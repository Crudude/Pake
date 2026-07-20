// The verbs of the app. Every schedule change funnels through here so
// validation and messaging stay in one place.
//
// A client's `sessions` array is her personal session-type list
// (label, location, modality, duration) — most clients have one, some
// have an extra parent session etc. Each grid assignment references
// one via sessionId.

import { getState, mutate, uid } from './state/store.js';
import { deriveCode, uniqueCode } from './domain/names.js';
import {
  canPlace, conflictsFor, assignmentsOf, blockConflictsFor, fitsDay, overlaps,
} from './domain/schedule.js';
import { DAYS, DAY_END, SESSION_DURATIONS, todayISO, fmtTime } from './domain/time.js';
import { toast } from './ui/toast.js';

function client(id) {
  return getState().clients.find((c) => c.id === id) || null;
}

export function primarySession(c) {
  return c.sessions[0];
}

export function sessionOf(c, sessionId) {
  return c.sessions.find((t) => t.id === sessionId) || c.sessions[0];
}

export function newSessionType(label = 'Session') {
  return { id: uid(), label, location: '', modality: '', duration: 60, jane: null };
}

// The one place the client shape is defined. Every creation path (add
// dialog, Jane import, sample data) builds on this so a new field can't
// be forgotten in one of them.
export function newClient({ name, type, autoName = true, jane = null, sessions, ...extra }) {
  return {
    id: uid(),
    name,
    autoName,
    type,
    status: 'active',
    paused: null,
    closed: null,
    formulation: null,
    sessions: sessions || [newSessionType()],
    jane,
    schedulingNotes: '',
    casePlan: { workingOn: '', nextSession: '', longTermGoals: '', log: [] },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...extra,
  };
}

// Longest of (preferred, 60, 30) that still fits before closing.
function fittingDuration(preferred, start) {
  for (const d of [preferred, 60, 30]) {
    if (d && start + d <= DAY_END) return d;
  }
  return null;
}

// What would placing/moving produce at this target? Used by drop
// validation and by the actual drop.
function blockPlacementOk(state, cand, ignoreId = null) {
  return fitsDay(cand)
    && !conflictsFor(state, cand).length
    && !blockConflictsFor(state, cand, ignoreId).length;
}

export function candidateFor(payload, day, parityIdx, start) {
  const state = getState();
  if (payload.kind === 'block') {
    const b = state.blocks.find((x) => x.id === payload.id);
    if (!b) return null;
    return { block: b, cand: { ...b, day, start, parity: 'both' }, ignoreId: b.id };
  }
  if (payload.kind === 'assignment') {
    const a = state.assignments.find((x) => x.id === payload.id);
    if (!a) return null;
    return {
      cand: { ...a, day, start, parity: a.parity === 'both' ? 'both' : parityIdx },
      ignoreId: a.id,
    };
  }
  const c = client(payload.id);
  if (!c) return null;
  if (c.type === 'monthly' || c.type === 'self') return { flexible: true };
  const sess = primarySession(c);
  const duration = fittingDuration(sess.duration, start);
  if (!duration) return null;
  return {
    cand: {
      id: null,
      clientId: c.id,
      day,
      start,
      duration,
      parity: c.type === 'weekly' ? 'both' : parityIdx,
      sessionId: sess.id,
    },
    ignoreId: null,
  };
}

export function dropAllowed(payload, day, parityIdx, start) {
  const target = candidateFor(payload, day, parityIdx, start);
  if (!target || target.flexible) return false;
  if (target.block) return blockPlacementOk(getState(), target.cand, target.ignoreId);
  return canPlace(getState(), target.cand, target.ignoreId).ok;
}

/* ---------- blocked time (breaks, meetings) ---------- */

export function addBlock(day, start, { label = 'Break', duration = 30 } = {}) {
  const cand = { day, start, duration, parity: 'both' };
  if (!fitsDay(cand)) { toast('Past closing time', 'warn'); return null; }
  if (!blockPlacementOk(getState(), cand)) { toast('Someone already sits there', 'warn'); return null; }
  const id = uid();
  mutate((s) => { s.blocks.push({ id, day, start, duration, label }); });
  return id;
}

