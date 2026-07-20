// Jane-side integration. The importer reads exactly TWO things from a
// Jane Client List export: Client Number and Name. Email, phone,
// address, birth date and everything else in the file is discarded at
// the parser — the planner holds minimized data on purpose.

import { getState, mutate, normalizeData } from './state/store.js';
import { newClient } from './actions.js';
import { openModal } from './ui/dialogs.js';
import { toast } from './ui/toast.js';

const TITLE = /^(mr|mrs|ms|miss|mx|dr)\.?$/i;

// "Ms. Zonaira (Zonaira) Chaudhry" -> "Zonaira Chaudhry";
// trailing dashes and preferred-name parentheticals dropped.
export function cleanJaneName(raw) {
  const noParens = String(raw || '').replace(/\([^)]*\)/g, ' ');
  const words = noParens.trim().split(/\s+/)
    .filter((w, i) => !(i === 0 && TITLE.test(w)))
    .filter((w) => w !== '-');
  return words.join(' ').trim();
}

// Minimal CSV parser (quotes, commas, newlines inside quotes).
export function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.length > 1 || row[0] !== '') rows.push(row);
  return rows;
}

export function importJaneCSV(text) {
  const rows = parseCSV(text);
  if (!rows.length) { toast('That file looks empty', 'warn'); return Promise.resolve(); }
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idCol = header.findIndex((h) => h.includes('client number') || h === 'number' || h === 'id');
  const nameCol = header.findIndex((h) => h === 'name' || h.includes('client name'));
  if (idCol === -1 || nameCol === -1) {
    toast('Couldn’t find Client Number / Name columns in that file', 'warn');
    return Promise.resolve();
  }
  const list = rows.slice(1).map((r) => ({ id: String(r[idCol] ?? '').trim(), name: r[nameCol] ?? '' }));
  return importJaneClients(list);
}

// list: [{ id, name }] — everything else about a person stays in Jane.
export async function importJaneClients(list) {
  const seen = new Set();
  const incoming = [];
  for (const item of list) {
    const id = String(item.id ?? '').trim();
    const name = cleanJaneName(item.name);
    // The separator keeps id+name unambiguous (a bare concat would fold
    // distinct rows together); the id keeps same-name rows with blank
    // ids from collapsing only when Jane really repeats the pair.
    const key = `${id}|${name.toLowerCase()}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    incoming.push({ id, name });
  }
  if (!incoming.length) { toast('No clients found to import', 'warn'); return; }

  const state = getState();
  const byId = new Map();
  const byName = new Map();
  for (const c of state.clients) {
    if (c.jane?.id) byId.set(String(c.jane.id), c);
    if (c.jane?.name) byName.set(cleanJaneName(c.jane.name).toLowerCase(), c);
  }

  const toLink = [];
  const toCreate = [];
  for (const item of incoming) {
    // A name-only match must not steal a client already linked to a
    // DIFFERENT Jane id — two people can share a name; the id is truth.
    const byIdHit = item.id ? byId.get(item.id) : null;
    const byNameHit = byName.get(item.name.toLowerCase());
    const existing = byIdHit
      || ((!item.id || !byNameHit?.jane?.id) ? byNameHit : null);
    if (existing) toLink.push({ item, existing });
    else toCreate.push(item);
  }

  const ok = await openModal({
    title: 'Import from Jane',
    bodyHTML: `<b>${incoming.length}</b> client${incoming.length === 1 ? '' : 's'} in the export.
      Only the Jane client number and name are kept — contact details never leave Jane.
      <div class="restore-summary">
        <span><b>${toLink.length}</b> already here &rarr; linked/refreshed</span>
        <span><b>${toCreate.length}</b> new &rarr; added as <b>every-other-week</b> (adjust each later)</span>
      </div>`,
    confirmText: 'Import',
  });
  if (!ok) return;

  mutate((s) => {
    for (const { item, existing } of toLink) {
      const c = s.clients.find((x) => x.id === existing.id);
      c.jane = { id: item.id || c.jane?.id || null, name: item.name };
      // autoName display codes refresh (collision-safe) in normalizeData,
      // which runs on every load; nothing to recompute here.
    }
    for (const item of toCreate) {
      s.clients.push(newClient({
        name: item.name,
        type: 'biweekly',
        jane: { id: item.id || null, name: item.name },
      }));
    }
    normalizeData(s);
  });
  toast(`Imported — ${toCreate.length} new, ${toLink.length} linked`);
}
