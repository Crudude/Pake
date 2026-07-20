// Client drawer: identity, session types, schedule, scheduling notes,
// and the case plan — glanceable, and one Enter away for quick log notes.

import { mutate, makeFieldSaver } from "../state/store.js";
import { assignmentsOf } from "../domain/schedule.js";
import {
  DAYS,
  SESSION_DURATIONS,
  fmtTimeRange,
  parityPhrase,
  shortDate,
  todayISO,
} from "../domain/time.js";
import {
  removeAssignment,
  cycleDuration,
  pauseClient,
  resumeClient,
  closeClientFile,
  reopenClient,
  deleteClient,
  changeClientType,
  addSessionType,
  updateSessionType,
  removeSessionType,
  setAssignmentSession,
} from "../actions.js";
import { exportBackup, stashPreDestroyBackup } from "../backup.js";
import { openModal, escapeHTML } from "./dialogs.js";
import { logListHTML, wireIndexedRemove } from "./cards.js";
import { toast } from "./toast.js";

// Debounced field saves, keyed by client AND field so a quick hop
// between fields can never discard the first field's edit.
const fieldSaver = makeFieldSaver(350);

function saveField(clientId, fieldKey, apply) {
  fieldSaver(
    `${clientId}:${fieldKey}`,
    (s) => {
      const c = s.clients.find((x) => x.id === clientId);
      if (!c) return;
      apply(c);
      c.updatedAt = new Date().toISOString();
    },
    { skipDrawer: true },
  );
}

const TYPE_OPTIONS = [
  ["weekly", "Weekly"],
  ["biweekly", "Every other week"],
  ["monthly", "Monthly"],
  ["self", "Self-booking"],
];

const LOC_OPTIONS = [
  ["", "—"],
  ["in-person", "In person"],
  ["virtual", "Virtual"],
  ["mixed", "Mixed"],
];

