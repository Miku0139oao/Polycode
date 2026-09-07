use super::*;
use std::cell::Cell;
use xai_grok_subagent_resolution::config::{SubagentPersona, SubagentRole};
use xai_grok_test_support::EnvGuard;

const ORIGIN: &str = "http://127.0.0.1:38479";
const CODEX: &str = "http://127.0.0.1:38479/codex/v1";
const CURSOR: &str = "http://127.0.0.1:38479/cursor/v1";
const NATIVE: &str = "https://api.x.ai/v1";

fn routed_entry(model: &str, base: &str) -> crate::agent::config::ModelEntry {
    let mut entry = test_model_entry(model);
    entry.info.base_url = base.to_owned();
    entry
}
fn live_sampling(model: &str, base: &str) -> xai_grok_sampling_types::SamplingConfig {
    xai_grok_sampling_types::SamplingConfig {
        base_url: base.to_owned(),
        temperature: Some(0.17),
        ..test_sampling_config(model)
    }
}
fn source(model: &str) -> ResumeSourceData {
    ResumeSourceData {
        subagent_id: "previous-child".into(),
        child_session_id: "previous-session".into(),
        child_cwd: "/tmp".into(),
        worktree_path: None,
        snapshot_ref: None,
        subagent_type: "general-purpose".into(),
        persona: None,
        model_id: Some(model.into()),
    }
}
fn assert_affinity_error<T>(result: Result<T, String>) {
    let error = result.err().expect("cross-provider pin must fail closed");
    assert!(error.contains("Select the desired provider in the TUI"));
    assert!(error.contains("Native fees"));
}

// The sampler registry is a OnceLock. ONE registration covers all providers/cases;
// do not split this into independent registering tests or install a shell bridge.
// No sockets are bound and no inference/control requests are sent.
#[tokio::test]
#[serial_test::serial]
async fn registered_subscription_children_preserve_provider_affinity() {
    xai_grok_sampler::local_transport::register(ORIGIN, "affinity-fixture-transport-token")
        .unwrap();
    let _ambient = EnvGuard::set("XAI_API_KEY", "ambient-native-fee-key-fixture");
    assert!(crate::agent::auth_method::read_xai_api_key_env().is_ok());
    for (parent_base, foreign_base) in [(CODEX, CURSOR), (CURSOR, CODEX)] {
        exercise_subscription_parent(parent_base, foreign_base).await;
    }
    // Provider classification is not a URL suffix, slug prefix or mode heuristic.
    for lookalike in [
        "https://unregistered.example/codex/v1",
        "http://127.0.0.1:38480/codex/v1",
        "http://127.0.0.1:38479/codex/v1/",
        "http://127.0.0.1:38479/codex/v1?provider=codex",
    ] {
        assert_affinity_error(validate_child_provider(CODEX, lookalike));
        assert!(validate_child_provider(lookalike, NATIVE).is_ok());
    }
    assert!(validate_child_provider(NATIVE, CODEX).is_ok());
    assert!(validate_child_provider(NATIVE, NATIVE).is_ok());
    // Even when mode requires live state, a native parent's ordinary model choice
    // remains native and can resolve its ambient API key exactly as before.
    let mut ctx = ctx_with_toggle(HashMap::new());
    let chat = spawn_test_parent_chat_state("native-parent");
    chat.update_sampling_config(live_sampling("native-parent", NATIVE));
    ctx.parent_chat_state = Some(chat);
    ctx.available_models.insert(
        "native-choice".into(),
        routed_entry("native-choice", NATIVE),
    );
    let parent = capture_parent_sampling_config(&ctx, true).await.unwrap();
    let (config, _) = resolve_effective_model_config(
        Some("native-choice"),
        "general-purpose",
        &ModelOverride::Inherit,
        &ctx,
        &parent,
    )
    .unwrap();
    assert_eq!(config.base_url, NATIVE);
    assert_eq!(config.model, "native-choice");
    assert_eq!(
        config.api_key.as_deref(),
        Some("ambient-native-fee-key-fixture")
    );
}

