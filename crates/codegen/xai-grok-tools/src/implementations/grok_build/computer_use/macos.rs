//! macOS backend: `screencapture` for capture, `osascript` (JavaScript for Automation) for
//! input. Mouse events go through CoreGraphics via the ObjC bridge; keys go through System
//! Events. Screen Recording and Accessibility permissions must be granted to the terminal
//! that runs Polycode, exactly as for Codex's Computer Use.
//!
//! Coordinates are in points (the CoreGraphics global display space); the tool resizes the
//! Retina capture to that space so screenshot pixels and click coordinates line up.

use async_trait::async_trait;

use super::action::{ComputerAction, MouseButton};
use super::backend::{
    COMMAND_TIMEOUT, ComputerBackend, ComputerUseError, ScreenSize, find_program, run_command,
};
use super::keys::{Key, parse_chord};

pub struct MacOsBackend;

impl MacOsBackend {
    pub fn detect() -> Result<Self, ComputerUseError> {
        for tool in ["osascript", "screencapture"] {
            if find_program(tool).is_none() {
                return Err(ComputerUseError::MissingDependency {
                    tool: tool.to_owned(),
                    hint: "It ships with macOS; check PATH.".to_owned(),
                });
            }
        }
        Ok(Self)
    }

    async fn jxa(&self, script: &str) -> Result<String, ComputerUseError> {
        let args = vec!["-l".to_owned(), "JavaScript".to_owned()];
        let out = run_command("osascript", &args, Some(script), &[], COMMAND_TIMEOUT).await?;
        Ok(String::from_utf8_lossy(&out).into_owned())
    }
}

// CoreGraphics constants (CGEventType / CGMouseButton), spelled numerically because the
// bridged enum names are not reliably exported to JXA.
const LEFT_DOWN: u32 = 1;
const LEFT_UP: u32 = 2;
const RIGHT_DOWN: u32 = 3;
const RIGHT_UP: u32 = 4;
const MOUSE_MOVED: u32 = 5;
const LEFT_DRAGGED: u32 = 6;
const OTHER_DOWN: u32 = 25;
const OTHER_UP: u32 = 26;

const PRELUDE: &str = r#"ObjC.import('CoreGraphics');
function pt(x, y) { return $.CGPointMake(x, y); }
function post(e) { $.CGEventPost(0, e); }
function mouse(type, x, y, button, clicks) {
  var e = $.CGEventCreateMouseEvent(null, type, pt(x, y), button);
  if (clicks) { $.CGEventSetIntegerValueField(e, 1, clicks); }
  post(e);
}
function sleep(ms) { $.NSThread.sleepForTimeInterval(ms / 1000.0); }
"#;

fn button_codes(button: MouseButton) -> (u32, u32, u32) {
    match button {
        MouseButton::Left => (LEFT_DOWN, LEFT_UP, 0),
        MouseButton::Right => (RIGHT_DOWN, RIGHT_UP, 1),
        MouseButton::Middle => (OTHER_DOWN, OTHER_UP, 2),
        MouseButton::Back => (OTHER_DOWN, OTHER_UP, 3),
        MouseButton::Forward => (OTHER_DOWN, OTHER_UP, 4),
    }
}

/// System Events key code for a non-character key.
fn key_code(key: &Key) -> Option<u16> {
    Some(match key {
        Key::Enter => 36,
        Key::Escape => 53,
        Key::Tab => 48,
        Key::Space => 49,
        Key::Backspace => 51,
        Key::Delete => 117,
        Key::Insert => 114,
        Key::Up => 126,
        Key::Down => 125,
        Key::Left => 123,
        Key::Right => 124,
        Key::Home => 115,
        Key::End => 119,
        Key::PageUp => 116,
        Key::PageDown => 121,
        Key::CapsLock => 57,
        Key::PrintScreen => return None,
        Key::Function(n) => match n {
            1 => 122,
            2 => 120,
            3 => 99,
            4 => 118,
            5 => 96,
            6 => 97,
            7 => 98,
            8 => 100,
            9 => 101,
            10 => 109,
            11 => 103,
            12 => 111,
            13 => 105,
            14 => 107,
            15 => 113,
            16 => 106,
            17 => 64,
            18 => 79,
            19 => 80,
            20 => 90,
            _ => return None,
        },
        Key::Ctrl | Key::Alt | Key::Shift | Key::Meta | Key::Char(_) => return None,
    })
}

