use super::*;
use crate::app::dispatch::provider::{complete, dispatch_enabled};
use crate::app::provider::{Choice, Command, Operation, Reply};
use crate::views::question_view::LocalQuestionKind;
use xai_grok_shell::polycode::{Catalog, LoginAttempt, LoginState, ProviderId};

#[test]
fn polycode_unauthenticated_startup_opens_local_provider_ui_without_authentication() {
    let mut app = test_app();
    let effects = dispatch_enabled(&mut app, Command::Menu { login: false });
    let ActiveView::Agent(id) = app.active_view else {
        panic!("native view missing")
    };
    let q = app.agents[&id].question_view.as_ref().unwrap();
    assert!(matches!(
        q.local_kind,
        Some(LocalQuestionKind::Provider { .. })
    ));
    assert!(q.response_tx.is_none());
    assert!(app.agents[&id].session.session_id.is_none());
    assert!(app.agents[&id].mcp_init_progress.is_none());
    assert!(!app.agents[&id].session.prompt_history_loading);
    assert_eq!(
        q.questions[0]
            .options
            .iter()
            .filter_map(|o| o.id.as_deref())
            .collect::<Vec<_>>(),
        ["grok", "codex", "cursor", "refresh"]
    );
    assert!(!app.external_acp);
    assert!(effects.iter().any(|e| matches!(
        e,
        Effect::Provider {
            operation: Operation::Catalog { .. },
            ..
        }
    )));
    assert!(!effects.iter().any(|e| matches!(
        e,
        Effect::Authenticate { .. } | Effect::SwitchModel { .. } | Effect::CreateSession { .. }
    )));
}

#[test]
fn polycode_switch_preserves_native_session_tools_mcp_and_permissions_and_persists_after_success() {
    let mut app = test_app_with_agent();
    let target = AgentId(0);
    let model_id = acp::ModelId::new("codex/actual-model");
    app.models.available.insert(
        model_id.clone(),
        acp::ModelInfo::new(model_id.clone(), "ChatGPT Model"),
    );
    let agent = app.agents.get_mut(&target).unwrap();
    agent.session.available_tools = Some(
        ["Bash".into(), "Read".into(), "mcp__test__search".into()]
            .into_iter()
            .collect(),
    );
    agent.session.yolo_mode = true;
    let session_id = agent.session.session_id.clone();
    let tools = agent.session.available_tools.clone();
    let cwd = agent.session.cwd.clone();
    let tx = agent.session.acp_tx.clone();
    let effects = dispatch_enabled(&mut app, Command::Model(model_id.0.to_string()));
    assert_eq!(effects.len(), 1);
    assert!(
        matches!(&effects[0], Effect::SwitchModel { agent_id, session_id: sid, model_id: mid, .. } if *agent_id == target && Some(sid.clone()) == session_id && mid == &model_id)
    );
    assert!(!app.external_acp);
    let effects = dispatch_task_result(
        TaskResult::SwitchModelComplete {
            agent_id: target,
            model_id: model_id.clone(),
            effort: None,
            result: Ok(()),
            prev_model_id: None,
        },
        &mut app,
    );
    assert!(
        effects
            .iter()
            .any(|e| matches!(e, Effect::PersistPreferredModel { .. }))
    );
    let agent = &app.agents[&target];
    assert_eq!(agent.session.session_id, session_id);
    assert_eq!(agent.session.available_tools, tools);
    assert_eq!(agent.session.cwd, cwd);
    assert!(agent.session.yolo_mode);
    assert!(agent.session.acp_tx.same_channel(&tx));
    assert_eq!(agent.session.models.current, Some(model_id));
}

#[test]
fn polycode_busy_switch_requires_explicit_cancel_without_dropping_tools() {
    let mut app = test_app_with_agent();
    app.agents.get_mut(&AgentId(0)).unwrap().session.state = AgentState::TurnRunning;
    let previous = app.agents[&AgentId(0)].session.models.current.clone();
    assert!(
        dispatch_enabled(
            &mut app,
            Command::Choose {
                provider: Choice::Subscription(ProviderId::Cursor),
                login: true
            }
        )
        .is_empty()
    );
    assert!(app.agents[&AgentId(0)].session.state.is_busy());
    assert_eq!(app.agents[&AgentId(0)].session.models.current, previous);
    assert!(app.agents[&AgentId(0)].question_view.is_none());
}

