//! Platform backends that turn [`ComputerAction`]s into real input and capture the screen.
//!
//! Every backend shells out to tooling that ships with (or is trivially installed on) the
//! platform instead of linking native input libraries, so the tool compiles identically on
//! all targets and the platform is picked at runtime:
//!
//! * Linux/X11 — `xdotool` for input, one of `scrot` / `maim` / `import` /
//!   `gnome-screenshot` / `spectacle` for capture.
//! * macOS — `screencapture` for capture, `osascript` (JavaScript for Automation with the
//!   CoreGraphics bridge) for input.
//! * Windows — one PowerShell script per call using `user32` P/Invoke and `System.Drawing`.

use std::path::PathBuf;
use std::process::Stdio;
use std::time::Duration;

use async_trait::async_trait;

use super::action::ComputerAction;

/// Why an action or capture could not be carried out.
#[derive(Debug, thiserror::Error)]
pub enum ComputerUseError {
    /// No backend can drive this desktop (unsupported OS, Wayland-only session, no display).
    #[error("computer use is not available here: {0}")]
    Unsupported(String),
    /// A required helper binary is missing.
    #[error("computer use needs `{tool}` but it was not found on PATH. {hint}")]
    MissingDependency { tool: String, hint: String },
    /// A helper process ran but failed.
    #[error("`{program}` failed{}: {stderr}", code.map(|c| format!(" (exit {c})")).unwrap_or_default())]
    Command {
        program: String,
        code: Option<i32>,
        stderr: String,
    },
    /// A helper process exceeded its time budget.
    #[error("`{program}` did not finish within {seconds}s")]
    Timeout { program: String, seconds: u64 },
    /// The model asked for something the backend cannot express.
    #[error("invalid action: {0}")]
    InvalidAction(String),
    #[error("screenshot could not be processed: {0}")]
    Image(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// Screen dimensions in physical pixels.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ScreenSize {
    pub width: u32,
    pub height: u32,
}

/// One action in a batch failed; the actions before `index` ran.
#[derive(Debug)]
pub struct BatchFailure {
    pub index: usize,
    pub error: ComputerUseError,
}

/// A desktop the tool can observe and drive. Coordinates handed to `perform` are already
/// in the backend's screen coordinate space.
#[async_trait]
pub trait ComputerBackend: Send + Sync {
    /// Human-readable backend label for summaries (`"xdotool (X11)"`).
    fn name(&self) -> String;
    async fn screen_size(&self) -> Result<ScreenSize, ComputerUseError>;
    /// Capture the whole primary display as PNG bytes.
    async fn capture_png(&self) -> Result<Vec<u8>, ComputerUseError>;
    /// Execute one action. `Screenshot` is a no-op here (the tool captures once at the end
    /// of the batch) and `Wait` is handled by the default `perform_batch`.
    async fn perform(&self, action: &ComputerAction) -> Result<(), ComputerUseError>;
    /// Execute actions in order, stopping at the first failure. Backends with expensive
    /// process start-up override this to run the whole batch in one helper process.
    async fn perform_batch(&self, actions: &[ComputerAction]) -> Result<(), BatchFailure> {
        for (index, action) in actions.iter().enumerate() {
            match action {
                ComputerAction::Screenshot => {}
                ComputerAction::Wait { ms } => {
                    tokio::time::sleep(Duration::from_millis(*ms)).await;
                }
                other => self
                    .perform(other)
                    .await
                    .map_err(|error| BatchFailure { index, error })?,
            }
        }
        Ok(())
    }
}

/// Default per-process budget. Screenshots and input are fast; PowerShell cold starts
/// are the slow case and stay well within this.
pub const COMMAND_TIMEOUT: Duration = Duration::from_secs(60);

/// Run a helper process to completion, capturing stdout, with a timeout.
pub(super) async fn run_command(
    program: &str,
    args: &[String],
    stdin: Option<&str>,
    env: &[(String, String)],
    timeout: Duration,
) -> Result<Vec<u8>, ComputerUseError> {
    let mut cmd = tokio::process::Command::new(program);
    cmd.args(args)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(if stdin.is_some() {
            Stdio::piped()
        } else {
            Stdio::null()
        })
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    // Short-lived helper (xdotool/scrot/osascript/powershell): waited on below with a
    // timeout, and `kill_on_drop` reaps it if the timeout fires or the call is cancelled.
    #[allow(clippy::disallowed_methods)]
    let mut child = cmd.spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ComputerUseError::MissingDependency {
                tool: program.to_owned(),
                hint: String::new(),
            }
        } else {
            ComputerUseError::Io(e)
        }
    })?;
    if let Some(input) = stdin
        && let Some(mut pipe) = child.stdin.take()
    {
        use tokio::io::AsyncWriteExt as _;
        pipe.write_all(input.as_bytes()).await?;
        drop(pipe);
    }
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| ComputerUseError::Timeout {
            program: program.to_owned(),
            seconds: timeout.as_secs(),
        })??;
    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
        return Err(ComputerUseError::Command {
            program: program.to_owned(),
            code: output.status.code(),
            stderr: if stderr.is_empty() { stdout } else { stderr },
        });
    }
    Ok(output.stdout)
}

/// Locate `program` on PATH.
pub(super) fn find_program(program: &str) -> Option<PathBuf> {
    which::which(program).ok()
}

/// Pick the backend for the current process's platform.
///
/// `display` overrides the X11 `DISPLAY` used by the Linux backend.
pub fn detect_backend(display: Option<&str>) -> Result<Box<dyn ComputerBackend>, ComputerUseError> {
    match std::env::consts::OS {
        "linux" => super::linux::LinuxX11Backend::detect(display).map(|b| Box::new(b) as _),
        "macos" => super::macos::MacOsBackend::detect().map(|b| Box::new(b) as _),
        "windows" => super::windows::WindowsBackend::detect().map(|b| Box::new(b) as _),
        other => Err(ComputerUseError::Unsupported(format!(
            "no desktop backend for {other}"
        ))),
    }
}

/// A test double that records actions and returns a fixed PNG.
#[cfg(test)]
pub(super) mod fake {
    use super::*;
    use std::sync::{Arc, Mutex};

    #[derive(Clone, Default)]
    pub struct FakeBackend {
        pub size: (u32, u32),
        pub png: Vec<u8>,
        pub performed: Arc<Mutex<Vec<ComputerAction>>>,
        pub captures: Arc<Mutex<u32>>,
        pub fail_on: Option<usize>,
    }

    #[async_trait]
    impl ComputerBackend for FakeBackend {
        fn name(&self) -> String {
            "fake".to_owned()
        }
        async fn screen_size(&self) -> Result<ScreenSize, ComputerUseError> {
            Ok(ScreenSize {
                width: self.size.0,
                height: self.size.1,
            })
        }
        async fn capture_png(&self) -> Result<Vec<u8>, ComputerUseError> {
            *self.captures.lock().unwrap() += 1;
            Ok(self.png.clone())
        }
        async fn perform(&self, action: &ComputerAction) -> Result<(), ComputerUseError> {
            let mut performed = self.performed.lock().unwrap();
            if self.fail_on == Some(performed.len()) {
                return Err(ComputerUseError::Command {
                    program: "fake".into(),
                    code: Some(1),
                    stderr: "simulated failure".into(),
                });
            }
            performed.push(action.clone());
            Ok(())
        }
    }
}
