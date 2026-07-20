// Shared drag context. dataTransfer payloads aren't readable during
// dragover, so validity feedback reads from this module instead.

export const drag = { active: null };
// active: { kind: 'assignment', id } | { kind: 'client', id }

export function startDrag(payload, dataTransfer) {
  drag.active = payload;
  try {
    dataTransfer.setData('application/x-cadence', JSON.stringify(payload));
    dataTransfer.effectAllowed = 'move';
  } catch { /* older webviews */ }
}

export function endDrag() {
  drag.active = null;
}

export function readDrop(e) {
  try {
    const raw = e.dataTransfer.getData('application/x-cadence');
    if (raw) return JSON.parse(raw);
  } catch { /* fall through */ }
  return drag.active;
}
