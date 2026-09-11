//! `/model` (alias `/m`): switch the model and optionally its reasoning effort.
//! Chained autocomplete: after picking a reasoning-supported model, the trailing space re-opens the dropdown into a `low|medium|high|xhigh` sub-menu.

use agent_client_protocol as acp;
use xai_grok_shell::sampling::types::supports_reasoning_effort_meta;

use crate::acp::model_state::ModelState;
use crate::app::actions::Action;
use crate::slash::command::{
    AppCtx, ArgItem, CommandExecCtx, CommandResult, SlashCommand, slash_meta,
};
use crate::slash::commands::effort_levels::build_effort_arg_items;

/// Switch the active model (and optionally its reasoning effort).
pub struct ModelCommand;

impl SlashCommand for ModelCommand {
    slash_meta! {
        name: "model",
        aliases: ["m"],
        description: "Switch the active model",
        usage: "/model <name> [effort]",
        takes_args: true,
        args_required: true,
        session_scoped: true,
        // The dashboard offers `/model` to pick the model for the next spawned agent (intercepted in `dispatch_dashboard_dispatch_slash`).
        offered_when_session_less: true,
        arg_placeholder: "<model> [effort]",
    }

    fn suggest_args(&self, ctx: &AppCtx, args_query: &str) -> Option<Vec<ArgItem>> {
        if ctx.models.is_empty() {
            return None;
        }

        // Effort phase if input is "<reasoning-model> ", else model phase.
        if let Some((model_id, model_query)) = detect_effort_phase(ctx.models, args_query) {
            let effort_query = args_query[model_query.len()..].trim();
            let mut matcher = crate::slash::matcher::FuzzyMatcher::new();
            let options = ctx.models.reasoning_effort_options_for(&model_id);
            let items = build_effort_items(ctx.models, &model_id)
                .into_iter()
                .zip(options)
                .filter_map(|(mut item, option)| {
                    if !effort_query.is_empty()
                        && matcher.indices_for(effort_query, &option.id).is_none()
                    {
                        return None;
                    }
                    // Match the typed alias, but keep insertion canonical and filter only the effort suffix.
                    let sort_prefix = item.match_text.split_once(' ')?.0;
                    item.match_text = format!("{sort_prefix} {model_query} {}", option.id);
                    Some(item)
                })
                .collect();
            return Some(items);
        }
        Some(build_model_items(ctx.models))
    }

    fn run(&self, ctx: &mut CommandExecCtx, args: &str) -> CommandResult {
        let trimmed = args.trim();
        if trimmed.eq_ignore_ascii_case("cancel") {
            return CommandResult::Action(Action::CancelPendingModelSwitch);
        }
        if trimmed.is_empty() {
            return CommandResult::Error("Usage: /model <name> [effort]".into());
        }

        // Prefer an exact full-string catalog match first. Model display names often contain spaces ("Grok 4.5").
        // If we split on the last token first, a shorter catalog entry ("Grok") would steal the prefix and treat "4.5" as an effort level
        if let Some(id) = ctx.models.resolve_by_name_or_id(trimmed) {
            return CommandResult::Action(Action::SetDefaultModel(id));
        }

        // A trailing effort token on a reasoning model makes a session-scoped switch (not persisted as default)
        // Resolve via the shared gate so a rejected level (e.g. `none` on grok-4.5) reports the effort error with the model's offered ids.
        // Without it the fall-through reports "Unknown model: … none"
        if let Some((prefix, token)) = split_trailing_token(trimmed)
            && let Some(id) = resolve_model(ctx.models, prefix)
        {
            return match ctx.models.resolve_effort_for_model(&id, token) {
                Ok(effort) => CommandResult::Action(Action::SwitchModel {
                    model_id: id,
                    effort: Some(effort),
                }),
                Err(err) => CommandResult::Error(err.message()),
            };
        }

        CommandResult::Error(format!(
            "Unknown or ambiguous model: {trimmed}. Use /model to search, or enter a full provider/model ID."
        ))
    }
}

