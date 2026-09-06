//! Local provider control messages. Never sent as prompts, tool results, or chat history.
use super::agent::AgentId;
pub(crate) use super::dispatch::provider::answer;
use agent_client_protocol as acp;
use xai_grok_shell::polycode::{Catalog, LoginAttempt, LoginState, ProviderId};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Grok,
    Subscription(ProviderId),
}
#[derive(Debug, Clone)]
pub enum Command {
    Menu { login: bool },
    Choose { provider: Choice, login: bool },
    Model(String),
    Refresh,
    Cancel,
}
#[derive(Default, Debug)]
pub struct State {
    pub generation: u64,
    pub target: Option<AgentId>,
    pub selected: Option<Choice>,
    pub attempt: Option<LoginAttempt>,
    pub catalog: Catalog,
    pub login_menu: bool,
    /// A local-only view until explicit model choice commits its ACP session.
    pub local_target: Option<AgentId>,
    pub creating: bool,
    pub pending_session_id: Option<String>,
    /// Prevent late ACP traffic from a cancelled create reaching any new placeholder.
    pub retired_sessions: std::collections::HashSet<String>,
}
impl State {
    pub fn invalidate(&mut self) -> Option<LoginAttempt> {
        self.generation = self.generation.wrapping_add(1);
        self.attempt.take()
    }
    pub fn accepts(&self, generation: u64, target: AgentId) -> bool {
        self.generation == generation && self.target == Some(target)
    }
}
// Payloads deliberately have redacted Debug implementations: effect/task tracing must not
// record auth URLs, device codes, instructions, attempt IDs, or server messages.
pub enum Operation {
    Catalog {
        refresh: bool,
        provider: Option<Choice>,
    },
    Start(ProviderId),
    Poll(String),
    Cancel(String),
}
impl std::fmt::Debug for Operation {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Catalog { .. } => "Catalog",
            Self::Start(_) => "Start",
            Self::Poll(_) => "Poll",
            Self::Cancel(_) => "Cancel",
        })
    }
}
pub enum Reply {
    Catalog {
        catalog: Catalog,
        models: acp::SessionModelState,
        provider: Option<Choice>,
    },
    Started(LoginAttempt),
    Status {
        state: LoginState,
        message: Option<String>,
    },
    Cancelled,
    Error(String),
}
impl std::fmt::Debug for Reply {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(match self {
            Self::Catalog { .. } => "Catalog",
            Self::Started(_) => "Started",
            Self::Status { .. } => "Status",
            Self::Cancelled => "Cancelled",
            Self::Error(_) => "Error",
        })
    }
}
pub async fn execute(operation: Operation, tx: xai_acp_lib::AcpAgentTx) -> Reply {
    async fn run(operation: Operation, tx: xai_acp_lib::AcpAgentTx) -> Result<Reply, String> {
        let bridge = xai_grok_shell::polycode::bridge()
            .ok_or("Use --polycode-native via the Polycode launcher")?;
        Ok(match operation {
            Operation::Catalog { refresh, provider } => {
                let catalog = bridge.refresh(refresh).await?;
                let req = acp::ExtRequest::new(
                    "x.ai/auth/polycode/reload",
                    serde_json::value::to_raw_value(&serde_json::json!({}))
                        .unwrap()
                        .into(),
                );
                let response: acp::ExtResponse = xai_acp_lib::acp_send(req, &tx)
                    .await
                    .map_err(|_| "Native model catalog reload failed")?;
                let models = serde_json::from_str(response.0.get())
                    .map_err(|_| "Invalid native model catalog")?;
                Reply::Catalog {
                    catalog,
                    models,
                    provider,
                }
            }
            Operation::Start(provider) => Reply::Started(bridge.start(provider).await?),
            Operation::Poll(id) => {
                tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                let status = bridge.status(&id).await?;
                Reply::Status {
                    state: status.state,
                    message: status.message,
                }
            }
            Operation::Cancel(id) => {
                bridge.cancel(&id).await?;
                Reply::Cancelled
            }
        })
    }
    run(operation, tx).await.unwrap_or_else(Reply::Error)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cancelled_and_stale_completions_cannot_select_a_newer_provider() {
        let mut state = State {
            target: Some(AgentId(1)),
            ..Default::default()
        };
        let first = state.generation;
        assert!(state.accepts(first, AgentId(1)));
        state.invalidate();
        assert!(!state.accepts(first, AgentId(1)));
        assert!(!state.accepts(state.generation, AgentId(2)));
        let second = state.generation;
        state.invalidate();
        assert!(!state.accepts(second, AgentId(1)));
    }
    #[test]
    fn control_debug_never_contains_auth_material() {
        assert!(!format!("{:?}", Operation::Poll("private-attempt".into())).contains("private"));
        assert!(
            !format!(
                "{:?}",
                Reply::Status {
                    state: LoginState::Failed,
                    message: Some("private-message".into())
                }
            )
            .contains("private")
        );
    }
}
