//! Deterministic consent protocol / local transport tests. No external services.
use super::*;
use crate::implementations::grok_build::{
    ask_user_question::types::{QuestionAnnotation, UserQuestionError, UserQuestionResult},
    image_edit::{ImageEditInput, ImageEditTool},
    image_gen::{ImageGenClient, ImageGenConfig, ImageGenInput, ImageGenTool},
    video_gen::{
        ImageToVideoInput, ImageToVideoTool, ReferenceToVideoInput, ReferenceToVideoTool,
        VideoGenClient, VideoGenConfig, VideoOutcome,
    },
    web_search::{WebSearchInput, WebSearchTool},
};
use crate::implementations::web_search::{client::WebSearchClient, types::WebSearchConfig};
use crate::types::tool_metadata::test_ctx_with_call_id;
use indexmap::IndexMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::sync::mpsc;
use wiremock::{
    Mock, MockServer, ResponseTemplate,
    matchers::{method, path},
};

fn fixture() -> (
    NativeServiceConsent,
    SharedResources,
    mpsc::UnboundedReceiver<UserQuestionRequest>,
) {
    let policy = NativeServiceConsent::new(Some("codex"));
    let (tx, rx) = mpsc::unbounded_channel();
    let mut resources = Resources::new();
    resources.insert(policy.clone());
    resources.insert(UserQuestionSender(tx));
    (policy, resources.into_shared(), rx)
}

fn answer(request: &UserQuestionRequest, label: &str) -> UserQuestionResponse {
    UserQuestionResponse::Accepted {
        answers: IndexMap::from([(request.questions[0].question.clone(), vec![label.into()])]),
        annotations: None,
    }
}

fn allow(request: UserQuestionRequest) {
    let response = answer(&request, ALLOW);
    request.result_tx.send(Ok(response)).unwrap();
}

fn headers(key: &'static str) -> HeaderMap {
    let mut headers = HeaderMap::new();
    headers.insert(AUTHORIZATION, HeaderValue::from_static(key));
    headers
}

#[derive(Default)]
struct RotatingProvider {
    key: Mutex<Option<String>>,
    reads: AtomicUsize,
}
impl RotatingProvider {
    fn set(&self, value: Option<&str>) {
        *self.key.lock() = value.map(str::to_owned);
    }
}
impl crate::types::ApiKeyProvider for RotatingProvider {
    fn current_api_key(&self) -> Option<String> {
        self.reads.fetch_add(1, Ordering::SeqCst);
        self.key.lock().clone()
    }
}

fn search_client(
    server: &MockServer,
    provider: Option<SharedApiKeyProvider>,
    extra: IndexMap<String, String>,
) -> WebSearchClient {
    search_client_at(server.uri(), provider, extra)
}

fn search_client_at(
    base_url: String,
    provider: Option<SharedApiKeyProvider>,
    extra: IndexMap<String, String>,
) -> WebSearchClient {
    WebSearchClient::new(
        &WebSearchConfig::Enabled {
            api_key: "static-secret".into(),
            base_url,
            model: "search-model".into(),
            extra_headers: extra,
            alpha_test_key: None,
            allowed_domains: None,
            excluded_domains: None,
        },
        provider,
    )
    .unwrap()
}

async fn mount_search(server: &MockServer) {
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(200).set_body_json(serde_json::json!({
            "id": "resp_test", "object": "response", "created_at": 1234567890,
            "status": "completed", "model": "search-model", "output": [{
                "type": "message", "id": "msg_1", "status": "completed", "role": "assistant",
                "content": [{"type": "output_text", "text": "result", "annotations": [{
                    "type": "url_citation", "url": "https://example.org", "title": "Example",
                    "start_index": 0, "end_index": 6
                }]}]
            }]
        })))
        .mount(server)
        .await;
}

async fn search(
    client: &WebSearchClient,
    ctx: &ToolCallContext,
    titles: bool,
) -> Result<String, ToolError> {
    if titles {
        client
            .search_with_titles_with_context(ctx, "q", None)
            .await
            .map(|(text, pairs)| {
                assert_eq!(
                    pairs,
                    vec![("Example".into(), "https://example.org".into())]
                );
                text
            })
    } else {
        client
            .search_with_context(ctx, "q", None)
            .await
            .map(|(text, urls)| {
                assert_eq!(urls, vec!["https://example.org"]);
                text
            })
    }
}

#[test]
fn selection_is_shared_ephemeral_and_same_label_invalidates() {
    let native = NativeServiceConsent::default();
    assert_eq!(native.selected_provider(), None);
    let policy = NativeServiceConsent::new(Some("cursor"));
    let clone = policy.clone();
    let changed = policy.0.lock().changed.clone();
    clone.set_provider(Some("cursor"));
    assert!(changed.is_cancelled());
    assert_eq!(policy.0.lock().generation, 1);
    clone.set_provider(None);
    assert_eq!(policy.selected_provider(), None);
    let mut resources = Resources::new();
    resources.insert(policy);
    assert_eq!(resources.serialize(), serde_json::json!({}));
}

#[test]
fn subscription_accessor_uses_the_captured_route() {
    let policy = NativeServiceConsent::new(Some("codex"));
    let mut resources = Resources::new();
    resources.insert(policy.clone());
    let ctx = ToolCallContext::default();
    let subscription = NativeServiceCall::from_resources(&ctx, &resources);
    policy.set_provider(None);
    let native = NativeServiceCall::from_resources(&ctx, &resources);
    assert!(subscription.is_subscription());
    assert!(!native.is_subscription());
    policy.set_provider(Some("cursor"));
    assert!(!native.is_subscription());
    assert!(NativeServiceCall::from_resources(&ctx, &resources).is_subscription());
}

