//! Generation-scoped pager mirror of actor-owned pending model configuration.
use super::{actions::SwitchModelError, agent::AgentId};
use agent_client_protocol as acp;
use xai_grok_shell::sampling::types::ReasoningEffort;

#[derive(Clone, Debug)]
pub struct Selection {
    pub generation: u64,
    pub selection_id: String,
    pub catalog_revision: Option<String>,
    pub agent_id: AgentId,
    pub session_id: acp::SessionId,
    pub model_id: acp::ModelId,
    pub effort: Option<ReasoningEffort>,
}
#[derive(Default, Debug)]
pub struct Pending {
    generation: u64,
    pub selections: std::collections::HashMap<AgentId, Selection>,
}
impl Pending {
    pub fn queue(
        &mut self,
        agent_id: AgentId,
        session_id: acp::SessionId,
        model_id: acp::ModelId,
        effort: Option<ReasoningEffort>,
    ) -> Selection {
        self.generation = self.generation.wrapping_add(1);
        let selection = Selection {
            generation: self.generation,
            selection_id: uuid::Uuid::new_v4().to_string(),
            catalog_revision: None,
            agent_id,
            session_id,
            model_id,
            effort,
        };
        self.selections.insert(agent_id, selection.clone());
        selection
    }
    pub fn accepts(&self, s: &Selection, current_session: Option<&acp::SessionId>) -> bool {
        current_session == Some(&s.session_id)
            && self
                .selections
                .get(&s.agent_id)
                .is_some_and(|p| p.generation == s.generation && p.session_id == s.session_id)
    }
}
pub async fn execute(
    s: &Selection,
    tx: &xai_acp_lib::AcpAgentTx,
) -> Result<Option<ReasoningEffort>, SwitchModelError> {
    let mut meta = acp::Meta::new();
    meta.insert(
        "polycodeSelectionId".into(),
        serde_json::json!(s.selection_id),
    );
    if let Some(revision) = &s.catalog_revision { meta.insert("polycodeCatalogRevision".into(), serde_json::json!(revision)); }
    if let Some(effort) = s.effort {
        meta.insert("reasoningEffort".into(), serde_json::json!(effort));
    }
    let response: acp::SetSessionModelResponse = xai_acp_lib::acp_send(
        acp::SetSessionModelRequest::new(s.session_id.clone(), s.model_id.clone()).meta(Some(meta)),
        tx,
    )
    .await
    .map_err(|e| {
        if let Some(error) =
            xai_grok_shell::agent::config::ModelSwitchIncompatibleAgentError::from_acp_error(&e)
        {
            SwitchModelError::IncompatibleAgent {
                error,
                prev_model_id: None,
            }
        } else {
            SwitchModelError::Other(super::sanitize_user_error(&e.to_string()))
        }
    })?;
    applied_effort(&response)
}
fn applied_effort(
    response: &acp::SetSessionModelResponse,
) -> Result<Option<ReasoningEffort>, SwitchModelError> {
    // An explicit null is authoritative; missing/malformed metadata is not a fake no-op.
    let raw = response.meta.as_ref().and_then(|m| m.get("reasoningEffort"))
        .ok_or_else(|| SwitchModelError::Other("Native actor did not confirm applied effort; reconnect with the updated native binary".into()))?;
    serde_json::from_value(raw.clone()).map_err(|_| {
        SwitchModelError::Other("Native actor returned an invalid applied effort".into())
    })
}
pub async fn cancel(
    session_id: acp::SessionId,
    selection_id: String,
    tx: &xai_acp_lib::AcpAgentTx,
) {
    let mut meta = acp::Meta::new();
    meta.insert("polycodeCancelPending".into(), serde_json::json!(true));
    meta.insert(
        "polycodeSelectionId".into(),
        serde_json::json!(selection_id),
    );
    let _: Result<acp::SetSessionModelResponse, _> = xai_acp_lib::acp_send(
        acp::SetSessionModelRequest::new(session_id, acp::ModelId::new("")).meta(Some(meta)),
        tx,
    )
    .await;
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn model_settings_applied_effort_is_explicit_not_silently_dropped() {
        assert!(applied_effort(&acp::SetSessionModelResponse::new()).is_err());
        for (value, expected) in [
            (serde_json::json!(null), None),
            (serde_json::json!("low"), Some(ReasoningEffort::Low)),
        ] {
            let response = acp::SetSessionModelResponse::new().meta(
                serde_json::json!({"reasoningEffort":value})
                    .as_object()
                    .cloned(),
            );
            assert_eq!(applied_effort(&response).unwrap(), expected);
        }
        let bad = acp::SetSessionModelResponse::new().meta(
            serde_json::json!({"reasoningEffort":"unknown"})
                .as_object()
                .cloned(),
        );
        assert!(applied_effort(&bad).is_err());
    }
    #[test]
    fn model_settings_replace_cancel_and_resume_reject_stale_completions() {
        let mut pending = Pending::default();
        let sid = acp::SessionId::new("old");
        let old = pending.queue(
            AgentId(1),
            sid.clone(),
            acp::ModelId::new("codex/a"),
            Some(ReasoningEffort::Low),
        );
        let new = pending.queue(AgentId(1), sid.clone(), acp::ModelId::new("cursor/b"), None);
        assert!(!pending.accepts(&old, Some(&sid)));
        assert!(pending.accepts(&new, Some(&sid)));
        assert!(!pending.accepts(&new, Some(&acp::SessionId::new("resumed"))));
        pending.selections.remove(&AgentId(1));
        assert!(!pending.accepts(&new, Some(&sid)));
    }
}
