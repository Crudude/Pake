// The gear-icon popover: parity flip, encrypted sync, Jane import,
// sample data, wipe and recovery. Extracted from main.js so the render
// modules stay one-per-surface.

import {
  mutate,
  session,
  setupEncryption,
  disableEncryption,
  lockDevice,
  linkSaveFile,
  adoptEnvelope,
  overwriteLinkedFile,
  replaceData,
  normalizeData,
  validEnvelope,
  emptyData,
  hasAnyData,
} from "../state/store.js";
import {
  fileLinkingSupported,
  pickSaveFile,
  unlinkSaveFile,
} from "../state/sync.js";
import { parityNames } from "../domain/time.js";
import {
  exportBackup,
  exportSharedSaveCopy,
  stashPreDestroyBackup,
  getPreDestroyBackup,
} from "../backup.js";
import { importJaneCSV } from "../jane.js";
import { openModal, escapeHTML } from "./dialogs.js";
import { toast } from "./toast.js";

export function renderSettings(el, ctx) {
  if (!ctx.ui.settingsOpen) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  const state = ctx.state;
  const hasData = hasAnyData(state);
  const names = parityNames(state.settings);
  el.innerHTML = `
    <div class="set-row">
      <div>
        <div>Week names</div>
        <div class="hint">What the two alternating weeks are called — rename them to anything.</div>
      </div>
    </div>
    <div class="set-row">
      <input type="text" class="week-name-input" data-set="name-even"
        value="${escapeHTML(names[0])}" maxlength="14" autocomplete="off" aria-label="First week name">
      <input type="text" class="week-name-input" data-set="name-odd"
        value="${escapeHTML(names[1])}" maxlength="14" autocomplete="off" aria-label="Second week name">
    </div>
    <div class="set-row">
      <div>
        <div>Swap the two weeks</div>
        <div class="hint">If this week shows under the wrong name, flip this once.</div>
      </div>
      <label class="switch">
        <input type="checkbox" data-set="flip" ${state.settings.parityLabelFlipped ? "checked" : ""}>
        <span class="track"></span>
      </label>
    </div>
    <div class="set-row">
      <div>
        <div>Shared save</div>
        <div class="hint">${
          session.encrypted
            ? `Encrypted &middot; ${session.role} role &middot; ${
                session.handle
                  ? session.filePermission
                    ? "file linked"
                    : "file needs reconnecting"
                  : fileLinkingSupported()
                    ? "no file linked yet"
                    : "no file link on this build — use Export shared save"
              }`
            : "Off — data stays on this computer only."
        }</div>
      </div>
    </div>
    <div class="set-row">
      ${
        !session.encrypted
          ? '<button class="btn btn--primary" data-act="sync-setup">Set up encrypted sync&hellip;</button>'
          : `${fileLinkingSupported() ? '<button class="btn" data-act="sync-file">Choose save file&hellip;</button>' : ""}
           ${!fileLinkingSupported() && !session.handle ? '<button class="btn" data-act="export-shared">Export shared save&hellip;</button>' : ""}
           <button class="btn" data-act="sync-lock">Lock now</button>
           ${session.role === "therapist" ? '<button class="btn btn--danger" data-act="sync-off">Turn off&hellip;</button>' : ""}`
      }
    </div>
    <hr>
    <div class="set-row">
      <button class="btn" data-act="jane-import">Import from Jane&hellip;</button>
      <input type="file" data-act="jane-file" accept=".csv,text/csv" hidden>
    </div>
    <div class="hint" style="font-size:11px;color:var(--ink-3)">Reports &rarr; Client List (filter by appointment date) &rarr; export CSV. Only client number + name are read.</div>
    <hr>
    <div class="set-row">
      <button class="btn" data-act="sample" ${hasData ? "disabled" : ""}>Load sample data</button>
      <button class="btn btn--danger" data-act="wipe" ${hasData ? "" : "disabled"}>Delete all data&hellip;</button>
    </div>
    ${hasData ? '<div class="hint" style="font-size:11px;color:var(--ink-3)">Sample data is only offered while the app is empty.</div>' : ""}
    <div class="set-row">
      <button class="btn" data-act="recover">Recover pre-delete backup&hellip;</button>
    </div>
    <hr>
    <p class="about">Cadence holds the two-week template and light planning notes only.
      Jane is the record of record — sessions, attendance and clinical notes live there.</p>`;

  el.querySelector('[data-set="flip"]').addEventListener("change", (e) => {
    mutate((s) => {
      s.settings.parityLabelFlipped = e.target.checked;
    });
  });

  for (const [attr, key, fallback] of [
    ["name-even", "even", "Even"],
    ["name-odd", "odd", "Odd"],
  ]) {
    const input = el.querySelector(`[data-set="${attr}"]`);
    input.addEventListener("change", () => {
      const value = input.value.trim().slice(0, 14) || fallback;
      mutate((s) => {
        s.settings.parityNames[key] = value;
      });
    });
  }

  const closeAnd = (fn) => async () => {
    ctx.ui.settingsOpen = false;
    ctx.rerender();
    await fn();
  };

  const syncSetup = el.querySelector('[data-act="sync-setup"]');
  if (syncSetup) {
    syncSetup.addEventListener(
      "click",
      closeAnd(async () => {
        const values = await openModal({
          title: "Set up encrypted sync",
          bodyHTML: `Two passphrases: the therapist one opens everything; the admin
          one opens scheduling but can never decrypt case plans, session logs or
          formulations. <b>Write them down somewhere safe — there is no reset.</b>`,
          formHTML: `
          <div class="form-row"><label>Therapist passphrase (min 8)</label>
            <input type="password" name="tp"></div>
          <div class="form-row"><label>Repeat therapist passphrase</label>
            <input type="password" name="tp2"></div>
          <div class="form-row"><label>Admin passphrase (min 8, different)</label>
            <input type="password" name="ap"></div>
          <div class="form-row"><label>Repeat admin passphrase</label>
            <input type="password" name="ap2"></div>`,
          confirmText: "Encrypt",
        });
        if (!values) return;
        if (values.tp.length < 8 || values.tp !== values.tp2) {
          toast("Therapist passphrases don’t match (min 8)", "warn");
          return;
        }
        if (
          values.ap.length < 8 ||
          values.ap !== values.ap2 ||
          values.ap === values.tp
        ) {
          toast("Admin passphrase invalid — min 8 and different", "warn");
          return;
        }
        await setupEncryption(values.tp, values.ap);
        // The file-picker button only exists where a linking backend does —
        // don't send other builds hunting for it.
        toast(
          fileLinkingSupported()
            ? "Encrypted — now choose the save file in your OneDrive folder (Settings)"
            : "Encrypted — this computer keeps its own encrypted copy",
        );
        ctx.rerender();
      }),
    );
  }

  const syncFile = el.querySelector('[data-act="sync-file"]');
  if (syncFile) {
    syncFile.addEventListener(
      "click",
      closeAnd(async () => {
        let handle;
        try {
          handle = await pickSaveFile();
        } catch {
          return; /* picker dismissed */
        }
        const res = await linkSaveFile(handle);
        if (res.status === "existing") {
          await handleExistingFile(res.envelope, handle, ctx);
        } else {
          toast(
            `Saving to ${handle.name} — put it in the shared OneDrive folder`,
          );
        }
        ctx.rerender();
      }),
    );
  }

  const syncLock = el.querySelector('[data-act="sync-lock"]');
  if (syncLock) syncLock.addEventListener("click", () => lockDevice());

  const exportShared = el.querySelector('[data-act="export-shared"]');
  if (exportShared) {
    exportShared.addEventListener(
      "click",
      closeAnd(() => exportSharedSaveCopy()),
    );
  }

  const syncOff = el.querySelector('[data-act="sync-off"]');
  if (syncOff) {
    syncOff.addEventListener(
      "click",
      closeAnd(async () => {
        const ok = await openModal({
          title: "Turn off encrypted sync?",
          bodyHTML: `Data goes back to plain storage on this computer only. The shared
          file is disconnected — its (now outdated) encrypted copy can be deleted
          from OneDrive.`,
          confirmText: "Turn off",
          danger: true,
          requireText: "plain",
        });
        if (!ok) return;
        try {
          await disableEncryption();
          toast("Encryption off — local plain storage");
        } catch {
          toast(
            "Couldn’t disconnect the shared file — nothing was changed",
            "warn",
          );
        }
        ctx.rerender();
      }),
    );
  }

  const janeFile = el.querySelector('[data-act="jane-file"]');
  el.querySelector('[data-act="jane-import"]').addEventListener("click", () =>
    janeFile.click(),
  );
  janeFile.addEventListener("change", async () => {
    const file = janeFile.files[0];
    janeFile.value = "";
    if (!file) return;
    ctx.ui.settingsOpen = false;
    ctx.rerender();
    await importJaneCSV(await file.text());
  });

  el.querySelector('[data-act="sample"]').addEventListener("click", () => {
    ctx.ui.settingsOpen = false;
    ctx.loadSample();
  });

  el.querySelector('[data-act="recover"]').addEventListener(
    "click",
    closeAnd(() => recoverPreDelete(ctx)),
  );

  el.querySelector('[data-act="wipe"]').addEventListener(
    "click",
    closeAnd(async () => {
      const ok = await openModal({
        title: "Delete all data?",
        bodyHTML: `Every client, slot, note, task and list is removed from the app.
        A final backup file is saved to Downloads first (and a recovery copy is
        kept on this computer — Settings &rarr; Recover pre-delete backup).
        Exported backups are otherwise untouched.`,
        confirmText: "Delete everything",
        danger: true,
        requireText: "delete",
      });
      if (!ok) return;
      await stashPreDestroyBackup();
      await exportBackup({ silent: true });
      ctx.ui.placementClientId = null;
      ctx.ui.drawerClientId = null;
      mutate((s) => {
        // Derive the reset from the canonical empty shape so a future
        // collection can never be missed here; settings survive the wipe.
        const fresh = normalizeData(emptyData());
        for (const k of Object.keys(fresh)) {
          if (k !== "settings" && k !== "schemaVersion") s[k] = fresh[k];
        }
        s.settings.lastBackupAt = null;
      });
      toast("All data deleted — a final backup file is in Downloads");
    }),
  );
}

