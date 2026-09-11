use super::*;
use crate::remote::DEFAULT_CONTEXT_WINDOW;
use xai_chat_state::conversation_util::replace_or_insert_system_head;
#[cfg(test)]
#[path = "model_settings_tests.rs"]
mod model_settings_tests;
impl SessionActor {
    /// Fail closed if child status is unavailable. No permission response is touched here.
    pub(super) async fn model_settings_idle(&self) -> Result<bool, acp::Error> {
        if self.is_busy().await || !self.pending_interactions.lock().unwrap().is_empty() {
            return Ok(false);
        }
        use xai_grok_tools::implementations::grok_build::task::types::{
            SubagentEvent, SubagentListActiveRequest,
        };
        let Some(event_tx) = &self.tool_context.subagent_event_tx else {
            return Ok(true);
        };
        let (tx, rx) = tokio::sync::oneshot::channel();
        event_tx
            .send(SubagentEvent::ListActive(SubagentListActiveRequest {
                parent_session_id: self.session_id_string(),
                respond_to: tx,
            }))
            .map_err(|_| {
                acp::Error::internal_error().data("Cannot verify active children; model unchanged")
            })?;
        let children = tokio::time::timeout(std::time::Duration::from_secs(5), rx)
            .await
            .map_err(|_| {
                acp::Error::internal_error()
                    .data("Timed out checking active children; model unchanged")
            })?
            .map_err(|_| {
                acp::Error::internal_error().data("Cannot verify active children; model unchanged")
            })?;
        Ok(crate::session::model_settings::can_commit(
            self.is_busy().await,
            !children.is_empty(),
        ))
    }

    /// Runs outside the actor loop; cancel/replace/resume can retire it during remote validation.
    pub(super) async fn validate_pending_model_switch(
        self: &std::sync::Arc<Self>,
        model_id: acp::ModelId,
        catalog_entry: serde_json::Value,
        catalog_revision: Option<String>,
        mut sampling_config: xai_grok_sampler::SamplerConfig,
    ) -> Result<Option<xai_grok_sampler::SamplerConfig>, acp::Error> {
        if !self.model_settings_idle().await? {
            return Ok(None);
        }
        let models = self.models_manager.models();
        let entry = models.get(model_id.0.as_ref()).ok_or_else(|| {
            acp::Error::invalid_params().data("Queued model is no longer available")
        })?;
        if !entry.info.user_selectable
            || serde_json::to_value(entry).ok().as_ref() != Some(&catalog_entry)
        {
            return Err(
                acp::Error::invalid_params().data("Queued model catalog changed; select again")
            );
        }
        if let Some(bridge) =
            crate::polycode::bridge().filter(|b| b.owns_endpoint(&sampling_config.base_url))
        {
            let revision = catalog_revision.as_deref().ok_or_else(|| {
                acp::Error::invalid_params()
                    .data("Provider has no catalog revision; refresh and select again")
            })?;
            bridge
                .validate_selection(
                    model_id.0.as_ref(),
                    revision,
                    sampling_config.reasoning_effort,
                )
                .await
                .map_err(|e| acp::Error::invalid_params().data(e))?;
        } else {
            let session_key = if let Some(am) = &self.auth_manager {
                am.get_valid_token()
                    .await
                    .ok()
                    .or_else(|| am.current().map(|a| a.key))
            } else {
                None
            };
            let mut credentials =
                crate::agent::config::resolve_credentials(entry, session_key.as_deref());
            crate::agent::config::enforce_disable_api_key_auth(
                &mut credentials,
                self.auth_manager
                    .as_ref()
                    .is_some_and(|am| am.grok_com_config().api_key_auth_disabled()),
                session_key.as_deref(),
            );
            if credentials.api_key.is_none() || credentials.base_url != sampling_config.base_url {
                return Err(acp::Error::auth_required().data(
                    "Selected model credentials expired or route changed; sign in and select again",
                ));
            }
            sampling_config.api_key = credentials.api_key;
        }
        if !self.model_settings_idle().await? {
            return Ok(None);
        }
        Ok(Some(sampling_config))
    }

