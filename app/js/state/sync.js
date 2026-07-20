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

export async function pickSaveFile() {
  const handle = await window.showSaveFilePicker({
    suggestedName: 'cadence-shared-save.json',
    types: [{ description: 'Cadence shared save', accept: { 'application/json': ['.json'] } }],
  });
  await kvSet('fileHandle', handle);
  return handle;
}

export async function getSavedHandle() {
  return kvGet('fileHandle');
}

export async function ensurePermission(handle, interactive = false) {
  try {
    if (await handle.queryPermission({ mode: 'readwrite' }) === 'granted') return true;
    if (!interactive) return false;
    return await handle.requestPermission({ mode: 'readwrite' }) === 'granted';
  } catch { return false; }
}

export async function readFileEnvelope(handle) {
  try {
    const file = await handle.getFile();
    const text = await file.text();
    return text.trim() ? JSON.parse(text) : null;
  } catch { return null; }
}

export async function writeFileEnvelope(handle, envelope) {
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
