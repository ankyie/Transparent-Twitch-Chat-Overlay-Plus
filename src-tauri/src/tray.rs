//! System tray icon + menu.

use crate::{ops, windows};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::AppHandle;

pub fn create(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "Open manager", true, None::<&str>)?;
    let edit = MenuItem::with_id(app, "edit", "Toggle edit mode (move / resize)", true, None::<&str>)?;
    let fade = MenuItem::with_id(app, "fade", "Fade / restore overlays", true, None::<&str>)?;
    let hover = MenuItem::with_id(app, "hover", "Turn hover fade on / off", true, None::<&str>)?;
    let all = MenuItem::with_id(app, "all", "Show / hide all overlays", true, None::<&str>)?;
    let layout = MenuItem::with_id(app, "layout", "Next layout", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit TTCO+", true, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&open, &sep1, &edit, &fade, &hover, &all, &layout, &sep2, &quit])?;

    let mut builder = TrayIconBuilder::with_id("ttco-tray")
        .tooltip("TTCO+ chat overlay")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            let app = app.clone();
            let id = event.id().as_ref().to_string();
            std::thread::spawn(move || match id.as_str() {
                "open" => windows::show_manager(&app),
                "edit" => ops::toggle_edit_mode(&app),
                "fade" => ops::toggle_fade(&app),
                "hover" => ops::toggle_hover_fade(&app),
                "all" => ops::toggle_all_hidden(&app),
                "layout" => ops::next_layout(&app),
                "quit" => ops::quit(&app),
                _ => {}
            });
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle().clone();
                std::thread::spawn(move || windows::show_manager(&app));
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}
