// Save-file bridge commands. Deliberately narrow: the page can pick one
// file (native dialog), then read/write/unlink THAT file only. No
// command accepts a path from the page — a compromised page can never
// roam the filesystem through this surface.

use super::{read_shell_config, write_shell_config, CadenceState, ShellConfig};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Runtime, State};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellInfo {
    pub shell: bool,
    pub shell_version: String,
    pub builtin_app_version: String,
    pub update_active: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveTarget {
    pub name: String,
}

fn linked_path(state: &CadenceState) -> Option<PathBuf> {
    read_shell_config(&state.identifier)
        .save_file
        .map(PathBuf::from)
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| "cadence-shared-save.json".into())
}

// All commands run on the async runtime's workers ((async) annotation):
// tauri executes plain sync commands inline on the main/UI thread, and
// blocking file I/O there — e.g. OneDrive hydrating a cloud-only
// placeholder — would freeze the whole app.
#[tauri::command(async)]
pub fn cadence_shell_info(state: State<'_, CadenceState>) -> ShellInfo {
    ShellInfo {
        shell: true,
        shell_version: env!("CARGO_PKG_VERSION").into(),
        builtin_app_version: state.builtin_version.clone(),
        update_active: state.update_active.clone(),
    }
}

#[tauri::command(async)]
pub fn cadence_linked_save(state: State<'_, CadenceState>) -> Option<SaveTarget> {
    linked_path(&state).map(|p| SaveTarget {
        name: file_name(&p),
    })
}

/// Native save dialog on the MAIN thread (WKWebView/NSPanel requirement);
/// the command itself runs on a worker, so blocking recv() is safe.
#[tauri::command]
pub async fn cadence_pick_save_file<R: Runtime>(
    app: AppHandle<R>,
    state: State<'_, CadenceState>,
) -> Result<Option<SaveTarget>, String> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<PathBuf>>();
    let start_dir = linked_path(&state).and_then(|p| p.parent().map(Path::to_path_buf));
    app.run_on_main_thread(move || {
        let mut dialog = rfd::FileDialog::new()
            .set_title("Cadence shared save")
            .set_file_name("cadence-shared-save.json")
            .add_filter("Cadence shared save", &["json"]);
        if let Some(dir) = start_dir {
            dialog = dialog.set_directory(dir);
        }
        let _ = tx.send(dialog.save_file());
    })
    .map_err(|e| e.to_string())?;

    let picked = rx.recv().map_err(|e| e.to_string())?;
    let Some(path) = picked else { return Ok(None) };

    write_shell_config(
        &state.identifier,
        &ShellConfig {
            save_file: Some(path.to_string_lossy().into_owned()),
        },
    )?;
    Ok(Some(SaveTarget {
        name: file_name(&path),
    }))
}

/// None = no file linked, or linked file doesn't exist yet (both mean
/// "nothing to read", matching the FSA backend's semantics).
#[tauri::command(async)]
pub fn cadence_read_save(state: State<'_, CadenceState>) -> Result<Option<String>, String> {
    let Some(path) = linked_path(&state) else {
        return Ok(None);
    };
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Write via fsynced temp file + atomic rename — std::fs::rename
/// replaces the destination in one step on BOTH platforms (MoveFileExW
/// with REPLACE_EXISTING on Windows, rename(2) on macOS), so at no
/// instant does the shared file not exist and a crash can't tear it.
#[tauri::command(async)]
pub fn cadence_write_save(state: State<'_, CadenceState>, contents: String) -> Result<(), String> {
    use std::io::Write;
    let Some(path) = linked_path(&state) else {
        return Err("no save file linked".into());
    };
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("json.tmp-cadence");
    {
        let mut file = std::fs::File::create(&tmp).map_err(|e| e.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|e| e.to_string())?;
        // Flushed to disk BEFORE the rename: power loss must never be
        // able to land an empty or torn replacement.
        file.sync_all().map_err(|e| e.to_string())?;
    }
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

#[tauri::command(async)]
pub fn cadence_unlink_save(state: State<'_, CadenceState>) -> Result<(), String> {
    write_shell_config(&state.identifier, &ShellConfig { save_file: None })
}
