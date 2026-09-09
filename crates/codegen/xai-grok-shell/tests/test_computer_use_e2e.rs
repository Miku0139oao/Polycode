//! `computer` tool end to end through the real `MvpAgent`: the `computer_use` feature flag
//! decides whether the tool is advertised to the model, a scripted tool call reaches the
//! native permission prompt (with the session-scoped "allow computer use" option), and the
//! tool result is fed back to the model on the next request.

mod acp_harness;

use std::cell::RefCell;
use std::rc::Rc;

use acp_harness::{
    RPC_TIMEOUT, allow_once, connect_and_auth, new_session, prompt_turn, run_agent_test,
};
use agent_client_protocol::{self as acp};
use xai_grok_test_support::ScriptedResponse;
use xai_grok_test_support::sse::chat_completions_reasoning_then_tool_call_events;

const COMPUTER_FLAG: &str = "GROK_COMPUTER_USE";
const CALL_ID: &str = "cu-e2e-call-1";
/// The prompter offers this option only for `computer` prompts.
const ALLOW_COMPUTER_SESSION_OPTION_ID: &str = "allow-computer-session";

/// Records every permission prompt and answers allow-once.
#[derive(Default)]
struct RecordingClient {
    prompts: Rc<RefCell<Vec<acp::RequestPermissionRequest>>>,
}

#[async_trait::async_trait(?Send)]
impl acp::Client for RecordingClient {
    async fn request_permission(
        &self,
        args: acp::RequestPermissionRequest,
    ) -> acp::Result<acp::RequestPermissionResponse> {
        let outcome = allow_once(&args);
        self.prompts.borrow_mut().push(args);
        Ok(acp::RequestPermissionResponse::new(outcome))
    }

    async fn session_notification(&self, _: acp::SessionNotification) -> acp::Result<()> {
        Ok(())
    }
}

fn set_flag(value: Option<&str>) {
    // SAFETY: same contract as the harness's `set_test_env`; the agent runtime is
    // single-threaded and the mock's HTTP workers never read the environment.
    unsafe {
        match value {
            Some(v) => std::env::set_var(COMPUTER_FLAG, v),
            None => std::env::remove_var(COMPUTER_FLAG),
        }
    }
}

/// Main-turn `/v1/chat/completions` bodies, excluding turn-summary side requests.
fn chat_bodies(server: &xai_grok_test_support::MockInferenceServer) -> Vec<serde_json::Value> {
    server
        .requests()
        .into_iter()
        .filter(|r| r.path == "/v1/chat/completions")
        .filter(|r| {
            !r.header("x-grok-req-id")
                .is_some_and(|id| id.starts_with("xai-turn-summary-"))
        })
        .filter_map(|r| r.body)
        .collect()
}

fn on_path(program: &str) -> bool {
    std::env::var_os("PATH")
        .is_some_and(|path| std::env::split_paths(&path).any(|dir| dir.join(program).is_file()))
}

fn advertised_tool_names(body: &serde_json::Value) -> Vec<String> {
    body.get("tools")
        .and_then(|t| t.as_array())
        .map(|tools| {
            tools
                .iter()
                .filter_map(|t| t.pointer("/function/name").and_then(|n| n.as_str()))
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

#[test]
fn computer_tool_is_not_advertised_when_the_feature_is_off() {
    run_agent_test(|cwd, server| async move {
        set_flag(None);
        let (conn, _init) = connect_and_auth(RecordingClient::default(), "test-client").await;
        let session_id = new_session(&conn, &cwd).await;
        prompt_turn(&conn, &session_id, "hi").await;

        let bodies = chat_bodies(&server);
        assert!(!bodies.is_empty(), "the turn must reach the model");
        let names = advertised_tool_names(&bodies[0]);
        assert!(
            !names.iter().any(|n| n == "computer"),
            "computer must stay hidden while `computer_use` is off: {names:?}"
        );
    });
}

#[test]
fn computer_tool_call_is_permission_gated_and_its_result_reaches_the_model() {
    run_agent_test(|cwd, server| async move {
        set_flag(Some("1"));
        let client = RecordingClient::default();
        let prompts = client.prompts.clone();
        let (conn, _init) = connect_and_auth(client, "test-client").await;
        let session_id = new_session(&conn, &cwd).await;

        // Turn 1: the model asks to look at the screen; turn 2 falls through to the mock's echo.
        server.enqueue_response(
            "/v1/chat/completions",
            ScriptedResponse::sse(chat_completions_reasoning_then_tool_call_events(
                "",
                CALL_ID,
                "computer",
                r#"{"actions":[{"type":"screenshot"}]}"#,
                "test-model",
            )),
        );

        tokio::time::timeout(RPC_TIMEOUT, async {
            prompt_turn(&conn, &session_id, "what is on my screen?").await;
        })
        .await
        .expect("turn with a computer call must finish");
        set_flag(None);

        let bodies = chat_bodies(&server);
        assert!(
            bodies.len() >= 2,
            "expected the tool-call request plus the follow-up carrying its result, saw {}",
            bodies.len()
        );
        let names = advertised_tool_names(&bodies[0]);
        assert!(
            names.iter().any(|n| n == "computer"),
            "computer must be advertised while `computer_use` is on: {names:?}"
        );

        // Exactly one prompt, and it is the `computer` prompt (the only one offering the
        // session-scoped option). Desktop control is never auto-approved.
        let prompts = prompts.borrow();
        assert_eq!(
            prompts.len(),
            1,
            "one computer call → one permission prompt"
        );
        let option_ids: Vec<&str> = prompts[0]
            .options
            .iter()
            .map(|o| o.option_id.0.as_ref())
            .collect();
        assert!(
            option_ids.contains(&ALLOW_COMPUTER_SESSION_OPTION_ID),
            "computer prompt must offer the session-scoped grant: {option_ids:?}"
        );

        // The follow-up request carries a tool result for the call. Whether the desktop is
        // reachable depends on the host (CI has no display), so accept either the screenshot
        // summary or the in-band unavailability error; both are model-facing text, never a
        // protocol failure.
        let follow_up = bodies.last().unwrap().to_string();
        assert!(
            follow_up.contains(CALL_ID),
            "follow-up must reference the tool call id: {follow_up}"
        );
        let has_screenshot = follow_up.contains("Captured the screen");
        let has_error = follow_up.contains("Error:");
        assert!(
            has_screenshot || has_error,
            "follow-up must carry the computer tool result text: {follow_up}"
        );
        if std::env::var_os("DISPLAY").is_some() && on_path("xdotool") && on_path("scrot") {
            assert!(
                has_screenshot,
                "with a live display the result must be a screenshot summary: {follow_up}"
            );
        }
    });
}
