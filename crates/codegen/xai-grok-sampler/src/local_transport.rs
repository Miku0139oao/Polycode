//! Explicitly registered process-local model transport. No environment/config discovery.
//! The opaque bearer never enters SamplerConfig, chat state, persistence, or auth telemetry.
use reqwest::header::{AUTHORIZATION, HeaderMap, HeaderValue};
use std::sync::OnceLock;

struct Transport {
    endpoints: [String; 2],
    bearer: HeaderValue,
    client: reqwest::Client,
}
static TRANSPORT: OnceLock<Transport> = OnceLock::new();

pub fn register(origin: &str, token: &str) -> Result<(), &'static str> {
    let url = reqwest::Url::parse(origin).map_err(|_| "Invalid local transport URL")?;
    let ip = url
        .host_str()
        .and_then(|h| h.trim_matches(['[', ']']).parse::<std::net::IpAddr>().ok());
    if url.scheme() != "http"
        || !ip.is_some_and(|ip| ip.is_loopback())
        || !url.username().is_empty()
        || url.password().is_some()
        || url.path() != "/"
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err("Local transport must be an HTTP loopback origin");
    }
    let mut bearer = HeaderValue::from_str(&format!("Bearer {token}"))
        .map_err(|_| "Invalid local transport bearer")?;
    bearer.set_sensitive(true);
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(std::time::Duration::from_secs(10))
        .build()
        .map_err(|_| "Local transport client unavailable")?;
    let origin = origin.trim_end_matches('/');
    TRANSPORT
        .set(Transport {
            endpoints: [format!("{origin}/codex/v1"), format!("{origin}/cursor/v1")],
            bearer,
            client,
        })
        .map_err(|_| "Local transport already registered")
}
fn transport(base: &str) -> Option<&'static Transport> {
    TRANSPORT
        .get()
        .filter(|t| t.endpoints.iter().any(|endpoint| endpoint == base))
}
pub(crate) fn is_local(base: &str) -> bool {
    transport(base).is_some()
}
/// Only endpoints in the process-local registration identify a subscription.
/// Return a provider label, never the transport's bearer or endpoint.
pub fn subscription_provider(base: &str) -> Option<&'static str> {
    let t = transport(base)?;
    t.endpoints
        .iter()
        .position(|endpoint| endpoint == base)
        .map(|index| ["codex", "cursor"][index])
}
pub(crate) fn client(base: &str) -> Option<reqwest::Client> {
    transport(base).map(|t| t.client.clone())
}
pub(crate) fn authorize(base: &str, headers: &mut HeaderMap) {
    if let Some(t) = transport(base) {
        headers.remove("x-api-key");
        headers.remove("x-xai-token-auth");
        headers.insert(AUTHORIZATION, t.bearer.clone());
    }
}
