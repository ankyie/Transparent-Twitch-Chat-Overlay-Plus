//! High-level operations shared by commands, global shortcuts and the tray menu.

use crate::config::{b, merge, new_id, now_ms, s, AppState};
use crate::windows::{self, MANAGER};
use serde_json::{json, Map, Value};
use tauri::{AppHandle, Emitter, Manager};

fn state(app: &AppHandle) -> tauri::State<'_, AppState> {
    app.state::<AppState>()
}

/// Full state snapshot sent to the manager UI.
pub fn snapshot(app: &AppHandle) -> Value {
    let st = state(app);
    let errors = st.shortcut_errors.lock().map(|e| e.clone()).unwrap_or(json!({}));
    let local_base = st.local_base.lock().map(|b| b.clone()).unwrap_or_default();
    let cfg = st.cfg.lock().unwrap();
    json!({
        "shortcutErrors": errors,
        "localBase": local_base,
        "initialized": cfg.initialized,
        "settings": cfg.settings,
        "overlays": cfg.overlays,
        "layouts": cfg.layouts,
        "trash": cfg.trash,
        "dataDir": st.data_dir.to_string_lossy(),
    })
}

pub fn notify_manager(app: &AppHandle) {
    let snap = snapshot(app);
    let _ = app.emit_to(MANAGER, "state", snap);
}

pub fn toast(app: &AppHandle, msg: &str) {
    let show = state(app)
        .cfg
        .lock()
        .map(|c| b(&c.settings, "showToasts", true))
        .unwrap_or(true);
    if show {
        let _ = app.emit("toast", msg);
    }
}

fn settings(app: &AppHandle) -> Value {
    state(app).cfg.lock().unwrap().settings.clone()
}

fn broadcast_settings(app: &AppHandle) {
    let _ = app.emit("settings-updated", settings(app));
}

fn sync_all(app: &AppHandle) {
    let overlays = state(app).cfg.lock().unwrap().overlays.clone();
    for ov in &overlays {
        windows::sync_overlay(app, ov, false);
    }
}

// ---------------------------------------------------------------- overlays

pub fn get_overlay(app: &AppHandle, id: &str) -> Option<Value> {
    let st = state(app);
    let local_base = st.local_base.lock().map(|b| b.clone()).unwrap_or_default();
    let cfg = st.cfg.lock().unwrap();
    let ov = cfg.overlays.iter().find(|o| s(o, "id") == id)?.clone();
    Some(json!({ "overlay": ov, "settings": cfg.settings, "localBase": local_base }))
}

pub fn create_overlay(app: &AppHandle, mut ov: Value) -> Value {
    if !ov.is_object() {
        ov = json!({});
    }
    if s(&ov, "id").is_empty() {
        ov["id"] = json!(new_id("o"));
    }
    if s(&ov, "name").is_empty() {
        ov["name"] = json!("New overlay");
    }
    {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        cfg.overlays.push(ov.clone());
        cfg.initialized = true;
        st.mark_dirty();
    }
    windows::sync_overlay(app, &ov, false);
    // Return the stored version (geometry may have been filled in).
    let id = s(&ov, "id").to_string();
    let stored = get_overlay(app, &id).map(|v| v["overlay"].clone()).unwrap_or(ov);
    notify_manager(app);
    stored
}

pub fn update_overlay(app: &AppHandle, id: &str, patch: &Value) -> Option<Value> {
    let ov = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let o = cfg.overlays.iter_mut().find(|o| s(o, "id") == id)?;
        merge(o, patch);
        o["id"] = json!(id); // never allow the id to be patched away
        st.mark_dirty();
        o.clone()
    };
    let geometry = ["x", "y", "w", "h"].iter().any(|k| patch.get(*k).is_some());
    windows::sync_overlay(app, &ov, geometry);
    Some(ov)
}

pub fn delete_overlay(app: &AppHandle, id: &str) {
    let removed = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let Some(pos) = cfg.overlays.iter().position(|o| s(o, "id") == id) else {
            return;
        };
        let mut ov = cfg.overlays.remove(pos);
        ov["deletedAt"] = json!(now_ms());
        cfg.trash.insert(0, ov.clone());
        cfg.trash.truncate(50);
        st.mark_dirty();
        ov
    };
    if let Some(w) = app.get_webview_window(&windows::label(s(&removed, "id"))) {
        let _ = w.destroy();
    }
    notify_manager(app);
}

pub fn restore_overlay(app: &AppHandle, id: &str) {
    let ov = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let Some(pos) = cfg.trash.iter().position(|o| s(o, "id") == id) else {
            return;
        };
        let mut ov = cfg.trash.remove(pos);
        if let Some(m) = ov.as_object_mut() {
            m.remove("deletedAt");
        }
        cfg.overlays.push(ov.clone());
        st.mark_dirty();
        ov
    };
    windows::sync_overlay(app, &ov, false);
    notify_manager(app);
}

pub fn purge_trash(app: &AppHandle, id: Option<String>) {
    {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        match id {
            Some(id) => cfg.trash.retain(|o| s(o, "id") != id),
            None => cfg.trash.clear(),
        }
        st.mark_dirty();
    }
    notify_manager(app);
}

pub fn reorder_overlays(app: &AppHandle, ids: &[String]) {
    {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let rank = |o: &Value| ids.iter().position(|x| x == s(o, "id")).unwrap_or(usize::MAX);
        cfg.overlays.sort_by_key(rank);
        st.mark_dirty();
    }
    notify_manager(app);
}

pub fn set_initialized(app: &AppHandle) {
    let st = state(app);
    st.cfg.lock().unwrap().initialized = true;
    st.mark_dirty();
}

