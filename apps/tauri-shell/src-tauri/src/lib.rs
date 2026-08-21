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
use tauri_plugin_dialog::DialogExt;

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
