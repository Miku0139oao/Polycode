//! Private, launch-scoped native-leader bootstrap.
//!
//! The only secret-bearing channel is the stdin pipe of our exact executable.
//! A length-delimited bootstrap is consumed before telemetry/runtime/tool startup;
//! the rest of that pipe is a lifetime lease, never ACP or ordinary tool input.
//! Neither a shared leader nor a managed-install replacement binary is eligible.
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::{ChildStdin, Command, Stdio};
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};
use tokio_util::sync::CancellationToken;

pub const BOOTSTRAP_FLAG: &str = "--polycode-leader-bootstrap";
const VERSION: u32 = 1;
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const INVALID_BOOTSTRAP: &str = "Invalid private Polycode leader bootstrap";

// Deliberately no Debug: even an invalid frame must not reach logs or errors.
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Bootstrap {
    version: u32,
    socket: PathBuf,
    bridge: crate::polycode::LeaderBridgeBootstrap,
}

struct Launch {
    socket: PathBuf,
    lease: Mutex<Lease>,
}
#[derive(Default)]
struct Lease {
    closed: bool,
    writers: Vec<(uuid::Uuid, ChildStdin)>,
}
impl Lease {
    fn retain(&mut self, writer: ChildStdin) -> uuid::Uuid {
        let id = uuid::Uuid::new_v4();
        if !self.closed {
            self.writers.push((id, writer));
        }
        id
    }
    fn close(&mut self) {
        self.closed = true;
        self.writers.clear();
    }
}
struct Leader {
    socket: PathBuf,
    owner_gone: CancellationToken,
}
static LAUNCH: OnceLock<Launch> = OnceLock::new();
static LEADER: OnceLock<Leader> = OnceLock::new();

/// Held by main until the native launch ends (including cancelled startup).
/// Closing all leases also shuts down busy leaders and leaders without clients.
pub struct LaunchGuard;
impl Drop for LaunchGuard {
    fn drop(&mut self) {
        if let Some(launch) = LAUNCH.get() {
            launch.lease.lock().expect("leader lease").close();
        }
    }
}

/// An explicit socket is a namespace *hint*, never an address to adopt verbatim.
/// The UUID does not derive from the bridge token, URL, provider, or account.
fn scoped_socket(hint: &Path, id: uuid::Uuid) -> PathBuf {
    let stem = hint
        .file_stem()
        .unwrap_or_else(|| std::ffi::OsStr::new("leader"));
    let mut name = stem.to_os_string();
    name.push(format!("-polycode-{}.sock", id.simple()));
    hint.with_file_name(name)
}

pub fn start_launch(socket_hint: Option<&Path>) -> Result<LaunchGuard, &'static str> {
    if !crate::polycode::enabled() || LEADER.get().is_some() {
        return Err(INVALID_BOOTSTRAP);
    }
    let hint = socket_hint
        .map(Path::to_path_buf)
        .or_else(|| {
            std::env::var_os(super::LEADER_SOCKET_ENV)
                .filter(|v| !v.is_empty())
                .map(PathBuf::from)
        })
        .unwrap_or_else(|| crate::util::grok_home::grok_home().join("leader.sock"));
    let hint = if hint.is_absolute() {
        hint
    } else {
        std::env::current_dir()
            .map_err(|_| INVALID_BOOTSTRAP)?
            .join(hint)
    };
    LAUNCH
        .set(Launch {
            socket: scoped_socket(&hint, uuid::Uuid::new_v4()),
            lease: Mutex::new(Lease::default()),
        })
        .map_err(|_| INVALID_BOOTSTRAP)?;
    Ok(LaunchGuard)
}

/// Process-local override takes precedence over CLI/env paths, in both processes.
/// It is never exported to MCP, shell tools, auth helpers, or other executables.
pub(super) fn socket_override() -> Option<PathBuf> {
    LEADER
        .get()
        .map(|l| l.socket.clone())
        .or_else(|| LAUNCH.get().map(|l| l.socket.clone()))
}

pub(super) fn is_launch() -> bool {
    LAUNCH.get().is_some()
}
pub fn is_bootstrapped_leader() -> bool {
    LEADER.get().is_some()
}

/// Never allow a bridge-enabled client to silently adopt a normal leader.
pub(super) fn require_scope() -> Result<(), &'static str> {
    if crate::polycode::enabled() && socket_override().is_none() {
        Err("Polycode native leader requires a private launch scope")
    } else {
        Ok(())
    }
}

