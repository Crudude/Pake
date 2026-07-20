// Promise-based modal. Resolves with an object of named form values on
// confirm, or null on cancel/dismiss.

let root = null;

export function initDialogs(el) {
  root = el;
}

export function openModal({
  title,
  bodyHTML = "",
  formHTML = "",
  confirmText = "Confirm",
  cancelText = "Cancel",
  danger = false,
  requireText = null,
}) {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "modal-scrim";
    scrim.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" aria-label="${escapeAttr(title)}">
        <h2>${escapeHTML(title)}</h2>
        ${bodyHTML ? `<div class="modal-body">${bodyHTML}</div>` : ""}
        <form class="modal-form" novalidate>
          ${formHTML}
          ${
            requireText
              ? `
            <div class="form-row">
              <label>Type <b>${escapeHTML(requireText)}</b> to confirm</label>
              <input type="text" name="__require" autocomplete="off" spellcheck="false">
            </div>`
              : ""
          }
          <div class="modal-actions">
            <button type="button" class="btn" data-act="cancel">${escapeHTML(cancelText)}</button>
            <button type="submit" class="btn ${danger ? "btn--danger" : "btn--primary"}" data-act="ok"
              ${requireText ? "disabled" : ""}>${escapeHTML(confirmText)}</button>
          </div>
        </form>
      </div>`;

    const form = scrim.querySelector("form");
    const okBtn = scrim.querySelector('[data-act="ok"]');

    function close(result) {
      document.removeEventListener("keydown", onKey, true);
      scrim.remove();
      resolve(result);
    }

    function onKey(e) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(null);
      }
    }

    scrim.addEventListener("mousedown", (e) => {
      if (e.target === scrim) close(null);
    });
    scrim
      .querySelector('[data-act="cancel"]')
      .addEventListener("click", () => close(null));

    if (requireText) {
      const gate = form.elements.__require;
      gate.addEventListener("input", () => {
        okBtn.disabled =
          gate.value.trim().toLowerCase() !== requireText.toLowerCase();
      });
    }

    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (okBtn.disabled) return;
      const values = {};
      for (const el of form.elements) {
        if (!el.name || el.name === "__require") continue;
        values[el.name] =
          el.type === "checkbox" ? (el.checked ? "on" : "") : el.value.trim();
      }
      close(values);
    });

    document.addEventListener("keydown", onKey, true);
    root.append(scrim);
    // With no form fields, default focus goes to Cancel so a stray
    // Enter can't confirm a destructive/replacing action.
    const first = form.querySelector("input, select");
    (first || scrim.querySelector('[data-act="cancel"]')).focus();
  });
}

export function escapeHTML(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function escapeAttr(s) {
  return escapeHTML(s);
}
