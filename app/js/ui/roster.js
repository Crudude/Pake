// Left panel: every client, searchable, draggable onto the grid.

import { startDrag, endDrag } from "./dnd.js";
import { summarizeSlots } from "../actions.js";
import { escapeHTML } from "./dialogs.js";

let refocusSearch = false;
let caretPos = null;

const TYPE_LABEL = {
  weekly: "Weekly",
  biweekly: "Every other week",
  monthly: "Monthly",
  self: "Self-booking",
};

export function renderRoster(el, ctx) {
  const state = ctx.state;
  const { ui } = ctx;

  if (!state.clients.length) {
    el.innerHTML = `
      <div class="roster-head"><span class="panel-title">Clients</span></div>
      <div class="empty-state">
        <p class="display">A calm week starts here.</p>
        <p>Add your clients, then drag them onto the two-week board.</p>
        <button class="btn btn--primary" data-act="add">Add client</button>
        <button class="btn" data-act="sample">Load sample data</button>
      </div>`;
    el.querySelector('[data-act="add"]').addEventListener(
      "click",
      ctx.addClientFlow,
    );
    el.querySelector('[data-act="sample"]').addEventListener(
      "click",
      ctx.loadSample,
    );
    return;
  }

  // The roster is ACTIVE clients only — paused people live in the right
  // tray, closed files in the fold below. Search still finds everyone.
  const q = (ui.search || "").trim().toLowerCase();
  const sorted = [...state.clients].sort((a, b) =>
    a.name.localeCompare(b.name),
  );
  const matches = (c) =>
    c.name.toLowerCase().includes(q) ||
    (c.jane?.name || "").toLowerCase().includes(q);
  const active = sorted.filter((c) => c.status === "active");
  const closed = sorted.filter((c) => c.status === "closed");
  const shown = q ? active.filter(matches) : active;
  const foundPaused = q
    ? sorted.filter((c) => c.status === "paused").filter(matches)
    : [];
  const foundClosed = q ? closed.filter(matches) : [];

  el.innerHTML = `
    <div class="roster-head">
      <span class="panel-title">Clients</span>
      <span class="count-tag">${active.length}</span>
    </div>
    <input class="search" type="search" placeholder="Find a client&hellip;" value="${escapeHTML(ui.search || "")}" aria-label="Find a client">
    <div class="roster-list"></div>
    <button class="btn roster-add" data-act="add">+ Add client</button>
    ${
      !q && closed.length
        ? `
      <details class="done-fold">
        <summary>Closed files &middot; ${closed.length}</summary>
        <div class="roster-list" data-list="closed"></div>
      </details>`
        : ""
    }`;

  const search = el.querySelector(".search");
  search.addEventListener("input", () => {
    ui.search = search.value;
    refocusSearch = true;
    caretPos = search.selectionStart;
    renderRoster(el, ctx);
  });
  if (refocusSearch) {
    refocusSearch = false;
    search.focus();
    const pos = caretPos ?? search.value.length;
    search.setSelectionRange(pos, pos);
  }

  const list = el.querySelector(".roster-list");

  const makeItem = (c, hintOverride = null) => {
    const item = document.createElement("div");
    item.className = `roster-item${ui.placementClientId === c.id ? " is-selected" : ""}`;
    item.setAttribute("role", "button");
    item.tabIndex = 0;
    const fixed = c.type === "weekly" || c.type === "biweekly";
    // Everyone drags: fixed clients onto the grid, anyone into the
    // Paused tray. Invalid targets refuse the drop with an explanation.
    item.draggable = c.status !== "closed";

    const hint =
      hintOverride ??
      (c.status === "paused"
        ? "paused"
        : c.status === "closed"
          ? "closed"
          : fixed
            ? summarizeSlots(state, c.id)
            : "tray");

    item.innerHTML = `
      <span class="type-dot type-dot--${c.type}" title="${TYPE_LABEL[c.type]}"></span>
      <span class="who">${escapeHTML(c.name)}</span>
      <span class="slot-hint">${escapeHTML(hint)}</span>`;

    item.addEventListener("click", () => ctx.openClient(c.id));
    item.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        ctx.openClient(c.id);
      }
    });
    if (item.draggable) {
      item.addEventListener("dragstart", (e) =>
        startDrag({ kind: "client", id: c.id }, e.dataTransfer),
      );
      item.addEventListener("dragend", endDrag);
    }
    return item;
  };

  for (const c of shown) list.append(makeItem(c));

  const caption = (text) => {
    const p = document.createElement("p");
    p.className = "roster-caption";
    p.textContent = text;
    return p;
  };
  if (foundPaused.length) {
    list.append(caption("Paused"));
    for (const c of foundPaused) list.append(makeItem(c));
  }
  if (foundClosed.length) {
    list.append(caption("Closed files"));
    for (const c of foundClosed) list.append(makeItem(c));
  }

  if (q && !shown.length && !foundPaused.length && !foundClosed.length) {
    list.innerHTML = '<p class="tray-empty">No one matches that search.</p>';
  }

  const closedList = el.querySelector('[data-list="closed"]');
  if (closedList) {
    for (const c of closed) {
      closedList.append(
        makeItem(
          c,
          c.closed?.since ? `since ${c.closed.since.slice(5)}` : "closed",
        ),
      );
    }
  }

  el.querySelector('[data-act="add"]').addEventListener(
    "click",
    ctx.addClientFlow,
  );
}
