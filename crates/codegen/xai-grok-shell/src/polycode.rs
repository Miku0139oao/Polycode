//! Opt-in, process-local subscription model transport. This is not an agent adapter.
//! Nothing here reads project configuration or persists credentials/catalogs to disk.
use std::sync::{OnceLock, RwLock};

use indexmap::IndexMap;
use reqwest::{Client, Method, Url};
use serde::{Deserialize, Serialize, de::DeserializeOwned};

use crate::agent::config::{ConfigModelOverride, ModelEntry};
use crate::agent::model_providers::ModelProviderConfig;
use crate::sampling::ApiBackend;

static BRIDGE: OnceLock<Bridge> = OnceLock::new();

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProviderId {
    Codex,
    Cursor,
}
impl ProviderId {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Codex => "codex",
            Self::Cursor => "cursor",
        }
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Catalog {
    pub providers: Vec<Provider>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Provider {
    pub id: ProviderId,
    pub name: String,
    pub logged_in: bool,
    pub models: Vec<Model>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    pub name: String,
    pub context_window: u64,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LoginAttempt {
    pub attempt_id: String,
    pub url: String,
    pub instructions: String,
    pub user_code: Option<String>,
}
// Auth URLs/codes are UI-only; TaskResult / tracing Debug must never print them.
impl std::fmt::Debug for LoginAttempt {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("LoginAttempt([redacted])")
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum LoginState {
    Pending,
    Completed,
    Failed,
    Cancelled,
}
#[derive(Deserialize)]
pub struct LoginStatus {
    pub state: LoginState,
    pub message: Option<String>,
}

pub struct Bridge {
    base: Url,
    token: String,
    client: Client,
    catalog: RwLock<Catalog>,
    initial_provider: Option<String>,
}
pub fn bridge() -> Option<&'static Bridge> {
    BRIDGE.get()
}
pub fn enabled() -> bool {
    bridge().is_some()
}
pub fn initial_provider() -> Option<&'static str> {
    bridge().and_then(|b| b.initial_provider.as_deref())
}

/// Called only by --polycode-native, before connecting the native agent.
/// Environment variables alone cannot activate this transport.
pub fn enable_from_env(initial_provider: Option<&str>) -> Result<(), String> {
    let base =
        std::env::var("POLYCODE_BRIDGE_URL").map_err(|_| "POLYCODE_BRIDGE_URL is required")?;
    let token =
        std::env::var("POLYCODE_BRIDGE_TOKEN").map_err(|_| "POLYCODE_BRIDGE_TOKEN is required")?;
    let mut bridge = Bridge::new(&base, token)?;
    bridge.initial_provider = initial_provider.map(str::to_owned);
    install(bridge)
}

/// Secret-bearing snapshot, serialized ONLY into the trusted leader's private pipe.
/// Deliberately not Debug and never part of user config, session state, or ACP.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct LeaderBridgeBootstrap {
    base: String,
    token: String,
    initial_provider: Option<String>,
    catalog: Catalog,
}
pub(crate) fn enable_from_leader(bootstrap: LeaderBridgeBootstrap) -> Result<(), String> {
    install(Bridge::from_leader_bootstrap(bootstrap)?)
}
fn install(bridge: Bridge) -> Result<(), String> {
    xai_grok_sampler::local_transport::register(bridge.base.as_str(), &bridge.token)
        .map_err(str::to_owned)?;
    BRIDGE
        .set(bridge)
        .map_err(|_| "Polycode bridge already initialized".to_owned())
}

