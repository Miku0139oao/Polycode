//! Conservative migration of the pre-Polycode built-in prompt identity.
//! Only a complete rendered built-in prefix, backed by its saved context, is recognized.
use super::context::{PromptAudience, PromptContext, TemplateOverride};
use super::template::{apply_patch_template, base_template, subagent_template};
use crate::config::PromptMode;
use xai_grok_tools::types::template_renderer::TemplateRenderer;
use zeroize::Zeroizing;

const IDENTITY_GUIDANCE: &str = "Polycode is your agent identity, independent of the selected model. Describe the underlying model and its creator only using authoritative model/provider metadata; a hosting service is not necessarily the model's creator.";

/// Reconstruct the 18d/9dc built-in template, before rendering any user-controlled text.
/// An unrecognized template revision fails closed instead of guessing at arbitrary saved prose.
fn legacy_builtin_template(ctx: &PromptContext) -> Option<Zeroizing<String>> {
    let (template, current_intro, legacy_intro) = match &ctx.system_prompt {
        TemplateOverride::None if ctx.audience == PromptAudience::Primary => (
            base_template(),
            "You are Polycode, a provider-neutral software engineering agent.",
            "You are ${{ system_prompt_label }} released by xAI.",
        ),
        TemplateOverride::None => (
            subagent_template(),
            "You are a Polycode subagent — a focused worker delegated a specific task.",
            "You are a Grok Build subagent — a focused worker delegated a specific task.",
        ),
        TemplateOverride::Codex => (
            apply_patch_template(),
            "You are Polycode, a terminal-based coding assistant running in the Polycode CLI.",
            "You are a coding agent running in the Grok Build CLI, a terminal-based coding assistant.",
        ),
        TemplateOverride::Custom(_) => return None,
    };
    let rest = template
        .strip_prefix(current_intro)?
        .strip_prefix(' ')?
        .strip_prefix(IDENTITY_GUIDANCE)?;
    let legacy = format!("{legacy_intro}{rest}");
    Some(Zeroizing::new(legacy.replacen(
        "Documentation about the Polycode TUI",
        "Documentation about the Grok Build TUI",
        1,
    )))
}

