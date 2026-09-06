//! No network or real credentials: exercise the production routing seam with sentinel auth.
use super::*;

fn selected(provider: &str) -> SamplerConfig {
    SamplerConfig {
        model: format!("selected-{provider}"),
        base_url: format!("http://127.0.0.1:1234/{provider}/v1"),
        api_backend: ApiBackend::ChatCompletions,
        api_key: Some("test-process-transport".into()),
        context_window: 128_000,
        client_identifier: Some("test-session".into()),
        max_retries: Some(2),
        query_params: IndexMap::from([("session".into(), "test".into())]),
        extra_headers: IndexMap::from([("x-test-route".into(), "selected".into())]),
        ..Default::default()
    }
}

#[test]
#[serial]
fn subscription_aux_affinity_ignores_native_credentials_present_and_absent() {
    for native in [false, true] {
        let _api = if native {
            EnvGuard::set(XAI_API_KEY_ENV_VAR, "test-native-api-key")
        } else {
            EnvGuard::unset(XAI_API_KEY_ENV_VAR)
        };
        let _legacy = EnvGuard::unset(LEGACY_XAI_API_KEY_ENV_VAR);
        let session = native.then_some("test-native-session");
        let endpoints = EndpointsConfig {
            deployment_key: native.then(|| "test-native-deployment".into()),
            ..Default::default()
        };
        let mut models = IndexMap::new();
        models.insert(
            "grok-4.6".into(),
            test_model_entry(
                "grok-4.6",
                "https://api.x.ai/v1",
                native.then_some("test-native-owned"),
                None,
                None,
            ),
        );
        for provider in ["codex", "cursor"] {
            let primary = selected(provider);
            for helper in [
                "grok-4.6",
                "missing-helper",
                "cursor/foreign",
                "codex/foreign",
            ] {
                let resolved = resolve_aux_model_sampling_config(
                    &primary, helper, &models, &endpoints, session, false, None, None,
                )
                .unwrap();
                // Compare every serializable field, not just the model and URL.
                assert_eq!(
                    serde_json::to_value(&resolved).unwrap(),
                    serde_json::to_value(&primary).unwrap()
                );
                let (model, image) = finalize_image_describe_sampler_config(
                    Some(resolved),
                    &primary,
                    primary.client_identifier.clone(),
                    primary.max_retries,
                );
                assert_eq!(model, primary.model);
                assert_eq!(
                    serde_json::to_value(image).unwrap(),
                    serde_json::to_value(&primary).unwrap()
                );
            }
        }
    }
}

#[test]
fn subscription_aux_affinity_accepts_only_explicit_same_provider_catalog_helpers() {
    for provider in ["codex", "cursor"] {
        let primary = selected(provider);
        let mut helper = test_model_entry("small-helper", &primary.base_url, None, None, None);
        helper.info.api_backend = primary.api_backend.clone();
        helper.info.extra_headers = primary.extra_headers.clone();
        helper.info.query_params = primary.query_params.clone();
        // Even a credential pinned on the helper cannot replace the subscription transport.
        helper.api_key = Some("must-not-be-used".into());
        let key = format!("{provider}/small");
        let mut models = IndexMap::from([(key.clone(), helper.clone())]);
        let resolved = subscription_aux_sampling_config(&primary, Some(&key), &models);
        assert_eq!(resolved.model, "small-helper");
        assert_eq!(resolved.base_url, primary.base_url);
        assert_eq!(resolved.api_key, primary.api_key);
        assert_eq!(resolved.query_params, primary.query_params);
        assert_eq!(resolved.client_identifier, primary.client_identifier);
        // No slug-only lookup: another provider may advertise the very same wire model.
        assert_eq!(
            subscription_aux_sampling_config(&primary, Some("small-helper"), &models).model,
            primary.model
        );
        assert_eq!(
            subscription_aux_sampling_config(&primary, None, &models).model,
            primary.model
        );
        for foreign in [
            "http://127.0.0.1:1234/cursor/v1",
            "http://127.0.0.1:1234/codex/v1",
            "https://api.x.ai/v1",
        ] {
            if foreign == primary.base_url {
                continue;
            }
            helper.info.base_url = foreign.into();
            models.insert(key.clone(), helper.clone());
            let resolved = subscription_aux_sampling_config(&primary, Some(&key), &models);
            assert_eq!(
                serde_json::to_value(resolved).unwrap(),
                serde_json::to_value(&primary).unwrap()
            );
        }
    }
}

#[test]
fn subscription_aux_affinity_keeps_callback_identity_and_blocks_pre_resolved_native_image() {
    #[derive(Debug)]
    struct Resolver;
    impl xai_grok_sampler::BearerResolver for Resolver {
        fn current_bearer(&self) -> Option<String> {
            Some("test-process-transport".into())
        }
    }
    let mut primary = selected("codex");
    primary.bearer_resolver = Some(Arc::new(Resolver));
    let resolved = subscription_aux_sampling_config(&primary, None, &IndexMap::new());
    assert!(Arc::ptr_eq(
        primary.bearer_resolver.as_ref().unwrap(),
        resolved.bearer_resolver.as_ref().unwrap()
    ));
    let (model, config) = finalize_image_describe_sampler_config(
        Some(SamplerConfig::default()),
        &primary,
        None,
        None,
    );
    assert_eq!(model, primary.model);
    assert_eq!(config.base_url, primary.base_url);
    assert_eq!(config.api_key, primary.api_key);
}

#[test]
#[serial]
fn native_aux_affinity_keeps_original_grok_default_and_credential_resolution() {
    let _api = EnvGuard::unset(XAI_API_KEY_ENV_VAR);
    let _legacy = EnvGuard::unset(LEGACY_XAI_API_KEY_ENV_VAR);
    let primary = SamplerConfig::default();
    assert!(!is_subscription_sampling(&primary));
    let resolved = resolve_aux_model_sampling_config(
        &primary,
        crate::models::default_session_summary_model(),
        &IndexMap::new(),
        &EndpointsConfig::default(),
        Some("test-native-session"),
        false,
        None,
        None,
    )
    .unwrap();
    assert_eq!(
        resolved.model,
        crate::models::default_session_summary_model()
    );
    assert_eq!(resolved.api_key.as_deref(), Some("test-native-session"));
    assert!(!is_subscription_sampling(&resolved));
}
