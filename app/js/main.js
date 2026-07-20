import {
  initStore, getState, subscribe, mutate, handlers, status, session,
  normalizeData, flushPendingEdits, flushFileNow, unlockWithPassphrase,
} from './state/store.js';
import { ensurePermission } from './state/sync.js';
import { saveSnapshot } from './state/db.js';
import { sampleData } from './state/seed.js';
import {
  weekHeadingParts, columnOrder, currentParity, daysAgo, BLOCK_DURATIONS,
} from './domain/time.js';
import { openHourCounts } from './domain/schedule.js';
import { addClient, updateBlock, removeBlock } from './actions.js';
import { renderGrid, renderLegend, parityForView } from './ui/grid.js';
import { renderBooking, getWeekPlan } from './ui/booking.js';
import { renderFormulation } from './ui/formulation.js';
import { importJaneCSV, importJaneClients } from './jane.js';
import { anonymize } from './anonymize.js';
import { renderTodos } from './ui/todos.js';
import { renderReading } from './ui/reading.js';
import { renderTraining } from './ui/training.js';
import { drag } from './ui/dnd.js';
import { renderRoster } from './ui/roster.js';
import { renderRail } from './ui/trays.js';
import { renderDrawer } from './ui/drawer.js';
import { renderSettings } from './ui/settings.js';
import { initToast, toast } from './ui/toast.js';
import { initDialogs, openModal, escapeHTML } from './ui/dialogs.js';
import { exportBackup, maybeAutoBackup, restoreFromFile } from './backup.js';

const ui = {
  page: 'schedule',
  placementClientId: null,
  placingBlock: false,
  drawerClientId: null,
  formulationClientId: null,
  formulationSearch: '',
  search: '',
  settingsOpen: false,
};

// Every page except the schedule (the special default: board tools,
// roster, rail, placement) lives in this table. Adding a page = one row
// here + its <a> and <main> in index.html; route, visibility toggle,
// header and dispatch all follow from the row.
const PAGES = [
  {
    id: 'booking', el: 'pageBooking', render: renderBooking,
    header: () => ({ title: 'Weekly <em>booking</em>', sub: 'review the week · book in Jane · mark it here' }),
  },
  {
    id: 'formulation', el: 'pageFormulation', render: renderFormulation,
    // The admin role has no clinical key — the page would be empty
    // ciphertext, so it disappears entirely.
    visible: (c) => !c.isAdmin,
    header: (s) => {
      const n = s.clients.filter((c) => c.formulation).length;
      return { title: 'Case <em>conceptualization</em>', sub: n ? `${n} living document${n === 1 ? '' : 's'}` : '' };
    },
  },
  {
    id: 'tasks', el: 'pageTasks', render: renderTodos,
    header: (s) => {
      const open = s.todos.filter((t) => t.status === 'open').length;
      return { title: 'Practice <em>tasks</em>', sub: open ? `${open} open · quietest first, ready for the meeting` : 'all clear' };
    },
  },
  {
    id: 'reading', el: 'pageReading', render: renderReading,
    header: (s) => {
      const now = s.reading.filter((r) => r.status === 'reading').length;
      const queued = s.reading.filter((r) => r.status === 'to-read').length;
      return { title: 'Reading <em>list</em>', sub: `${now} in hand · ${queued} waiting` };
    },
  },
  {
    id: 'training', el: 'pageTraining', render: renderTraining,
    header: (s) => {
      const active = s.training.filter((t) => t.status === 'in-progress').length;
      return { title: 'Training <em>&amp; growth</em>', sub: active ? `${active} in progress` : '' };
    },
  },
];

function pageFromHash() {
  const found = PAGES.find((p) => location.hash === `#/${p.id}`);
  return found ? found.id : 'schedule';
}

const els = {};

const ctx = {
  get state() { return getState(); },
  get isAdmin() { return session.encrypted && session.role === 'admin'; },
  ui,
  rerender: () => renderAll(),
  openClient(id) { ui.drawerClientId = id; ui.settingsOpen = false; renderAll(); },
  closeDrawer() { ui.drawerClientId = null; renderAll(); },
  startPlacement(id) {
    ui.placementClientId = id;
    ui.drawerClientId = null;
    // Placement needs the full board — single views are look-only.
    if (getState().settings.viewMode !== 'split') {
      mutate((s) => { s.settings.viewMode = 'split'; });
      toast('Switched to Both weeks — placing needs the whole board');
    } else {
      renderAll();
    }
  },
  endPlacement() { ui.placementClientId = null; renderAll(); },
  endBlockPlacing() { ui.placingBlock = false; renderAll(); },
  async editBlock(blockId) {
    const b = getState().blocks.find((x) => x.id === blockId);
    if (!b) return;
    const values = await openModal({
      title: 'Blocked time',
      formHTML: `
        <div class="form-row"><label>Label</label>
          <input type="text" name="label" value="${escapeHTML(b.label)}" autocomplete="off"></div>
        <div class="form-row"><label>Length</label>
          <select name="duration">
            ${BLOCK_DURATIONS.map((d) => `<option value="${d}"${b.duration === d ? ' selected' : ''}>${d} min</option>`).join('')}
          </select></div>
        <div class="form-row"><label style="display:flex;gap:7px;align-items:center;cursor:pointer">
          <input type="checkbox" name="remove"> Remove this block</label></div>`,
      confirmText: 'Save',
    });
    if (!values) return;
    if (values.remove) removeBlock(blockId);
    else updateBlock(blockId, { label: values.label, duration: Number(values.duration) });
  },
  addClientFlow,
  loadSample,
};

