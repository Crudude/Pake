// Case conceptualization — its own page. One living formulation per
// client, structured the way her Claude formulation documents are.
// This content belongs to the CLINICAL compartment: once the two-role
// encryption lands, the admin passphrase cannot decrypt any of it.

import { makeFieldSaver } from '../state/store.js';
import { anonymizeWithReport } from '../anonymize.js';
import { escapeHTML } from './dialogs.js';
import { copyToClipboard } from './clipboard.js';
import { toast } from './toast.js';

export const SECTIONS = [
  ['core', 'Core formulation'],
  ['driving', 'What’s driving it'],
  ['maintains', 'What maintains it'],
  ['modality', 'Primary modality + rationale'],
  ['inTheRoom', 'In the room'],
  ['activated', 'What gets activated in you'],
  ['underPressure', 'Under pressure'],
  ['shapesYou', 'How they shape you'],
  ['whatToDo', 'What to do with it'],
];

export function emptyFormulation() {
  const f = { profile: '', updatedAt: null };
  for (const [key] of SECTIONS) f[key] = '';
  return f;
}

const fieldSaver = makeFieldSaver(400);

function saveField(clientId, field, value) {
  fieldSaver(`form:${clientId}:${field}`, (s) => {
    const c = s.clients.find((x) => x.id === clientId);
    if (!c) return;
    if (!c.formulation) c.formulation = emptyFormulation();
    c.formulation[field] = value;
    c.formulation.updatedAt = new Date().toISOString();
  }, { skipPage: true });
}

export function formulationMarkdown(c) {
  const f = c.formulation || emptyFormulation();
  const lines = [`CLIENT: ${c.name}`, ''];
  if (f.profile) lines.push(f.profile, '');
  for (const [key, label] of SECTIONS) {
    if (!f[key]) continue;
    lines.push(`## ${label}`, '', f[key], '');
  }
  lines.push('_This is a living document. Update after significant sessions or treatment shifts._');
  return lines.join('\n');
}

export function renderFormulation(el, ctx) {
  const state = ctx.state;
  const active = state.clients
    .filter((c) => c.status !== 'closed')
    .sort((a, b) => a.name.localeCompare(b.name));
  const withDocs = active.filter((c) => c.formulation);

  let selected = ctx.ui.formulationClientId
    ? state.clients.find((c) => c.id === ctx.ui.formulationClientId)
    : null;
  if (!selected && withDocs.length) selected = withDocs[0];

  const q = (ctx.ui.formulationSearch || '').trim().toLowerCase();
  const listed = q
    ? active.filter((c) => c.name.toLowerCase().includes(q)
      || (c.jane?.name || '').toLowerCase().includes(q))
    : (withDocs.length ? withDocs : active);

  const f = selected ? (selected.formulation || emptyFormulation()) : null;

  el.innerHTML = `
    <div class="form-cols">
      <aside class="form-side">
        <input class="search" type="search" placeholder="Any client&hellip;"
          value="${escapeHTML(ctx.ui.formulationSearch || '')}" aria-label="Find a client">
        ${!q && withDocs.length ? '<p class="roster-caption">With formulations</p>' : ''}
        <div class="form-side-list">
          ${listed.map((c) => `
            <button class="roster-item${selected && c.id === selected.id ? ' is-selected' : ''}" data-pick="${c.id}">
              <span class="who">${escapeHTML(c.name)}</span>
              ${c.formulation ? '<span class="slot-hint">&#9679;</span>' : ''}
            </button>`).join('')}
        </div>
      </aside>
      <section class="form-main">
        ${selected ? `
          <div class="form-head">
            <div>
              <h2 class="form-client">${escapeHTML(selected.name)}</h2>
              ${selected.jane?.name ? `<p class="drawer-fullname">${escapeHTML(selected.jane.name)}</p>` : ''}
            </div>
            <div class="form-head-actions">
              <button class="btn" data-act="copy">Copy for Claude</button>
            </div>
          </div>
          <div class="field">
            <label>Profile line</label>
            <input type="text" class="log-input" data-form-field="profile"
              value="${escapeHTML(f.profile)}"
              placeholder="e.g. Teen, male &middot; under 6 months &middot; ERP (titrated) + foundations">
          </div>
          ${SECTIONS.map(([key, label]) => `
            <div class="field">
              <label>${label}</label>
              <textarea class="form-area" data-form-field="${key}" rows="${f[key] ? Math.min(14, Math.max(3, f[key].split('\n').length + 1)) : 3}"
                placeholder="&mdash;">${escapeHTML(f[key])}</textarea>
            </div>`).join('')}
          <p class="form-footer">A living document — update after significant sessions or treatment shifts.
            ${f.updatedAt ? `Last touched ${escapeHTML(new Date(f.updatedAt).toLocaleDateString())}.` : ''}</p>`
        : '<p class="page-empty">Pick a client to start the formulation.</p>'}
      </section>
    </div>`;

  const search = el.querySelector('.search');
  search.addEventListener('input', () => {
    // Re-rendering replaces the input — restore focus AND caret position
    // so editing mid-word doesn't jump the cursor to the end.
    const pos = search.selectionStart;
    ctx.ui.formulationSearch = search.value;
    renderFormulation(el, ctx);
    const s2 = el.querySelector('.search');
    s2.focus();
    s2.setSelectionRange(pos, pos);
  });

  for (const btn of el.querySelectorAll('[data-pick]')) {
    btn.addEventListener('click', () => {
      ctx.ui.formulationClientId = btn.dataset.pick;
      ctx.ui.formulationSearch = '';
      renderFormulation(el, ctx);
    });
  }

  if (selected) {
    for (const input of el.querySelectorAll('[data-form-field]')) {
      input.addEventListener('input', () => {
        saveField(selected.id, input.dataset.formField, input.value);
      });
    }
    // Tabbing away commits the field immediately — deferred one
    // macrotask so a click that pulled focus out completes against the
    // current DOM before the commit re-renders it. (Guarded: `el`
    // survives re-renders, the listener must not stack.)
    if (!el.dataset.focusFlushWired) {
      el.dataset.focusFlushWired = '1';
      el.addEventListener('focusout', () => setTimeout(() => fieldSaver.flush(), 0));
    }
    el.querySelector('[data-act="copy"]').addEventListener('click', () => {
      let report;
      try {
        report = anonymizeWithReport(formulationMarkdown(selected));
      } catch {
        toast('Couldn’t prepare the copy', 'warn');
        return;
      }
      // Honest about the limit: a first-name-only client has no Jane
      // name to scrub — her name goes out as typed.
      copyToClipboard(report.text, report.unscrubbed.length
        ? `Copied — Jane-known names became codes, but ${report.unscrubbed.join(', ')} ha${report.unscrubbed.length === 1 ? 's' : 've'} no Jane name and went out as-is`
        : 'Copied, anonymized — names became codes on the way out');
    });
  }
}
