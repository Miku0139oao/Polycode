//! Explicit, fail-closed stdio ACP transport. No leader reconnect or native fallback.
use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    process::Stdio,
    sync::{Arc, Mutex},
};

use agent_client_protocol as acp;
use anyhow::{Context, Result, bail};
use tokio_util::{
    compat::{TokioAsyncReadCompatExt, TokioAsyncWriteCompatExt},
    sync::CancellationToken,
};
use xai_acp_lib::{
    AcpAgentMessage, AcpClientChannel, AcpClientMessage, AcpGatewayReceiver, AcpGatewaySender,
    LineBufferedRead, acp_channels, acp_send,
};

mod cursor;

/// An absolute executable avoids ambiguous PATH resolution (notably `agent`).
/// Arguments are passed verbatim, never through a shell. No credentials/config are copied.
#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ExternalAgentConfig {
    pub executable: PathBuf,
    #[serde(default)]
    pub args: Vec<String>,
    pub auth_method: Option<String>,
}
impl ExternalAgentConfig {
    pub fn resolve(
        args: &crate::app::cli::PagerArgs,
        config: &toml::Value,
    ) -> Result<Option<Self>> {
        if args.no_external_acp {
            return Ok(None);
        }
        let configured = config
            .get("external_acp")
            .cloned()
            .map(|v| v.try_into::<Self>())
            .transpose()
            .context("invalid [external_acp] configuration")?;
        let selected = if let Some(executable) = &args.acp_executable {
            Some(Self {
                executable: executable.clone(),
                args: args.acp_args.clone(),
                auth_method: args.acp_auth_method.clone(),
            })
        } else {
            if !args.acp_args.is_empty() || args.acp_auth_method.is_some() {
                bail!("--acp-arg/--acp-auth-method require --acp-executable");
            }
            configured
        };
        if let Some(c) = &selected {
            c.validate()?;
        }
        Ok(selected)
    }
    pub fn validate(&self) -> Result<()> {
        if !self.executable.is_absolute() {
            bail!("external ACP executable must be an absolute path; PATH lookup is not allowed");
        }
        if self.args.iter().any(|a| a.contains('\0'))
            || self
                .auth_method
                .as_ref()
                .is_some_and(|m| m.trim().is_empty())
        {
            bail!("invalid external ACP arguments or empty auth_method");
        }
        #[cfg(windows)]
        if self
            .executable
            .extension()
            .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
        {
            bail!("external ACP requires a native executable, not a shell script (.cmd/.bat)");
        }
        Ok(())
    }
    /// Reject unsupported launch modes before any native startup side effects.
    pub fn validate_launch(&self, args: &crate::app::cli::PagerArgs) -> Result<()> {
        if args.command.is_some()
            || args.single.is_some()
            || args.prompt_json.is_some()
            || args.prompt_file.is_some()
            || args.memory_flush
        {
            bail!(
                "external ACP currently supports interactive TUI only, not subcommands/headless mode"
            );
        }
        if args.leader
            || args.leader_socket.is_some()
            || args.chat()
            || args.worktree.is_some()
            || args.fork_session
            || args.restore_code
            || args.session_id.is_some()
            || args.continue_last_session
            || args.resume_most_recent()
        {
            bail!(
                "external ACP does not support native leader/chat/worktree/fork/restore/session-id/most-recent modes; resume with an explicit external session ID"
            );
        }
        if args.yolo
            || args.permission_mode_flag.is_some()
            || !args.allow_rules.is_empty()
            || !args.deny_rules.is_empty()
            || args.rules.is_some()
            || args.system_prompt_override.is_some()
            || args.agent.is_some()
            || args.reasoning_effort.is_some()
        {
            bail!(
                "external ACP does not support Polycode permission overrides, agent/system prompt/rules or reasoning-effort flags; configure the external agent instead"
            );
        }
        Ok(())
    }
}

pub(crate) fn unsupported() -> acp::Error {
    acp::Error::new(
        acp::ErrorCode::MethodNotFound.into(),
        "Unsupported by external ACP backend (native Polycode extensions are disabled)",
    )
}