async fn exercise_subscription_parent(parent_base: &str, foreign_base: &str) {
    let mut ctx = ctx_with_toggle(HashMap::new());
    ctx.model_id = acp::ModelId::new("grok-4.5");
    ctx.sampling_config.model = "grok-4.5".into();
    ctx.sampling_config.base_url = NATIVE.into();
    ctx.sampling_config.api_key = Some("stale-native-key-fixture".into());
    ctx.available_models
        .insert("grok-4.5".into(), routed_entry("grok-4.5", NATIVE));
    ctx.available_models
        .insert("live-choice".into(), routed_entry("live-slug", parent_base));
    // The model name is intentionally foreign-looking; endpoints, not names, decide.
    ctx.available_models.insert(
        "same-provider".into(),
        routed_entry("grok-foreign-looking-slug", parent_base),
    );
    ctx.available_models.insert(
        "foreign-provider".into(),
        routed_entry("other-slug", foreign_base),
    );
    let chat = spawn_test_parent_chat_state("old-slug");
    chat.update_sampling_config(live_sampling("live-slug", parent_base));
    chat.update_credentials(xai_chat_state::Credentials {
        api_key: Some("live-key-fixture".into()),
        auth_type: xai_chat_state::AuthType::ApiKey,
        alpha_test_key: Some("live-alpha-fixture".into()),
        client_version: Some("live-client-version".into()),
    });
    ctx.parent_chat_state = Some(chat.clone());
    let parent = read_parent_sampling_config(&ctx).await.unwrap();
    assert_eq!(parent.model_id.0.as_ref(), "live-choice");
    assert_eq!(
        parent.credentials.alpha_test_key.as_deref(),
        Some("live-alpha-fixture")
    );
    assert_eq!(parent.config.api_key.as_deref(), Some("live-key-fixture"));
    assert_eq!(
        parent.config.client_version.as_deref(),
        Some("live-client-version")
    );
    assert!(parent.config.bearer_resolver.is_none());
    let mut request = bootstrap_test_request(false);
    let inherit = ModelOverride::Inherit;
    let (inherited, id) =
        resolve_child_model_config(&request, None, &inherit, None, &ctx, &parent).unwrap();
    assert_eq!(inherited.base_url, parent_base);
    assert_eq!(inherited.model, "live-slug");
    assert_eq!(inherited.temperature, Some(0.17));
    assert_eq!(inherited.api_key, parent.config.api_key);
    assert_eq!(id, parent.model_id);

    // Task.model is model-visible, not a billing-consent surface.
    request.runtime_overrides.model = Some("grok-4.5".into());
    request.runtime_overrides.model_override_provenance = ModelOverrideProvenance::Tool;
    assert!(
        super::super::handle_request::task_model_override_error(
            request.runtime_overrides.model.as_deref(),
            ModelOverrideProvenance::Tool,
            false,
            &ctx.available_models,
            false,
        )
        .is_none()
    );
    assert_affinity_error(resolve_child_model_config(
        &request,
        request.runtime_overrides.model.as_deref(),
        &inherit,
        None,
        &ctx,
        &parent,
    ));
    // The actual credential-resolution callback used by production must not execute,
    // even with an ambient native key available. A client/inference downstream of it
    // is therefore unreachable, rather than merely failing later due to missing auth.
    let credential_calls = Cell::new(0);
    let downstream_calls = Cell::new(0);
    let native = &ctx.available_models["grok-4.5"];
    assert_affinity_error(with_child_provider_affinity(parent_base, native, || {
        credential_calls.set(credential_calls.get() + 1);
        let credentials = resolve_credentials(native, None);
        downstream_calls.set(downstream_calls.get() + 1);
        credentials
    }));
    assert_eq!(credential_calls.get(), 0);
    assert_eq!(downstream_calls.get(), 0);

    for foreign in ["grok-4.5", "foreign-provider"] {
        assert_affinity_error(resolve_effective_model_config(
            Some(foreign),
            "general-purpose",
            &inherit,
            &ctx,
            &parent,
        ));
        assert_affinity_error(resolve_effective_model_config(
            None,
            "general-purpose",
            &ModelOverride::Override(foreign.into()),
            &ctx,
            &parent,
        ));
        ctx.subagent_model_overrides
            .insert("general-purpose".into(), foreign.into());
        assert_affinity_error(resolve_effective_model_config(
            None,
            "general-purpose",
            &inherit,
            &ctx,
            &parent,
        ));
        ctx.subagent_model_overrides.clear();
        assert_affinity_error(resolve_child_model_config(
            &request,
            Some("same-provider"),
            &inherit,
            Some(&source(foreign)),
            &ctx,
            &parent,
        ));
    }
    // Role/persona text participates in the real runtime precedence, but never consent.
    let definition = xai_grok_agent::config::AgentDefinition::general_purpose();
    request.runtime_overrides.model = None;
    for persona in [false, true] {
        request.subagent_type = if persona {
            "general-purpose"
        } else {
            "affinity-role"
        }
        .into();
        request.runtime_overrides.persona = persona.then(|| "affinity-persona".into());
        ctx.subagent_roles.insert(
            "affinity-role".into(),
            SubagentRole {
                model: Some("grok-4.5".into()),
                ..Default::default()
            },
        );
        ctx.subagent_personas.insert(
            "affinity-persona".into(),
            SubagentPersona {
                instructions: Some("Test persona instructions.".into()),
                model: Some("grok-4.5".into()),
                ..Default::default()
            },
        );
        let runtime = xai_grok_subagent_resolution::resolve_runtime_config(
            &request.subagent_type,
            &request.runtime_overrides,
            &ctx.subagent_roles,
            &ctx.subagent_personas,
            None,
            &definition,
        );
        assert!(runtime.persona_error.is_none());
        assert_eq!(runtime.model.as_deref(), Some("grok-4.5"));
        assert_affinity_error(resolve_child_model_config(
            &request,
            runtime.model.as_deref(),
            &inherit,
            None,
            &ctx,
            &parent,
        ));
    }
    request = bootstrap_test_request(false);
    // Only the winner is validated: an unused foreign config/definition pin cannot
    // prevent a same-provider runtime override, resume source, or live-context fork.
    ctx.subagent_model_overrides
        .insert("general-purpose".into(), "grok-4.5".into());
    let foreign_definition = ModelOverride::Override("foreign-provider".into());
    let (same, _) = resolve_child_model_config(
        &request,
        Some("same-provider"),
        &foreign_definition,
        None,
        &ctx,
        &parent,
    )
    .unwrap();
    assert_eq!(same.model, "grok-foreign-looking-slug");
    assert_eq!(same.base_url, parent_base);
    assert!(same.api_key.is_none());
    let (resumed, _) = resolve_child_model_config(
        &request,
        Some("grok-4.5"),
        &foreign_definition,
        Some(&source("same-provider")),
        &ctx,
        &parent,
    )
    .unwrap();
    assert_eq!(resumed.base_url, parent_base);
    assert_eq!(resumed.model, same.model);
    request.fork_context = true;
    let (forked, fork_id) = resolve_child_model_config(
        &request,
        Some("grok-4.5"),
        &foreign_definition,
        None,
        &ctx,
        &parent,
    )
    .unwrap();
    assert_eq!(forked.model, "live-slug");
    assert_eq!(forked.api_key, parent.config.api_key);
    assert_eq!(fork_id, parent.model_id);
    assert_affinity_error(resolve_child_model_config(
        &request,
        None,
        &inherit,
        Some(&source("grok-4.5")),
        &ctx,
        &parent,
    ));
    request.fork_context = false;
    ctx.subagent_model_overrides.clear();
    // Unknown pins may still fall back, but only to this verified snapshot.
    let (unknown, _) =
        resolve_effective_model_config(Some("missing"), "general-purpose", &inherit, &ctx, &parent)
            .unwrap();
    assert_eq!(unknown.base_url, parent_base);
    assert_eq!(unknown.model, "live-slug");
    assert!(
        resolve_child_model_config(
            &request,
            Some("grok-4.5"),
            &inherit,
            Some(&source("missing")),
            &ctx,
            &parent
        )
        .is_err()
    );
    ctx.available_models.shift_remove("live-choice");
    let (known_parent, _) = resolve_child_model_config(
        &request,
        Some("grok-4.5"),
        &inherit,
        Some(&source("live-choice")),
        &ctx,
        &parent,
    )
    .unwrap();
    assert_eq!(known_parent.base_url, parent_base);

    // API-key fallback URLs are inspected before any ambient credential read too.
    let mut ambiguous = routed_entry("ambiguous", parent_base);
    ambiguous.api_base_url = Some(NATIVE.into());
    assert_affinity_error(with_child_provider_affinity(
        parent_base,
        &ambiguous,
        || -> () { panic!("credential helper reached") },
    ));
    ctx.available_models.insert("ambiguous".into(), ambiguous);
    assert_affinity_error(resolve_effective_model_config(
        Some("ambiguous"),
        "general-purpose",
        &inherit,
        &ctx,
        &parent,
    ));
    // Defense after effort/resume can reject a mutated effective route.
    let mut after_effort = same.clone();
    after_effort.base_url = NATIVE.into();
    assert_affinity_error(validate_child_provider(
        &parent.config.base_url,
        &after_effort.base_url,
    ));

    assert!(recheck_parent_model(&ctx, &parent).await.is_ok());
    chat.update_credentials(xai_chat_state::Credentials {
        api_key: Some("rotated-live-key-fixture".into()),
        ..parent.credentials.clone()
    });
    assert!(recheck_parent_model(&ctx, &parent).await.is_ok());
    assert_eq!(parent.config.api_key.as_deref(), Some("live-key-fixture"));
    // A later snapshot is used ONLY for stale-route detection, not inheritance.
    chat.update_sampling_config(live_sampling("new-same-provider-model", parent_base));
    let (still_captured, _) =
        resolve_child_model_config(&request, None, &inherit, None, &ctx, &parent).unwrap();
    assert_eq!(still_captured.model, "live-slug");
    assert!(recheck_parent_model(&ctx, &parent).await.is_err());
    chat.update_sampling_config(live_sampling("live-slug", foreign_base));
    assert!(recheck_parent_model(&ctx, &parent).await.is_err());
    ctx.parent_chat_state = None;
    assert!(recheck_parent_model(&ctx, &parent).await.is_err());
    // Global mode requires state even with a native process baseline, but never
    // determines provider classification. No global test-mode mutation is needed.
    assert!(capture_parent_sampling_config(&ctx, true).await.is_err());
    ctx.sampling_config.base_url = parent_base.into();
    assert!(read_parent_sampling_config(&ctx).await.is_err());
}