export function moveBlock(blockId, day, start) {
  const state = getState();
  const b = state.blocks.find((x) => x.id === blockId);
  if (!b) return false;
  const cand = { ...b, day, start, parity: 'both' };
  if (!blockPlacementOk(state, cand, b.id)) { toast('Someone already sits there', 'warn'); return false; }
  mutate((s) => { Object.assign(s.blocks.find((x) => x.id === blockId), { day, start }); });
  return true;
}

export function updateBlock(blockId, { label, duration }) {
  const state = getState();
  const b = state.blocks.find((x) => x.id === blockId);
  if (!b) return;
  if (duration && duration !== b.duration) {
    const cand = { ...b, duration, parity: 'both' };
    if (!blockPlacementOk(state, cand, b.id)) {
      toast('That length runs into someone', 'warn');
      duration = b.duration;
    }
  }
  mutate((s) => {
    const target = s.blocks.find((x) => x.id === blockId);
    if (label !== undefined) target.label = label || 'Break';
    if (duration) target.duration = duration;
  });
}

export function removeBlock(blockId) {
  mutate((s) => { s.blocks = s.blocks.filter((x) => x.id !== blockId); });
}

export function placeClient(clientId, day, parityIdx, start) {
  const c = client(clientId);
  if (!c) return false;
  if (c.type === 'monthly' || c.type === 'self') {
    toast(`${c.name} is flexible — she lives in the tray, not the grid`);
    return false;
  }
  const sess = primarySession(c);
  const duration = fittingDuration(sess.duration, start);
  if (!duration) { toast('Past closing time', 'warn'); return false; }
  const cand = {
    id: uid(),
    clientId,
    day,
    start,
    duration,
    parity: c.type === 'weekly' ? 'both' : parityIdx,
    sessionId: sess.id,
  };
  const check = canPlace(getState(), cand);
  if (!check.ok) { toast(check.reason, 'warn'); return false; }
  let displaced = 0;
  mutate((s) => {
    s.assignments.push(cand);
    if (c.status === 'paused') displaced = unpauseInPlace(s, c.id, cand.id);
  });
  // A silent downgrade near closing time would book her short without
  // anyone noticing — say so.
  if (duration !== sess.duration) {
    toast(`Placed as ${duration} min — ${sess.duration} min doesn’t fit before close`, 'warn');
  }
  if (displaced) {
    toast(`${c.name} is back — ${displaced} of her old slot${displaced === 1 ? ' was' : 's were'} `
      + 'taken meanwhile and removed', 'warn');
  }
  return true;
}

export function moveAssignment(assignmentId, day, parityIdx, start) {
  const state = getState();
  const a = state.assignments.find((x) => x.id === assignmentId);
  if (!a) return false;
  const cand = { ...a, day, start, parity: a.parity === 'both' ? 'both' : parityIdx };
  const check = canPlace(state, cand, a.id);
  if (!check.ok) { toast(check.reason, 'warn'); return false; }
  mutate((s) => {
    const target = s.assignments.find((x) => x.id === assignmentId);
    Object.assign(target, { day, start, parity: cand.parity });
  });
  return true;
}

export function removeAssignment(assignmentId) {
  mutate((s) => {
    s.assignments = s.assignments.filter((x) => x.id !== assignmentId);
  });
}

// Rotates through SESSION_DURATIONS, skipping lengths that don't fit
// or clash.
export function cycleDuration(assignmentId) {
  const state = getState();
  const a = state.assignments.find((x) => x.id === assignmentId);
  if (!a) return;
  const i = SESSION_DURATIONS.indexOf(a.duration);
  const next = i < 0
    ? [60]
    : [...SESSION_DURATIONS.slice(i + 1), ...SESSION_DURATIONS.slice(0, i)];
  for (const duration of next) {
    const cand = { ...a, duration };
    if (canPlace(state, cand, a.id).ok) {
      mutate((s) => {
        s.assignments.find((x) => x.id === assignmentId).duration = duration;
      });
      return;
    }
  }
  toast('No other length fits there', 'warn');
}

