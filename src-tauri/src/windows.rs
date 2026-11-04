//! Window creation / synchronisation for the manager and the overlay windows.
//!
//! IMPORTANT: never hold the config mutex while calling window APIs. Many of them
//! round-trip through the main thread, whose window-event handler also locks the
//! config (geometry updates) — holding the lock would deadlock.

use crate::config::{b, i, s, AppState};
use serde_json::{json, Value};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

pub const MANAGER: &str = "manager";
pub const OVERLAY_PREFIX: &str = "overlay-";

/// Every webview shares one WebView2 environment (one browser process), which
/// requires the same data dir + browser args for all windows.
const BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required";

pub fn label(id: &str) -> String {
    format!("{OVERLAY_PREFIX}{id}")
}

// ---------------------------------------------------------------- manager

pub fn build_manager(app: &AppHandle) -> tauri::Result<WebviewWindow> {
    let st = app.state::<AppState>();
    WebviewWindowBuilder::new(app, MANAGER, WebviewUrl::App("manager.html".into()))
        .title("TTCO+  ·  Chat Overlay Manager")
        .inner_size(1200.0, 780.0)
        .min_inner_size(920.0, 600.0)
        .theme(Some(tauri::Theme::Dark))
        .visible(false)
        .center()
        .data_directory(st.webview_dir())
        .additional_browser_args(BROWSER_ARGS)
        .build()
}

pub fn show_manager(app: &AppHandle) {
    let win = match app.get_webview_window(MANAGER) {
        Some(w) => w,
        None => match build_manager(app) {
            Ok(w) => w,
            Err(e) => {
                eprintln!("[ttco] cannot open manager: {e}");
                return;
            }
        },
    };
    let _ = win.unminimize();
    let _ = win.show();
    let _ = win.set_focus();
}

// ---------------------------------------------------------------- overlays

/// Effective visibility = the overlay's own flag AND not globally panic-hidden.
pub fn effective_visible(app: &AppHandle, ov: &Value) -> bool {
    let st = app.state::<AppState>();
    let all_hidden = st
        .cfg
        .lock()
        .map(|c| b(&c.settings, "allHidden", false))
        .unwrap_or(false);
    b(ov, "visible", true) && !all_hidden
}

/// Make the real window match the overlay config (create / destroy / update).
pub fn sync_overlay(app: &AppHandle, ov: &Value, apply_geometry: bool) {
    let id = s(ov, "id");
    if id.is_empty() {
        return;
    }
    let lbl = label(id);
    let visible = effective_visible(app, ov);
    let locked = b(ov, "locked", false);

    if let Ok(mut h) = app.state::<AppState>().hover.lock() {
        h.remove(&lbl);
    }

    match app.get_webview_window(&lbl) {
        None if visible => {
            if let Err(e) = create_overlay_window(app, ov) {
                eprintln!("[ttco] failed to create overlay {id}: {e}");
            }
        }
        None => {}
        Some(w) if !visible => {
            let _ = w.destroy();
        }
        Some(w) => {
            let _ = w.set_ignore_cursor_events(locked);
            let _ = w.set_title(&format!("TTCO+ overlay: {}", s(ov, "name")));
            if apply_geometry {
                if let (Some(x), Some(y), Some(wd), Some(ht)) =
                    (i(ov, "x"), i(ov, "y"), i(ov, "w"), i(ov, "h"))
                {
                    let _ = w.set_size(PhysicalSize::new(wd.max(60) as u32, ht.max(40) as u32));
                    let _ = w.set_position(PhysicalPosition::new(x as i32, y as i32));
                }
            }
            let _ = app.emit_to(lbl.as_str(), "overlay-updated", ov);
        }
    }
}

