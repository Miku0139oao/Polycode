//! Native provider picker and OAuth state machine. Local questions have no ACP response
//! sender, so provider management can never enter the model conversation.
use crate::app::provider::{Choice, Command, Operation, Reply};
use crate::app::{
    actions::Effect,
    agent::AgentId,
    app_view::{ActiveView, AppView},
};
use crate::views::question_view::{LocalQuestionKind, Question, QuestionOption, QuestionViewState};
use xai_grok_shell::polycode::{LoginState, ProviderId};

fn effect(app: &AppView, operation: Operation) -> Effect {
    Effect::Provider {
        generation: app.provider.generation,
        target: app.provider.target.expect("provider target"),
        operation,
    }
}
fn option(label: &str, description: &str, id: &str) -> QuestionOption {
    QuestionOption {
        label: label.into(),
        description: description.into(),
        id: Some(id.into()),
        preview: None,
    }
}
fn close_card(app: &mut AppView) {
    if let Some(agent) = app.provider.target.and_then(|id| app.agents.get_mut(&id))
        && matches!(agent.active_modal.as_ref(), Some(crate::views::modal::ActiveModal::ArgPicker { command, .. }) if command == "provider")
    {
        agent.active_modal = None;
    }
    if let Some(id) = app.provider.target
        && let Some(agent) = app.agents.get_mut(&id)
        && agent
            .question_view
            .as_ref()
            .is_some_and(|q| matches!(q.local_kind, Some(LocalQuestionKind::Provider { .. })))
    {
        if let Some(question) = agent.question_view.take() {
            agent.prompt.restore(question.stashed_prompt);
        }
        agent.cleanup_question_state();
    }
}
fn card(app: &mut AppView, title: String, options: Vec<QuestionOption>, login: bool) {
    let Some(id) = app.provider.target else {
        return;
    };
    if app
        .agents
        .get(&id)
        .is_some_and(|a| !a.permission_queue.is_empty() || a.plan_approval_view.is_some())
    {
        app.show_toast(
            "Resolve the current tool/plan permission before opening the provider picker",
        );
        return;
    }
    close_card(app);
    let Some(agent) = app.agents.get_mut(&id) else {
        return;
    };
    if agent.question_view.is_some() {
        app.show_toast("Finish the current question, then use /provider");
        return;
    }
    let state = QuestionViewState::new(
        "polycode-provider".into(),
        vec![Question {
            question: title,
            id: None,
            options,
            multi_select: Some(false),
        }],
        agent.prompt.stash(),
    )
    .with_local_kind(LocalQuestionKind::Provider { login })
    .with_no_freeform();
    agent.question_view = Some(state);
    // Replacing a card restores scrollback focus during cleanup. Explicitly give
    // the new local card keyboard ownership, including asynchronous catalog refresh.
    agent.active_pane = crate::app::agent_view::ActivePane::Prompt;
    agent.prompt.set_text("");
}
/// Reuse the last signed-in model (or CLI `-m`) instead of the provider-then-model cards.
/// Only the first unauthenticated startup catalog (`provider: None`) may restore; login and
/// `/provider` keep the explicit picker. Missing or signed-out targets fall through to the menu.
fn try_restore_preferred(app: &mut AppView) -> Option<Vec<Effect>> {
    if app.provider.restore_attempted || app.provider.login_menu {
        return None;
    }
    app.provider.restore_attempted = true;
    if app.provider.local_target.is_none() || app.provider.creating {
        return None;
    }
    let model = app
        .provider
        .preferred_model
        .as_deref()
        .map(str::trim)
        .filter(|id| !id.is_empty())?
        .to_owned();
    let id = agent_client_protocol::ModelId::new(model.clone());
    if !app.models.available.contains_key(&id) {
        return None;
    }
    if (model.starts_with("codex/") || model.starts_with("cursor/"))
        && !app.provider.catalog.providers.iter().any(|provider| {
            provider.logged_in
                && provider
                    .models
                    .iter()
                    .any(|entry| model == format!("{}/{}", provider.id.as_str(), entry.id))
        })
    {
        return None;
    }
    let effort = app.provider.preferred_effort.filter(|effort| {
        app.models
            .resolve_effort_for_model(&id, effort.as_str())
            .is_ok()
    });
    Some(dispatch_enabled(app, Command::ModelEffort(model, effort)))
}
fn menu(app: &mut AppView) {
    if app.provider.selected.is_none() {
        app.provider.selected = match xai_grok_shell::polycode::initial_provider() {
            Some("codex") => Some(Choice::Subscription(ProviderId::Codex)),
            Some("cursor") => Some(Choice::Subscription(ProviderId::Cursor)),
            Some("native") => Some(Choice::Grok),
            _ => None,
        };
    }
    let mut options = vec![option(
        "Grok (native)",
        "Original native Grok account and models",
        "grok",
    )];
    for (id, name) in [
        (ProviderId::Codex, "OpenAI ChatGPT"),
        (ProviderId::Cursor, "Cursor"),
    ] {
        let signed_in = app
            .provider
            .catalog
            .providers
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.logged_in);
        options.push(option(
            name,
            if signed_in {
                "Signed in; choose a model (use /login to sign in again)"
            } else {
                "Sign in using your subscription"
            },
            id.as_str(),
        ));
    }
    options.push(option(
        "Refresh models",
        "Refetch the Grok (native) and subscription model catalogs",
        "refresh",
    ));
    card(
        app,
        if app.provider.login_menu {
            "Sign in to a provider"
        } else {
            "Choose a provider — same native session, tools and permissions"
        }
        .into(),
        options,
        app.provider.login_menu,
    );
    if let Some(id) = app.provider.target
        && let Some(agent) = app.agents.get_mut(&id)
        && let Some(q) = agent.question_view.as_mut()
    {
        q.set_cursor(match app.provider.selected {
            Some(Choice::Subscription(ProviderId::Codex)) => 1,
            Some(Choice::Subscription(ProviderId::Cursor)) => 2,
            _ => 0,
        });
    }
}
fn models(app: &mut AppView, _provider: Choice) {
    use crate::views::{modal::ActiveModal, picker::PickerState};

    let items = app
        .models
        .available
        .iter()
        .map(|(id, model)| {
            let provider = if id.0.starts_with("codex/") {
                "OpenAI ChatGPT"
            } else if id.0.starts_with("cursor/") {
                "Cursor"
            } else {
                "Grok native"
            };
            let short = model
                .name
                .split_once(" / ")
                .map(|(_, rest)| rest.trim())
                .filter(|rest| !rest.is_empty())
                .unwrap_or(model.name.as_str());
            crate::slash::command::ArgItem {
                display: format!("{short} [{}]", id.0),
                description: provider.into(),
                match_text: format!("{provider} {} {short} {}", model.name, id.0),
                insert_text: id.0.to_string(),
            }
        })
        .collect::<Vec<_>>();
    if items.is_empty() {
        app.show_toast("No models available yet; use /login or /provider refresh");
        menu(app);
        return;
    }
    close_card(app);
    let Some(agent) = app.provider.target.and_then(|id| app.agents.get_mut(&id)) else {
        return;
    };
    agent.active_modal = Some(ActiveModal::ArgPicker {
        command: "provider".into(),
        args_query: String::new(),
        items: items.clone(),
        original_items: items,
        state: PickerState::input_active(),
        previous_palette: None,
        window: Default::default(),
    });
}
fn cancel(app: &mut AppView) -> Vec<Effect> {
    close_card(app);
    let effects = invalidate(app);
    if let Some(id) = app.provider.local_target.take() {
        // Retire the unique placeholder, including queued prompts. Late native
        // creation completions must never attach to a later provider attempt.
        super::session::modal::remove_agent_and_cleanup(app, id);
        if app.active_view == ActiveView::Agent(id) {
            super::ctx::show_welcome(app);
            app.welcome_prompt_focused = true;
        }
    }
    app.provider.creating = false;
    if let Some(sid) = app.provider.pending_session_id.take() {
        app.provider.retired_sessions.insert(sid);
    }
    effects
}
fn invalidate(app: &mut AppView) -> Vec<Effect> {
    let prior = app.provider.invalidate();
    prior
        .map(|a| vec![effect(app, Operation::Cancel(a.attempt_id))])
        .unwrap_or_default()
}
pub(super) fn dispatch(app: &mut AppView, command: Command) -> Vec<Effect> {
    if !xai_grok_shell::polycode::enabled() {
        app.show_toast("Provider selection requires --polycode-native via the Polycode launcher");
        return vec![];
    }
    if matches!(command, Command::Cancel) {
        let effects = cancel(app);
        app.show_toast("Provider login cancelled; the current model is unchanged");
        return effects;
    }
    dispatch_enabled(app, command)
}