async function addClientFlow() {
  const values = await openModal({
    title: 'Add a client',
    formHTML: `
      <div class="form-row"><label>Name &mdash; a full name shows as initials (Joshua Nevin &rarr; JNe)</label>
        <input type="text" name="name" autocomplete="off" spellcheck="false"></div>
      <div class="form-row"><label>Rhythm</label>
        <select name="type">
          <option value="weekly">Weekly</option>
          <option value="biweekly" selected>Every other week</option>
          <option value="monthly">Monthly</option>
          <option value="self">Books herself</option>
        </select></div>`,
    confirmText: 'Add',
  });
  if (!values || !values.name) return;
  const id = addClient({ name: values.name, type: values.type });
  ctx.openClient(id);
}

function loadSample() {
  mutate((s) => {
    const { clients, assignments } = sampleData();
    s.clients = clients;
    s.assignments = assignments;
    // Blocks and week plans placed before the sample would sit on top of
    // its fixed slots — the sample only makes sense on a clean board.
    s.blocks = [];
    s.weekPlans = {};
    normalizeData(s);
  });
  toast('Sample schedule loaded — replace it with real clients anytime');
}

/* ---------- board tools (view toggle) ---------- */

const VIEWS = [['split', 'Both weeks'], ['even', 'Even'], ['odd', 'Odd']];

function renderBoardTools(state) {
  const mode = state.settings.viewMode;
  const viewedParity = parityForView(mode, state.settings);
  const note = viewedParity === null
    ? ''
    : (viewedParity === currentParity() ? 'this week' : 'next week');
  els.boardTools.innerHTML = `
    <div class="seg" role="group" aria-label="Week view">
      ${VIEWS.map(([v, label]) =>
        `<button type="button" data-view="${v}"${v === mode ? ' class="is-active"' : ''}>${label}</button>`).join('')}
    </div>
    ${note ? `<span class="view-note">${note}</span>` : ''}
    <span style="flex:1"></span>
    <button type="button" class="btn" data-act="block-time">+ Block time</button>`;
  els.boardTools.querySelector('[data-act="block-time"]').addEventListener('click', () => {
    ui.placingBlock = true;
    ui.placementClientId = null;
    if (getState().settings.viewMode !== 'split') {
      mutate((s) => { s.settings.viewMode = 'split'; });
    } else {
      renderAll();
    }
  });
  for (const btn of els.boardTools.querySelectorAll('[data-view]')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.view === getState().settings.viewMode) return;
      if (btn.dataset.view !== 'split') ui.placementClientId = null;
      mutate((s) => { s.settings.viewMode = btn.dataset.view; });
    });
  }
}

/* ---------- header ---------- */

function renderHeader(state) {
  const page = PAGES.find((p) => p.id === ui.page);
  if (page) {
    const h = page.header(state);
    els.weekHeading.innerHTML = h.title;
    els.openCounts.textContent = h.sub;
  } else {
    const parts = weekHeadingParts(new Date(), state.settings);
    els.weekHeading.innerHTML =
      `Week of ${parts.weekOf} &middot; <em>${parts.parityName.toLowerCase()} week</em>`;

    const counts = openHourCounts(state);
    const order = columnOrder(state.settings);
    els.openCounts.textContent =
      `open hours — even ${counts[order[0]]} · odd ${counts[order[1]]}`;
  }

  const last = state.settings.lastBackupAt;
  const age = last ? daysAgo(last) : null;
  els.backupStatus.textContent = age === null
    ? (state.clients.length ? 'No backup yet' : '')
    : (age <= 0 ? 'Backed up today' : `Backed up ${age}d ago`);
  els.backupStatus.classList.toggle('is-stale', age === null ? !!state.clients.length : age >= 7);
}

