//! Native provider picker and OAuth state machine. Local questions have no ACP response
//! sender, so provider management can never enter the model conversation.
use crate::app::provider::{Choice, Command, Operation, Reply};
use crate::app::{
    actions::{Action, Effect},
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
    agent.prompt.set_text("");
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
        "Refresh the subscription model catalog",
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
fn models(app: &mut AppView, provider: Choice) {
    let options = match provider {
        Choice::Grok => app
            .models
            .available
            .iter()
            .filter(|(id, _)| !id.0.starts_with("codex/") && !id.0.starts_with("cursor/"))
            .map(|(id, m)| option(&m.name, "Native model", &format!("model:{}", id.0)))
            .collect::<Vec<_>>(),
        Choice::Subscription(id) => app
            .provider
            .catalog
            .providers
            .iter()
            .filter(|p| p.id == id)
            .flat_map(|p| {
                p.models.iter().map(move |m| {
                    option(
                        &m.name,
                        &format!("{} token context", m.context_window),
                        &format!("model:{}/{}", id.as_str(), m.id),
                    )
                })
            })
            .collect(),
    };
    if options.is_empty() {
        app.show_toast("No models available yet; use /login or /provider refresh");
        menu(app);
    } else {
        card(
            app,
            "Choose a model for this native session".into(),
            options,
            false,
        );
    }
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
        close_card(app);
        let effects = invalidate(app);
        app.show_toast("Provider login cancelled; the current model is unchanged");
        return effects;
    }
    dispatch_enabled(app, command)
}

pub(super) fn dispatch_enabled(app: &mut AppView, command: Command) -> Vec<Effect> {
    if matches!(command, Command::Cancel) {
        close_card(app);
        return invalidate(app);
    }
    if let ActiveView::Agent(id) = app.active_view
        && let Some(agent) = app.agents.get(&id)
    {
        if agent.session.state.is_busy() || agent.session.model_switch_pending {
            app.show_toast(
                "Wait for the current turn, or cancel it before switching providers/models",
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
    if !matches!(app.active_view, ActiveView::Agent(_)) {
        effects.extend(super::session::lifecycle::dispatch_new_session_inner(
            app, None,
        ));
    }
    let ActiveView::Agent(target) = app.active_view else {
        return effects;
    };
    // Cancel an attempt in its original scope before changing targets.
    effects.extend(invalidate(app));
    app.provider.target = Some(target);
    close_card(app);
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
        Command::Model(model) => {
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
            let id = agent_client_protocol::ModelId::new(model);
            if !app.models.available.contains_key(&id) {
                app.show_toast("Model no longer available; refresh with /provider");
                return effects;
            }
            effects.extend(super::router::dispatch(
                Action::SwitchModel {
                    model_id: id,
                    effort: None,
                },
                app,
            ));
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
        s if s.starts_with("model:") => Command::Model(s[6..].to_owned()),
        _ => Command::Cancel,
    }
}