#[tokio::test]
async fn polycode_missing_or_closed_parent_state_fails_closed() {
    let mut ctx = ctx_with_toggle(HashMap::new());
    assert!(capture_parent_sampling_config(&ctx, true).await.is_err());
    let (mock, _rx) = xai_chat_state::MockChatPersistence::new();
    let (event_tx, _events) = mpsc::unbounded_channel();
    let cancel = CancellationToken::new();
    let chat = xai_chat_state::ChatStateActor::spawn(
        vec![],
        test_sampling_config("grok-4.5"),
        Box::new(mock),
        event_tx,
        cancel.clone(),
    );
    cancel.cancel();
    ctx.parent_chat_state = Some(chat);
    assert!(capture_parent_sampling_config(&ctx, true).await.is_err());
    // Ordinary native fallback remains available outside Polycode.
    ctx.parent_chat_state = None;
    assert!(capture_parent_sampling_config(&ctx, false).await.is_ok());
}

#[test]
fn model_resolution_log_fields_never_contain_key_fragments() {
    let ctx = ctx_with_toggle(HashMap::new());
    let mut parent = ctx.sampling_config.clone();
    let mut child = parent.clone();
    parent.api_key = Some("parent-fixture-secret-value".into());
    for key in ["child-fixture-secret-value", "abc", "密碼測試", ""] {
        child.api_key = Some(key.into());
        let fields =
            subagent_model_resolution_fields("test", "inherit", &child, &ctx.model_id, &parent);
        assert_eq!(fields["child_key"], "configured");
        assert_eq!(fields["parent_key"], "configured");
        let serialized = fields.to_string();
        assert!(!serialized.contains("parent-f"));
        if !key.is_empty() {
            let fragment: String = key.chars().take(8).collect();
            assert!(!serialized.contains(&fragment));
        }
    }
    child.api_key = parent.api_key.clone();
    let fields =
        subagent_model_resolution_fields("test", "inherit", &child, &ctx.model_id, &parent);
    assert_eq!(fields["keys_match"], true);
    child.api_key = None;
    let fields =
        subagent_model_resolution_fields("test", "inherit", &child, &ctx.model_id, &parent);
    assert_eq!(fields["child_key"], "absent");
    for source in [
        include_str!("../mod.rs"),
        include_str!("../handle_request.rs"),
    ] {
        assert!(
            !source.contains("key_prefix"),
            "no credential prefix logger may remain"
        );
    }
}