/// This command is intentionally never formatted with Debug or logged.
pub(super) fn prepare_command(cmd: &mut Command) {
    configure_command(cmd, is_launch());
}
fn configure_command(cmd: &mut Command, private: bool) {
    // Defence in depth: even embedders must not reintroduce general token inheritance.
    cmd.env_remove("POLYCODE_BRIDGE_TOKEN");
    if private {
        cmd.arg(BOOTSTRAP_FLAG);
        cmd.env_remove("POLYCODE_BRIDGE_URL");
        cmd.env_remove(super::LEADER_SOCKET_ENV);
        cmd.stdin(Stdio::piped());
    }
}

fn encode_frame(bootstrap: &Bootstrap) -> Result<Vec<u8>, &'static str> {
    let payload = serde_json::to_vec(bootstrap).map_err(|_| INVALID_BOOTSTRAP)?;
    if payload.is_empty() || payload.len() > MAX_FRAME_BYTES {
        return Err(INVALID_BOOTSTRAP);
    }
    let mut frame = Vec::with_capacity(4 + payload.len());
    frame.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    frame.extend_from_slice(&payload);
    Ok(frame)
}
fn read_frame(reader: &mut impl Read) -> Result<Bootstrap, &'static str> {
    let mut length = [0; 4];
    reader
        .read_exact(&mut length)
        .map_err(|_| INVALID_BOOTSTRAP)?;
    let length = u32::from_be_bytes(length) as usize;
    if length == 0 || length > MAX_FRAME_BYTES {
        return Err(INVALID_BOOTSTRAP);
    }
    let mut payload = vec![0; length];
    reader
        .read_exact(&mut payload)
        .map_err(|_| INVALID_BOOTSTRAP)?;
    let bootstrap: Bootstrap = serde_json::from_slice(&payload).map_err(|_| INVALID_BOOTSTRAP)?;
    if bootstrap.version != VERSION || !bootstrap.socket.is_absolute() {
        return Err(INVALID_BOOTSTRAP);
    }
    Ok(bootstrap)
}

pub(super) fn launch_frame() -> Result<Vec<u8>, &'static str> {
    let launch = LAUNCH.get().ok_or(INVALID_BOOTSTRAP)?;
    let bridge = crate::polycode::bridge().ok_or(INVALID_BOOTSTRAP)?;
    encode_frame(&Bootstrap {
        version: VERSION,
        socket: launch.socket.clone(),
        bridge: bridge.leader_bootstrap(),
    })
}

/// Run on the child-reaper thread, not on a Tokio worker. A cancelled launch
/// cannot keep a late bootstrap's writer alive.
pub(super) fn send_and_retain(
    mut writer: ChildStdin,
    frame: &[u8],
) -> Result<uuid::Uuid, &'static str> {
    writer.write_all(frame).map_err(|_| INVALID_BOOTSTRAP)?;
    writer.flush().map_err(|_| INVALID_BOOTSTRAP)?;
    let id = LAUNCH
        .get()
        .ok_or(INVALID_BOOTSTRAP)?
        .lease
        .lock()
        .expect("leader lease")
        .retain(writer);
    Ok(id)
}
pub(super) fn release_lease(id: uuid::Uuid) {
    if let Some(launch) = LAUNCH.get() {
        launch
            .lease
            .lock()
            .expect("leader lease")
            .writers
            .retain(|(key, _)| *key != id);
    }
}

/// Consume exactly one frame synchronously, before any ordinary child can spawn.
/// Call ONLY for the internal agent-leader flag, never based on environment alone.
pub fn consume_stdin() -> Result<(), &'static str> {
    use std::io::IsTerminal;
    if std::io::stdin().is_terminal() || LAUNCH.get().is_some() {
        return Err(INVALID_BOOTSTRAP);
    }
    let bootstrap = read_frame(&mut std::io::stdin().lock())?;
    crate::polycode::enable_from_leader(bootstrap.bridge).map_err(|_| INVALID_BOOTSTRAP)?;
    LEADER
        .set(Leader {
            socket: bootstrap.socket,
            owner_gone: CancellationToken::new(),
        })
        .map_err(|_| INVALID_BOOTSTRAP)?;
    Ok(())
}

