// Display-name codes. On-screen the app shows compact initials so a
// glanced-at screen gives nothing away: first initial + first two
// letters of the surname — "Joshua Nevin" -> "JNe". The full name (when
// known, e.g. from Jane) stays tucked in the drawer.

export function deriveCode(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '';
  if (parts.length === 1) return parts[0];
  const first = parts[0][0].toUpperCase();
  const last = parts[parts.length - 1];
  return first + last[0].toUpperCase() + (last[1] || '').toLowerCase();
}

// Collision-safe variant: "Maria Silva" and "Mark Sims" must not both
// show as MSi. Extends the surname one letter at a time (MSi → MSil →
// MSilv), then falls back to a numeric suffix once the surname runs out.
export function uniqueCode(fullName, taken) {
  const base = deriveCode(fullName);
  if (!base || !taken.has(base)) return base;
  const parts = String(fullName).trim().split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    const last = parts[parts.length - 1];
    const first = parts[0][0].toUpperCase();
    for (let n = 3; n <= last.length; n += 1) {
      const code = first + last[0].toUpperCase() + last.slice(1, n).toLowerCase();
      if (!taken.has(code)) return code;
    }
  }
  for (let i = 2; ; i += 1) {
    const code = base + i;
    if (!taken.has(code)) return code;
  }
}
