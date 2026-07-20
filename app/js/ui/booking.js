// Booking page: batch and manage one real week. The template says who
// SHOULD be in; here she reviews the list, works through Jane, and
// marks each session booked or skipped. Statuses persist per week, so
// half-finished booking sessions pick up where they left off.

import { getState, mutate } from '../state/store.js';
import {
  DAYS, DAY_START, DAY_END, weekIndexOf, parityLabel, fmtTimeRange,
  dateForWeek, fmtDayDate, columnOrder,
} from '../domain/time.js';
import { sessionOf } from '../actions.js';
import { escapeHTML } from './dialogs.js';
import { copyToClipboard } from './clipboard.js';
import { toast } from './toast.js';

let weekOffset = 1; // she usually preps the coming week

const LOC_LABEL = { 'in-person': 'in person', virtual: 'virtual', mixed: 'virtual/in person' };
const STATUS_NEXT = { pending: 'booked', booked: 'skipped', skipped: 'pending' };
const STATUS_LABEL = { pending: 'to book', booked: 'booked', skipped: 'skip' };

// Structured plan for one real week — also the surface the future
// automated booking runs on (window.cadence.getWeekPlan()).
export function getWeekPlan(weekIndex = weekIndexOf() + weekOffset) {
  const state = getState();
  const parity = ((weekIndex % 2) + 2) % 2;
  const saved = state.weekPlans[weekIndex] || {};
  const active = new Map(state.clients.filter((c) => c.status === 'active').map((c) => [c.id, c]));

  const planned = state.assignments
    .filter((a) => active.has(a.clientId) && (a.parity === 'both' || a.parity === parity))
    .sort((x, y) => (x.day - y.day) || (x.start - y.start))
    .map((a) => {
      const c = active.get(a.clientId);
      const sess = sessionOf(c, a.sessionId);
      return {
        assignmentId: a.id,
        day: a.day,
        dateLabel: fmtDayDate(dateForWeek(weekIndex, a.day)),
        time: fmtTimeRange(a.start, a.duration),
        start: a.start,
        duration: a.duration,
        code: c.name,
        janeName: c.jane?.name || '',
        janeId: c.jane?.id || null,
        session: sess.label || 'Session',
        location: sess.location,
        modality: sess.modality,
        status: saved.statuses?.[a.id] || 'pending',
      };
    });

  const flexible = state.clients
    .filter((c) => c.status === 'active' && (c.type === 'monthly' || c.type === 'self'))
    .map((c) => ({
      clientId: c.id,
      code: c.name,
      janeName: c.jane?.name || '',
      type: c.type,
      notes: c.schedulingNotes,
      status: saved.flex?.[c.clientId] || saved.flex?.[c.id] || 'pending',
    }));

  return { weekIndex, parity, planned, flexible };
}

function setStatus(weekIndex, kind, id, status) {
  mutate((s) => {
    const wp = s.weekPlans[weekIndex] || (s.weekPlans[weekIndex] = {});
    const bucket = wp[kind] || (wp[kind] = {});
    if (status === 'pending') delete bucket[id];
    else bucket[id] = status;
  });
}


