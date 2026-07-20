// Practice tasks. Each task carries an assignee and a dated update log —
// the meeting mechanism: open tasks sort stalest-first, the last update
// sits right on the card, and adding this meeting's note is one Enter.

import { getState, mutate, uid } from "../state/store.js";
import { todayISO, shortDate, daysAgo } from "../domain/time.js";
import { openModal, escapeHTML } from "./dialogs.js";
import { openDetailsSet, logListHTML, wireIndexedRemove } from "./cards.js";
import { toast } from "./toast.js";

function knownPeople(state) {
  const set = new Set();
  for (const t of state.todos) if (t.assignee) set.add(t.assignee);
  return [...set].sort();
}

function lastUpdate(t) {
  return t.updates.length ? t.updates[0] : null;
}

export function renderTodos(el, ctx) {
  const state = ctx.state;
  const wasOpen = openDetailsSet(el, "todo");
  const open = state.todos.filter((t) => t.status === "open");
  const done = state.todos.filter((t) => t.status === "done");

  // Stalest-touched first: tasks nobody has reported on rise to the top
  // of the meeting.
  open.sort((a, b) => {
    const la = lastUpdate(a)?.date || "0";
    const lb = lastUpdate(b)?.date || "0";
    return la < lb ? -1 : la > lb ? 1 : 0;
  });

  const people = knownPeople(state);

  el.innerHTML = `
    <div class="page-inner">
      <form class="add-row" data-form="add">
        <input type="text" name="title" placeholder="A new task&hellip;" autocomplete="off" aria-label="Task">
        <input type="text" name="assignee" list="peopleOptions" placeholder="Who" autocomplete="off" aria-label="Assignee" class="add-row-narrow">
        <button class="btn btn--primary" type="submit">Add</button>
      </form>
      <datalist id="peopleOptions">
        ${people.map((p) => `<option value="${escapeHTML(p)}"></option>`).join("")}
      </datalist>

      <div class="stack" data-list="open">
        ${
          open.length
            ? open.map(todoCard).join("")
            : '<p class="page-empty">Nothing on the list. Enjoy it while it lasts.</p>'
        }
      </div>

      ${
        done.length
          ? `
        <details class="done-fold">
          <summary>Done &middot; ${done.length}</summary>
          <div class="stack">
            ${done.map(todoCard).join("")}
          </div>
        </details>`
          : ""
      }
    </div>`;

  el.querySelector('[data-form="add"]').addEventListener("submit", (e) => {
    e.preventDefault();
    const form = e.target;
    const title = form.elements.title.value.trim();
    if (!title) return;
    const assignee = form.elements.assignee.value.trim();
    mutate((s) => {
      s.todos.unshift({
        id: uid(),
        title,
        assignee,
        status: "open",
        createdAt: todayISO(),
        doneAt: null,
        updates: [],
      });
    });
  });

  for (const card of el.querySelectorAll("[data-todo]")) {
    const id = card.dataset.todo;
    if (wasOpen.has(id)) card.open = true;

    card
      .querySelector('[data-act="toggle"]')
      .addEventListener("change", (e) => {
        const isDone = e.target.checked;
        mutate((s) => {
          const t = s.todos.find((x) => x.id === id);
          t.status = isDone ? "done" : "open";
          t.doneAt = isDone ? todayISO() : null;
        });
      });

    const input = card.querySelector('[data-act="update"]');
    if (input) {
      input.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        mutate((s) => {
          s.todos
            .find((x) => x.id === id)
            .updates.unshift({ date: todayISO(), text });
        });
      });
    }

    wireIndexedRemove(card, "update-remove", (idx) => {
      mutate((s) => {
        s.todos.find((x) => x.id === id).updates.splice(idx, 1);
      });
    });

    card
      .querySelector('[data-act="delete"]')
      .addEventListener("click", async () => {
        const t = getState().todos.find((x) => x.id === id);
        if (t.updates.length) {
          const ok = await openModal({
            title: "Delete this task?",
            bodyHTML: `<b>${escapeHTML(t.title)}</b> and its ${t.updates.length} progress note${t.updates.length === 1 ? "" : "s"} are removed.`,
            confirmText: "Delete",
            danger: true,
          });
          if (!ok) return;
        }
        mutate((s) => {
          s.todos = s.todos.filter((x) => x.id !== id);
        });
        toast("Task deleted");
      });
  }
}

function todoCard(t) {
  const last = lastUpdate(t);
  const stale = last ? daysAgo(`${last.date}T12:00:00`) : null;
  const isDone = t.status === "done";
  return `
    <details class="todo-card${isDone ? " is-done" : ""}" data-todo="${t.id}">
      <summary>
        <label class="tick" onclick="event.stopPropagation()">
          <input type="checkbox" data-act="toggle" ${isDone ? "checked" : ""} aria-label="Done">
          <span class="tick-box"></span>
        </label>
        <span class="todo-title">${escapeHTML(t.title)}</span>
        ${t.assignee ? `<span class="assignee-chip">${escapeHTML(t.assignee)}</span>` : ""}
        <span class="todo-last">${
          isDone
            ? `done ${t.doneAt ? shortDate(t.doneAt) : ""}`
            : last
              ? `${shortDate(last.date)} &middot; ${escapeHTML(last.text.slice(0, 56))}${last.text.length > 56 ? "&hellip;" : ""}`
              : "no progress notes yet"
        }</span>
        ${!isDone && stale !== null && stale >= 14 ? `<span class="stale-chip">${stale}d quiet</span>` : ""}
      </summary>
      <div class="todo-body">
        ${
          !isDone
            ? `
          <input type="text" class="log-input" data-act="update"
            placeholder="Progress for the meeting &mdash; Enter saves" autocomplete="off">`
            : ""
        }
        ${logListHTML(t.updates, "update-remove")}
        <button class="link-danger" data-act="delete">Delete task</button>
      </div>
    </details>`;
}
