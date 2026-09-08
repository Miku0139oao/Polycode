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
        if !id.starts_with("codex/") {
            return "Fast mode unsupported for this provider. Select an advertised Cursor fast model with /model; there is no generic Cursor fast flag.".into();
        }
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
            return "Fast mode unsupported by the current account/model catalog. No request settings changed; any existing priority request will be rejected rather than silently downgraded.".into();
        }
        if args == "on" {
            config.extra_headers.insert(FAST_HEADER.into(), "on".into());
            self.chat_state_handle.update_sampling_config(config);
            return "Fast mode on for this session model: requests use priority processing (service_tier=priority), which may cost more. Provider availability applies; model switches reset this setting.".into();
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
        format!(
            "Fast mode {state}. This account/model advertises priority processing. /fast on may cost more; /fast off removes the priority request."
        )
    }
}
