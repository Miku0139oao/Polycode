//! Linux/X11 backend: `xdotool` for input, a screenshot CLI for capture.

use async_trait::async_trait;

use super::action::{ComputerAction, MouseButton};
use super::backend::{
    COMMAND_TIMEOUT, ComputerBackend, ComputerUseError, ScreenSize, find_program, run_command,
};
use super::keys::{Key, parse_chord};

/// Screenshot CLIs in preference order, with the arguments that write a PNG to a path.
const SCREENSHOT_TOOLS: &[(&str, &[&str])] = &[
    ("scrot", &["-o"]),
    ("maim", &[]),
    ("import", &["-window", "root"]),
    ("gnome-screenshot", &["-f"]),
    ("spectacle", &["-b", "-n", "-o"]),
];

pub struct LinuxX11Backend {
    screenshot_tool: (String, Vec<String>),
    env: Vec<(String, String)>,
}

impl LinuxX11Backend {
    pub fn detect(display: Option<&str>) -> Result<Self, ComputerUseError> {
        let display = display
            .map(str::to_owned)
            .or_else(|| std::env::var("DISPLAY").ok())
            .filter(|d| !d.is_empty());
        let Some(display) = display else {
            let wayland = std::env::var("WAYLAND_DISPLAY").is_ok_and(|w| !w.is_empty());
            return Err(ComputerUseError::Unsupported(if wayland {
                "this is a Wayland session without an X11 DISPLAY; computer use needs XWayland \
                 (set DISPLAY) or an X11 session"
                    .to_owned()
            } else {
                "no DISPLAY is set; computer use needs a running X11 desktop".to_owned()
            }));
        };
        if find_program("xdotool").is_none() {
            return Err(ComputerUseError::MissingDependency {
                tool: "xdotool".to_owned(),
                hint: "Install it with your package manager (e.g. `sudo apt install xdotool`)."
                    .to_owned(),
            });
        }
        let screenshot_tool = SCREENSHOT_TOOLS
            .iter()
            .find(|(bin, _)| find_program(bin).is_some())
            .map(|(bin, args)| {
                (
                    (*bin).to_owned(),
                    args.iter().map(|a| (*a).to_owned()).collect(),
                )
            })
            .ok_or_else(|| ComputerUseError::MissingDependency {
                tool: "scrot".to_owned(),
                hint: format!(
                    "Install one screenshot tool: {}.",
                    SCREENSHOT_TOOLS
                        .iter()
                        .map(|(b, _)| *b)
                        .collect::<Vec<_>>()
                        .join(", ")
                ),
            })?;
        Ok(Self {
            screenshot_tool,
            env: vec![("DISPLAY".to_owned(), display)],
        })
    }

