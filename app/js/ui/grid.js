// The two-week board. In split view each day column is divided into an
// Even half and an Odd half; the whole cycle is visible at once. Days
// alternate a soft wash so each day reads as its own column; the dotted
// seam separates the two weeks inside a day, and the dotted underline
// marks which half is the real current week. In single view one parity
// gets the full width of every day.

import {
  DAYS,
  SLOTS,
  STEP,
  DAY_START,
  DAY_END,
  hourLabel,
  fmtTimeRange,
  parityLabel,
  parityNames,
  columnOrder,
  currentParity,
} from "../domain/time.js";
import { startDrag, endDrag, readDrop, drag } from "./dnd.js";
import {
  dropAllowed,
  placeClient,
  moveAssignment,
  sessionOf,
  addBlock,
  moveBlock,
} from "../actions.js";
import { escapeAttr } from "./dialogs.js";

// Which internal parity index does a label-space view name refer to?
export function parityForView(view, settings) {
  if (view === "even") return settings.parityLabelFlipped ? 1 : 0;
  if (view === "odd") return settings.parityLabelFlipped ? 0 : 1;
  return null;
}

const LOC_LABEL = {
  "in-person": "in person",
  virtual: "virtual",
  mixed: "virtual + in person",
};

export function renderGrid(el, ctx) {
  const state = ctx.state;
  const { ui } = ctx;
  const settings = state.settings;
  const order = columnOrder(settings);
  const nowParity = currentParity();
  const viewedParity = parityForView(settings.viewMode, settings);
  const single = viewedParity !== null;
  const headerRows = single ? 1 : 2;
  const rowOf = (startMin) => headerRows + 1 + (startMin - DAY_START) / STEP;
  const subCols = single ? 1 : 2;

  const grid = document.createElement("div");
  grid.className = single ? "grid grid--single" : "grid";

  DAYS.forEach((d, i) => {
    const head = document.createElement("div");
    head.className = `gd-day${i % 2 === 1 ? " gd-day--alt" : ""}`;
    head.textContent = d.short;
    head.style.gridColumn = single ? `${2 + i}` : `${2 + i * 2} / span 2`;
    head.style.gridRow = "1";
    grid.append(head);

    if (!single) {
      [0, 1].forEach((v) => {
        const parityIdx = order[v];
        const sub = document.createElement("div");
        sub.className = [
          "gd-sub",
          parityIdx === nowParity ? "is-current" : "",
          i % 2 === 1 ? "gd-sub--alt" : "",
        ]
          .filter(Boolean)
          .join(" ");
        sub.textContent = parityNames(settings)[v];
        sub.title = parityIdx === nowParity ? "This week" : "Next week";
        sub.style.gridColumn = `${2 + i * 2 + v}`;
        sub.style.gridRow = "2";
        grid.append(sub);
      });
    }
  });

  for (const s of SLOTS) {
    if (s % 60 === 0) {
      const label = document.createElement("div");
      label.className = "time-label";
      label.innerHTML = hourLabel(s);
      label.style.gridColumn = "1";
      label.style.gridRow = `${rowOf(s)} / span 2`;
      grid.append(label);
    }
  }

  const placing = ui.placementClientId
    ? state.clients.find((c) => c.id === ui.placementClientId)
    : null;
  const targeting = !!placing || ui.placingBlock;

  DAYS.forEach((d, i) => {
    for (let v = 0; v < subCols; v += 1) {
      const parityIdx = single ? viewedParity : order[v];
      for (const s of SLOTS) {
        const cell = document.createElement("div");
        cell.className = [
          "cell",
          s % 60 === 0 ? "cell--hour" : "",
          !single && v === 1 ? "cell--seam" : "cell--day-start",
          i % 2 === 1 ? "cell--alt" : "",
          targeting && !single ? "is-open-target" : "",
        ]
          .filter(Boolean)
          .join(" ");
        cell.style.gridColumn = `${2 + i * subCols + v}`;
        cell.style.gridRow = `${rowOf(s)}`;
        cell.setAttribute(
          "aria-label",
          `${d.short} ${fmtTimeRange(s, STEP)}, ${parityLabel(parityIdx, settings)} week`,
        );

        // Single-week views are for looking, not rearranging — with the
        // other week invisible, drops would bounce off unseen chips.
        if (!single) {
          cell.addEventListener("click", () => {
            if (ctx.ui.placingBlock) {
              const id = addBlock(d.dow, s);
              if (id) {
                ctx.endBlockPlacing();
                ctx.editBlock(id);
              }
              return;
            }
            if (!ctx.ui.placementClientId) return;
            if (placeClient(ctx.ui.placementClientId, d.dow, parityIdx, s)) {
              ctx.endPlacement();
            }
          });

          cell.addEventListener("dragover", (e) => {
            if (!drag.active) return;
            const ok = dropAllowed(drag.active, d.dow, parityIdx, s);
            cell.classList.toggle("is-drop-ok", ok);
            cell.classList.toggle("is-drop-bad", !ok);
            if (ok) {
              e.preventDefault();
              e.dataTransfer.dropEffect = "move";
            }
          });
          cell.addEventListener("dragleave", () => {
            cell.classList.remove("is-drop-ok", "is-drop-bad");
          });
          cell.addEventListener("drop", (e) => {
            e.preventDefault();
            cell.classList.remove("is-drop-ok", "is-drop-bad");
            const payload = readDrop(e);
            endDrag();
            if (!payload) return;
            if (payload.kind === "assignment") {
              moveAssignment(payload.id, d.dow, parityIdx, s);
            } else if (payload.kind === "client") {
              placeClient(payload.id, d.dow, parityIdx, s);
            } else if (payload.kind === "block") {
              moveBlock(payload.id, d.dow, s);
            }
          });
        }

        grid.append(cell);
      }
    }
  });

  const activeIds = new Set(
    state.clients.filter((c) => c.status === "active").map((c) => c.id),
  );
  for (const a of state.assignments) {
    if (!activeIds.has(a.clientId)) continue;
    if (single && a.parity !== "both" && a.parity !== viewedParity) continue;
    const c = state.clients.find((x) => x.id === a.clientId);
    if (!c) continue;
    const dayIdx = DAYS.findIndex((d) => d.dow === a.day);
    if (dayIdx === -1 || a.start < DAY_START || a.start + a.duration > DAY_END)
      continue;

    const sess = sessionOf(c, a.sessionId);
    const chip = document.createElement("button");
    chip.type = "button";
    const spansBoth = a.parity === "both";
    chip.className = [
      "chip",
      spansBoth ? "chip--weekly" : "chip--biweekly",
      a.duration === 30 ? "chip--half" : "",
      sess.location === "virtual" ? "chip--virtual" : "",
      sess.location === "mixed" ? "chip--mixed" : "",
    ]
      .filter(Boolean)
      .join(" ");
    if (single) {
      chip.style.gridColumn = `${2 + dayIdx}`;
    } else if (spansBoth) {
      chip.style.gridColumn = `${2 + dayIdx * 2} / span 2`;
    } else {
      const v = order.indexOf(a.parity);
      chip.style.gridColumn = `${2 + dayIdx * 2 + v}`;
    }
    chip.style.gridRow = `${rowOf(a.start)} / span ${a.duration / STEP}`;
    chip.draggable = !single;

    const when = `${DAYS[dayIdx].short} ${fmtTimeRange(a.start, a.duration)}`;
    const cadence = spansBoth
      ? "every week"
      : `${parityLabel(a.parity, settings)} weeks`;
    const extras = [
      c.sessions.length > 1 ? sess.label : "",
      LOC_LABEL[sess.location],
      sess.modality,
    ]
      .filter(Boolean)
      .join(" · ");
    chip.title = `${c.name} · ${when} · ${cadence}${extras ? ` · ${extras}` : ""}`;
    const subLabel =
      a.duration === 30
        ? "30'"
        : c.sessions.length > 1 && sess.label
          ? sess.label
          : "";
    chip.innerHTML =
      `<span class="chip-name">${escapeAttr(c.name)}</span>` +
      (subLabel ? `<span class="chip-sub">${escapeAttr(subLabel)}</span>` : "");

    chip.addEventListener("click", () => ctx.openClient(a.clientId));
    chip.addEventListener("dragstart", (e) => {
      startDrag({ kind: "assignment", id: a.id }, e.dataTransfer);
      requestAnimationFrame(() => chip.classList.add("is-dragging"));
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("is-dragging");
      endDrag();
    });

    grid.append(chip);
  }

  // Blocked time: breaks, meetings — grey hatched bands across both
  // week-halves, every week.
  for (const b of state.blocks || []) {
    const dayIdx = DAYS.findIndex((d) => d.dow === b.day);
    if (dayIdx === -1 || b.start < DAY_START || b.start + b.duration > DAY_END)
      continue;
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = `chip chip--block${b.duration === 30 ? " chip--half" : ""}`;
    chip.style.gridColumn = single
      ? `${2 + dayIdx}`
      : `${2 + dayIdx * 2} / span 2`;
    chip.style.gridRow = `${rowOf(b.start)} / span ${b.duration / STEP}`;
    chip.draggable = !single;
    chip.title = `${b.label} · ${DAYS[dayIdx].short} ${fmtTimeRange(b.start, b.duration)} · every week`;
    chip.innerHTML = `<span class="chip-name">${escapeAttr(b.label)}</span>`;
    chip.addEventListener("click", () => ctx.editBlock(b.id));
    chip.addEventListener("dragstart", (e) => {
      startDrag({ kind: "block", id: b.id }, e.dataTransfer);
      requestAnimationFrame(() => chip.classList.add("is-dragging"));
    });
    chip.addEventListener("dragend", () => {
      chip.classList.remove("is-dragging");
      endDrag();
    });
    grid.append(chip);
  }

  el.replaceChildren(grid);
}

export function renderLegend(el, settings) {
  // First two letters of the current-week column's name, mirroring the
  // dotted marker in the day sub-headers.
  const current = parityLabel(currentParity(), settings).slice(0, 2);
  el.innerHTML = `
    <span class="sample"><span class="sw sw--weekly"></span>weekly</span>
    <span class="sample"><span class="sw sw--biweekly"></span>every other week</span>
    <span class="sample"><span class="sw sw--inperson"></span>in person</span>
    <span class="sample"><span class="sw sw--virtual"></span>virtual</span>
    <span class="sample"><span class="sw-mixed">name</span>&thinsp;mixed</span>
    <span class="sample"><span class="sw-week">${escapeAttr(current)}</span>&thinsp;this week</span>`;
}
