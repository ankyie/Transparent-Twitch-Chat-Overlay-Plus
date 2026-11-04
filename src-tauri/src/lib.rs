mod config;
mod hover;
mod localfile;
mod ops;
mod shortcuts;
mod tray;
mod windows;

use config::AppState;
use serde_json::Value;
use std::sync::atomic::Ordering;
use std::time::Duration;
use tauri::{AppHandle, Manager, RunEvent, WindowEvent};
use tauri_plugin_global_shortcut::ShortcutState;

type CmdResult<T = Value> = Result<T, String>;

// All window-touching commands are `async` so they run off the main thread
// (synchronous commands that create windows deadlock on Windows).

#[tauri::command]
async fn get_state(app: AppHandle) -> CmdResult {
    Ok(ops::snapshot(&app))
}

#[tauri::command]
async fn get_overlay(app: AppHandle, id: String) -> CmdResult {
    ops::get_overlay(&app, &id).ok_or_else(|| format!("overlay {id} not found"))
}

#[tauri::command]
async fn create_overlay(app: AppHandle, overlay: Value) -> CmdResult {
    Ok(ops::create_overlay(&app, overlay))
}

#[tauri::command]
async fn update_overlay(app: AppHandle, id: String, patch: Value) -> CmdResult {
    let ov = ops::update_overlay(&app, &id, &patch).ok_or_else(|| format!("overlay {id} not found"))?;
    // Only visibility / lock changes need the sidebar to re-render everywhere.
    if patch.get("visible").is_some() || patch.get("locked").is_some() || patch.get("name").is_some() {
        ops::notify_manager(&app);
    }
    Ok(ov)
}

#[tauri::command]
async fn delete_overlay(app: AppHandle, id: String) -> CmdResult<()> {
    ops::delete_overlay(&app, &id);
    Ok(())
}

#[tauri::command]
async fn restore_overlay(app: AppHandle, id: String) -> CmdResult<()> {
    ops::restore_overlay(&app, &id);
    Ok(())
}

#[tauri::command]
async fn purge_trash(app: AppHandle, id: Option<String>) -> CmdResult<()> {
    ops::purge_trash(&app, id);
    Ok(())
}

#[tauri::command]
async fn reorder_overlays(app: AppHandle, ids: Vec<String>) -> CmdResult<()> {
    ops::reorder_overlays(&app, &ids);
    Ok(())
}

#[tauri::command]
async fn update_settings(app: AppHandle, patch: Value) -> CmdResult {
    let res = ops::update_settings(&app, &patch);
    ops::notify_manager(&app);
    Ok(res)
}

#[tauri::command]
async fn toggle(app: AppHandle, what: String, on: Option<bool>) -> CmdResult<()> {
    match (what.as_str(), on) {
        ("editMode", Some(v)) => ops::set_edit_mode(&app, v),
        ("editMode", None) => ops::toggle_edit_mode(&app),
        ("allHidden", Some(v)) => ops::set_all_hidden(&app, v),
        ("allHidden", None) => ops::toggle_all_hidden(&app),
        ("hoverFade", _) => ops::toggle_hover_fade(&app),
        ("fade", _) => ops::toggle_fade(&app),
        _ => return Err(format!("unknown toggle {what}")),
    }
    Ok(())
}

#[tauri::command]
async fn capture_layout(app: AppHandle, id: Option<String>, name: String) -> CmdResult {
    Ok(ops::capture_layout(&app, id, name))
}

#[tauri::command]
async fn apply_layout(app: AppHandle, id: String) -> CmdResult<()> {
    ops::apply_layout(&app, &id);
    Ok(())
}

#[tauri::command]
async fn set_layouts(app: AppHandle, layouts: Vec<Value>) -> CmdResult<()> {
    ops::set_layouts(&app, layouts);
    Ok(())
}

