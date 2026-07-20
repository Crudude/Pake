// Placement rules for the two-week template grid.
//
// assignment: { id, clientId, day (2..6), start (min from midnight),
//               duration (60|30), parity (0 | 1 | 'both') }

import { DAYS, DAY_START, DAY_END } from './time.js';

export function parityIntersects(a, b) {
  return a === 'both' || b === 'both' || a === b;
}

export function overlaps(a, b) {
  return a.day === b.day
    && parityIntersects(a.parity, b.parity)
    && a.start < b.start + b.duration
    && b.start < a.start + a.duration;
}

export function activeClientIds(state) {
  return new Set(state.clients.filter((c) => c.status === 'active').map((c) => c.id));
}

// Paused clients keep their assignments in data, but those don't block
// the grid — the slot reads as open while they're away.
export function conflictsFor(state, candidate, ignoreId = null) {
  const active = activeClientIds(state);
  return state.assignments.filter((a) =>
    a.id !== ignoreId && active.has(a.clientId) && overlaps(a, candidate));
}

// Blocked time (breaks, meetings) applies to every week and stops
// client placement the same way another session would.
export function blockConflictsFor(state, candidate, ignoreId = null) {
  return (state.blocks || []).filter((b) =>
    b.id !== ignoreId && overlaps({ ...b, parity: 'both' }, candidate));
}

export function fitsDay(candidate) {
  return candidate.start + candidate.duration <= DAY_END;
}

export function canPlace(state, candidate, ignoreId = null) {
  if (!fitsDay(candidate)) return { ok: false, reason: 'Past closing time' };
  const clash = conflictsFor(state, candidate, ignoreId);
  if (clash.length) {
    const who = state.clients.find((c) => c.id === clash[0].clientId);
    return { ok: false, reason: `That slot is ${who ? who.name + "'s" : 'taken'}` };
  }
  const blocked = blockConflictsFor(state, candidate);
  if (blocked.length) {
    return { ok: false, reason: `That time is blocked — ${blocked[0].label}` };
  }
  return { ok: true };
}

// Whole bookable hours per parity index, counted from the merged free
// gaps — the grid books 60-minute sessions at :30 starts too, so
// testing only on-the-hour candidates would undercount.
export function openHourCounts(state) {
  const counts = [0, 0];
  const active = activeClientIds(state);
  for (const parity of [0, 1]) {
    for (const d of DAYS) {
      const busy = [];
      for (const a of state.assignments) {
        if (active.has(a.clientId) && a.day === d.dow && parityIntersects(a.parity, parity)) {
          busy.push([Math.max(a.start, DAY_START), Math.min(a.start + a.duration, DAY_END)]);
        }
      }
      for (const b of state.blocks || []) {
        if (b.day === d.dow) {
          busy.push([Math.max(b.start, DAY_START), Math.min(b.start + b.duration, DAY_END)]);
        }
      }
      busy.sort((x, y) => x[0] - y[0]);
      let cursor = DAY_START;
      for (const [s, e] of busy) {
        if (s > cursor) counts[parity] += Math.floor((s - cursor) / 60);
        cursor = Math.max(cursor, e);
      }
      if (DAY_END > cursor) counts[parity] += Math.floor((DAY_END - cursor) / 60);
    }
  }
  return counts;
}

export function assignmentsOf(state, clientId) {
  return state.assignments
    .filter((a) => a.clientId === clientId)
    .sort((a, b) => (a.day - b.day) || (a.start - b.start));
}
