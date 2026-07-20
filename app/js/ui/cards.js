// Shared pieces for the card-list pages (tasks, reading, training) and
// the drawer's session log. These three pages are deliberate siblings —
// keeping the mechanics here stops them drifting apart (again).

import { shortDate } from "../domain/time.js";
import { escapeHTML } from "./dialogs.js";

function camel(attr) {
  return attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
}

// Which <details data-ATTR> cards are open right now — captured before a
// re-render wipes them, applied after so expansion state survives.
export function openDetailsSet(el, attr) {
  return new Set(
    [...el.querySelectorAll(`details[data-${attr}][open]`)].map(
      (d) => d.dataset[camel(attr)],
    ),
  );
}

// The dated-note list every card body shows (task updates, training
// progress, session log).
export function logListHTML(items, removeAttr) {
  return `
    <div class="log-list">
      ${items
        .map(
          (u, idx) => `
        <div class="log-item">
          <span class="when">${shortDate(u.date)}</span>
          <span class="what">${escapeHTML(u.text)}</span>
          <button class="x" data-${removeAttr}="${idx}" aria-label="Remove note">&#10005;</button>
        </div>`,
        )
        .join("")}
    </div>`;
}

export function wireIndexedRemove(card, removeAttr, onRemove) {
  for (const rm of card.querySelectorAll(`[data-${removeAttr}]`)) {
    rm.addEventListener("click", () =>
      onRemove(Number(rm.dataset[camel(removeAttr)])),
    );
  }
}