    /// Linearization boundary in the actor: validation is complete and queued cancel/replace
    /// commands have priority over this completion. No network validation blocks command intake.
    pub(super) async fn commit_pending_model_switch(
        self: &std::sync::Arc<Self>,
        pending: &mut crate::session::model_settings::PendingModelSwitch,
    ) -> Result<acp::ModelId, acp::Error> {
        if self.is_busy().await
            || !self.pending_interactions.lock().unwrap().is_empty()
            || pending.responds_to.is_closed()
        {
            return Err(acp::Error::invalid_params()
                .data("Model selection expired while validating; select again"));
        }
        // Recheck local catalog policy after the remote round trip, including non-serialized allowlist.
        if self
            .models_manager
            .models()
            .get(pending.model_id.0.as_ref())
            .is_none_or(|e| {
                !e.info.user_selectable
                    || serde_json::to_value(e).ok().as_ref() != Some(&pending.catalog_entry)
            })
        {
            return Err(
                acp::Error::invalid_params().data("Queued model catalog changed; select again")
            );
        }
        if pending.rebuild.is_some()
            && self
                .signals_handle()
                .snapshot()
                .await
                .is_some_and(|s| s.turn_count > 0)
        {
            return Err(acp::Error::invalid_params().data(
                "Queued harness change is no longer safe after work started; start a new session",
            ));
        }
        if let Some(definition) = pending.rebuild.take() {
            self.handle_rebuild_agent_for_definition(definition).await?;
            pending.skip_prompt_rewrite = true;
        }
        let mut sampling_config = pending.sampling_config.clone();
        sampling_config.extra_headers.shift_remove("x-polycode-fast");
        if pending.effort_only
            && let Some(previous) = self.chat_state_handle.get_sampling_config().await
            && previous.base_url == sampling_config.base_url
            && previous.model == sampling_config.model
            && previous.extra_headers.get("x-polycode-fast").is_some_and(|value| value == "on")
        {
            sampling_config.extra_headers.insert("x-polycode-fast".into(), "on".into());
        }
        self.handle_set_session_model(
            sampling_config,
            pending.use_concise,
            pending.is_family_switch,
            pending.apply_prompt_override,
            pending.skip_prompt_rewrite,
            pending.auto_compact_threshold_percent,
        )
        .await
    }
    /// Resolve the title client from the same complete config being committed by the switch.
    /// Build before mutating live state, so a client construction failure cannot retain an
    /// old-provider title resolver behind a nominally successful model selection.
    fn selected_summary_client(
        &self,
        primary: &xai_grok_sampler::SamplerConfig,
    ) -> Result<(xai_grok_sampler::SamplingClient, String), acp::Error> {
        let models = self.models_manager.models();
        let endpoints = self.models_manager.endpoints();
        let pin = self.models_manager.session_summary_model();
        let session_key = self
            .auth_manager
            .as_ref()
            .and_then(|am| am.current_or_expired().map(|a| a.key));
        let disable_api_key_auth = self
            .auth_manager
            .as_ref()
            .is_some_and(|am| am.grok_com_config().api_key_auth_disabled());
        let resolved = crate::agent::config::resolve_aux_model_sampling_config(
            primary,
            pin.as_deref()
                .unwrap_or(crate::models::default_session_summary_model()),
            &models,
            &endpoints,
            session_key.as_deref(),
            disable_api_key_auth,
            endpoints.alpha_test_key.clone(),
            primary.client_version.clone(),
        );
        let (model, config) = crate::agent::config::finalize_image_describe_sampler_config(
            resolved,
            primary,
            primary.client_identifier.clone(),
            primary.max_retries,
        );
        let client =
            xai_grok_sampler::SamplingClient::new(config).map_err(|e| self.to_acp_error(e))?;
        Ok((client, model))
    }

