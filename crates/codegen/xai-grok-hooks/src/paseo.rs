//! Paseo product hooks are Claude/Cursor integration snippets that Paseo
//! installs into `~/.claude/settings.json`. They gate on `PASEO_*` and invoke
//! `paseo hooks <vendor> <event>`.
//!
//! Native Polycode/Grok is not a Paseo host. Loading those commands made
//! `UserPromptSubmit` fail on Windows with `required env var not set
//! ${PASEO_TERMINAL_ID}` because the runner treated a `[ -n "$VAR" ]` presence
//! test as a required expansion. Drop them unless this process is Paseo-hosted.

use crate::config::HookSpec;

/// A Paseo-hosted agent sets at least one of these. Native Polycode/Grok does not.
pub(crate) fn paseo_host_session() -> bool {
    const VARS: &[&str] = &[
        "PASEO_CLI",
        "PASEO_AGENT_ID",
        "PASEO_AGENT_CWD",
        "PASEO_HOST",
        "PASEO_WORKSPACE",
        "PASEO_SESSION",
        "PASEO_TERMINAL_ID",
        "PASEO_HOOK_CLI",
    ];
    VARS.iter()
        .any(|key| std::env::var_os(key).is_some_and(|value| !value.is_empty()))
}

pub(crate) fn is_paseo_product_hook(spec: &HookSpec) -> bool {
    command_is_paseo_product(spec.command_raw.as_deref().unwrap_or(""))
        || command_is_paseo_product(spec.url_raw.as_deref().unwrap_or(""))
}

pub(crate) fn should_skip_paseo_hook(spec: &HookSpec) -> bool {
    !paseo_host_session() && is_paseo_product_hook(spec)
}

pub(crate) fn command_is_paseo_product(cmd: &str) -> bool {
    if cmd.is_empty() {
        return false;
    }
    for r in crate::env_expand::iter_env_var_references(cmd) {
        if r.name.starts_with("PASEO_") {
            return true;
        }
    }
    invokes_paseo_hooks_cli(cmd)
}

/// True for `paseo hooks …` / `paseo.exe hooks …`, including quoted forms.
fn invokes_paseo_hooks_cli(cmd: &str) -> bool {
    let lower = cmd.to_ascii_lowercase();
    let bytes = lower.as_bytes();
    let mut i = 0;
    while i + 5 <= bytes.len() {
        if !bytes[i..].starts_with(b"paseo") {
            i += 1;
            continue;
        }
        let before_ok = i == 0 || !bytes[i - 1].is_ascii_alphanumeric();
        let mut j = i + 5;
        if bytes.get(j..).is_some_and(|s| s.starts_with(b".exe")) {
            j += 4;
        }
        while j < bytes.len()
            && (bytes[j].is_ascii_whitespace() || bytes[j] == b'"' || bytes[j] == b'\'')
        {
            j += 1;
        }
        if before_ok && bytes[j..].starts_with(b"hooks") {
            let after = j + 5;
            if after == bytes.len() || !bytes[after].is_ascii_alphanumeric() {
                return true;
            }
        }
        i += 1;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    const PASEO_CLAUDE_PROMPT: &str = r#"if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks claude UserPromptSubmit; fi"#;

    #[test]
    fn detects_claude_settings_paseo_hooks() {
        assert!(command_is_paseo_product(PASEO_CLAUDE_PROMPT));
        assert!(command_is_paseo_product(
            r#"if [ -n "$PASEO_TERMINAL_ID" ]; then "${PASEO_HOOK_CLI:-paseo}" hooks claude Stop; fi"#
        ));
        assert!(command_is_paseo_product(
            "paseo hooks claude UserPromptSubmit"
        ));
        assert!(command_is_paseo_product("paseo.exe hooks cursor Stop"));
        assert!(command_is_paseo_product(
            r#""paseo" hooks claude Notification"#
        ));
    }

    #[test]
    fn does_not_flag_unrelated_commands() {
        assert!(!command_is_paseo_product("echo native"));
        assert!(!command_is_paseo_product("echo not-paseo-related"));
        assert!(!command_is_paseo_product("pase"));
        assert!(!command_is_paseo_product("mypaseo hooks"));
        assert!(!command_is_paseo_product(""));
    }
}
