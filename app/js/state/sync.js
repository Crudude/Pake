// Device-local plumbing for the shared encrypted save file: the file
// handle (points into the OneDrive folder), cached key material, and a
// device id. All of it stays in THIS device's IndexedDB — never in the
// synced file itself.

const DB_NAME = 'cadence-device';
const STORE = 'kv';

let dbp = null;
function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    dbp.catch(() => { dbp = null; });
  }
  return dbp;
}

export async function kvGet(key) {
  try {
    const db = await open();
    return await new Promise((resolve) => {
      const req = db.transaction(STORE).objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => resolve(null);
    });
  } catch { return null; }
}

export async function kvSet(key, value) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(value, key);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

export async function kvDel(key) {
  try { await kvSet(key, null); } catch { /* best effort */ }
}

export function fsaSupported() {
  return typeof window.showSaveFilePicker === 'function';
}

/* ---------- Cadence shell bridge (macOS desktop build) ----------
   WKWebView has no File System Access API; the custom shell exposes a
   narrow command surface instead: pick ONE file via native dialog, then
   read/write/unlink that file only (the path lives shell-side, never in
   the page). Handles from this backend are plain
   `{ shell: true, name }` objects — the rest of the app treats handles
   opaquely, so nothing outside this module knows the difference. */

let shellBridge = false;

function shellInvoke(cmd, args) {
  return window.__TAURI__.core.invoke(cmd, args);
}

function isShellHandle(handle) {
  return !!handle && handle.shell === true;
}

// Must run before getSavedHandle (initStore does). The plain Pake build
// also exposes window.__TAURI__ but not the cadence commands, so the
// probe has to actually call one. The bridge is preferred over FSA
// wherever it answers — only the bridge records the save path in the
// shell config that anchors the update loader, so an FSA-first rule
// would leave the WINDOWS shell's updater permanently inert.
export async function initSyncBackend() {
  if (!window.__TAURI__?.core?.invoke) return;
  try {
    const info = await shellInvoke('cadence_shell_info');
    shellBridge = !!info?.shell;
  } catch { /* stock shell without the bridge */ }
}

// Gates the "Choose save file…" UI: true wherever SOME backend exists.
export function fileLinkingSupported() {
  return fsaSupported() || shellBridge;
}

export async function pickSaveFile() {
  if (shellBridge) {
    const target = await shellInvoke('cadence_pick_save_file');
    // Same contract as the FSA picker: dismissal throws, callers catch.
    if (!target) throw new Error('picker dismissed');
    return { shell: true, name: target.name };
  }
  if (fsaSupported()) {
    const handle = await window.showSaveFilePicker({
      suggestedName: 'cadence-shared-save.json',
      types: [{ description: 'Cadence shared save', accept: { 'application/json': ['.json'] } }],
    });
    await kvSet('fileHandle', handle);
    return handle;
  }
  throw new Error('file linking is not supported on this build');
}

export async function getSavedHandle() {
  if (shellBridge) {
    const target = await shellInvoke('cadence_linked_save').catch(() => null);
    return target ? { shell: true, name: target.name } : null;
  }
  return kvGet('fileHandle');
}

// Forget the linked file on whichever backend holds it. A shell-side
// failure PROPAGATES — callers like disableEncryption must abort rather
// than report success while the stale link survives.
export async function unlinkSaveFile() {
  if (shellBridge) await shellInvoke('cadence_unlink_save');
  await kvDel('fileHandle');
}

export async function ensurePermission(handle, interactive = false) {
  if (isShellHandle(handle)) return true; // shell paths need no grant
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (!interactive) return false;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch { return false; }
}

export async function readFileEnvelope(handle) {
  try {
    if (isShellHandle(handle)) {
      const text = await shellInvoke('cadence_read_save');
      return text?.trim() ? JSON.parse(text) : null;
    }
    const file = await handle.getFile();
    const text = await file.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch { return null; }
}

export async function writeFileEnvelope(handle, envelope) {
  if (isShellHandle(handle)) {
    await shellInvoke('cadence_write_save', { contents: JSON.stringify(envelope) });
    return;
  }
  const writable = await handle.createWritable();
  await writable.write(JSON.stringify(envelope));
  await writable.close();
}

export async function deviceId() {
  let id = await kvGet('deviceId');
  if (!id) {
    id = Math.random().toString(36).slice(2, 10);
    await kvSet('deviceId', id);
  }
  return id;
}
