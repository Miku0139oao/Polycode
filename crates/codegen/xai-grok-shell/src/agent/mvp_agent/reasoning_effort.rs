//! Applies a reasoning-effort hint only when the model supports it; shared by session creation, model switch, and the summary client.

use agent_client_protocol as acp;
use xai_grok_sampler::SamplerConfig;
use xai_grok_sampling_types::ReasoningEffort;

use crate::agent::models::ModelsManager;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EffortTarget {
    NewSession,
    ModelSwitch,
    SummaryClient,
}

impl EffortTarget {
    fn as_str(self) -> &'static str {
        match self {
            Self::NewSession => "new_session",
            Self::ModelSwitch => "model_switch",
            Self::SummaryClient => "summary",
        }
    }
}

impl ModelsManager {
    pub(crate) fn apply_supported_effort(
        &self,
        sampling: &mut SamplerConfig,
        effort: Option<ReasoningEffort>,
        session_id: &acp::SessionId,
        target: EffortTarget,
    ) {
        let Some(effort) = effort else {
            return;
        };
        // Different subscriptions can advertise the same wire slug. Resolve capabilities by
        // the complete route rather than whichever bare slug happens to be first in the catalog.
        let model_key = self
            .models()
            .into_iter()
            .find(|(_, e)| e.info.model == sampling.model && e.info.base_url == sampling.base_url)
            .map(|(key, _)| key)
            .unwrap_or_else(|| sampling.model.clone());
        if !self.model_supports_reasoning_effort_value(&model_key, effort) {
            // SummaryClient stays quiet; the spawn or switch that carried this effort already warned that the model does not support it
            if matches!(target, EffortTarget::NewSession | EffortTarget::ModelSwitch) {
                tracing::warn!(
                    session_id = %session_id.0,
                    model = %sampling.model,
                    effort = %effort,
                    "reasoning_effort: inherited effort unavailable; using the selected model's catalog default"
                );
            }
            return;
        }
        // Some models are a different model id at each effort, so swap in the id this effort asks for.
        // Do this before the log, or the log records an id we are not sending.
        if let Some(routed) = self.model_for_effort(&model_key, effort) {
            sampling.model = routed;
        }
        // Same fields at every target; only the level differs
        // tracing bakes the level into a static callsite, so match a const level per arm
        macro_rules! log_applied {
            ($level:expr) => {
                tracing::event!(
                    $level,
                    session_id = %session_id.0,
                    model = %sampling.model,
                    effort = %effort,
                    target = %target.as_str(),
                    "reasoning_effort: applied effort"
                )
            };
        }
        match target {
            EffortTarget::NewSession | EffortTarget::ModelSwitch => {
                log_applied!(tracing::Level::INFO)
            }
            EffortTarget::SummaryClient => log_applied!(tracing::Level::DEBUG),
        }
        sampling.reasoning_effort = Some(effort);
    }
}

#[cfg(test)]
mod model_settings_tests {
    use super::*;
    #[test]
    fn model_settings_recovery_revalidates_inherited_effort_against_target_route() {
        let manager = ModelsManager::default();
        let mut entry = crate::agent::config::resolve_model_list(&Default::default(), None)
            .into_values()
            .next()
            .unwrap();
        entry.info.model = "shared-slug".into();
        entry.info.base_url = "https://catalog-fixture.invalid/codex/v1".into();
        entry.info.supports_reasoning_effort = true;
        entry.info.reasoning_effort = Some(ReasoningEffort::High);
        entry.info.reasoning_efforts =
            serde_json::from_value(serde_json::json!(["low", "high"])).unwrap();
        manager.insert_test_entry("codex/shared-slug", entry.clone());
        let mut config = crate::agent::config::sampling_config_for_model(
            &entry,
            crate::agent::config::resolve_credentials(&entry, None),
            None,
            None,
            None,
            None,
        );
        manager.apply_supported_effort(
            &mut config,
            Some(ReasoningEffort::Xhigh),
            &acp::SessionId::new("restore"),
            EffortTarget::ModelSwitch,
        );
        assert_eq!(
            config.reasoning_effort,
            Some(ReasoningEffort::High),
            "obsolete persisted effort uses the actual target default"
        );
        manager.apply_supported_effort(
            &mut config,
            Some(ReasoningEffort::Low),
            &acp::SessionId::new("restore"),
            EffortTarget::NewSession,
        );
        assert_eq!(config.reasoning_effort, Some(ReasoningEffort::Low));
        entry.info.base_url = "https://catalog-fixture.invalid/cursor/v1".into();
        entry.info.supports_reasoning_effort = false;
        entry.info.reasoning_effort = None;
        entry.info.reasoning_efforts.clear();
        manager.insert_test_entry("cursor/shared-slug", entry.clone());
        let mut cursor = crate::agent::config::sampling_config_for_model(
            &entry,
            crate::agent::config::resolve_credentials(&entry, None),
            None,
            None,
            None,
            None,
        );
        manager.apply_supported_effort(
            &mut cursor,
            Some(ReasoningEffort::Low),
            &acp::SessionId::new("restore"),
            EffortTarget::ModelSwitch,
        );
        assert!(
            cursor.reasoning_effort.is_none(),
            "same slug on another provider must not borrow Codex capabilities"
        );
    }
}

/// At most one variant carries the hint, so the spawn and switch consumers can never both fire.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NewSessionEffort {
    /// Seed the spawned session's sampling config (default-model path).
    Spawn(ReasoningEffort),
    /// Apply after spawn through the model switch (explicit `modelId` path).
    Switch(ReasoningEffort),
    None,
}

/// Precedence: an explicit `_meta.reasoningEffort` wins over the process-wide last-used or `[models].default_reasoning_effort` value.
/// The catalog default is the last resort and is left on the sampling config when this returns `None`.
pub(crate) fn resolve_new_session_effort_hint(
    meta_hint: Option<ReasoningEffort>,
    current: Option<ReasoningEffort>,
) -> Option<ReasoningEffort> {
    meta_hint.or(current)
}

pub(crate) fn split_new_session_effort(
    resolved_custom_model: Option<&str>,
    hint: Option<ReasoningEffort>,
) -> NewSessionEffort {
    match hint {
        None => NewSessionEffort::None,
        Some(effort) if resolved_custom_model.is_some() => NewSessionEffort::Switch(effort),
        Some(effort) => NewSessionEffort::Spawn(effort),
    }
}
