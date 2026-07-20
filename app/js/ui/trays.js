// Right rail: flexible clients (monthly / book-themselves) and paused
// clients. Both kinds are expected people — they live beside the grid,
// not on it.

import { drag, readDrop, endDrag } from './dnd.js';
import { pauseClient, addClient } from '../actions.js';
import { startDrag } from './dnd.js';
import { mutate, uid } from '../state/store.js';
import { shortDate } from '../domain/time.js';
import { openModal, escapeHTML } from './dialogs.js';
import { toast } from './toast.js';

const TYPE_LABEL = { monthly: 'Monthly', self: 'Books herself' };

export function renderRail(el, ctx) {
  const state = ctx.state;
  const flexible = state.clients
    .filter((c) => c.status === 'active' && (c.type === 'monthly' || c.type === 'self'))
    .sort((a, b) => a.name.localeCompare(b.name));
  const paused = state.clients
    .filter((c) => c.status === 'paused')
    .sort((a, b) => a.name.localeCompare(b.name));

  el.innerHTML = `
    <div class="rail-group" data-group="flexible">
      <div class="rail-head">
        <span class="panel-title">Flexible</span>
        <span class="count-tag">${flexible.length || ''}</span>
      </div>
      <div class="tray-zone" data-zone="flexible"></div>
    </div>
    <div class="rail-group" data-group="paused">
      <div class="rail-head">
        <span class="panel-title">Paused</span>
        <span class="count-tag">${paused.length || ''}</span>
      </div>
      <div class="tray-zone" data-zone="paused"></div>
      <p class="rail-drop-hint">Drag anyone here to pause them. Their slots stay remembered.</p>
    </div>
    <div class="rail-group" data-group="waitlist">
      <div class="rail-head">
        <span class="panel-title">Waitlist</span>
        <button class="mini-btn" data-act="wl-add">+ add</button>
      </div>
      <div class="tray-zone" data-zone="waitlist"></div>
    </div>`;

  const flexZone = el.querySelector('[data-zone="flexible"]');
  if (!flexible.length) {
    flexZone.innerHTML = '<p class="tray-empty">No monthly or self-booking clients.</p>';
  }
  for (const c of flexible) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tray-item';
    item.draggable = true;
    item.innerHTML = `
      <span class="row">
        <span class="type-dot type-dot--${c.type}"></span>
        <span class="who">${escapeHTML(c.name)}</span>
      </span>
      <span class="meta">${TYPE_LABEL[c.type]}${c.schedulingNotes
        ? ` &middot; ${escapeHTML(c.schedulingNotes.slice(0, 64))}${c.schedulingNotes.length > 64 ? '&hellip;' : ''}`
        : ''}</span>`;
    item.addEventListener('click', () => ctx.openClient(c.id));
    item.addEventListener('dragstart', (e) => startDrag({ kind: 'client', id: c.id }, e.dataTransfer));
    item.addEventListener('dragend', endDrag);
    flexZone.append(item);
  }

  const pausedZone = el.querySelector('[data-zone="paused"]');
  if (!paused.length) {
    pausedZone.innerHTML = '<p class="tray-empty">No one is paused.</p>';
  }
  for (const c of paused) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'tray-item tray-item--paused';
    item.draggable = c.type === 'weekly' || c.type === 'biweekly';
    const meta = [
      c.paused?.since ? `Since ${shortDate(c.paused.since)}` : '',
      c.paused?.expectedReturn ? `back ${escapeHTML(c.paused.expectedReturn)}` : '',
    ].filter(Boolean).join(' &middot; ');
    item.innerHTML = `
      <span class="row">
        <span class="type-dot type-dot--${c.type}"></span>
        <span class="who">${escapeHTML(c.name)}</span>
      </span>
      ${meta ? `<span class="meta">${meta}</span>` : ''}`;
    item.addEventListener('click', () => ctx.openClient(c.id));
    if (item.draggable) {
      item.addEventListener('dragstart', (e) => startDrag({ kind: 'client', id: c.id }, e.dataTransfer));
      item.addEventListener('dragend', endDrag);
    }
    pausedZone.append(item);
  }

  const wlZone = el.querySelector('[data-zone="waitlist"]');
  if (!state.waitlist.length) {
    wlZone.innerHTML = '<p class="tray-empty">No one waiting.</p>';
  }
  for (const w of state.waitlist) {
    const item = document.createElement('div');
    item.className = 'tray-item tray-item--waitlist';
    item.innerHTML = `
      <span class="row">
        <span class="who">${escapeHTML(w.name)}</span>
        <button class="mini-btn" data-act="wl-promote" title="Make her a client">&rarr; client</button>
        <button class="x" data-act="wl-remove" aria-label="Remove from waitlist">&#10005;</button>
      </span>
      ${w.preference ? `<span class="meta">${escapeHTML(w.preference)}</span>` : ''}`;
    item.querySelector('[data-act="wl-remove"]').addEventListener('click', () => {
      mutate((s) => { s.waitlist = s.waitlist.filter((x) => x.id !== w.id); });
    });
    item.querySelector('[data-act="wl-promote"]').addEventListener('click', () => {
      const id = addClient({ name: w.name, type: 'biweekly' });
      mutate((s) => {
        const c = s.clients.find((x) => x.id === id);
        if (c && w.preference) c.schedulingNotes = w.preference;
        s.waitlist = s.waitlist.filter((x) => x.id !== w.id);
      });
      toast(`${w.name} is a client now — place her when a slot opens`);
      ctx.openClient(id);
    });
    wlZone.append(item);
  }

  el.querySelector('[data-act="wl-add"]').addEventListener('click', async () => {
    const values = await openModal({
      title: 'Add to waitlist',
      formHTML: `
        <div class="form-row"><label>Name</label>
          <input type="text" name="name" autocomplete="off" spellcheck="false"></div>
        <div class="form-row"><label>Preferred times</label>
          <input type="text" name="preference" placeholder="e.g. Thu evenings, any Saturday morning"></div>`,
      confirmText: 'Add',
    });
    if (!values || !values.name) return;
    mutate((s) => {
      s.waitlist.push({ id: uid(), name: values.name, preference: values.preference || '', addedAt: new Date().toISOString() });
    });
  });

  // Dropping a chip or a roster client on the Paused group pauses them.
  const pausedGroup = el.querySelector('[data-group="paused"]');
  pausedGroup.addEventListener('dragover', (e) => {
    if (!drag.active) return;
    const clientId = dragClientId(state, drag.active);
    const target = clientId ? state.clients.find((x) => x.id === clientId) : null;
    if (target && target.status === 'active') {
      e.preventDefault();
      pausedGroup.classList.add('is-drop-ok');
    }
  });
  pausedGroup.addEventListener('dragleave', () => pausedGroup.classList.remove('is-drop-ok'));
  pausedGroup.addEventListener('drop', (e) => {
    e.preventDefault();
    pausedGroup.classList.remove('is-drop-ok');
    const payload = readDrop(e);
    endDrag();
    const clientId = payload ? dragClientId(state, payload) : null;
    if (clientId) pauseClient(clientId);
  });
}

function dragClientId(state, payload) {
  if (payload.kind === 'client') return payload.id;
  if (payload.kind === 'assignment') {
    const a = state.assignments.find((x) => x.id === payload.id);
    return a ? a.clientId : null;
  }
  return null;
}
