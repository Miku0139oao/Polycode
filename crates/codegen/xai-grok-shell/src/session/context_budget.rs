//! Model-agnostic context-budget reminder.
//!
//! This is a portable port of the token-budget tier of Codex's experimental
//! context management (`features.context_management.experimental_mode`): instead
//! of relying solely on lossy compaction to survive a long task, the session
//! injects an explicit, machine-readable remaining-context budget alongside each
//! model call so the model can pace itself, preserve durable state, and decide to
//! wrap up before older turns are summarized away.
//!
//! Unlike Codex — which gates the feature to the ChatGPT/Codex backend and the
//! Astra model — this reminder is a plain `<system-reminder>` user item, so it
//! works with every provider and model the fork can talk to. It is opt-in behind
//! the `context_budget` feature flag and ephemeral (injected into the outgoing
//! request only, never persisted into history), so the default behavior and the
//! on-disk transcript are unchanged.

use std::num::NonZeroU64;

/// Minimum context utilization (percent) before the per-turn budget reminder is
/// injected. Below this the reminder is suppressed so short tasks are unaffected
/// and the request prefix stays cache-stable until context pressure matters.
pub(crate) const CONTEXT_BUDGET_FLOOR_PERCENT: u8 = 50;

/// Tag used to wrap the injected reminder (matches the `<system-reminder>` convention).
const REMINDER_TAG: &str = "system-reminder";

/// Build the per-turn context-budget reminder, or `None` when usage is below the floor.
///
/// * `used` — estimated live context size in tokens (provider usage plus the
///   bytes/4 estimate for items pushed since the last response).
/// * `context_window` — the current model's context-window limit.
/// * `auto_compact_threshold_percent` — the utilization percentage at which
///   automatic compaction fires for this session.
///
/// The returned text is deliberately model-agnostic: it states the budget and
/// asks the model to pace itself, without ever suggesting it switch models,
/// lower its reasoning effort, or skip required steps to save tokens.
pub(crate) fn build_context_budget_reminder(
    used: u64,
    context_window: NonZeroU64,
    auto_compact_threshold_percent: u8,
) -> Option<String> {
    let cw = context_window.get();
    let pct = xai_token_estimation::usage_percentage_u8(used, cw);
    if pct < CONTEXT_BUDGET_FLOOR_PERCENT {
        return None;
    }
    let free = xai_token_estimation::free_tokens(cw, used);
    // Tokens remaining before auto-compaction (a lossy summary) triggers.
    let compact_at = cw.saturating_mul(auto_compact_threshold_percent as u64) / 100;
    let until_compact = compact_at.saturating_sub(used);
    let body = format!(
        "Context budget: about {used} of {cw} tokens used ({pct}%); ~{free} tokens remain. \
Automatic compaction (a lossy summary of this conversation) triggers near {auto_compact_threshold_percent}% of the window — about {until_compact} tokens from now. \
Spend the remaining budget deliberately: keep responses focused, avoid re-reading files or re-running commands whose output is already in context, and record any durable decisions, findings, or next steps (in your reply or via your notes/todo tools) before older turns are summarized away. \
Do not switch models, lower your reasoning effort, or skip required steps because of this budget."
    );
    Some(format!("<{REMINDER_TAG}>\n{body}\n</{REMINDER_TAG}>"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cw(n: u64) -> NonZeroU64 {
        NonZeroU64::new(n).unwrap()
    }

    #[test]
    fn suppressed_below_floor() {
        // 40% utilization is below the 50% floor.
        assert!(build_context_budget_reminder(40_000, cw(100_000), 85).is_none());
        // Exactly one token under the floor boundary is still suppressed.
        assert!(build_context_budget_reminder(49, cw(100), 85).is_none());
    }

    #[test]
    fn injected_at_and_above_floor() {
        // Exactly at the floor.
        assert!(build_context_budget_reminder(50, cw(100), 85).is_some());
        let text = build_context_budget_reminder(60_000, cw(100_000), 85).unwrap();
        // Wrapped in the system-reminder tag.
        assert!(text.starts_with("<system-reminder>\n"));
        assert!(text.ends_with("\n</system-reminder>"));
        // Reports usage, remaining, percentage, and threshold.
        assert!(text.contains("60000 of 100000 tokens used (60%)"));
        assert!(text.contains("~40000 tokens remain"));
        assert!(text.contains("near 85% of the window"));
        // 85% of 100_000 = 85_000; 85_000 - 60_000 = 25_000 remain until compaction.
        assert!(text.contains("about 25000 tokens from now"));
    }

    #[test]
    fn model_agnostic_guardrail_is_present() {
        let text = build_context_budget_reminder(70_000, cw(100_000), 85).unwrap();
        assert!(
            text.contains(
                "Do not switch models, lower your reasoning effort, or skip required steps"
            ),
            "reminder must not invite masking behavior"
        );
    }

    #[test]
    fn saturates_when_past_threshold() {
        // Used already past the auto-compact threshold: no negative countdown.
        let text = build_context_budget_reminder(90_000, cw(100_000), 85).unwrap();
        assert!(text.contains("about 0 tokens from now"));
        assert!(text.contains("(90%)"));
    }

    #[test]
    fn percentage_clamps_at_full() {
        // Over 100% (estimate can exceed the window) clamps to 100 and 0 free.
        let text = build_context_budget_reminder(120_000, cw(100_000), 85).unwrap();
        assert!(text.contains("(100%)"));
        assert!(text.contains("~0 tokens remain"));
    }
}