/// Look up a model by case-insensitive display name OR model id match.
fn resolve_model(models: &ModelState, name: &str) -> Option<acp::ModelId> {
    models.resolve_by_name_or_id(name)
}

fn supports_reasoning_effort(info: &acp::ModelInfo) -> bool {
    supports_reasoning_effort_meta(info.meta.as_ref())
}

/// Split `args` into `(prefix, last_token)` on the final whitespace run.
/// Returns `None` when there is no interior whitespace to split on.
/// The token is resolved to an effort against the picked model's options by the caller.
fn split_trailing_token(args: &str) -> Option<(&str, &str)> {
    let (prefix, last) = args.rsplit_once(char::is_whitespace)?;
    let prefix = prefix.trim_end();
    if prefix.is_empty() || last.is_empty() {
        return None;
    }
    Some((prefix, last))
}

/// Returns the matched model id and typed alias when `args_query` is `"<reasoning-model> ..."`.
/// Candidates are tried longest name first to disambiguate names that share a prefix.
fn detect_effort_phase<'a>(
    models: &ModelState,
    args_query: &'a str,
) -> Option<(acp::ModelId, &'a str)> {
    let mut candidates: Vec<(&acp::ModelId, &str)> = models
        .available
        .iter()
        .filter(|(_, info)| supports_reasoning_effort(info))
        .flat_map(|(id, info)| {
            [
                Some((id, id.0.as_ref())),
                Some((id, info.name.as_str())),
                id.0.split_once('/').map(|(_, name)| (id, name)),
                info.name.split_once(" / ").map(|(_, name)| (id, name)),
            ]
            .into_iter()
            .flatten()
        })
        .collect();
    candidates.sort_by_key(|(_, name)| std::cmp::Reverse(name.len()));

    for (id, name) in candidates {
        if args_query.len() > name.len()
            && args_query.is_char_boundary(name.len())
            && args_query[..name.len()].eq_ignore_ascii_case(name)
            && args_query[name.len()..].starts_with(char::is_whitespace)
            && models.resolve_by_name_or_id(name).as_ref() == Some(id)
        {
            return Some((id.clone(), &args_query[..name.len()]));
        }
    }
    None
}

/// Catalog names are `Provider / Model`. The picker shows the model; provider goes in the description column.
fn short_model_name(info: &acp::ModelInfo) -> &str {
    info.name
        .split_once(" / ")
        .map(|(_, rest)| rest.trim())
        .filter(|rest| !rest.is_empty())
        .unwrap_or(info.name.as_str())
}

fn model_row_description(id: &acp::ModelId, info: &acp::ModelInfo) -> String {
    let provider = if id.0.starts_with("codex/") {
        "ChatGPT"
    } else if id.0.starts_with("cursor/") {
        "Cursor"
    } else {
        "Grok"
    };
    let mut bits = vec![provider.to_string()];
    if supports_reasoning_effort(info) {
        bits.push("effort".into());
    }
    if let Some(desc) = info
        .description
        .as_deref()
        .map(str::trim)
        .filter(|desc| {
            !desc.is_empty()
                && !desc.eq_ignore_ascii_case("Provider does not expose reasoning effort control")
        })
    {
        bits.push(desc.to_string());
    }
    bits.join(" · ")
}

/// One row per logical model.
/// Reasoning models get a trailing space in `insert_text` so the prompt widget chains into the effort sub-menu.
fn build_model_items(models: &ModelState) -> Vec<ArgItem> {
    let current_id = models.current.as_ref();
    let mut items: Vec<ArgItem> = Vec::with_capacity(models.available.len());
    for (id, info) in &models.available {
        let is_current = current_id == Some(id);
        let supports = supports_reasoning_effort(info);

        let qualified =
            id.0.contains('/') || models.resolve_by_name_or_id(&info.name).as_ref() != Some(id);
        let label = if qualified {
            format!("{} [{}]", short_model_name(info), id.0)
        } else {
            short_model_name(info).to_string()
        };
        let display = if is_current {
            format!("{label} (current)")
        } else {
            label
        };
        let selection = if qualified { id.0.as_ref() } else { &info.name };

        // A trailing space on reasoning models signals "more input expected" to the prompt widget
        // Enter then advances to the effort phase instead of submitting
        let insert_text = if supports {
            format!("{selection} ")
        } else {
            selection.to_string()
        };

        items.push(ArgItem {
            display,
            match_text: if qualified {
                format!("{} {} {}", info.name, short_model_name(info), id.0)
            } else {
                info.name.clone()
            },
            insert_text,
            description: model_row_description(id, info),
        });
    }
    items
}

