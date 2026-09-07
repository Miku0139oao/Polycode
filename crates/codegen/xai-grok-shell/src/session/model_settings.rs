//! Actor-owned, single-slot model configuration transaction. Nothing is applied at admission.
use agent_client_protocol as acp;
use tokio::sync::oneshot;

pub(crate) struct PendingModelSwitch {
    pub model_id: acp::ModelId,
    pub selection_id: Option<String>,
    pub effort_only: bool,
    // Private in-memory fingerprint only; may contain config credentials. Never Debug/persist it.
    pub catalog_entry: serde_json::Value,
    pub catalog_revision: Option<String>,
    pub sampling_config: xai_grok_sampler::SamplerConfig,
    pub use_concise: bool,
    pub is_family_switch: bool,
    pub apply_prompt_override: bool,
    pub skip_prompt_rewrite: bool,
    pub rebuild: Option<xai_grok_agent::AgentDefinition>,
    pub auto_compact_threshold_percent: u8,
    pub responds_to: oneshot::Sender<Result<acp::ModelId, acp::Error>>,
}

pub(crate) struct ValidationTask(
    pub tokio::task::JoinHandle<Result<Option<xai_grok_sampler::SamplerConfig>, acp::Error>>,
);
impl Drop for ValidationTask {
    fn drop(&mut self) {
        self.0.abort();
    }
}

/// Owned by one actor incarnation, not persisted or reused on resume. A replacement consumes
/// the previous responder; there is no detached future that can apply a retired generation.
#[derive(Default)]
pub(crate) struct PendingSlot<T> {
    value: Option<T>,
}
impl<T> PendingSlot<T> {
    pub fn new() -> Self {
        Self { value: None }
    }
    pub fn replace(&mut self, value: T) -> Option<T> {
        self.value.replace(value)
    }
    pub fn take(&mut self) -> Option<T> {
        self.value.take()
    }
    pub fn as_ref(&self) -> Option<&T> {
        self.value.as_ref()
    }
    pub fn is_some(&self) -> bool {
        self.value.is_some()
    }
}
impl PendingSlot<PendingModelSwitch> {
    pub fn accepts_cancel(&self, selection_id: Option<&str>) -> bool {
        selection_id.is_none()
            || self
                .as_ref()
                .is_some_and(|p| p.selection_id.as_deref() == selection_id)
    }
    pub fn cancel(&mut self, reason: &str) {
        if let Some(old) = self.take() {
            let _ = old
                .responds_to
                .send(Err(acp::Error::invalid_params().data(reason)));
        }
    }
}

/// The complete idle boundary: active inference, finalization, tools/side-work, server input,
/// parked permissions and children all keep their original configuration until finished.
pub(crate) fn can_commit(busy: bool, active_children: bool) -> bool {
    !busy && !active_children
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test(flavor = "current_thread")]
    async fn model_settings_retired_validation_cannot_publish_late_completion() {
        tokio::task::LocalSet::new()
            .run_until(async {
                let published = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
                let marker = published.clone();
                let (release, wait) = tokio::sync::oneshot::channel::<()>();
                let task = ValidationTask(tokio::task::spawn_local(async move {
                    let _ = wait.await;
                    marker.store(true, std::sync::atomic::Ordering::SeqCst);
                    Ok(None)
                }));
                tokio::task::yield_now().await;
                drop(task); // same retirement used by replace/cancel/error/resume/shutdown
                let _ = release.send(());
                tokio::task::yield_now().await;
                assert!(!published.load(std::sync::atomic::Ordering::SeqCst));
            })
            .await;
    }
    #[test]
    fn model_settings_busy_accept_replace_cancel_and_safe_commit() {
        let mut pending = PendingSlot::new();
        let mut live = ("grok", "old", "high");
        let target = ("codex", "new", "low");
        assert_eq!(pending.replace(target), None); // admission is permitted while busy
        assert!(!can_commit(true, false));
        assert_eq!(live, ("grok", "old", "high"));
        assert_eq!(
            pending.replace(("cursor", "actual", "unavailable")),
            Some(target)
        );
        assert!(!can_commit(false, true)); // children are not just the foreground turn
        assert_eq!(pending.take(), Some(("cursor", "actual", "unavailable"))); // cancel
        assert_eq!(pending.take(), None);
        pending.replace(target);
        if can_commit(false, false) {
            live = pending.take().unwrap();
        }
        assert_eq!(live, target); // whole provider/model/effort commits, never a partial merge
    }
    #[test]
    fn model_settings_error_or_session_change_cannot_reuse_a_pending_generation() {
        let mut old = PendingSlot::new();
        old.replace(1);
        old.take(); // error/cancel consumes it
        assert!(old.take().is_none());
        let resumed = PendingSlot::<i32>::new();
        assert!(!resumed.is_some());
        old.replace(2);
        assert_eq!(old.take(), Some(2));
        assert!(old.take().is_none());
    }
}
