//! Session-local consent for native xAI services when chat uses subscription routing.
//!
//! Hosts must inject one shared instance into every Polycode session/rebuild path,
//! and call `set_provider` after each successful model configuration commit (even
//! within the same provider). An absent resource deliberately preserves native SDK
//! behavior. This resource is ephemeral: never serialize approvals or credentials.

use std::future::Future;
use std::sync::Arc;
use std::time::Duration;

use parking_lot::Mutex;
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use tokio::sync::oneshot;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use xai_tool_runtime::{ToolCallContext, ToolError};

use crate::implementations::grok_build::ask_user_question::{
    AskUserQuestionParams, Question, QuestionOption,
    types::{UserQuestionRequest, UserQuestionResponse, UserQuestionSender},
};
use crate::types::SharedApiKeyProvider;
use crate::types::resources::{Params, Resources, SharedResources};

/// Cloneable, shared, in-memory policy. `None` means native Grok; any `Some`
/// means a subscription chat route, not authorization to bill native services.
#[derive(Clone)]
pub struct NativeServiceConsent(Arc<Mutex<Selection>>);

struct Selection {
    provider: Option<&'static str>,
    generation: u64,
    changed: CancellationToken,
    approvals: Vec<ApprovalKey>,
    credentials: Vec<HeaderMap>,
    targets: Vec<ApprovalKey>,
}

impl NativeServiceConsent {
    pub fn new(provider: Option<&'static str>) -> Self {
        Self(Arc::new(Mutex::new(Selection {
            provider,
            generation: 0,
            changed: CancellationToken::new(),
            approvals: Vec::new(),
            credentials: Vec::new(),
            targets: Vec::new(),
        })))
    }

    /// Current explicitly selected route label; contains no credentials.
    pub fn selected_provider(&self) -> Option<&'static str> {
        self.0.lock().provider
    }

    /// Invalidates pending decisions and cached approvals, including same-label
    /// model changes. Existing call snapshots can never adopt the new route.
    pub fn set_provider(&self, provider: Option<&'static str>) {
        let mut state = self.0.lock();
        state.changed.cancel();
        state.changed = CancellationToken::new();
        state.generation = state
            .generation
            .checked_add(1)
            .expect("consent generation overflow");
        state.provider = provider;
        state.approvals.clear();
        state.credentials.clear();
        state.targets.clear();
    }
}

impl Default for NativeServiceConsent {
    fn default() -> Self {
        Self::new(None)
    }
}

impl std::fmt::Debug for NativeServiceConsent {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NativeServiceConsent")
            .finish_non_exhaustive()
    }
}

crate::register_resource!("grok_build", "NativeServiceConsent", NativeServiceConsent);

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum NativeService {
    WebSearch,
    ImageGeneration,
    ImageEdit,
    VideoGeneration,
}

impl NativeService {
    fn label(self) -> &'static str {
        match self {
            Self::WebSearch => "web search",
            Self::ImageGeneration => "Imagine image generation",
            Self::ImageEdit => "Imagine image editing",
            Self::VideoGeneration => "Imagine video generation (including status polls)",
        }
    }
}

// Exact comparisons, not a lossy fingerprint. Treat ALL configured headers as
// credential-bearing, including unknown gateway headers. No Debug implementation.
#[derive(Clone, PartialEq, Eq)]
struct ApprovalKey {
    service: NativeService,
    base: String,
    model: String,
    headers: HeaderMap,
}

impl ApprovalKey {
    /// Render only an HTTP(S) origin and a conservative plain model ID. The
    /// exact private target is represented separately by a session-local ID.
    fn safe_labels(&self, configured_headers: &HeaderMap) -> (String, &str) {
        let contains_credential = |label: &str| {
            [&self.headers, configured_headers].into_iter().any(|headers| {
                headers.values().any(|value| {
                    // All headers are potentially credentials. Check whitespace
                    // tokens too, so "Bearer token" also suppresses "token" in
                    // a model/origin; never expose a credential suffix or hash.
                    value
                        .as_bytes()
                        .split(u8::is_ascii_whitespace)
                        .filter(|part| !part.is_empty())
                        .any(|part| {
                            label
                                .as_bytes()
                                .windows(part.len())
                                .any(|window| window.eq_ignore_ascii_case(part))
                        })
                })
            })
        };
        let origin = url::Url::parse(&self.base)
            .ok()
            .filter(|url| matches!(url.scheme(), "http" | "https"))
            .map(|url| url.origin().ascii_serialization())
            .filter(|origin| !contains_credential(origin))
            .unwrap_or_else(|| "[redacted]".into());
        let plain_model = !self.model.is_empty()
            && self.model.len() <= 128
            && self.model.as_bytes()[0].is_ascii_alphanumeric()
            && self
                .model
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'));
        let model = if plain_model && !contains_credential(&self.model) {
            self.model.as_str()
        } else {
            "[redacted]"
        };
        (origin, model)
    }
}