fn setup_login() -> AppView {
    let mut app = test_app_with_agent();
    app.provider.target = Some(AgentId(0));
    app.provider.selected = Some(Choice::Subscription(ProviderId::Codex));
    app.provider.attempt = Some(LoginAttempt {
        attempt_id: "attempt-one".into(),
        url: "https://example.com/login".into(),
        instructions: "Sign in".into(),
        user_code: None,
    });
    app
}

#[test]
fn polycode_success_refreshes_catalog_but_never_switches_before_model_selection() {
    let mut app = setup_login();
    let current = app.agents[&AgentId(0)].session.models.current.clone();
    let effects = complete(
        &mut app,
        0,
        AgentId(0),
        Reply::Status {
            state: LoginState::Completed,
            message: None,
        },
    );
    assert_eq!(effects.len(), 1);
    assert!(matches!(
        effects[0],
        Effect::Provider {
            operation: Operation::Catalog {
                refresh: true,
                provider: Some(Choice::Subscription(ProviderId::Codex))
            },
            ..
        }
    ));
    assert_eq!(app.agents[&AgentId(0)].session.models.current, current);
    assert!(app.provider.attempt.is_none());
}

#[test]
fn polycode_failure_cancel_and_stale_attempts_never_switch_models() {
    let mut app = setup_login();
    let current = app.agents[&AgentId(0)].session.models.current.clone();
    let effects = complete(
        &mut app,
        0,
        AgentId(0),
        Reply::Status {
            state: LoginState::Failed,
            message: Some("Sign-in failed".into()),
        },
    );
    assert!(effects.is_empty());
    assert!(app.agents[&AgentId(0)].question_view.is_some());
    assert_eq!(app.agents[&AgentId(0)].session.models.current, current);
    assert!(app.agents[&AgentId(0)].scrollback.is_empty());
    let mut app = setup_login();
    let effects = dispatch_enabled(&mut app, Command::Cancel);
    assert!(
        matches!(&effects[0], Effect::Provider { operation: Operation::Cancel(id), .. } if id == "attempt-one")
    );
    assert!(
        complete(
            &mut app,
            0,
            AgentId(0),
            Reply::Status {
                state: LoginState::Completed,
                message: None
            }
        )
        .is_empty()
    );
    let stale = LoginAttempt {
        attempt_id: "late-start".into(),
        url: "https://example.com".into(),
        instructions: String::new(),
        user_code: None,
    };
    let effects = complete(&mut app, 0, AgentId(0), Reply::Started(stale));
    assert!(
        matches!(&effects[0], Effect::Provider { operation: Operation::Cancel(id), .. } if id == "late-start")
    );
    assert_eq!(app.agents[&AgentId(0)].session.models.current, current);
}

#[test]
fn polycode_native_and_subscription_catalogs_coexist_in_the_existing_model_picker() {
    let mut app = setup_login();
    let catalog: Catalog = serde_json::from_value(serde_json::json!({"providers":[{"id":"cursor","name":"Cursor","loggedIn":true,"models":[{"id":"actual","name":"Model","contextWindow":128000}]}]})).unwrap();
    let grok = acp::ModelId::new("native-grok");
    let cursor = acp::ModelId::new("cursor/actual");
    let state = acp::SessionModelState::new(
        grok.clone(),
        vec![
            acp::ModelInfo::new(grok.clone(), "Grok"),
            acp::ModelInfo::new(cursor.clone(), "Cursor Model"),
        ],
    );
    complete(
        &mut app,
        0,
        AgentId(0),
        Reply::Catalog {
            catalog,
            models: state,
            provider: Some(Choice::Subscription(ProviderId::Cursor)),
        },
    );
    assert!(app.models.available.contains_key(&grok));
    assert!(app.models.available.contains_key(&cursor));
    assert!(
        app.agents[&AgentId(0)]
            .session
            .models
            .available
            .contains_key(&grok)
    );
    let q = app.agents[&AgentId(0)].question_view.as_ref().unwrap();
    assert_eq!(
        q.questions[0].options[0].id.as_deref(),
        Some("model:cursor/actual")
    );
    assert!(q.response_tx.is_none());
}
