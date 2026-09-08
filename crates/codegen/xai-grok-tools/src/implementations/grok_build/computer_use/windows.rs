//! Windows backend: one PowerShell process per call. `user32` P/Invoke drives the mouse,
//! `System.Windows.Forms.SendKeys` drives the keyboard, and `System.Drawing` captures the
//! screen. Nothing needs to be installed; `powershell.exe` ships with every supported
//! Windows and `pwsh` is used when it is the only one on PATH.
//!
//! PowerShell start-up dominates latency, so [`ComputerBackend::perform_batch`] compiles the
//! whole action batch into a single script instead of one process per action.

use async_trait::async_trait;

use super::action::{ComputerAction, MouseButton};
use super::backend::{
    BatchFailure, COMMAND_TIMEOUT, ComputerBackend, ComputerUseError, ScreenSize, find_program,
    run_command,
};
use super::keys::{Key, parse_chord};

/// P/Invoke declarations plus DPI awareness so coordinates are physical pixels.
const PRELUDE: &str = r#"$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace PolycodeCU -Name Native -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, int data, System.UIntPtr extra);
'@
[void][PolycodeCU.Native]::SetProcessDPIAware()
function MouseAt($x, $y) { [void][PolycodeCU.Native]::SetCursorPos($x, $y); Start-Sleep -Milliseconds 15 }
function MouseEvent($flags, $data) { [PolycodeCU.Native]::mouse_event($flags, 0, 0, $data, [System.UIntPtr]::Zero) }
function SendKeys($s) { [System.Windows.Forms.SendKeys]::SendWait($s) }
"#;

// mouse_event flags.
const LEFT_DOWN: u32 = 0x0002;
const LEFT_UP: u32 = 0x0004;
const RIGHT_DOWN: u32 = 0x0008;
const RIGHT_UP: u32 = 0x0010;
const MIDDLE_DOWN: u32 = 0x0020;
const MIDDLE_UP: u32 = 0x0040;
const X_DOWN: u32 = 0x0080;
const X_UP: u32 = 0x0100;
const WHEEL: u32 = 0x0800;
const HWHEEL: u32 = 0x1000;
const WHEEL_DELTA: i64 = 120;

pub struct WindowsBackend {
    shell: String,
}

impl WindowsBackend {
    pub fn detect() -> Result<Self, ComputerUseError> {
        let shell = ["powershell", "pwsh"]
            .into_iter()
            .find(|bin| find_program(bin).is_some())
            .ok_or_else(|| ComputerUseError::MissingDependency {
                tool: "powershell".to_owned(),
                hint: "Windows PowerShell or PowerShell 7 (`pwsh`) must be on PATH.".to_owned(),
            })?;
        Ok(Self {
            shell: shell.to_owned(),
        })
    }

    async fn run_script(&self, script: &str) -> Result<String, ComputerUseError> {
        let args: Vec<String> = [
            "-NoProfile",
            "-NonInteractive",
            "-ExecutionPolicy",
            "Bypass",
            "-Command",
            "-",
        ]
        .into_iter()
        .map(str::to_owned)
        .collect();
        let out = run_command(&self.shell, &args, Some(script), &[], COMMAND_TIMEOUT).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

/// (down flags, up flags, dwData) for a button.
fn button_events(button: MouseButton) -> (u32, u32, i32) {
    match button {
        MouseButton::Left => (LEFT_DOWN, LEFT_UP, 0),
        MouseButton::Right => (RIGHT_DOWN, RIGHT_UP, 0),
        MouseButton::Middle => (MIDDLE_DOWN, MIDDLE_UP, 0),
        MouseButton::Back => (X_DOWN, X_UP, 1),
        MouseButton::Forward => (X_DOWN, X_UP, 2),
    }
}

/// Escape literal text for `SendKeys` (`+ ^ % ~ ( ) { } [ ]` are control characters).
pub(super) fn sendkeys_escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len() + 8);
    for c in text.chars() {
        match c {
            '+' | '^' | '%' | '~' | '(' | ')' | '{' | '}' | '[' | ']' => {
                out.push('{');
                out.push(c);
                out.push('}');
            }
            '\n' => out.push_str("{ENTER}"),
            '\r' => {}
            '\t' => out.push_str("{TAB}"),
            other => out.push(other),
        }
    }
    out
}

