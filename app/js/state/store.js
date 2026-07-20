// Single in-memory document + subscribe/notify. The whole dataset is
// one small JSON doc; every mutation persists a full snapshot.
//
// The envelope wraps the doc so that encryption can be added later
// (format: 'plain' -> 'aes-gcm') without a data migration.

import { saveSnapshot, loadLatest, requestPersistence, deletePlainSnapshots } from './db.js';
import { uniqueCode } from '../domain/names.js';
import { SESSION_DURATIONS, BLOCK_DURATIONS } from '../domain/time.js';
import {
  createEncryptedEnvelope, unlockEnvelope, sealEnvelope,
  decryptWithRawKeys, exportRawKeys,
} from './crypto.js';
import {
  kvGet, kvSet, kvDel, getSavedHandle, ensurePermission,
  readFileEnvelope, writeFileEnvelope, deviceId as getDeviceId,
} from './sync.js';

export const SCHEMA_VERSION = 1;

export function emptyData() {
  return {
    schemaVersion: SCHEMA_VERSION,
    settings: { parityLabelFlipped: false, lastBackupAt: null, viewMode: 'split' },
    clients: [],
    assignments: [],
    waitlist: [],
  };
}

export function validEnvelope(env) {
  return !!env
    && env.format === 'plain'
    && env.schemaVersion === SCHEMA_VERSION
    && !!env.data
    && typeof env.data === 'object'
    && Array.isArray(env.data.clients)
    && Array.isArray(env.data.assignments)
    && !!env.data.settings;
}

// Fill in fields added after a save was written, so older snapshots and
// backups load cleanly. Runs on every load and restore.
export function normalizeData(data) {
  const s = data.settings;
  if (s.parityLabelFlipped === undefined) s.parityLabelFlipped = false;
  if (s.lastBackupAt === undefined) s.lastBackupAt = null;
  if (s.viewMode === undefined || !['split', 'even', 'odd'].includes(s.viewMode)) s.viewMode = 'split';
  if (!Array.isArray(data.waitlist)) data.waitlist = [];
  if (!data.weekPlans || typeof data.weekPlans !== 'object' || Array.isArray(data.weekPlans)) data.weekPlans = {};
  if (!Array.isArray(data.blocks)) data.blocks = [];
  for (const b of data.blocks) {
    if (b.label === undefined) b.label = 'Break';
    if (!BLOCK_DURATIONS.includes(b.duration)) b.duration = 30;
  }
  if (!Array.isArray(data.todos)) data.todos = [];
  if (!Array.isArray(data.reading)) data.reading = [];
  if (!Array.isArray(data.training)) data.training = [];
  // Status strings land in class names and lookup tables, so anything a
  // corrupt or hand-edited backup smuggles in gets clamped to a member
  // of the real set.
  for (const t of data.todos) {
    if (!Array.isArray(t.updates)) t.updates = [];
    if (!['open', 'done'].includes(t.status)) t.status = 'open';
    if (t.assignee === undefined) t.assignee = '';
  }
  for (const r of data.reading) {
    if (!['to-read', 'reading', 'done'].includes(r.status)) r.status = 'to-read';
    if (r.notes === undefined) r.notes = '';
    if (r.author === undefined) r.author = '';
  }
  for (const t of data.training) {
    if (!Array.isArray(t.progress)) t.progress = [];
    if (!['planned', 'in-progress', 'done'].includes(t.status)) t.status = 'planned';
    if (t.goal === undefined) t.goal = '';
    if (t.target === undefined) t.target = '';
  }
  for (const [k, plan] of Object.entries(data.weekPlans)) {
    if (!plan || typeof plan !== 'object') { delete data.weekPlans[k]; continue; }
    for (const bucket of [plan.statuses, plan.flex]) {
      if (!bucket) continue;
      for (const [id, v] of Object.entries(bucket)) {
        if (!['pending', 'booked', 'skipped'].includes(v)) delete bucket[id];
      }
    }
  }
  for (const c of data.clients) {
    // Older saves had flat location/modality; they became the client's
    // personal session-type list (most clients have one, some have an
    // extra parent session etc).
    if (!Array.isArray(c.sessions) || !c.sessions.length) {
      c.sessions = [{
        id: uid(),
        label: 'Session',
        location: c.location || '',
        modality: c.modality || '',
        duration: 60,
        jane: null,
      }];
    }
    for (const t of c.sessions) {
      if (!t.id) t.id = uid();
      if (t.label === undefined) t.label = 'Session';
      if (t.location === undefined) t.location = '';
      if (t.modality === undefined) t.modality = '';
      if (!SESSION_DURATIONS.includes(t.duration)) t.duration = 60;
      if (t.jane === undefined) t.jane = null;
    }
    delete c.location;
    delete c.modality;
    if (c.jane === undefined) c.jane = null;
    if (!['weekly', 'biweekly', 'monthly', 'self'].includes(c.type)) c.type = 'biweekly';
    if (!['active', 'paused', 'closed'].includes(c.status)) c.status = 'active';
    if (c.closed === undefined) c.closed = null;
    if (c.autoName === undefined) c.autoName = true;
    if (!c.casePlan) c.casePlan = { workingOn: '', nextSession: '', longTermGoals: '', log: [] };
    if (!Array.isArray(c.casePlan.log)) c.casePlan.log = [];
    if (c.formulation === undefined) c.formulation = null;
  }
  // Display codes auto-follow the Jane-side full name until the therapist
  // sets her own — and must stay unique, or two clients become
  // indistinguishable on the grid. Hand-set names are claimed first;
  // client order makes the outcome deterministic on every device.
  const taken = new Set();
  for (const c of data.clients) {
    if (!(c.autoName && c.jane?.name)) taken.add(c.name);
  }
  for (const c of data.clients) {
    if (c.autoName && c.jane?.name) {
      const code = uniqueCode(c.jane.name, taken);
      if (code) { c.name = code; taken.add(code); }
    }
  }
  for (const a of data.assignments) {
    const c = data.clients.find((x) => x.id === a.clientId);
    if (c && (!a.sessionId || !c.sessions.some((t) => t.id === a.sessionId))) {
      a.sessionId = c.sessions[0].id;
    }
    if (!SESSION_DURATIONS.includes(a.duration)) a.duration = 60;
  }
  return data;
}