pub(super) fn dispatch_enabled(app: &mut AppView, command: Command) -> Vec<Effect> {
    if matches!(command, Command::Cancel) {
        return cancel(app);
    }
    if let ActiveView::Agent(id) = app.active_view
        && let Some(agent) = app.agents.get(&id)
    {
        if app.provider.local_target == Some(id) && app.provider.creating {
            app.show_toast("Native session is starting; wait for creation before choosing again");
            return vec![];
        }
        if !agent.permission_queue.is_empty() || agent.plan_approval_view.is_some() {
            app.show_toast(
                "Resolve the current tool/plan permission before opening the provider picker",
            );
            return vec![];
        }
        if agent
            .question_view
            .as_ref()
            .is_some_and(|q| !matches!(q.local_kind, Some(LocalQuestionKind::Provider { .. })))
        {
            app.show_toast("Finish the current question before switching providers");
            return vec![];
        }
    }
    let mut effects = Vec::new();
    if let Some(local) = app.provider.local_target
        && app.active_view != ActiveView::Agent(local)
    {
        // Navigating to another scope retires the old startup just like Esc.
        effects.extend(cancel(app));
    }
    if !matches!(app.active_view, ActiveView::Agent(_)) {
        if !app.session_startup_allowed() {
            app.show_toast("Resolve startup trust and consent before choosing a provider");
            return effects;
        }
        // No auth RPC, MCP startup, persistence or sampling on the picker path.
        let (id, local_effects) = super::session::lifecycle::create_local_session_view(app);
        app.provider.local_target = Some(id);
        app.provider.creating = false;
        effects.extend(local_effects);
    }
    let ActiveView::Agent(target) = app.active_view else {
        return effects;
    };
    // Cancel an attempt in its original scope before changing targets.
    effects.extend(invalidate(app));
    app.provider.target = Some(target);
    close_card(app);
    let selected_effort = match &command {
        Command::ModelEffort(_, effort) => *effort,
        _ => None,
    };
    let choose_effort = matches!(&command, Command::Model(_));
    match command {
        Command::Menu { login } => {
            app.provider.login_menu = login;
            menu(app); // Always usable, including an unavailable bridge / unauthenticated startup.
            effects.push(effect(
                app,
                Operation::Catalog {
                    refresh: false,
                    provider: None,
                },
            ));
        }
        Command::Refresh => {
            app.provider.login_menu = false;
            menu(app);
            effects.push(effect(
                app,
                Operation::Catalog {
                    refresh: true,
                    provider: None,
                },
            ));
        }
        Command::Choose { provider, login } => {
            app.provider.selected = Some(provider);
            match provider {
                Choice::Grok if login => {
                    effects.extend(super::auth::dispatch_login(app));
                }
                Choice::Grok => models(app, provider),
                Choice::Subscription(id) => {
                    let logged_in = app
                        .provider
                        .catalog
                        .providers
                        .iter()
                        .find(|p| p.id == id)
                        .is_some_and(|p| p.logged_in);
                    if login || !logged_in {
                        card(
                            app,
                            "Starting browser sign-in… (Esc cancels)".into(),
                            vec![option("Cancel", "Keep the current model", "cancel")],
                            false,
                        );
                        effects.push(effect(app, Operation::Start(id)));
                    } else {
                        models(app, provider);
                    }
                }
            }
        }
        Command::Model(model) | Command::ModelEffort(model, _) => {
            let id = agent_client_protocol::ModelId::new(model);
            if !app.models.available.contains_key(&id) {
                app.show_toast("Model no longer available; refresh with /provider");
                return effects;
            }
            let efforts = app.models.reasoning_effort_options_for(&id);
            if choose_effort && !efforts.is_empty() {
                let mut options = efforts
                    .iter()
                    .map(|e| {
                        option(
                            &e.label,
                            e.description.as_deref().unwrap_or(if e.default {
                                "Provider default"
                            } else {
                                "Native reasoning effort"
                            }),
                            &format!("model-effort:{}:{}", e.value, id.0),
                        )
                    })
                    .collect::<Vec<_>>();
                options.push(option(
                    "Model default",
                    "Use the selected model's advertised default",
                    &format!("model-default:{}", id.0),
                ));
                card(
                    app,
                    "Choose reasoning effort for the selected model".into(),
                    options,
                    false,
                );
                return effects;
            }
            if app.provider.local_target == Some(target) {
                let subscription = id.0.starts_with("codex/") || id.0.starts_with("cursor/");
                if subscription
                    && !app.provider.catalog.providers.iter().any(|p| {
                        p.logged_in
                            && p.models
                                .iter()
                                .any(|m| id.0.as_ref() == format!("{}/{}", p.id.as_str(), m.id))
                    })
                {
                    app.show_toast(
                        "Sign in and refresh the provider catalog before choosing a model",
                    );
                    return effects;
                }
                let mut create =
                    super::session::lifecycle::start_local_session(app, target, Some(id.clone()));
                // Identify pre-SessionCreated ACP notifications without binding the
                // UI (binding early would let queued prompts sample prematurely).
                for effect in &mut create {
                    if let Effect::CreateSession {
                        preferred_session_id,
                        ..
                    } = effect
                    {
                        let sid = preferred_session_id
                            .get_or_insert_with(|| uuid::Uuid::new_v4().to_string());
                        app.provider.pending_session_id = Some(sid.clone());
                    }
                }
                app.provider.creating = !create.is_empty();
                // A CLI/deferred model must not replace the explicit picker choice.
                if app.provider.creating {
                    app.agents
                        .get_mut(&target)
                        .unwrap()
                        .session
                        .deferred_model_switch =
                        selected_effort.map(|effort| crate::app::agent::DeferredModelSwitch {
                            model_id: id.clone(),
                            effort: Some(effort),
                            prev_model_id: None,
                        });
                }
                effects.extend(create);
                return effects;
            }
            if app
                .agents
                .get(&target)
                .is_none_or(|a| a.session.session_id.is_none())
            {
                app.show_toast(
                    "Native session is still starting; choose the model again with /provider",
                );
                return effects;
            }
            effects.extend(queue_model_switch(app, target, id, selected_effort));
        }
        Command::Cancel => unreachable!(),
    }
    effects
}

