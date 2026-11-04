//! Tiny loopback HTTP server that lets web-widget overlays show local HTML widgets.
//!
//! WebView2 refuses to show `file:///` pages inside the overlay page, so the
//! frontend rewrites `file:///C:/dir/page.html` to
//! `http://127.0.0.1:<port>/<token>/C:/dir/page.html` and this server serves it
//! (relative scripts / styles resolve the same way).
//!
//! Why a loopback server instead of a Tauri custom protocol: Tauri treats every
//! protocol registered by the app as part of the app itself, which would give a
//! local widget — and any remote script it loads — full access to the app's
//! commands. Pages served from 127.0.0.1 are "remote" to Tauri, so its
//! permission system blocks all IPC from them.
//!
//! Hardening:
//! * binds to 127.0.0.1 only;
//! * every URL must start with a random per-launch token (other local programs
//!   or websites can't guess it);
//! * the Host header must be the loopback address (blocks DNS rebinding);
//! * only files inside the folder of a local widget the user configured (or its
//!   sub-folders) are served — never a whole drive;
//! * GET / HEAD only, no directory listings.

use crate::config::{s, AppState};
use std::collections::hash_map::RandomState;
use std::hash::{BuildHasher, Hasher};
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, Manager};

fn random_token() -> String {
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let mut out = String::new();
    for i in 0..2u64 {
        // RandomState is seeded from the OS RNG.
        let mut h = RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u64(i);
        h.write_usize(std::process::id() as usize);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or("");
            if let Ok(b) = u8::from_str_radix(hex, 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// `file:///C:/a%20b/x.html#p=1`, `C:\a b\x.html` -> `C:/a b/x.html`
pub fn local_path_of(url: &str) -> Option<PathBuf> {
    let u = url.trim();
    let rest = if let Some(r) = u.strip_prefix("file:///").or_else(|| u.strip_prefix("file://")) {
        r
    } else if u.len() > 2 && u.as_bytes()[1] == b':' && u.as_bytes()[0].is_ascii_alphabetic() {
        u
    } else {
        return None;
    };
    let rest = rest.split(['#', '?']).next().unwrap_or("");
    Some(PathBuf::from(percent_decode(rest).replace('\\', "/")))
}

/// Folders the user has pointed a local widget at (never a drive root).
fn allowed_roots(app: &AppHandle) -> Vec<PathBuf> {
    let st = app.state::<AppState>();
    let urls: Vec<String> = match st.cfg.lock() {
        Ok(cfg) => cfg
            .overlays
            .iter()
            .filter(|o| s(o, "kind") == "web")
            .filter_map(|o| o.get("web").map(|w| s(w, "url").to_string()))
            .collect(),
        Err(_) => return vec![],
    };
    urls.iter()
        .filter_map(|u| local_path_of(u))
        .filter_map(|p| p.parent().map(Path::to_path_buf))
        .filter_map(|d| std::fs::canonicalize(d).ok())
        .filter(|d| d.parent().is_some())
        .collect()
}

fn mime(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase().as_str() {
        "html" | "htm" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "mp3" => "audio/mpeg",
        "wav" => "audio/wav",
        "ogg" => "audio/ogg",
        "mp4" => "video/mp4",
        "webm" => "video/webm",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

fn reply(stream: &mut TcpStream, code: u16, reason: &str, ctype: &str, body: &[u8], head_only: bool) {
    let header = format!(
        "HTTP/1.1 {code} {reason}\r\nContent-Type: {ctype}\r\nContent-Length: {}\r\nCache-Control: no-cache\r\nX-Content-Type-Options: nosniff\r\nConnection: close\r\n\r\n",
        body.len()
    );
    let _ = stream.write_all(header.as_bytes());
    if !head_only {
        let _ = stream.write_all(body);
    }
    let _ = stream.flush();
}

fn handle(app: &AppHandle, mut stream: TcpStream, port: u16, token: &str) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let _ = stream.set_write_timeout(Some(Duration::from_secs(10)));

    // Read the request head (we never need a body).
    let mut buf = Vec::with_capacity(2048);
    let mut chunk = [0u8; 2048];
    while !buf.windows(4).any(|w| w == b"\r\n\r\n") {
        match stream.read(&mut chunk) {
            Ok(0) | Err(_) => return,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
        }
        if buf.len() > 16 * 1024 {
            return reply(&mut stream, 431, "Request Header Fields Too Large", "text/plain", b"", false);
        }
    }
    let head = String::from_utf8_lossy(&buf);
    let mut lines = head.split("\r\n");
    let mut first = lines.next().unwrap_or("").split(' ');
    let (method, target) = (first.next().unwrap_or(""), first.next().unwrap_or(""));
    let head_only = method == "HEAD";
    if method != "GET" && !head_only {
        return reply(&mut stream, 405, "Method Not Allowed", "text/plain", b"", false);
    }

    let host = lines
        .filter_map(|l| l.split_once(':'))
        .find(|(k, _)| k.trim().eq_ignore_ascii_case("host"))
        .map(|(_, v)| v.trim().to_ascii_lowercase())
        .unwrap_or_default();
    if host != format!("127.0.0.1:{port}") && host != format!("localhost:{port}") {
        return reply(&mut stream, 403, "Forbidden", "text/plain", b"Bad host", head_only);
    }

    let path_part = target.split(['?', '#']).next().unwrap_or("");
    let Some(rest) = path_part.strip_prefix(&format!("/{token}/")) else {
        return reply(&mut stream, 404, "Not Found", "text/plain", b"Not found", head_only);
    };
    let path = PathBuf::from(percent_decode(rest));
    let Ok(real) = std::fs::canonicalize(&path) else {
        return reply(&mut stream, 404, "Not Found", "text/plain", b"Not found", head_only);
    };
    if !real.is_file() || !allowed_roots(app).iter().any(|root| real.starts_with(root)) {
        return reply(&mut stream, 403, "Forbidden", "text/plain", b"This folder is not used by any web-widget overlay.", head_only);
    }
    match std::fs::read(&real) {
        Ok(bytes) => reply(&mut stream, 200, "OK", mime(&real), &bytes, head_only),
        Err(_) => reply(&mut stream, 500, "Internal Server Error", "text/plain", b"Read error", head_only),
    }
}

/// Starts the server; prefers `preferred_port` so widgets keep their
/// localStorage between launches. Returns (port, base URL).
pub fn start(app: AppHandle, preferred_port: u16) -> Option<(u16, String)> {
    let listener = (preferred_port != 0)
        .then(|| TcpListener::bind(("127.0.0.1", preferred_port)).ok())
        .flatten()
        .or_else(|| TcpListener::bind(("127.0.0.1", 0)).ok())?;
    let port = listener.local_addr().ok()?.port();
    let token = random_token();
    let base = format!("http://127.0.0.1:{port}/{token}/");
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let app = app.clone();
            let token = token.clone();
            std::thread::spawn(move || handle(&app, stream, port, &token));
        }
    });
    Some((port, base))
}