#[tokio::test]
async fn only_exact_affirmative_accepted_selection_is_consent() {
    for case in 0..11 {
        let (policy, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources, "exact-answer");
        let call = NativeServiceCall::from_context(&ctx).await;
        let defaults = headers("Bearer secret");
        let (result, ()) = tokio::join!(
            call.authorize(NativeService::WebSearch, "base", "model", &defaults, None),
            async {
                let request = rx.recv().await.unwrap();
                let mut response: UserQuestionResult = Ok(answer(&request, DENY));
                match case {
                    0 => {}
                    1 => response = Ok(UserQuestionResponse::Cancelled),
                    2 => {
                        response = Ok(UserQuestionResponse::SkipInterview {
                            questions: request.questions.clone(),
                            partial_answers: Default::default(),
                        })
                    }
                    3 => {
                        response = Ok(UserQuestionResponse::ChatAboutThis {
                            questions: request.questions.clone(),
                            partial_answers: Default::default(),
                        })
                    }
                    4 => {
                        response = Err(UserQuestionError::TransportError(
                            "secret transport details".into(),
                        ))
                    }
                    5 => {
                        response = Err(UserQuestionError::MalformedResponse(
                            "secret malformed body".into(),
                        ))
                    }
                    6 => {
                        response = Ok(UserQuestionResponse::Accepted {
                            answers: IndexMap::new(),
                            annotations: None,
                        })
                    }
                    7 => {
                        response = Ok(UserQuestionResponse::Accepted {
                            answers: IndexMap::from([(
                                "wrong question".into(),
                                vec![ALLOW.into()],
                            )]),
                            annotations: None,
                        })
                    }
                    8 => {
                        response = Ok(UserQuestionResponse::Accepted {
                            answers: IndexMap::from([(
                                request.questions[0].question.clone(),
                                vec![ALLOW.into(), DENY.into()],
                            )]),
                            annotations: None,
                        })
                    }
                    9 => response = Ok(answer(&request, "allow native xAI service")),
                    10 => {
                        response = Ok(UserQuestionResponse::Accepted {
                            answers: IndexMap::from([(
                                request.questions[0].question.clone(),
                                vec![ALLOW.into()],
                            )]),
                            annotations: Some(std::collections::HashMap::from([(
                                request.questions[0].question.clone(),
                                QuestionAnnotation {
                                    preview: None,
                                    notes: Some("do not bill me".into()),
                                },
                            )])),
                        })
                    }
                    _ => unreachable!(),
                }
                request.result_tx.send(response).unwrap();
            }
        );
        assert!(result.is_err(), "case {case}");
        assert!(!result.err().unwrap().to_string().contains("secret"));
        assert!(policy.0.lock().approvals.is_empty());
    }
}

#[tokio::test]
async fn both_search_paths_send_zero_http_until_explicit_allow_and_cache_exact_identity() {
    for titles in [false, true] {
        let server = MockServer::start().await;
        mount_search(&server).await;
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources.clone(), "search-allow");
        let client = search_client(&server, None, IndexMap::new());
        let (result, ()) = tokio::join!(search(&client, &ctx, titles), async {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.tool_call_id, "search-allow");
            // The question coordinator may itself access session resources.
            // Consent must not hold that lock while waiting for its reply.
            assert!(
                resources
                    .lock()
                    .await
                    .get::<NativeServiceConsent>()
                    .is_some()
            );
            assert!(
                request.questions[0]
                    .question
                    .contains("outside ChatGPT/Cursor subscription billing")
            );
            assert_eq!(request.questions[0].options[0].label, DENY);
            assert!(!format!("{request:?}").contains("static-secret"));
            assert!(request.questions[0].question.contains(&format!(
                "Endpoint origin: {}. Model: search-model. Opaque target #1",
                server.uri()
            )));
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(request);
        });
        assert_eq!(result.unwrap(), "result");
        assert_eq!(search(&client, &ctx, !titles).await.unwrap(), "result");
        assert!(
            rx.try_recv().is_err(),
            "cache must cover both representations of the same service"
        );
        let sent = server.received_requests().await.unwrap();
        assert_eq!(sent.len(), 2);
        assert_eq!(
            sent[0].headers.get(AUTHORIZATION).unwrap(),
            "Bearer static-secret"
        );
    }
}

#[tokio::test]
async fn context_aware_search_cancels_while_response_body_is_held_after_headers() {
    use std::task::{Context, Wake, Waker};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpListener;
    use tokio::sync::Notify;

    struct ResponseWake(Notify);
    impl Wake for ResponseWake {
        fn wake(self: Arc<Self>) {
            self.0.notify_one();
        }
        fn wake_by_ref(self: &Arc<Self>) {
            self.0.notify_one();
        }
    }

    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let client = search_client_at(
        format!("http://{}", listener.local_addr().unwrap()),
        None,
        IndexMap::new(),
    );
    let (_, resources, mut rx) = fixture();
    let cancellation = CancellationToken::new();
    let mut ctx = test_ctx_with_call_id(resources, "cancel-response-body");
    ctx.insert(xai_tool_runtime::Cancellation(cancellation.clone()));
    let (request_received_tx, request_received_rx) = oneshot::channel();
    let (send_headers_tx, send_headers_rx) = oneshot::channel();
    let (release_body_tx, release_body_rx) = oneshot::channel();
    let server = async {
        let (mut socket, _) = listener.accept().await.unwrap();
        let mut input = Vec::new();
        let mut buffer = [0u8; 4096];
        let header_end = loop {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            input.extend_from_slice(&buffer[..read]);
            if let Some(end) = input.windows(4).position(|bytes| bytes == b"\r\n\r\n") {
                break end + 4;
            }
            assert!(input.len() < 64 * 1024);
        };
        let headers = std::str::from_utf8(&input[..header_end]).unwrap();
        assert!(headers.starts_with("POST /responses HTTP/1.1\r\n"));
        let length = headers
            .lines()
            .find_map(|line| {
                let (name, value) = line.split_once(':')?;
                name.eq_ignore_ascii_case("content-length")
                    .then(|| value.trim().parse::<usize>().unwrap())
            })
            .expect("JSON request has a content length");
        while input.len() < header_end + length {
            let read = socket.read(&mut buffer).await.unwrap();
            assert!(read > 0);
            input.extend_from_slice(&buffer[..read]);
        }
        request_received_tx.send(()).unwrap();
        send_headers_rx.await.unwrap();
        socket
            .write_all(concat!(
                "HTTP/1.1 200 OK\r\n",
                "Content-Type: application/json\r\n",
                "Content-Length: 2\r\nConnection: close\r\n\r\n{"
            ).as_bytes())
            .await
            .unwrap();
        // Headers and one body byte are available, but body completion is held
        // until AFTER the caller's bounded cancellation result is captured.
        release_body_rx.await.unwrap();
        let _ = socket.write_all(b"}").await;
    };
    let exercise = async {
        let mut pending = Box::pin(client.search_with_context(&ctx, "q", None));
        let request = tokio::select! {
            request = rx.recv() => request.unwrap(),
            _ = &mut pending => panic!("must wait for consent"),
        };
        allow(request);
        tokio::select! {
            received = request_received_rx => received.unwrap(),
            _ = &mut pending => panic!("must wait for response headers"),
        };
        // The server has drained the entire request. Register a fresh waker
        // while execute is awaiting headers, then release just those headers.
        // Their delivery wakes this future; polling it again reaches the body
        // wait before cancellation. No timing sleeps or spawned call races.
        let wake = Arc::new(ResponseWake(Notify::new()));
        let waker = Waker::from(wake.clone());
        assert!(
            pending.as_mut().poll(&mut Context::from_waker(&waker)).is_pending()
        );
        send_headers_tx.send(()).unwrap();
        wake.0.notified().await;
        assert!(
            pending.as_mut().poll(&mut Context::from_waker(&waker)).is_pending()
        );
        cancellation.cancel();
        let outcome = tokio::time::timeout(Duration::from_secs(5), pending.as_mut()).await;
        let body_still_held = !release_body_tx.is_closed();
        drop(pending);
        let _ = release_body_tx.send(());
        (outcome, body_still_held)
    };
    // Scoped futures: even a failed handshake drops the socket and the request.
    // On the expected regression failure, release/cleanup happens before assert.
    let ((), (outcome, body_still_held)) = tokio::time::timeout(Duration::from_secs(15), async {
        tokio::join!(server, exercise)
    })
    .await
    .expect("local response-body test and cleanup must finish within the bound");
    assert!(body_still_held);
    let error = outcome
        .expect("cancellation must finish without releasing the response body")
        .unwrap_err()
        .to_string();
    assert!(error.contains("tool call cancelled"), "{error}");
}