// The picked file already holds an encrypted save. NEVER auto-overwrite:
// this is exactly what "restoring" a shared save looks like.
async function handleExistingFile(envelope, handle, ctx) {
  const when = envelope.savedAt
    ? new Date(envelope.savedAt).toLocaleString()
    : "unknown time";
  const adopt = await openModal({
    title: "This file already holds a Cadence save",
    bodyHTML: `Last saved ${escapeHTML(when)}. Load its data into the app
      (right choice when reconnecting or restoring)? Nothing has been
      written to the file yet.`,
    confirmText: "Load its data",
    cancelText: "Not now",
  });
  if (adopt) {
    if (await adoptEnvelope(envelope, { isFileContent: true })) {
      toast(`Loaded the save from ${handle.name} — future changes write there`);
    } else {
      session.handle = null;
      session.filePermission = false;
      // Best-effort here: the poisoned fileRev already guards writes.
      await unlinkSaveFile().catch(() => {});
      toast(
        "That file was sealed with different passphrases — it can’t be linked to this practice",
        "warn",
      );
    }
    return;
  }
  const overwrite = await openModal({
    title: "Overwrite the file instead?",
    bodyHTML: `The save inside <b>${escapeHTML(handle.name)}</b> is replaced by
      what’s in the app right now.`,
    confirmText: "Overwrite file",
    danger: true,
    requireText: "overwrite",
  });
  if (overwrite) {
    await overwriteLinkedFile(envelope);
    toast(`Saving to ${handle.name} — put it in the shared OneDrive folder`);
  } else {
    // linkSaveFile left the identity poisoned (fileRev -1), so the next
    // save cannot take the unchanged fast-path — it raises the conflict
    // prompt instead of silently clobbering the declined file.
    toast(
      "File linked, nothing written — the next save will ask about the conflict",
    );
  }
}