fn modifier_name(key: &Key) -> Option<&'static str> {
    Some(match key {
        Key::Ctrl => "control down",
        Key::Alt => "option down",
        Key::Shift => "shift down",
        Key::Meta => "command down",
        _ => return None,
    })
}

fn js_string(s: &str) -> String {
    serde_json::to_string(s).unwrap_or_else(|_| "\"\"".to_owned())
}

/// Build the JXA program for one action (pure, for tests).
pub(super) fn jxa_script(action: &ComputerAction) -> Result<String, ComputerUseError> {
    let mut body = String::new();
    match action {
        ComputerAction::Screenshot | ComputerAction::Wait { .. } => return Ok(String::new()),
        ComputerAction::Move { x, y } => {
            body.push_str(&format!("mouse({MOUSE_MOVED}, {x}, {y}, 0);\n"));
        }
        ComputerAction::Click { x, y, button } => {
            let (down, up, b) = button_codes(*button);
            body.push_str(&format!(
                "mouse({MOUSE_MOVED}, {x}, {y}, {b});\nmouse({down}, {x}, {y}, {b}, 1);\nmouse({up}, {x}, {y}, {b}, 1);\n"
            ));
        }
        ComputerAction::DoubleClick { x, y } => {
            body.push_str(&format!(
                "mouse({MOUSE_MOVED}, {x}, {y}, 0);\n\
                 mouse({LEFT_DOWN}, {x}, {y}, 0, 1);\nmouse({LEFT_UP}, {x}, {y}, 0, 1);\n\
                 mouse({LEFT_DOWN}, {x}, {y}, 0, 2);\nmouse({LEFT_UP}, {x}, {y}, 0, 2);\n"
            ));
        }
        ComputerAction::Drag { path } => {
            let first = path
                .first()
                .ok_or_else(|| ComputerUseError::InvalidAction("empty drag path".into()))?;
            body.push_str(&format!(
                "mouse({MOUSE_MOVED}, {}, {}, 0);\nmouse({LEFT_DOWN}, {}, {}, 0, 1);\n",
                first.x, first.y, first.x, first.y
            ));
            for p in &path[1..] {
                body.push_str(&format!(
                    "mouse({LEFT_DRAGGED}, {}, {}, 0);\nsleep(20);\n",
                    p.x, p.y
                ));
            }
            let last = path.last().expect("checked non-empty");
            body.push_str(&format!(
                "mouse({LEFT_UP}, {}, {}, 0, 1);\n",
                last.x, last.y
            ));
        }
        ComputerAction::Scroll {
            x,
            y,
            scroll_x,
            scroll_y,
        } => {
            // CG: positive wheel1 scrolls content up, positive wheel2 scrolls left.
            body.push_str(&format!(
                "mouse({MOUSE_MOVED}, {x}, {y}, 0);\n\
                 post($.CGEventCreateScrollWheelEvent2(null, 1, 2, {}, {}, 0));\n",
                -scroll_y, -scroll_x
            ));
        }
        ComputerAction::Keypress { keys } => {
            let chord = parse_chord(keys).map_err(ComputerUseError::InvalidAction)?;
            let mods: Vec<String> = chord
                .iter()
                .filter_map(modifier_name)
                .map(|m| format!("'{m}'"))
                .collect();
            let using = format!("{{using: [{}]}}", mods.join(", "));
            let main = chord.iter().find(|k| !k.is_modifier()).ok_or_else(|| {
                ComputerUseError::InvalidAction(
                    "keypress needs a non-modifier key (e.g. [\"cmd\", \"l\"])".into(),
                )
            })?;
            body.push_str("var se = Application('System Events');\n");
            match main {
                Key::Char(c) => body.push_str(&format!(
                    "se.keystroke({}, {using});\n",
                    js_string(&c.to_string())
                )),
                other => {
                    let code = key_code(other).ok_or_else(|| {
                        ComputerUseError::InvalidAction(format!("{other:?} has no macOS key code"))
                    })?;
                    body.push_str(&format!("se.keyCode({code}, {using});\n"));
                }
            }
        }
        ComputerAction::Type { text } => {
            body.push_str(&format!(
                "var se = Application('System Events');\nse.keystroke({});\n",
                js_string(text)
            ));
        }
    }
    Ok(format!("{PRELUDE}{body}"))
}

