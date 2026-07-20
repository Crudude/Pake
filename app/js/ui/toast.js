let root = null;

export function initToast(el) {
  root = el;
}

export function toast(message, tone = 'info') {
  if (!root) return;
  const el = document.createElement('div');
  el.className = `toast${tone === 'warn' ? ' toast--warn' : ''}`;
  el.textContent = message;
  root.append(el);
  requestAnimationFrame(() => el.classList.add('is-in'));
  setTimeout(() => {
    el.classList.remove('is-in');
    setTimeout(() => el.remove(), 400);
  }, 3600);
}