function renderPlacementBar(state) {
  if (ui.placingBlock) {
    els.placementBar.hidden = false;
    els.placementBar.innerHTML = `
      <span>Blocking time — click a slot (breaks, meetings, lunch)</span>
      <span class="kbd">esc</span>
      <button class="btn" data-act="cancel">Cancel</button>`;
    els.placementBar.querySelector('[data-act="cancel"]').addEventListener('click', ctx.endBlockPlacing);
    return;
  }
  const c = ui.placementClientId
    ? state.clients.find((x) => x.id === ui.placementClientId)
    : null;
  if (!c) { ui.placementClientId = null; els.placementBar.hidden = true; return; }
  els.placementBar.hidden = false;
  els.placementBar.innerHTML = `
    <span>Placing <strong>${escapeHTML(c.name)}</strong> — click an open slot</span>
    <span class="kbd">esc</span>
    <button class="btn" data-act="cancel">Cancel</button>`;
  els.placementBar.querySelector('[data-act="cancel"]').addEventListener('click', ctx.endPlacement);
}

/* ---------- render root ---------- */

function renderAll(state = getState(), meta = {}) {
  if (!state) return; // locked — nothing to draw yet

  // Pages the current role can't see fall back to the schedule, and
  // their nav tabs disappear.
  const current = PAGES.find((p) => p.id === ui.page);
  if (current?.visible && !current.visible(ctx)) ui.page = 'schedule';
  for (const p of PAGES) {
    if (!p.visible) continue;
    const tab = els.navTabs.querySelector(`[data-page="${p.id}"]`);
    if (tab) tab.style.display = p.visible(ctx) ? '' : 'none';
  }

  renderHeader(state);

  els.pageSchedule.hidden = ui.page !== 'schedule';
  for (const p of PAGES) els[p.el].hidden = ui.page !== p.id;
  for (const a of els.navTabs.querySelectorAll('[data-page]')) {
    a.classList.toggle('is-active', a.dataset.page === ui.page);
  }

  if (ui.page === 'schedule') {
    renderBoardTools(state);
    renderGrid(els.board, ctx);
    renderRoster(els.roster, ctx);
    renderRail(els.rail, ctx);
  } else if (!meta.skipPage) {
    const page = PAGES.find((p) => p.id === ui.page);
    if (page) page.render(els[page.el], ctx);
  }

  if (!meta.skipDrawer) renderDrawer(els, ctx);
  renderPlacementBar(state);
  renderSettings(els.settingsPop, ctx);
}

/* ---------- boot ---------- */

async function boot() {
  for (const id of ['weekHeading', 'openCounts', 'backupStatus', 'board', 'boardTools',
    'roster', 'rail', 'drawer', 'drawerScrim', 'placementBar', 'settingsPop', 'toastRoot',
    'modalRoot', 'btnExport', 'btnRestore', 'fileRestore', 'btnSettings', 'legend',
    'navTabs', 'pageSchedule', ...PAGES.map((p) => p.el)]) {
    els[id] = document.getElementById(id);
    // A PAGES row without its <main>/<a> in index.html would otherwise
    // fail silently as a permanently blank page.
    if (!els[id]) console.error(`Cadence boot: missing #${id} in index.html`);
  }
  ui.page = pageFromHash();
  window.addEventListener('hashchange', () => {
    ui.page = pageFromHash();
    if (ui.page !== 'schedule') {
      ui.placementClientId = null;
      ui.drawerClientId = null;
      ui.settingsOpen = false;
    }
    renderAll();
  });
  els.scrim = els.drawerScrim;

  initToast(els.toastRoot);
  initDialogs(els.modalRoot);

  let persistWarned = false;
  handlers.onPersistError = () => {
    if (persistWarned) return;
    persistWarned = true;
    toast('Saving to this device failed — export a backup now', 'warn');
  };

  await initStore();

  handlers.onSyncConflict = async (fileEnv) => {
    const ok = await openModal({
      title: 'The other computer saved meanwhile',
      bodyHTML: `The shared file has newer changes from the other device.
        Reload to pick them up (recommended) — or keep working and overwrite them.`,
      confirmText: 'Reload',
      cancelText: 'Overwrite theirs',
    });
    if (ok) {
      // Park the file's copy as the newest local snapshot first — on an
      // equal-rev divergence a bare reload re-derives the same tie and
      // the same modal, forever. This makes the reloaded boot actually
      // adopt their changes (which is what the button promises).
      try { await saveSnapshot(fileEnv); } catch { /* conflict re-surfaces */ }
      location.reload();
      return;
    }
    // Jump ahead of the file's rev so the overwrite is ordered after it
    // everywhere — a lower-rev overwrite would lose the next boot's
    // newest-rev-wins pick.
    session.envelope.rev = Math.max(session.envelope.rev ?? 0, fileEnv.rev ?? 0);
    session.fileRev = fileEnv.rev;
    session.fileDevice = fileEnv.deviceId ?? null;
    mutate(() => {});
  };

  if (session.locked) { renderLockScreen(); return; }
  finishBoot();
}

