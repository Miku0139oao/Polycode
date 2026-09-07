//! Usage attribution is about the active registered model, never the picker cursor,
//! a display name, a model-id prefix, or a URL. Keep this adapter as the only seam
//! between the shared provider registry and usage rendering/dispatch.

use xai_grok_shell::polycode::ProviderId;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UsageProvider {
    NativeGrok,
    Subscription(ProviderId),
    Unavailable,
}

impl UsageProvider {
    pub(crate) fn for_models(models: &crate::acp::ModelState) -> Self {
        // The shell owns model registration and identity. The shared helper must
        // return None for an unregistered/unknown identity, not infer it from a slug.
        // Native-only startup retains its original billing behavior before a model exists.
        if !xai_grok_shell::polycode::enabled() {
            return Self::NativeGrok;
        }
        let Some(id) = models.current_model_id_str() else {
            return Self::Unavailable;
        };
        use xai_grok_shell::polycode::RegisteredModelProvider;
        match xai_grok_shell::polycode::registered_model_provider(id) {
            Some(RegisteredModelProvider::NativeGrok) => Self::NativeGrok,
            Some(RegisteredModelProvider::Subscription(provider)) => Self::Subscription(provider),
            None => Self::Unavailable,
        }
    }

    pub(crate) fn label(self) -> &'static str {
        match self {
            Self::NativeGrok => "Grok (native xAI)",
            Self::Subscription(ProviderId::Codex) => "ChatGPT",
            Self::Subscription(ProviderId::Cursor) => "Cursor",
            Self::Unavailable => "Unavailable (unregistered model)",
        }
    }

    pub(crate) fn permits_native_billing(self) -> bool {
        self == Self::NativeGrok
    }

    /// Local facts only. No balance is synthesized and no billing request is made.
    pub(crate) fn unavailable_lines(self) -> Vec<String> {
        match self {
            Self::NativeGrok => vec![],
            Self::Subscription(_) => vec![
                "Subscription quota: unavailable".into(),
                "Remaining balance: unavailable".into(),
                "Not provided by a supported provider API.".into(),
                "Session tokens are not subscription quota.".into(),
                "Native xAI billing is separate; not queried.".into(),
            ],
            Self::Unavailable => vec![
                "Provider quota and balance: unavailable".into(),
                "Model provider identity is not registered.".into(),
                "Native xAI billing was not queried.".into(),
            ],
        }
    }

    pub(crate) fn heading(self, model: Option<&str>) -> Vec<String> {
        let mut lines = vec![format!("Active provider: {}", self.label())];
        lines.push(format!("Active model: {}", model.unwrap_or("unavailable")));
        lines
    }
}
