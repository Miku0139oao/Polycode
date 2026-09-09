//! Key-name normalization shared by every backend.
//!
//! Models spell keys many ways (`CTRL`, `Control`, `ctrl`, `cmd`, `Return`, `esc`). Each
//! backend needs its own spelling (X keysyms, macOS key codes, Windows virtual keys), so
//! the tool first folds every spelling into a small canonical set and lets the backend
//! translate that.

/// A canonical key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Key {
    Ctrl,
    Alt,
    Shift,
    /// Command on macOS, Windows/Super elsewhere.
    Meta,
    Enter,
    Escape,
    Tab,
    Space,
    Backspace,
    Delete,
    Insert,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    CapsLock,
    PrintScreen,
    /// F1..F24
    Function(u8),
    /// Any single printable character (already lower-cased when it is a letter).
    Char(char),
}

impl Key {
    pub fn is_modifier(&self) -> bool {
        matches!(self, Self::Ctrl | Self::Alt | Self::Shift | Self::Meta)
    }
}

/// Parse one key token. Returns `None` for names no backend understands.
pub fn parse_key(raw: &str) -> Option<Key> {
    let name = raw.trim();
    if name.is_empty() {
        return None;
    }
    let lower = name.to_ascii_lowercase();
    let key = match lower.as_str() {
        "ctrl" | "control" | "ctl" => Key::Ctrl,
        "alt" | "option" | "opt" => Key::Alt,
        "shift" => Key::Shift,
        "cmd" | "command" | "meta" | "super" | "win" | "windows" => Key::Meta,
        "enter" | "return" | "ret" => Key::Enter,
        "esc" | "escape" => Key::Escape,
        "tab" => Key::Tab,
        "space" | "spacebar" | " " => Key::Space,
        "backspace" | "bksp" | "back" => Key::Backspace,
        "delete" | "del" => Key::Delete,
        "insert" | "ins" => Key::Insert,
        "up" | "arrowup" | "uparrow" => Key::Up,
        "down" | "arrowdown" | "downarrow" => Key::Down,
        "left" | "arrowleft" | "leftarrow" => Key::Left,
        "right" | "arrowright" | "rightarrow" => Key::Right,
        "home" => Key::Home,
        "end" => Key::End,
        "pageup" | "pgup" | "page_up" | "prior" => Key::PageUp,
        "pagedown" | "pgdn" | "page_down" | "next" => Key::PageDown,
        "capslock" | "caps_lock" => Key::CapsLock,
        "printscreen" | "print" | "prtsc" => Key::PrintScreen,
        f if f.len() >= 2 && f.starts_with('f') && f[1..].chars().all(|c| c.is_ascii_digit()) => {
            let n: u8 = f[1..].parse().ok()?;
            if (1..=24).contains(&n) {
                Key::Function(n)
            } else {
                return None;
            }
        }
        _ => {
            let mut chars = name.chars();
            let c = chars.next()?;
            if chars.next().is_some() {
                return None;
            }
            Key::Char(c.to_ascii_lowercase())
        }
    };
    Some(key)
}

/// Parse a chord from the model's `keys` list. Each entry may itself be a `+`-joined
/// chord (`"ctrl+shift+t"`); a lone `"+"` is the plus character.
pub fn parse_chord(keys: &[String]) -> Result<Vec<Key>, String> {
    let mut out = Vec::new();
    for entry in keys {
        let entry = entry.trim();
        if entry.is_empty() {
            continue;
        }
        if entry == "+" {
            out.push(Key::Char('+'));
            continue;
        }
        for part in entry.split('+') {
            let part = part.trim();
            if part.is_empty() {
                continue;
            }
            let key = parse_key(part).ok_or_else(|| format!("unknown key name {part:?}"))?;
            out.push(key);
        }
    }
    if out.is_empty() {
        return Err("no keys given".to_owned());
    }
    // Modifiers first, then the (single) non-modifier, so backends can emit `mods+key`.
    let non_mods = out.iter().filter(|k| !k.is_modifier()).count();
    if non_mods > 1 {
        return Err(
            "a keypress may combine modifiers with at most one key; use `type` for text".to_owned(),
        );
    }
    out.sort_by_key(|k| !k.is_modifier());
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_common_spellings() {
        assert_eq!(parse_key("CTRL"), Some(Key::Ctrl));
        assert_eq!(parse_key("Control"), Some(Key::Ctrl));
        assert_eq!(parse_key("cmd"), Some(Key::Meta));
        assert_eq!(parse_key("Return"), Some(Key::Enter));
        assert_eq!(parse_key("esc"), Some(Key::Escape));
        assert_eq!(parse_key("F12"), Some(Key::Function(12)));
        assert_eq!(parse_key("A"), Some(Key::Char('a')));
        assert_eq!(parse_key("/"), Some(Key::Char('/')));
        assert_eq!(parse_key("f99"), None);
        assert_eq!(parse_key("bogus"), None);
    }

    #[test]
    fn chords_put_modifiers_first_and_allow_plus_syntax() {
        let chord = parse_chord(&["l".to_owned(), "ctrl".to_owned()]).unwrap();
        assert_eq!(chord, vec![Key::Ctrl, Key::Char('l')]);
        let chord = parse_chord(&["ctrl+shift+t".to_owned()]).unwrap();
        assert_eq!(chord, vec![Key::Ctrl, Key::Shift, Key::Char('t')]);
        assert_eq!(
            parse_chord(&["+".to_owned()]).unwrap(),
            vec![Key::Char('+')]
        );
    }

    #[test]
    fn chords_reject_multiple_plain_keys() {
        assert!(parse_chord(&["a".to_owned(), "b".to_owned()]).is_err());
        assert!(parse_chord(&[]).is_err());
        assert!(parse_chord(&["nope".to_owned()]).is_err());
    }
}
