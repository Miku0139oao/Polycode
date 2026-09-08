//! `/fast` is handled by the session without an inference turn.
use crate::slash::command::{CommandExecCtx, CommandResult, SlashCommand, slash_meta};

pub struct FastCommand;

impl SlashCommand for FastCommand {
    slash_meta! {
        name: "fast",
        description: "Control priority processing where supported (may cost more)",
        usage: "/fast [on|off|status]",
        takes_args: true,
        session_scoped: true,
        arg_placeholder: "on|off|status",
    }

    fn run(&self, _ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        match args.trim() {
            "" | "status" => CommandResult::PassThrough("/fast status".into()),
            "on" | "off" => CommandResult::PassThrough(format!("/fast {}", args.trim())),
            _ => CommandResult::Error("Usage: /fast [on|off|status]".into()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_and_routes_without_inference() {
        let models = crate::acp::model_state::ModelState::default();
        let mut ctx = crate::slash::commands::tests::make_ctx(&models);
        for arg in ["", "status", "on", "off"] {
            assert!(matches!(
                FastCommand.run(&mut ctx, arg),
                CommandResult::PassThrough(_)
            ));
        }
        assert!(matches!(
            FastCommand.run(&mut ctx, "maybe"),
            CommandResult::Error(_)
        ));
    }
}