let state = null;
const listeners = new Set();

export const handlers = { onPersistError: null };

// True when the last IndexedDB read FAILED (as opposed to finding an
// empty store). While set, persistence is disabled so the rolling trim
// can't march intact snapshots out of the window under a re-entered
// dataset.
export const status = { loadError: false };

// Shared-save session: whether encryption is on, which role unlocked,
// the live keys, the latest sealed envelope, and the linked file.
export const session = {
  encrypted: false,
  locked: false,
  role: 'therapist',
  keys: null,
  envelope: null,
  handle: null,
  filePermission: false,
  // Identity of the shared file as this device last saw it. Both halves
  // matter: two devices sealing from the same base produce the SAME rev,
  // so rev alone cannot detect a foreign write.
  fileRev: null,
  fileDevice: null,
  deviceId: null,
  // A boot-time divergence the UI must surface once it's ready — the
  // conflict handler isn't registered until after initStore returns.
  pendingConflict: null,
};

function isEncryptedEnvelope(env) {
  return !!env && env.format === 'cadence-encrypted' && !!env.practice && !!env.roles;
}

export async function initStore() {
  session.deviceId = await getDeviceId();
  session.handle = await getSavedHandle();
  let fileEnv = null;
  if (session.handle) {
    session.filePermission = await ensurePermission(session.handle, false);
    if (session.filePermission) fileEnv = await readFileEnvelope(session.handle);
  }

  const res = await loadLatest((e) => validEnvelope(e) || isEncryptedEnvelope(e));
  status.loadError = res.error;
  const local = res.envelope;

  // Prefer whichever encrypted copy is newest. The shared file wins a
  // tie only when it shares lineage (same device) — an equal-rev file
  // from the OTHER device is a divergence, not a newer copy, and must
  // not silently shadow local edits.
  let chosen = local;
  let divergentTie = false;
  const fr = fileEnv?.rev ?? 0;
  const lr = local?.rev ?? 0;
  if (isEncryptedEnvelope(fileEnv)
    && (!local || fr > lr || (fr === lr && fileEnv.deviceId === local.deviceId))) {
    chosen = fileEnv;
  } else if (isEncryptedEnvelope(fileEnv) && fr === lr && fileEnv.deviceId !== local.deviceId) {
    // Divergent tie: keep local and stash the conflict — the UI raises
    // it once boot (and any unlock) has finished. A setTimeout here
    // would fire before main.js registers the handler, or while locked,
    // and the divergence would be silently forgotten.
    divergentTie = true;
    session.pendingConflict = fileEnv;
  }

  if (isEncryptedEnvelope(chosen)) {
    session.encrypted = true;
    session.envelope = chosen;
    // On a divergent tie the file is NOT "as we last wrote it" — poison
    // the identity so the first save re-raises the conflict instead of
    // taking the unchanged fast-path and clobbering the foreign copy.
    session.fileRev = divergentTie ? -1 : (isEncryptedEnvelope(fileEnv) ? fileEnv.rev : null);
    session.fileDevice = divergentTie ? null : (isEncryptedEnvelope(fileEnv) ? (fileEnv.deviceId ?? null) : null);
    const cached = await kvGet('keyCache');
    const opened = cached ? await decryptWithRawKeys(chosen, cached) : null;
    if (opened) {
      session.role = opened.role;
      session.keys = opened.keys;
      state = normalizeData(opened.data);
      session.locked = false;
    } else {
      session.locked = true;
      state = null;
    }
    // Retroactive hygiene for installs that encrypted before plaintext
    // purging existed: no plain snapshot may outlive encryption.
    if (!res.error) deletePlainSnapshots().catch(() => {});
  } else {
    state = normalizeData(chosen ? chosen.data : emptyData());
  }

  if (!res.error) requestPersistence();
  return state;
}