/// Returns (x, y, w, h) in physical pixels, filling in sane defaults (and saving
/// them) when the overlay is new or its saved position is off every monitor.
fn ensure_geometry(app: &AppHandle, ov: &Value) -> (i32, i32, u32, u32) {
    let monitors = app.available_monitors().unwrap_or_default();
    let primary = app.primary_monitor().ok().flatten().or_else(|| monitors.first().cloned());

    let saved = match (i(ov, "x"), i(ov, "y"), i(ov, "w"), i(ov, "h")) {
        (Some(x), Some(y), Some(w), Some(h)) if w > 40 && h > 30 => Some((x as i32, y as i32, w as u32, h as u32)),
        _ => None,
    };

    // Is at least a 60x40 chunk of the saved rect on a monitor?
    let on_screen = |(x, y, w, h): (i32, i32, u32, u32)| {
        monitors.is_empty()
            || monitors.iter().any(|m| {
                let p = m.position();
                let sz = m.size();
                let ix = (x + w as i32).min(p.x + sz.width as i32) - x.max(p.x);
                let iy = (y + h as i32).min(p.y + sz.height as i32) - y.max(p.y);
                ix >= 60 && iy >= 40
            })
    };

    if let Some(g) = saved {
        if on_screen(g) {
            return g;
        }
    }

    let (mx, my, mw, scale) = primary
        .map(|m| (m.position().x, m.position().y, m.size().width as i32, m.scale_factor()))
        .unwrap_or((0, 0, 1920, 1.0));
    let w = saved.map(|g| g.2).unwrap_or((380.0 * scale) as u32);
    let h = saved.map(|g| g.3).unwrap_or((620.0 * scale) as u32);
    let x = mx + mw - w as i32 - (40.0 * scale) as i32;
    let y = my + (120.0 * scale) as i32;

    let st = app.state::<AppState>();
    if let Ok(mut cfg) = st.cfg.lock() {
        if let Some(o) = cfg.overlays.iter_mut().find(|o| s(o, "id") == s(ov, "id")) {
            o["x"] = json!(x);
            o["y"] = json!(y);
            o["w"] = json!(w);
            o["h"] = json!(h);
        }
    }
    st.mark_dirty();
    (x, y, w, h)
}

fn create_overlay_window(app: &AppHandle, ov: &Value) -> tauri::Result<()> {
    let id = s(ov, "id").to_string();
    let (x, y, w, h) = ensure_geometry(app, ov);
    let locked = b(ov, "locked", false);
    let webview_dir = app.state::<AppState>().webview_dir();

    let win = WebviewWindowBuilder::new(
        app,
        label(&id),
        WebviewUrl::App(format!("overlay.html?id={id}").into()),
    )
    .title(format!("TTCO+ overlay: {}", s(ov, "name")))
    .transparent(true)
    .decorations(false)
    .shadow(false)
    .always_on_top(true)
    .skip_taskbar(true)
    .resizable(true)
    .focused(false)
    // WS_EX_NOACTIVATE: overlays never take focus from the game — not when they
    // appear, and not when lock / unlock changes their window style.
    .focusable(false)
    .visible(false)
    .min_inner_size(120.0, 80.0)
    .data_directory(webview_dir)
    .additional_browser_args(BROWSER_ARGS)
    .build()?;

    win.set_size(PhysicalSize::new(w, h))?;
    win.set_position(PhysicalPosition::new(x, y))?;
    win.set_ignore_cursor_events(locked)?;
    // Must go through Tauri (not a raw ShowWindow): the window layer tracks
    // visibility and would re-hide the window on the next style change (e.g. lock).
    win.show()?;
    Ok(())
}

/// Called from the window-event handler when an overlay is dragged / resized.
pub fn geometry_changed(app: &AppHandle, id: &str, pos: Option<(i32, i32)>, size: Option<(u32, u32)>) {
    if let Some((x, y)) = pos {
        if x <= -30000 || y <= -30000 {
            return; // minimised / hidden sentinel values
        }
    }
    let st = app.state::<AppState>();
    let payload = {
        let mut cfg = match st.cfg.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        let Some(o) = cfg.overlays.iter_mut().find(|o| s(o, "id") == id) else {
            return;
        };
        let mut changed = false;
        if let Some((x, y)) = pos {
            if i(o, "x") != Some(x as i64) || i(o, "y") != Some(y as i64) {
                o["x"] = json!(x);
                o["y"] = json!(y);
                changed = true;
            }
        }
        if let Some((w, h)) = size {
            if i(o, "w") != Some(w as i64) || i(o, "h") != Some(h as i64) {
                o["w"] = json!(w);
                o["h"] = json!(h);
                changed = true;
            }
        }
        if !changed {
            return;
        }
        json!({ "id": id, "x": o["x"], "y": o["y"], "w": o["w"], "h": o["h"] })
    };
    st.mark_dirty();
    let _ = app.emit_to(MANAGER, "geometry", payload);
}
