// One clipboard path for every "Copy" button. navigator.clipboard is a
// promise — a sync try/catch can't see its rejection (WebKit rejects
// far more readily than Chromium), and it can be entirely absent, so:
// async API first, textarea+execCommand fallback, and the success toast
// only ever AFTER a copy actually happened.

import { toast } from "./toast.js";

export function copyToClipboard(text, okMsg = "Copied") {
  const done = (ok) =>
    toast(ok ? okMsg : "Couldn’t reach the clipboard", ok ? undefined : "warn");
  const legacy = () => {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      /* fall through */
    }
    ta.remove();
    done(ok);
  };
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), legacy);
  } else {
    legacy();
  }
}