#[derive(Default)]
struct Capabilities {
    load: bool,
    images: bool,
    audio: bool,
    embedded: bool,
    methods: Vec<acp::AuthMethodId>,
    replaying: HashSet<acp::SessionId>,
    models: HashMap<acp::SessionId, Vec<acp::ModelId>>,
    cursor: cursor::State,
}

/// Policy sits immediately before the wire: even a missed UI gate cannot leak xAI
/// metadata, configured MCP credentials, or a Grok-only extension to the child.
async fn forward(
    mut msg: AcpAgentMessage,
    tx: xai_acp_lib::AcpAgentTx,
    caps: Arc<Mutex<Capabilities>>,
) {
    match msg {
        AcpAgentMessage::ExtMethod(a) => {
            let _ = a.response_tx.send(Err(unsupported()));
            return;
        }
        AcpAgentMessage::ExtNotification(a) => {
            let _ = a.response_tx.send(Err(unsupported()));
            return;
        }
        AcpAgentMessage::Initialize(mut a) => {
            a.request.meta = None;
            a.request.client_capabilities = acp::ClientCapabilities::new();
            let response = acp_send(a.request, &tx)
                .await
                .map(|mut r: acp::InitializeResponse| {
                    let mut c = caps.lock().unwrap();
                    c.load = r.agent_capabilities.load_session;
                    c.images = r.agent_capabilities.prompt_capabilities.image;
                    c.audio = r.agent_capabilities.prompt_capabilities.audio;
                    c.embedded = r.agent_capabilities.prompt_capabilities.embedded_context;
                    c.methods = r.auth_methods.iter().map(|m| m.id().clone()).collect();
                    // Never treat an external process as Grok, regardless of its metadata.
                    r.meta = None;
                    r
                });
            let _ = a.response_tx.send(response);
            return;
        }
        AcpAgentMessage::NewSession(mut a) => {
            let requested_model = a
                .request
                .meta
                .as_ref()
                .and_then(|m| m.get("modelId"))
                .and_then(|v| v.as_str())
                .map(acp::ModelId::new);
            a.request.meta = None;
            a.request.mcp_servers.clear();
            let mut response = acp_send(a.request, &tx).await;
            if let Ok(r) = &mut response {
                r.meta = None;
                record_models(&caps, &r.session_id, r.models.as_ref());
                if let Some(model) = requested_model {
                    if !model_allowed(&caps, &r.session_id, &model) {
                        response = Err(acp::Error::invalid_params()
                            .data("Model not advertised by external session"));
                    } else {
                        match acp_send(
                            acp::SetSessionModelRequest::new(r.session_id.clone(), model.clone()),
                            &tx,
                        )
                        .await
                        {
                            Ok(_) => {
                                if let Some(models) = &mut r.models {
                                    models.current_model_id = model;
                                }
                            }
                            Err(e) => response = Err(e),
                        }
                    }
                }
            }
            let _ = a.response_tx.send(response);
            return;
        }
        AcpAgentMessage::LoadSession(mut a) => {
            if !caps.lock().unwrap().load {
                let _ = a.response_tx.send(Err(unsupported()));
                return;
            }
            a.request.meta = None;
            a.request.mcp_servers.clear();
            let sid = a.request.session_id.clone();
            caps.lock().unwrap().replaying.insert(sid.clone());
            let response = acp_send(a.request, &tx)
                .await
                .map(|mut r: acp::LoadSessionResponse| {
                    r.meta = None;
                    record_models(&caps, &sid, r.models.as_ref());
                    r
                });
            let _ = a.response_tx.send(response);
            return;
        }
        _ => {}
    }
    match &mut msg {
        AcpAgentMessage::Authenticate(a) => {
            a.request.meta = None;
            if !caps.lock().unwrap().methods.contains(&a.request.method_id) {
                let AcpAgentMessage::Authenticate(a) = msg else {
                    unreachable!()
                };
                let _ =
                    a.response_tx.send(Err(acp::Error::invalid_params()
                        .data("Authentication method was not advertised")));
                return;
            }
        }
        AcpAgentMessage::Prompt(a) => {
            caps.lock().unwrap().replaying.remove(&a.request.session_id);
            a.request.meta = None;
            for block in &mut a.request.prompt {
                match block {
                    acp::ContentBlock::Text(b) => b.meta = None,
                    acp::ContentBlock::Image(b) => b.meta = None,
                    acp::ContentBlock::Audio(b) => b.meta = None,
                    acp::ContentBlock::Resource(b) => b.meta = None,
                    acp::ContentBlock::ResourceLink(b) => b.meta = None,
                    _ => {}
                }
            }
            let supported = a.request.prompt.iter().all(|block| {
                let c = caps.lock().unwrap();
                match block {
                    acp::ContentBlock::Text(_) => true,
                    acp::ContentBlock::Image(_) => c.images,
                    acp::ContentBlock::Audio(_) => c.audio,
                    acp::ContentBlock::Resource(_) | acp::ContentBlock::ResourceLink(_) => {
                        c.embedded
                    }
                    _ => false,
                }
            });
            if !supported {
                let AcpAgentMessage::Prompt(a) = msg else {
                    unreachable!()
                };
                let _ = a.response_tx.send(Err(acp::Error::invalid_params()
                    .data("Prompt content not supported by external agent capabilities")));
                return;
            }
        }
        AcpAgentMessage::Cancel(a) => {
            a.request.meta = None;
            caps.lock().unwrap().cursor.cancel(&a.request.session_id);
        }
        AcpAgentMessage::SetSessionModel(a) => {
            a.request.meta = None;
            if !model_allowed(&caps, &a.request.session_id, &a.request.model_id) {
                let AcpAgentMessage::SetSessionModel(a) = msg else {
                    unreachable!()
                };
                let _ = a.response_tx.send(Err(unsupported()));
                return;
            }
        }
        // UI's modes are Grok-specific (plan/auto/yolo), not arbitrary ACP modes.
        AcpAgentMessage::SetSessionMode(_) => {
            let AcpAgentMessage::SetSessionMode(a) = msg else {
                unreachable!()
            };
            let _ = a.response_tx.send(Err(unsupported()));
            return;
        }
        _ => unreachable!(),
    }
    if let AcpAgentMessage::Prompt(a) = msg {
        let sid = a.request.session_id.clone();
        let turn = {
            let mut c = caps.lock().unwrap();
            // Only sessions successfully created/loaded through this connector are owned.
            if c.models.contains_key(&sid) {
                match c.cursor.begin(&sid) {
                    Ok(turn) => Some(turn),
                    Err(e) => { let _ = a.response_tx.send(Err(e)); return; }
                }
            } else { None }
        };
        let response = acp_send(a.request, &tx).await;
        if let Some(turn) = turn { caps.lock().unwrap().cursor.finish(&sid, &turn); }
        let _ = a.response_tx.send(response);
    } else {
        let _ = tx.send(msg);
    }
}
fn record_models(
    caps: &Mutex<Capabilities>,
    sid: &acp::SessionId,
    models: Option<&acp::SessionModelState>,
) {
    caps.lock().unwrap().models.insert(
        sid.clone(),
        models
            .map(|m| {
                m.available_models
                    .iter()
                    .map(|m| m.model_id.clone())
                    .collect()
            })
            .unwrap_or_default(),
    );
}
fn model_allowed(caps: &Mutex<Capabilities>, sid: &acp::SessionId, model: &acp::ModelId) -> bool {
    caps.lock()
        .unwrap()
        .models
        .get(sid)
        .is_some_and(|models| models.contains(model))
}

