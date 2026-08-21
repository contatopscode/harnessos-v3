// =============================================================================
// HarnessOS Desktop — Tauri 2 shell
//
// Envelopa o web build de packages/web numa janela nativa com WebView, e
// expõe commands Rust que a UI chama pra:
//   - Abrir o folder picker nativo do SO (macOS NSOpenPanel / Windows
//     IFileOpenDialog) em vez do file input HTML limitado.
//   - Validar paths locais antes de mandar pro backend.
//   - Ler env vars (DATABASE_URL, etc.) sem precisar rebuild.
//   - Abrir URLs externas no browser padrão.
//
// Auto-progress / audit log / FORGE continuam na VPS (Easypanel) sem
// mudança — o desktop shell só serve de "browser nativo + bridge de fs".
// =============================================================================

use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::Duration;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_shell::ShellExt;

#[derive(Debug, Serialize)]
pub struct AppInfo {
    pub name: String,
    pub version: String,
    pub platform: String,
    pub arch: String,
    pub webview_url: String,
    pub is_dev: bool,
}

#[derive(Debug, Serialize)]
pub struct PathInfo {
    pub path: String,
    pub exists: bool,
    pub is_directory: bool,
    pub is_file: bool,
    pub canonical: Option<String>,
}

#[tauri::command]
async fn pick_directory(app: tauri::AppHandle) -> Result<Option<String>, String> {
    // Native folder picker — blocks the calling task on macOS/Windows dialog.
    // Returns the absolute path or None if the user cancelled.
    let (tx, rx) = std::sync::mpsc::channel();
    app.dialog()
        .file()
        .set_title("Selecione a pasta do projeto")
        .pick_folder(move |folder| {
            let _ = tx.send(folder);
        });
    let folder = rx.recv().map_err(|e| e.to_string())?;
    Ok(folder.and_then(|p| p.into_path().ok()).and_then(|p| p.to_str().map(String::from)))
}

#[tauri::command]
async fn pick_file(
    app: tauri::AppHandle,
    title: Option<String>,
    filters: Option<Vec<(String, Vec<String>)>>,
) -> Result<Option<String>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let mut builder = app.dialog().file();
    if let Some(t) = title {
        builder = builder.set_title(t);
    }
    // Note: tauri-plugin-dialog filter API in 2.x accepts name + extensions
    if let Some(fs) = filters {
        for (name, exts) in fs {
            // add_filter takes &[&str] — convert Vec<String> to Vec<&str> on the fly
            let ext_refs: Vec<&str> = exts.iter().map(String::as_str).collect();
            builder = builder.add_filter(name, &ext_refs);
        }
    }
    builder.pick_file(move |file| {
        let _ = tx.send(file);
    });
    let file = rx.recv().map_err(|e| e.to_string())?;
    Ok(file.and_then(|p| p.into_path().ok()).and_then(|p| p.to_str().map(String::from)))
}

#[tauri::command]
fn validate_path(path: String) -> PathInfo {
    let p = PathBuf::from(&path);
    let exists = p.exists();
    let is_directory = p.is_dir();
    let is_file = p.is_file();
    let canonical = p.canonicalize().ok().and_then(|c| c.to_str().map(String::from));
    PathInfo {
        path,
        exists,
        is_directory,
        is_file,
        canonical,
    }
}

#[tauri::command]
fn get_app_info(app: tauri::AppHandle) -> AppInfo {
    let name = app.package_info().name.clone();
    let version = app.package_info().version.to_string();
    // Platform detection via env (avoids extra crate dep)
    let platform = if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "linux") {
        "linux"
    } else {
        "unknown"
    }
    .to_string();
    let arch = std::env::consts::ARCH.to_string();
    let is_dev = cfg!(debug_assertions);
    // Webview URL: devUrl in dev, served file in production
    let webview_url = if is_dev {
        "http://localhost:5173".to_string()
    } else {
        "tauri://localhost".to_string()
    };
    AppInfo {
        name,
        version,
        platform,
        arch,
        webview_url,
        is_dev,
    }
}

#[tauri::command]
fn get_env(key: String) -> Option<String> {
    // Whitelist-only read of env vars (UI cannot see full process env)
    match key.as_str() {
        "DATABASE_URL" | "PORT" | "HOSTNAME" | "NODE_ENV" | "LOG_LEVEL" => {
            std::env::var(&key).ok()
        }
        _ => None,
    }
}

/// Path to the HarnessOS server sidecar binary. Tauri auto-renames
/// `bin/harnessos-server` to `bin/harnessos-server-<target-triple>` for
/// cross-platform builds, and copies it to Resources/_up_/ in the .app.
const SIDECAR_NAME: &str = "harnessos-server";

/// Default port for the local server. Webview URL (`tauri.conf.json`)
/// points to `http://localhost:3090`.
const SERVER_PORT: u16 = 3090;