pub(super) fn complete(
    app: &mut AppView,
    generation: u64,
    target: AgentId,
    reply: Reply,
) -> Vec<Effect> {
    if !app.provider.accepts(generation, target) || app.active_view != ActiveView::Agent(target) {
        // Even an unobserved start must be cancelled. A stale completion never selects a model.
        return match reply {
            Reply::Started(a) => vec![Effect::Provider {
                generation,
                target,
                operation: Operation::Cancel(a.attempt_id),
            }],
            _ => vec![],
        };
    }
    match reply {
        Reply::Catalog {
            catalog,
            models: state,
            provider,
        } => {
            let native_models = crate::acp::ModelState::from(Some(state));
            app.models.update_catalog(native_models.available.clone());
            for agent in app.agents.values_mut() {
                agent
                    .session
                    .models
                    .update_catalog(native_models.available.clone());
            }
            app.provider.catalog = catalog;
            if provider.is_none()
                && let Some(effects) = try_restore_preferred(app)
            {
                return effects;
            }
            if let Some(provider) = provider {
                models(app, provider);
            } else {
                menu(app);
            }
        }
        Reply::Started(attempt) => {
            use crate::app::link_opener::try_open_url;
            use crate::terminal::hyperlinks::SchemeFilter;
            // The safe opener only; unlike open_url_or_show it never writes auth URLs into scrollback.
            let _ = try_open_url(&attempt.url, SchemeFilter::Standard);
            let text = format!(
                "{}\n{}{}\nWaiting for sign-in… Esc cancels.",
                attempt.instructions,
                attempt.url,
                attempt
                    .user_code
                    .as_ref()
                    .map(|c| format!("\nDevice code: {c}"))
                    .unwrap_or_default()
            );
            let id = attempt.attempt_id.clone();
            app.provider.attempt = Some(attempt);
            card(
                app,
                text,
                vec![option(
                    "Cancel",
                    "Stop sign-in; keep the current model",
                    "cancel",
                )],
                false,
            );
            return vec![effect(app, Operation::Poll(id))];
        }
        Reply::Status {
            state: LoginState::Pending,
            ..
        } => {
            if let Some(a) = &app.provider.attempt {
                return vec![effect(app, Operation::Poll(a.attempt_id.clone()))];
            }
        }
        Reply::Status {
            state: LoginState::Completed,
            ..
        } => {
            app.provider.attempt = None;
            close_card(app);
            app.show_toast("Signed in; choose a model to switch this native session");
            return vec![effect(
                app,
                Operation::Catalog {
                    refresh: true,
                    provider: app.provider.selected,
                },
            )];
        }
        Reply::Status { state, message } => {
            app.provider.attempt = None;
            card(
                app,
                message.unwrap_or_else(|| format!("Sign-in {state:?}; current model unchanged")),
                vec![option("Choose provider", "Try again", "menu")],
                false,
            );
        }
        Reply::Error(message) => {
            // Static/sanitized control errors only; do not append them to session history.
            card(
                app,
                message,
                vec![
                    option("Choose provider", "Retry login or refresh", "menu"),
                    option("Cancel", "Keep current model", "cancel"),
                ],
                false,
            );
        }
        Reply::Cancelled => {}
    }
    vec![]
}