/// One row per effort level for the `/model` chained effort phase.
/// `insert_text` is `"ModelName high"` so selecting a row completes both tokens.
fn build_effort_items(models: &ModelState, model_id: &acp::ModelId) -> Vec<ArgItem> {
    let info = match models.available.get(model_id) {
        Some(info) => info,
        None => return Vec::new(),
    };
    let model_name = if model_id.0.contains('/')
        || models.resolve_by_name_or_id(&info.name).as_ref() != Some(model_id)
    {
        model_id.0.to_string()
    } else {
        info.name.clone()
    };
    let is_current_model = models.current.as_ref() == Some(model_id);
    let options = models.reasoning_effort_options_for(model_id);
    build_effort_arg_items(
        &options,
        models.reasoning_effort,
        is_current_model,
        |option| format!("{model_name} {}", option.id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    use xai_grok_shell::sampling::types::ReasoningEffort;

    fn model_with_reasoning(id: &str, name: &str) -> (acp::ModelId, acp::ModelInfo) {
        let id = acp::ModelId::new(Arc::from(id));
        let mut meta = serde_json::Map::new();
        meta.insert(
            "supportsReasoningEffort".into(),
            serde_json::Value::Bool(true),
        );
        let info = acp::ModelInfo::new(id.clone(), name.to_string())
            .meta(serde_json::Value::Object(meta).as_object().cloned());
        (id, info)
    }

    fn plain_model(id: &str, name: &str) -> (acp::ModelId, acp::ModelInfo) {
        let id = acp::ModelId::new(Arc::from(id));
        let info = acp::ModelInfo::new(id.clone(), name.to_string());
        (id, info)
    }

    static EMPTY_BUNDLE: crate::app::bundle::BundleState = crate::app::bundle::BundleState {
        has_cache: false,
        version: String::new(),
        personas: Vec::new(),
        roles: Vec::new(),
        agents: Vec::new(),
        skills: Vec::new(),
        persona_details: Vec::new(),
        role_details: Vec::new(),
    };

    fn dummy_exec_ctx(models: &ModelState) -> CommandExecCtx<'_> {
        CommandExecCtx {
            models,
            session_id: None,
            bundle_state: &EMPTY_BUNDLE,
            screen_mode: crate::app::ScreenMode::Inline,
            billing_surface_visible: true,
            usage_command_visible: true,
            pager_state: crate::settings::PagerLocalSnapshot {
                multiline_mode: false,
                yolo_mode: false,
                ..crate::settings::PagerLocalSnapshot::default()
            },
        }
    }

    #[test]
    fn model_settings_picker_offers_only_catalog_levels_and_cancel_is_local() {
        let mut state = ModelState::default();
        let id = acp::ModelId::new("codex/actual");
        let meta = serde_json::json!({"supportsReasoningEffort":true,"reasoningEffort":"minimal",
            "reasoningEfforts":["minimal","high"]});
        state.available.insert(
            id.clone(),
            acp::ModelInfo::new(id.clone(), "Actual").meta(meta.as_object().cloned()),
        );
        let items = build_effort_items(&state, &id);
        assert_eq!(items.len(), 2);
        assert!(
            items
                .iter()
                .any(|i| i.insert_text == "codex/actual minimal")
        );
        assert!(items.iter().any(|i| i.insert_text == "codex/actual high"));
        assert!(!items.iter().any(|i| i.insert_text.contains("xhigh")));
        let mut ctx = dummy_exec_ctx(&state);
        assert!(matches!(
            ModelCommand.run(&mut ctx, "Actual xhigh"),
            CommandResult::Error(_)
        ));
        assert!(matches!(
            ModelCommand.run(&mut ctx, "cancel"),
            CommandResult::Action(Action::CancelPendingModelSwitch)
        ));
        let (plain, info) = plain_model("cursor/actual", "Cursor Actual");
        state.available.insert(plain.clone(), info);
        assert!(build_effort_items(&state, &plain).is_empty());
        let mut ctx = dummy_exec_ctx(&state);
        assert!(
            matches!(ModelCommand.run(&mut ctx, "Cursor Actual high"), CommandResult::Error(message) if message.contains("does not support reasoning effort"))
        );
    }
    #[test]
    fn bare_model_names_resolve_across_providers_only_when_unique() {
        let mut state = ModelState::default();
        let (id, info) = plain_model("codex/gpt-5.5", "ChatGPT / GPT 5.5");
        state.available.insert(id.clone(), info);
        assert_eq!(state.resolve_by_name_or_id("GPT-5.5"), Some(id.clone()));
        assert_eq!(state.resolve_by_name_or_id("GPT 5.5"), Some(id.clone()));
        let (other, info) = plain_model("cursor/gpt-5.5", "Cursor / GPT 5.5");
        state.available.insert(other.clone(), info);
        assert_eq!(state.resolve_by_name_or_id("gpt-5.5"), None);
        assert_eq!(state.resolve_by_name_or_id("GPT 5.5"), None);
        assert_eq!(state.resolve_by_name_or_id("codex/gpt-5.5"), Some(id));
        assert_eq!(state.resolve_by_name_or_id("cursor/gpt-5.5"), Some(other));
    }

    #[test]
    fn cross_provider_models_are_searchable_and_commit_the_selected_id() {
        let mut state = ModelState::default();
        for provider in ["codex", "cursor"] {
            let (id, info) = model_with_reasoning(&format!("{provider}/gpt-5.5"), "GPT 5.5");
            state.available.insert(id, info);
        }
        assert!(detect_effort_phase(&state, "GPT 5.5 ").is_none());
        let items = build_model_items(&state);
        assert_eq!(items.len(), 2);
        for (item, provider) in items.iter().zip(["codex", "cursor"]) {
            let id = format!("{provider}/gpt-5.5");
            assert!(item.match_text.contains("GPT 5.5"));
            assert!(item.match_text.contains(&id));
            assert!(item.display.contains(&id));
            assert_eq!(item.insert_text, format!("{id} "));
            let (resolved, _) = detect_effort_phase(&state, &item.insert_text).unwrap();
            assert_eq!(resolved.0.as_ref(), id);
            let efforts = build_effort_items(&state, &resolved);
            assert!(!efforts.is_empty());
            for effort in efforts {
                assert!(effort.insert_text.starts_with(&format!("{id} ")));
                let mut ctx = dummy_exec_ctx(&state);
                assert!(matches!(
                    ModelCommand.run(&mut ctx, &effort.insert_text),
                    CommandResult::Action(Action::SwitchModel { model_id, .. }) if model_id == resolved
                ));
            }
            let mut ctx = dummy_exec_ctx(&state);
            assert!(matches!(
                ModelCommand.run(&mut ctx, &id),
                CommandResult::Action(Action::SetDefaultModel(model_id)) if model_id == resolved
            ));
        }
    }

    #[test]
    fn controller_refresh_matches_model_aliases_and_filters_effort_suffix() {
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("codex/gpt-5.5", "ChatGPT / GPT 5.5");
        state.available.insert(id, info);
        let mut controller = crate::slash::SlashController::with_builtins(".".into());
        let slash = crate::slash::SlashState::default();
        for alias in ["ChatGPT / GPT 5.5", "GPT 5.5", "gpt-5.5", "codex/gpt-5.5"] {
            for (suffix, expected) in [
                ("", vec!["xhigh", "high", "medium", "low"]),
                ("h", vec!["xhigh", "high"]),
                ("low", vec!["low"]),
                ("medium", vec!["medium"]),
                ("bogus", vec![]),
                ("GPT", vec![]),
                ("5.5", vec![]),
            ] {
                let text = format!("/model {alias} {suffix}");
                controller.refresh(&slash, &text, text.len(), &state);
                let snapshot = slash.snapshot();
                assert_eq!(snapshot.open, !expected.is_empty(), "{text}");
                let mut actual: Vec<_> = snapshot
                    .matches
                    .iter()
                    .map(|row| row.insert_text.as_str())
                    .collect();
                let mut expected: Vec<_> = expected
                    .iter()
                    .map(|effort| format!("codex/gpt-5.5 {effort}"))
                    .collect();
                actual.sort_unstable();
                expected.sort_unstable();
                assert_eq!(actual, expected, "{text}");
            }
        }
    }

    #[test]
    fn mixed_native_and_subscription_collisions_insert_resolvable_ids() {
        for reasoning in [false, true] {
            let mut state = ModelState::default();
            for id in ["grok-4.5", "cursor/grok-4.5"] {
                let (id, info) = if reasoning {
                    model_with_reasoning(id, "Grok 4.5")
                } else {
                    plain_model(id, "Grok 4.5")
                };
                state.available.insert(id, info);
            }
            assert!(state.resolve_by_name_or_id("Grok 4.5").is_none());
            let mut controller = crate::slash::SlashController::with_builtins(".".into());
            let slash = crate::slash::SlashState::default();
            let text = "/model Grok 4.5";
            controller.refresh(&slash, text, text.len(), &state);
            let snapshot = slash.snapshot();
            assert_eq!(snapshot.matches.len(), 2);
            for row in &snapshot.matches {
                let id = state.resolve_by_name_or_id(row.insert_text.trim()).unwrap();
                assert_eq!(row.insert_text.trim(), id.0.as_ref());
                let mut ctx = dummy_exec_ctx(&state);
                assert!(matches!(
                    ModelCommand.run(&mut ctx, row.insert_text.trim()),
                    CommandResult::Action(Action::SetDefaultModel(resolved)) if resolved == id
                ));
                if reasoning {
                    let text = format!("/model {}low", row.insert_text);
                    controller.refresh(&slash, &text, text.len(), &state);
                    let efforts = slash.snapshot();
                    assert_eq!(efforts.matches.len(), 1);
                    let effort = &efforts.matches[0];
                    assert_eq!(effort.insert_text, format!("{} low", id.0));
                    assert!(matches!(
                        ModelCommand.run(&mut ctx, &effort.insert_text),
                        CommandResult::Action(Action::SwitchModel { model_id, .. }) if model_id == id
                    ));
                }
            }
        }
    }

    #[test]
    fn split_trailing_token_splits_on_final_whitespace() {
        assert_eq!(
            split_trailing_token("Reasoning X high"),
            Some(("Reasoning X", "high"))
        );
        assert_eq!(
            split_trailing_token("reasoning-x  xhigh"),
            Some(("reasoning-x", "xhigh"))
        );
        // No interior whitespace, so nothing to split off
        assert!(split_trailing_token("reasoning-x-pro").is_none());
    }

    #[test]
    fn subscription_rows_lead_with_the_model_not_a_capability_warning() {
        let mut state = ModelState::default();
        let id = acp::ModelId::new("cursor/composer");
        let info = acp::ModelInfo::new(
            id.clone(),
            "Cursor subscription (experimental) / Composer".to_string(),
        )
        .description(Some(
            "Provider does not expose reasoning effort control".into(),
        ));
        state.available.insert(id, info);
        let items = build_model_items(&state);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].display, "Composer [cursor/composer]");
        assert_eq!(items[0].description, "Cursor");
        assert!(!items[0].display.contains("experimental"));
        assert!(!items[0].description.contains("does not expose"));
        assert!(items[0].match_text.contains("Composer"));
    }

    #[test]
    fn empty_query_returns_one_row_per_logical_model() {
        let mut state = ModelState::default();
        let (rid, rinfo) = model_with_reasoning("reasoning-x", "Reasoning X");
        let (pid, pinfo) = plain_model("grok-4.5", "Grok 4.5");
        state.available.insert(rid, rinfo);
        state.available.insert(pid, pinfo);

        let cmd = ModelCommand;
        let ctx = AppCtx {
            models: &state,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            saved_workflows: &[],
            workflow_runs: &[],
            screen_mode: crate::app::ScreenMode::Fullscreen,
            current_title: None,
        };
        let items = cmd.suggest_args(&ctx, "").unwrap();
        assert_eq!(items.len(), 2, "model phase: one row per logical model");

        // A reasoning model has a trailing space in insert_text
        // The prompt widget reads it to keep the dropdown open after Enter so the effort sub-menu can render
        let reasoning = items
            .iter()
            .find(|i| i.match_text == "Reasoning X")
            .unwrap();
        assert_eq!(reasoning.insert_text, "Reasoning X ");

        // A plain model has no trailing space, so Enter commits immediately
        let plain = items.iter().find(|i| i.match_text == "Grok 4.5").unwrap();
        assert_eq!(plain.insert_text, "Grok 4.5");
    }

    #[test]
    fn trailing_space_after_reasoning_model_enters_effort_phase() {
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("reasoning-x", "Reasoning X");
        state.available.insert(id, info);

        let cmd = ModelCommand;
        let ctx = AppCtx {
            models: &state,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            saved_workflows: &[],
            workflow_runs: &[],
            screen_mode: crate::app::ScreenMode::Fullscreen,
            current_title: None,
        };
        // The args query has a trailing space, so this is the effort phase
        // Items come out ordered xhigh to low (strongest first) per EFFORT_LEVELS
        let items = cmd.suggest_args(&ctx, "Reasoning X ").unwrap();
        assert_eq!(items.len(), 4);
        assert_eq!(items[0].insert_text, "Reasoning X xhigh");
        assert_eq!(items[1].insert_text, "Reasoning X high");
        assert_eq!(items[2].insert_text, "Reasoning X medium");
        assert_eq!(items[3].insert_text, "Reasoning X low");
        // Display is just the level so the user sees a clean column.
        assert_eq!(items[0].display, "xhigh");
        // match_text carries the sort-key prefix that forces the matcher's alphabetical tiebreak to render rows in EFFORT_LEVELS order
        assert!(items[0].match_text.starts_with("a "));
        assert!(items[3].match_text.starts_with("d "));
    }

    #[test]
    fn partial_effort_query_still_in_effort_phase() {
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("reasoning-x", "Reasoning X");
        state.available.insert(id, info);

        let cmd = ModelCommand;
        let ctx = AppCtx {
            models: &state,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            saved_workflows: &[],
            workflow_runs: &[],
            screen_mode: crate::app::ScreenMode::Fullscreen,
            current_title: None,
        };
        // Filter the effort suffix independently of the model alias.
        let items = cmd.suggest_args(&ctx, "Reasoning X h").unwrap();
        assert_eq!(items.len(), 2);
    }

    #[test]
    fn partial_model_query_stays_in_model_phase() {
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("reasoning-x", "Reasoning X");
        state.available.insert(id, info);

        let cmd = ModelCommand;
        let ctx = AppCtx {
            models: &state,
            cwd: std::path::Path::new("."),
            has_session_announcements: false,
            billing_surface_visible: true,
            usage_command_visible: true,
            workflows_available: true,
            saved_workflows: &[],
            workflow_runs: &[],
            screen_mode: crate::app::ScreenMode::Fullscreen,
            current_title: None,
        };
        // No trailing space: the user is still typing the model name
        let items = cmd.suggest_args(&ctx, "Reason").unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].insert_text, "Reasoning X ");
    }

    #[test]
    fn run_parses_model_plus_effort_when_supported() {
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("reasoning-x", "Reasoning X");
        state.available.insert(id, info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "Reasoning X xhigh");
        match result {
            CommandResult::Action(Action::SwitchModel { model_id, effort }) => {
                assert_eq!(model_id.0.as_ref(), "reasoning-x");
                assert_eq!(effort, Some(ReasoningEffort::Xhigh));
            }
            other => panic!("expected SwitchModel with effort, got {other:?}"),
        }
    }

    #[test]
    fn run_rejects_unoffered_effort_with_effort_error_not_unknown_model() {
        // Regression: previously `resolve_effort_token_for` returned None and the handler fell through to `Unknown model: Reasoning X none`
        let mut state = ModelState::default();
        let (id, info) = model_with_reasoning("reasoning-x", "Reasoning X");
        state.available.insert(id, info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "Reasoning X none");
        match result {
            CommandResult::Error(msg) => {
                assert!(
                    msg.contains("unknown effort level 'none'"),
                    "expected effort error, got {msg}"
                );
                assert!(
                    msg.contains("use one of:"),
                    "expected offered levels in message, got {msg}"
                );
                assert!(
                    !msg.to_lowercase().contains("unknown model"),
                    "must not misreport as unknown model: {msg}"
                );
                let offered = msg.split_once("; ").map(|(_, r)| r).unwrap_or("");
                assert!(
                    !offered.contains("none"),
                    "must not list none as offered: {msg}"
                );
            }
            other => panic!("expected Error, got {other:?}"),
        }
    }

    #[test]
    fn run_prefers_full_multi_word_model_name_over_prefix_plus_effort() {
        // The catalog has both "Grok" (reasoning) and "Grok 4.5"
        // `/model Grok 4.5` must select the full name, not treat "4.5" as an effort on "Grok"
        let mut state = ModelState::default();
        let (short_id, short_info) = model_with_reasoning("grok", "Grok");
        let (long_id, long_info) = model_with_reasoning("grok-4.5", "Grok 4.5");
        state.available.insert(short_id, short_info);
        state.available.insert(long_id.clone(), long_info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "Grok 4.5");
        match result {
            CommandResult::Action(Action::SetDefaultModel(resolved_id)) => {
                assert_eq!(resolved_id, long_id);
            }
            other => panic!("expected SetDefaultModel(Grok 4.5), got {other:?}"),
        }
    }

    #[test]
    fn run_rejects_effort_for_non_reasoning_model() {
        let mut state = ModelState::default();
        let (id, info) = plain_model("grok-4.5", "Grok 4.5");
        state.available.insert(id, info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "Grok 4.5 high");
        // Falls through to "is the whole string a model name?", which it isn't, so we get an Unknown error
        assert!(matches!(result, CommandResult::Error(_)));
    }

    /// The bare `/model <name>` form dispatches `Action::SetDefaultModel(<ModelId>)` instead of the legacy `Action::SwitchModel { effort: None }`.
    /// The dispatcher routes it through both `Effect::SwitchModel` (session mutation) and `Effect::PersistSetting` (next-session default).
    ///
    /// The payload is the typed `acp::ModelId` (resolved at the slash boundary), not a String.
    #[test]
    fn run_bare_model_name_dispatches_set_default_model() {
        let mut state = ModelState::default();
        let (id, info) = plain_model("grok-4.5", "Grok 4.5");
        state.available.insert(id.clone(), info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "Grok 4.5");
        match result {
            CommandResult::Action(Action::SetDefaultModel(resolved_id)) => {
                assert_eq!(resolved_id, id);
            }
            other => panic!("expected Action::SetDefaultModel(<id>), got {other:?}"),
        }
    }

    /// Case-insensitive matching against the catalog: `/model grok 4.5` resolves to the same `ModelId` as `/model Grok 4.5`.
    #[test]
    fn run_set_default_model_resolves_case_insensitively() {
        let mut state = ModelState::default();
        let (id, info) = plain_model("grok-4.5", "Grok 4.5");
        state.available.insert(id.clone(), info);
        let mut ctx = dummy_exec_ctx(&state);
        let result = ModelCommand.run(&mut ctx, "grok 4.5");
        match result {
            CommandResult::Action(Action::SetDefaultModel(resolved_id)) => {
                assert_eq!(resolved_id, id);
            }
            other => panic!("expected Action::SetDefaultModel(<id>), got {other:?}"),
        }
    }
}
