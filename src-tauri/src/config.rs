//! Persistent configuration + shared application state.
//!
//! The Rust side deliberately only understands the handful of overlay fields it
//! needs (id, visibility, lock state, geometry, hover). Everything else (look,
//! filters, channels...) is owned by the frontend and stored verbatim.

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    #[serde(default = "one")]
    pub version: u32,
    #[serde(default)]
    pub initialized: bool,
    #[serde(default)]
    pub settings: Value,
    #[serde(default)]
    pub overlays: Vec<Value>,
    #[serde(default)]
    pub layouts: Vec<Value>,
    #[serde(default)]
    pub trash: Vec<Value>,
}

fn one() -> u32 {
    1
}

pub fn default_settings() -> Value {
    json!({
        "hoverFadeEnabled": true,
        "allHidden": false,
        "showToasts": true,
        "startHidden": false,
        "hoverPollMs": 40,
        "ignoreHiddenCursor": true,
        "activeLayout": null,
        "dimmed": false,
        "shortcuts": {
            "toggleFade": "Ctrl+Alt+H",
            "toggleHoverFade": "Ctrl+Alt+Shift+H",
            "toggleEditMode": "Ctrl+Alt+U",
            "toggleAllVisible": "Ctrl+Alt+V",
            "openManager": "Ctrl+Alt+O",
            "nextLayout": "Ctrl+Alt+L"
        }
    })
}

pub struct AppState {
    pub cfg: Mutex<Config>,
    pub dirty: AtomicBool,
    pub data_dir: PathBuf,
    /// Last hover state emitted per overlay window label.
    pub hover: Mutex<HashMap<String, bool>>,
    /// Registered global shortcut id -> action name.
    pub shortcuts: Mutex<HashMap<u32, String>>,
    /// Last registration errors per action, shown in the manager.
    pub shortcut_errors: Mutex<Value>,
    pub manager_shown_once: AtomicBool,
    /// Base URL of the loopback server for local widgets ("" if it failed to start).
    pub local_base: Mutex<String>,
}

impl AppState {
    pub fn new(cfg: Config, data_dir: PathBuf) -> Self {
        Self {
            cfg: Mutex::new(cfg),
            dirty: AtomicBool::new(false),
            data_dir,
            hover: Mutex::new(HashMap::new()),
            shortcuts: Mutex::new(HashMap::new()),
            shortcut_errors: Mutex::new(json!({})),
            local_base: Mutex::new(String::new()),
            manager_shown_once: AtomicBool::new(false),
        }
    }

    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::SeqCst);
    }

    pub fn webview_dir(&self) -> PathBuf {
        self.data_dir.join("webview")
    }

    pub fn save_now(&self) {
        let cfg = match self.cfg.lock() {
            Ok(c) => c.clone(),
            Err(_) => return,
        };
        self.dirty.store(false, Ordering::SeqCst);
        if let Err(e) = write_config(&self.data_dir, &cfg) {
            eprintln!("[ttco] failed to save config: {e}");
        }
    }
}

// ---------------------------------------------------------------- helpers

pub fn s<'a>(v: &'a Value, k: &str) -> &'a str {
    v.get(k).and_then(|x| x.as_str()).unwrap_or("")
}

pub fn b(v: &Value, k: &str, d: bool) -> bool {
    v.get(k).and_then(|x| x.as_bool()).unwrap_or(d)
}

pub fn i(v: &Value, k: &str) -> Option<i64> {
    v.get(k).and_then(|x| x.as_f64()).map(|f| f.round() as i64)
}

/// Deep-merge `patch` into `target`. Objects merge recursively, anything else replaces.
pub fn merge(target: &mut Value, patch: &Value) {
    match (target.as_object_mut(), patch.as_object()) {
        (Some(t), Some(p)) => {
            for (k, v) in p {
                match t.get_mut(k) {
                    Some(tv) if tv.is_object() && v.is_object() => merge(tv, v),
                    _ => {
                        t.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        _ => *target = patch.clone(),
    }
}

/// Fill keys that are missing in `target` from `defaults` (recursively).
pub fn fill_defaults(target: &mut Value, defaults: &Value) {
    if !target.is_object() {
        *target = defaults.clone();
        return;
    }
    if let (Some(t), Some(d)) = (target.as_object_mut(), defaults.as_object()) {
        for (k, dv) in d {
            match t.get_mut(k) {
                None => {
                    t.insert(k.clone(), dv.clone());
                }
                Some(tv) if tv.is_object() && dv.is_object() => fill_defaults(tv, dv),
                _ => {}
            }
        }
    }
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

pub fn new_id(prefix: &str) -> String {
    let ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::SeqCst);
    format!("{prefix}{ms:x}{n:x}")
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------- storage

/// Portable by default: `<exe folder>/data`. Falls back to the OS config dir
/// only if the exe folder is not writable (e.g. installed under Program Files).
pub fn resolve_data_dir(app: &AppHandle) -> PathBuf {
    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let d = dir.join("data");
            if std::fs::create_dir_all(&d).is_ok() {
                let probe = d.join(".write-test");
                if std::fs::write(&probe, b"ok").is_ok() {
                    let _ = std::fs::remove_file(probe);
                    return d;
                }
            }
        }
    }
    let d = app
        .path()
        .app_config_dir()
        .unwrap_or_else(|_| PathBuf::from("data"));
    let _ = std::fs::create_dir_all(&d);
    d
}

pub fn load(dir: &Path) -> Config {
    let path = dir.join("config.json");
    let mut cfg = match std::fs::read_to_string(&path) {
        Ok(text) => match serde_json::from_str::<Config>(&text) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("[ttco] config.json is invalid ({e}); keeping a backup and starting fresh");
                let _ = std::fs::copy(&path, dir.join(format!("config.broken-{}.json", now_ms())));
                Config::default()
            }
        },
        Err(_) => Config::default(),
    };
    if cfg.version == 0 {
        cfg.version = 1;
    }
    // v1 -> v2: Ctrl+Alt+H becomes the manual "fade now" key; the hover on/off
    // switch moves to Ctrl+Alt+Shift+H (only if the user never changed it).
    if let Some(sc) = cfg.settings.get_mut("shortcuts").and_then(|v| v.as_object_mut()) {
        if !sc.contains_key("toggleFade") {
            if sc.get("toggleHoverFade").and_then(|v| v.as_str()) == Some("Ctrl+Alt+H") {
                sc.insert("toggleHoverFade".into(), json!("Ctrl+Alt+Shift+H"));
                sc.insert("toggleFade".into(), json!("Ctrl+Alt+H"));
            } else {
                sc.insert("toggleFade".into(), json!(""));
            }
        }
    }
    cfg.version = 2;
    fill_defaults(&mut cfg.settings, &default_settings());
    // Manual fade is a temporary state — always start un-faded.
    cfg.settings["dimmed"] = json!(false);
    cfg
}

fn write_config(dir: &Path, cfg: &Config) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let tmp = dir.join("config.json.tmp");
    let text = serde_json::to_string_pretty(cfg)?;
    std::fs::write(&tmp, text)?;
    std::fs::rename(&tmp, dir.join("config.json"))
}

/// Background thread that flushes the config to disk shortly after changes.
pub fn start_saver(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(700));
        let st = app.state::<AppState>();
        if st.dirty.load(Ordering::SeqCst) {
            st.save_now();
        }
    });
}