async fn incoming(msg: AcpClientMessage, tx: xai_acp_lib::AcpClientTx, caps: Arc<Mutex<Capabilities>>) {
    // Only implemented client capabilities and the narrow, client-local Cursor UX bridge.
    // Unknown blocking requests receive a real denial, never fake success.
    macro_rules! deny {
        ($a:expr) => {{
            let _ = $a.response_tx.send(Err(unsupported()));
        }};
    }
    match msg {
        AcpClientMessage::RequestPermission(mut a) => {
            a.request.meta = None;
            let ids: Vec<_> = a
                .request
                .options
                .iter()
                .map(|o| o.option_id.clone())
                .collect();
            for option in &mut a.request.options {
                option.meta = None;
            }
            let response = acp_send(a.request, &tx).await.map(
                |mut response: acp::RequestPermissionResponse| {
                    response.meta = None;
                    if let acp::RequestPermissionOutcome::Selected(selected) = &response.outcome
                        && !ids.contains(&selected.option_id)
                    {
                        response.outcome = acp::RequestPermissionOutcome::Cancelled;
                    }
                    response
                },
            );
            let _ = a.response_tx.send(response);
        }
        AcpClientMessage::SessionNotification(mut a) => {
            caps.lock().unwrap().cursor.observe(&a.request);
            a.request.meta = None;
            let _ = tx.send(AcpClientMessage::SessionNotification(a));
        }
        AcpClientMessage::ExtMethod(a) => {
            let response = cursor::request(a.request, &tx, &caps).await;
            let _ = a.response_tx.send(response);
        }
        AcpClientMessage::ExtNotification(a) => {
            let _ = a.response_tx.send(cursor::notification(a.request, &tx, &caps));
        }
        AcpClientMessage::ReadTextFile(a) => deny!(a),
        AcpClientMessage::WriteTextFile(a) => deny!(a),
        AcpClientMessage::CreateTerminal(a) => deny!(a),
        AcpClientMessage::TerminalOutput(a) => deny!(a),
        AcpClientMessage::ReleaseTerminal(a) => deny!(a),
        AcpClientMessage::WaitForTerminalExit(a) => deny!(a),
        AcpClientMessage::KillTerminalCommand(a) => deny!(a),
    }
}