#[tokio::test]
async fn both_search_paths_deny_no_ui_closed_ui_and_headless_fail_before_http() {
    for titles in [false, true] {
        let server = MockServer::start().await;
        let client = search_client(&server, None, IndexMap::new());
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources.clone(), "deny-search");
        let (result, ()) = tokio::join!(search(&client, &ctx, titles), async {
            let request = rx.recv().await.unwrap();
            let response = answer(&request, DENY);
            request.result_tx.send(Ok(response)).unwrap();
        });
        assert!(result.is_err());
        resources.lock().await.insert(Params(AskUserQuestionParams {
            non_interactive: Some(true),
            ..Default::default()
        }));
        assert!(search(&client, &ctx, titles).await.is_err());
        assert!(rx.try_recv().is_err());
        resources
            .lock()
            .await
            .remove::<Params<AskUserQuestionParams>>();
        drop(rx);
        assert!(search(&client, &ctx, titles).await.is_err());
        resources.lock().await.remove::<UserQuestionSender>();
        assert!(search(&client, &ctx, titles).await.is_err());
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn native_and_missing_resource_contexts_keep_legacy_requests() {
    let server = MockServer::start().await;
    mount_search(&server).await;
    let client = search_client(&server, None, IndexMap::new());
    assert_eq!(
        search(&client, &ToolCallContext::default(), false)
            .await
            .unwrap(),
        "result"
    );
    let (_, resources, mut rx) = fixture();
    resources
        .lock()
        .await
        .insert(NativeServiceConsent::default());
    let ctx = test_ctx_with_call_id(resources, "native");
    assert_eq!(search(&client, &ctx, true).await.unwrap(), "result");
    assert!(rx.try_recv().is_err());
    assert_eq!(server.received_requests().await.unwrap().len(), 2);
}

#[tokio::test]
async fn rotation_while_prompt_open_requires_second_consent_before_http() {
    for titles in [false, true] {
        let server = MockServer::start().await;
        mount_search(&server).await;
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources, "rotating");
        let provider = Arc::new(RotatingProvider::default());
        provider.set(Some("first-secret"));
        let client = search_client(&server, Some(provider.clone()), IndexMap::new());
        let (result, ()) = tokio::join!(search(&client, &ctx, titles), async {
            let first = rx.recv().await.unwrap();
            assert!(first.questions[0].question.contains("credential #1"));
            provider.set(Some("second-secret"));
            allow(first);
            let second = rx.recv().await.unwrap();
            assert!(second.questions[0].question.contains("credential #2"));
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(second);
        });
        result.unwrap();
        let sent = server.received_requests().await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].headers.get(AUTHORIZATION).unwrap(),
            "Bearer second-secret"
        );
        assert_eq!(provider.reads.load(Ordering::SeqCst), 3);
    }
}

#[tokio::test]
async fn static_extra_header_fallback_and_dynamic_override_are_the_approved_snapshot() {
    for dynamic in [None, Some("dynamic-secret")] {
        let server = MockServer::start().await;
        mount_search(&server).await;
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources, "fallback");
        let provider = Arc::new(RotatingProvider::default());
        provider.set(dynamic);
        let client = search_client(
            &server,
            Some(provider.clone()),
            IndexMap::from([
                ("aUtHoRiZaTiOn".into(), "Bearer extra-secret".into()),
                ("x-api-key".into(), "gateway-secret".into()),
            ]),
        );
        let (result, ()) = tokio::join!(search(&client, &ctx, false), async {
            let request = rx.recv().await.unwrap();
            assert!(!format!("{request:?}").contains("secret"));
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(request);
        });
        result.unwrap();
        let sent = server.received_requests().await.unwrap();
        assert_eq!(
            sent[0]
                .headers
                .get(AUTHORIZATION)
                .unwrap()
                .to_str()
                .unwrap(),
            format!("Bearer {}", dynamic.unwrap_or("extra-secret"))
        );
        assert_eq!(sent[0].headers.get("x-api-key").unwrap(), "gateway-secret");
        assert_eq!(
            provider.reads.load(Ordering::SeqCst),
            2,
            "no post-approval credential lookup"
        );
    }
}

#[tokio::test]
async fn dispatch_does_not_look_up_credentials_a_third_time() {
    struct Scripted(AtomicUsize);
    impl crate::types::ApiKeyProvider for Scripted {
        fn current_api_key(&self) -> Option<String> {
            Some(
                if self.0.fetch_add(1, Ordering::SeqCst) < 2 {
                    "approved"
                } else {
                    "unapproved"
                }
                .into(),
            )
        }
    }
    let server = MockServer::start().await;
    mount_search(&server).await;
    let provider = Arc::new(Scripted(AtomicUsize::new(0)));
    let client = search_client(&server, Some(provider.clone()), IndexMap::new());
    let (_, resources, mut rx) = fixture();
    let ctx = test_ctx_with_call_id(resources, "snapshot");
    let (result, ()) = tokio::join!(search(&client, &ctx, false), async {
        allow(rx.recv().await.unwrap());
    });
    result.unwrap();
    assert_eq!(provider.0.load(Ordering::SeqCst), 2);
    assert_eq!(
        server.received_requests().await.unwrap()[0]
            .headers
            .get(AUTHORIZATION)
            .unwrap(),
        "Bearer approved"
    );
}

