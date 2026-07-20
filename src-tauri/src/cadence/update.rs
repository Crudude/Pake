// Signed app-update loader.
//
// The shared folder is a SYNC CHANNEL, not a trust root: anything in it
// is untrusted bytes until the Ed25519 signature verifies against the
// public key baked in below. The zip is re-verified on EVERY launch —
// the extraction cache is only reused when the verified zip's hash
// matches what was extracted. No valid bundle (or any error at all)
// means the built-in app runs; the updater can never brick the shell.

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};
use std::borrow::Cow;
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use tauri::utils::assets::{AssetKey, AssetsIter, CspHash};
use tauri::{Assets, Wry};

// tools/keygen.mjs output — the matching PRIVATE key lives with Josh,
// next to the passphrases. Changing this key strands every installed
// shell on its built-in version.
const UPDATE_PUBKEY: [u8; 32] = [
    0x64, 0x8c, 0x6e, 0xd4, 0x7e, 0x8d, 0x75, 0x5e, 0x36, 0x3c, 0xf6, 0x7e, 0x73, 0x0e, 0x79, 0x09,
    0xb2, 0x90, 0x18, 0xd5, 0x3a, 0x5a, 0x74, 0x2d, 0xbc, 0x5a, 0x45, 0x7a, 0xe0, 0x5c, 0x15, 0x6c,
];

// Pake ≥3.15 serves a local app at the ORIGIN ROOT (dist/index.html →
// "/index.html"); the bundle's files are keyed the same way. Pake's own
// dist files (cli.js) aren't in bundles and fall through to embedded.
const MAX_BUNDLE_BYTES: u64 = 50 * 1024 * 1024;

pub fn parse_version(v: &str) -> Option<(u64, u64, u64)> {
    let mut parts = v.trim().split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next()?.parse().ok()?;
    if parts.next().is_some() {
        return None;
    }
    Some((major, minor, patch))
}

fn bundle_version(file_name: &str) -> Option<(u64, u64, u64, String)> {
    let rest = file_name
        .strip_prefix("cadence-app-")?
        .strip_suffix(".zip")?;
    let (a, b, c) = parse_version(rest)?;
    Some((a, b, c, rest.to_string()))
}

fn verify_bundle(zip_bytes: &[u8], sig_bytes: &[u8]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(&UPDATE_PUBKEY) else {
        return false;
    };
    let Ok(sig_arr) = <[u8; 64]>::try_from(sig_bytes) else {
        return false;
    };
    key.verify(zip_bytes, &Signature::from_bytes(&sig_arr))
        .is_ok()
}

/// Highest-version bundle in `dir` that is newer than `builtin` and
/// properly signed. Returns (zip bytes, version string).
fn best_valid_bundle(dir: &Path, builtin: (u64, u64, u64)) -> Option<(Vec<u8>, String)> {
    let mut candidates: Vec<((u64, u64, u64), String, PathBuf)> = std::fs::read_dir(dir)
        .ok()?
        .flatten()
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            let (a, b, c, ver) = bundle_version(&name)?;
            if (a, b, c) <= builtin {
                return None;
            }
            Some(((a, b, c), ver, entry.path()))
        })
        .collect();
    candidates.sort_by(|x, y| y.0.cmp(&x.0));

    for (_, ver, zip_path) in candidates {
        let Ok(meta) = std::fs::metadata(&zip_path) else {
            continue;
        };
        if meta.len() > MAX_BUNDLE_BYTES {
            eprintln!("[cadence] update {ver}: bundle too large, skipping");
            continue;
        }
        let sig_path = PathBuf::from(format!("{}.sig", zip_path.display()));
        // An Ed25519 signature is exactly 64 bytes — check BEFORE
        // reading so a planted multi-GB .sig can't stall the launch.
        if std::fs::metadata(&sig_path)
            .map(|m| m.len() != 64)
            .unwrap_or(true)
        {
            continue;
        }
        let (Ok(zip_bytes), Ok(sig_bytes)) = (std::fs::read(&zip_path), std::fs::read(&sig_path))
        else {
            continue;
        };
        if verify_bundle(&zip_bytes, &sig_bytes) {
            return Some((zip_bytes, ver));
        }
        eprintln!("[cadence] update {ver}: signature INVALID, ignoring bundle");
    }
    None
}