struct ProcessTreeGuard(Option<Arc<xai_tty_utils::ProcessGroup>>);
impl ProcessTreeGuard {
    fn kill(&mut self) {
        if let Some(group) = self.0.take() {
            let _ = group.kill();
        }
    }
}
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

/// Drain stderr without retaining/logging credentials or injecting it into ACP stdout.
async fn drain_stderr(mut stderr: tokio::process::ChildStderr) {
    use tokio::io::AsyncReadExt;
    let mut buf = [0u8; 8192];
    while let Ok(n) = stderr.read(&mut buf).await {
        if n == 0 {
            break;
        }
    }
}

fn spawn(
    config: ExternalAgentConfig,
    cancel: CancellationToken,
) -> Result<(AcpClientChannel, std::thread::JoinHandle<Result<()>>)> {
    let (client, mut policy) = acp_channels();
    let thread = std::thread::Builder::new().name("pager-external-acp".into()).spawn(move || {
        let _finished = cancel.clone().drop_guard();
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build()?;
        tokio::task::LocalSet::new().block_on(&rt, async move {
            let mut cmd = tokio::process::Command::new(&config.executable);
            cmd.args(&config.args).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
            // External agents own their login. Do not export xAI/Grok secrets/settings.
            for (key, _) in std::env::vars_os() {
                let upper = key.to_string_lossy().to_ascii_uppercase();
                if upper.starts_with("XAI_") || upper.starts_with("GROK_") { cmd.env_remove(key); }
            }
            let (mut child, process_group) = xai_tty_utils::global_process_scope().spawn(cmd)
                .context("failed to spawn external ACP executable/process group")?;
            let mut tree = ProcessTreeGuard(Some(process_group));
            let stdin = child.stdin.take().context("external ACP stdin missing")?;
            let stdout = child.stdout.take().context("external ACP stdout missing")?;
            tokio::task::spawn_local(drain_stderr(child.stderr.take().context("external ACP stderr missing")?));
            let (mut wire, gateway) = acp_channels();
            let (conn, io) = acp::ClientSideConnection::new(AcpGatewaySender::new(gateway.tx), stdin.compat_write(), LineBufferedRead::spawn_local(stdout.compat()), |f| { tokio::task::spawn_local(f); });
            let gateway_task = tokio::task::spawn_local(AcpGatewayReceiver::new(gateway.rx, conn).run());
            let caps = Arc::new(Mutex::new(Capabilities::default()));
            let disconnect_caps = caps.clone();
            let policy_task = tokio::task::spawn_local(async move {
                loop {
                    tokio::select! {
                        m = policy.rx.recv() => match m { Some(m) => {
                            // Invalidate pending answers before any asynchronously scheduled reply.
                            if let AcpAgentMessage::Cancel(a) = &m { caps.lock().unwrap().cursor.cancel(&a.request.session_id); }
                            tokio::task::spawn_local(forward(m, wire.tx.clone(), caps.clone()));
                        }, None => break },
                        m = wire.rx.recv() => match m {
                            Some(AcpClientMessage::SessionNotification(mut a)) => {
                                caps.lock().unwrap().cursor.observe(&a.request);
                                // Client-local replay stamp for the TUI load barrier; never sent to the agent.
                                a.request.meta = caps.lock().unwrap().replaying.contains(&a.request.session_id)
                                    .then(|| serde_json::json!({"isReplay": true}).as_object().unwrap().clone());
                                let _ = policy.tx.send(AcpClientMessage::SessionNotification(a));
                            }
                            Some(m) => { tokio::task::spawn_local(incoming(m, policy.tx.clone(), caps.clone())); }, None => break
                        },
                    }
                }
                caps.lock().unwrap().cursor.disconnect();
            });
            let result = tokio::select! {
                _ = cancel.cancelled() => Ok(()),
                status = child.wait() => { status.context("external ACP wait failed").and_then(|s| if s.success() { Ok(()) } else { bail!("external ACP exited: {s}") }) },
                result = io => result.context("external ACP transport closed"),
            };
            disconnect_caps.lock().unwrap().cursor.disconnect();
            // Unix process group / Windows Job Object, including adapter descendants.
            tree.kill();
            let _ = child.start_kill();
            let _ = child.wait().await;
            policy_task.abort();
            gateway_task.abort();
            result
        })
    })?;
    Ok((client, thread))
}