export function setAssignmentSession(assignmentId, sessionId) {
  mutate((s) => {
    const a = s.assignments.find((x) => x.id === assignmentId);
    if (a) a.sessionId = sessionId;
  });
}

export function pauseClient(clientId, details = {}) {
  const c = client(clientId);
  if (!c || c.status === 'paused') return;
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    target.status = 'paused';
    target.paused = {
      since: details.since || todayISO(),
      expectedReturn: details.expectedReturn || '',
      note: details.note || '',
    };
    target.updatedAt = new Date().toISOString();
  });
  toast(`${c.name} paused — her slots read as open while she’s away`);
}

// While a client is paused her assignments stay in the data but don't
// block the grid. Coming back, anything that now clashes — with a slot
// given to someone else, or with the slot she was just dropped on — is
// removed. keepId protects the just-placed assignment itself.
function unpauseInPlace(s, clientId, keepId = null) {
  const target = s.clients.find((x) => x.id === clientId);
  target.status = 'active';
  target.paused = null;
  target.updatedAt = new Date().toISOString();
  const mine = s.assignments.filter((a) => a.clientId === clientId && a.id !== keepId);
  // Blocked time placed over her remembered slot displaces it the same
  // way another client's session does.
  const displaced = mine.filter((a) =>
    conflictsFor(s, a, a.id).length > 0 || blockConflictsFor(s, a).length > 0);
  if (displaced.length) {
    s.assignments = s.assignments.filter((a) => !displaced.includes(a));
  }
  return displaced.length;
}

// Closing a file frees the slots but keeps the person and every note —
// she moves to the Closed files fold, one click from reopening.
export function closeClientFile(clientId) {
  const c = client(clientId);
  if (!c || c.status === 'closed') return;
  let freed = 0;
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    freed = s.assignments.filter((a) => a.clientId === clientId).length;
    s.assignments = s.assignments.filter((a) => a.clientId !== clientId);
    target.status = 'closed';
    target.paused = null;
    target.closed = { since: todayISO() };
    target.updatedAt = new Date().toISOString();
  });
  toast(`${c.name}’s file closed${freed ? ` — ${freed} slot${freed === 1 ? '' : 's'} freed` : ''} · notes kept`);
}

export function reopenClient(clientId) {
  const c = client(clientId);
  if (!c || c.status !== 'closed') return;
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    target.status = 'active';
    target.closed = null;
    target.updatedAt = new Date().toISOString();
  });
  toast(`${c.name} is back — place her when a slot opens`);
}

export function resumeClient(clientId) {
  const c = client(clientId);
  if (!c) return;
  let displaced = 0;
  mutate((s) => { displaced = unpauseInPlace(s, clientId); });
  toast(displaced
    ? `${c.name} is back — ${displaced} of her old slot${displaced === 1 ? ' was' : 's were'} taken meanwhile, re-place her`
    : `${c.name} is back on the schedule`);
}

