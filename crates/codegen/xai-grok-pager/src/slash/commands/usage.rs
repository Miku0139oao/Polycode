//! `/usage` shows reported session tokens/costs for the active registered provider.
//! Only native Grok consumer accounts can open native xAI billing here.
//!
//! External-auth deployments (`auth_provider_command`) never reach grok.com billing.
//! [`AppCtx::usage_command_visible`] hides and refuses the command there.

use crate::app::actions::Action;
use crate::slash::command::{
    AppCtx, ArgItem, CommandExecCtx, CommandResult, SlashCommand, slash_meta,
};
use crate::views::usage_modal::UsageProvider;
use agent_client_protocol as acp;

pub struct UsageCommand;

#[cfg(test)]
mod provider_usage_tests {
    use super::*;

    #[test]
    fn subscription_page_is_local_and_manage_never_opens_native_billing() {
        for arg in ["", "show"] {
            assert!(matches!(
                non_native_usage(arg),
                CommandResult::Action(Action::ShowUsage)
            ));
        }
        let CommandResult::Error(message) = non_native_usage("manage") else {
            panic!("subscription manage must not dispatch billing or a URL");
        };
        assert!(message.contains("Native xAI billing is separate"));
        assert!(message.contains("unavailable from a supported provider API"));
        assert!(matches!(
            non_native_usage("delete"),
            CommandResult::Error(_)
        ));
    }
}

fn non_native_usage(arg: &str) -> CommandResult {
    match arg {
        "" | "show" => CommandResult::Action(Action::ShowUsage),
        "manage" => CommandResult::Error(
            "Native xAI billing is separate. Provider quota and remaining balance are unavailable from a supported provider API.".into(),
        ),
        _ => CommandResult::Error(format!("Unknown argument: {arg}. Use /usage")),
    }
}

/// Detect external-auth installs once at pager startup.
pub(crate) fn detect_external_auth_provider(auth_methods: &[acp::AuthMethod]) -> bool {
    auth_methods.iter().any(auth_method_is_external_provider)
        || auth_provider_env_set()
        || auth_provider_config_set()
}

fn auth_method_is_external_provider(method: &acp::AuthMethod) -> bool {
    method
        .meta()
        .as_ref()
        .and_then(|v| v.get("external_provider"))
        .and_then(|v| v.as_bool())
        .unwrap_or(false)
}

fn auth_provider_env_set() -> bool {
    std::env::var("GROK_AUTH_PROVIDER_COMMAND")
        .ok()
        .is_some_and(|s| !s.trim().is_empty())
}

fn auth_provider_config_set() -> bool {
    let Ok(raw) = xai_grok_shell::config::load_effective_config() else {
        return false;
    };
    let Ok(cfg) = xai_grok_shell::agent::config::Config::new_from_toml_cfg(&raw) else {
        return false;
    };
    cfg.grok_com_config
        .auth_provider_command
        .as_deref()
        .is_some_and(|s| !s.trim().is_empty())
}

impl SlashCommand for UsageCommand {
    slash_meta! {
        name: "usage",
        aliases: ["cost"],
        description: "View usage",
        usage: "/usage [show|manage]",
        takes_args: true,
    }

    fn visible(&self, ctx: &AppCtx) -> bool {
        ctx.usage_command_visible
            || matches!(
                UsageProvider::for_models(ctx.models),
                UsageProvider::Subscription(_)
            )
    }

    fn takes_args_now(&self, ctx: &AppCtx) -> bool {
        // Non-consumer accounts get bare `/usage` only; Enter should send, not chain for args
        ctx.usage_command_visible
            && ctx.billing_surface_visible
            && UsageProvider::for_models(ctx.models).permits_native_billing()
    }

    fn suggest_args(&self, ctx: &AppCtx, _args_query: &str) -> Option<Vec<ArgItem>> {
        if !ctx.usage_command_visible
            || !ctx.billing_surface_visible
            || !UsageProvider::for_models(ctx.models).permits_native_billing()
        {
            return None;
        }
        Some(vec![
            ArgItem {
                display: "show".into(),
                match_text: "show".into(),
                insert_text: "show".into(),
                description: "View usage".into(),
            },
            ArgItem {
                display: "manage".into(),
                match_text: "manage".into(),
                insert_text: "manage".into(),
                description: "Manage native xAI billing".into(),
            },
        ])
    }

    fn run(&self, ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        let provider = UsageProvider::for_models(ctx.models);
        if !ctx.usage_command_visible && !matches!(provider, UsageProvider::Subscription(_)) {
            return CommandResult::Error("/usage is not available.".into());
        }
        let arg = args.trim();
        if !provider.permits_native_billing() {
            return non_native_usage(arg);
        }
        if !ctx.billing_surface_visible {
            return match arg {
                "" => CommandResult::Action(Action::ShowUsage),
                _ => CommandResult::Error(format!("Unknown argument: {arg}. Use /usage")),
            };
        }
        match arg {
            "" | "show" => CommandResult::Action(Action::ShowUsage),
            "manage" => CommandResult::Action(Action::ManageBilling),
            _ => CommandResult::Error(format!(
                "Unknown argument: {arg}. Use /usage show or /usage manage"
            )),
        }
    }
}