/// Queue the complete target without changing the live route, effort, tools or permissions.
pub(super) fn queue_model_switch(
    app: &mut AppView,
    target: AgentId,
    model_id: agent_client_protocol::ModelId,
    effort: Option<xai_grok_shell::sampling::types::ReasoningEffort>,
) -> Vec<Effect> {
    let Some(agent) = app.agents.get_mut(&target) else {
        return vec![];
    };
    let Some(session_id) = agent.session.session_id.clone() else {
        return vec![];
    };
    let models = if agent.session.models.available.contains_key(&model_id) {
        &agent.session.models
    } else {
        &app.models
    };
    if !models.available.contains_key(&model_id) {
        app.show_toast("Model no longer available; refresh and select again");
        return vec![];
    }
    if let Some(effort) = effort {
        if let Err(error) = models.resolve_effort_for_model(&model_id, effort.as_str()) {
            app.show_toast(&error.message());
            return vec![];
        }
    }
    let replaced = app.provider.pending_models.selections.contains_key(&target);
    let label = format!(
        "{}{}",
        models.display_name_for(&model_id),
        effort.map(|e| format!(" ({e} effort)")).unwrap_or_default()
    );
    let revision_for = |catalog: &xai_grok_shell::polycode::Catalog| {
        catalog
            .providers
            .iter()
            .find(|p| {
                p.models
                    .iter()
                    .any(|m| model_id.0.as_ref() == format!("{}/{}", p.id.as_str(), m.id))
            })
            .and_then(|p| p.catalog_revision.clone())
    };
    let catalog_revision = revision_for(&app.provider.catalog)
        .or_else(|| xai_grok_shell::polycode::bridge().and_then(|b| revision_for(&b.catalog())));
    let mut selection = app
        .provider
        .pending_models
        .queue(target, session_id, model_id, effort);
    selection.catalog_revision = catalog_revision;
    app.provider
        .pending_models
        .selections
        .insert(target, selection.clone());
    agent.session.model_switch_pending = true;
    app.show_toast(&format!(
        "{}Queued switch to {label}; applies after current work completes. /model cancel cancels.",
        if replaced {
            "Replaced pending selection. "
        } else {
            ""
        }
    ));
    vec![Effect::PolycodeSwitchModel(selection)]
}
pub(super) fn cancel_active_model_switch(app: &mut AppView) -> Vec<Effect> {
    let ActiveView::Agent(id) = app.active_view else {
        return vec![];
    };
    let Some(selection) = app.provider.pending_models.selections.remove(&id) else {
        return vec![];
    };
    if let Some(agent) = app.agents.get_mut(&id) {
        agent.session.model_switch_pending = false;
    }
    vec![Effect::CancelPendingModelSwitch {
        session_id: selection.session_id,
        selection_id: selection.selection_id,
    }]
}
pub(super) fn cancel_model_switches(app: &mut AppView) -> Vec<Effect> {
    let pending = std::mem::take(&mut app.provider.pending_models.selections);
    pending
        .into_iter()
        .map(|(id, selection)| {
            if let Some(agent) = app.agents.get_mut(&id) {
                agent.session.model_switch_pending = false;
            }
            Effect::CancelPendingModelSwitch {
                session_id: selection.session_id,
                selection_id: selection.selection_id,
            }
        })
        .collect()
}
pub(super) fn model_switch_complete(
    app: &mut AppView,
    selection: crate::app::model_settings::Selection,
    result: Result<
        Option<xai_grok_shell::sampling::types::ReasoningEffort>,
        crate::app::actions::SwitchModelError,
    >,
) -> Vec<Effect> {
    let current_session = app
        .agents
        .get(&selection.agent_id)
        .and_then(|a| a.session.session_id.as_ref());
    if !app
        .provider
        .pending_models
        .accepts(&selection, current_session)
    {
        return vec![];
    }
    app.provider
        .pending_models
        .selections
        .remove(&selection.agent_id);
    let applied_effort = result.as_ref().ok().copied().flatten();
    let succeeded = result.is_ok();
    let effects = super::session::lifecycle::handle_polycode_switch_model_complete(
        app,
        selection.agent_id,
        selection.model_id.clone(),
        applied_effort,
        result.map(|_| ()),
    );
    if succeeded {
        app.show_toast(&format!(
            "Applied switch to {}{}",
            selection.model_id.0,
            applied_effort
                .map(|e| format!(" ({e} effort)"))
                .unwrap_or_default()
        ));
    }
    effects
}

pub(crate) fn answer(id: &str, login: bool) -> Command {
    match id {
        "grok" => Command::Choose {
            provider: Choice::Grok,
            login,
        },
        "codex" => Command::Choose {
            provider: Choice::Subscription(ProviderId::Codex),
            login,
        },
        "cursor" => Command::Choose {
            provider: Choice::Subscription(ProviderId::Cursor),
            login,
        },
        "refresh" => Command::Refresh,
        "menu" => Command::Menu { login },
        s if s.starts_with("model-effort:") => {
            match s[13..]
                .split_once(':')
                .and_then(|(effort, model)| effort.parse().ok().map(|e| (e, model)))
            {
                Some((effort, model)) => Command::ModelEffort(model.to_owned(), Some(effort)),
                None => Command::Cancel,
            }
        }
        s if s.starts_with("model-default:") => Command::ModelEffort(s[14..].to_owned(), None),
        s if s.starts_with("model:") => Command::Model(s[6..].to_owned()),
        _ => Command::Cancel,
    }
}