#[tokio::test]
async fn cancelled_changed_same_provider_or_dropped_call_cannot_accept_late_answers() {
    for change in 0..5 {
        let server = MockServer::start().await;
        let client = search_client(&server, None, IndexMap::new());
        let (policy, resources, mut rx) = fixture();
        let cancellation = CancellationToken::new();
        let mut ctx = test_ctx_with_call_id(resources, "cancelled");
        ctx.insert(xai_tool_runtime::Cancellation(cancellation.clone()));
        let mut pending = Box::pin(search(&client, &ctx, false));
        let request = tokio::select! {
            r = rx.recv() => r.unwrap(),
            _ = &mut pending => panic!("must wait for consent"),
        };
        match change {
            0 => cancellation.cancel(),
            1 => policy.set_provider(Some("cursor")),
            2 => policy.set_provider(Some("codex")),
            3 => policy.set_provider(None),
            4 => {}
            _ => unreachable!(),
        }
        if change != 4 {
            assert!(pending.as_mut().await.is_err());
        }
        drop(pending);
        let late = answer(&request, ALLOW);
        assert!(request.result_tx.send(Ok(late)).is_err());
        assert!(policy.0.lock().approvals.is_empty());
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test(start_paused = true)]
async fn timeout_is_fail_closed_and_no_detached_approval_writer_survives() {
    let (policy, resources, mut rx) = fixture();
    resources.lock().await.insert(Params(AskUserQuestionParams {
        timeout_secs: Some(1),
        timeout_enabled: Some(false),
        ..Default::default()
    }));
    let ctx = test_ctx_with_call_id(resources, "timeout");
    let call = NativeServiceCall::from_context(&ctx).await;
    let defaults = headers("Bearer secret");
    let mut pending =
        Box::pin(call.authorize(NativeService::WebSearch, "base", "model", &defaults, None));
    let request = tokio::select! {
        r = rx.recv() => r.unwrap(),
        _ = &mut pending => panic!("must wait for consent"),
    };
    tokio::time::advance(Duration::from_secs(2)).await;
    assert!(pending.await.is_err());
    assert!(request.result_tx.is_closed());
    assert!(policy.0.lock().approvals.is_empty());
}

#[tokio::test(start_paused = true)]
async fn ready_allow_after_deadline_is_denied_before_http_or_cache_write() {
    let server = MockServer::start().await;
    let client = search_client(&server, None, IndexMap::new());
    let (policy, resources, mut rx) = fixture();
    resources.lock().await.insert(Params(AskUserQuestionParams {
        timeout_secs: Some(1),
        ..Default::default()
    }));
    let ctx = test_ctx_with_call_id(resources, "expired-ready-allow");
    let mut pending = Box::pin(search(&client, &ctx, false));
    let request = tokio::select! {
        r = rx.recv() => r.unwrap(),
        _ = &mut pending => panic!("must wait for consent"),
    };
    // Keep the unspawned future unpolled: both the expired timer and the Allow
    // must be ready together on its next poll (timeout alone can accept Allow).
    tokio::time::advance(Duration::from_secs(2)).await;
    allow(request);
    let error = pending.await.unwrap_err().to_string();
    assert!(error.contains("approval timed out"));
    assert!(policy.0.lock().approvals.is_empty());
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test(start_paused = true)]
async fn timely_allow_cannot_be_cached_after_slow_credential_revalidation() {
    struct SlowRevalidation(AtomicUsize);
    impl crate::types::ApiKeyProvider for SlowRevalidation {
        fn current_api_key(&self) -> Option<String> {
            Some("unchanged-key".into())
        }

        fn current_api_key_async(
            &self,
        ) -> std::pin::Pin<Box<dyn Future<Output = Option<String>> + Send + '_>> {
            Box::pin(async {
                if self.0.fetch_add(1, Ordering::SeqCst) > 0 {
                    tokio::time::sleep(Duration::from_secs(2)).await;
                }
                self.current_api_key()
            })
        }
    }
    let (policy, resources, mut rx) = fixture();
    resources.lock().await.insert(Params(AskUserQuestionParams {
        timeout_secs: Some(1),
        ..Default::default()
    }));
    let ctx = test_ctx_with_call_id(resources, "slow-revalidation");
    let call = NativeServiceCall::from_context(&ctx).await;
    let provider: SharedApiKeyProvider = Arc::new(SlowRevalidation(AtomicUsize::new(0)));
    let defaults = HeaderMap::new();
    let (result, ()) = tokio::join!(
        call.authorize(
            NativeService::WebSearch,
            "https://api.example.test",
            "model",
            &defaults,
            Some(&provider)
        ),
        async { allow(rx.recv().await.unwrap()) }
    );
    assert!(
        result.err().unwrap().to_string().contains("approval timed out")
    );
    assert!(policy.0.lock().approvals.is_empty());
}

