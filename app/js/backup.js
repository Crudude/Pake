// Export / restore. The export is a plain <a download> blob click —
// in the Pake wrapper this is caught by the native download handler and
// saved straight to the OS Downloads folder on both Windows and macOS.
//
// A fired click is NOT a completed download (macOS can silently deny
// Downloads access), so destructive flows also stash the envelope in
// this device's IndexedDB first — recoverable from Settings even when
// every Downloads export silently failed.

import {
  getState,
  replaceData,
  mutate,
  validEnvelope,
  normalizeData,
  hasAnyData,
  flushPendingEdits,
  currentEnvelope,
  session,
  adoptEnvelope,
  adoptWithPassphrase,
} from "./state/store.js";
import { kvGet, kvSet } from "./state/sync.js";
import { openModal, escapeHTML } from "./ui/dialogs.js";
import { toast } from "./ui/toast.js";
import { todayISO, daysAgo } from "./domain/time.js";

function downloadJSON(filename, envelope) {
  const blob = new Blob([JSON.stringify(envelope, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  // Keep the blob alive until the (possibly native) download has started.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

export async function exportBackup({ silent = false } = {}) {
  flushPendingEdits();
  // Seals the post-flush state (with encryption on, backups are the
  // sealed envelope — never plaintext).
  const envelope = await currentEnvelope();
  const filename = `cadence-backup-${todayISO()}.json`;
  downloadJSON(filename, envelope);
  mutate(
    (s) => {
      s.settings.lastBackupAt = new Date().toISOString();
    },
    { source: "backup" },
  );
  // Naming the file makes a silently-missing download discoverable.
  if (!silent) toast(`Backup saved — ${filename} in Downloads`);
}

// Manual sync for machines that can't link the shared file: download a
// copy named exactly like the shared save, so replacing the one in the
// OneDrive folder is a single drag in Finder.
export async function exportSharedSaveCopy() {
  flushPendingEdits();
  const envelope = await currentEnvelope();
  downloadJSON("cadence-shared-save.json", envelope);
  toast(
    "cadence-shared-save.json is in Downloads — move it into the shared OneDrive folder, replacing the old one",
  );
}

// Before anything destructive: park the full envelope on this device,
// awaited, so the data survives even if the Downloads export never lands.
// Settings → "Recover pre-delete backup" reads it back.
export async function stashPreDestroyBackup() {
  const envelope = await currentEnvelope();
  await kvSet("preDestroyBackup", {
    savedAt: new Date().toISOString(),
    envelope,
  });
}

export async function getPreDestroyBackup() {
  return kvGet("preDestroyBackup");
}

export function maybeAutoBackup() {
  const s = getState();
  if (!s.clients.length) return;
  const last = s.settings.lastBackupAt;
  const age = last ? daysAgo(last) : null;
  if (age === null || age >= 7) {
    // exportBackup is async — only claim success once it resolves.
    exportBackup({ silent: true }).then(
      () => toast("Weekly backup saved to your Downloads folder"),
      () => toast("Weekly backup failed — export one manually", "warn"),
    );
  }
}

export async function restoreFromFile(file) {
  let envelope = null;
  try {
    envelope = JSON.parse(await file.text());
  } catch {
    envelope = null;
  }
  if (envelope?.format === "cadence-encrypted") {
    // Same shape gate the store applies — a hand-corrupted "encrypted"
    // file must fall through to the not-a-backup toast, not throw.
    if (envelope.practice && envelope.roles) {
      await restoreEncrypted(envelope);
      return;
    }
    toast("That file isn’t a Cadence backup", "warn");
    return;
  }
  if (!validEnvelope(envelope)) {
    toast("That file isn’t a Cadence backup", "warn");
    return;
  }
  // While locked there is no state to replace safely — plain restores
  // need an unlocked session (encrypted saves handle lock themselves).
  if (session.locked) {
    toast("Unlock first — then restore the backup", "warn");
    return;
  }
  // A plain backup carries clinical fields; an admin-role seal would
  // strip them and expose them meanwhile. Therapist-only action.
  if (session.encrypted && session.role !== "therapist") {
    toast("Restoring a plain backup needs the therapist passphrase", "warn");
    return;
  }
  const d = envelope.data;
  const saved = envelope.savedAt ? new Date(envelope.savedAt) : null;
  const hasCurrentData = hasAnyData(getState());
  const ok = await openModal({
    title: "Restore this backup?",
    bodyHTML: `It replaces what’s in the app right now${
      hasCurrentData
        ? " — the current data is first saved to your Downloads folder as its own backup file"
        : ""
    }.
      <div class="restore-summary">
        <span><b>${d.clients.length}</b> client${d.clients.length === 1 ? "" : "s"} &middot;
          <b>${d.assignments.length}</b> scheduled slot${d.assignments.length === 1 ? "" : "s"}</span>
        <span>Saved ${
          saved && !Number.isNaN(saved.getTime())
            ? escapeHTML(saved.toLocaleString())
            : "unknown"
        }</span>
      </div>`,
    confirmText: "Restore",
  });
  if (!ok) return;
  if (hasCurrentData) {
    await stashPreDestroyBackup();
    await exportBackup({ silent: true });
  }
  replaceData(normalizeData(structuredClone(d)));
  toast("Backup restored");
}

// An encrypted shared save opened by hand — the manual round-trip for
// machines without file linking, and the recovery path everywhere else.
async function restoreEncrypted(envelope) {
  const hasCurrentData = hasAnyData(getState());
  let parked = false;
  const park = async () => {
    if (hasCurrentData && !parked) {
      parked = true;
      await stashPreDestroyBackup();
      await exportBackup({ silent: true });
    }
  };

  // Same lineage as this device's keys? Opens without a passphrase.
  if (session.encrypted && session.keys && !session.locked) {
    await park();
    if (await adoptEnvelope(envelope)) {
      toast("Shared save loaded");
      return;
    }
  }

  const values = await openModal({
    title: "Encrypted Cadence save",
    bodyHTML: `Enter a passphrase to open it — the therapist one opens everything,
      the admin one opens scheduling only.${
        hasCurrentData
          ? " It replaces what’s in the app right now (the current data is saved to Downloads first)."
          : ""
      }`,
    formHTML: `
      <div class="form-row"><label>Passphrase</label>
        <input type="password" name="passphrase"></div>`,
    confirmText: "Open",
  });
  if (!values) return;
  await park();
  if (await adoptWithPassphrase(envelope, values.passphrase)) {
    toast("Shared save loaded — this computer stays unlocked");
  } else {
    toast("That passphrase doesn’t open this file", "warn");
  }
}
