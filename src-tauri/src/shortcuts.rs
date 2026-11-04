//! Configurable global hotkeys.

use crate::config::AppState;
use crate::{ops, windows};
use serde_json::{Map, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut};

pub const ACTIONS: [&str; 6] = [
    "toggleFade",
    "toggleHoverFade",
    "toggleEditMode",
    "toggleAllVisible",
    "openManager",
    "nextLayout",
];

/// (Re)register every shortcut from settings. Returns `{ action: error }` for
/// the ones that could not be registered (invalid or already taken).
pub fn register_all(app: &AppHandle) -> Value {
    let gs = app.global_shortcut();
    let _ = gs.unregister_all();
    let st = app.state::<AppState>();
    let keys = st
        .cfg
        .lock()
        .map(|c| c.settings.get("shortcuts").cloned().unwrap_or(Value::Null))
        .unwrap_or(Value::Null);

    let mut map = HashMap::new();
    let mut errors = Map::new();
    for action in ACTIONS {
        let key = keys.get(action).and_then(|v| v.as_str()).unwrap_or("").trim();
        if key.is_empty() {
            continue;
        }
        match key.parse::<Shortcut>() {
            Ok(sc) => match gs.register(sc) {
                Ok(()) => {
                    map.insert(sc.id(), action.to_string());
                }
                Err(e) => {
                    errors.insert(action.into(), Value::String(format!("Could not register (in use by another app?): {e}")));
                }
            },
            Err(e) => {
                errors.insert(action.into(), Value::String(format!("Invalid shortcut: {e}")));
            }
        }
    }
    if let Ok(mut m) = st.shortcuts.lock() {
        *m = map;
    }
    let errors = Value::Object(errors);
    if let Ok(mut e) = st.shortcut_errors.lock() {
        *e = errors.clone();
    }
    errors
}

pub fn handle(app: &AppHandle, sc: &Shortcut) {
    let action = app
        .state::<AppState>()
        .shortcuts
        .lock()
        .ok()
        .and_then(|m| m.get(&sc.id()).cloned());
    let Some(action) = action else { return };
    let app = app.clone();
    // Window operations must not run inside the event-loop callback itself.
    std::thread::spawn(move || match action.as_str() {
        "toggleFade" => ops::toggle_fade(&app),
        "toggleHoverFade" => ops::toggle_hover_fade(&app),
        "toggleEditMode" => ops::toggle_edit_mode(&app),
        "toggleAllVisible" => ops::toggle_all_hidden(&app),
        "openManager" => windows::show_manager(&app),
        "nextLayout" => ops::next_layout(&app),
        _ => {}
    });
}