#[tokio::test]
async fn parallel_calls_route_out_of_order_allow_and_deny_to_their_own_ids() {
    let server = MockServer::start().await;
    mount_search(&server).await;
    let client = search_client(&server, None, IndexMap::new());
    let (_, resources, mut rx) = fixture();
    let first_ctx = test_ctx_with_call_id(resources.clone(), "parallel-one");
    let second_ctx = test_ctx_with_call_id(resources, "parallel-two");
    let (first, second, allowed_id) = tokio::join!(
        search(&client, &first_ctx, false),
        search(&client, &second_ctx, true),
        async {
            let first = rx.recv().await.unwrap();
            let second = rx.recv().await.unwrap();
            let mut ids = vec![first.tool_call_id.clone(), second.tool_call_id.clone()];
            ids.sort();
            assert_eq!(ids, ["parallel-one", "parallel-two"]);
            assert!(server.received_requests().await.unwrap().is_empty());
            let allowed_id = second.tool_call_id.clone();
            allow(second);
            let deny = answer(&first, DENY);
            first.result_tx.send(Ok(deny)).unwrap();
            allowed_id
        }
    );
    assert_eq!(first.is_ok(), allowed_id == "parallel-one");
    assert_eq!(second.is_ok(), allowed_id == "parallel-two");
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn cached_consent_is_bound_to_service_base_model_and_all_header_bytes() {
    let (policy, resources, mut rx) = fixture();
    let ctx = test_ctx_with_call_id(resources.clone(), "scope");
    let call = NativeServiceCall::from_context(&ctx).await;
    let mut extra = headers("Bearer same");
    extra.insert("x-extra-auth", HeaderValue::from_static("extra-secret"));
    for (service, base, model, defaults) in [
        (
            NativeService::WebSearch,
            "https://user:secret@host/?secret",
            "model",
            headers("Bearer same"),
        ),
        (
            NativeService::ImageGeneration,
            "https://user:secret@host/?secret",
            "model",
            headers("Bearer same"),
        ),
        (
            NativeService::WebSearch,
            "different-base",
            "model",
            headers("Bearer same"),
        ),
        (
            NativeService::WebSearch,
            "different-base",
            "different-model",
            headers("Bearer same"),
        ),
        (
            NativeService::WebSearch,
            "different-base",
            "different-model",
            extra,
        ),
    ] {
        let (result, ()) = tokio::join!(
            call.authorize(service, base, model, &defaults, None),
            async {
                let request = rx.recv().await.unwrap();
                assert!(!format!("{request:?}").contains("secret"));
                allow(request);
            }
        );
        assert!(result.is_ok());
        assert!(
            call.authorize(service, base, model, &defaults, None)
                .await
                .is_ok()
        );
        assert!(rx.try_recv().is_err());
    }
    assert_eq!(policy.0.lock().approvals.len(), 5);
    assert_eq!(resources.lock().await.serialize(), serde_json::json!({}));
    policy.set_provider(Some("codex"));
    let state = policy.0.lock();
    assert!(state.approvals.is_empty());
    assert!(state.credentials.is_empty());
    assert!(state.targets.is_empty());
}

#[tokio::test]
async fn questions_distinguish_private_targets_without_disclosing_secrets() {
    let (policy, resources, mut rx) = fixture();
    let ctx = test_ctx_with_call_id(resources, "visible-scope");
    let call = NativeServiceCall::from_context(&ctx).await;
    let mut defaults = headers("Bearer bearer-secret");
    defaults.insert("x-gateway-key", HeaderValue::from_static("gateway-secret"));
    defaults.insert(
        "x-custom-auth",
        HeaderValue::from_static("bEaReR custom-secret"),
    );
    const FIRST: &str =
        "https://url-user:url-password@api.example.test:8443/private-one?key=query-secret#fragment-secret";
    const SECOND: &str =
        "https://url-user:url-password@api.example.test:8443/private-two?key=query-secret#fragment-secret";
    const OTHER_ORIGIN: &str =
        "https://url-user:url-password@other.example.test:8443/private-one?key=query-secret#fragment-secret";
    const SECRET_MODEL: &str = "https://model-user:model-password@model.example.test/private-model?key=model-query#model-fragment";
    let mut questions = Vec::new();
    for (base, model, target, safe_model) in [
        (FIRST, "grok-4.1", 1, "grok-4.1"),
        (SECOND, "grok-4.1", 2, "grok-4.1"),
        (SECOND, "grok-4.2", 3, "grok-4.2"),
        // Denial doesn't discard opaque identity: the same target stays #1.
        (FIRST, "grok-4.1", 1, "grok-4.1"),
        (OTHER_ORIGIN, "grok-4.1", 4, "grok-4.1"),
        (FIRST, SECRET_MODEL, 5, "[redacted]"),
        (FIRST, "grok-bearer-secret-model", 6, "[redacted]"),
        (FIRST, "grok-gateway-secret-model", 7, "[redacted]"),
        (FIRST, "grok-custom-secret-model", 8, "[redacted]"),
        (FIRST, "grok-\x1b[31munsafe", 9, "[redacted]"),
        (FIRST, "grok/image", 10, "[redacted]"),
        (FIRST, SECRET_MODEL, 5, "[redacted]"),
    ] {
        let (result, ()) = tokio::join!(
            call.authorize(NativeService::WebSearch, base, model, &defaults, None),
            async {
                let request = rx.recv().await.unwrap();
                let question = &request.questions[0];
                assert_eq!(question.options[0].label, DENY);
                assert_eq!(question.options[1].label, ALLOW);
                assert!(question.question.contains("credential #1"));
                assert!(question.question.contains(&format!(
                    "Model: {safe_model}. Opaque target #{target} "
                )));
                let host = if base == OTHER_ORIGIN { "other" } else { "api" };
                assert!(question.question.contains(&format!(
                    "Endpoint origin: https://{host}.example.test:8443."
                )));
                let rendered = format!("{request:?}");
                for hidden in [
                    "url-user",
                    "url-password",
                    "private-one",
                    "private-two",
                    "query-secret",
                    "fragment-secret",
                    "bearer-secret",
                    "gateway-secret",
                    "custom-secret",
                    "x-gateway-key",
                    "x-custom-auth",
                    "model-user",
                    "model-password",
                    "private-model",
                    "model-query",
                    "model-fragment",
                    "unsafe",
                    "grok/image",
                ] {
                    assert!(!rendered.contains(hidden), "leaked {hidden}");
                }
                questions.push(question.question.clone());
                let deny = answer(&request, DENY);
                request.result_tx.send(Ok(deny)).unwrap();
            }
        );
        assert!(result.is_err());
    }
    assert_ne!(questions[0], questions[1], "path-only changes must be visible");
    assert_ne!(questions[1], questions[2], "model changes must be visible");
    assert_eq!(questions[0], questions[3], "opaque target IDs must be stable");
    assert_ne!(questions[0], questions[4], "origins must be distinguishable");
    assert_ne!(questions[5], questions[6], "redacted models need distinct IDs");
    assert_eq!(questions[5], questions[11]);
    assert_eq!(policy.0.lock().targets.len(), 10);
    assert!(policy.0.lock().approvals.is_empty());
    policy.set_provider(Some("codex"));
    assert!(policy.0.lock().targets.is_empty());
    assert!(policy.0.lock().credentials.is_empty());
}

#[test]
fn target_labels_redact_invalid_origins_and_overridden_header_credentials() {
    let configured = headers("Bearer fallback-secret");
    let mut key = ApprovalKey {
        service: NativeService::WebSearch,
        base: "https://CURRENT-SECRET.example.test/private?hidden#fragment".into(),
        model: "grok-fallback-secret".into(),
        headers: headers("Bearer current-secret"),
    };
    assert_eq!(
        key.safe_labels(&configured),
        ("[redacted]".to_owned(), "[redacted]")
    );
    for base in ["not a URL", "file:///private", "mailto:private@example.test"] {
        key.base = base.into();
        assert_eq!(key.safe_labels(&configured).0, "[redacted]");
    }
    key.base = "https://user:password@[::1]:8443/private?hidden#fragment".into();
    for model in ["", "grok/model", "grok?key=private", "grok model", "模型"] {
        key.model = model.into();
        assert_eq!(
            key.safe_labels(&configured),
            ("https://[::1]:8443".to_owned(), "[redacted]")
        );
    }
    key.model = "m".repeat(129);
    assert_eq!(key.safe_labels(&configured).1, "[redacted]");
    key.model = "grok-4.1_fast".into();
    assert_eq!(key.safe_labels(&configured).1, "grok-4.1_fast");
}

fn image_client(server: &MockServer) -> ImageGenClient {
    ImageGenClient::new(
        &ImageGenConfig::Enabled {
            api_key: "static-secret".into(),
            base_url: server.uri(),
            extra_headers: IndexMap::new(),
            image_gen_enabled: true,
            image_edit_enabled: true,
            model_override: None,
            edit_model_override: None,
            tier_restricted: false,
        },
        None,
    )
    .unwrap()
    .with_session_id("session-media")
}

#[tokio::test]
async fn all_image_and_search_tool_wrappers_pass_call_context_and_image_edit_is_separate() {
    let server = MockServer::start().await;
    mount_search(&server).await;
    for endpoint in ["/images/generations", "/images/edits"] {
        Mock::given(method("POST"))
            .and(path(endpoint))
            .respond_with(
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [{"b64_json": "aW1hZ2U="}]})),
            )
            .mount(&server)
            .await;
    }
    let (_, resources, mut rx) = fixture();
    let folder = tempfile::tempdir().unwrap();
    resources
        .lock()
        .await
        .insert(crate::types::resources::SessionFolder(
            folder.path().to_owned(),
        ));
    resources.lock().await.insert(image_client(&server));
    resources
        .lock()
        .await
        .insert(search_client(&server, None, IndexMap::new()));
    let image_ctx = test_ctx_with_call_id(resources.clone(), "image-tool");
    let (result, ()) = tokio::join!(
        xai_tool_runtime::Tool::run(
            &ImageGenTool,
            image_ctx,
            ImageGenInput {
                prompt: "image".into(),
                aspect_ratio: "auto".into()
            }
        ),
        async {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.tool_call_id, "image-tool");
            assert!(
                request.questions[0]
                    .question
                    .contains("Imagine image generation")
            );
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(request);
        }
    );
    result.unwrap();
    let edit_ctx = test_ctx_with_call_id(resources.clone(), "edit-tool");
    let (result, ()) = tokio::join!(
        xai_tool_runtime::Tool::run(&ImageEditTool, edit_ctx, ImageEditInput {
            prompt: "edit".into(), aspect_ratio: "auto".into(), image: vec![
                "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=".into()
            ],
        }),
        async {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.tool_call_id, "edit-tool");
            assert!(request.questions[0].question.contains("Imagine image editing"));
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
            allow(request);
        }
    );
    result.unwrap();
    let search_ctx = test_ctx_with_call_id(resources, "search-tool");
    let (result, ()) = tokio::join!(
        xai_tool_runtime::Tool::run(
            &WebSearchTool,
            search_ctx,
            WebSearchInput {
                query: "q".into(),
                allowed_domains: None
            }
        ),
        async {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.tool_call_id, "search-tool");
            assert_eq!(server.received_requests().await.unwrap().len(), 2);
            allow(request);
        }
    );
    result.unwrap();
    let sent = server.received_requests().await.unwrap();
    assert_eq!(sent.len(), 3);
    for request in &sent[..2] {
        assert_eq!(
            request.headers.get(AUTHORIZATION).unwrap(),
            "Bearer static-secret"
        );
        assert_eq!(
            request.headers.get("x-grok-session-id").unwrap(),
            "session-media"
        );
    }
}