// ---------------------------------------------------------------- global toggles

pub fn set_edit_mode(app: &AppHandle, on: bool) {
    let overlays = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        for o in cfg.overlays.iter_mut() {
            o["locked"] = json!(!on);
        }
        st.mark_dirty();
        cfg.overlays.clone()
    };
    for ov in &overlays {
        windows::sync_overlay(app, ov, false);
    }
    toast(app, if on { "Edit mode — drag & resize overlays" } else { "Overlays locked (click-through)" });
    notify_manager(app);
}

pub fn toggle_edit_mode(app: &AppHandle) {
    let any_locked = {
        let st = state(app);
        let cfg = st.cfg.lock().unwrap();
        cfg.overlays.iter().filter(|o| b(o, "visible", true)).any(|o| b(o, "locked", false))
    };
    set_edit_mode(app, any_locked);
}

pub fn set_all_hidden(app: &AppHandle, hidden: bool) {
    {
        let st = state(app);
        st.cfg.lock().unwrap().settings["allHidden"] = json!(hidden);
        st.mark_dirty();
    }
    sync_all(app);
    broadcast_settings(app);
    if !hidden {
        toast(app, "Overlays shown");
    }
    notify_manager(app);
}

pub fn toggle_all_hidden(app: &AppHandle) {
    let hidden = b(&settings(app), "allHidden", false);
    set_all_hidden(app, !hidden);
}

pub fn toggle_hover_fade(app: &AppHandle) {
    let on = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let on = !b(&cfg.settings, "hoverFadeEnabled", true);
        cfg.settings["hoverFadeEnabled"] = json!(on);
        st.mark_dirty();
        on
    };
    broadcast_settings(app);
    toast(app, if on { "Hover fade: ON" } else { "Hover fade: OFF" });
    notify_manager(app);
}

/// Manual fade: dim every overlay right now, no hovering needed.
pub fn toggle_fade(app: &AppHandle) {
    let on = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let on = !b(&cfg.settings, "dimmed", false);
        cfg.settings["dimmed"] = json!(on);
        on
    };
    broadcast_settings(app);
    toast(app, if on { "Faded — press again to restore" } else { "Overlays restored" });
    notify_manager(app);
}

pub fn update_settings(app: &AppHandle, patch: &Value) -> Value {
    {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        merge(&mut cfg.settings, patch);
        st.mark_dirty();
    }
    let errors = if patch.get("shortcuts").is_some() {
        crate::shortcuts::register_all(app)
    } else {
        Value::Object(Map::new())
    };
    if patch.get("allHidden").is_some() {
        sync_all(app);
    }
    broadcast_settings(app);
    json!({ "settings": settings(app), "shortcutErrors": errors })
}

// ---------------------------------------------------------------- layouts

pub fn capture_layout(app: &AppHandle, id: Option<String>, name: String) -> Value {
    let layout = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let mut items = Map::new();
        for o in &cfg.overlays {
            items.insert(
                s(o, "id").to_string(),
                json!({ "visible": b(o, "visible", true), "x": o["x"], "y": o["y"], "w": o["w"], "h": o["h"] }),
            );
        }
        let lid = id.unwrap_or_else(|| new_id("l"));
        let layout = json!({ "id": lid, "name": name, "items": items, "savedAt": now_ms() });
        match cfg.layouts.iter_mut().find(|l| s(l, "id") == lid) {
            Some(l) => *l = layout.clone(),
            None => cfg.layouts.push(layout.clone()),
        }
        cfg.settings["activeLayout"] = json!(lid);
        st.mark_dirty();
        layout
    };
    notify_manager(app);
    layout
}

pub fn set_layouts(app: &AppHandle, layouts: Vec<Value>) {
    {
        let st = state(app);
        st.cfg.lock().unwrap().layouts = layouts;
        st.mark_dirty();
    }
    notify_manager(app);
}

pub fn apply_layout(app: &AppHandle, id: &str) {
    let (layout, overlays) = {
        let st = state(app);
        let mut cfg = st.cfg.lock().unwrap();
        let Some(layout) = cfg.layouts.iter().find(|l| s(l, "id") == id).cloned() else {
            return;
        };
        let items = layout.get("items").cloned().unwrap_or(json!({}));
        for o in cfg.overlays.iter_mut() {
            if let Some(it) = items.get(s(o, "id")) {
                merge(o, it);
            }
        }
        cfg.settings["activeLayout"] = json!(id);
        cfg.settings["allHidden"] = json!(false);
        st.mark_dirty();
        (layout, cfg.overlays.clone())
    };
    for ov in &overlays {
        windows::sync_overlay(app, ov, true);
    }
    broadcast_settings(app);
    toast(app, &format!("Layout: {}", s(&layout, "name")));
    notify_manager(app);
}

pub fn next_layout(app: &AppHandle) {
    let next = {
        let st = state(app);
        let cfg = st.cfg.lock().unwrap();
        if cfg.layouts.is_empty() {
            None
        } else {
            let cur = s(&cfg.settings, "activeLayout").to_string();
            let idx = cfg.layouts.iter().position(|l| s(l, "id") == cur);
            let n = idx.map(|i| (i + 1) % cfg.layouts.len()).unwrap_or(0);
            Some(s(&cfg.layouts[n], "id").to_string())
        }
    };
    match next {
        Some(id) => apply_layout(app, &id),
        None => toast(app, "No layouts saved yet"),
    }
}

// ---------------------------------------------------------------- misc

pub fn quit(app: &AppHandle) {
    state(app).save_now();
    app.exit(0);
}
