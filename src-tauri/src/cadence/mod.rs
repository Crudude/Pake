// Cadence shell: the two things the stock Pake wrapper can't do.
//
// 1. bridge — save-file access for engines without the File System
//    Access API (WKWebView on macOS). The webview may only ever touch
//    the ONE file the user picked in a native dialog; its path lives in
//    a shell-side config file, never in the page.
// 2. update — at launch, look for a signed app bundle in the shared
//    folder ("<save file's folder>/app-update/") and serve it instead
//    of the built-in copy when its version is higher and its Ed25519
//    signature verifies against the key baked into this binary.
//
// Same origin, same identifier, same storage — an update changes only
// which bytes the tauri asset protocol serves under /app/.

pub mod bridge;
pub mod update;

use std::path::PathBuf;

/// Immutable facts the bridge commands report to the page.
pub struct CadenceState {
    pub identifier: String,
    pub builtin_version: String,
    pub update_active: Option<String>,
}

/// <config_dir>/<identifier>/cadence-shell.json — must resolve the same
/// way tauri's app_config_dir does, but WITHOUT an AppHandle: the update
/// check runs before the app is built.
pub fn shell_config_path(identifier: &str) -> Option<PathBuf> {
    Some(
        dirs::config_dir()?
            .join(identifier)
            .join("cadence-shell.json"),
    )
}

#[derive(serde::Serialize, serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ShellConfig {
    pub save_file: Option<String>,
}

pub fn read_shell_config(identifier: &str) -> ShellConfig {
    shell_config_path(identifier)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

pub fn write_shell_config(identifier: &str, config: &ShellConfig) -> Result<(), String> {
    let path = shell_config_path(identifier).ok_or("no config dir on this platform")?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    std::fs::write(&path, json).map_err(|e| e.to_string())
}
