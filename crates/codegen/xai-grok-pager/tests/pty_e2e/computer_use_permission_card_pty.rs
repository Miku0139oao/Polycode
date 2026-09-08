// Per-test-case module for the `pty_e2e` integration test crate.
#[allow(unused_imports)]
use super::common::*;

const DONE: &str = "COMPUTER_USE_TURN_SETTLED";
/// Label of the `computer` prompt's session-scoped option (see `AcpPrompter::computer_options`).
const SESSION_OPTION_LABEL: &str = "allow computer use for the rest of this session";

/// With `computer_use` on, a scripted `computer` call renders the native permission card in the
/// real TUI (with the session-scoped option), and allowing it lets the turn settle.
/// Without a desktop the tool reports an in-band error; the model-facing flow is the same.
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
#[ignore = "PTY e2e; run the owning pty_e2e_* Cargo test with --ignored (see Cargo.toml)"]
async fn computer_use_permission_card_pty() {
    let content = ContentController::start().await.expect("start content");

    let binary = pager_binary().expect("resolve pager binary");
    let mut harness = PtyHarness::spawn_with_content_env_ops_in_dir(
        &binary,
        DEFAULT_ROWS,
        DEFAULT_COLS,
        &content,
        &["--trust"],
        &[EnvOp::set("GROK_COMPUTER_USE", "1")],
        Some(content.home()),
    )
    .expect("spawn pager");

    harness
        .wait_for_text(WELCOME_SCREEN_SENTINEL, WELCOME_TIMEOUT)
        .expect("welcome");

    let _turn = expect_tool_turn(
        &content,
        "call_computer_screenshot",
        "computer",
        json!({ "actions": [{ "type": "screenshot" }] }).to_string(),
    );
    content.set_response(DONE);
    harness
        .inject_keys(b"what is on my screen?\r")
        .expect("submit prompt that triggers a computer call");

    harness
        .wait_for_text(SESSION_OPTION_LABEL, Duration::from_secs(60))
        .unwrap_or_else(|_| {
            panic!(
                "computer permission card must open with the session option; got:\n{}",
                harness.screen_contents()
            )
        });
    assert!(
        harness.contains_text("No, reject"),
        "computer card must offer reject; screen:\n{}",
        harness.screen_contents()
    );
    write_screen_dump_if_requested(&harness, "computer_use_permission_card");

    harness.inject_keys(b"1").expect("allow once");
    harness
        .wait_for_text(DONE, Duration::from_secs(90))
        .unwrap_or_else(|_| {
            panic!(
                "turn must settle after allowing the computer call; got:\n{}",
                harness.screen_contents()
            )
        });
    write_screen_dump_if_requested(&harness, "computer_use_turn_settled");

    assert!(
        !harness.contains_text("panicked"),
        "pager panicked\nscreen:\n{}",
        harness.screen_contents()
    );
    harness.quit().expect("clean quit");
}