export function renderBooking(el, ctx) {
  const state = ctx.state;
  const wi = weekIndexOf() + weekOffset;
  const plan = getWeekPlan(wi);
  const monday = dateForWeek(wi, 1);
  const parityName = parityLabel(plan.parity, state.settings).toLowerCase();
  const whenNote = weekOffset === 0 ? 'this week'
    : weekOffset === 1 ? 'next week'
      : weekOffset > 1 ? `in ${weekOffset} weeks` : `${-weekOffset} week${weekOffset === -1 ? '' : 's'} ago`;

  const pending = plan.planned.filter((p) => p.status === 'pending');
  const booked = plan.planned.filter((p) => p.status === 'booked');

  const byDay = new Map();
  for (const p of plan.planned) {
    if (!byDay.has(p.day)) byDay.set(p.day, []);
    byDay.get(p.day).push(p);
  }

  el.innerHTML = `
    <div class="page-inner page-inner--wide">
      <div class="wk-head">
        <div class="wk-nav">
          <button class="icon-btn" data-act="prev" aria-label="Earlier week">&lsaquo;</button>
          <div class="wk-title">
            <span class="wk-week">Week of ${fmtDayDate(monday)} &middot; <em>${parityName} week</em></span>
            <span class="view-note">${whenNote}</span>
          </div>
          <button class="icon-btn" data-act="next" aria-label="Later week">&rsaquo;</button>
        </div>
        <div class="wk-actions">
          <span class="wk-counts">${plan.planned.length} planned &middot; ${booked.length} booked &middot; ${pending.length} to go</span>
          <button class="btn" data-act="copy">Copy to-book list</button>
          <button class="btn" data-act="all-booked" ${pending.length ? '' : 'disabled'}>Mark all booked</button>
        </div>
      </div>

      ${[...byDay.entries()].map(([day, items]) => `
        <h3 class="group-title">${DAYS.find((d) => d.dow === day)?.name || ''} ${items[0].dateLabel}</h3>
        <div class="stack">
          ${items.map((p) => `
            <div class="wk-row" data-aid="${p.assignmentId}">
              <span class="wk-time">${p.time}</span>
              <span class="wk-code">${escapeHTML(p.code)}</span>
              <span class="wk-detail">${escapeHTML(p.session)}${p.modality ? ` &middot; ${escapeHTML(p.modality)}` : ''}${p.location ? ` &middot; ${LOC_LABEL[p.location] || ''}` : ''} &middot; ${p.duration} min</span>
              <button class="status-chip status-chip--${p.status}" data-status="${p.status}" data-act="status" title="Click to cycle">${STATUS_LABEL[p.status]}</button>
            </div>`).join('')}
        </div>`).join('')
      || '<p class="page-empty">Nothing on the template for this week yet.</p>'}

      ${plan.flexible.length ? `
        <h3 class="group-title">Flexible — book if due</h3>
        <div class="stack">
          ${plan.flexible.map((f) => `
            <div class="wk-row" data-fid="${f.clientId}">
              <span class="wk-time">&mdash;</span>
              <span class="wk-code">${escapeHTML(f.code)}</span>
              <span class="wk-detail">${f.type === 'monthly' ? 'monthly' : 'books herself'}${f.notes ? ` &middot; ${escapeHTML(f.notes.slice(0, 70))}` : ''}</span>
              <button class="status-chip status-chip--${f.status}" data-status="${f.status}" data-act="status" title="Click to cycle">${STATUS_LABEL[f.status]}</button>
            </div>`).join('')}
        </div>` : ''}

      <details class="done-fold">
        <summary>Utilization &middot; template hours per day</summary>
        ${utilizationTable(state)}
      </details>
    </div>`;

  el.querySelector('[data-act="prev"]').addEventListener('click', () => { weekOffset -= 1; renderBooking(el, ctx); });
  el.querySelector('[data-act="next"]').addEventListener('click', () => { weekOffset += 1; renderBooking(el, ctx); });

  el.querySelector('[data-act="copy"]').addEventListener('click', () => {
    const lines = pending.map((p) =>
      `${DAYS.find((d) => d.dow === p.day)?.short} ${p.dateLabel} ${p.time} — ${p.janeName || p.code} — ${p.session}${p.modality ? ` (${p.modality})` : ''}${p.location ? `, ${LOC_LABEL[p.location]}` : ''}, ${p.duration} min`);
    if (!lines.length) { toast('Nothing left to book this week'); return; }
    copyToClipboard(
      `Bookings — week of ${fmtDayDate(monday)} (${parityName} week)\n${lines.join('\n')}`,
      'Copied — paste it wherever it helps',
    );
  });

  el.querySelector('[data-act="all-booked"]').addEventListener('click', () => {
    mutate((s) => {
      const wp = s.weekPlans[wi] || (s.weekPlans[wi] = {});
      const bucket = wp.statuses || (wp.statuses = {});
      for (const p of plan.planned) if ((bucket[p.assignmentId] || 'pending') === 'pending') bucket[p.assignmentId] = 'booked';
    });
    toast('Whole week marked booked');
  });

  for (const row of el.querySelectorAll('.wk-row')) {
    const btn = row.querySelector('[data-act="status"]');
    btn.addEventListener('click', () => {
      const isFlex = !!row.dataset.fid;
      const id = row.dataset.aid || row.dataset.fid;
      // Status rides in data-status — class names are styling, not state.
      const next = STATUS_NEXT[btn.dataset.status] || 'booked';
      setStatus(wi, isFlex ? 'flex' : 'statuses', id, next);
    });
  }
}

function utilizationTable(state) {
  const active = new Set(state.clients.filter((c) => c.status === 'active').map((c) => c.id));
  const hours = {}; // day -> [evenMin, oddMin]
  for (const d of DAYS) hours[d.dow] = [0, 0];
  for (const a of state.assignments) {
    if (!active.has(a.clientId)) continue;
    if (a.parity === 'both') { hours[a.day][0] += a.duration; hours[a.day][1] += a.duration; }
    else hours[a.day][a.parity] += a.duration;
  }
  const total = (DAY_END - DAY_START) / 60; // bookable hours per day
  const cell = (mins) => {
    const h = mins / 60;
    const pct = Math.min(100, (h / total) * 100);
    return `<td><span class="util-num">${h % 1 ? h.toFixed(1) : h}/${total}</span>
      <span class="util-bar"><span style="width:${pct}%"></span></span></td>`;
  };
  // Columns follow the same Even-left contract as the grid, so the
  // parityLabelFlipped setting can't desync this table from the board.
  const order = columnOrder(state.settings);
  return `
    <table class="util-table">
      <thead><tr><th></th><th>Even</th><th>Odd</th></tr></thead>
      <tbody>
        ${DAYS.map((d) => `<tr><th>${d.short}</th>${cell(hours[d.dow][order[0]])}${cell(hours[d.dow][order[1]])}</tr>`).join('')}
      </tbody>
    </table>`;
}
