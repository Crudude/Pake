// Two-role envelope encryption for the shared save file.
//
// Two random AES-256-GCM data keys:
//   practiceKey — schedule, clients, scheduling notes, tasks, etc.
//   clinicalKey — per-client case plans + session logs only.
// The therapist passphrase wraps BOTH keys; the admin passphrase wraps
// only the practice key. So one file, two passphrases: the therapist
// sees everything, the admin sees scheduling but case information stays
// ciphertext to them — and an admin save carries the clinical blob
// through untouched.
//
// After first unlock the RAW key material is cached in this device's
// IndexedDB (never inside the synced file) — that's what makes
// decryption feel automatic on each computer. The guard for that cache
// is the OS login + disk encryption; "Lock now" clears it.

const KDF_ITERATIONS = 600_000;

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}
function unb64(str) {
  return Uint8Array.from(atob(str), (c) => c.charCodeAt(0));
}
function rand(n) {
  return crypto.getRandomValues(new Uint8Array(n));
}

async function deriveWrappingKey(passphrase, salt) {
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: KDF_ITERATIONS },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function newDataKey() {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
}

async function wrapKey(dataKey, wrappingKey) {
  const raw = await crypto.subtle.exportKey('raw', dataKey);
  const iv = rand(12);
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, wrappingKey, raw);
  return { iv: b64(iv), key: b64(wrapped) };
}

async function unwrapKey(wrapped, wrappingKey) {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(wrapped.iv) }, wrappingKey, unb64(wrapped.key),
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
}

async function encryptJSON(obj, key) {
  const iv = rand(12);
  const ciphertext = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(obj)),
  );
  return { iv: b64(iv), ciphertext: b64(ciphertext) };
}

async function decryptJSON(blob, key) {
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: unb64(blob.iv) }, key, unb64(blob.ciphertext),
  );
  return JSON.parse(dec.decode(plain));
}

// Case information out (case plans, session logs AND formulations);
// everything else stays. The practice compartment keeps empty stand-ins
// so its shape stays valid for the admin role.
export function splitData(data) {
  const clinical = {};
  const practice = structuredClone(data);
  for (const c of practice.clients) {
    clinical[c.id] = { casePlan: c.casePlan, formulation: c.formulation ?? null };
    c.casePlan = { workingOn: '', nextSession: '', longTermGoals: '', log: [] };
    c.formulation = null;
  }
  return { practice, clinical };
}

export function mergeData(practice, clinical) {
  const data = structuredClone(practice);
  for (const c of data.clients) {
    const secret = clinical[c.id];
    if (secret) {
      // Legacy shape (pre-formulation) stored the casePlan directly.
      if (secret.casePlan || secret.formulation !== undefined) {
        c.casePlan = secret.casePlan || c.casePlan;
        c.formulation = secret.formulation ?? null;
      } else {
        c.casePlan = secret;
      }
    }
  }
  return data;
}

export async function createEncryptedEnvelope(data, therapistPass, adminPass, meta = {}) {
  const practiceKey = await newDataKey();
  const clinicalKey = await newDataKey();

  const tSalt = rand(16);
  const aSalt = rand(16);
  const tWrap = await deriveWrappingKey(therapistPass, tSalt);
  const aWrap = await deriveWrappingKey(adminPass, aSalt);

  const { practice, clinical } = splitData(data);

  return {
    format: 'cadence-encrypted',
    version: 1,
    rev: meta.rev ?? 1,
    deviceId: meta.deviceId ?? null,
    savedAt: new Date().toISOString(),
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS },
    roles: {
      therapist: {
        salt: b64(tSalt),
        practiceKey: await wrapKey(practiceKey, tWrap),
        clinicalKey: await wrapKey(clinicalKey, tWrap),
      },
      admin: {
        salt: b64(aSalt),
        practiceKey: await wrapKey(practiceKey, aWrap),
      },
    },
    practice: await encryptJSON(practice, practiceKey),
    clinical: await encryptJSON(clinical, clinicalKey),
  };
}