#[async_trait]
impl ComputerBackend for MacOsBackend {
    fn name(&self) -> String {
        "screencapture + osascript (macOS)".to_owned()
    }

    async fn screen_size(&self) -> Result<ScreenSize, ComputerUseError> {
        let out = self
            .jxa(
                "ObjC.import('AppKit');\nvar f = $.NSScreen.mainScreen.frame;\n\
                 JSON.stringify([Math.round(f.size.width), Math.round(f.size.height)]);",
            )
            .await?;
        let dims: Vec<u32> =
            serde_json::from_str(out.trim()).map_err(|e| ComputerUseError::Command {
                program: "osascript".into(),
                code: None,
                stderr: format!("unexpected screen size output {out:?}: {e}"),
            })?;
        match dims.as_slice() {
            [w, h] if *w > 0 && *h > 0 => Ok(ScreenSize {
                width: *w,
                height: *h,
            }),
            _ => Err(ComputerUseError::Command {
                program: "osascript".into(),
                code: None,
                stderr: format!("unexpected screen size output {out:?}"),
            }),
        }
    }

    async fn capture_png(&self) -> Result<Vec<u8>, ComputerUseError> {
        let file = tempfile::Builder::new()
            .prefix("polycode-screen-")
            .suffix(".png")
            .tempfile()?;
        let args = vec![
            "-x".to_owned(),
            "-m".to_owned(),
            "-t".to_owned(),
            "png".to_owned(),
            file.path().to_string_lossy().into_owned(),
        ];
        run_command("screencapture", &args, None, &[], COMMAND_TIMEOUT).await?;
        let bytes = tokio::fs::read(file.path()).await?;
        if bytes.is_empty() {
            return Err(ComputerUseError::Image(
                "screencapture wrote an empty file; is Screen Recording permission granted?".into(),
            ));
        }
        Ok(bytes)
    }

    async fn perform(&self, action: &ComputerAction) -> Result<(), ComputerUseError> {
        let script = jxa_script(action)?;
        if script.is_empty() {
            return Ok(());
        }
        self.jxa(&script).await.map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn click_emits_move_down_up_with_button() {
        let s = jxa_script(&ComputerAction::Click {
            x: 10,
            y: 20,
            button: MouseButton::Right,
        })
        .unwrap();
        assert!(s.starts_with("ObjC.import('CoreGraphics');"));
        assert!(s.contains("mouse(5, 10, 20, 1);"));
        assert!(s.contains("mouse(3, 10, 20, 1, 1);"));
        assert!(s.contains("mouse(4, 10, 20, 1, 1);"));
    }

    #[test]
    fn keypress_uses_system_events_modifiers() {
        let s = jxa_script(&ComputerAction::Keypress {
            keys: vec!["cmd".into(), "shift".into(), "t".into()],
        })
        .unwrap();
        assert!(s.contains("se.keystroke(\"t\", {using: ['command down', 'shift down']});"));
        let s = jxa_script(&ComputerAction::Keypress {
            keys: vec!["enter".into()],
        })
        .unwrap();
        assert!(s.contains("se.keyCode(36, {using: []});"));
        assert!(
            jxa_script(&ComputerAction::Keypress {
                keys: vec!["cmd".into()]
            })
            .is_err()
        );
    }

    #[test]
    fn type_escapes_text_as_js_string() {
        let s = jxa_script(&ComputerAction::Type {
            text: "he said \"hi\"\n".into(),
        })
        .unwrap();
        assert!(s.contains(r#"se.keystroke("he said \"hi\"\n");"#));
    }

    #[test]
    fn scroll_inverts_sign_for_coregraphics() {
        let s = jxa_script(&ComputerAction::Scroll {
            x: 1,
            y: 2,
            scroll_x: 3,
            scroll_y: 4,
        })
        .unwrap();
        assert!(s.contains("CGEventCreateScrollWheelEvent2(null, 1, 2, -4, -3, 0)"));
    }
}
