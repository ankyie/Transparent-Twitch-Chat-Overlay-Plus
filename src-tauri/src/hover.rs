//! Hover detection for click-through overlays.
//!
//! A locked overlay ignores all mouse input (so clicks reach the game), which
//! also means its web page never sees the mouse. Instead we poll the global
//! cursor position on a tiny background thread and tell each overlay window
//! when the cursor enters / leaves it. Only state *changes* are emitted, and the
//! thread idles at a slow rate when no overlay needs hover detection.

use crate::config::{b, i, s, AppState};
use crate::windows::label;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

struct Target {
    label: String,
    x: i32,
    y: i32,
    w: i32,
    h: i32,
}

#[cfg(windows)]
fn cursor(ignore_hidden: bool) -> Option<(i32, i32)> {
    use windows_sys::Win32::UI::WindowsAndMessaging::{GetCursorInfo, CURSORINFO, CURSOR_SHOWING};
    unsafe {
        let mut ci: CURSORINFO = std::mem::zeroed();
        ci.cbSize = std::mem::size_of::<CURSORINFO>() as u32;
        if GetCursorInfo(&mut ci) == 0 {
            return None;
        }
        // Games that capture the mouse (FPS etc.) hide the cursor: treat as "not hovering".
        if ignore_hidden && (ci.flags & CURSOR_SHOWING) == 0 {
            return None;
        }
        Some((ci.ptScreenPos.x, ci.ptScreenPos.y))
    }
}

#[cfg(not(windows))]
fn cursor(_ignore_hidden: bool) -> Option<(i32, i32)> {
    None
}

pub fn start(app: AppHandle) {
    std::thread::spawn(move || loop {
        let st = app.state::<AppState>();
        let (targets, poll, ignore_hidden) = {
            let cfg = match st.cfg.lock() {
                Ok(c) => c,
                Err(_) => return,
            };
            let set = &cfg.settings;
            let enabled = b(set, "hoverFadeEnabled", true) && !b(set, "allHidden", false);
            let poll = set.get("hoverPollMs").and_then(|v| v.as_u64()).unwrap_or(40).clamp(15, 250);
            let ignore_hidden = b(set, "ignoreHiddenCursor", true);
            let targets: Vec<Target> = if !enabled {
                Vec::new()
            } else {
                cfg.overlays
                    .iter()
                    .filter(|o| b(o, "visible", true) && b(o, "locked", false))
                    .filter(|o| o.get("hover").map(|h| b(h, "enabled", true)).unwrap_or(true))
                    .filter_map(|o| {
                        Some(Target {
                            label: label(s(o, "id")),
                            x: i(o, "x")? as i32,
                            y: i(o, "y")? as i32,
                            w: i(o, "w")? as i32,
                            h: i(o, "h")? as i32,
                        })
                    })
                    .collect()
            };
            (targets, poll, ignore_hidden)
        };

        if targets.is_empty() {
            if let Ok(mut h) = st.hover.lock() {
                h.clear();
            }
            std::thread::sleep(Duration::from_millis(250));
            continue;
        }

        let cur = cursor(ignore_hidden);
        let mut emits: Vec<(String, bool)> = Vec::new();
        if let Ok(mut hv) = st.hover.lock() {
            for t in &targets {
                let inside = cur
                    .map(|(cx, cy)| cx >= t.x && cx < t.x + t.w && cy >= t.y && cy < t.y + t.h)
                    .unwrap_or(false);
                if hv.get(&t.label) != Some(&inside) {
                    hv.insert(t.label.clone(), inside);
                    emits.push((t.label.clone(), inside));
                }
            }
            hv.retain(|k, _| targets.iter().any(|t| &t.label == k));
        }
        for (lbl, inside) in emits {
            let _ = app.emit_to(lbl.as_str(), "hover", inside);
        }
        std::thread::sleep(Duration::from_millis(poll));
    });
}