pub(crate) struct ApprovedHeaders(HeaderMap);

impl ApprovedHeaders {
    #[cfg(test)]
    pub(crate) fn headers_for_test(&self) -> HeaderMap {
        self.0.clone()
    }

    /// Attribution must describe what was actually sent, including static and
    /// extra-header fallback. Never perform another provider lookup here.
    pub(crate) fn sent_bearer(&self) -> Option<&str> {
        let value = self.0.get(AUTHORIZATION)?.to_str().ok()?;
        let (scheme, bearer) = value.split_once(' ')?;
        scheme.eq_ignore_ascii_case("bearer").then_some(bearer)
    }
}

/// Immutable per-invocation context, never stored on shared HTTP clients.
/// Resources are cloned under the caller's lock, which is released before I/O.
pub(crate) struct NativeServiceCall {
    call_id: String,
    policy: NativeServiceConsent,
    generation: u64,
    subscription: bool,
    changed: CancellationToken,
    cancellation: CancellationToken,
    sender: Option<UserQuestionSender>,
    non_interactive: bool,
    timeout: Duration,
}

const ALLOW: &str = "Allow this native xAI service for this session scope";
const DENY: &str = "Deny native xAI service";
const CONSENT_TIMEOUT: Duration = Duration::from_secs(30 * 60);

fn denied(reason: &str) -> ToolError {
    ToolError::custom(
        "native_service_consent",
        format!(
            "Native xAI service request stopped: {reason}. ChatGPT/Cursor subscription billing does not cover this service. Already dispatched requests cannot be undone."
        ),
    )
}

fn check_approval_deadline(deadline: Instant) -> Result<(), ToolError> {
    if Instant::now() >= deadline {
        return Err(denied("approval timed out"));
    }
    Ok(())
}

impl NativeServiceCall {
    pub(crate) fn from_resources(ctx: &ToolCallContext, resources: &Resources) -> Self {
        let policy = resources
            .get::<NativeServiceConsent>()
            .cloned()
            .unwrap_or_default();
        let state = policy.0.lock();
        let params = resources.get::<Params<AskUserQuestionParams>>();
        Self {
            call_id: ctx.call_id.to_string(),
            policy: policy.clone(),
            generation: state.generation,
            subscription: state.provider.is_some(),
            changed: state.changed.clone(),
            cancellation: ctx
                .get::<xai_tool_runtime::Cancellation>()
                .map(|c| c.0.clone())
                .unwrap_or_default(),
            sender: resources.get::<UserQuestionSender>().cloned(),
            non_interactive: params.and_then(|p| p.non_interactive).unwrap_or(false),
            // Consent is always bounded, independently of ordinary question or
            // always-approve settings; no environment-based policy inference.
            timeout: params
                .and_then(|p| p.timeout_secs)
                .filter(|s| *s > 0)
                .map(Duration::from_secs)
                .unwrap_or(CONSENT_TIMEOUT)
                .min(CONSENT_TIMEOUT),
        }
    }

    pub(crate) async fn from_context(ctx: &ToolCallContext) -> Self {
        if let Some(resources) = ctx.get::<SharedResources>() {
            let res = resources.lock().await;
            Self::from_resources(ctx, &res)
        } else {
            Self::from_resources(ctx, &Resources::new())
        }
    }

    /// Compatibility path for standalone native SDK methods ONLY. Model-facing
    /// tools/adapters must use their context-aware variants instead.
    pub(crate) fn native() -> Self {
        Self::from_resources(&ToolCallContext::default(), &Resources::new())
    }

    /// Captured route only; in-flight calls never adopt a later selection.
    pub(crate) fn is_subscription(&self) -> bool {
        self.subscription
    }

    /// Mirror reqwest's request-over-default precedence before resolving the
    /// dynamic bearer. This also captures URL userinfo auth and JSON content type
    /// rather than changing legacy behavior when those override static defaults.
    pub(crate) fn request_headers(
        defaults: &HeaderMap,
        request: &reqwest::RequestBuilder,
    ) -> Result<HeaderMap, ToolError> {
        let request = request
            .try_clone()
            .ok_or_else(|| denied("request cannot be snapshotted"))?
            .build()
            .map_err(|_| denied("invalid service request"))?;
        let mut headers = defaults.clone();
        headers.extend(request.headers().clone());
        Ok(headers)
    }

