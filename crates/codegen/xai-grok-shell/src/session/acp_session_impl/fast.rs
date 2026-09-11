use super::*;

#[cfg(test)]
mod tests {
    use crate::session::slash_commands::{
        BUILTIN_COMMANDS, BuiltinAction, ModelAuthoredEligibility,
    };

    #[test]
    fn fast_is_a_human_only_builtin_with_explicit_arguments() {
        let command = BUILTIN_COMMANDS
            .iter()
            .find(|command| command.name == "fast")
            .unwrap();
        assert_eq!(
            command.model_authored_eligibility,
            ModelAuthoredEligibility::Denied
        );
        for args in ["", "status", "on", "off", "invalid"] {
            assert!(
                matches!((command.resolve)(args), BuiltinAction::Fast { args: value } if value == args)
            );
        }
    }

    #[test]
    fn fast_mechanism_follows_the_subscription_provider_prefix() {
        use super::FastMechanism;
        assert_eq!(
            FastMechanism::for_model_id("codex/gpt-5.3-codex"),
            Some(FastMechanism::CodexPriorityTier)
        );
        assert_eq!(
            FastMechanism::for_model_id("cursor/gpt-5.3-codex"),
            Some(FastMechanism::CursorFastVariant)
        );
        assert_eq!(FastMechanism::for_model_id("grok/grok-4"), None);
        assert_eq!(FastMechanism::for_model_id("no-prefix"), None);
        assert!(
            FastMechanism::CursorFastVariant
                .enabled_message()
                .contains("Cursor fast variant")
        );
        assert!(
            FastMechanism::CursorFastVariant
                .unsupported_message()
                .contains("no fast variant")
        );
        assert!(
            FastMechanism::CodexPriorityTier
                .enabled_message()
                .contains("service_tier=priority")
        );
    }
}

// This private bridge header is translated to the Codex Responses body, not forwarded upstream.
const FAST_HEADER: &str = "x-polycode-fast";

impl SessionActor {
    pub(super) async fn execute_fast_command(&self, args: &str) -> String {
        let args = args.trim();
        if !matches!(args, "" | "status" | "on" | "off") {
            return "Usage: /fast [on|off|status]".into();
        }
        let Some(mut config) = self.chat_state_handle.get_sampling_config().await else {
            return "Fast mode unavailable: no active model.".into();
        };
        if args == "off" {
            config.extra_headers.shift_remove(FAST_HEADER);
            self.chat_state_handle.update_sampling_config(config);
            return "Fast mode off: no priority tier will be requested. Model switches reset this setting.".into();
        }
        let Some(id) = crate::polycode::canonical_model_id(&config.base_url, &config.model) else {
            return "Fast mode unsupported for this provider. No request settings changed.".into();
        };
        let Some(mechanism) = FastMechanism::for_model_id(&id) else {
            return "Fast mode unsupported for this provider. No request settings changed.".into();
        };
        let Some(bridge) = crate::polycode::bridge() else {
            return "Fast mode unavailable: native provider bridge is not connected.".into();
        };
        let supported = match bridge.fast_supported(&id).await {
            Ok(value) => value,
            Err(message) => {
                return format!(
                    "Cannot verify fast capability: {message}. No request settings changed."
                );
            }
        };
        if !supported {
            return mechanism.unsupported_message().into();
        }
        if args == "on" {
            config.extra_headers.insert(FAST_HEADER.into(), "on".into());
            self.chat_state_handle.update_sampling_config(config);
            return mechanism.enabled_message().into();
        }
        let state = if config
            .extra_headers
            .get(FAST_HEADER)
            .is_some_and(|value| value == "on")
        {
            "on"
        } else {
            "off"
        };
        format!("Fast mode {state}. {}", mechanism.status_message())
    }
}

/// How the bridge realises fast mode for a subscription provider. The header is
/// the same; only the translation and the user-facing explanation differ.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FastMechanism {
    /// Codex Responses accept `service_tier=priority` on the same model.
    CodexPriorityTier,
    /// Cursor publishes `-fast` catalog variants; the bridge swaps the model ID.
    CursorFastVariant,
}

impl FastMechanism {
    fn for_model_id(id: &str) -> Option<Self> {
        match id.split_once('/')?.0 {
            "codex" => Some(Self::CodexPriorityTier),
            "cursor" => Some(Self::CursorFastVariant),
            _ => None,
        }
    }

    fn unsupported_message(self) -> &'static str {
        match self {
            Self::CodexPriorityTier => {
                "Fast mode unsupported by the current account/model catalog. No request settings changed; any existing priority request will be rejected rather than silently downgraded."
            }
            Self::CursorFastVariant => {
                "Fast mode unsupported: your Cursor catalog has no fast variant for this model family. No request settings changed; a pending fast request is rejected rather than silently downgraded."
            }
        }
    }

    fn enabled_message(self) -> &'static str {
        match self {
            Self::CodexPriorityTier => {
                "Fast mode on for this session model: requests use priority processing (service_tier=priority), which may cost more. Provider availability applies; model switches reset this setting."
            }
            Self::CursorFastVariant => {
                "Fast mode on for this session model: requests use the model's Cursor fast variant at the current reasoning effort, which may cost more. Efforts without a fast variant are rejected; model switches reset this setting."
            }
        }
    }

    fn status_message(self) -> &'static str {
        match self {
            Self::CodexPriorityTier => {
                "This account/model advertises priority processing. /fast on may cost more; /fast off removes the priority request."
            }
            Self::CursorFastVariant => {
                "This Cursor model family advertises fast variants. /fast on switches requests to the fast variant and may cost more; /fast off returns to the standard variant."
            }
        }
    }
}
