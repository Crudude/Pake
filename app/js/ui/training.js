// Training: courses, certifications, workshops — each with a goal, a
// target, and a dated progress log (same rhythm as tasks).

import { getState, mutate, uid } from '../state/store.js';
import { todayISO, shortDate } from '../domain/time.js';
import { openModal, escapeHTML } from './dialogs.js';
import { openDetailsSet, logListHTML, wireIndexedRemove } from './cards.js';
import { toast } from './toast.js';

const STATUSES = [
  ['in-progress', 'In progress'],
  ['planned', 'Planned'],
  ['done', 'Completed'],
];

export function renderTraining(el, ctx) {
  const state = ctx.state;
  const wasOpen = openDetailsSet(el, 'training');
  const order = { 'in-progress': 0, planned: 1, done: 2 };
  const items = [...state.training].sort((a, b) => order[a.status] - order[b.status]);

  el.innerHTML = `
    <div class="page-inner">
      <form class="add-row" data-form="add">
        <input type="text" name="title" placeholder="A course, certification, workshop&hellip;" autocomplete="off" aria-label="Training">
        <button class="btn btn--primary" type="submit">Add</button>
      </form>

      <div class="stack">
        ${items.length ? items.map(trainingCard).join('')
          : '<p class="page-empty">No trainings tracked yet.</p>'}
      </div>
    </div>`;

  el.querySelector('[data-form="add"]').addEventListener('submit', (e) => {
    e.preventDefault();
    const title = e.target.elements.title.value.trim();
    if (!title) return;
    mutate((s) => {
      s.training.unshift({
        id: uid(), title, status: 'planned', goal: '', target: '',
        progress: [], addedAt: todayISO(),
      });
    });
  });

  for (const card of el.querySelectorAll('[data-training]')) {
    const id = card.dataset.training;
    if (wasOpen.has(id)) card.open = true;

    card.querySelector('[data-act="status"]').addEventListener('change', (e) => {
      const status = e.target.value;
      mutate((s) => { s.training.find((x) => x.id === id).status = status; });
    });

    const goal = card.querySelector('[data-act="goal"]');
    goal.addEventListener('change', () => {
      const value = goal.value;
      mutate((s) => { s.training.find((x) => x.id === id).goal = value; }, { skipPage: true });
    });

    const target = card.querySelector('[data-act="target"]');
    target.addEventListener('change', () => {
      const value = target.value.trim();
      mutate((s) => { s.training.find((x) => x.id === id).target = value; }, { skipPage: true });
    });

    const input = card.querySelector('[data-act="progress"]');
    input.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      mutate((s) => {
        s.training.find((x) => x.id === id).progress.unshift({ date: todayISO(), text });
      });
    });

    wireIndexedRemove(card, 'progress-remove', (idx) => {
      mutate((s) => {
        s.training.find((x) => x.id === id).progress.splice(idx, 1);
      });
    });

    card.querySelector('[data-act="delete"]').addEventListener('click', async () => {
      const t = getState().training.find((x) => x.id === id);
      if (t.progress.length || t.goal) {
        const ok = await openModal({
          title: 'Remove this training?',
          bodyHTML: `<b>${escapeHTML(t.title)}</b> and its progress history are removed.`,
          confirmText: 'Remove', danger: true,
        });
        if (!ok) return;
      }
      mutate((s) => { s.training = s.training.filter((x) => x.id !== id); });
      toast('Training removed');
    });
  }
}

function trainingCard(t) {
  const last = t.progress[0] || null;
  return `
    <details class="todo-card${t.status === 'done' ? ' is-done' : ''}" data-training="${t.id}">
      <summary>
        <span class="todo-title">${escapeHTML(t.title)}</span>
        ${t.target ? `<span class="assignee-chip">${escapeHTML(t.target)}</span>` : ''}
        <select class="select select--quiet" data-act="status" onclick="event.stopPropagation()" aria-label="Status">
          ${STATUSES.map(([v, l]) => `<option value="${v}"${t.status === v ? ' selected' : ''}>${l}</option>`).join('')}
        </select>
        <span class="todo-last">${last
          ? `${shortDate(last.date)} &middot; ${escapeHTML(last.text.slice(0, 48))}${last.text.length > 48 ? '&hellip;' : ''}`
          : ''}</span>
      </summary>
      <div class="todo-body">
        <div class="field">
          <label>Goal</label>
          <textarea class="notes-area" data-act="goal" rows="2"
            placeholder="What finishing this unlocks&hellip;">${escapeHTML(t.goal)}</textarea>
        </div>
        <div class="field">
          <label>Target</label>
          <input type="text" class="log-input" data-act="target" value="${escapeHTML(t.target)}"
            placeholder="e.g. by December, before the retreat" autocomplete="off">
        </div>
        <input type="text" class="log-input" data-act="progress"
          placeholder="Progress note &mdash; Enter saves" autocomplete="off">
        ${logListHTML(t.progress, 'progress-remove')}
        <button class="link-danger" data-act="delete">Remove training</button>
      </div>
    </details>`;
}