/// `SendKeys` token for a non-modifier key.
fn sendkeys_token(key: &Key) -> Option<String> {
    Some(match key {
        Key::Enter => "{ENTER}".into(),
        Key::Escape => "{ESC}".into(),
        Key::Tab => "{TAB}".into(),
        Key::Space => " ".into(),
        Key::Backspace => "{BACKSPACE}".into(),
        Key::Delete => "{DELETE}".into(),
        Key::Insert => "{INSERT}".into(),
        Key::Up => "{UP}".into(),
        Key::Down => "{DOWN}".into(),
        Key::Left => "{LEFT}".into(),
        Key::Right => "{RIGHT}".into(),
        Key::Home => "{HOME}".into(),
        Key::End => "{END}".into(),
        Key::PageUp => "{PGUP}".into(),
        Key::PageDown => "{PGDN}".into(),
        Key::CapsLock => "{CAPSLOCK}".into(),
        Key::PrintScreen => "{PRTSC}".into(),
        Key::Function(n) if (1..=16).contains(n) => format!("{{F{n}}}"),
        Key::Function(_) => return None,
        Key::Char(c) => sendkeys_escape(&c.to_string()),
        Key::Ctrl | Key::Alt | Key::Shift | Key::Meta => return None,
    })
}

/// Single-quoted PowerShell string literal.
fn ps_string(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// PowerShell statements for one action (pure, for tests). Empty for observations.
pub(super) fn ps_statements(action: &ComputerAction) -> Result<String, ComputerUseError> {
    let mut s = String::new();
    match action {
        ComputerAction::Screenshot => {}
        ComputerAction::Wait { ms } => s.push_str(&format!("Start-Sleep -Milliseconds {ms}\n")),
        ComputerAction::Move { x, y } => s.push_str(&format!("MouseAt {x} {y}\n")),
        ComputerAction::Click { x, y, button } => {
            let (down, up, data) = button_events(*button);
            s.push_str(&format!(
                "MouseAt {x} {y}\nMouseEvent {down} {data}\nMouseEvent {up} {data}\n"
            ));
        }
        ComputerAction::DoubleClick { x, y } => {
            s.push_str(&format!(
                "MouseAt {x} {y}\nMouseEvent {LEFT_DOWN} 0\nMouseEvent {LEFT_UP} 0\n\
                 Start-Sleep -Milliseconds 60\nMouseEvent {LEFT_DOWN} 0\nMouseEvent {LEFT_UP} 0\n"
            ));
        }
        ComputerAction::Drag { path } => {
            let first = path
                .first()
                .ok_or_else(|| ComputerUseError::InvalidAction("empty drag path".into()))?;
            s.push_str(&format!(
                "MouseAt {} {}\nMouseEvent {LEFT_DOWN} 0\n",
                first.x, first.y
            ));
            for p in &path[1..] {
                s.push_str(&format!("MouseAt {} {}\n", p.x, p.y));
            }
            s.push_str(&format!("MouseEvent {LEFT_UP} 0\n"));
        }
        ComputerAction::Scroll {
            x,
            y,
            scroll_x,
            scroll_y,
        } => {
            s.push_str(&format!("MouseAt {x} {y}\n"));
            // Windows: positive wheel data scrolls up / left, so invert the model's sign.
            if *scroll_y != 0 {
                s.push_str(&format!(
                    "MouseEvent {WHEEL} {}\n",
                    -(*scroll_y).clamp(-50, 50) * WHEEL_DELTA
                ));
            }
            if *scroll_x != 0 {
                s.push_str(&format!(
                    "MouseEvent {HWHEEL} {}\n",
                    (*scroll_x).clamp(-50, 50) * WHEEL_DELTA
                ));
            }
        }
        ComputerAction::Keypress { keys } => {
            let chord = parse_chord(keys).map_err(ComputerUseError::InvalidAction)?;
            let mut seq = String::new();
            let mut win = false;
            for key in &chord {
                match key {
                    Key::Ctrl => seq.push('^'),
                    Key::Alt => seq.push('%'),
                    Key::Shift => seq.push('+'),
                    Key::Meta => win = true,
                    _ => {}
                }
            }
            let main = chord.iter().find(|k| !k.is_modifier()).ok_or_else(|| {
                ComputerUseError::InvalidAction(
                    "keypress needs a non-modifier key (e.g. [\"ctrl\", \"l\"])".into(),
                )
            })?;
            if win {
                // SendKeys has no Windows-key modifier; Ctrl+Esc opens the Start menu, which
                // is the only Win chord that maps cleanly.
                if matches!(main, Key::Escape) || chord.len() == 1 {
                    seq = "^{ESC}".to_owned();
                } else {
                    return Err(ComputerUseError::InvalidAction(
                        "Windows-key chords other than opening Start are not supported via SendKeys"
                            .into(),
                    ));
                }
            } else {
                let token = sendkeys_token(main).ok_or_else(|| {
                    ComputerUseError::InvalidAction(format!("{main:?} has no SendKeys token"))
                })?;
                seq.push_str(&token);
            }
            s.push_str(&format!("SendKeys {}\n", ps_string(&seq)));
        }
        ComputerAction::Type { text } => {
            s.push_str(&format!("SendKeys {}\n", ps_string(&sendkeys_escape(text))));
        }
    }
    Ok(s)
}

#[async_trait]
impl ComputerBackend for WindowsBackend {
    fn name(&self) -> String {
        format!("{} + user32/SendKeys (Windows)", self.shell)
    }

    async fn screen_size(&self) -> Result<ScreenSize, ComputerUseError> {
        let script = format!(
            "{PRELUDE}$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n\
             Write-Output \"$($b.Width) $($b.Height)\""
        );
        let out = self.run_script(&script).await?;
        let mut parts = out.split_whitespace();
        let (Some(w), Some(h)) = (
            parts.next().and_then(|v| v.parse().ok()),
            parts.next().and_then(|v| v.parse().ok()),
        ) else {
            return Err(ComputerUseError::Command {
                program: self.shell.clone(),
                code: None,
                stderr: format!("unexpected screen size output {out:?}"),
            });
        };
        Ok(ScreenSize {
            width: w,
            height: h,
        })
    }

    async fn capture_png(&self) -> Result<Vec<u8>, ComputerUseError> {
        let file = tempfile::Builder::new()
            .prefix("polycode-screen-")
            .suffix(".png")
            .tempfile()?;
        let path = file.path().to_string_lossy().into_owned();
        let script = format!(
            "{PRELUDE}$b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n\
             $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height\n\
             $g = [System.Drawing.Graphics]::FromImage($bmp)\n\
             $g.CopyFromScreen($b.Location, [System.Drawing.Point]::Empty, $b.Size)\n\
             $bmp.Save({}, [System.Drawing.Imaging.ImageFormat]::Png)\n\
             $g.Dispose(); $bmp.Dispose()",
            ps_string(&path)
        );
        self.run_script(&script).await?;
        let bytes = tokio::fs::read(file.path()).await?;
        if bytes.is_empty() {
            return Err(ComputerUseError::Image(
                "PowerShell wrote an empty screenshot".into(),
            ));
        }
        Ok(bytes)
    }

    async fn perform(&self, action: &ComputerAction) -> Result<(), ComputerUseError> {
        let body = ps_statements(action)?;
        if body.is_empty() {
            return Ok(());
        }
        self.run_script(&format!("{PRELUDE}{body}"))
            .await
            .map(|_| ())
    }

    async fn perform_batch(&self, actions: &[ComputerAction]) -> Result<(), BatchFailure> {
        let mut body = String::new();
        for (index, action) in actions.iter().enumerate() {
            body.push_str(&ps_statements(action).map_err(|error| BatchFailure { index, error })?);
        }
        if body.is_empty() {
            return Ok(());
        }
        self.run_script(&format!("{PRELUDE}{body}"))
            .await
            .map(|_| ())
            .map_err(|error| BatchFailure {
                index: actions.len().saturating_sub(1),
                error,
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_moves_then_presses_and_releases() {
        let s = ps_statements(&ComputerAction::Click {
            x: 10,
            y: 20,
            button: MouseButton::Right,
        })
        .unwrap();
        assert_eq!(s, "MouseAt 10 20\nMouseEvent 8 0\nMouseEvent 16 0\n");
        let s = ps_statements(&ComputerAction::Click {
            x: 1,
            y: 1,
            button: MouseButton::Forward,
        })
        .unwrap();
        assert!(s.contains("MouseEvent 128 2"));
    }

    #[test]
    fn scroll_inverts_vertical_sign() {
        let s = ps_statements(&ComputerAction::Scroll {
            x: 5,
            y: 5,
            scroll_x: 0,
            scroll_y: 3,
        })
        .unwrap();
        assert!(s.contains("MouseEvent 2048 -360"));
    }

    #[test]
    fn keypress_builds_sendkeys_chord() {
        let s = ps_statements(&ComputerAction::Keypress {
            keys: vec!["ctrl".into(), "shift".into(), "t".into()],
        })
        .unwrap();
        assert_eq!(s, "SendKeys '^+t'\n");
        let s = ps_statements(&ComputerAction::Keypress {
            keys: vec!["enter".into()],
        })
        .unwrap();
        assert_eq!(s, "SendKeys '{ENTER}'\n");
        assert!(
            ps_statements(&ComputerAction::Keypress {
                keys: vec!["win".into(), "r".into()]
            })
            .is_err()
        );
    }

    #[test]
    fn type_escapes_sendkeys_metacharacters_and_quotes() {
        let s = ps_statements(&ComputerAction::Type {
            text: "a+b (c) it's\n".into(),
        })
        .unwrap();
        assert_eq!(s, "SendKeys 'a{+}b {(}c{)} it''s{ENTER}'\n");
    }
}
