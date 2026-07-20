// Week math and the working-day grid.
//
// Parity is an internal index (0 or 1) anchored to a fixed epoch Monday,
// NOT to ISO week numbers — ISO years with 53 weeks would put two odd
// weeks back to back. Which index is *labelled* "Even" is a display
// setting (settings.parityLabelFlipped) so the app can match whatever
// the therapist already calls her weeks.

export const DAYS = [
  { dow: 2, name: 'Tuesday', short: 'Tue' },
  { dow: 3, name: 'Wednesday', short: 'Wed' },
  { dow: 4, name: 'Thursday', short: 'Thu' },
  { dow: 5, name: 'Friday', short: 'Fri' },
  { dow: 6, name: 'Saturday', short: 'Sat' },
];

export const DAY_START = 9 * 60;   // 9:00
export const DAY_END = 19 * 60;    // 19:00
export const STEP = 30;

// The only allowed lengths. Validators (normalizeData) coerce anything
// else to the default, so UI option lists MUST draw from these arrays —
// a new length added only in a <select> would be silently rewritten on
// the next load.
export const SESSION_DURATIONS = [30, 60, 90];
export const BLOCK_DURATIONS = [30, 60, 90, 120];

export const SLOTS = [];
for (let m = DAY_START; m < DAY_END; m += STEP) SLOTS.push(m);

// Mon 1 Jan 2024, local noon. Noon keeps DST shifts from moving the day.
const EPOCH = new Date(2024, 0, 1, 12);
const DAY_MS = 24 * 60 * 60 * 1000;

function localNoon(date) {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12);
}

export function weekIndexOf(date = new Date()) {
  // Round to whole days first: across a DST boundary the raw difference
  // is off by an hour, and flooring raw ms puts every summer Monday in
  // the previous week.
  const days = Math.round((localNoon(date) - EPOCH) / DAY_MS);
  return Math.floor(days / 7);
}

export function currentParity(date = new Date()) {
  return ((weekIndexOf(date) % 2) + 2) % 2;
}

export function mondayOf(date = new Date()) {
  const noon = localNoon(date);
  const sinceMonday = (noon.getDay() + 6) % 7;
  noon.setDate(noon.getDate() - sinceMonday);
  return noon;
}

export const DEFAULT_PARITY_NAMES = ['Even', 'Odd'];

// The two alternating weeks can be called anything (settings.parityNames,
// synced in the save file). Slot 0 is the LEFT column's name; the
// Swap toggle (parityLabelFlipped) still controls which internal parity
// index sits in which slot.
export function parityNames(settings) {
  const custom = settings.parityNames || {};
  return [
    String(custom.even ?? '').trim() || DEFAULT_PARITY_NAMES[0],
    String(custom.odd ?? '').trim() || DEFAULT_PARITY_NAMES[1],
  ];
}

export function hasDefaultParityNames(settings) {
  const [a, b] = parityNames(settings);
  return a === DEFAULT_PARITY_NAMES[0] && b === DEFAULT_PARITY_NAMES[1];
}

export function parityLabel(parityIndex, settings) {
  const names = parityNames(settings);
  return settings.parityLabelFlipped
    ? names[1 - parityIndex]
    : names[parityIndex];
}

// "Even weeks" reads right for the defaults; a custom name ("Week A",
// "Blue") stands alone.
export function parityPhrase(parityIndex, settings) {
  const label = parityLabel(parityIndex, settings);
  return hasDefaultParityNames(settings) ? `${label} weeks` : label;
}

// Left-to-right parity indexes for each day column. The left half is
// always the one carrying slot-0's name.
export function columnOrder(settings) {
  return settings.parityLabelFlipped ? [1, 0] : [0, 1];
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function weekHeadingParts(date, settings) {
  const monday = mondayOf(date);
  const label = parityLabel(currentParity(date), settings);
  return {
    weekOf: `${monday.getDate()} ${MONTHS[monday.getMonth()]}`,
    parityName: label,
    // "· odd week" for the defaults, "· Week A" verbatim for custom names.
    parityHeading: hasDefaultParityNames(settings) ? `${label.toLowerCase()} week` : label,
  };
}

export function fmtTime(minutes) {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const h12 = ((h + 11) % 12) + 1;
  return m === 0 ? `${h12}` : `${h12}:${String(m).padStart(2, '0')}`;
}

export function fmtTimeRange(start, duration) {
  return `${fmtTime(start)}–${fmtTime(start + duration)}`;
}

// Hour labels down the gutter: "9 am", "10", "11", "12 pm", "1", ...
export function hourLabel(minutes) {
  const h = Math.floor(minutes / 60);
  if (h === 9) return '<b>9</b>&hairsp;am';
  if (h === 12) return '<b>12</b>&hairsp;pm';
  return `<b>${((h + 11) % 12) + 1}</b>`;
}

// The real calendar date of a given weekday in a given week index.
export function dateForWeek(weekIndex, dow) {
  const d = new Date(2024, 0, 1, 12); // epoch Monday
  d.setDate(d.getDate() + weekIndex * 7 + (dow - 1));
  return d;
}

export function fmtDayDate(date) {
  return `${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`;
}

export function todayISO() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function shortDate(iso) {
  const d = new Date(`${iso}T12:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  return `${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`;
}

export function daysAgo(isoDateTime) {
  const t = Date.parse(isoDateTime);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / (24 * 60 * 60 * 1000));
}
