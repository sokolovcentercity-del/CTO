/**
 * Toast notification system.
 */

import { el } from './dom.js';

let container = null;

function ensureContainer() {
  if (!container) {
    container = el('div', { className: 'toast-container', 'aria-live': 'polite' });
    document.body.appendChild(container);
  }
  return container;
}

/** Show a toast message */
export function showToast(message, type = 'success', duration = 3000) {
  const c = ensureContainer();

  const colors = {
    success: 'bg-emerald-500/90 text-white',
    error: 'bg-red-500/90 text-white',
    info: 'bg-cyan-500/90 text-white',
    warning: 'bg-amber-500/90 text-slate-900',
  };

  const icons = {
    success: '✓',
    error: '✕',
    info: 'ℹ',
    warning: '⚠',
  };

  const toast = el(
    'div',
    {
      className: `toast flex items-center gap-2 rounded-xl px-4 py-3 text-sm font-medium shadow-lg ${colors[type] || colors.info}`,
      role: 'status',
    },
    el('span', { className: 'text-base' }, icons[type] || icons.info),
    el('span', {}, message),
  );

  c.appendChild(toast);

  setTimeout(() => {
    toast.classList.add('out');
    toast.addEventListener('animationend', () => toast.remove());
  }, duration);
}