/// Forward a one-off action (e.g. "test" messages, "clear") to an overlay window.
#[tauri::command]
async fn overlay_action(app: AppHandle, id: String, action: String) -> CmdResult<()> {
    use tauri::Emitter;
    app.emit_to(windows::label(&id).as_str(), "action", action)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn open_manager(app: AppHandle, select: Option<String>) -> CmdResult<()> {
    use tauri::Emitter;
    windows::show_manager(&app);
    if let Some(id) = select {
        let _ = app.emit_to(windows::MANAGER, "select-overlay", id);
    }
    Ok(())
}

#[tauri::command]
async fn manager_ready(app: AppHandle) -> CmdResult<()> {
    app.state::<AppState>().manager_shown_once.store(true, Ordering::SeqCst);
    windows::show_manager(&app);
    Ok(())
}

#[tauri::command]
async fn mark_initialized(app: AppHandle) -> CmdResult<()> {
    ops::set_initialized(&app);
    Ok(())
}

#[tauri::command]
async fn open_data_folder(app: AppHandle) -> CmdResult<()> {
    let dir = app.state::<AppState>().data_dir.clone();
    std::process::Command::new("explorer")
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn quit_app(app: AppHandle) -> CmdResult<()> {
    ops::quit(&app);
    Ok(())
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            let app = app.clone();
            std::thread::spawn(move || windows::show_manager(&app));
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, sc, event| {
                    if event.state() == ShortcutState::Pressed {
                        shortcuts::handle(app, sc);
                    }
                })
                .build(),
        )
        .setup(|app| {
            let handle = app.handle().clone();
            let dir = config::resolve_data_dir(&handle);
            let cfg = config::load(&dir);
            let overlays = cfg.overlays.clone();
            let start_in_tray = cfg.initialized && config::b(&cfg.settings, "startHidden", false);
            let preferred_port = cfg.settings.get("localPort").and_then(|v| v.as_u64()).unwrap_or(0) as u16;
            app.manage(AppState::new(cfg, dir));

            // Loopback server for local HTML widgets (must exist before overlays load).
            if let Some((port, base)) = localfile::start(handle.clone(), preferred_port) {
                let st = app.state::<AppState>();
                *st.local_base.lock().unwrap() = base;
                if port != preferred_port {
                    st.cfg.lock().unwrap().settings["localPort"] = serde_json::json!(port);
                    st.mark_dirty();
                }
            }

            if let Err(e) = tray::create(&handle) {
                eprintln!("[ttco] tray icon failed: {e}");
            }
            if start_in_tray {
                app.state::<AppState>().manager_shown_once.store(true, Ordering::SeqCst);
            } else {
                windows::build_manager(&handle)?;
            }
            for ov in &overlays {
                windows::sync_overlay(&handle, ov, false);
            }
            let errors = shortcuts::register_all(&handle);
            if errors.as_object().map(|m| !m.is_empty()).unwrap_or(false) {
                eprintln!("[ttco] shortcut problems: {errors}");
            }
            hover::start(handle.clone());
            config::start_saver(handle.clone());

            // Safety net: if the manager page fails to report ready, show it anyway.
            let h2 = handle.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_secs(4));
                let st = h2.state::<AppState>();
                if !st.manager_shown_once.load(Ordering::SeqCst) {
                    st.manager_shown_once.store(true, Ordering::SeqCst);
                    windows::show_manager(&h2);
                }
            });
            Ok(())
        })
        .on_window_event(|window, event| {
            let label = window.label().to_string();
            let app = window.app_handle();
            if label == windows::MANAGER {
                // Closing the manager really closes its webview (frees memory while
                // gaming); overlays + tray keep running and it is rebuilt on demand.
                return;
            }
            let Some(id) = label.strip_prefix(windows::OVERLAY_PREFIX) else {
                return;
            };
            match event {
                WindowEvent::Moved(p) => windows::geometry_changed(app, id, Some((p.x, p.y)), None),
                WindowEvent::Resized(sz) if sz.width > 0 && sz.height > 0 => {
                    windows::geometry_changed(app, id, None, Some((sz.width, sz.height)))
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // Alt+F4 on an overlay hides it instead of losing it.
                    api.prevent_close();
                    let app = app.clone();
                    let id = id.to_string();
                    std::thread::spawn(move || {
                        ops::update_overlay(&app, &id, &serde_json::json!({ "visible": false }));
                        ops::notify_manager(&app);
                    });
                }
                _ => {}
            }
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            get_overlay,
            create_overlay,
            update_overlay,
            delete_overlay,
            restore_overlay,
            purge_trash,
            reorder_overlays,
            update_settings,
            toggle,
            capture_layout,
            apply_layout,
            set_layouts,
            overlay_action,
            open_manager,
            manager_ready,
            mark_initialized,
            open_data_folder,
            quit_app,
        ])
        .build(tauri::generate_context!())
        .expect("error while building TTCO+");

    app.run(|app, event| match event {
        // Keep running in the tray when the last window goes away;
        // only an explicit quit (exit code set) ends the app.
        RunEvent::ExitRequested { code: None, api, .. } => api.prevent_exit(),
        RunEvent::Exit => app.state::<AppState>().save_now(),
        _ => {}
    });
}