pub async fn connect(
    config: ExternalAgentConfig,
    parent: &CancellationToken,
) -> Result<super::AcpConnection> {
    config.validate()?;
    let cancel = parent.child_token();
    // Dropping a timed-out connect future must stop its subprocess too.
    let guard = cancel.clone().drop_guard();
    let (channel, thread) = spawn(config.clone(), cancel.clone())?;
    let response: acp::InitializeResponse = tokio::select! {
        _ = cancel.cancelled() => bail!("external ACP process exited before initialization"),
        r = acp_send(acp::InitializeRequest::new(acp::ProtocolVersion::V1), &channel.tx) => r.context("external ACP initialize failed")?,
    };
    if response.protocol_version != acp::ProtocolVersion::V1 {
        bail!("external ACP protocol version is incompatible");
    }
    let method = match config.auth_method.as_deref() {
        Some(id) => Some(
            response
                .auth_methods
                .iter()
                .find(|m| m.id().0.as_ref() == id)
                .context("configured external ACP auth method was not advertised")?,
        ),
        None => response.auth_methods.first(),
    };
    let login_label = method.map(|m| m.name().to_owned());
    let login_method_id = method.map(|m| m.id().clone());
    let needs_login = method.is_some();
    guard.disarm();
    Ok(super::AcpConnection {
        tx: channel.tx,
        rx: channel.rx,
        models: None.into(),
        is_grok_shell: false,
        auth_methods: response.auth_methods,
        cancel,
        agent_thread: Some(thread),
        available_commands: Vec::new(),
        needs_login,
        login_label,
        login_method_id,
        auth_start_mode: super::AuthStartMode::Command,
        auth_meta: None,
        leader_status_rx: None,
        cancel_rewind_enabled: false,
        session_recap_available: false,
        feedback_trace_offer: false,
        auth_manager: None,
    })
}

