use super::*;
use crate::app::dispatch::provider::{complete, dispatch_enabled};
use crate::app::provider::{Choice, Command, Operation, Reply};
use xai_grok_shell::polycode::{Catalog, LoginAttempt, LoginState, ProviderId};

fn local_picker() -> (AppView, AgentId) {
    let mut app = test_app();
    let effects = dispatch_enabled(&mut app, Command::Menu { login: true });
    assert!(effects.iter().all(|e| matches!(e, Effect::Provider { .. })));
    let ActiveView::Agent(id) = app.active_view else {
        panic!("missing local picker")
    };
    assert_eq!(app.provider.local_target, Some(id));
    assert!(!app.provider.creating);
    (app, id)
}

fn catalog_reply(logged_in: bool) -> Reply {
    startup_catalog_reply(logged_in, Some(Choice::Subscription(ProviderId::Codex)))
}

fn startup_catalog_reply(logged_in: bool, provider: Option<Choice>) -> Reply {
    let model = acp::ModelId::new("codex/actual");
    let catalog: Catalog = serde_json::from_value(serde_json::json!({"providers":[{
        "id":"codex", "name":"ChatGPT", "loggedIn": logged_in,
        "models":[{"id":"actual", "name":"Actual", "contextWindow":128000}]
    }]}))
    .unwrap();
    Reply::Catalog {
        catalog,
        models: acp::SessionModelState::new(
            model.clone(),
            vec![acp::ModelInfo::new(model, "Actual")],
        ),
        provider,
    }
}

fn publish_catalog(app: &mut AppView, id: AgentId, logged_in: bool) {
    let generation = app.provider.generation;
    assert!(complete(app, generation, id, catalog_reply(logged_in)).is_empty());
}

fn startup_picker() -> (AppView, AgentId) {
    let mut app = test_app();
    let effects = dispatch_enabled(&mut app, Command::Menu { login: false });
    assert!(effects.iter().all(|e| matches!(e, Effect::Provider { .. })));
    let ActiveView::Agent(id) = app.active_view else {
        panic!("missing local picker")
    };
    assert_eq!(app.provider.local_target, Some(id));
    assert!(!app.provider.login_menu);
    (app, id)
}

#[test]
fn polycode_startup_reuses_last_signed_in_model_without_the_picker() {
    let (mut app, id) = startup_picker();
    app.provider.preferred_model = Some("codex/actual".into());
    let generation = app.provider.generation;
    let effects = complete(&mut app, generation, id, startup_catalog_reply(true, None));
    assert!(
        matches!(&effects[..], [Effect::CreateSession { agent_id, model_id: Some(mid), .. }]
        if *agent_id == id && mid.0.as_ref() == "codex/actual"),
        "expected restored session, got {effects:?}"
    );
    assert!(app.provider.creating);
    assert!(app.provider.restore_attempted);
    assert!(app.agents[&id].question_view.is_none());
    assert!(app.agents[&id].active_modal.is_none());
}

#[test]
fn polycode_startup_keeps_picker_when_last_model_is_signed_out() {
    let (mut app, id) = startup_picker();
    app.provider.preferred_model = Some("codex/actual".into());
    let generation = app.provider.generation;
    let effects = complete(&mut app, generation, id, startup_catalog_reply(false, None));
    assert!(effects.is_empty());
    assert!(!app.provider.creating);
    assert!(app.provider.restore_attempted);
    let q = app.agents[&id].question_view.as_ref().unwrap();
    assert!(matches!(
        q.local_kind,
        Some(crate::views::question_view::LocalQuestionKind::Provider { .. })
    ));
}

#[test]
fn polycode_startup_does_not_restore_or_overlay_picker_on_a_bound_session() {
    let (mut app, id) = startup_picker();
    app.provider.preferred_model = Some("codex/actual".into());
    app.agents.get_mut(&id).unwrap().session.session_id =
        Some(acp::SessionId::new("resumed-session"));
    let generation = app.provider.generation;
    let effects = complete(&mut app, generation, id, startup_catalog_reply(true, None));
    assert!(
        effects.is_empty(),
        "expected no create/restore over resume, got {effects:?}"
    );
    assert!(!app.provider.creating);
    assert!(app.provider.restore_attempted);
    assert!(app.agents[&id].question_view.is_none());
    assert!(app.agents[&id].active_modal.is_none());
    assert_eq!(
        app.agents[&id]
            .session
            .session_id
            .as_ref()
            .unwrap()
            .0
            .as_ref(),
        "resumed-session"
    );
}

#[test]
fn polycode_login_menu_does_not_auto_restore_last_model() {
    let (mut app, id) = local_picker();
    app.provider.preferred_model = Some("codex/actual".into());
    let generation = app.provider.generation;
    let effects = complete(&mut app, generation, id, startup_catalog_reply(true, None));
    assert!(effects.is_empty());
    assert!(!app.provider.creating);
    assert!(!app.provider.restore_attempted);
    assert!(app.agents[&id].question_view.is_some());
}

