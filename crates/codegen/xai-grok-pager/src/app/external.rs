//! Capability isolation for the optional external ACP backend.
//! UI gates are backed by the wire policy in `acp::external`.
use super::{
    actions::{Action, Effect},
    app_view::AppView,
};

pub(crate) const UNSUPPORTED: &str = "Unavailable with external ACP. Use the external agent's controls; native Polycode features are disabled.";

pub(crate) fn effect_allowed(effect: &Effect) -> bool {
    // Deliberately an allowlist: a new native feature must not accidentally access
    // xAI services, Grok session storage or process-owned hooks in external mode.
    matches!(
        effect,
        Effect::Quit
            | Effect::Authenticate { .. }
            | Effect::CreateSession { .. }
            | Effect::LoadSession { .. }
            | Effect::SendPrompt { .. }
            | Effect::SendPromptBlocks { .. }
            | Effect::CancelTurn { .. }
            | Effect::SwitchModel { .. }
            | Effect::ScheduleClearAuthCopyFeedback { .. }
            | Effect::PreparePromptImagePreview { .. }
    )
}

pub(crate) fn action_denied(action: &Action) -> bool {
    matches!(
        action,
        Action::OpenDashboard
            | Action::CancelPendingModelSwitch
            | Action::FetchSessionList
            | Action::ShowSessionPicker
            | Action::ChooseNewSessionMode
            | Action::NewWorktreeSession { .. }
            | Action::NewSessionWithId(_)
            | Action::StartupForkSession { .. }
            | Action::DeleteCurrentSession
            | Action::ShareSession
            | Action::RenameSession { .. }
            | Action::ResetSessionTitleToAuto
            | Action::Logout
            | Action::SwitchAccount
            | Action::SubmitAuthCode(_)
            | Action::EnableVoiceMode
            | Action::VoiceToggle
            | Action::SendBashCommand(_)
            | Action::CycleMode
            | Action::ToggleYolo
            | Action::SetYoloMode(_)
            | Action::SetPermissionMode(_)
            | Action::EnterPlanMode { .. }
            | Action::SetPlanMode(_)
            | Action::OpenSettings
            | Action::OpenSettingsFocus { .. }
            | Action::RelaunchInScreenMode { .. }
            | Action::ResumeForeignSession
            | Action::Interject { .. }
            | Action::SendPromptNow { .. }
            | Action::Rewind
            | Action::RewindShowPicker
            | Action::RewindPickerSelect(_)
            | Action::RewindConfirm(_)
            | Action::RewindConfirmNeverAsk(_)
            | Action::OpenExtensionsModal { .. }
            | Action::OpenConfigAgentsModal(_)
            | Action::ShowSessionInfo
            | Action::ShowReleaseNotes { .. }
            | Action::ShowContextInfo
            | Action::ShowUsage
            | Action::ManageBilling
            | Action::EnterRememberMode
            | Action::SendRememberNote(_)
            | Action::SendBtw(_)
            | Action::OpenFeedbackPane { .. }
            | Action::SendFeedback { .. }
    )
}

pub(crate) fn apply(app: &mut AppView) {
    if !app.external_acp {
        return;
    }
    app.new_session_worktree_mode = super::app_view::WorktreeMode::Never;
    app.default_yolo = false;
    app.current_ui.permission_mode = Some("ask".into());
    app.permission_mode_from_soft_default = false;
    app.plan_mode = false;
    app.subagents = false;
    app.workspace_dashboard_enabled = false;
    app.plugin_cta_enabled = false;
    app.privacy_notice_rollout = false;
    app.sharing_enabled = false;
    app.usage_visible = false;
    app.has_external_auth_provider = true;
    app.cancel_rewind_enabled = false;
    app.session_recap_available = false;
    app.shell_feedback_trace_offer = false;
    app.gate = None;
    app.pending_gate_verification = None;
    app.apply_voice_mode_enabled(false);
    app.welcome_prompt
        .slash_controller
        .registry_mut()
        .set_external(true);
    for agent in app.agents.values_mut() {
        agent
            .prompt
            .slash_controller
            .registry_mut()
            .set_external(true);
        agent.session.prompt_history_loading = false;
        agent.mcp_init_progress = None;
        agent.session.yolo_mode = false;
        agent.session.auto_mode = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn native_network_and_storage_effects_are_denied() {
        assert!(!effect_allowed(&Effect::FetchAppBilling));
        assert!(!effect_allowed(&Effect::FetchChangelog));
        assert!(!effect_allowed(&Effect::RefreshGate));
        assert!(!effect_allowed(&Effect::FetchRoster));
        assert!(!effect_allowed(&Effect::RegisterActiveSession {
            session_id: "foreign".into(),
            cwd: "/tmp".into()
        }));
        assert!(effect_allowed(&Effect::CancelTurn {
            session_id: "foreign".into(),
            cancel_subagents: false,
            trigger: None,
            rewind_prompt_id: None
        }));
    }
    #[test]
    fn dangerous_controls_are_disabled_not_approvals() {
        assert!(action_denied(&Action::ToggleYolo));
        assert!(action_denied(&Action::VoiceToggle));
        assert!(action_denied(&Action::OpenDashboard));
        assert!(!action_denied(&Action::Quit));
    }
}
