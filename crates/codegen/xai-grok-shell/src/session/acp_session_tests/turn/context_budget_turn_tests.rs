//! The opt-in `context_budget` reminder rides the real turn loop: it appears in the outgoing
//! request only when the feature is on and utilization is at or above the floor, and it is
//! never written into persisted history.

use super::rate_limit_backoff_tests::{SessionKind, actor_under_test, pump_local_tasks};
use super::*;
use std::time::Duration;
use xai_grok_sampling_types::ConversationItem;
use xai_grok_test_support::{MockInferenceServer, MockModelEntry};

const CONTEXT_WINDOW: u64 = 256_000;
const BUDGET_MARKER: &str = "Context budget:";

/// The turn future needs a session-sized stack (spawn.rs: 8 MiB); default test stacks overflow.
fn on_session_stack(test: impl FnOnce() + Send + 'static) {
    std::thread::Builder::new()
        .stack_size(8 * 1024 * 1024)
        .spawn(test)
        .expect("spawn test thread")
        .join()
        .expect("test thread panicked");
}

fn run_local<F: std::future::Future>(fut: impl FnOnce() -> F) {
    let rt = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("test runtime");
    let local = tokio::task::LocalSet::new();
    rt.block_on(local.run_until(async move {
        fut().await;
    }));
}

/// Rebuild the actor's immutable `Agent` with the `context_budget` gate set.
fn set_context_budget(actor: &SessionActor, enabled: bool) {
    let rebuilt = {
        let base = actor.agent.borrow();
        xai_grok_agent::Agent::new(
            base.definition().clone(),
            xai_grok_agent::PromptContext::default(),
            base.system_prompt().to_string(),
            base.tool_bridge().clone(),
            xai_grok_agent::ReminderPolicy::default(),
            xai_grok_agent::CompactionPolicy {
                context_budget_enabled: enabled,
                ..Default::default()
            },
            Vec::new(),
            false,
        )
    };
    *actor.agent.borrow_mut() = rebuilt;
}

/// Drive one real turn and return the serialized request bodies plus the persisted history.
///
/// The history excludes assistant items: the mock server's default reply echoes the
/// request's last input, so the assistant text legitimately repeats whatever was sent.
async fn run_turn(
    server: &MockInferenceServer,
    enabled: bool,
    total_tokens: u64,
) -> (Vec<String>, Vec<String>) {
    let (actor, _retries) = actor_under_test(
        server,
        SessionKind::Main,
        xai_grok_sampler::RetryPolicy::default(),
        true,
    )
    .await;
    set_context_budget(&actor, enabled);
    actor.chat_state_handle.record_token_usage(total_tokens);
    let cfg = actor
        .chat_state_handle
        .get_sampling_config()
        .await
        .expect("test actor has sampling config");
    assert_eq!(
        cfg.context_window.get(),
        CONTEXT_WINDOW,
        "fixture context window drives the utilization math"
    );
    server.set_keep_requests(true);

    let outcome = tokio::time::timeout(
        Duration::from_secs(300),
        actor.process_conversation_turn_with_recovery(
            "req-context-budget-test",
            None,
            None,
            None,
            &mut length_salvage::LengthSalvage::new(None),
        ),
    )
    .await
    .expect("turn must finish within timeout");
    assert!(
        outcome.is_ok(),
        "mock success must complete the turn: {:?}",
        outcome.as_ref().map(|_| "TurnOutcome").err()
    );
    pump_local_tasks().await;

    let bodies = server
        .request_bodies()
        .into_iter()
        .map(|body| body.to_string())
        .collect();
    let history = actor
        .chat_state_handle
        .get_conversation()
        .await
        .into_iter()
        .filter(|item| !matches!(item, ConversationItem::Assistant(_)))
        .map(|item| serde_json::to_string(&item).expect("conversation item serializes"))
        .collect();
    (bodies, history)
}

#[test]
fn enabled_at_floor_injects_reminder_into_request_but_not_history() {
    on_session_stack(|| {
        run_local(|| async {
            let server = MockInferenceServer::start_with_models(vec![MockModelEntry::new("test")])
                .await
                .expect("mock inference server");
            // 58% used: above the 50% floor, below the 85% auto-compact threshold.
            let (bodies, history) = run_turn(&server, true, 150_000).await;

            assert!(!bodies.is_empty(), "the turn must submit a request");
            let budget_requests = bodies
                .iter()
                .filter(|body| body.contains(BUDGET_MARKER))
                .count();
            assert_eq!(
                budget_requests,
                bodies.len(),
                "every sampling request carries the reminder: {bodies:#?}"
            );
            let body = &bodies[0];
            assert!(
                body.contains("system-reminder"),
                "reminder is wrapped in the system-reminder tag: {body}"
            );
            // The window and the auto-compact threshold come straight from the live
            // sampling config and session policy; the used count is the recorded usage
            // (plus any bytes/4 estimate), so the percentage sits in the 58–60% band.
            assert!(
                body.contains("of 256000 tokens used (58%)")
                    || body.contains("of 256000 tokens used (59%)")
                    || body.contains("of 256000 tokens used (60%)"),
                "reminder reports the live used/window numbers: {body}"
            );
            assert!(
                body.contains("near 85% of the window"),
                "reminder reports the session auto-compact threshold: {body}"
            );
            assert!(
                !history.iter().any(|item| item.contains(BUDGET_MARKER)),
                "the reminder is ephemeral and never persisted: {history:#?}"
            );
        });
    });
}

#[test]
fn enabled_below_floor_stays_silent() {
    on_session_stack(|| {
        run_local(|| async {
            let server = MockInferenceServer::start_with_models(vec![MockModelEntry::new("test")])
                .await
                .expect("mock inference server");
            // 39% used: below the 50% floor.
            let (bodies, history) = run_turn(&server, true, 100_000).await;

            assert!(!bodies.is_empty(), "the turn must submit a request");
            assert!(
                !bodies.iter().any(|body| body.contains(BUDGET_MARKER)),
                "no reminder below the floor: {bodies:#?}"
            );
            assert!(!history.iter().any(|item| item.contains(BUDGET_MARKER)));
        });
    });
}

#[test]
fn disabled_never_injects_even_when_pressured() {
    on_session_stack(|| {
        run_local(|| async {
            let server = MockInferenceServer::start_with_models(vec![MockModelEntry::new("test")])
                .await
                .expect("mock inference server");
            let (bodies, history) = run_turn(&server, false, 150_000).await;

            assert!(!bodies.is_empty(), "the turn must submit a request");
            assert!(
                !bodies.iter().any(|body| body.contains(BUDGET_MARKER)),
                "feature off means no reminder regardless of pressure: {bodies:#?}"
            );
            assert!(!history.iter().any(|item| item.contains(BUDGET_MARKER)));
        });
    });
}