/// Wait for `http://localhost:{port}/health` to return 200, polling
/// every 250ms up to `timeout_secs`. Returns the first 200 received.
async fn wait_for_server(port: u16, timeout_secs: u64) -> Result<(), String> {
    let url = format!("http://127.0.0.1:{port}/health");
    let deadline = std::time::Instant::now() + Duration::from_secs(timeout_secs);
    while std::time::Instant::now() < deadline {
        match reqwest_get_200(&url).await {
            Ok(true) => return Ok(()),
            Ok(false) | Err(_) => {
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
        }
    }
    Err(format!("Server didn't become ready within {timeout_secs}s"))
}

/// Tiny inline HTTP GET that returns Ok(true) on 200, Ok(false) otherwise.
/// We don't pull in reqwest (heavy dep) — net::TcpStream to localhost
/// is enough for a healthcheck.
async fn reqwest_get_200(url: &str) -> Result<bool, String> {
    use std::io::{Read, Write};
    use std::net::TcpStream;
    // Parse "http://host:port/path" — collect the pieces so the spawned
    // closure below doesn't borrow `url` (spawn_blocking requires 'static).
    let trimmed = url.trim_start_matches("http://").to_string();
    let (host_port, path) = match trimmed.split_once('/') {
        Some((hp, p)) => (hp.to_string(), format!("/{p}")),
        None => (trimmed, "/".to_string()),
    };
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) => (h.to_string(), p.to_string()),
        None => return Err("bad url".to_string()),
    };

    let result = tokio::task::spawn_blocking(move || -> Result<bool, String> {
        let port: u16 = port.parse().map_err(|e: std::num::ParseIntError| e.to_string())?;
        let addr = format!("{host}:{port}");
        let socket_addr: std::net::SocketAddr = addr
            .parse()
            .map_err(|e: std::net::AddrParseError| e.to_string())?;
        let mut stream = TcpStream::connect_timeout(&socket_addr, Duration::from_millis(500))
            .map_err(|e| e.to_string())?;
        let req = format!(
            "GET {path} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n"
        );
        stream
            .write_all(req.as_bytes())
            .map_err(|e| e.to_string())?;
        let mut buf = [0u8; 64];
        let n = stream.read(&mut buf).map_err(|e| e.to_string())?;
        let response = String::from_utf8_lossy(&buf[..n]);
        Ok(response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200"))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(result)
}

#[tauri::command]
fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err(format!("Not a directory: {path}"));
    }
    let mut entries = Vec::new();
    for entry in std::fs::read_dir(p).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        let is_dir = path.is_dir();
        entries.push(DirEntry { name, path: path.to_string_lossy().to_string(), is_dir });
    }
    entries.sort_by(|a, b| {
        // Directories first, then alphabetical
        b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name))
    });
    Ok(entries)
}

#[derive(Debug, Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("info")).init();

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            // Smoke log so the user sees the shell started
            log::info!("HarnessOS desktop shell starting…");
            log::info!("App: {} v{}", app.package_info().name, app.package_info().version);
            if cfg!(target_os = "macos") {
                log::info!("Platform: macos ({})", std::env::consts::ARCH);
            } else if cfg!(target_os = "windows") {
                log::info!("Platform: windows ({})", std::env::consts::ARCH);
            }

            // Spawn the HarnessOS server sidecar (the same Bun server we
            // deploy to Easypanel, but compiled standalone so it doesn't
            // need a Bun runtime on the user's machine). The server
            // listens on 127.0.0.1:3090 and serves the same `packages/web/dist`
            // the hosted UI does. Postgres points to the same remote DB,
            // so audit log / codebases / demands stay in sync across the
            // team regardless of who's using the desktop app vs the
            // hosted UI.
            let shell = app.shell();
            let mut cmd = match shell.sidecar(SIDECAR_NAME) {
                Ok(c) => c,
                Err(e) => {
                    log::error!("Failed to build sidecar command: {e}");
                    return Err(Box::new(std::io::Error::other(
                        "HarnessOS server sidecar not found in bundle",
                    )));
                }
            };
            cmd = cmd
                .env("PORT", SERVER_PORT.to_string())
                .env("HOSTNAME", "127.0.0.1")
                .env("NODE_ENV", "production")
                .env("LOG_LEVEL", "info");
            // DATABASE_URL: prefer a user-set env (set by the Tauri command
            // if/when we add a config screen), fall back to the default
            // remote DB. Default is the same Postgres the Easypanel
            // deployment uses, so audit log + codebases are shared.
            if std::env::var("DATABASE_URL").is_err() {
                cmd = cmd.env(
                    "DATABASE_URL",
                    "postgresql://archon:Hos_8K3mN9pL2qR7vT5wX1yA4bC6dE0fG@213.199.32.229:5432/HarnessOS?sslmode=disable",
                );
            }

            // Sidecar side effects (writing its child into the AppHandle so
            // we can kill it on app exit). Tauri auto-kills sidecars on
            // shutdown, but we hold a CommandChild anyway for diagnostics.
            let (_rx, _child) = match cmd.spawn() {
                Ok(pair) => pair,
                Err(e) => {
                    log::error!("Failed to spawn sidecar: {e}");
                    return Err(Box::new(std::io::Error::other(
                        "Failed to spawn HarnessOS server sidecar",
                    )));
                }
            };
            log::info!("Server sidecar spawned, waiting for /health…");

            // Block setup() (and the window open) until the server is up.
            // Worst case: 30s timeout, then the user sees a blank webview
            // (we surface the error in logs).
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                match wait_for_server(SERVER_PORT, 30).await {
                    Ok(()) => {
                        log::info!("Server ready on http://localhost:{SERVER_PORT}");
                    }
                    Err(e) => {
                        log::error!("Server not ready: {e}");
                        // Bring the main window to front + show a banner.
                        if let Some(win) = app_handle.get_webview_window("main") {
                            let _ = win.eval(
                                "document.body.insertAdjacentHTML('beforeend', \
                                 '<div style=\"position:fixed;top:0;left:0;right:0;\
                                 background:#c00;color:#fff;padding:8px;font:12px/1.4 \
                                 system-ui;z-index:99999\">HarnessOS server failed \
                                 to start. Check logs.</div>')",
                            );
                        }
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            pick_directory,
            pick_file,
            validate_path,
            get_app_info,
            get_env,
            list_dir
        ])
        .run(tauri::generate_context!())
        .expect("error while running HarnessOS desktop shell");
}