    pub(crate) fn check_current(&self) -> Result<(), ToolError> {
        if self.cancellation.is_cancelled() {
            return Err(denied("tool call cancelled"));
        }
        if self.changed.is_cancelled() || self.policy.0.lock().generation != self.generation {
            return Err(denied("provider/model selection changed"));
        }
        Ok(())
    }

    pub(crate) async fn wait<T>(&self, future: impl Future<Output = T>) -> Result<T, ToolError> {
        self.check_current()?;
        tokio::select! {
            biased;
            _ = self.cancellation.cancelled() => Err(denied("tool call cancelled")),
            _ = self.changed.cancelled() => Err(denied("provider/model selection changed")),
            value = future => { self.check_current()?; Ok(value) }
        }
    }

    /// Resolve effective auth before asking; after an asynchronous answer resolve
    /// again. A changed identity requires a new question, never a detached cache
    /// writer. The returned snapshot is the only source of outbound headers.
    pub(crate) async fn authorize(
        &self,
        service: NativeService,
        base: &str,
        model: &str,
        defaults: &HeaderMap,
        provider: Option<&SharedApiKeyProvider>,
    ) -> Result<ApprovedHeaders, ToolError> {
        self.check_current()?;
        if self.subscription
            && (self.non_interactive || self.sender.as_ref().is_none_or(|s| s.0.is_closed()))
        {
            return Err(denied("explicit interactive approval is unavailable"));
        }
        let mut headers = self.resolve_headers(defaults, provider).await?;
        if !self.subscription {
            return Ok(ApprovedHeaders(headers));
        }
        loop {
            self.check_current()?;
            let key = ApprovalKey {
                service,
                base: base.to_owned(),
                model: model.to_owned(),
                headers: headers.clone(),
            };
            let (credential_label, target_label) = {
                let mut state = self.policy.0.lock();
                if state.generation != self.generation {
                    return Err(denied("provider/model selection changed"));
                }
                if state.approvals.contains(&key) {
                    return Ok(ApprovedHeaders(headers));
                }
                // Opaque, session-local labels only; no bearer fragments, raw
                // secret URLs, hashes, or inferred account identity in the UI.
                let existing = state.credentials.iter().position(|h| h == &headers);
                let index = existing.unwrap_or_else(|| {
                    state.credentials.push(headers.clone());
                    state.credentials.len() - 1
                });
                let target = state.targets.iter().position(|target| target == &key);
                let target = target.unwrap_or_else(|| {
                    state.targets.push(key.clone());
                    state.targets.len() - 1
                });
                (index + 1, target + 1)
            };
            let deadline = self
                .ask(&key, credential_label, target_label, defaults)
                .await?;
            let refreshed = self.resolve_headers(defaults, provider).await?;
            check_approval_deadline(deadline)?;
            if refreshed != headers {
                headers = refreshed;
                continue;
            }
            self.check_current()?;
            let mut state = self.policy.0.lock();
            if state.generation != self.generation || self.cancellation.is_cancelled() {
                return Err(denied("call or provider/model decision cancelled"));
            }
            // Re-resolution and lock acquisition may consume the remaining
            // approval window. Never cache an answer after its deadline.
            check_approval_deadline(deadline)?;
            if !state.approvals.contains(&key) {
                state.approvals.push(key);
            }
            return Ok(ApprovedHeaders(headers));
        }
    }

    async fn resolve_headers(
        &self,
        defaults: &HeaderMap,
        provider: Option<&SharedApiKeyProvider>,
    ) -> Result<HeaderMap, ToolError> {
        let mut headers = defaults.clone();
        if let Some(bearer) = self
            .wait(crate::types::api_key_provider::resolve_bearer(provider))
            .await?
        {
            let value = HeaderValue::from_str(&format!("Bearer {bearer}"))
                .map_err(|_| denied("invalid credential header"))?;
            headers.insert(AUTHORIZATION, value);
        }
        for value in headers.values_mut() {
            value.set_sensitive(true);
        }
        Ok(headers)
    }