export async function unlockWithPassphrase(passphrase) {
  const opened = await unlockEnvelope(session.envelope, passphrase);
  if (!opened) return false;
  session.role = opened.role;
  session.keys = opened.keys;
  session.locked = false;
  state = normalizeData(opened.data);
  // The cache is a convenience, not a requirement — a failed write must
  // not make a correct passphrase look wrong.
  try { await kvSet('keyCache', await exportRawKeys(opened.keys)); } catch { /* ask again next launch */ }
  emit({});
  return true;
}

// Turn encryption on for the current data. Called once, by the
// therapist, from Settings.
export async function setupEncryption(therapistPass, adminPass) {
  const env = await createEncryptedEnvelope(state, therapistPass, adminPass,
    { rev: (session.envelope?.rev ?? 0) + 1, deviceId: session.deviceId });
  const opened = await unlockEnvelope(env, therapistPass);
  session.encrypted = true;
  session.locked = false;
  session.role = 'therapist';
  session.keys = opened.keys;
  session.envelope = env;
  try { await kvSet('keyCache', await exportRawKeys(opened.keys)); } catch { /* ask again next launch */ }
  try {
    await saveSnapshot(env);
    // Purge plaintext history only once the encrypted snapshot is truly
    // committed — never strand the user with zero recoverable snapshots.
    await deletePlainSnapshots();
  } catch (err) {
    if (handlers.onPersistError) handlers.onPersistError(err);
  }
  await flushFileWrite(env);
}

// Therapist-only: decrypt everything back to plain local storage. The
// shared file is forgotten too — leaving it linked would let its stale
// encrypted copy win the boot-time preference and resurrect old data
// over everything edited after this point.
export async function disableEncryption() {
  if (session.role !== 'therapist') return false;
  clearTimeout(writeTimer);
  writeTimer = null;
  session.encrypted = false;
  session.envelope = null;
  session.keys = null;
  session.handle = null;
  session.filePermission = false;
  session.fileRev = null;
  session.fileDevice = null;
  await kvDel('keyCache');
  await kvDel('fileHandle');
  persist();
  return true;
}