fn video_client(server: &MockServer, provider: Option<SharedApiKeyProvider>) -> VideoGenClient {
    VideoGenClient::new(
        &VideoGenConfig::Enabled {
            api_key: "static-secret".into(),
            base_url: server.uri(),
            extra_headers: IndexMap::new(),
            zdr_video_output_s3: None,
            tier_restricted: false,
            zdr_restricted: false,
        },
        provider,
    )
    .unwrap()
    .with_session_id("session-media")
}

async fn video(client: &VideoGenClient, ctx: &ToolCallContext) -> Result<VideoOutcome, ToolError> {
    client
        .generate_with_images_with_context(
            ctx,
            "video-model",
            "prompt",
            Some(6),
            None,
            "480p",
            None,
            Vec::new(),
            Vec::new(),
        )
        .await
}

#[tokio::test]
async fn media_rotation_to_none_requires_consent_for_extra_header_fallback() {
    for image in [false, true] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(if image {
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"data": [{"b64_json": "aW1hZ2U="}]}))
            } else {
                ResponseTemplate::new(400)
            })
            .mount(&server)
            .await;
        let provider = Arc::new(RotatingProvider::default());
        provider.set(Some("dynamic-first"));
        let extra = IndexMap::from([
            ("authorization".into(), "Bearer extra-fallback".into()),
            ("x-grok-session-id".into(), "caller-session".into()),
        ]);
        let image_client = ImageGenClient::new(
            &ImageGenConfig::Enabled {
                api_key: "static".into(),
                base_url: server.uri(),
                extra_headers: extra.clone(),
                image_gen_enabled: true,
                image_edit_enabled: true,
                model_override: None,
                edit_model_override: None,
                tier_restricted: false,
            },
            Some(provider.clone()),
        )
        .unwrap()
        .with_session_id("must-not-override");
        let video_client = VideoGenClient::new(
            &VideoGenConfig::Enabled {
                api_key: "static".into(),
                base_url: server.uri(),
                extra_headers: extra,
                zdr_video_output_s3: None,
                tier_restricted: false,
                zdr_restricted: false,
            },
            Some(provider.clone()),
        )
        .unwrap()
        .with_session_id("must-not-override");
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources, "media-fallback");
        let run = async {
            if image {
                image_client
                    .generate_with_context(&ctx, "image", "auto")
                    .await
                    .map(|_| ())
            } else {
                video(&video_client, &ctx).await.map(|_| ())
            }
        };
        let (result, ()) = tokio::join!(run, async {
            let first = rx.recv().await.unwrap();
            provider.set(None);
            allow(first);
            let second = rx.recv().await.unwrap();
            assert!(second.questions[0].question.contains("credential #2"));
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(second);
        });
        assert_eq!(result.is_ok(), image);
        let sent = server.received_requests().await.unwrap();
        assert_eq!(sent.len(), 1);
        assert_eq!(
            sent[0].headers.get(AUTHORIZATION).unwrap(),
            "Bearer extra-fallback"
        );
        assert_eq!(
            sent[0].headers.get("x-grok-session-id").unwrap(),
            "caller-session"
        );
        assert_eq!(provider.reads.load(Ordering::SeqCst), 3);
    }
}

