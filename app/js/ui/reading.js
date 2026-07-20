// Reading list: what she's in, what's queued, what's finished.

import { getState, mutate, uid } from '../state/store.js';
import { todayISO, shortDate } from '../domain/time.js';
import { openModal, escapeHTML } from './dialogs.js';
import { openDetailsSet } from './cards.js';
import { toast } from './toast.js';

const GROUPS = [
  ['reading', 'Reading now'],
  ['to-read', 'To read'],
  ['done', 'Finished'],
];

export function renderReading(el, ctx) {
  const state = ctx.state;
  const wasOpen = openDetailsSet(el, 'reading');

  el.innerHTML = `
    <div class="page-inner">
      <form class="add-row" data-form="add">
        <input type="text" name="title" placeholder="Title&hellip;" autocomplete="off" aria-label="Title">
        <input type="text" name="author" placeholder="Author" autocomplete="off" aria-label="Author" class="add-row-narrow">
        <button class="btn btn--primary" type="submit">Add</button>
      </form>

      ${GROUPS.map(([key, label]) => {
        const items = state.reading.filter((r) => r.status === key);
        if (!items.length) return '';
        return `
          <h3 class="group-title">${label} <span class="count-tag">${items.length}</span></h3>
          <div class="stack">${items.map(readingCard).join('')}</div>`;
      }).join('') || '<p class="page-empty">Nothing here yet — add the book on the nightstand.</p>'}
    </div>`;

  el.querySelector('[data-form="add"]').addEventListener('submit', (e) => {
    e.preventDefault();
    const form = e.target;
    const title = form.elements.title.value.trim();
    if (!title) return;
    mutate((s) => {
      s.reading.unshift({
        id: uid(), title,
        author: form.elements.author.value.trim(),
        status: 'to-read', notes: '',
        addedAt: todayISO(), finishedAt: null,
      });
    });
  });

  for (const card of el.querySelectorAll('[data-reading]')) {
    const id = card.dataset.reading;
    if (wasOpen.has(id)) card.open = true;

    card.querySelector('[data-act="status"]').addEventListener('change', (e) => {
      const status = e.target.value;
      mutate((s) => {
        const r = s.reading.find((x) => x.id === id);
        r.status = status;
        r.finishedAt = status === 'done' ? todayISO() : null;
      });
    });

    const notes = card.querySelector('[data-act="notes"]');
    notes.addEventListener('change', () => {
      const value = notes.value;
      mutate((s) => {
        s.reading.find((x) => x.id === id).notes = value;
      }, { skipPage: true });
    });

    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const r = getState().reading.find((x) => x.id === id);
      // Same guard as tasks/training: content-bearing cards confirm.
      if (r?.notes.trim()) {
        const ok = await openModal({
          title: 'Remove this book?',
          bodyHTML: `<b>${escapeHTML(r.title)}</b> and its notes are removed.`,
          confirmText: 'Remove', danger: true,
        });
        if (!ok) return;
      }
      mutate((s) => { s.reading = s.reading.filter((x) => x.id !== id); });
      toast('Removed from the list');
    });
  }
}

function readingCard(r) {
  return `
    <details class="todo-card${r.status === 'done' ? ' is-done' : ''}" data-reading="${r.id}">
      <summary>
        <span class="todo-title">${escapeHTML(r.title)}</span>
        ${r.author ? `<span class="todo-author">${escapeHTML(r.author)}</span>` : ''}
        <select class="select select--quiet" data-act="status" onclick="event.stopPropagation()" aria-label="Status">
          ${GROUPS.map(([v, l]) => `<option value="${v}"${r.status === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        ${r.status === 'done' && r.finishedAt ? `<span class="todo-last">${shortDate(r.finishedAt)}</span>` : ''}
      </summary>
      <div class="todo-body">
        <textarea class="notes-area" data-act="notes" rows="2"
          placeholder="Worth keeping: ideas, quotes, who to recommend it to&hellip;">${escapeHTML(r.notes)}</textarea>
        <button class="link-danger" data-act="delete">Remove from list</button>
      </div>
    </details>`;
}
