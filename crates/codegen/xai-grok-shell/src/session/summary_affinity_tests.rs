//! Loopback-only inference regression. All credentials are test sentinels.
use super::*;
use crate::agent::config::{EndpointsConfig, resolve_aux_model_sampling_config};
use indexmap::IndexMap;
use xai_grok_sampler::{ApiBackend, SamplerConfig};
use xai_grok_test_support::EnvGuard;

async fn recv<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> T {
    tokio::time::timeout(std::time::Duration::from_secs(5), rx.recv())
        .await
        .unwrap()
        .unwrap()
}

fn title_client(
    origin: &str,
    provider: &str,
    model: &str,
    native: bool,
) -> (OaiCompatClient, String) {
    let primary = SamplerConfig {
        base_url: format!("{origin}/{provider}/v1"),
        model: model.into(),
        api_key: Some("test-process-transport".into()),
        api_backend: ApiBackend::ChatCompletions,
        max_retries: Some(0),
        ..Default::default()
    };
    let endpoints = EndpointsConfig {
        // A regression must hit the local trap, never a live native API.
        models_base_url: Some(format!("{origin}/native/v1")),
        cli_chat_proxy_base_url: Some(format!("{origin}/native/v1")),
        xai_api_base_url: format!("{origin}/native/v1"),
        deployment_key: native.then(|| "test-native-deployment".into()),
        ..Default::default()
    };
    let resolved = resolve_aux_model_sampling_config(
        &primary,
        crate::models::default_session_summary_model(),
        &IndexMap::new(),
        &endpoints,
        native.then_some("test-native-session"),
        false,
        None,
        None,
    )
    .unwrap_or(primary);
    let model = resolved.model.clone();
    (OaiCompatClient::new(resolved).unwrap(), model)
}

#[tokio::test]
#[serial_test::serial]
async fn subscription_first_title_and_post_switch_only_call_selected_route_and_model() {
    let _no_proxy = EnvGuard::set("NO_PROXY", "127.0.0.1");
    let _no_proxy_lower = EnvGuard::set("no_proxy", "127.0.0.1");
    let (requests_tx, mut requests_rx) = mpsc::unbounded_channel();
    let app = axum::Router::new().fallback(
        move |uri: axum::http::Uri, headers: axum::http::HeaderMap, axum::Json(body): axum::Json<serde_json::Value>| {
            let tx = requests_tx.clone();
            async move {
                tx.send((uri.path().to_owned(), headers, body)).unwrap();
                let chunk = serde_json::json!({
                    "id":"test", "object":"chat.completion.chunk", "created":0, "model":"test",
                    "choices":[{"index":0,"delta":{"role":"assistant","tool_calls":[{
                        "index":0,"id":"title-call","type":"function","function":{
                            "name":"session_title","arguments":"{\"session_title\":\"Selected provider title\"}"
                        }
                    }]},"finish_reason":"tool_calls"}]
                });
                ([("content-type", "text/event-stream")], format!("data: {chunk}\n\ndata: [DONE]\n\n"))
            }
        },
    );
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let server = tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
    for native in [false, true] {
        let _api = if native {
            EnvGuard::set("XAI_API_KEY", "test-native-api")
        } else {
            EnvGuard::unset("XAI_API_KEY")
        };
        let _legacy = EnvGuard::unset("GROK_API_KEY");
        let (tx, mut rx) = mpsc::unbounded_channel();
        let (client, model) = title_client(&origin, "codex", "selected-chatgpt", native);
        let mut generator = SummaryGenerator::new(SummaryConfig {
            sampling_client: client,
            model,
            persistence_tx: tx.downgrade(),
        });
        generator.update("Explain the parser".into());
        let (path, headers, body) = recv(&mut requests_rx).await;
        assert_eq!(path, "/codex/v1/chat/completions");
        assert_eq!(body["model"], "selected-chatgpt");
        assert_eq!(headers["authorization"], "Bearer test-process-transport");
        let PersistenceMsg::GeneratedTitle {
            generation: old, ..
        } = recv(&mut rx).await
        else {
            panic!("expected title")
        };
        // The old task has already enqueued its result. Switching must reject even this
        // completed result and retry the original first prompt with the new full client.
        let (client, model) = title_client(&origin, "cursor", "selected-composer", native);
        generator.refresh_sampling(client, model);
        assert!(!generator.accept_generated(old));
        let (path, headers, body) = recv(&mut requests_rx).await;
        assert_eq!(path, "/cursor/v1/chat/completions");
        assert_eq!(body["model"], "selected-composer");
        assert_eq!(headers["authorization"], "Bearer test-process-transport");
        let PersistenceMsg::GeneratedTitle { title, generation } = recv(&mut rx).await else {
            panic!("expected title")
        };
        assert_eq!(title, "Selected provider title");
        assert!(generator.accept_generated(generation));
        generator.reset();
        // Same-provider model switches must also replace the client/model pair.
        let (client, model) = title_client(&origin, "cursor", "selected-composer-next", native);
        generator.refresh_sampling(client, model);
        generator.update("Continue after switch".into());
        let (path, _, body) = recv(&mut requests_rx).await;
        assert_eq!(path, "/cursor/v1/chat/completions");
        assert_eq!(body["model"], "selected-composer-next");
        let PersistenceMsg::GeneratedTitle { generation, .. } = recv(&mut rx).await else {
            panic!("expected title")
        };
        assert!(generator.accept_generated(generation));
        assert!(
            requests_rx.try_recv().is_err(),
            "no extra/native fallback inference"
        );
    }
    server.abort();
}

#[test]
fn subscription_switch_before_first_content_and_reset_isolates_queued_results() {
    let (tx, _rx) = mpsc::unbounded_channel();
    let (client, model) = title_client("http://127.0.0.1:1234", "codex", "first-model", true);
    let mut generator = SummaryGenerator::new(SummaryConfig {
        sampling_client: client,
        model,
        persistence_tx: tx.downgrade(),
    });
    let old = generator.generation;
    let (client, model) = title_client("http://127.0.0.1:1234", "cursor", "second-model", true);
    generator.refresh_sampling(client, model);
    assert!(generator.is_idle());
    assert_eq!(generator.config.model, "second-model");
    assert!(!generator.accept_generated(old));
    let old = generator.generation;
    generator.reset();
    assert!(!generator.accept_generated(old));
}
