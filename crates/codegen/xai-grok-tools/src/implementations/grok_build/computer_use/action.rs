//! The structured action vocabulary the model sends to the `computer` tool.
//!
//! Mirrors the OpenAI computer-use (`computer_call.actions`) action set so any model
//! that has seen that contract can drive the tool, while staying a plain JSON function
//! schema that every provider supports.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

/// Mouse button for `click` actions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum MouseButton {
    #[default]
    Left,
    Right,
    Middle,
    Back,
    Forward,
}

impl MouseButton {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Left => "left",
            Self::Right => "right",
            Self::Middle => "middle",
            Self::Back => "back",
            Self::Forward => "forward",
        }
    }
}

/// A point in screenshot pixel coordinates (origin top-left).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
pub struct Point {
    pub x: i64,
    pub y: i64,
}

fn default_wait_ms() -> u64 {
    1000
}

/// One desktop action. Coordinates are in the pixel space of the screenshots this tool
/// returns; the tool maps them onto the physical screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum ComputerAction {
    /// Capture the current screen without changing anything.
    Screenshot,
    /// Click at (x, y) with the given button (default left).
    Click {
        x: i64,
        y: i64,
        #[serde(default)]
        button: MouseButton,
    },
    /// Double-click the left button at (x, y).
    DoubleClick { x: i64, y: i64 },
    /// Move the pointer to (x, y) without clicking.
    Move { x: i64, y: i64 },
    /// Press the left button at the first point, move through the path, release at the last point.
    Drag { path: Vec<Point> },
    /// Scroll at (x, y). Positive `scroll_y` scrolls down, negative scrolls up; positive
    /// `scroll_x` scrolls right. Units are wheel notches.
    Scroll {
        x: i64,
        y: i64,
        #[serde(default)]
        scroll_x: i64,
        #[serde(default)]
        scroll_y: i64,
    },
    /// Press a key or chord. Each entry is a key name (`"enter"`, `"ctrl"`, `"a"`, `"f5"`);
    /// several entries form a chord (`["ctrl", "l"]`). `"ctrl+l"` is also accepted.
    Keypress { keys: Vec<String> },
    /// Type literal text into the focused control.
    Type { text: String },
    /// Pause for `ms` milliseconds (default 1000) so the UI can settle.
    Wait {
        #[serde(default = "default_wait_ms")]
        ms: u64,
    },
}

impl ComputerAction {
    /// `true` when the action only observes the screen.
    pub fn is_observation(&self) -> bool {
        matches!(self, Self::Screenshot | Self::Wait { .. })
    }

    /// Short one-line description for summaries and permission prompts.
    pub fn describe(&self) -> String {
        match self {
            Self::Screenshot => "screenshot".to_owned(),
            Self::Click { x, y, button } => format!("click {} at ({x}, {y})", button.as_str()),
            Self::DoubleClick { x, y } => format!("double-click at ({x}, {y})"),
            Self::Move { x, y } => format!("move pointer to ({x}, {y})"),
            Self::Drag { path } => match (path.first(), path.last()) {
                (Some(a), Some(b)) => format!(
                    "drag from ({}, {}) to ({}, {}) via {} points",
                    a.x,
                    a.y,
                    b.x,
                    b.y,
                    path.len()
                ),
                _ => "drag (empty path)".to_owned(),
            },
            Self::Scroll {
                x,
                y,
                scroll_x,
                scroll_y,
            } => format!("scroll at ({x}, {y}) by dx={scroll_x} dy={scroll_y}"),
            Self::Keypress { keys } => format!("press {}", keys.join("+")),
            Self::Type { text } => {
                let shown: String = text.chars().take(40).collect();
                if text.chars().count() > 40 {
                    format!("type {shown:?}… ({} chars)", text.chars().count())
                } else {
                    format!("type {shown:?}")
                }
            }
            Self::Wait { ms } => format!("wait {ms} ms"),
        }
    }

    /// Return the same action with every coordinate divided by `scale` (screenshot space →
    /// screen space) and rounded to the nearest pixel.
    pub fn scaled(&self, scale: f64) -> Self {
        let map = |v: i64| -> i64 {
            if scale <= 0.0 || (scale - 1.0).abs() < f64::EPSILON {
                v
            } else {
                (v as f64 / scale).round() as i64
            }
        };
        match self {
            Self::Screenshot => Self::Screenshot,
            Self::Click { x, y, button } => Self::Click {
                x: map(*x),
                y: map(*y),
                button: *button,
            },
            Self::DoubleClick { x, y } => Self::DoubleClick {
                x: map(*x),
                y: map(*y),
            },
            Self::Move { x, y } => Self::Move {
                x: map(*x),
                y: map(*y),
            },
            Self::Drag { path } => Self::Drag {
                path: path
                    .iter()
                    .map(|p| Point {
                        x: map(p.x),
                        y: map(p.y),
                    })
                    .collect(),
            },
            Self::Scroll {
                x,
                y,
                scroll_x,
                scroll_y,
            } => Self::Scroll {
                x: map(*x),
                y: map(*y),
                scroll_x: *scroll_x,
                scroll_y: *scroll_y,
            },
            Self::Keypress { keys } => Self::Keypress { keys: keys.clone() },
            Self::Type { text } => Self::Type { text: text.clone() },
            Self::Wait { ms } => Self::Wait { ms: *ms },
        }
    }