// Try therapist first, then admin. Wrong passphrase for both -> null.
export async function unlockEnvelope(envelope, passphrase) {
  for (const role of ['therapist', 'admin']) {
    const slot = envelope.roles[role];
    if (!slot) continue;
    try {
      const wrap = await deriveWrappingKey(passphrase, unb64(slot.salt));
      const practiceKey = await unwrapKey(slot.practiceKey, wrap);
      const practice = await decryptJSON(envelope.practice, practiceKey);
      if (role === 'therapist') {
        const clinicalKey = await unwrapKey(slot.clinicalKey, wrap);
        const clinical = await decryptJSON(envelope.clinical, clinicalKey);
        return { role, keys: { practiceKey, clinicalKey }, data: mergeData(practice, clinical) };
      }
      return { role, keys: { practiceKey }, data: practice };
    } catch {
      // wrong passphrase for this role — try the next
    }
  }
  return null;
}

// Re-seal after edits. The admin role has no clinical key, so the
// clinical compartment from the loaded envelope rides through unchanged.
export async function sealEnvelope(previous, data, role, keys, meta = {}) {
  const { practice, clinical } = splitData(data);
  return {
    ...previous,
    rev: (previous.rev ?? 0) + 1,
    deviceId: meta.deviceId ?? previous.deviceId,
    savedAt: new Date().toISOString(),
    practice: await encryptJSON(practice, keys.practiceKey),
    clinical: role === 'therapist'
      ? await encryptJSON(clinical, keys.clinicalKey)
      : previous.clinical,
  };
}

export async function exportRawKeys(keys) {
  const out = { practice: await crypto.subtle.exportKey('raw', keys.practiceKey) };
  if (keys.clinicalKey) out.clinical = await crypto.subtle.exportKey('raw', keys.clinicalKey);
  return out;
}

// Unlock with device-cached raw key material (no passphrase) — the
// "decrypts automatically on this computer" path.
export async function decryptWithRawKeys(envelope, raw) {
  const importOne = (buf) => crypto.subtle.importKey('raw', buf, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  try {
    const practiceKey = await importOne(raw.practice);
    const practice = await decryptJSON(envelope.practice, practiceKey);
    if (raw.clinical) {
      const clinicalKey = await importOne(raw.clinical);
      const clinical = await decryptJSON(envelope.clinical, clinicalKey);
      return { role: 'therapist', keys: { practiceKey, clinicalKey }, data: mergeData(practice, clinical) };
    }
    return { role: 'admin', keys: { practiceKey }, data: practice };
  } catch {
    return null;
  }
}

// Round-trip sanity check, runnable from the console:
//   (await import('./js/state/crypto.js')).selfTest()
export async function selfTest() {
  const data = {
    clients: [
      { id: 'c1', name: 'AAl', casePlan: { workingOn: 'SECRET', nextSession: '', longTermGoals: '', log: [{ date: '2026-07-19', text: 'SECRET NOTE' }] }, formulation: { core: 'SECRET FORMULATION' }, schedulingNotes: 'mornings' },
    ],
    assignments: [{ id: 'a1', clientId: 'c1', day: 2, start: 600, duration: 60, parity: 'both' }],
    settings: {},
  };
  const env = await createEncryptedEnvelope(data, 'therapist-pass', 'admin-pass');

  const t = await unlockEnvelope(env, 'therapist-pass');
  if (t.role !== 'therapist' || t.data.clients[0].casePlan.workingOn !== 'SECRET') throw new Error('therapist unlock failed');

  const a = await unlockEnvelope(env, 'admin-pass');
  if (a.role !== 'admin' || a.data.clients[0].casePlan.workingOn !== '') throw new Error('admin must not see case info');
  if (a.data.clients[0].formulation !== null) throw new Error('admin must not see formulations');
  if (a.data.clients[0].schedulingNotes !== 'mornings') throw new Error('admin must see scheduling notes');

  if (await unlockEnvelope(env, 'wrong') !== null) throw new Error('wrong passphrase must fail');
  if (JSON.stringify(env).includes('SECRET')) throw new Error('plaintext leaked into envelope');

  // Admin edits the schedule; the clinical blob must survive untouched.
  a.data.assignments[0].start = 660;
  const env2 = await sealEnvelope(env, a.data, 'admin', a.keys);
  const t2 = await unlockEnvelope(env2, 'therapist-pass');
  if (t2.data.assignments[0].start !== 660) throw new Error('admin edit lost');
  if (t2.data.clients[0].casePlan.log[0].text !== 'SECRET NOTE') throw new Error('clinical lost after admin save');
  if (t2.data.clients[0].formulation?.core !== 'SECRET FORMULATION') throw new Error('formulation lost after admin save');
  if (env2.rev !== env.rev + 1) throw new Error('rev must increment');

  return 'crypto self-test passed: roles, secrecy, admin save, rev guard';
}