#[tokio::test]
async fn media_clients_deny_without_ui_before_http() {
    let server = MockServer::start().await;
    let (_, resources, _rx) = fixture();
    resources.lock().await.remove::<UserQuestionSender>();
    let ctx = test_ctx_with_call_id(resources, "headless-media");
    assert!(
        image_client(&server)
            .generate_with_context(&ctx, "q", "auto")
            .await
            .is_err()
    );
    assert!(video(&video_client(&server, None), &ctx).await.is_err());
    assert!(server.received_requests().await.unwrap().is_empty());
}

#[tokio::test]
async fn video_polls_require_fresh_consent_after_rotation_and_honor_deny_or_model_change() {
    // Actual poll interval is retained. No sleeps/time races in the test: the
    // responder rotates exactly at the start HTTP boundary; questions handshake.
    for decision in ["allow", "deny", "model-change", "cancel"] {
        let server = MockServer::start().await;
        let provider = Arc::new(RotatingProvider::default());
        provider.set(Some("start-secret"));
        let responder_provider = provider.clone();
        Mock::given(method("POST"))
            .and(path("/videos/generations"))
            .respond_with(move |_: &wiremock::Request| {
                responder_provider.set(Some("poll-secret"));
                ResponseTemplate::new(200)
                    .set_body_json(serde_json::json!({"request_id": "request-1"}))
            })
            .mount(&server)
            .await;
        Mock::given(method("GET")).and(path("/videos/request-1")).respond_with(
            ResponseTemplate::new(200).set_body_json(serde_json::json!({"status": "done", "video": {"url": format!("{}/download", server.uri())}}))
        ).mount(&server).await;
        Mock::given(method("GET"))
            .and(path("/download"))
            .respond_with(ResponseTemplate::new(200).set_body_bytes(b"video".to_vec()))
            .mount(&server)
            .await;
        let (policy, resources, mut rx) = fixture();
        let cancellation = CancellationToken::new();
        let mut ctx = test_ctx_with_call_id(resources, "video-poll");
        ctx.insert(xai_tool_runtime::Cancellation(cancellation.clone()));
        let client = video_client(&server, Some(provider));
        let (result, ()) = tokio::join!(video(&client, &ctx), async {
            let start = rx.recv().await.unwrap();
            assert_eq!(start.tool_call_id, "video-poll");
            assert!(start.questions[0].question.contains("video generation"));
            assert!(server.received_requests().await.unwrap().is_empty());
            allow(start);
            let poll = rx.recv().await.unwrap();
            assert_eq!(poll.tool_call_id, "video-poll");
            assert!(poll.questions[0].question.contains("credential #2"));
            assert_eq!(server.received_requests().await.unwrap().len(), 1);
            match decision {
                "allow" => allow(poll),
                "deny" => {
                    let deny = answer(&poll, DENY);
                    poll.result_tx.send(Ok(deny)).unwrap();
                }
                "model-change" => {
                    let late_allow = answer(&poll, ALLOW);
                    policy.set_provider(Some("codex"));
                    let _ = poll.result_tx.send(Ok(late_allow));
                }
                "cancel" => {
                    cancellation.cancel();
                }
                _ => unreachable!(),
            }
        });
        let sent = server.received_requests().await.unwrap();
        if decision == "allow" {
            assert!(matches!(result.unwrap(), VideoOutcome::Bytes(bytes) if bytes == b"video"));
            assert_eq!(sent.len(), 3);
            assert_eq!(
                sent[0].headers.get(AUTHORIZATION).unwrap(),
                "Bearer start-secret"
            );
            assert_eq!(
                sent[1].headers.get(AUTHORIZATION).unwrap(),
                "Bearer poll-secret"
            );
            assert_eq!(
                sent[1].headers.get("x-grok-session-id").unwrap(),
                "session-media"
            );
            assert!(sent[2].headers.get(AUTHORIZATION).is_none());
        } else {
            assert!(result.is_err());
            assert_eq!(sent.len(), 1, "no unapproved poll or download");
        }
    }
}

#[tokio::test]
async fn subscription_redirect_is_not_an_unguarded_second_request() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(
            ResponseTemplate::new(307)
                .insert_header("Location", format!("{}/different-target", server.uri())),
        )
        .mount(&server)
        .await;
    let (_, resources, mut rx) = fixture();
    let ctx = test_ctx_with_call_id(resources, "redirect");
    let client = search_client(&server, None, IndexMap::new());
    let (result, ()) = tokio::join!(search(&client, &ctx, false), async {
        allow(rx.recv().await.unwrap());
    });
    assert!(result.is_err());
    assert_eq!(server.received_requests().await.unwrap().len(), 1);
}