    /// Every coordinate the action touches, for bounds checks.
    pub fn points(&self) -> Vec<Point> {
        match self {
            Self::Click { x, y, .. }
            | Self::DoubleClick { x, y }
            | Self::Move { x, y }
            | Self::Scroll { x, y, .. } => vec![Point { x: *x, y: *y }],
            Self::Drag { path } => path.clone(),
            Self::Screenshot | Self::Keypress { .. } | Self::Type { .. } | Self::Wait { .. } => {
                Vec::new()
            }
        }
    }

    /// Reject structurally invalid actions before anything touches the desktop.
    pub fn validate(&self, width: u32, height: u32) -> Result<(), String> {
        match self {
            Self::Drag { path } if path.len() < 2 => {
                return Err("drag requires a path with at least two points".to_owned());
            }
            Self::Keypress { keys } if keys.iter().all(|k| k.trim().is_empty()) => {
                return Err("keypress requires at least one key name".to_owned());
            }
            Self::Type { text } if text.is_empty() => {
                return Err("type requires non-empty text".to_owned());
            }
            Self::Wait { ms } if *ms > 30_000 => {
                return Err("wait is capped at 30000 ms per action".to_owned());
            }
            _ => {}
        }
        for p in self.points() {
            if p.x < 0 || p.y < 0 || p.x >= i64::from(width) || p.y >= i64::from(height) {
                return Err(format!(
                    "point ({}, {}) is outside the {width}x{height} screenshot",
                    p.x, p.y
                ));
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_openai_cua_shapes() {
        let actions: Vec<ComputerAction> = serde_json::from_value(serde_json::json!([
            {"type": "screenshot"},
            {"type": "click", "x": 405, "y": 157, "button": "left"},
            {"type": "click", "x": 1, "y": 2},
            {"type": "double_click", "x": 3, "y": 4},
            {"type": "move", "x": 5, "y": 6},
            {"type": "drag", "path": [{"x": 1, "y": 1}, {"x": 9, "y": 9}]},
            {"type": "scroll", "x": 10, "y": 10, "scroll_y": -5},
            {"type": "keypress", "keys": ["CTRL", "L"]},
            {"type": "type", "text": "penguin"},
            {"type": "wait"},
            {"type": "wait", "ms": 250}
        ]))
        .unwrap();
        assert_eq!(actions.len(), 11);
        assert_eq!(
            actions[2],
            ComputerAction::Click {
                x: 1,
                y: 2,
                button: MouseButton::Left
            }
        );
        assert_eq!(actions[9], ComputerAction::Wait { ms: 1000 });
        assert!(matches!(
            actions[6],
            ComputerAction::Scroll {
                scroll_x: 0,
                scroll_y: -5,
                ..
            }
        ));
    }

    #[test]
    fn scaled_maps_screenshot_space_to_screen_space() {
        // Screen 2000 wide shown as a 1000-wide screenshot: scale 0.5.
        let a = ComputerAction::Click {
            x: 100,
            y: 50,
            button: MouseButton::Right,
        };
        assert_eq!(
            a.scaled(0.5),
            ComputerAction::Click {
                x: 200,
                y: 100,
                button: MouseButton::Right
            }
        );
        let d = ComputerAction::Drag {
            path: vec![Point { x: 1, y: 1 }, Point { x: 3, y: 3 }],
        };
        assert_eq!(
            d.scaled(0.5),
            ComputerAction::Drag {
                path: vec![Point { x: 2, y: 2 }, Point { x: 6, y: 6 }]
            }
        );
        // Identity scale leaves coordinates alone.
        assert_eq!(a.scaled(1.0), a);
    }

    #[test]
    fn validate_rejects_out_of_bounds_and_malformed() {
        assert!(
            ComputerAction::Click {
                x: 1000,
                y: 10,
                button: MouseButton::Left
            }
            .validate(800, 600)
            .is_err()
        );
        assert!(
            ComputerAction::Move { x: -1, y: 0 }
                .validate(800, 600)
                .is_err()
        );
        assert!(
            ComputerAction::Drag {
                path: vec![Point { x: 1, y: 1 }]
            }
            .validate(800, 600)
            .is_err()
        );
        assert!(
            ComputerAction::Type {
                text: String::new()
            }
            .validate(800, 600)
            .is_err()
        );
        assert!(
            ComputerAction::Wait { ms: 60_000 }
                .validate(800, 600)
                .is_err()
        );
        assert!(
            ComputerAction::Click {
                x: 799,
                y: 599,
                button: MouseButton::Left
            }
            .validate(800, 600)
            .is_ok()
        );
    }

    #[test]
    fn describe_is_compact() {
        let long = "x".repeat(100);
        let d = ComputerAction::Type { text: long }.describe();
        assert!(d.contains("(100 chars)"));
        assert_eq!(
            ComputerAction::Keypress {
                keys: vec!["ctrl".into(), "l".into()]
            }
            .describe(),
            "press ctrl+l"
        );
    }
}