async function recoverPreDelete(ctx) {
  const saved = await getPreDestroyBackup();
  if (!saved?.envelope) {
    toast("No pre-delete backup exists on this computer", "warn");
    return;
  }
  const when = saved.savedAt
    ? new Date(saved.savedAt).toLocaleString()
    : "unknown time";
  const ok = await openModal({
    title: "Recover pre-delete backup?",
    bodyHTML: `Replaces what’s in the app with the copy parked here just before
      the last delete (${escapeHTML(when)}).`,
    confirmText: "Recover",
  });
  if (!ok) return;
  const env = saved.envelope;
  if (validEnvelope(env)) {
    // A plain stash carries clinical fields. An admin-role seal would
    // strip them again (splitData) and expose them meanwhile — recovery
    // of plain data is a therapist action.
    if (session.encrypted && session.role !== "therapist") {
      toast(
        "That copy holds clinical content — unlock with the therapist passphrase to recover it",
        "warn",
      );
      return;
    }
    replaceData(normalizeData(structuredClone(env.data)));
    toast("Recovered");
  } else if (env.format === "cadence-encrypted") {
    if (!session.encrypted || !session.keys) {
      toast(
        "That copy is encrypted — set up encrypted sync with the same passphrases first",
        "warn",
      );
      return;
    }
    if (await adoptEnvelope(env)) toast("Recovered");
    else toast("That copy was sealed with different passphrases", "warn");
  } else {
    toast("The recovery copy is unreadable", "warn");
  }
  ctx.rerender();
}