#[tokio::test]
async fn final_dispatch_rechecks_generation_and_cancellation_after_approval() {
    for cancel in [false, true] {
        let server = MockServer::start().await;
        let (policy, resources, mut rx) = fixture();
        let mut ctx = test_ctx_with_call_id(resources, "dispatch-check");
        let cancellation = CancellationToken::new();
        ctx.insert(xai_tool_runtime::Cancellation(cancellation.clone()));
        let call = NativeServiceCall::from_context(&ctx).await;
        let defaults = headers("Bearer approved");
        let (approved, ()) = tokio::join!(
            call.authorize(
                NativeService::WebSearch,
                "configured-base",
                "model",
                &defaults,
                None
            ),
            async {
                allow(rx.recv().await.unwrap());
            }
        );
        let approved = approved.unwrap();
        if cancel {
            cancellation.cancel();
        } else {
            policy.set_provider(Some("codex"));
        }
        let guarded = guarded_http_client("dispatch-test", |b| b).unwrap();
        assert!(
            call.send(
                reqwest::Client::new().post(server.uri()),
                &approved,
                &guarded
            )
            .await
            .is_err()
        );
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn video_tool_wrappers_pass_their_distinct_call_ids_before_http() {
    for reference in [false, true] {
        let server = MockServer::start().await;
        let (_, resources, mut rx) = fixture();
        let folder = tempfile::tempdir().unwrap();
        resources
            .lock()
            .await
            .insert(crate::types::resources::SessionFolder(
                folder.path().to_owned(),
            ));
        resources.lock().await.insert(video_client(&server, None));
        let ctx = test_ctx_with_call_id(
            resources,
            if reference {
                "reference-video"
            } else {
                "image-video"
            },
        );
        let run = async {
            if reference {
                xai_tool_runtime::Tool::run(
                    &ReferenceToVideoTool,
                    ctx,
                    ReferenceToVideoInput {
                        prompt: "hello".into(),
                        images: Vec::new(),
                        voices: vec!["eve".into()],
                        aspect_ratio: "16:9".into(),
                        duration: Some(6),
                        resolution_name: "480p".into(),
                    },
                )
                .await
            } else {
                xai_tool_runtime::Tool::run(
                    &ImageToVideoTool,
                    ctx,
                    ImageToVideoInput {
                        prompt: None,
                        image: "data:image/png;base64,aW1hZ2U=".into(),
                        duration: Some(6),
                        resolution_name: "480p".into(),
                    },
                )
                .await
            }
        };
        let (result, ()) = tokio::join!(run, async {
            let request = rx.recv().await.unwrap();
            assert_eq!(
                request.tool_call_id,
                if reference {
                    "reference-video"
                } else {
                    "image-video"
                }
            );
            assert!(server.received_requests().await.unwrap().is_empty());
            let response = answer(&request, DENY);
            request.result_tx.send(Ok(response)).unwrap();
        });
        assert!(result.is_err());
        assert!(server.received_requests().await.unwrap().is_empty());
    }
}

#[tokio::test]
async fn request_headers_preserve_request_over_default_auth_and_content_type() {
    let client = reqwest::Client::new();
    let request = client
        .post("https://alice:secret@example.org/responses")
        .json(&serde_json::json!({"model": "m"}));
    let mut defaults = headers("Bearer static");
    defaults.insert(
        reqwest::header::CONTENT_TYPE,
        HeaderValue::from_static("text/plain"),
    );
    let effective = NativeServiceCall::request_headers(&defaults, &request).unwrap();
    assert_eq!(
        effective.get(AUTHORIZATION).unwrap(),
        "Basic YWxpY2U6c2VjcmV0"
    );
    assert_eq!(
        effective.get(reqwest::header::CONTENT_TYPE).unwrap(),
        "application/json"
    );
    let approved = NativeServiceCall::native()
        .authorize(NativeService::WebSearch, "base", "m", &effective, None)
        .await
        .unwrap();
    assert!(approved.sent_bearer().is_none());
    assert_eq!(
        approved.headers_for_test().get(AUTHORIZATION).unwrap(),
        "Basic YWxpY2U6c2VjcmV0"
    );
}

#[tokio::test]
async fn tool_retry_reauthorizes_a_rotated_credential_before_second_http() {
    let server = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/responses"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&server)
        .await;
    let provider = Arc::new(RotatingProvider::default());
    provider.set(Some("first"));
    let client = search_client(&server, Some(provider.clone()), IndexMap::new());
    let (_, resources, mut rx) = fixture();
    let ctx = test_ctx_with_call_id(resources, "retry-id");
    for count in 0..2 {
        let (result, ()) = tokio::join!(search(&client, &ctx, false), async {
            let request = rx.recv().await.unwrap();
            assert_eq!(request.tool_call_id, "retry-id");
            assert_eq!(server.received_requests().await.unwrap().len(), count);
            allow(request);
        });
        assert!(result.is_err());
        provider.set(Some("second"));
    }
    let sent = server.received_requests().await.unwrap();
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0].headers.get(AUTHORIZATION).unwrap(), "Bearer first");
    assert_eq!(sent[1].headers.get(AUTHORIZATION).unwrap(), "Bearer second");
}

#[test]
fn config_debug_does_not_disclose_headers_keys_or_secret_urls() {
    let config = WebSearchConfig::Enabled {
        api_key: "hidden-secret".into(),
        base_url: "https://user:hidden-secret@host/".into(),
        model: "model".into(),
        extra_headers: IndexMap::from([("x-auth".into(), "hidden-secret".into())]),
        alpha_test_key: Some("hidden-secret".into()),
        allowed_domains: None,
        excluded_domains: None,
    };
    assert!(!format!("{config:?}").contains("hidden-secret"));
    let image = ImageGenConfig::Enabled {
        api_key: "hidden-secret".into(),
        base_url: "https://user:hidden-secret@host/".into(),
        extra_headers: IndexMap::from([("x-auth".into(), "hidden-secret".into())]),
        image_gen_enabled: true,
        image_edit_enabled: true,
        model_override: None,
        edit_model_override: None,
        tier_restricted: false,
    };
    assert!(!format!("{image:?}").contains("hidden-secret"));
    let video = VideoGenConfig::Enabled {
        api_key: "hidden-secret".into(),
        base_url: "https://user:hidden-secret@host/".into(),
        extra_headers: IndexMap::from([("x-auth".into(), "hidden-secret".into())]),
        zdr_video_output_s3: None,
        tier_restricted: false,
        zdr_restricted: false,
    };
    assert!(!format!("{video:?}").contains("hidden-secret"));
}

#[derive(Default, Debug)]
struct Attribution(Mutex<Vec<Option<String>>>);
impl crate::attribution::Auth401AttributionCallback for Attribution {
    fn record_401(&self, _: crate::attribution::ToolConsumer, suffix: Option<&str>) {
        self.0.lock().push(suffix.map(str::to_owned));
    }
}

#[tokio::test]
async fn unauthorized_uses_actual_sent_fallback_and_does_not_echo_secrets() {
    for titles in [false, true] {
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .and(path("/responses"))
            .respond_with(
                ResponseTemplate::new(401).set_body_string(
                    "Bearer actual-sent-12345678901 https://secret:password@host/",
                ),
            )
            .mount(&server)
            .await;
        let (_, resources, mut rx) = fixture();
        let ctx = test_ctx_with_call_id(resources, "attribution");
        let provider = Arc::new(RotatingProvider::default()); // dynamic None
        let callback = Arc::new(Attribution::default());
        let client = search_client(
            &server,
            Some(provider),
            IndexMap::from([(
                "authorization".into(),
                "Bearer actual-sent-12345678901".into(),
            )]),
        )
        .with_attribution_callback(Some(callback.clone()));
        let (result, ()) = tokio::join!(search(&client, &ctx, titles), async {
            allow(rx.recv().await.unwrap());
        });
        let error = result.unwrap_err().to_string();
        assert!(!error.contains("actual-sent"));
        assert!(!error.contains("password"));
        assert_eq!(*callback.0.lock(), vec![Some("12345678901".into())]);
        assert_eq!(
            server.received_requests().await.unwrap()[0]
                .headers
                .get(AUTHORIZATION)
                .unwrap(),
            "Bearer actual-sent-12345678901"
        );
    }
}