    async fn ask(
        &self,
        key: &ApprovalKey,
        credential_label: usize,
        target_label: usize,
        configured_headers: &HeaderMap,
    ) -> Result<Instant, ToolError> {
        self.check_current()?;
        // Record before queueing, not when the receiver is next polled.
        let deadline = Instant::now() + self.timeout;
        let (origin, model) = key.safe_labels(configured_headers);
        let question = format!(
            "Allow native xAI {} outside ChatGPT/Cursor subscription billing? This may use native xAI quota or incur charges using configured credential #{credential_label}. Endpoint origin: {origin}. Model: {model}. Opaque target #{target_label} distinguishes the exact private endpoint/model/credential scope, including redacted parts. Approval is in-memory for this service's exact configured endpoint, model and credential only, until the provider/model selection changes.",
            key.service.label()
        );
        let (result_tx, result_rx) = oneshot::channel();
        let request = UserQuestionRequest {
            tool_call_id: self.call_id.clone(),
            questions: vec![Question {
                question: question.clone(),
                // Deny is the default/first option; ordinary always-approve is
                // never consulted and never grants native billing permission.
                options: vec![
                    QuestionOption {
                        label: DENY.into(),
                        description: "Do not call this native xAI service.".into(),
                        preview: None,
                        id: None,
                    },
                    QuestionOption {
                        label: ALLOW.into(),
                        description: "Explicitly permit this separately billed native xAI service for the exact configured target and credential.".into(),
                        preview: None,
                        id: None,
                    },
                ],
                multi_select: Some(false),
                id: None,
            }],
            result_tx,
        };
        self.sender
            .as_ref()
            .ok_or_else(|| denied("question UI missing"))?
            .0
            .send(request)
            .map_err(|_| denied("question UI closed"))?;
        let response = self
            .wait(tokio::time::timeout_at(deadline, result_rx))
            .await?
            .map_err(|_| denied("approval timed out"))?
            .map_err(|_| denied("approval cancelled"))?
            .map_err(|_| denied("approval response unavailable or malformed"))?;
        if let UserQuestionResponse::Accepted {
            answers,
            annotations,
        } = response
        {
            let exact_answer = answers.len() == 1
                && answers
                    .get(&question)
                    .is_some_and(|v| v.len() == 1 && v[0] == ALLOW);
            let plain_selection = annotations.as_ref().is_none_or(|a| {
                a.iter().all(|(q, a)| {
                    q == &question
                        && a.preview.is_none()
                        && a.notes.as_ref().is_none_or(|n| n.is_empty())
                })
            });
            if exact_answer && plain_selection {
                // Tokio timeouts may return an already-ready answer even when
                // the timer has expired; the explicit deadline is authoritative.
                check_approval_deadline(deadline)?;
                return Ok(deadline);
            }
        }
        Err(denied("explicit affirmative approval was not received"))
    }

    /// All explicit native-service HTTP dispatches, including video polls, go
    /// through this boundary. No credential lookup occurs after authorization.
    pub(crate) async fn send(
        &self,
        request: reqwest::RequestBuilder,
        headers: &ApprovedHeaders,
        guarded_http: &reqwest::Client,
    ) -> Result<reqwest::Response, ToolError> {
        let (native_http, request) = request.headers(headers.0.clone()).build_split();
        let request = request.map_err(|_| {
            ToolError::custom("native_service_http", "Invalid native xAI service request")
        })?;
        // A redirect or transparent retry would create a second dispatch without
        // rechecking the route/credential. Disable those only for subscription
        // routes; native Grok retains its original transport behavior. Explicit
        // tool retries and video polls re-enter authorization normally.
        let http = if self.subscription {
            guarded_http
        } else {
            &native_http
        };
        self.check_current()?;
        self.wait(http.execute(request)).await?.map_err(|_| {
            ToolError::custom(
                "native_service_http",
                "Native xAI service HTTP request failed",
            )
        })
    }
}

/// Separate transport, with identical service timeouts but no hidden dispatches.
/// `kind` identifies the caller's constant timeout configuration in the cache.
pub(crate) fn guarded_http_client(
    kind: &str,
    configure: impl Fn(reqwest::ClientBuilder) -> reqwest::ClientBuilder,
) -> Result<reqwest::Client, ToolError> {
    let key =
        crate::util::shared_http::cache_key(&format!("native_consent_{kind}"), &HeaderMap::new());
    crate::util::shared_http::cached_client(key, || {
        xai_grok_extra_ca::build_reqwest_client(|builder| {
            configure(builder)
                .redirect(reqwest::redirect::Policy::none())
                .retry(reqwest::retry::never())
        })
    })
    .map_err(|_| {
        ToolError::custom(
            "native_service_http",
            "Failed to build native service consent transport",
        )
    })
}

#[cfg(test)]
mod tests;
