/**
 * Resizable table columns.
 * Call makeColumnsResizable(tableElement) after rendering any <table>.
 * Adds drag handles to <th> elements.
 * Persists column widths to sessionStorage keyed by table id.
 */

const MIN_COL_WIDTH = 40; // px

/**
 * Make all <th> columns in a table resizable by drag.
 * @param {HTMLTableElement} table
 * @param {string} [storageKey] - optional key for persisting widths
 */
export function makeColumnsResizable(table, storageKey) {
  if (!table || table._resizable) return;
  table._resizable = true;

  const headers = Array.from(table.querySelectorAll('thead th'));
  if (headers.length === 0) return;

  // Restore saved widths
  const savedWidths = loadWidths(storageKey);

  headers.forEach((th, i) => {
    // Apply saved width if available
    if (savedWidths && savedWidths[i] != null) {
      th.style.width = savedWidths[i] + 'px';
      th.style.minWidth = savedWidths[i] + 'px';
    }

    // Don't add handle to the last column (it auto-fills)
    if (i === headers.length - 1) return;

    // Create drag handle
    const handle = document.createElement('span');
    handle.className = 'col-resize-handle';
    handle.setAttribute('aria-hidden', 'true');
    handle.style.cssText = [
      'position:absolute',
      'top:0',
      'right:0',
      'width:8px',
      'height:100%',
      'cursor:col-resize',
      'z-index:10',
      'user-select:none',
      'display:flex',
      'align-items:center',
      'justify-content:center',
    ].join(';');

    // Visual indicator line
    const line = document.createElement('span');
    line.style.cssText = [
      'display:block',
      'width:2px',
      'height:60%',
      'background:rgba(148,163,184,0.2)',
      'border-radius:1px',
      'transition:background 0.15s',
    ].join(';');
    handle.appendChild(line);

    handle.addEventListener('mouseenter', () => {
      line.style.background = 'rgba(34,211,238,0.5)';
    });
    handle.addEventListener('mouseleave', () => {
      if (!handle._dragging) line.style.background = 'rgba(148,163,184,0.2)';
    });

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      handle._dragging = true;
      line.style.background = 'rgba(34,211,238,0.8)';

      const startX = e.clientX;
      const startWidth = th.offsetWidth;

      // Overlay to capture mouse events outside table
      const overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:col-resize;';
      document.body.appendChild(overlay);

      const onMove = (ev) => {
        const delta = ev.clientX - startX;
        const newWidth = Math.max(MIN_COL_WIDTH, startWidth + delta);
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
      };

      const onUp = () => {
        handle._dragging = false;
        line.style.background = 'rgba(148,163,184,0.2)';
        overlay.remove();
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        saveWidths(storageKey, headers);
      };

      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    // Touch support
    handle.addEventListener('touchstart', (e) => {
      e.preventDefault();
      const touch = e.touches[0];
      const startX = touch.clientX;
      const startWidth = th.offsetWidth;

      const onMove = (ev) => {
        const t = ev.touches[0];
        const delta = t.clientX - startX;
        const newWidth = Math.max(MIN_COL_WIDTH, startWidth + delta);
        th.style.width = newWidth + 'px';
        th.style.minWidth = newWidth + 'px';
      };

      const onEnd = () => {
        handle.removeEventListener('touchmove', onMove);
        handle.removeEventListener('touchend', onEnd);
        saveWidths(storageKey, headers);
      };

      handle.addEventListener('touchmove', onMove, { passive: false });
      handle.addEventListener('touchend', onEnd);
    }, { passive: false });

    // Ensure th has position:relative for the absolute handle
    const pos = window.getComputedStyle(th).position;
    if (pos === 'static') th.style.position = 'relative';

    th.appendChild(handle);
  });
}

function saveWidths(key, headers) {
  if (!key) return;
  try {
    const widths = headers.map(th => th.offsetWidth);
    sessionStorage.setItem('col-widths:' + key, JSON.stringify(widths));
  } catch { /* quota */ }
}

function loadWidths(key) {
  if (!key) return null;
  try {
    const raw = sessionStorage.getItem('col-widths:' + key);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}