export function renderDrawer(els, ctx) {
  const { drawer, scrim } = els;
  const state = ctx.state;
  const c = ctx.ui.drawerClientId
    ? state.clients.find((x) => x.id === ctx.ui.drawerClientId)
    : null;

  if (!c) {
    ctx.ui.drawerClientId = null;
    drawer.classList.remove("is-open");
    scrim.classList.remove("is-open");
    scrim.hidden = true;
    drawer.innerHTML = "";
    return;
  }

  const fixed = c.type === "weekly" || c.type === "biweekly";
  const slots = assignmentsOf(state, c.id);
  const multiSession = c.sessions.length > 1;

  drawer.innerHTML = `
    <div class="drawer-top">
      <input class="drawer-name" value="${escapeHTML(c.name)}" aria-label="Client display code" spellcheck="false">
      <button class="icon-btn" data-act="close" aria-label="Close">
        <svg viewBox="0 0 14 14" width="13" height="13"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>
      </button>
    </div>
    ${c.jane?.name ? `<p class="drawer-fullname">${escapeHTML(c.jane.name)}${c.jane.id ? " · linked to Jane" : ""}</p>` : ""}

    <div class="drawer-controls">
      <select class="select" data-act="type" aria-label="Client rhythm">
        ${TYPE_OPTIONS.map(([v, l]) => `<option value="${v}"${c.type === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      ${c.status === "active" ? `<button class="btn" data-act="pause">Pause</button>` : ""}
      ${c.status === "paused" ? `<button class="btn btn--primary" data-act="resume">Resume</button>` : ""}
      ${
        c.status === "closed"
          ? `<button class="btn btn--primary" data-act="reopen">Reopen file</button>`
          : `<button class="btn" data-act="close-file">Close file&hellip;</button>`
      }
      ${
        fixed && c.status === "active"
          ? `<button class="btn btn--primary" data-act="place">Place on grid</button>`
          : ""
      }
    </div>

    ${
      c.status === "paused"
        ? `
      <div class="paused-note">
        Paused${c.paused?.since ? ` since <b>${shortDate(c.paused.since)}</b>` : ""}${c.paused?.expectedReturn ? ` &middot; expected back <b>${escapeHTML(c.paused.expectedReturn)}</b>` : ""}.
        ${c.paused?.note ? `<br>${escapeHTML(c.paused.note)}` : ""}
      </div>`
        : ""
    }
    ${
      c.status === "closed"
        ? `
      <div class="paused-note">
        File closed${c.closed?.since ? ` since <b>${shortDate(c.closed.since)}</b>` : ""} &middot;
        notes are kept, reopen anytime.
      </div>`
        : ""
    }

    <section class="drawer-section">
      <h3>Session types <span class="soft">${multiSession ? "first one is the default" : ""}</span></h3>
      <div class="sess-list">
        ${c.sessions.map((t) => sessionRow(t, c)).join("")}
      </div>
      <button class="btn btn--small" data-act="add-session">+ Add session type</button>
    </section>

    <section class="drawer-section">
      <h3>Schedule</h3>
      ${
        fixed
          ? `
        <div class="slot-list">
          ${
            slots.length
              ? slots.map((a) => slotRow(a, c, state)).join("")
              : '<p class="tray-empty">No fixed slot yet — use “Place on grid”.</p>'
          }
        </div>`
          : `<p class="tray-empty">Flexible — booked ad hoc, lives in the tray.</p>`
      }
    </section>

    <section class="drawer-section">
      <h3>Scheduling notes</h3>
      <div class="field">
        <textarea data-f="schedulingNotes" rows="2"
          placeholder="Preferences, constraints, the shape of the week&hellip;">${escapeHTML(c.schedulingNotes)}</textarea>
      </div>
    </section>

    ${
      ctx.isAdmin
        ? ""
        : `
    <section class="drawer-section">
      <h3>Case plan <span class="soft">at a glance</span>
        <button class="mini-btn" data-act="formulation">Formulation &rarr;</button></h3>
      <div class="field">
        <label>Working on now</label>
        <textarea data-cp="workingOn" rows="2">${escapeHTML(c.casePlan.workingOn)}</textarea>
      </div>
      <div class="field">
        <label>Expected next session</label>
        <textarea data-cp="nextSession" rows="2">${escapeHTML(c.casePlan.nextSession)}</textarea>
      </div>
      <div class="field">
        <label>Long-term goals</label>
        <textarea data-cp="longTermGoals" rows="2">${escapeHTML(c.casePlan.longTermGoals)}</textarea>
      </div>
    </section>

    <section class="drawer-section">
      <h3>Session log</h3>
      <div class="log-add">
        <input type="text" data-act="log" placeholder="Add a note for today &mdash; Enter saves" autocomplete="off">
      </div>
      ${logListHTML(c.casePlan.log, "log-remove")}
    </section>`
    }

    <div class="drawer-footer">
      <button class="link-danger" data-act="delete">Delete ${escapeHTML(c.name)}&hellip;</button>
    </div>`;

  scrim.hidden = false;
  requestAnimationFrame(() => {
    drawer.classList.add("is-open");
    scrim.classList.add("is-open");
  });

  drawer
    .querySelector('[data-act="close"]')
    .addEventListener("click", ctx.closeDrawer);

  // Tabbing away from a field commits it immediately — the debounce
  // window only covers active typing. Deferred one macrotask so a click
  // that pulled focus out completes against the current DOM before the
  // commit re-renders it. (Guarded: `drawer` survives re-renders, the
  // listener must not stack.)
  if (!drawer.dataset.focusFlushWired) {
    drawer.dataset.focusFlushWired = "1";
    drawer.addEventListener("focusout", () =>
      setTimeout(() => fieldSaver.flush(), 0),
    );
  }

  const name = drawer.querySelector(".drawer-name");
  name.addEventListener("input", () => {
    const value = name.value;
    saveField(c.id, "name", (cl) => {
      cl.name = value.trim() || cl.name;
      // A hand-set code stops auto-following the Jane name.
      cl.autoName = false;
    });
  });

  drawer.querySelector('[data-act="type"]').addEventListener("change", (e) => {
    changeClientType(c.id, e.target.value);
  });

  const pauseBtn = drawer.querySelector('[data-act="pause"]');
  if (pauseBtn) {
    pauseBtn.addEventListener("click", async () => {
      const values = await openModal({
        title: `Pause ${c.name}`,
        bodyHTML:
          "Paused clients stay visible in the Paused tray, and their slots read as open in the meantime.",
        formHTML: `
          <div class="form-row"><label>Expected back</label>
            <input type="text" name="expectedReturn" placeholder="e.g. September, or after the baby"></div>
          <div class="form-row"><label>Note</label>
            <input type="text" name="note" placeholder="Anything worth remembering"></div>`,
        confirmText: "Pause",
      });
      if (values) pauseClient(c.id, values);
    });
  }

  const resumeBtn = drawer.querySelector('[data-act="resume"]');
  if (resumeBtn) resumeBtn.addEventListener("click", () => resumeClient(c.id));

  const closeFileBtn = drawer.querySelector('[data-act="close-file"]');
  if (closeFileBtn) {
    closeFileBtn.addEventListener("click", async () => {
      if (slots.length) {
        const ok = await openModal({
          title: `Close ${c.name}’s file?`,
          bodyHTML: `The ${slots.length} slot${slots.length === 1 ? "" : "s"} open${slots.length === 1 ? "s" : ""} up for other
            clients. Notes and history stay — the file moves to Closed files at the bottom of
            the roster, one click from reopening.`,
          confirmText: "Close file",
        });
        if (!ok) return;
      }
      closeClientFile(c.id);
    });
  }

  const reopenBtn = drawer.querySelector('[data-act="reopen"]');
  if (reopenBtn) reopenBtn.addEventListener("click", () => reopenClient(c.id));

  drawer
    .querySelector('[data-act="formulation"]')
    ?.addEventListener("click", () => {
      ctx.ui.formulationClientId = c.id;
      ctx.closeDrawer();
      location.hash = "#/formulation";
    });

  const placeBtn = drawer.querySelector('[data-act="place"]');
  if (placeBtn)
    placeBtn.addEventListener("click", () => ctx.startPlacement(c.id));

  drawer
    .querySelector('[data-act="add-session"]')
    .addEventListener("click", () => {
      addSessionType(c.id);
    });

  for (const row of drawer.querySelectorAll("[data-sess]")) {
    const sessId = row.dataset.sess;
    for (const input of row.querySelectorAll("[data-sf]")) {
      const field = input.dataset.sf;
      if (input.tagName === "SELECT") {
        input.addEventListener("change", () => {
          const value =
            field === "duration" ? Number(input.value) : input.value;
          updateSessionType(c.id, sessId, { [field]: value });
        });
      } else {
        input.addEventListener("input", () => {
          const value = input.value;
          saveField(c.id, `sess:${sessId}:${field}`, (cl) => {
            const sess = cl.sessions.find((t) => t.id === sessId);
            if (sess) sess[field] = value.trim();
          });
        });
      }
    }
    const rm = row.querySelector('[data-act="rm-session"]');
    if (rm) rm.addEventListener("click", () => removeSessionType(c.id, sessId));
  }

  drawer
    .querySelector('[data-f="schedulingNotes"]')
    .addEventListener("input", (e) => {
      const value = e.target.value;
      saveField(c.id, "schedulingNotes", (cl) => {
        cl.schedulingNotes = value;
      });
    });

  for (const area of drawer.querySelectorAll("[data-cp]")) {
    area.addEventListener("input", (e) => {
      const key = e.target.dataset.cp;
      const value = e.target.value;
      saveField(c.id, `cp:${key}`, (cl) => {
        cl.casePlan[key] = value;
      });
    });
  }

  const logInput = drawer.querySelector('[data-act="log"]');
  if (logInput)
    logInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const text = logInput.value.trim();
      if (!text) return;
      mutate((s) => {
        const cl = s.clients.find((x) => x.id === c.id);
        cl.casePlan.log.unshift({ date: todayISO(), text });
        cl.updatedAt = new Date().toISOString();
      });
    });

  wireIndexedRemove(drawer, "log-remove", (idx) => {
    mutate((s) => {
      const cl = s.clients.find((x) => x.id === c.id);
      cl.casePlan.log.splice(idx, 1);
    });
  });

  for (const row of drawer.querySelectorAll("[data-slot]")) {
    const id = row.dataset.slot;
    row
      .querySelector('[data-act="dur"]')
      .addEventListener("click", () => cycleDuration(id));
    row
      .querySelector('[data-act="rm"]')
      .addEventListener("click", () => removeAssignment(id));
    const sessSel = row.querySelector("[data-slot-sess]");
    if (sessSel) {
      sessSel.addEventListener("change", () =>
        setAssignmentSession(id, sessSel.value),
      );
    }
  }

  drawer
    .querySelector('[data-act="delete"]')
    .addEventListener("click", async () => {
      const ok = await openModal({
        title: `Delete ${c.name}?`,
        bodyHTML: `Removes the slots and every note. A backup file of everything
        is saved to Downloads first, so this is recoverable from there — but not
        inside the app.`,
        confirmText: "Delete",
        danger: true,
        requireText: c.name,
      });
      if (ok) {
        // Awaited: the on-device stash must exist before anything is
        // destroyed — the Downloads export alone can silently fail.
        await stashPreDestroyBackup();
        await exportBackup({ silent: true });
        ctx.closeDrawer();
        deleteClient(c.id);
        toast(`${c.name} deleted — a backup file was saved to Downloads first`);
      }
    });
}

function sessionRow(t, c) {
  const only = c.sessions.length <= 1;
  return `
    <div class="sess-row" data-sess="${t.id}">
      <input type="text" data-sf="label" value="${escapeHTML(t.label)}" placeholder="Individual" aria-label="Session name">
      <select class="select" data-sf="location" aria-label="Location">
        ${LOC_OPTIONS.map(([v, l]) => `<option value="${v}"${t.location === v ? " selected" : ""}>${l}</option>`).join("")}
      </select>
      ${only ? "<span></span>" : `<button class="x" data-act="rm-session" aria-label="Remove session type">&#10005;</button>`}
      <input type="text" data-sf="modality" list="modalityOptions" value="${escapeHTML(t.modality)}" placeholder="CBT, DBT, Family&hellip;" aria-label="Approach">
      <select class="select" data-sf="duration" aria-label="Length">
        ${SESSION_DURATIONS.map((d) => `<option value="${d}"${t.duration === d ? " selected" : ""}>${d} min</option>`).join("")}
      </select>
      <span></span>
    </div>`;
}

function slotRow(a, c, state) {
  const day = DAYS.find((d) => d.dow === a.day);
  const cadence =
    a.parity === "both" ? "Both weeks" : parityPhrase(a.parity, state.settings);
  const multi = c.sessions.length > 1;
  return `
    <div class="slot-row${multi ? " slot-row--tall" : ""}" data-slot="${a.id}">
      <span class="when">${day ? day.short : "?"} ${fmtTimeRange(a.start, a.duration)}</span>
      <span class="badge">${cadence}</span>
      <button class="mini-btn" data-act="dur" title="Cycle ${SESSION_DURATIONS.join(" / ")} minutes">${a.duration}&prime;</button>
      <button class="x" data-act="rm" aria-label="Remove slot">&#10005;</button>
      ${
        multi
          ? `
        <select class="select slot-sess" data-slot-sess aria-label="Session type for this slot">
          ${c.sessions.map((t) => `<option value="${t.id}"${a.sessionId === t.id ? " selected" : ""}>${escapeHTML(t.label || "Session")}</option>`).join("")}
        </select>`
          : ""
      }
    </div>`;
}