    pub(super) async fn handle_set_session_model(
        self: &std::sync::Arc<Self>,
        sampling_config: xai_grok_sampler::SamplerConfig,
        use_concise: bool,
        is_family_switch: bool,
        apply_prompt_override: bool,
        skip_prompt_rewrite: bool,
        auto_compact_threshold_percent: u8,
    ) -> Result<acp::ModelId, acp::Error> {
        if crate::polycode::enabled() && self.state.lock().await.running_task.is_some() {
            return Err(acp::Error::invalid_params()
                .data("Direct model mutation is unsafe during work; use the queued model API"));
        }
        let (summary_client, summary_model) = self.selected_summary_client(&sampling_config)?;
        self.abort_title_refresh();
        let model_id = acp::ModelId::new(
            crate::polycode::canonical_model_id(&sampling_config.base_url, &sampling_config.model)
                .unwrap_or_else(|| sampling_config.model.clone()),
        );
        let new_context_window = self.compaction.context_window_override.unwrap_or_else(|| {
            // A bridge model's catalog entry may omit the window; a bound learned from a length rejection beats the placeholder.
            crate::polycode::known_context_window(&sampling_config.base_url, &sampling_config.model)
                .and_then(std::num::NonZeroU64::new)
                .or_else(|| std::num::NonZeroU64::new(sampling_config.context_window))
                .unwrap_or_else(|| {
                    std::num::NonZeroU64::new(DEFAULT_CONTEXT_WINDOW)
                        .expect("DEFAULT_CONTEXT_WINDOW is non-zero")
                })
        });
        let prev_threshold = self.compaction.threshold_percent.get();
        if prev_threshold != auto_compact_threshold_percent {
            tracing::info!(
                session_id = %self.session_info.id.0,
                new_model = %sampling_config.model,
                old_threshold = prev_threshold,
                new_threshold = auto_compact_threshold_percent,
                "auto_compact_threshold_percent updated for model switch"
            );
        }
        self.compaction
            .threshold_percent
            .set(auto_compact_threshold_percent);
        self.supports_backend_search
            .set(sampling_config.supports_backend_search);
        self.compactions_remaining
            .set(sampling_config.compactions_remaining);
        self.compaction_at_tokens
            .set(sampling_config.compaction_at_tokens);
        xai_grok_telemetry::unified_log::info(
            "backend_search: model switch",
            Some(self.session_info.id.0.as_ref()),
            Some(serde_json::json!({
                "new_model": &sampling_config.model,
                "api_backend": format!("{:?}", sampling_config.api_backend),
                "supports_backend_search": sampling_config.supports_backend_search,
            })),
        );
        // Queue title invalidation before publishing the new chat route. The FIFO is
        // the persistence actor's selection boundary, including already-queued titles.
        let _ = self
            .notifications
            .persistence_tx
            .send(PersistenceMsg::SummarySampling {
                client: summary_client,
                model: summary_model,
            });
        let previous = self.chat_state_handle.get_sampling_config().await;
        let next_sampling = xai_grok_sampling_types::SamplingConfig {
                base_url: sampling_config.base_url.clone(),
                model: sampling_config.model.clone(),
                max_completion_tokens: sampling_config.max_completion_tokens,
                temperature: sampling_config.temperature,
                top_p: sampling_config.top_p,
                api_backend: sampling_config.api_backend.clone(),
                extra_headers: sampling_config.extra_headers.clone(),
                query_params: sampling_config.query_params.clone(),
                env_http_headers: sampling_config.env_http_headers.clone(),
                context_window: new_context_window,
                reasoning_effort: sampling_config.reasoning_effort,
                stream_tool_calls: Some(sampling_config.stream_tool_calls),
            };
        let existing = self.chat_state_handle.get_credentials().await;
        let session_key = self
            .auth_manager
            .as_ref()
            .and_then(|am| am.current_or_expired().map(|a| a.key));
        // The context bar must follow the new model's window right away, not at the next turn's compaction check.
        let switched_context_window = self
            .measured_context_window(&next_sampling)
            .map_or(0, |cw| cw.get());
        self.chat_state_handle
            .update_sampling_config_and_credentials(next_sampling, xai_chat_state::Credentials {
                api_key: sampling_config.api_key.clone(),
                auth_type: crate::agent::config::resolve_chat_state_auth_type(
                    sampling_config.model.as_str(),
                    session_key.as_deref(),
                    existing.auth_type,
                ),
                alpha_test_key: existing.alpha_test_key,
                client_version: sampling_config.client_version.clone(),
            }).await.map_err(|e| acp::Error::internal_error().data(e))?;
        if previous.as_ref().is_none_or(|c| c.base_url != sampling_config.base_url
            || c.model != sampling_config.model || c.reasoning_effort != sampling_config.reasoning_effort) {
            self.rebuild_spec.native_service_consent.set_provider(
                xai_grok_sampler::local_transport::subscription_provider(&sampling_config.base_url),
            );
        }
        self.invalidate_model_auth_memo();
        self.signals_handle()
            .record_model_usage(&sampling_config.model);
        let estimated_total = self.chat_state_handle.get_estimated_total_tokens().await;
        self.signals_handle()
            .update_context_usage(estimated_total, switched_context_window);
        if apply_prompt_override && !skip_prompt_rewrite {
            let mut conversation = self.chat_state_handle.get_conversation().await;
            for item in conversation.iter_mut() {
                if let ConversationItem::System(sys) = item {
                    if use_concise {
                        sys.content = std::sync::Arc::<str>::from(
                            xai_grok_agent::prompt::template::COMPACT_SYSTEM_PROMPT,
                        );
                    } else {
                        sys.content =
                            std::sync::Arc::<str>::from(self.agent.borrow().system_prompt());
                    }
                    break;
                }
            }
            self.chat_state_handle.replace_conversation(conversation);
        } else if !apply_prompt_override {
            tracing::info!(
                session_id = %self.session_info.id.0,
                model_id = %model_id.0,
                "handle_set_session_model: skipping prompt override (apply_prompt_override=false)"
            );
        } else {
            tracing::info!(
                session_id = %self.session_info.id.0,
                model_id = %model_id.0,
                "handle_set_session_model: skipping prompt rewrite (just rebuilt harness)"
            );
        }
        let agent_name = self.agent.borrow().definition().name.clone();
        let _ = self
            .notifications
            .persistence_tx
            .send(PersistenceMsg::CurrentModel {
                model_id: model_id.clone(),
                agent_name: Some(agent_name),
                reasoning_effort: Some(sampling_config.reasoning_effort),
            });
        self.emit_status_snapshot_detached();
        let turn_in_flight = self.state.lock().await.running_task.is_some();
        if turn_in_flight && is_family_switch {
            tracing::warn!("Family-switch compact skipped: turn in flight");
        }
        if is_family_switch && !turn_in_flight && self.history_has_model_minted_items().await {
            self.abort_and_clear_prefire().await;
            let estimated_total_tokens = self.chat_state_handle.get_estimated_total_tokens().await;
            let context_window = new_context_window.get();
            let trigger_info = compaction::AutoCompactTriggerInfo {
                tokens_used: estimated_total_tokens,
                context_window,
                percentage: xai_token_estimation::usage_percentage_u8(
                    estimated_total_tokens,
                    context_window,
                ),
            };
            tracing::info!("Family-switch compact: -> {}", sampling_config.model);
            if let Err(e) = self.run_compact_only(trigger_info, true).await {
                tracing::error!(error = %e, "Family-switch compaction failed; switching anyway");
            }
        }
        Ok(model_id)
    }
    /// Set the reasoning effort on the live sampling config, applying the same
    /// support check and per-effort model routing as `apply_supported_effort`.
    pub(super) async fn handle_set_reasoning_effort(
        self: &std::sync::Arc<Self>,
        effort: xai_grok_sampling_types::ReasoningEffort,
    ) -> Result<acp::ModelId, acp::Error> {
        let Some(mut cfg) = self.chat_state_handle.get_sampling_config().await else {
            return Err(acp::Error::internal_error().data("session has no sampling config"));
        };
        if !self
            .models_manager
            .model_supports_reasoning_effort_value(&cfg.model, effort)
        {
            return Err(acp::Error::invalid_params()
                .data("the session's current model does not support reasoning effort"));
        }
        let previous_model = cfg.model.clone();
        let previous_effort = cfg.reasoning_effort;
        if let Some(routed) = self.models_manager.model_for_effort(&cfg.model, effort) {
            cfg.model = routed;
        }
        if previous_model != cfg.model {
            cfg.extra_headers.shift_remove("x-polycode-fast");
        }
        cfg.reasoning_effort = Some(effort);
        let model_id = acp::ModelId::new(
            crate::polycode::canonical_model_id(&cfg.base_url, &cfg.model)
                .unwrap_or_else(|| cfg.model.clone()),
        );
        let mut primary = self.reconstruct_full_config().await;
        primary.model = cfg.model.clone();
        primary.extra_headers = cfg.extra_headers.clone();
        primary.reasoning_effort = cfg.reasoning_effort;
        let (client, model) = self.selected_summary_client(&primary)?;
        self.abort_title_refresh();
        let _ = self
            .notifications
            .persistence_tx
            .send(PersistenceMsg::SummarySampling { client, model });
        if previous_model != cfg.model || previous_effort != cfg.reasoning_effort {
            self.rebuild_spec.native_service_consent.set_provider(
                xai_grok_sampler::local_transport::subscription_provider(&cfg.base_url),
            );
        }
        self.chat_state_handle.update_sampling_config(cfg);
        let agent_name = self.agent.borrow().definition().name.clone();
        let _ = self
            .notifications
            .persistence_tx
            .send(PersistenceMsg::CurrentModel {
                model_id: model_id.clone(),
                agent_name: Some(agent_name),
                reasoning_effort: Some(Some(effort)),
            });
        self.emit_status_snapshot_detached();
        Ok(model_id)
    }
    /// Handle [`SessionCommand::RebuildAgentForDefinition`].
    ///
    /// Builds a fresh [`xai_grok_agent::Agent`] from the cached [`crate::session::agent_rebuild::AgentRebuildSpec`] and the supplied definition.
    /// Replaces `self.agent`, rewrites the system message in the conversation, persists the new prompt artifacts, and updates `active_agent_type`.
    ///
    /// Triggered from `MvpAgent::set_session_model` only when the new model's `agent_type` differs from the session's `active_agent_type`.
    /// The trigger also requires `turn_count == 0` (no user message has been sent yet).
    /// Defense-in-depth: rejects if a turn is in flight.
    pub(super) async fn handle_rebuild_agent_for_definition(
        &self,
        definition: xai_grok_agent::AgentDefinition,
    ) -> Result<(), acp::Error> {
        {
            let state = self.state.lock().await;
            if state.running_task.is_some() {
                tracing::warn!(
                    session_id = %self.session_info.id.0,
                    new_agent_type = %definition.name,
                    "handle_rebuild_agent_for_definition: turn in flight, rejecting rebuild"
                );
                return Err(acp::Error::internal_error()
                    .data("rebuild_agent: turn in flight, refusing to rebuild harness"));
            }
        }
        let new_agent_name = definition.name.clone();
        tracing::info!(
            session_id = %self.session_info.id.0,
            new_agent_type = %new_agent_name,
            "handle_rebuild_agent_for_definition: rebuilding harness"
        );
        let new_agent = self
            .rebuild_spec
            .build_agent(definition)
            .await
            .map_err(|e| {
                tracing::error!(
                    session_id = %self.session_info.id.0,
                    new_agent_type = %new_agent_name,
                    error = %e,
                    "handle_rebuild_agent_for_definition: AgentBuilder::build failed"
                );
                acp::Error::internal_error().data(format!(
                    "rebuild_agent: build failed for agent_type={new_agent_name}: {e}"
                ))
            })?;
        let new_system_prompt = new_agent.system_prompt().to_string();
        let mut new_prompt_context = new_agent.prompt_context().clone();
        new_prompt_context.normalize_for_persistence();
        self.abort_and_clear_prefire().await;
        *self.agent.borrow_mut() = new_agent;
        *self.active_agent_type.lock() = Some(new_agent_name.clone());
        self.emit_resolved_tool_overrides();
        self.queue_exit_reminder_on_approved_exit.store(
            self.is_cursor_harness(),
            std::sync::atomic::Ordering::Relaxed,
        );
        if let Err(e) = self.workspace_ops.bind_local_session(
            &self.session_id_string(),
            self.tool_context.cwd.as_path().to_path_buf(),
            self.tool_context.hunk_tracker_handle.clone(),
            self.agent.borrow().tool_bridge().toolset(),
            None,
        ) {
            tracing::warn!(error = %e, "failed to rebind local session toolset after agent rebuild");
        }
        {
            let bridge = self.agent.borrow().tool_bridge().clone();
            let snapshot = self.tool_metadata_snapshot.clone();
            let tool_index = crate::session::tool_index::Bm25ToolSearchIndex::new(snapshot);
            bridge
                .update_resource(xai_grok_tools::types::tool_index::ToolIndex(
                    std::sync::Arc::new(tool_index),
                ))
                .await;
            if let Some(client) = self.rebuild_spec.managed_gateway_tool_client.clone() {
                bridge.update_resource(client).await;
            }
            let plan_path = self.plan_mode.lock().plan_file_path().to_path_buf();
            bridge
                .update_resource(xai_grok_tools::types::resources::PlanFilePath(plan_path))
                .await;
            if let Some(display_cwd) = self.display_cwd.get() {
                bridge
                    .set_display_cwd(std::path::PathBuf::from(display_cwd))
                    .await;
            }
            bridge
                .update_resource(
                    xai_grok_tools::implementations::grok_build::workflow::WorkflowLaunchHandle(
                        self.workflow_launch_tx.clone(),
                    ),
                )
                .await;
            if !self.goal_runs_on_workflow_engine() {
                bridge
                    .update_resource(
                        xai_grok_tools::implementations::grok_build::update_goal::GoalUpdateHandle(
                            self.goal_update_tx.clone(),
                        ),
                    )
                    .await;
            }
            if let Some(reservations) = self.tool_context.task_completion_reservations.clone() {
                bridge.update_resource(reservations).await;
            }
            if let Some(gate) = self.tool_context.task_wake_suppressed.clone() {
                bridge.update_resource(gate).await;
            }
            self.inject_deny_read_globs().await;
        }
        {
            let notified = self.mcp_handshakes_done.notified();
            tokio::pin!(notified);
            let needs_wait = {
                let s = self.mcp_state.lock().await;
                !s.configs.is_empty() && !s.is_initialized()
            };
            if needs_wait {
                const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);
                tokio::select! {
                    () = &mut notified => {}
                    () = tokio::time::sleep(TIMEOUT) => {
                        tracing::warn!(
                            session_id = %self.session_info.id.0,
                            "handle_rebuild_agent_for_definition: timed out waiting for MCP handshakes"
                        );
                    }
                }
            }
        }
        self.re_register_mcp_tools_on_rebuilt_bridge().await;
        if let Some(old_handle) = self.deferred_prefix.take() {
            old_handle.abort();
        }
        let new_user_prefix = self.build_user_message_prefix().await;
        {
            let mut conversation = self.chat_state_handle.get_conversation().await;
            let _ = replace_or_insert_system_head(&mut conversation, &new_system_prompt);
            let drop_startup_skill_reminder = false;
            Self::rewrite_zero_turn_prefix(
                &mut conversation,
                new_user_prefix,
                drop_startup_skill_reminder,
            );
            if !conversation_has_project_instructions(&conversation)
                && let Some(agents_md_reminder) = self.agent.borrow().agents_md_user_reminder()
            {
                let agents_md_at = conversation.len().min(2);
                conversation.insert(
                    agents_md_at,
                    ConversationItem::project_instructions(agents_md_reminder),
                );
            }
            self.inject_baseline_skill_reminder(&mut conversation).await;
            self.chat_state_handle.replace_conversation(conversation);
        }
        save_prompt_context(&self.session_info, &new_prompt_context);
        save_system_prompt(&self.session_info, &new_system_prompt);
        let snapshot = self.chat_state_handle.get_conversation().await;
        persist_chat_history_jsonl_sync(&self.session_info, &snapshot);
        self.mcp_reminder_dirty
            .store(true, std::sync::atomic::Ordering::Relaxed);
        self.send_available_commands_update().await;
        tracing::info!(
            session_id = %self.session_info.id.0,
            new_agent_type = %new_agent_name,
            "handle_rebuild_agent_for_definition: harness rebuild complete"
        );
        Ok(())
    }
    /// Apply a client-supplied `systemPromptOverride` on attach without wiping user/assistant history: swap only the leading `System` message.
    /// The swap happens atomically inside the `ChatStateActor` (see `ChatStateCommand::ReplaceSystemHead` for the serialization guarantees).
    /// `system_prompt.txt` (not owned by the persistence actor) is saved directly, even on a head no-op, so a diverged secondary artifact self-heals.
    /// Skipped entirely on a verbatim mirror-fork (`preserve_inherited_system`).
    pub(super) async fn handle_replace_system_prompt(&self, system_prompt: String) {
        if self.startup_hints.preserve_inherited_system {
            tracing::debug!(
                session_id = %self.session_info.id.0,
                "handle_replace_system_prompt: skipped (preserve_inherited_system)"
            );
            return;
        }
        let Some(changed) = self
            .chat_state_handle
            .replace_system_head(&system_prompt)
            .await
        else {
            tracing::error!(
                session_id = %self.session_info.id.0,
                "handle_replace_system_prompt: chat-state actor unavailable; override not applied"
            );
            return;
        };
        save_system_prompt(&self.session_info, &system_prompt);
        if changed {
            tracing::info!(
                session_id = %self.session_info.id.0,
                prompt_len = system_prompt.len(),
                "handle_replace_system_prompt: client override applied"
            );
        } else {
            tracing::debug!(
                session_id = %self.session_info.id.0,
                "handle_replace_system_prompt: head already matches, no-op"
            );
        }
    }
    /// Whether the conversation has anything a family switch must compact away.
    async fn history_has_model_minted_items(&self) -> bool {
        self.chat_state_handle
            .get_conversation()
            .await
            .iter()
            .any(|item| {
                matches!(
                    item,
                    xai_grok_sampling_types::ConversationItem::Assistant(_)
                        | xai_grok_sampling_types::ConversationItem::Reasoning(_)
                        | xai_grok_sampling_types::ConversationItem::BackendToolCall(_)
                )
            })
    }
    /// Abort and join an in-flight prefire pass-1 and drop its NOTE1 cache.
    pub(super) async fn abort_and_clear_prefire(&self) {
        if let Some(handle) = self.compaction.prefire.take_handle() {
            handle.abort();
            let _ = handle.await;
            self.compaction.prefire.finish();
        }
        self.compaction.prefire.clear();
    }
}
