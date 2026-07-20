// Anonymizer for anything that leaves the app for a Claude chat.
// Jane-side full names (and their parts, two letters up) are replaced
// with the client's display code, so a formulation reads "DUc"
// throughout and Claude still knows exactly which client is meant.
// Emails and phone numbers are scrubbed too.
//
// Two honest limits, reported via anonymizeWithReport:
// - A client with NO Jane-side name cannot be scrubbed — her stored
//   name IS the real first name, and it appears as-is.
// - It only catches names it knows: family members or third parties
//   typed into notes still need the initials-only habit.

import { getState } from "./state/store.js";

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Unicode-aware word boundary: \b is ASCII-only and never matches
// around CJK or at the end of "José". Sub-3-letter parts match
// case-sensitively so a client part "An" can't rewrite every "an".
function nameRegExp(needle) {
  const flags = needle.length >= 3 ? "giu" : "gu";
  return new RegExp(
    `(?<![\\p{L}\\p{N}])${escapeRegExp(needle)}(?![\\p{L}\\p{N}])`,
    flags,
  );
}

export function anonymizeWithReport(text) {
  const state = getState();
  const src = String(text);
  let out = src;

  const replacements = [];
  for (const c of state.clients) {
    const full = c.jane?.name;
    if (!full) continue;
    replacements.push([full, c.name]);
    for (const part of full.split(/\s+/)) {
      if (part.length >= 2) replacements.push([part, c.name]);
    }
  }
  // Longest needles first so "Ana Alvarez" wins over "Ana".
  replacements.sort((a, b) => b[0].length - a[0].length);
  for (const [needle, code] of replacements) {
    out = out.replace(nameRegExp(needle), code);
  }

  out = out.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, "[email]");
  out = out.replace(/\+?\d[\d\s().-]{8,}\d/g, "[phone]");

  const unscrubbed = [];
  for (const c of state.clients) {
    if (c.jane?.name || !c.name) continue;
    // Must appear in the ORIGINAL text too — an inserted display code
    // that happens to spell another client's name is not a leak.
    if (nameRegExp(c.name).test(src) && nameRegExp(c.name).test(out))
      unscrubbed.push(c.name);
  }
  return { text: out, unscrubbed };
}

export function anonymize(text) {
  return anonymizeWithReport(text).text;
}