function renderLockScreen() {
  const overlay = document.createElement('div');
  overlay.className = 'load-error';
  overlay.innerHTML = `
    <div class="load-error-card">
      <h2>Cadence is locked</h2>
      <p>Enter a passphrase — the therapist one opens everything,
        the admin one opens scheduling only.</p>
      <form class="lock-form">
        <input type="password" class="log-input" placeholder="Passphrase" aria-label="Passphrase">
        <button class="btn btn--primary" type="submit">Unlock</button>
      </form>
      <p class="lock-err" hidden>That passphrase doesn&rsquo;t open this file.</p>
      ${session.handle && !session.filePermission
        ? '<button class="btn" data-act="reconnect">Reconnect shared file</button>' : ''}
    </div>`;
  const form = overlay.querySelector('form');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const ok = await unlockWithPassphrase(form.querySelector('input').value);
    if (ok) {
      overlay.remove();
      finishBoot();
    } else {
      overlay.querySelector('.lock-err').hidden = false;
    }
  });
  const reconnect = overlay.querySelector('[data-act="reconnect"]');
  if (reconnect) {
    reconnect.addEventListener('click', async () => {
      if (await ensurePermission(session.handle, true)) location.reload();
    });
  }
  document.body.append(overlay);
  overlay.querySelector('input').focus();
}

function finishBoot() {
  els.btnExport.addEventListener('click', () => exportBackup());
  els.btnRestore.addEventListener('click', () => els.fileRestore.click());
  els.fileRestore.addEventListener('change', async () => {
    const file = els.fileRestore.files[0];
    els.fileRestore.value = '';
    if (file) await restoreFromFile(file);
  });
  els.btnSettings.addEventListener('click', (e) => {
    e.stopPropagation();
    ui.settingsOpen = !ui.settingsOpen;
    renderAll();
  });
  document.addEventListener('mousedown', (e) => {
    if (ui.settingsOpen && !els.settingsPop.contains(e.target)
      && !els.btnSettings.contains(e.target)) {
      ui.settingsOpen = false;
      renderAll();
    }
  });

  // Without these, dropping a file anywhere outside a handled cell
  // navigates the webview away from the app. A dropped backup .json is
  // routed into the restore flow instead.
  document.addEventListener('dragover', (e) => {
    if (!drag.active) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (drag.active) return;
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.toLowerCase().endsWith('.json')) restoreFromFile(file);
  });

  // Flush half-typed edits and the debounced file write if the app is
  // being hidden or quit. WKWebView doesn't reliably fire
  // visibilitychange on Cmd+Q, so pagehide and blur cover the gap.
  const flushForQuit = () => {
    flushPendingEdits();
    flushFileNow();
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushForQuit();
  });
  window.addEventListener('pagehide', flushForQuit);
  window.addEventListener('blur', flushForQuit);
  els.drawerScrim.addEventListener('click', ctx.closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (ui.settingsOpen) { ui.settingsOpen = false; renderAll(); return; }
    if (ui.placingBlock) { ctx.endBlockPlacing(); return; }
    if (ui.placementClientId) { ctx.endPlacement(); return; }
    if (ui.drawerClientId) ctx.closeDrawer();
  });

  // Small automation surface: lets a trusted driver (e.g. Claude in the
  // browser) run the Jane import or read the week plan for batch booking.
  window.cadence = { importJaneCSV, importJaneClients, getWeekPlan, anonymize };

  renderLegend(els.legend);
  subscribe((state, meta) => renderAll(state, meta));
  renderAll();

  // A divergence initStore found before the conflict handler existed
  // (finishBoot runs for both the unlocked and the just-unlocked path).
  if (session.pendingConflict) {
    const conflict = session.pendingConflict;
    session.pendingConflict = null;
    handlers.onSyncConflict(conflict);
  }

  if (status.loadError) {
    const overlay = document.createElement('div');
    overlay.className = 'load-error';
    overlay.innerHTML = `
      <div class="load-error-card">
        <h2>Couldn&rsquo;t read the saved data</h2>
        <p>The data is most likely still on this computer — this looks like a
          read hiccup, not data loss. <b>Don&rsquo;t re-enter anything.</b>
          Saving is switched off until a restart reads it back cleanly.</p>
        <button class="btn btn--primary" data-act="reload">Try again</button>
      </div>`;
    overlay.querySelector('[data-act="reload"]').addEventListener('click', () => location.reload());
    document.body.append(overlay);
    return;
  }
  maybeAutoBackup();
}

boot();