impl PromptContext {
    /// Upgrade a recognized historical built-in prompt while preserving custom bodies and suffixes.
    /// The caller must supply the saved context, not a freshly built replacement context.
    /// Full/custom prompts, missing provenance, and changed tool renderings are left untouched.
    pub fn migrate_legacy_builtin_identity_with_renderer(
        &self,
        saved_prompt: &str,
        renderer: &TemplateRenderer,
    ) -> Option<String> {
        if self.version != 1 || self.prompt_mode != PromptMode::Extend {
            return None;
        }
        let legacy_template = legacy_builtin_template(self)?;
        let mut legacy_context = self.clone();
        legacy_context.system_prompt = TemplateOverride::Custom(legacy_template.to_string());
        // Contexts predating the label field deserialize to Polycode now; their old default was Grok.
        for label in [self.system_prompt_label.as_str(), "Grok"] {
            legacy_context.system_prompt_label = label.to_string();
            let legacy_prompt = legacy_context.render_with_renderer(renderer)?;
            if let Some(suffix) = saved_prompt.strip_prefix(&legacy_prompt) {
                if !suffix.is_empty() && !suffix.starts_with('\n') {
                    continue;
                }
                // Replace only the built-in base. Even a custom body's rendered legacy
                // label must survive byte-for-byte when the saved label field was absent.
                let mut base_context = legacy_context.clone();
                base_context.prompt_body = None;
                let legacy_base = base_context.render_with_renderer(renderer)?;
                let preserved_tail = saved_prompt.strip_prefix(&legacy_base)?;
                base_context.system_prompt = self.system_prompt.clone();
                let mut migrated = base_context.render_with_renderer(renderer)?;
                migrated.push_str(preserved_tail);
                return Some(migrated);
            }
        }
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;
    use xai_grok_tools::types::tool::ToolKind;

    fn renderer() -> TemplateRenderer {
        TemplateRenderer::new(
            [
                (ToolKind::Read, "Read".into()),
                (ToolKind::Edit, "Edit".into()),
                (ToolKind::Execute, "Bash".into()),
                (ToolKind::Search, "Grep".into()),
                (ToolKind::List, "Glob".into()),
                (ToolKind::Task, "spawn_subagent".into()),
            ]
            .into(),
            HashMap::new(),
        )
    }

    fn legacy_prompt(ctx: &PromptContext, renderer: &TemplateRenderer) -> String {
        let mut legacy = ctx.clone();
        legacy.system_prompt =
            TemplateOverride::Custom(legacy_builtin_template(ctx).unwrap().to_string());
        legacy.render_with_renderer(renderer).unwrap()
    }

    fn assert_polycode_identity(prompt: &str, opening: &str) {
        assert!(prompt.starts_with(opening), "unexpected opening: {prompt}");
        assert!(prompt.contains(IDENTITY_GUIDANCE));
        for stale in [
            "released by xAI",
            "Grok Build",
            "You are Grok",
            "You are Cursor",
            "You are ChatGPT",
        ] {
            assert!(!prompt.contains(stale), "stale identity: {stale}");
        }
        assert!(!prompt.contains("${{"));
        assert!(!prompt.contains("${%"));
    }

    #[test]
    fn polycode_legacy_recognizer_matches_the_verified_9dc_template_bytes() {
        use sha2::{Digest, Sha256};
        // SHA256 of the actual 9dc748d Git blobs, not snapshots generated from this matcher.
        for (audience, template, expected) in [
            (
                PromptAudience::Primary,
                TemplateOverride::None,
                "40a129c27382f83b5a292eb649ab7d8c56be1b07e952279cac505997a69a626f",
            ),
            (
                PromptAudience::Subagent,
                TemplateOverride::None,
                "b1b6617c5dcabc0147355045d35ecb54ae4944f48550135e694cfa6590083597",
            ),
            (
                PromptAudience::Primary,
                TemplateOverride::Codex,
                "1645baba058e100a91f253e8c30b43b3698740d16822f32fb599f2ed5b2780bb",
            ),
        ] {
            let ctx = PromptContext {
                audience,
                system_prompt: template,
                ..Default::default()
            };
            let legacy = legacy_builtin_template(&ctx).unwrap();
            assert_eq!(format!("{:x}", Sha256::digest(legacy.as_bytes())), expected);
        }
    }

    #[test]
    fn polycode_builtin_identity_is_independent_of_model_labels_and_interactivity() {
        let renderer = renderer();
        let mut ctx = PromptContext::default();
        // Includes catalog, subscription, hosting-service, and explicit legacy labels.
        for label in [
            "Grok",
            "Grok 4.6",
            "Grok 4.5",
            "ChatGPT",
            "Cursor",
            "claude-sonnet",
            "Custom label",
        ] {
            ctx.system_prompt_label = label.into();
            for non_interactive in [false, true] {
                ctx.is_non_interactive = non_interactive;
                let prompt = ctx.render_with_renderer(&renderer).unwrap();
                assert_polycode_identity(
                    &prompt,
                    "You are Polycode, a provider-neutral software engineering agent.",
                );
                assert!(prompt.contains("<work_policy>"));
                assert!(prompt.contains("`spawn_subagent`"));
                assert!(prompt.contains("`Read`"));
                assert!(prompt.contains("`Edit`"));
                assert_eq!(
                    prompt.contains("There is no human operator"),
                    non_interactive
                );
                assert_eq!(prompt.contains("<user_guide>"), !non_interactive);
            }
        }
    }

    #[test]
    fn polycode_child_and_apply_patch_profiles_keep_neutral_identity() {
        let renderer = renderer();
        for audience in [PromptAudience::Primary, PromptAudience::Subagent] {
            for template in [TemplateOverride::None, TemplateOverride::Codex] {
                let ctx = PromptContext {
                    audience,
                    system_prompt: template.clone(),
                    system_prompt_label: "Cursor-hosted unrelated model".into(),
                    ..Default::default()
                };
                let opening = match (audience, template) {
                    (_, TemplateOverride::Codex) => {
                        "You are Polycode, a terminal-based coding assistant running in the Polycode CLI."
                    }
                    (PromptAudience::Subagent, _) => {
                        "You are a Polycode subagent — a focused worker delegated a specific task."
                    }
                    _ => "You are Polycode, a provider-neutral software engineering agent.",
                };
                assert_polycode_identity(&ctx.render_with_renderer(&renderer).unwrap(), opening);
            }
        }
    }

    #[test]
    fn polycode_full_builtin_child_profiles_preserve_identity_and_dynamic_context() {
        use crate::prompt::subagent_prompts::{
            EXPLORE_PROMPT, GENERAL_PURPOSE_PROMPT, PLAN_PROMPT,
        };
        let renderer = renderer();
        for body in [GENERAL_PURPOSE_PROMPT, EXPLORE_PROMPT, PLAN_PROMPT] {
            let ctx = PromptContext {
                audience: PromptAudience::Subagent,
                prompt_body: Some(body.into()),
                os_name: Some("linux".into()),
                shell_path: Some("/bin/bash".into()),
                working_directory: Some("/workspace/identity-test".into()),
                current_date: Some("2026-06-15".into()),
                role_instructions: Some("Keep the assigned role".into()),
                persona_instructions: Some("Keep the custom persona".into()),
                ..Default::default()
            };
            let prompt = ctx.render_with_renderer(&renderer).unwrap();
            assert_polycode_identity(
                &prompt,
                "You are a Polycode subagent — a focused worker delegated a specific task.",
            );
            for preserved in [
                "<work_policy>",
                "<tool_calling>",
                "OS: linux",
                "Shell: /bin/bash",
                "Workspace Path: /workspace/identity-test",
                "Current Date: 2026-06-15",
                "Keep the assigned role",
                "Keep the custom persona",
            ] {
                assert!(
                    prompt.contains(preserved),
                    "missing dynamic context or policy: {preserved}"
                );
            }
            let rendered_body = renderer
                .render_with_extra(body, &ctx.placeholders())
                .unwrap();
            assert!(prompt.ends_with(&format!("\n\n{rendered_body}")));
        }
    }

    #[test]
    fn polycode_identity_preserves_explicit_custom_prompt_semantics() {
        let renderer = renderer();
        let body = "You are Grok released by xAI. Custom ${{ system_prompt_label }} uses ${{ tools.by_kind.read }}.";
        let expected = "You are Grok released by xAI. Custom user label uses Read.";
        for mode in [PromptMode::Full, PromptMode::Extend] {
            let ctx = PromptContext {
                prompt_mode: mode.clone(),
                prompt_body: Some(body.into()),
                system_prompt_label: "user label".into(),
                ..Default::default()
            };
            let prompt = ctx.render_with_renderer(&renderer).unwrap();
            if mode == PromptMode::Full {
                assert_eq!(prompt, expected);
            } else {
                assert!(prompt.starts_with("You are Polycode,"));
                assert!(prompt.ends_with(&format!("\n\n{expected}")));
            }
            let custom = PromptContext {
                system_prompt: TemplateOverride::Custom(body.into()),
                prompt_body: None,
                prompt_mode: PromptMode::Extend,
                ..ctx
            };
            assert_eq!(custom.render_with_renderer(&renderer).unwrap(), expected);
        }
    }

    #[test]
    fn polycode_identity_migrates_exact_saved_builtin_contexts_without_rewriting_extensions() {
        let renderer = renderer();
        for audience in [PromptAudience::Primary, PromptAudience::Subagent] {
            for template in [TemplateOverride::None, TemplateOverride::Codex] {
                for non_interactive in [false, true] {
                    let ctx = PromptContext {
                        audience,
                        system_prompt: template.clone(),
                        system_prompt_label: "Grok 4.6".into(),
                        is_non_interactive: non_interactive,
                        prompt_body: Some("Keep custom text: You are Grok released by xAI. ${{ tools.by_kind.read }}".into()),
                        working_directory: Some("/workspace/saved".into()),
                        role_instructions: Some("Retain saved role".into()),
                        ..Default::default()
                    };
                    let json = serde_json::to_string(&ctx).unwrap();
                    let loaded: PromptContext = serde_json::from_str(&json).unwrap();
                    let suffix = "\n\n<human_rules>\nGrok Build and xAI are literal project text.\n</human_rules>";
                    let saved = format!("{}{suffix}", legacy_prompt(&loaded, &renderer));
                    let migrated = loaded
                        .migrate_legacy_builtin_identity_with_renderer(&saved, &renderer)
                        .unwrap();
                    assert_eq!(
                        migrated,
                        format!(
                            "{}{suffix}",
                            loaded.render_with_renderer(&renderer).unwrap()
                        )
                    );
                    assert!(
                        migrated.contains("Keep custom text: You are Grok released by xAI. Read")
                    );
                    assert_eq!(serde_json::to_string(&loaded).unwrap(), json);
                    assert!(
                        loaded
                            .migrate_legacy_builtin_identity_with_renderer(&migrated, &renderer)
                            .is_none(),
                        "migration must be idempotent"
                    );
                }
            }
        }
    }

    #[test]
    fn polycode_identity_migrates_missing_legacy_label_without_changing_saved_fields() {
        let renderer = renderer();
        let mut value = serde_json::to_value(PromptContext::default()).unwrap();
        value.as_object_mut().unwrap().remove("system_prompt_label");
        let loaded: PromptContext = serde_json::from_value(value).unwrap();
        assert_eq!(loaded.system_prompt_label, "Polycode");
        let old = PromptContext {
            system_prompt_label: "Grok".into(),
            ..loaded.clone()
        };
        let saved = legacy_prompt(&old, &renderer);
        assert_eq!(
            loaded
                .migrate_legacy_builtin_identity_with_renderer(&saved, &renderer)
                .unwrap(),
            loaded.render_with_renderer(&renderer).unwrap()
        );
    }

    #[test]
    fn polycode_migration_preserves_rendered_custom_body_when_legacy_label_was_absent() {
        let renderer = renderer();
        let loaded = PromptContext {
            prompt_body: Some(
                "Custom label was ${{ system_prompt_label }}; use ${{ tools.by_kind.read }}."
                    .into(),
            ),
            ..Default::default()
        };
        let old = PromptContext {
            system_prompt_label: "Grok".into(),
            ..loaded.clone()
        };
        let saved = legacy_prompt(&old, &renderer);
        let migrated = loaded
            .migrate_legacy_builtin_identity_with_renderer(&saved, &renderer)
            .unwrap();
        assert!(migrated.starts_with("You are Polycode,"));
        assert!(migrated.ends_with("\n\nCustom label was Grok; use Read."));
    }

    #[test]
    fn polycode_identity_migration_leaves_custom_and_unrecognized_text_untouched() {
        let renderer = renderer();
        let ctx = PromptContext {
            system_prompt_label: "Grok".into(),
            ..Default::default()
        };
        let saved = legacy_prompt(&ctx, &renderer);
        for altered in [
            "You are Grok released by xAI. User-authored prompt.".to_string(),
            format!("A quoted prompt:\n{saved}"),
            saved.replacen("<work_policy>", "<custom_work_policy>", 1),
            saved.replacen("`Read`", "`DifferentRead`", 1),
            format!("{saved}unrecognized inline suffix"),
        ] {
            assert!(
                ctx.migrate_legacy_builtin_identity_with_renderer(&altered, &renderer)
                    .is_none()
            );
        }
        for custom in [
            PromptContext {
                prompt_mode: PromptMode::Full,
                prompt_body: Some(saved.clone()),
                ..ctx.clone()
            },
            PromptContext {
                system_prompt: TemplateOverride::Custom(saved.clone()),
                ..ctx.clone()
            },
            PromptContext {
                version: 2,
                ..ctx.clone()
            },
        ] {
            assert!(
                custom
                    .migrate_legacy_builtin_identity_with_renderer(&saved, &renderer)
                    .is_none()
            );
        }
    }
}