    async fn xdotool(&self, args: Vec<String>) -> Result<String, ComputerUseError> {
        let out = run_command("xdotool", &args, None, &self.env, COMMAND_TIMEOUT).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

fn button_number(button: MouseButton) -> &'static str {
    match button {
        MouseButton::Left => "1",
        MouseButton::Middle => "2",
        MouseButton::Right => "3",
        MouseButton::Back => "8",
        MouseButton::Forward => "9",
    }
}

/// X keysym for a canonical key.
pub(super) fn keysym(key: &Key) -> String {
    match key {
        Key::Ctrl => "ctrl".into(),
        Key::Alt => "alt".into(),
        Key::Shift => "shift".into(),
        Key::Meta => "super".into(),
        Key::Enter => "Return".into(),
        Key::Escape => "Escape".into(),
        Key::Tab => "Tab".into(),
        Key::Space => "space".into(),
        Key::Backspace => "BackSpace".into(),
        Key::Delete => "Delete".into(),
        Key::Insert => "Insert".into(),
        Key::Up => "Up".into(),
        Key::Down => "Down".into(),
        Key::Left => "Left".into(),
        Key::Right => "Right".into(),
        Key::Home => "Home".into(),
        Key::End => "End".into(),
        Key::PageUp => "Prior".into(),
        Key::PageDown => "Next".into(),
        Key::CapsLock => "Caps_Lock".into(),
        Key::PrintScreen => "Print".into(),
        Key::Function(n) => format!("F{n}"),
        Key::Char(c) => match c {
            '+' => "plus".into(),
            '-' => "minus".into(),
            '=' => "equal".into(),
            '/' => "slash".into(),
            '\\' => "backslash".into(),
            '.' => "period".into(),
            ',' => "comma".into(),
            ';' => "semicolon".into(),
            '\'' => "apostrophe".into(),
            '`' => "grave".into(),
            '[' => "bracketleft".into(),
            ']' => "bracketright".into(),
            other => other.to_string(),
        },
    }
}

/// Build the `xdotool` argument list for one action (pure, for tests).
pub(super) fn xdotool_args(action: &ComputerAction) -> Result<Vec<String>, ComputerUseError> {
    let s = |v: i64| v.to_string();
    let args: Vec<String> = match action {
        ComputerAction::Screenshot | ComputerAction::Wait { .. } => Vec::new(),
        ComputerAction::Move { x, y } => vec!["mousemove".into(), s(*x), s(*y)],
        ComputerAction::Click { x, y, button } => vec![
            "mousemove".into(),
            s(*x),
            s(*y),
            "click".into(),
            button_number(*button).into(),
        ],
        ComputerAction::DoubleClick { x, y } => vec![
            "mousemove".into(),
            s(*x),
            s(*y),
            "click".into(),
            "--repeat".into(),
            "2".into(),
            "--delay".into(),
            "80".into(),
            "1".into(),
        ],
        ComputerAction::Drag { path } => {
            let mut v = Vec::new();
            let first = path
                .first()
                .ok_or_else(|| ComputerUseError::InvalidAction("empty drag path".into()))?;
            v.extend(["mousemove".to_owned(), s(first.x), s(first.y)]);
            v.extend(["mousedown".to_owned(), "1".to_owned()]);
            for p in &path[1..] {
                v.extend(["mousemove".to_owned(), s(p.x), s(p.y)]);
            }
            v.extend(["mouseup".to_owned(), "1".to_owned()]);
            v
        }
        ComputerAction::Scroll {
            x,
            y,
            scroll_x,
            scroll_y,
        } => {
            let mut v = vec!["mousemove".to_owned(), s(*x), s(*y)];
            // X wheel buttons: 4 up, 5 down, 6 left, 7 right.
            for (amount, neg, pos) in [(*scroll_y, "4", "5"), (*scroll_x, "6", "7")] {
                if amount == 0 {
                    continue;
                }
                let button = if amount < 0 { neg } else { pos };
                v.extend([
                    "click".to_owned(),
                    "--repeat".to_owned(),
                    amount.unsigned_abs().min(50).to_string(),
                    "--delay".to_owned(),
                    "20".to_owned(),
                    button.to_owned(),
                ]);
            }
            v
        }
        ComputerAction::Keypress { keys } => {
            let chord = parse_chord(keys).map_err(ComputerUseError::InvalidAction)?;
            let combo = chord.iter().map(keysym).collect::<Vec<_>>().join("+");
            vec!["key".into(), "--clearmodifiers".into(), combo]
        }
        ComputerAction::Type { text } => vec![
            "type".into(),
            "--delay".into(),
            "12".into(),
            "--".into(),
            text.clone(),
        ],
    };
    Ok(args)
}

#[async_trait]
impl ComputerBackend for LinuxX11Backend {
    fn name(&self) -> String {
        format!("xdotool + {} (X11)", self.screenshot_tool.0)
    }

