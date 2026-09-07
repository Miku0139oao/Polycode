//! Identity checks at the authoritative resume/install boundary and auxiliary template sources.
use super::{install_system_prompt, migrate_resumed_builtin_identity};
use xai_grok_agent::{PromptContext, prompt::context::PromptAudience};
use xai_grok_sampling_types::conversation::ConversationItem;
use xai_grok_tools::types::template_renderer::TemplateRenderer;

fn system_text(item: &ConversationItem) -> &str {
    match item {
        ConversationItem::System(sys) => &sys.content,
        _ => panic!("expected system message"),
    }
}

fn legacy_primary_prompt(ctx: &PromptContext, renderer: &TemplateRenderer) -> String {
    let mut legacy = ctx.clone();
    let template = xai_grok_agent::prompt::template::base_template_source();
    let intro = "You are Polycode, a provider-neutral software engineering agent. Polycode is your agent identity, independent of the selected model. Describe the underlying model and its creator only using authoritative model/provider metadata; a hosting service is not necessarily the model's creator.";
    let remainder = template
        .strip_prefix(intro)
        .expect("exact Polycode opening");
    legacy.system_prompt = xai_grok_agent::prompt::context::TemplateOverride::Custom(
        format!("You are ${{{{ system_prompt_label }}}} released by xAI.{remainder}").replacen(
            "Documentation about the Polycode TUI",
            "Documentation about the Grok Build TUI",
            1,
        ),
    );
    legacy.render_with_renderer(renderer).unwrap()
}

#[test]
fn polycode_resume_migrates_authoritative_head_and_preserves_history_and_custom_rules() {
    let renderer = TemplateRenderer::new(Default::default(), Default::default());
    let ctx = PromptContext {
        system_prompt_label: "Grok".into(),
        prompt_body: Some("Custom body mentioning Grok Build, xAI, and Cursor.".into()),
        ..Default::default()
    };
    // Exercise the on-disk saved context rather than substituting a fresh context at resume.
    let tmp = tempfile::tempdir().unwrap();
    std::fs::write(
        tmp.path().join("prompt_context.json"),
        serde_json::to_vec(&ctx).unwrap(),
    )
    .unwrap();
    let saved_context = super::load_prompt_context_from_dir(tmp.path()).unwrap();
    let rules =
        "\n\n<human_rules>\nKeep this literal: You are Grok released by xAI.\n</human_rules>";
    let old = format!("{}{rules}", legacy_primary_prompt(&ctx, &renderer));
    let turns = vec![
        ConversationItem::user("You are Grok released by xAI. This is user text."),
        ConversationItem::assistant("Previously answered as Grok; preserve this history verbatim."),
        ConversationItem::system("Additional system message about Grok Build."),
        ConversationItem::user("Continue the previous task."),
    ];
    let original_turns = serde_json::to_value(&turns).unwrap();
    let mut conversation = vec![ConversationItem::system(old)];
    conversation.extend(turns);
    // A stale/different convenience mirror must not be used as migration input.
    std::fs::write(tmp.path().join("system_prompt.txt"), "unrelated mirror").unwrap();
    assert!(migrate_resumed_builtin_identity(
        &mut conversation,
        &saved_context,
        &renderer
    ));
    let mut prefix = None;
    install_system_prompt(
        &mut conversation,
        &mut prefix,
        false,
        false,
        "fresh replacement must not win",
    );
    assert_eq!(
        system_text(&conversation[0]),
        format!("{}{rules}", ctx.render_with_renderer(&renderer).unwrap())
    );
    assert_eq!(
        serde_json::to_value(&conversation[1..]).unwrap(),
        original_turns
    );
    assert_eq!(prefix, None);
    assert!(!migrate_resumed_builtin_identity(
        &mut conversation,
        &saved_context,
        &renderer
    ));
}

#[test]
fn polycode_resume_preserves_custom_system_and_does_not_search_later_turns() {
    let renderer = TemplateRenderer::new(Default::default(), Default::default());
    let ctx = PromptContext {
        system_prompt_label: "Grok".into(),
        ..Default::default()
    };
    for head in [
        ConversationItem::system(
            "You are Grok released by xAI. This is an explicit custom prompt.",
        ),
        ConversationItem::user("A history with no system head"),
    ] {
        let mut conversation = vec![
            head,
            ConversationItem::system(legacy_primary_prompt(&ctx, &renderer)),
        ];
        let before = serde_json::to_value(&conversation).unwrap();
        assert!(!migrate_resumed_builtin_identity(
            &mut conversation,
            &ctx,
            &renderer
        ));
        assert_eq!(serde_json::to_value(&conversation).unwrap(), before);
    }
}

#[test]
fn polycode_child_resume_installs_fresh_neutral_prompt_without_rewriting_turns() {
    let renderer = TemplateRenderer::new(Default::default(), Default::default());
    let ctx = PromptContext {
        audience: PromptAudience::Subagent,
        ..Default::default()
    };
    let fresh = ctx.render_with_renderer(&renderer).unwrap();
    let mut conversation = vec![
        ConversationItem::system(
            "You are a Grok Build subagent — a focused worker delegated a specific task.",
        ),
        ConversationItem::user("Original child task"),
    ];
    let tail = serde_json::to_value(&conversation[1..]).unwrap();
    let mut prefix = Some(2);
    install_system_prompt(&mut conversation, &mut prefix, true, false, &fresh);
    assert_eq!(system_text(&conversation[0]), fresh);
    assert!(
        fresh.starts_with(
            "You are a Polycode subagent — a focused worker delegated a specific task."
        )
    );
    assert!(!fresh.contains("Grok Build"));
    assert!(!fresh.contains("released by xAI"));
    assert_eq!(serde_json::to_value(&conversation[1..]).unwrap(), tail);
    assert_eq!(prefix, Some(2));
}

#[test]
fn polycode_auxiliary_templates_have_exact_neutral_role_openings() {
    for (template, opening) in [
        (
            include_str!("../templates/goal_planner_prompt.md"),
            "You are the Goal Plan Writer for the Polycode harness.",
        ),
        (
            include_str!("../templates/goal_strategist_prompt.md"),
            "You are the Goal Strategist for the Polycode harness.",
        ),
        (
            include_str!("../templates/goal_summarizer_prompt.md"),
            "You are the Goal Summarizer for the Polycode harness.",
        ),
        (
            include_str!("../templates/goal_verifier_prompt.md"),
            "You are an **adversarial verifier** for the Polycode harness.",
        ),
    ] {
        assert!(template.starts_with(opening));
        assert!(!template.contains("Grok Build"));
        assert!(!template.contains("xAI"));
        assert!(!template.contains("OpenAI"));
        assert!(!template.contains("Cursor"));
    }
    for template in [
        include_str!("../templates/goal_continuation_directive.md"),
        include_str!("../templates/goal_continuation_directive_legacy.md"),
        include_str!("../templates/goal_plan_block.md"),
        include_str!("../templates/goal_rules.md"),
        include_str!("../templates/goal_rules_legacy.md"),
        include_str!("../templates/goal_task_discipline.md"),
        include_str!("../templates/goal_verifier_kind_lens_analysis.md"),
        include_str!("../templates/goal_verifier_kind_lens_code_change.md"),
        include_str!("../templates/goal_verifier_kind_lens_research.md"),
        include_str!("../templates/goal_verifier_resume_prompt.md"),
    ] {
        assert!(!template.contains("xAI Grok Build harness"));
        assert!(!template.contains("You are Grok"));
    }
}