fn loopback_origin(raw: &str) -> Result<Url, String> {
    let mut url = Url::parse(raw).map_err(|_| "Invalid bridge URL")?;
    let loopback = match url.host() {
        Some(url::Host::Ipv4(ip)) => ip.is_loopback(),
        Some(url::Host::Ipv6(ip)) => ip.is_loopback(),
        // IP literals only: do not entrust a bearer to DNS/proxy resolution of localhost.
        _ => false,
    };
    if !loopback
        || url.scheme() != "http"
        || url.port().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || url.path() != "/"
    {
        return Err("Bridge URL must be an HTTP loopback IP origin with an explicit port".into());
    }
    url.set_path("/");
    Ok(url)
}
impl Bridge {
    pub(crate) fn new(base: &str, token: String) -> Result<Self, String> {
        let base = loopback_origin(base)?;
        if token.len() < 16 || !token.bytes().all(|b| b.is_ascii_graphic()) {
            return Err("Invalid bridge process token".into());
        }
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(std::time::Duration::from_secs(15))
            .build()
            .map_err(|_| "Could not create bridge control client")?;
        Ok(Self {
            base,
            token,
            client,
            catalog: RwLock::new(Catalog::default()),
            initial_provider: None,
        })
    }
    pub(crate) fn leader_bootstrap(&self) -> LeaderBridgeBootstrap {
        LeaderBridgeBootstrap {
            base: self.base.to_string(),
            token: self.token.clone(),
            initial_provider: self.initial_provider.clone(),
            catalog: self.catalog(),
        }
    }
    pub(crate) fn from_leader_bootstrap(bootstrap: LeaderBridgeBootstrap) -> Result<Self, String> {
        let mut bridge = Self::new(&bootstrap.base, bootstrap.token)?;
        if bootstrap
            .initial_provider
            .as_deref()
            .is_some_and(|p| !matches!(p, "native" | "codex" | "cursor"))
        {
            return Err("Invalid initial bridge provider".into());
        }
        bridge.validate_catalog(&bootstrap.catalog)?;
        bridge.initial_provider = bootstrap.initial_provider;
        *bridge.catalog.write().expect("bridge catalog") = bootstrap.catalog;
        Ok(bridge)
    }
    async fn request<T: DeserializeOwned>(
        &self,
        method: Method,
        path: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T, String> {
        let url = self
            .base
            .join(path)
            .map_err(|_| "Invalid bridge control path")?;
        let mut request = self.client.request(method, url).bearer_auth(&self.token);
        if let Some(body) = body {
            request = request.json(&body);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| "Bridge unavailable (check the launcher)")?;
        if !response.status().is_success() {
            return Err("Bridge control request failed".into());
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Bridge response interrupted")?
        {
            if bytes.len() + chunk.len() > 1024 * 1024 {
                return Err("Bridge response too large".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        // Do not echo response bytes, URLs, reqwest errors, or parser errors to logs.
        serde_json::from_slice(&bytes).map_err(|_| "Invalid bridge response".into())
    }
    pub fn catalog(&self) -> Catalog {
        self.catalog.read().expect("bridge catalog").clone()
    }
    pub async fn refresh(&self, refresh: bool) -> Result<Catalog, String> {
        let catalog: Catalog = if refresh {
            self.request(Method::POST, "control/refresh", Some(serde_json::json!({})))
                .await?
        } else {
            self.request(Method::GET, "control/catalog", None).await?
        };
        self.validate_catalog(&catalog)?;
        *self.catalog.write().expect("bridge catalog") = catalog.clone();
        Ok(catalog)
    }
    fn safe_text(&self, value: &str) -> bool {
        value.len() <= 8192
            && !value.contains(&self.token)
            && !value
                .chars()
                .any(|c| c.is_control() && c != '\n' && c != '\t')
    }
    fn validate_catalog(&self, catalog: &Catalog) -> Result<(), String> {
        let mut providers = std::collections::HashSet::new();
        for provider in &catalog.providers {
            if !providers.insert(provider.id.as_str()) || !self.safe_text(&provider.name) {
                return Err("Invalid bridge provider catalog".into());
            }
            let mut ids = std::collections::HashSet::new();
            for model in &provider.models {
                if model.id.is_empty()
                    || model.id.chars().any(char::is_control)
                    || !self.safe_text(&model.id)
                    || !self.safe_text(&model.name)
                    || model.context_window == 0
                    || !ids.insert(&model.id)
                {
                    return Err("Invalid bridge model catalog".into());
                }
            }
        }
        Ok(())
    }
    pub async fn start(&self, provider: ProviderId) -> Result<LoginAttempt, String> {
        let attempt: LoginAttempt = self
            .request(
                Method::POST,
                "control/login/start",
                Some(serde_json::json!({"provider":provider})),
            )
            .await?;
        let url = Url::parse(&attempt.url).map_err(|_| "Invalid OAuth URL")?;
        if (url.scheme() != "https"
            && !(url.scheme() == "http"
                && loopback_origin(url.origin().ascii_serialization().as_str()).is_ok()))
            || !url.username().is_empty()
            || url.password().is_some()
            || attempt.attempt_id.is_empty()
            || !self.safe_text(&attempt.attempt_id)
            || !self.safe_text(&attempt.url)
            || !self.safe_text(&attempt.instructions)
            || attempt
                .user_code
                .as_deref()
                .is_some_and(|s| !self.safe_text(s))
        {
            return Err("Invalid OAuth instructions".into());
        }
        Ok(attempt)
    }
    pub async fn status(&self, attempt_id: &str) -> Result<LoginStatus, String> {
        let path = format!(
            "control/login/status?attemptId={}",
            urlencoding::encode(attempt_id)
        );
        let mut status: LoginStatus = self.request(Method::GET, &path, None).await?;
        if status
            .message
            .as_deref()
            .is_some_and(|s| !self.safe_text(s))
        {
            status.message = None;
        }
        Ok(status)
    }
    pub async fn cancel(&self, attempt_id: &str) -> Result<(), String> {
        let _: serde_json::Value = self
            .request(
                Method::POST,
                "control/login/cancel",
                Some(serde_json::json!({"attemptId":attempt_id})),
            )
            .await?;
        Ok(())
    }
    fn model_base(&self, provider: ProviderId) -> String {
        self.base
            .join(&format!("{}/v1", provider.as_str()))
            .expect("fixed path")
            .to_string()
    }
    pub fn owns_endpoint(&self, base: &str) -> bool {
        [ProviderId::Codex, ProviderId::Cursor]
            .iter()
            .any(|p| self.model_base(*p) == base)
    }
    /// Require both the authenticated control catalog and the exact injected route.
    /// A prefix, arbitrary loopback URL, or signed-out catalog entry is not authority.
    fn ready_model(&self, id: &str, entry: &ModelEntry) -> bool {
        self.catalog().providers.iter().any(|p| {
            p.logged_in
                && entry.info.base_url == self.model_base(p.id)
                && entry.info.api_backend == ApiBackend::ChatCompletions
                && entry.info.extra_headers.is_empty()
                && p.models.iter().any(|m| {
                    id == format!("{}/{}", p.id.as_str(), m.id)
                        && entry.info.id.as_deref() == Some(id)
                        && entry.info.model == m.id
                })
        })
    }
    /// Append last, after native/global config resolution. User headers/credentials must not
    /// override the trusted transport, nor may the process key enter a native Grok entry.
    fn inject(
        &self,
        resolved: &mut IndexMap<String, ModelEntry>,
        endpoints: &crate::agent::config::EndpointsConfig,
    ) {
        for provider in self.catalog().providers.into_iter().filter(|p| p.logged_in) {
            let config = ModelProviderConfig {
                base_url: Some(self.model_base(provider.id)),
                api_backend: Some(ApiBackend::ChatCompletions),
                ..Default::default()
            };
            for model in provider.models {
                let key = format!("{}/{}", provider.id.as_str(), model.id);
                let mut entry = ConfigModelOverride {
                    model: Some(model.id),
                    name: Some(format!("{} / {}", provider.name, model.name)),
                    context_window: Some(model.context_window),
                    supported_in_api: Some(true),
                    ..Default::default()
                }
                .with_provider_defaults(&config, provider.id.as_str())
                .apply(&key, None, endpoints);
                entry.info.id = Some(key.clone());
                entry.auth_provider = Some(crate::auth::AuthProviderRef::fail_closed(
                    "polycode process transport".into(),
                ));
                resolved.insert(key, entry);
            }
        }
    }
}
pub(crate) fn inject_models(
    resolved: &mut IndexMap<String, ModelEntry>,
    endpoints: &crate::agent::config::EndpointsConfig,
) {
    if let Some(bridge) = bridge() {
        bridge.inject(resolved, endpoints);
    }
}
pub(crate) fn is_ready_model(id: &str, entry: &ModelEntry) -> bool {
    // install() registers the opaque sampler transport BEFORE publishing BRIDGE.
    bridge().is_some_and(|b| b.ready_model(id, entry))
}
pub(crate) fn is_ready_model_entry(entry: &ModelEntry) -> bool {
    entry
        .info
        .id
        .as_deref()
        .is_some_and(|id| is_ready_model(id, entry))
}
pub fn is_bridge_endpoint(base: &str) -> bool {
    bridge().is_some_and(|b| b.owns_endpoint(base))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn server(
        responses: Vec<(&'static str, String)>,
    ) -> (String, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for (status, body) in responses {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(std::time::Duration::from_secs(5)))
                    .unwrap();
                let mut request = Vec::new();
                loop {
                    let mut byte = [0];
                    socket.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                    if request.ends_with(b"\r\n\r\n") {
                        break;
                    }
                }
                let headers = String::from_utf8(request.clone()).unwrap();
                let length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|n| n.parse::<usize>().ok())
                    })
                    .unwrap_or(0);
                let mut data = vec![0; length];
                socket.read_exact(&mut data).unwrap();
                request.extend(data);
                requests.push(String::from_utf8(request).unwrap());
                write!(socket, "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}", body.len()).unwrap();
            }
            requests
        });
        (origin, handle)
    }
    #[tokio::test]
    async fn polycode_control_contract_login_status_cancel_refresh_and_redaction() {
        let catalog = serde_json::json!({"providers":[{"id":"codex","name":"ChatGPT","loggedIn":false,"models":[]}]}).to_string();
        let (origin, server) = server(vec![
            ("200 OK", catalog.clone()),
            ("200 OK", r#"{"attemptId":"a/?&","url":"https://example.com/login","instructions":"Continue in browser","userCode":"ABC-DEF"}"#.into()),
            ("200 OK", r#"{"state":"pending"}"#.into()),
            ("200 OK", r#"{"state":"completed"}"#.into()),
            ("200 OK", "{}".into()),
            ("200 OK", catalog),
        ]);
        let bridge = Bridge::new(&origin, "test-process-token".into()).unwrap();
        assert!(
            bridge.refresh(false).await.unwrap().providers[0]
                .models
                .is_empty()
        );
        let a = bridge.start(ProviderId::Codex).await.unwrap();
        assert_eq!(a.user_code.as_deref(), Some("ABC-DEF"));
        assert_eq!(
            bridge.status(&a.attempt_id).await.unwrap().state,
            LoginState::Pending
        );
        assert_eq!(
            bridge.status(&a.attempt_id).await.unwrap().state,
            LoginState::Completed
        );
        bridge.cancel(&a.attempt_id).await.unwrap();
        bridge.refresh(true).await.unwrap();
        let requests = server.join().unwrap();
        for request in &requests {
            assert!(
                request
                    .to_ascii_lowercase()
                    .contains("authorization: bearer test-process-token\r\n")
            );
        }
        assert!(requests[0].starts_with("GET /control/catalog "));
        assert!(requests[1].starts_with("POST /control/login/start "));
        assert!(requests[1].ends_with(r#"{"provider":"codex"}"#));
        assert!(requests[2].starts_with("GET /control/login/status?attemptId=a%2F%3F%26 "));
        assert!(requests[4].ends_with(r#"{"attemptId":"a/?&"}"#));
        assert!(requests[5].starts_with("POST /control/refresh "));
        assert!(requests[5].ends_with("{}"));
    }
    #[tokio::test]
    async fn polycode_control_rejects_redirects_and_never_echoes_error_response() {
        let (origin, server) = server(vec![(
            "302 Found\r\nLocation: http://127.0.0.1:1/should-not-follow",
            "private-process-token".into(),
        )]);
        let bridge = Bridge::new(&origin, "private-process-token".into()).unwrap();
        let error = bridge.refresh(false).await.unwrap_err();
        assert_eq!(error, "Bridge control request failed");
        assert_eq!(server.join().unwrap().len(), 1);
        for state in ["failed", "cancelled"] {
            let (origin, server) = self::server(vec![(
                "200 OK",
                format!(r#"{{"state":"{state}","message":"private-process-token"}}"#),
            )]);
            let bridge = Bridge::new(&origin, "private-process-token".into()).unwrap();
            let status = bridge.status("attempt").await.unwrap();
            assert!(status.message.is_none());
            assert_ne!(status.state, LoginState::Completed);
            server.join().unwrap();
        }
    }
    #[tokio::test]
    async fn leader_bootstrap_preserves_snapshot_and_fetches_same_catalog_with_private_auth() {
        let catalog = serde_json::json!({"providers":[{"id":"cursor","name":"Cursor","loggedIn":true,"models":[{"id":"fresh-model","name":"Fresh","contextWindow":64000}]}]}).to_string();
        let (origin, server) = server(vec![("200 OK", catalog)]);
        let mut parent = Bridge::new(&origin, "private-leader-process-token".into()).unwrap();
        parent.initial_provider = Some("cursor".into());
        let snapshot = Catalog {
            providers: vec![Provider {
                id: ProviderId::Codex,
                name: "ChatGPT".into(),
                logged_in: false,
                models: vec![],
            }],
        };
        *parent.catalog.write().unwrap() = snapshot;
        let leader = Bridge::from_leader_bootstrap(parent.leader_bootstrap()).unwrap();
        assert_eq!(leader.initial_provider.as_deref(), Some("cursor"));
        assert_eq!(leader.catalog().providers[0].id, ProviderId::Codex);
        leader.refresh(false).await.unwrap();
        assert_eq!(leader.catalog().providers[0].models[0].id, "fresh-model");
        assert_eq!(
            parent.catalog().providers[0].id,
            ProviderId::Codex,
            "process-local caches must not be aliased"
        );
        let requests = server.join().unwrap();
        assert!(requests[0].starts_with("GET /control/catalog "));
        assert!(
            requests[0]
                .to_ascii_lowercase()
                .contains("authorization: bearer private-leader-process-token\r\n")
        );
    }
    #[test]
    fn leader_bootstrap_revalidates_transport_and_catalog_without_secret_errors() {
        let bridge = Bridge::new(
            "http://127.0.0.1:12345",
            "private-leader-process-token".into(),
        )
        .unwrap();
        let mut bad_origin = bridge.leader_bootstrap();
        bad_origin.base = "https://example.com".into();
        let mut bad_catalog = bridge.leader_bootstrap();
        bad_catalog.catalog.providers.push(Provider {
            id: ProviderId::Codex,
            name: "private-leader-process-token".into(),
            logged_in: false,
            models: vec![],
        });
        let mut bad_provider = bridge.leader_bootstrap();
        bad_provider.initial_provider = Some("private-leader-process-token".into());
        for snapshot in [bad_origin, bad_catalog, bad_provider] {
            let error = Bridge::from_leader_bootstrap(snapshot).err().unwrap();
            assert!(!error.contains("private-leader-process-token"));
        }
    }
    #[test]
    fn loopback_only_and_no_credential_url() {
        for bad in [
            "https://127.0.0.1:1234",
            "http://localhost:1234",
            "http://example.com:1234",
            "http://127.0.0.1",
            "http://u:p@127.0.0.1:1234",
            "http://127.0.0.1:1234/path",
            "http://127.0.0.1:1234?token=x",
            "http://127.0.0.1:1234/#x",
        ] {
            assert!(loopback_origin(bad).is_err(), "{bad}");
        }
        assert!(loopback_origin("http://127.0.0.1:1234").is_ok());
        assert!(loopback_origin("http://[::1]:1234").is_ok());
    }
    #[test]
    fn overlay_keeps_native_models_and_native_config() {
        use crate::agent::config::{Config, resolve_credentials, resolve_model_list};
        let cfg = Config::default();
        let mut models = resolve_model_list(&cfg, None);
        let original = models.clone();
        let bridge =
            Bridge::new("http://127.0.0.1:1234", "not-a-real-process-token".into()).unwrap();
        let catalog: Catalog = serde_json::from_value(serde_json::json!({"providers":[{"id":"codex","name":"ChatGPT","loggedIn":true,"models":[{"id":"actual-id","name":"Model","contextWindow":128000}]}]})).unwrap();
        bridge.validate_catalog(&catalog).unwrap();
        *bridge.catalog.write().unwrap() = catalog;
        bridge.inject(&mut models, &cfg.endpoints);
        assert_eq!(models.len(), original.len() + 1);
        for (id, entry) in original {
            assert_eq!(
                serde_json::to_value(&models[&id]).unwrap(),
                serde_json::to_value(entry).unwrap()
            );
        }
        let entry = &models["codex/actual-id"];
        assert!(bridge.ready_model("codex/actual-id", entry));
        assert!(!bridge.ready_model("cursor/actual-id", entry));
        assert!(!bridge.ready_model("codex/missing", entry));
        for endpoint in ["http://127.0.0.1:1235/codex/v1", "https://api.x.ai/v1"] {
            let mut forged = entry.clone();
            forged.info.base_url = endpoint.into();
            assert!(!bridge.ready_model("codex/actual-id", &forged));
        }
        let mut forged = entry.clone();
        forged.info.model = "uncatalogued-model".into();
        assert!(!bridge.ready_model("codex/actual-id", &forged));
        bridge.catalog.write().unwrap().providers[0].logged_in = false;
        assert!(!bridge.ready_model("codex/actual-id", entry));
        let mut signed_out = IndexMap::new();
        bridge.inject(&mut signed_out, &cfg.endpoints);
        assert!(
            signed_out.is_empty(),
            "signed-out models cannot be registered"
        );
        assert_eq!(entry.info.model, "actual-id");
        assert_eq!(entry.info.base_url, "http://127.0.0.1:1234/codex/v1");
        assert_eq!(entry.info.api_backend, ApiBackend::ChatCompletions);
        assert_eq!(
            serde_json::to_string(&entry.info.api_backend).unwrap(),
            "\"chat_completions\""
        );
        assert!(entry.info.extra_headers.is_empty());
        // No static, synthetic or native credential is embedded in the model.
        // Even without a globally installed transport this entry fails closed.
        assert!(entry.api_key.is_none());
        assert!(entry.env_key.is_none());
        assert!(
            resolve_credentials(entry, Some("native-session-token"))
                .api_key
                .is_none()
        );
        assert!(!format!("{entry:?}").contains("not-a-real-process-token"));
    }
    #[test]
    fn login_debug_is_redacted_and_catalog_rejects_token() {
        let b = Bridge::new("http://127.0.0.1:1234", "secret-process-token".into()).unwrap();
        let a = LoginAttempt {
            attempt_id: "private-id".into(),
            url: "https://example.com/private".into(),
            instructions: "private".into(),
            user_code: Some("private".into()),
        };
        assert!(!format!("{a:?}").contains("private"));
        let c = Catalog {
            providers: vec![Provider {
                id: ProviderId::Cursor,
                name: b.token.clone(),
                logged_in: false,
                models: vec![],
            }],
        };
        assert!(b.validate_catalog(&c).is_err());
    }
}
