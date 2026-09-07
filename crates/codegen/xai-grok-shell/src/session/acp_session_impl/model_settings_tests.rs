use super::super::support::create_test_actor;
use super::*;
use crate::session::model_settings::{PendingModelSwitch, PendingSlot};
use xai_grok_sampling_types::ReasoningEffort;

async fn fixture() -> (
    Arc<SessionActor>,
    PendingModelSwitch,
    tokio::sync::oneshot::Receiver<Result<acp::ModelId, acp::Error>>,
    tokio::sync::mpsc::UnboundedReceiver<PersistenceMsg>,
) {
    let (gateway, _rx) = tokio::sync::mpsc::unbounded_channel();
    let (persist, persistence) = tokio::sync::mpsc::unbounded_channel();
    let actor = Arc::new(create_test_actor(0, 256_000, 85, gateway, persist).await);
    let mut entry = crate::agent::config::resolve_model_list(&Default::default(), None)
        .into_values()
        .next()
        .unwrap();
    entry.info.model = "model-settings-target".into();
    entry.info.id = Some("model-settings-target".into());
    entry.info.base_url = "https://model-settings.invalid/v1".into();
    entry.info.reasoning_effort = Some(ReasoningEffort::Low);
    entry.info.supports_reasoning_effort = true;
    entry.info.reasoning_efforts =
        serde_json::from_value(serde_json::json!(["low", "high"])).unwrap();
    entry.info.user_selectable = true;
    entry.api_key = Some("model-settings-fixture-key".into());
    actor
        .models_manager
        .insert_test_entry("model-settings-target", entry.clone());
    let mut config = actor.reconstruct_full_config().await;
    config.base_url = entry.info.base_url.clone();
    config.model = entry.info.model.clone();
    config.reasoning_effort = Some(ReasoningEffort::Low);
    config.api_key = entry.api_key.clone();
    let (tx, rx) = tokio::sync::oneshot::channel();
    let pending = PendingModelSwitch {
        model_id: acp::ModelId::new("model-settings-target"),
        selection_id: None,
        effort_only: false,
        catalog_entry: serde_json::to_value(&entry).unwrap(),
        catalog_revision: None,
        sampling_config: config,
        use_concise: false,
        is_family_switch: false,
        apply_prompt_override: false,
        skip_prompt_rewrite: true,
        rebuild: None,
        auto_compact_threshold_percent: 85,
        responds_to: tx,
    };
    (actor, pending, rx, persistence)
}

#[tokio::test(flavor = "current_thread")]
async fn model_settings_busy_admission_does_not_change_live_sampling_or_permission() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let (actor, mut pending, mut reply, _persist) = fixture().await;
            pending.selection_id = Some("newer-selection".into());
            let before = actor.chat_state_handle.get_sampling_config().await.unwrap();
            let work = crate::session::handle::WorkGuard::new(actor.active_work.clone());
            let mut queue = PendingSlot::new();
            queue.replace(pending);
            assert!(!queue.accepts_cancel(Some("old-selection")));
            assert!(queue.accepts_cancel(Some("newer-selection")));
            assert!(!actor.model_settings_idle().await.unwrap());
            assert!(matches!(
                reply.try_recv(),
                Err(tokio::sync::oneshot::error::TryRecvError::Empty)
            ));
            let after = actor.chat_state_handle.get_sampling_config().await.unwrap();
            assert_eq!(after.model, before.model);
            assert_eq!(after.base_url, before.base_url);
            assert_eq!(after.reasoning_effort, before.reasoning_effort);
            drop(work);
            actor.pending_interactions.lock().unwrap().insert(
                "permission".into(),
                crate::session::pending_interaction::PendingKind::Permission,
            );
            assert!(!actor.model_settings_idle().await.unwrap());
            queue.cancel("cancelled");
            assert!(reply.await.unwrap().is_err());
            assert!(
                actor
                    .pending_interactions
                    .lock()
                    .unwrap()
                    .contains_key("permission")
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn model_settings_safe_commit_updates_wire_snapshot_and_persists_resumable_effort() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let (actor, mut pending, _reply, mut persist) = fixture().await;
            assert!(actor.model_settings_idle().await.unwrap());
            let validated = actor
                .validate_pending_model_switch(
                    pending.model_id.clone(),
                    pending.catalog_entry.clone(),
                    None,
                    pending.sampling_config.clone(),
                )
                .await
                .unwrap()
                .unwrap();
            pending.sampling_config = validated;
            actor
                .commit_pending_model_switch(&mut pending)
                .await
                .unwrap();
            let live = actor.chat_state_handle.get_sampling_config().await.unwrap();
            assert_eq!(live.model, "model-settings-target");
            assert_eq!(live.reasoning_effort, Some(ReasoningEffort::Low));
            assert_eq!(live.base_url, "https://model-settings.invalid/v1");
            let mut persisted = false;
            while let Ok(message) = persist.try_recv() {
                if let PersistenceMsg::CurrentModel {
                    model_id,
                    reasoning_effort,
                    ..
                } = message
                {
                    assert_eq!(model_id.0.as_ref(), "model-settings-target");
                    assert_eq!(reasoning_effort, Some(Some(ReasoningEffort::Low)));
                    persisted = true;
                }
            }
            assert!(
                persisted,
                "resume must receive the committed effort, not a queued preference"
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn model_settings_invalidated_target_never_falls_back() {
    tokio::task::LocalSet::new()
        .run_until(async {
            let (actor, mut pending, _reply, _persist) = fixture().await;
            let before = actor.chat_state_handle.get_sampling_config().await.unwrap();
            let mut changed = actor.models_manager.models()["model-settings-target"].clone();
            changed.info.user_selectable = false; // this policy bit is intentionally not serialized
            actor
                .models_manager
                .insert_test_entry("model-settings-target", changed);
            assert!(
                actor
                    .commit_pending_model_switch(&mut pending)
                    .await
                    .is_err()
            );
            assert_eq!(
                actor
                    .chat_state_handle
                    .get_sampling_config()
                    .await
                    .unwrap()
                    .model,
                before.model
            );
        })
        .await;
}

#[tokio::test(flavor = "current_thread")]
async fn model_settings_active_children_and_unavailable_child_guard_block_commit() {
    tokio::task::LocalSet::new()
        .run_until(async {
            use xai_grok_tools::implementations::grok_build::task::types::{
                ActiveSubagentSummary, SubagentEvent,
            };
            let (gateway, _rx) = tokio::sync::mpsc::unbounded_channel();
            let (persist, _rx) = tokio::sync::mpsc::unbounded_channel();
            let mut actor = create_test_actor(0, 256_000, 85, gateway, persist).await;
            let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel();
            actor.tool_context.subagent_event_tx = Some(tx);
            let answer = tokio::task::spawn_local(async move {
                let SubagentEvent::ListActive(request) = rx.recv().await.unwrap() else {
                    panic!("expected child query")
                };
                let _ = request.respond_to.send(vec![ActiveSubagentSummary {
                    subagent_id: "child".into(),
                    subagent_type: "general-purpose".into(),
                    description: "running".into(),
                    elapsed_ms: 1,
                }]);
            });
            assert!(!actor.model_settings_idle().await.unwrap());
            answer.await.unwrap();
            assert!(
                actor.model_settings_idle().await.is_err(),
                "closed child coordinator must fail closed"
            );
        })
        .await;
}
