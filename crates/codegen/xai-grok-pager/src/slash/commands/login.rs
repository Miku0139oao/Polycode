use crate::app::actions::Action;
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

pub struct LoginCommand;

impl SlashCommand for LoginCommand {
    slash_meta! {
        name: "login",
        description: "Log in or re-authenticate with your account",
        usage: "/login [grok|codex|cursor]",
        takes_args: true,
        args_required: false,
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        if args.trim().is_empty() { return CommandResult::Action(Action::Login); }
        if !xai_grok_shell::polycode::enabled() {
            return CommandResult::Error("Provider login requires --polycode-native".into());
        }
        match args.trim() {
            "grok" | "native" => CommandResult::Action(Action::Provider(crate::app::provider::Command::Choose { provider: crate::app::provider::Choice::Grok, login: true })),
            "codex" | "cursor" => CommandResult::Action(Action::Provider(crate::app::provider::answer(args.trim(), true))),
            _ => CommandResult::Error("Usage: /login [grok|codex|cursor]".into()),
        }
    }
}
