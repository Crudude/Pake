// IndexedDB snapshot persistence. Every mutation writes a whole new
// snapshot; we keep a rolling window so a corrupt write can never take
// the data with it. Writes happen at mutation time, never at window
// close — WKWebView persists storage asynchronously and close-time
// writes are a known loss vector (tauri#4455).

const DB_NAME = 'cadence-planner';
const STORE = 'snapshots';
const KEEP = 20;

let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'seq', autoIncrement: true });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    // A failed open must not poison the session — clear the cache so the
    // next save/load attempt retries.
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

export async function saveSnapshot(envelope) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    store.add(structuredClone(envelope));
    const countReq = store.count();
    countReq.onsuccess = () => {
      let excess = countReq.result - KEEP;
      if (excess > 0) {
        store.openCursor().onsuccess = (e) => {
          const cursor = e.target.result;
          if (cursor && excess > 0) {
            cursor.delete();
            excess -= 1;
            cursor.continue();
          }
        };
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

// Newest snapshot that passes validation, walking backward past corrupt
// records. Crucially distinguishes "the store is empty" from "the read
// failed": booting empty over intact data would let the rolling trim
// destroy the real snapshots as the user re-enters data.
export async function loadLatest(validate) {
  let db;
  try {
    db = await open();
  } catch {
    return { error: true, envelope: null };
  }
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; resolve(v); } };
    let tx;
    try {
      tx = db.transaction(STORE, 'readonly');
    } catch {
      done({ error: true, envelope: null });
      return;
    }
    const req = tx.objectStore(STORE).openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (!cursor) { done({ error: false, envelope: null }); return; }
      let ok = false;
      try { ok = validate(cursor.value); } catch { ok = false; }
      if (ok) {
        done({ error: false, envelope: cursor.value });
      } else {
        try { cursor.continue(); } catch { done({ error: true, envelope: null }); }
      }
    };
    req.onerror = () => done({ error: true, envelope: null });
    tx.onabort = () => done({ error: true, envelope: null });
  });
}

// Once encryption is on, plaintext history must not linger: the rolling
// window would otherwise keep pre-encryption snapshots (with clinical
// fields readable) for up to 20 more saves.
export async function deletePlainSnapshots() {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).openCursor().onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor) {
        if (cursor.value && cursor.value.format === 'plain') cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export function requestPersistence() {
  try { navigator.storage?.persist?.(); } catch { /* best effort */ }
}