export async function lockDevice() {
  clearTimeout(writeTimer);
  writeTimer = null;
  flushPendingEdits();
  if (session.encrypted && session.keys && !session.locked) {
    // Seal the very latest state and push it out before the reload kills
    // pending timers — otherwise the last edits exist nowhere.
    try {
      const env = await currentEnvelope();
      await saveSnapshot(env).catch(() => {});
      await flushFileWrite(env);
    } catch { /* lock anyway; the last committed snapshot still stands */ }
  }
  await kvDel('keyCache');
  location.reload();
}

// Point the session at a save file. If the file already holds an
// encrypted save, nothing is written — the caller decides whether to
// adopt the file's data or overwrite it (a user "restoring" a backup by
// linking it must never have the backup clobbered by the current state).
export async function linkSaveFile(handle) {
  session.handle = handle;
  session.filePermission = true;
  const existing = await readFileEnvelope(handle);
  if (isEncryptedEnvelope(existing)) {
    // Poisoned identity until the user chooses adopt/overwrite: a
    // debounced write armed before the picker opened must not be able to
    // pass the unchanged fast-path and clobber this file mid-decision.
    session.fileRev = -1;
    session.fileDevice = null;
    return { status: 'existing', envelope: existing };
  }
  session.fileRev = null;
  session.fileDevice = null;
  if (session.encrypted && session.envelope) await flushFileWrite(session.envelope);
  return { status: 'linked' };
}

// Adopt the data inside another envelope of this practice's lineage —
// a freshly linked file, or the pre-delete stash. Returns false when the
// keys don't match (a different-passphrase lineage cannot be merged).
// The rev is bumped to at least the session's current one so the adopted
// (possibly older) copy can never be shadowed by higher-rev leftovers.
export async function adoptEnvelope(envelope, { isFileContent = false } = {}) {
  const raw = await exportRawKeys(session.keys);
  const opened = await decryptWithRawKeys(envelope, raw);
  if (!opened) return false;
  // When the envelope IS the linked file's current content, its original
  // identity (pre-bump) is exactly what the next write should treat as
  // "last seen" — clears the poison linkSaveFile set.
  if (isFileContent) {
    session.fileRev = envelope.rev ?? 0;
    session.fileDevice = envelope.deviceId ?? null;
  }
  envelope.rev = Math.max(envelope.rev ?? 0, session.envelope?.rev ?? 0);
  session.envelope = envelope;
  session.role = opened.role;
  session.keys = opened.keys;
  replaceData(normalizeData(opened.data));
  return true;
}

// Overwrite a linked file that held another save: an EXPLICIT user
// choice, so it writes directly — the conflict guard would (correctly)
// veto it. The rev jumps above the file's so the write is ordered after
// everything the file had.
export async function overwriteLinkedFile(envelope) {
  session.envelope.rev = Math.max(session.envelope.rev ?? 0, envelope.rev ?? 0);
  const env = await currentEnvelope();
  await saveSnapshot(env).catch(() => {});
  try {
    await writeFileEnvelope(session.handle, env);
    session.fileRev = env.rev;
    session.fileDevice = env.deviceId ?? null;
  } catch (err) {
    if (handlers.onPersistError) handlers.onPersistError(err);
  }
}

let writeTimer = null;
async function flushFileWrite(env) {
  if (!session.handle || !session.filePermission) return;
  const current = await readFileEnvelope(session.handle);
  if (isEncryptedEnvelope(current)) {
    const unchanged = session.fileRev !== null
      && current.rev === session.fileRev
      && current.deviceId === session.fileDevice;
    // Never seen the file this session (boot read failed)? Only defer to
    // it when it's a foreign copy at-or-ahead of us; otherwise it's our
    // own older write and safe to replace.
    const foreignAhead = current.deviceId !== session.deviceId
      && (current.rev ?? 0) >= (env.rev ?? 0);
    if (!unchanged && (session.fileRev !== null || foreignAhead)) {
      if (handlers.onSyncConflict) handlers.onSyncConflict(current);
      return;
    }
  }
  try {
    await writeFileEnvelope(session.handle, env);
    session.fileRev = env.rev;
    session.fileDevice = env.deviceId ?? null;
  } catch (err) {
    if (handlers.onPersistError) handlers.onPersistError(err);
  }
}