/// Extract with a zip-slip guard: every entry must be a plain relative
/// path. Any suspicious entry aborts the whole extraction.
fn extract_zip(zip_bytes: &[u8], dest: &Path) -> Result<(), String> {
    let mut archive =
        zip::ZipArchive::new(std::io::Cursor::new(zip_bytes)).map_err(|e| e.to_string())?;
    for i in 0..archive.len() {
        let mut entry = archive.by_index(i).map_err(|e| e.to_string())?;
        let raw_name = entry.name().replace('\\', "/");
        if raw_name.ends_with('/') {
            continue; // directory entries — created on demand below
        }
        let rel = Path::new(&raw_name);
        let unsafe_entry = rel.is_absolute()
            || rel
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)));
        if unsafe_entry {
            return Err(format!("unsafe zip entry: {raw_name}"));
        }
        let out = dest.join(rel);
        if let Some(parent) = out.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let mut bytes = Vec::new();
        entry.read_to_end(&mut bytes).map_err(|e| e.to_string())?;
        std::fs::write(&out, bytes).map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// Verify + (re)extract the best bundle. Returns the directory holding
/// the update's app files and its version, or None to run built-in.
pub fn prepare(identifier: &str, builtin_version: &str) -> Option<(PathBuf, String)> {
    let builtin = parse_version(builtin_version)?;
    let save_file = super::read_shell_config(identifier).save_file?;
    let update_dir = Path::new(&save_file).parent()?.join("app-update");
    if !update_dir.is_dir() {
        return None;
    }

    let (zip_bytes, version) = best_valid_bundle(&update_dir, builtin)?;
    let hash = {
        let mut h = Sha256::new();
        h.update(&zip_bytes);
        format!("{:x}", h.finalize())
    };

    let live_root = dirs::config_dir()?.join(identifier).join("app-live");
    let dest = live_root.join(&version);
    let marker = dest.join(".cadence-extracted");

    let cached = std::fs::read_to_string(&marker)
        .map(|m| m.trim() == hash)
        .unwrap_or(false);
    if !cached {
        let _ = std::fs::remove_dir_all(&dest);
        if let Err(e) = std::fs::create_dir_all(&dest)
            .map_err(|e| e.to_string())
            .and_then(|_| extract_zip(&zip_bytes, &dest))
        {
            eprintln!("[cadence] update {version}: extraction failed ({e}), running built-in app");
            let _ = std::fs::remove_dir_all(&dest);
            return None;
        }
        if std::fs::write(&marker, &hash).is_err() {
            eprintln!("[cadence] update {version}: cannot write marker, running built-in app");
            return None;
        }
        // Older extracted versions are dead weight now.
        if let Ok(entries) = std::fs::read_dir(&live_root) {
            for entry in entries.flatten() {
                if entry.file_name().to_string_lossy() != version.as_str() {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
        }
    }

    let index = dest.join("index.html");
    if !index.is_file() {
        eprintln!("[cadence] update {version}: no index.html in bundle, running built-in app");
        return None;
    }
    Some((dest, version))
}

/// Read every file of the update into memory, keyed the way the tauri
/// asset protocol asks for them ("/app/js/main.js").
pub fn load_files(dir: &Path) -> Result<HashMap<String, Vec<u8>>, String> {
    let mut files = HashMap::new();
    let mut stack = vec![dir.to_path_buf()];
    while let Some(current) = stack.pop() {
        for entry in std::fs::read_dir(&current)
            .map_err(|e| e.to_string())?
            .flatten()
        {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path.file_name().is_some_and(|n| n != ".cadence-extracted") {
                let rel = path
                    .strip_prefix(dir)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/");
                let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
                files.insert(format!("/{rel}"), bytes);
            }
        }
    }
    if files.is_empty() {
        return Err("update directory is empty".into());
    }
    Ok(files)
}

/// Placeholder used only for the two-step assets swap in lib.rs.
pub struct EmptyAssets;

impl Assets<Wry> for EmptyAssets {
    fn get(&self, _key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        None
    }
    fn iter(&self) -> Box<AssetsIter<'_>> {
        Box::new(std::iter::empty())
    }
    fn csp_hashes(&self, _html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        Box::new(std::iter::empty())
    }
}

/// The update's files over the embedded assets. Only /app/* is ever
/// overridden — Pake's own dist files keep coming from the binary.
pub struct OverlayAssets {
    files: HashMap<String, Vec<u8>>,
    fallback: Box<dyn Assets<Wry>>,
}

impl OverlayAssets {
    pub fn new(files: HashMap<String, Vec<u8>>, fallback: Box<dyn Assets<Wry>>) -> Self {
        Self { files, fallback }
    }

    fn lookup(&self, key: &str) -> Option<&Vec<u8>> {
        // The window loads "/" — that's the bundle's index.
        if key.is_empty() || key == "/" {
            return self.files.get("/index.html");
        }
        self.files.get(key)
    }
}

impl Assets<Wry> for OverlayAssets {
    fn get(&self, key: &AssetKey) -> Option<Cow<'_, [u8]>> {
        if let Some(bytes) = self.lookup(key.as_ref()) {
            return Some(Cow::Borrowed(bytes));
        }
        self.fallback.get(key)
    }

    fn iter(&self) -> Box<AssetsIter<'_>> {
        let ours = self
            .files
            .iter()
            .map(|(k, v)| (Cow::Borrowed(k.as_str()), Cow::Borrowed(v.as_slice())));
        let fallback = self
            .fallback
            .iter()
            .filter(|(k, _)| !self.files.contains_key(k.as_ref()));
        Box::new(ours.chain(fallback))
    }

    fn csp_hashes(&self, html_path: &AssetKey) -> Box<dyn Iterator<Item = CspHash<'_>> + '_> {
        // CSP is disabled in this shell's config; hashes are only
        // meaningful for embedded HTML anyway.
        self.fallback.csp_hashes(html_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn version_parsing() {
        assert_eq!(parse_version("0.9.2"), Some((0, 9, 2)));
        assert_eq!(parse_version("10.0.0"), Some((10, 0, 0)));
        assert_eq!(parse_version("1.2"), None);
        assert_eq!(parse_version("1.2.3.4"), None);
        assert_eq!(parse_version("abc"), None);
    }

    #[test]
    fn bundle_name_parsing() {
        assert_eq!(
            bundle_version("cadence-app-0.9.3.zip").map(|v| v.3),
            Some("0.9.3".into())
        );
        assert_eq!(bundle_version("cadence-app-.zip"), None);
        assert_eq!(bundle_version("other-1.0.0.zip"), None);
    }

    #[test]
    fn rejects_garbage_signature() {
        assert!(!verify_bundle(b"payload", &[0u8; 64]));
        assert!(!verify_bundle(b"payload", &[0u8; 10]));
    }

    #[test]
    fn zip_slip_is_rejected() {
        // Hand-built stored zip with a traversal entry name.
        let mut bytes = Vec::new();
        {
            let mut w = zip::ZipWriter::new(std::io::Cursor::new(&mut bytes));
            let opts: zip::write::SimpleFileOptions = Default::default();
            w.start_file("../evil.txt", opts).unwrap();
            use std::io::Write;
            w.write_all(b"nope").unwrap();
            w.finish().unwrap();
        }
        let dest = std::env::temp_dir().join("cadence-zip-slip-test");
        let _ = std::fs::remove_dir_all(&dest);
        std::fs::create_dir_all(&dest).unwrap();
        assert!(extract_zip(&bytes, &dest).is_err());
        let _ = std::fs::remove_dir_all(&dest);
    }
}