#[cfg(all(test, unix))]
mod process_tests;

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn config_and_cli_are_explicit() {
        use clap::Parser;
        let path = std::env::current_exe().unwrap();
        let args = crate::app::cli::PagerArgs::try_parse_from([
            "grok",
            "--acp-executable",
            path.to_str().unwrap(),
            "--acp-arg=--stdio",
            "--acp-auth-method=codex_chatgpt",
        ])
        .unwrap();
        let c = ExternalAgentConfig::resolve(&args, &toml::Value::Table(Default::default()))
            .unwrap()
            .unwrap();
        assert_eq!(c.args, ["--stdio"]);
        assert_eq!(c.auth_method.as_deref(), Some("codex_chatgpt"));
        assert!(c.validate_launch(&args).is_ok());
        let args = crate::app::cli::PagerArgs {
            single: Some("hello".into()),
            ..args
        };
        assert!(c.validate_launch(&args).is_err());
        let bad: toml::Value =
            toml::from_str("[external_acp]\nexecutable = '/node'\nargs = '--stdio'").unwrap();
        assert!(ExternalAgentConfig::resolve(&args, &bad).is_err());
        let native = crate::app::cli::PagerArgs::try_parse_from(["grok"]).unwrap();
        assert!(
            ExternalAgentConfig::resolve(&native, &toml::Value::Table(Default::default()))
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn native_override_ignores_even_invalid_external_config() {
        use clap::Parser;
        let args = crate::app::cli::PagerArgs::try_parse_from(["grok", "--no-external-acp"])
            .unwrap();
        let config: toml::Value = toml::from_str(
            "[external_acp]\nexecutable = 'not-absolute'\nargs = 'invalid-type'",
        ).unwrap();
        assert!(ExternalAgentConfig::resolve(&args, &config).unwrap().is_none());
        let native_default = crate::app::cli::PagerArgs::try_parse_from(["grok"]).unwrap();
        assert!(ExternalAgentConfig::resolve(&native_default, &config).is_err());
        assert!(crate::app::cli::PagerArgs::try_parse_from([
            "grok", "--no-external-acp", "--acp-executable", "/agent",
        ]).is_err());
    }

    #[test]
    fn rejects_path_lookup_and_empty_auth() {
        let mut c = ExternalAgentConfig {
            executable: "agent".into(),
            args: vec![],
            auth_method: None,
        };
        assert!(c.validate().is_err());
        c.executable = std::env::current_exe().unwrap();
        c.args = vec!["a; not a shell".into(), "--literal=$HOME".into()];
        assert!(c.validate().is_ok());
        c.auth_method = Some(" ".into());
        assert!(c.validate().is_err());
    }
    #[tokio::test]
    async fn denies_extensions_without_wire_traffic() {
        let (wire, mut receiver) = acp_channels();
        let (ui, mut policy) = acp_channels();
        let request = acp::ExtRequest::new(
            "x.ai/auth/logout",
            serde_json::value::to_raw_value(&serde_json::json!({}))
                .unwrap()
                .into(),
        );
        let send = acp_send(request, &ui.tx);
        let serve = async {
            forward(policy.rx.recv().await.unwrap(), wire.tx, Arc::default()).await;
            assert!(receiver.rx.try_recv().is_err());
        };
        let (response, _) = tokio::join!(send, serve);
        assert_eq!(
            response.unwrap_err().code,
            acp::ErrorCode::MethodNotFound.into()
        );
    }
    #[tokio::test]
    async fn denies_unknown_client_extensions() {
        let (ui, policy) = acp_channels();
        let (mut wire, gateway) = acp_channels();
        let request = acp::ExtRequest::new(
            "cursor/unknown_method",
            serde_json::value::to_raw_value(&serde_json::json!({}))
                .unwrap()
                .into(),
        );
        let (r, _) = tokio::join!(acp_send(request, &gateway.tx), async {
            incoming(wire.rx.recv().await.unwrap(), policy.tx, Arc::default()).await;
        });
        assert_eq!(r.unwrap_err().code, acp::ErrorCode::MethodNotFound.into());
        drop(ui);
    }

    #[tokio::test]
    async fn denies_unadvertised_resume() {
        let (wire, mut receiver) = acp_channels();
        let (ui, mut policy) = acp_channels();
        let request = acp::LoadSessionRequest::new("outside", std::env::current_dir().unwrap());
        let (r, _) = tokio::join!(acp_send(request, &ui.tx), async {
            forward(policy.rx.recv().await.unwrap(), wire.tx, Arc::default()).await;
            assert!(receiver.rx.try_recv().is_err());
        });
        assert!(r.is_err());
    }
}