/// Start only after main has scrubbed launcher credentials from the environment.
/// No secret remains on stdin; the reader consumes EOF (or fails closed on data).
pub fn watch_owner() {
    if let Some(leader) = LEADER.get() {
        let gone = leader.owner_gone.clone();
        std::thread::spawn(move || {
            wait_for_owner(&mut std::io::stdin().lock(), &gone);
        });
    }
}
fn wait_for_owner(reader: &mut impl Read, gone: &CancellationToken) {
    let mut byte = [0];
    loop {
        match reader.read(&mut byte) {
            Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
            // EOF, failure, or unexpected trailing data all revoke the lease.
            _ => break,
        }
    }
    gone.cancel();
}
/// Revoke the normal leader server token so its ordinary shutdown path (relay
/// stop, lock/socket cleanup) runs before main's bounded shutdown deadline.
pub(super) fn cancel_with_owner(cancel: CancellationToken) {
    if let Some(leader) = LEADER.get() {
        let gone = leader.owner_gone.clone();
        tokio::spawn(async move {
            tokio::select! {
                () = cancel.cancelled() => {},
                () = gone.cancelled() => cancel.cancel(),
            }
        });
    }
}
pub async fn owner_disconnected() {
    match LEADER.get() {
        Some(leader) => leader.owner_gone.cancelled().await,
        None => std::future::pending::<()>().await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    fn bootstrap() -> Bootstrap {
        let bridge = crate::polycode::Bridge::new(
            "http://127.0.0.1:12345",
            "private-bootstrap-test-token".into(),
        )
        .unwrap();
        Bootstrap {
            version: VERSION,
            socket: std::env::temp_dir().join("leader-polycode-test.sock"),
            bridge: bridge.leader_bootstrap(),
        }
    }
    #[test]
    fn bootstrap_roundtrip_is_framed_and_leaves_lifetime_pipe_unread() {
        let expected = bootstrap();
        let mut frame = encode_frame(&expected).unwrap();
        let length = frame.len();
        frame.extend_from_slice(b"lease");
        let mut reader = Cursor::new(frame);
        let actual = read_frame(&mut reader).unwrap();
        assert_eq!(reader.position(), length as u64);
        assert_eq!(actual.socket, expected.socket);
        let bridge = crate::polycode::Bridge::from_leader_bootstrap(actual.bridge).unwrap();
        assert_eq!(bridge.catalog().providers.len(), 0);
        assert!(bridge.owns_endpoint("http://127.0.0.1:12345/codex/v1"));
    }
    #[test]
    fn bootstrap_rejects_truncation_oversize_version_and_relative_socket_without_echoing_input() {
        let mut wrong_version = bootstrap();
        wrong_version.version += 1;
        let mut relative = bootstrap();
        relative.socket = PathBuf::from("relative.sock");
        for input in [
            vec![],
            vec![0, 0, 0, 0],
            vec![255; 4],
            vec![0, 0, 0, 16, b'{'],
            encode_frame(&wrong_version).unwrap(),
            encode_frame(&relative).unwrap(),
        ] {
            let error = read_frame(&mut Cursor::new(input)).err().unwrap();
            assert_eq!(error, INVALID_BOOTSTRAP);
            assert!(!error.contains("private-bootstrap-test-token"));
        }
    }
    #[test]
    fn namespace_never_adopts_explicit_shared_or_other_launch_socket() {
        let shared = std::env::temp_dir().join("leader.sock");
        let a = scoped_socket(&shared, uuid::Uuid::new_v4());
        let b = scoped_socket(&shared, uuid::Uuid::new_v4());
        assert_ne!(a, shared);
        assert_ne!(a, b);
        assert_ne!(a.with_extension("lock"), shared.with_extension("lock"));
        assert_eq!(a.parent(), shared.parent());
    }
    #[test]
    fn owner_eof_and_unexpected_data_revoke_lifetime_without_clients() {
        for input in [b"".as_slice(), b"unexpected".as_slice()] {
            let gone = CancellationToken::new();
            wait_for_owner(&mut Cursor::new(input), &gone);
            assert!(gone.is_cancelled());
        }
    }
    // This entry point is run ONLY in an isolated test subprocess, so the
    // process-local bridge/sampler/leader singletons cannot contaminate tests.
    #[test]
    fn bootstrap_child_entry() {
        if std::env::var_os("POLYCODE_BOOTSTRAP_TEST_CHILD").is_none() {
            return;
        }
        assert!(std::env::var_os("POLYCODE_BRIDGE_TOKEN").is_none());
        consume_stdin().unwrap();
        assert!(is_bootstrapped_leader());
        let expected_socket = std::env::temp_dir().join("leader-polycode-test.sock");
        assert_eq!(socket_override().unwrap(), expected_socket);
        let lock = super::super::LeaderLock::new("wss://unrelated.example/relay");
        assert_eq!(lock.socket_path(), &expected_socket);
        assert_eq!(lock.lock_path(), &expected_socket.with_extension("lock"));
        assert!(crate::polycode::enabled());
        assert!(
            crate::polycode::bridge()
                .unwrap()
                .owns_endpoint("http://127.0.0.1:12345/cursor/v1")
        );
        println!("private-bootstrap-ready");
        std::io::stdout().flush().unwrap();
        watch_owner();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let server_cancel = CancellationToken::new();
            cancel_with_owner(server_cancel.clone());
            tokio::time::timeout(
                std::time::Duration::from_secs(10),
                server_cancel.cancelled(),
            )
            .await
            .unwrap();
            assert!(LEADER.get().unwrap().owner_gone.is_cancelled());
        });
    }
    #[test]
    fn private_pipe_process_bootstrap_and_lease_revocation() {
        use std::io::BufRead;
        let mut cmd = Command::new(std::env::current_exe().unwrap());
        cmd.args([
            "--exact",
            "leader::polycode_bootstrap::tests::bootstrap_child_entry",
            "--nocapture",
        ])
        .env("POLYCODE_BOOTSTRAP_TEST_CHILD", "1")
        .env(
            super::super::LEADER_SOCKET_ENV,
            "incompatible-shared-leader.sock",
        )
        .env("POLYCODE_BRIDGE_TOKEN", "private-bootstrap-test-token")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
        // The test executable uses libtest's flags, not the production CLI.
        cmd.env_remove("POLYCODE_BRIDGE_TOKEN");
        let mut child = cmd.spawn().unwrap();
        let mut lease = Lease::default();
        let mut pipe = child.stdin.take().unwrap();
        pipe.write_all(&encode_frame(&bootstrap()).unwrap())
            .unwrap();
        lease.retain(pipe);
        let mut output = std::io::BufReader::new(child.stdout.take().unwrap());
        let mut line = String::new();
        loop {
            line.clear();
            assert_ne!(
                output.read_line(&mut line).unwrap(),
                0,
                "child exited before bootstrap"
            );
            if line.contains("private-bootstrap-ready") {
                break;
            }
        }
        assert!(
            child.try_wait().unwrap().is_none(),
            "leader must outlive bootstrap while owner is present"
        );
        lease.close();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                assert!(status.success(), "bootstrap subprocess failed");
                break;
            }
            if std::time::Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!("leader did not exit on owner lease revocation");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(lease.closed);
        assert!(lease.writers.is_empty());
    }
    #[test]
    fn private_spawn_uses_only_a_nonsecret_flag_and_scrubs_bridge_environment() {
        let mut cmd = Command::new("unused-test-executable");
        cmd.env("POLYCODE_BRIDGE_TOKEN", "private-bootstrap-test-token");
        cmd.env("POLYCODE_BRIDGE_URL", "http://127.0.0.1:12345");
        cmd.env(super::super::LEADER_SOCKET_ENV, "shared-leader.sock");
        configure_command(&mut cmd, true);
        assert_eq!(
            cmd.get_args().collect::<Vec<_>>(),
            vec![std::ffi::OsStr::new(BOOTSTRAP_FLAG)]
        );
        for key in [
            "POLYCODE_BRIDGE_TOKEN",
            "POLYCODE_BRIDGE_URL",
            super::super::LEADER_SOCKET_ENV,
        ] {
            assert!(cmd.get_envs().any(|(k, v)| k == key && v.is_none()));
        }
        assert!(!format!("{cmd:?}").contains("private-bootstrap-test-token"));
    }
    #[test]
    fn spawn_always_scrubs_general_child_token_inheritance() {
        let mut cmd = Command::new("unused-test-executable");
        cmd.env("POLYCODE_BRIDGE_TOKEN", "private-bootstrap-test-token");
        prepare_command(&mut cmd);
        assert!(
            cmd.get_envs()
                .any(|(key, value)| key == "POLYCODE_BRIDGE_TOKEN" && value.is_none())
        );
        assert!(!format!("{cmd:?}").contains("private-bootstrap-test-token"));
    }
}