#[test]
fn polycode_oauth_and_catalog_do_not_create_until_explicit_model_choice() {
    let (mut app, id) = local_picker();
    let effects = dispatch_enabled(
        &mut app,
        Command::Choose {
            provider: Choice::Subscription(ProviderId::Codex),
            login: true,
        },
    );
    assert!(matches!(
        &effects[..],
        [Effect::Provider {
            operation: Operation::Start(ProviderId::Codex),
            ..
        }]
    ));
    app.provider.attempt = Some(LoginAttempt {
        attempt_id: "local-attempt".into(),
        url: "https://example.com/login".into(),
        instructions: "Sign in".into(),
        user_code: None,
    });
    let generation = app.provider.generation;
    let effects = complete(
        &mut app,
        generation,
        id,
        Reply::Status {
            state: LoginState::Completed,
            message: None,
        },
    );
    assert!(matches!(
        &effects[..],
        [Effect::Provider {
            operation: Operation::Catalog { refresh: true, .. },
            ..
        }]
    ));
    assert!(app.agents[&id].session.session_id.is_none());
    assert!(app.agents[&id].mcp_init_progress.is_none());
    publish_catalog(&mut app, id, true);
    assert!(!app.provider.creating);
    let tx = app.agents[&id].session.acp_tx.clone();
    let effects = dispatch_enabled(&mut app, Command::Model("codex/actual".into()));
    assert!(
        matches!(&effects[..], [Effect::CreateSession { agent_id, model_id: Some(mid), permission_mode_override: None, .. }]
        if *agent_id == id && mid.0.as_ref() == "codex/actual")
    );
    assert!(app.provider.creating);
    assert!(app.agents[&id].session.acp_tx.same_channel(&tx));
    assert!(app.agents[&id].session.deferred_model_switch.is_none());
    assert!(dispatch_enabled(&mut app, Command::Model("codex/actual".into())).is_empty());

    let mid = acp::ModelId::new("codex/actual");
    let effects = dispatch_task_result(
        TaskResult::SessionCreated {
            agent_id: id,
            session_id: acp::SessionId::new("native-same-session"),
            models: Some(acp::SessionModelState::new(
                mid.clone(),
                vec![acp::ModelInfo::new(mid, "Actual")],
            )),
            scheduler_background_loops: None,
        },
        &mut app,
    );
    assert!(app.provider.local_target.is_none());
    assert!(!app.provider.creating);
    assert!(effects.iter().any(|e| matches!(e, Effect::PersistPreferredModel { model_id, .. } if model_id.0.as_ref() == "codex/actual")));
    let effects = dispatch_enabled(&mut app, Command::Model("codex/actual".into()));
    assert!(!effects
        .iter()
        .any(|e| matches!(e, Effect::CreateSession { .. })));
    assert_eq!(
        app.agents[&id]
            .session
            .session_id
            .as_ref()
            .unwrap()
            .0
            .as_ref(),
        "native-same-session"
    );
}

#[test]
fn polycode_signed_out_catalog_and_unknown_models_cannot_bootstrap() {
    let (mut app, id) = local_picker();
    publish_catalog(&mut app, id, false);
    for model in ["codex/actual", "codex/unknown"] {
        assert!(dispatch_enabled(&mut app, Command::Model(model.into())).is_empty());
        assert!(!app.provider.creating);
    }
    assert!(app.agents[&id].session.session_id.is_none());
}

#[test]
fn polycode_cancelled_login_cannot_create_from_late_success_or_catalog() {
    let (mut app, id) = local_picker();
    let generation = app.provider.generation;
    assert!(dispatch_enabled(&mut app, Command::Cancel).is_empty());
    assert!(!app.agents.contains_key(&id));
    assert_eq!(app.active_view, ActiveView::Welcome);
    for reply in [
        Reply::Status {
            state: LoginState::Completed,
            message: None,
        },
        catalog_reply(true),
    ] {
        assert!(complete(&mut app, generation, id, reply).is_empty());
    }
    assert!(app.agents.is_empty());
}

#[test]
fn polycode_cancelled_creation_cannot_bind_or_reset_successor_picker() {
    let (mut app, old) = local_picker();
    publish_catalog(&mut app, old, true);
    dispatch_enabled(&mut app, Command::Model("codex/actual".into()));
    let retired = app.provider.pending_session_id.clone().unwrap();
    dispatch_enabled(&mut app, Command::Cancel);
    assert!(app.provider.retired_sessions.contains(&retired));
    assert!(app.provider.pending_session_id.is_none());
    dispatch_enabled(&mut app, Command::Menu { login: true });
    let ActiveView::Agent(new) = app.active_view else {
        panic!("successor missing")
    };
    assert_ne!(old, new);
    let model_before = app.models.current.clone();
    for result in [
        TaskResult::SessionCreated {
            agent_id: old,
            session_id: acp::SessionId::new("orphan"),
            models: None,
            scheduler_background_loops: None,
        },
        TaskResult::SessionFailed {
            agent_id: old,
            error: "late failure".into(),
        },
    ] {
        assert!(dispatch_task_result(result, &mut app).is_empty());
        assert_eq!(app.active_view, ActiveView::Agent(new));
        assert_eq!(app.provider.local_target, Some(new));
        assert!(app.agents[&new].session.session_id.is_none());
        assert!(app.agents[&new].question_view.is_some());
        assert_eq!(app.models.current, model_before);
    }
}

#[test]
fn polycode_failed_bootstrap_keeps_local_provider_card_retryable() {
    let (mut app, id) = local_picker();
    publish_catalog(&mut app, id, true);
    dispatch_enabled(&mut app, Command::Model("codex/actual".into()));
    let effects = dispatch_task_result(
        TaskResult::SessionFailed {
            agent_id: id,
            error: "provider unavailable".into(),
        },
        &mut app,
    );
    assert!(effects.is_empty());
    assert_eq!(app.active_view, ActiveView::Agent(id));
    assert!(!app.provider.creating);
    assert!(app.agents[&id].question_view.is_some());
    assert!(app.agents[&id].mcp_init_progress.is_none());
    let effects = dispatch_enabled(&mut app, Command::Model("codex/actual".into()));
    assert!(
        matches!(&effects[..], [Effect::CreateSession { model_id: Some(mid), .. }] if mid.0.as_ref() == "codex/actual")
    );
}