function scheduleFileWrite(env) {
  clearTimeout(writeTimer);
  // When the app is being hidden (minimize, quit) the debounce window
  // would die with the page — write immediately instead.
  const delay = document.visibilityState === 'hidden' ? 0 : 800;
  writeTimer = setTimeout(() => { writeTimer = null; flushFileWrite(env); }, delay);
}

// Push an already-armed debounced write out right now (quit/hide path).
// Strictly a no-op when nothing is pending: this runs on every window
// blur, and an unconditional write could clobber a just-linked file
// while its adopt/overwrite dialog is still open.
export function flushFileNow() {
  if (!writeTimer) return;
  clearTimeout(writeTimer);
  writeTimer = null;
  if (session.encrypted && session.envelope) flushFileWrite(session.envelope);
}

export function getState() {
  return state;
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function emit(meta) {
  for (const fn of [...listeners]) fn(state, meta || {});
}

export function makeEnvelope() {
  return {
    format: 'plain',
    schemaVersion: SCHEMA_VERSION,
    app: 'cadence',
    savedAt: new Date().toISOString(),
    data: state,
  };
}

// Encrypted saves are strictly serialized through this chain. Two
// concurrent seals would both read the same previous envelope and both
// produce rev N+1 — and whichever crypto op finished LAST would become
// the persisted truth, silently reverting the other one's data. Each
// queued task re-reads session/state when it runs, so back-to-back
// mutations coalesce into sealing the latest state.
let persistChain = Promise.resolve();

function persist() {
  if (status.loadError) return;
  if (session.encrypted) {
    persistChain = persistChain.then(async () => {
      if (!session.encrypted || !session.keys) return; // turned off meanwhile
      const env = await sealEnvelope(session.envelope, state, session.role, session.keys,
        { deviceId: session.deviceId });
      session.envelope = env;
      scheduleFileWrite(env);
      await saveSnapshot(env);
    }).catch((err) => {
      if (handlers.onPersistError) handlers.onPersistError(err);
    });
    return;
  }
  saveSnapshot(makeEnvelope()).catch((err) => {
    if (handlers.onPersistError) handlers.onPersistError(err);
  });
}

// The freshest sealable envelope, ordered after every pending persist —
// for callers about to hand the data somewhere else (backup file,
// pre-delete safety copy, lock-time flush).
export function currentEnvelope() {
  if (!session.encrypted) return Promise.resolve(makeEnvelope());
  const p = persistChain.then(async () => {
    const env = await sealEnvelope(session.envelope, state, session.role, session.keys,
      { deviceId: session.deviceId });
    session.envelope = env;
    return env;
  });
  persistChain = p.then(() => {}, () => {});
  return p;
}

// Modules with debounced edits register a flusher; callers that are
// about to serialize state (export, restore, quit) run them first.
const flushers = new Set();
export function registerFlusher(fn) { flushers.add(fn); }
export function flushPendingEdits() { for (const fn of [...flushers]) fn(); }

// One debounced-field-save implementation for every UI module that
// commits text fields as the user types (drawer, formulation). Returns
// a saver: saver(key, mutateFn, meta) queues the commit; saver.flush()
// runs everything pending right now (wired to focusout so tab-away
// commits immediately). The flusher registration covers export/quit.
export function makeFieldSaver(delayMs) {
  const pending = new Map();
  const flush = () => {
    for (const [, entry] of [...pending]) {
      clearTimeout(entry.timer);
      entry.run();
    }
  };
  registerFlusher(flush);
  const saver = (key, mutateFn, meta) => {
    const existing = pending.get(key);
    if (existing) clearTimeout(existing.timer);
    const run = () => {
      pending.delete(key);
      mutate(mutateFn, meta);
    };
    pending.set(key, { timer: setTimeout(run, delayMs), run });
  };
  saver.flush = flush;
  return saver;
}

export function mutate(fn, meta) {
  fn(state);
  persist();
  emit(meta);
}

export function replaceData(data, meta) {
  state = data;
  persist();
  emit(meta);
}

let uidCounter = 0;
export function uid() {
  uidCounter += 1;
  return `${Date.now().toString(36)}-${uidCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
