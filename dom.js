/**
 * Centralized DOM helpers.
 * NOTE: $ does NOT cache — caching stale references caused click handlers
 * to be attached to detached nodes after clearChildren() re-renders.
 */

/** Get element by id — always fresh lookup */
export function $(id) {
  return document.getElementById(id);
}

/** Query selector shorthand */
export function qs(selector, root = document) {
  return root.querySelector(selector);
}

/** Query all shorthand */
export function qsa(selector, root = document) {
  return [...root.querySelectorAll(selector)];
}

/** Create element with attributes and children */
export function el(tag, attrs = {}, ...children) {
  const element = document.createElement(tag);
  for (const [key, val] of Object.entries(attrs)) {
    if (key === 'className') {
      element.className = val;
    } else if (key === 'dataset') {
      Object.assign(element.dataset, val);
    } else if (key.startsWith('on')) {
      element.addEventListener(key.slice(2).toLowerCase(), val);
    } else {
      element.setAttribute(key, val);
    }
  }
  children.forEach(child => {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else if (child instanceof Node) {
      element.appendChild(child);
    }
  });
  return element;
}

/** Clear children of an element */
export function clearChildren(element) {
  while (element.firstChild) {
    element.removeChild(element.firstChild);
  }
}

function pushLines(lines, title, items = []) {
  if (!Array.isArray(items) || items.length === 0) return;
  if (lines.length) lines.push('');
  lines.push(title);
  items.forEach(item => lines.push(`• ${item}`));
}

/**
 * Shows a detailed delete warning with recalculation/cascade notes.
 */
export function confirmDeleteWithImpact({
  title = 'Удалить запись?',
  subject = '',
  impacts = [],
  recalculations = [],
  risks = [],
  finalNote = 'Действие нельзя отменить.',
} = {}) {
  const lines = [title];

  if (subject) {
    lines.push(`Объект: ${subject}`);
  }

  pushLines(lines, 'Что произойдёт:', impacts);
  pushLines(lines, 'Что будет пересчитано автоматически:', recalculations);
  pushLines(lines, 'Что не удаляется автоматически:', risks);

  if (finalNote) {
    lines.push('');
    lines.push(finalNote);
  }

  return window.confirm(lines.join('\n'));
}
