use crate::app::{actions::Action, provider::Command};
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

pub struct ProviderCommand;
impl SlashCommand for ProviderCommand {
    slash_meta! {
        name: "provider",
        description: "Choose a native model provider or sign in to a subscription",
        usage: "/provider [grok|codex|cursor|refresh|cancel]",
        takes_args: true,
        args_required: false,
    }
    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        let command = match args.trim() {
            "" => Command::Menu { login: false },
            "grok" | "codex" | "cursor" | "refresh" | "cancel" => {
                crate::app::provider::answer(args.trim(), false)
            }
            _ => {
                return CommandResult::Error(
                    "Usage: /provider [grok|codex|cursor|refresh|cancel]".into(),
                );
            }
        };
        CommandResult::Action(Action::Provider(command))
    }
}