    async fn screen_size(&self) -> Result<ScreenSize, ComputerUseError> {
        let out = self.xdotool(vec!["getdisplaygeometry".into()]).await?;
        let mut parts = out.split_whitespace();
        let (Some(w), Some(h)) = (
            parts.next().and_then(|v| v.parse().ok()),
            parts.next().and_then(|v| v.parse().ok()),
        ) else {
            return Err(ComputerUseError::Command {
                program: "xdotool getdisplaygeometry".into(),
                code: None,
                stderr: format!("unexpected output {out:?}"),
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
        let (bin, base_args) = &self.screenshot_tool;
        let mut args = base_args.clone();
        args.push(path);
        run_command(bin, &args, None, &self.env, COMMAND_TIMEOUT).await?;
        let bytes = tokio::fs::read(file.path()).await?;
        if bytes.is_empty() {
            return Err(ComputerUseError::Image(format!(
                "{bin} wrote an empty file"
            )));
        }
        Ok(bytes)
    }

    async fn perform(&self, action: &ComputerAction) -> Result<(), ComputerUseError> {
        let args = xdotool_args(action)?;
        if args.is_empty() {
            return Ok(());
        }
        self.xdotool(args).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::implementations::grok_build::computer_use::action::Point;

    fn strs(v: &[String]) -> Vec<&str> {
        v.iter().map(String::as_str).collect()
    }

    #[test]
    fn click_and_move_args() {
        let a = xdotool_args(&ComputerAction::Click {
            x: 10,
            y: 20,
            button: MouseButton::Right,
        })
        .unwrap();
        assert_eq!(strs(&a), ["mousemove", "10", "20", "click", "3"]);
        let m = xdotool_args(&ComputerAction::Move { x: 1, y: 2 }).unwrap();
        assert_eq!(strs(&m), ["mousemove", "1", "2"]);
    }

    #[test]
    fn drag_chains_down_moves_up() {
        let a = xdotool_args(&ComputerAction::Drag {
            path: vec![
                Point { x: 1, y: 1 },
                Point { x: 5, y: 5 },
                Point { x: 9, y: 9 },
            ],
        })
        .unwrap();
        assert_eq!(
            strs(&a),
            [
                "mousemove",
                "1",
                "1",
                "mousedown",
                "1",
                "mousemove",
                "5",
                "5",
                "mousemove",
                "9",
                "9",
                "mouseup",
                "1"
            ]
        );
    }

    #[test]
    fn scroll_maps_sign_to_wheel_buttons() {
        let a = xdotool_args(&ComputerAction::Scroll {
            x: 3,
            y: 4,
            scroll_x: 0,
            scroll_y: -5,
        })
        .unwrap();
        assert_eq!(
            strs(&a),
            [
                "mousemove",
                "3",
                "4",
                "click",
                "--repeat",
                "5",
                "--delay",
                "20",
                "4"
            ]
        );
        let a = xdotool_args(&ComputerAction::Scroll {
            x: 3,
            y: 4,
            scroll_x: 2,
            scroll_y: 0,
        })
        .unwrap();
        assert_eq!(a[a.len() - 1], "7");
    }

    #[test]
    fn keypress_uses_keysyms_with_modifiers_first() {
        let a = xdotool_args(&ComputerAction::Keypress {
            keys: vec!["l".into(), "CTRL".into()],
        })
        .unwrap();
        assert_eq!(strs(&a), ["key", "--clearmodifiers", "ctrl+l"]);
        let a = xdotool_args(&ComputerAction::Keypress {
            keys: vec!["cmd+enter".into()],
        })
        .unwrap();
        assert_eq!(a[2], "super+Return");
        assert_eq!(keysym(&Key::Char('/')), "slash");
        assert!(
            xdotool_args(&ComputerAction::Keypress {
                keys: vec!["bogus".into()]
            })
            .is_err()
        );
    }

    #[test]
    fn type_guards_leading_dashes() {
        let a = xdotool_args(&ComputerAction::Type {
            text: "-rf /".into(),
        })
        .unwrap();
        assert_eq!(strs(&a), ["type", "--delay", "12", "--", "-rf /"]);
    }
}