// Changing type reshapes existing fixed slots: weekly -> biweekly keeps
// the slots in one week; biweekly -> weekly widens them (merging a
// same-time pair into one, dropping any that clash with someone else);
// becoming flexible clears fixed slots.
export function changeClientType(clientId, type) {
  const c = client(clientId);
  if (!c || c.type === type) return;
  let dropped = 0;
  let merged = 0;
  let widened = false;
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    target.type = type;
    target.updatedAt = new Date().toISOString();
    const mine = () => s.assignments.filter((a) => a.clientId === clientId);
    if (type === 'monthly' || type === 'self') {
      dropped = mine().length;
      s.assignments = s.assignments.filter((a) => a.clientId !== clientId);
    } else if (type === 'weekly') {
      for (const a of [...mine()]) {
        if (a.parity === 'both') continue;
        const cand = { ...a, parity: 'both' };
        const clashes = conflictsFor(s, cand, a.id);
        // conflictsFor only sees ACTIVE clients — while she's paused her
        // own sibling slot is invisible to it, so check that directly or
        // a paused biweekly→weekly change would create two overlapping
        // 'both' records.
        const own = s.assignments.filter((x) =>
          x.id !== a.id && x.clientId === clientId && overlaps(x, cand));
        if (clashes.some((o) => o.clientId !== clientId)) {
          s.assignments = s.assignments.filter((x) => x.id !== a.id);
          dropped += 1;
        } else if (clashes.length || own.length) {
          // Her own sibling slot in the other week — one widened record
          // is enough.
          s.assignments = s.assignments.filter((x) => x.id !== a.id);
          merged += 1;
        } else {
          a.parity = 'both';
          widened = true;
        }
      }
    } else if (type === 'biweekly') {
      for (const a of mine()) {
        if (a.parity === 'both') { a.parity = 0; widened = true; }
      }
    }
  });
  if (type === 'monthly' || type === 'self') {
    if (dropped) toast(`${c.name} is flexible now — ${dropped} fixed slot${dropped === 1 ? '' : 's'} cleared`);
  } else if (type === 'weekly' && dropped) {
    toast(`${c.name} is weekly now — ${dropped} slot${dropped === 1 ? ' was' : 's were'} taken in the other week and dropped`, 'warn');
  } else if (type === 'weekly' && merged) {
    toast(`${c.name} is weekly now — her matching slots merged into one`);
  } else if (type === 'biweekly' && widened) {
    toast(`${c.name}’s slots now sit in one week — drag across the seam to adjust`);
  }
}

// `name` may be a full name — it becomes a JNe-style code on screen and
// the full version is kept aside for Jane matching.
export function addClient({ name, type }) {
  const isFullName = deriveCode(name) !== name.trim();
  const taken = new Set(getState().clients.map((c) => c.name));
  const code = uniqueCode(name, taken);
  const c = newClient({
    name: code || name,
    type,
    jane: isFullName ? { id: null, name: name.trim() } : null,
  });
  mutate((s) => { s.clients.push(c); });
  return c.id;
}

export function addSessionType(clientId) {
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    if (target) target.sessions.push(newSessionType(''));
  });
}

export function updateSessionType(clientId, sessionId, patch, meta) {
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    const sess = target && target.sessions.find((t) => t.id === sessionId);
    if (sess) Object.assign(sess, patch);
  }, meta);
}

export function removeSessionType(clientId, sessionId) {
  const c = client(clientId);
  if (!c) return;
  if (c.sessions.length <= 1) {
    toast('Every client needs at least one session type');
    return;
  }
  let moved = 0;
  let fallbackLabel = '';
  mutate((s) => {
    const target = s.clients.find((x) => x.id === clientId);
    target.sessions = target.sessions.filter((t) => t.id !== sessionId);
    fallbackLabel = target.sessions[0].label || 'her main session';
    for (const a of s.assignments) {
      if (a.clientId === clientId && a.sessionId === sessionId) {
        a.sessionId = target.sessions[0].id;
        moved += 1;
      }
    }
  });
  if (moved) toast(`${moved} slot${moved === 1 ? '' : 's'} switched to ${fallbackLabel}`);
}

export function deleteClient(clientId) {
  mutate((s) => {
    s.clients = s.clients.filter((c) => c.id !== clientId);
    s.assignments = s.assignments.filter((a) => a.clientId !== clientId);
  });
}

export function summarizeSlots(state, clientId) {
  const list = assignmentsOf(state, clientId);
  if (!list.length) return '';
  const first = list[0];
  const short = DAYS.find((d) => d.dow === first.day)?.short || '?';
  return `${short} ${fmtTime(first.start)}${list.length > 1 ? ` +${list.length - 1}` : ''}`;
}
