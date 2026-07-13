/**
 * Search and filter controls.
 * Includes shared predictive filter helpers used across cards and registries.
 */

import { $, el, clearChildren } from './dom.js';
import { state, getCategories } from '../state.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

let onFilterChange = null;

function normalizePredictiveOptions(options = []) {
  const seen = new Set();
  return options
    .map(value => String(value ?? '').trim())
    .filter(Boolean)
    .filter(value => {
      const key = value.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function ensurePredictiveDatalist(listId, options, host) {
  if (!listId) return null;
  let list = document.getElementById(listId);
  if (!list) {
    list = document.createElement('datalist');
    list.id = listId;
    (host || document.body).appendChild(list);
  }
  clearChildren(list);
  normalizePredictiveOptions(options).forEach(option => {
    list.appendChild(el('option', { value: option }));
  });
  return list;
}

function bindPredictiveUi(input, clearBtn) {
  if (!input || !clearBtn || input.dataset.predictiveUiBound === 'true') return;

  const syncState = () => {
    const empty = !String(input.value || '').trim();
    clearBtn.dataset.empty = empty ? 'true' : 'false';
    clearBtn.disabled = empty;
  };

  input.addEventListener('input', syncState);
  input.addEventListener('change', syncState);
  clearBtn.addEventListener('click', event => {
    event.preventDefault();
    if (!String(input.value || '').trim()) return;
    input.value = '';
    input.focus();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    syncState();
  });

  input.dataset.predictiveUiBound = 'true';
  syncState();
}

export function enhancePredictiveInput(input, {
  listId,
  options = [],
  icon = '⌕',
  minWidth,
  host,
  clearLabel,
} = {}) {
  if (!(input instanceof HTMLInputElement)) return null;

  if (listId) {
    input.setAttribute('list', listId);
  }

  input.classList.add('predictive-filter__input');
  input.autocomplete = input.autocomplete || 'off';

  let shell = input.closest('.predictive-filter');
  if (!shell) {
    shell = document.createElement('div');
    shell.className = 'predictive-filter';
    if (minWidth) shell.style.minWidth = minWidth;
    input.parentNode?.insertBefore(shell, input);
    shell.appendChild(input);
  } else if (minWidth) {
    shell.style.minWidth = minWidth;
  }

  let iconEl = shell.querySelector('.predictive-filter__icon');
  if (!iconEl) {
    iconEl = document.createElement('span');
    iconEl.className = 'predictive-filter__icon';
    iconEl.setAttribute('aria-hidden', 'true');
    shell.insertBefore(iconEl, input);
  }
  iconEl.textContent = icon;

  let clearBtn = shell.querySelector('.predictive-filter__clear');
  if (!clearBtn) {
    clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className = 'predictive-filter__clear';
    shell.appendChild(clearBtn);
  }
  clearBtn.textContent = '✕';
  clearBtn.setAttribute('aria-label', clearLabel || t('actions.clear'));

  if (listId) {
    const listHost = host || shell.parentElement || document.body;
    let list = document.getElementById(listId);
    if (list && list.parentElement !== listHost && !shell.contains(list)) {
      listHost.appendChild(list);
    }
    ensurePredictiveDatalist(listId, options, listHost);
  }

  bindPredictiveUi(input, clearBtn);
  return shell;
}

export function createPredictiveFilterControl({
  id,
  listId,
  placeholder = '',
  value = '',
  options = [],
  icon = '⌕',
  ariaLabel,
  minWidth = '160px',
  inputClassName = '',
  wrapClassName = '',
  clearLabel,
} = {}) {
  const wrap = el('div', { className: `predictive-filter ${wrapClassName}`.trim() });
  if (minWidth) wrap.style.minWidth = minWidth;

  const iconEl = el('span', { className: 'predictive-filter__icon', 'aria-hidden': 'true' }, icon);
  const input = el('input', {
    id,
    type: 'search',
    list: listId,
    placeholder,
    value,
    autocomplete: 'off',
    'aria-label': ariaLabel || placeholder || id || 'filter',
    className: `predictive-filter__input ${inputClassName}`.trim(),
  });
  const clearBtn = el('button', {
    type: 'button',
    className: 'predictive-filter__clear',
    'aria-label': clearLabel || t('actions.clear'),
  }, '✕');
  const list = el('datalist', { id: listId });
  normalizePredictiveOptions(options).forEach(option => {
    list.appendChild(el('option', { value: option }));
  });

  wrap.append(iconEl, input, clearBtn, list);
  bindPredictiveUi(input, clearBtn);
  return wrap;
}

export function refreshPredictiveOptions(listId, options = []) {
  ensurePredictiveDatalist(listId, options, document.body);
}

/** Populate filter dropdowns from current data */
export function updateFilterOptions() {
  const categorySelect = $('filterCategory');

  if (categorySelect) {
    const currentVal = categorySelect.value;
    clearChildren(categorySelect);
    categorySelect.appendChild(el('option', { value: '' }, t('filters.all')));
    getCategories().forEach(cat => {
      categorySelect.appendChild(el('option', { value: cat }, cat));
    });
    categorySelect.value = currentVal;
  }
}

/** Update product count display */
export function updateProductCount(visibleCount, totalCount) {
  const counter = $('productCount');
  if (!counter) return;

  if (totalCount === 0) {
    counter.textContent = '';
  } else if (visibleCount === totalCount) {
    counter.textContent = `${totalCount}`;
  } else {
    counter.textContent = `${visibleCount} / ${totalCount}`;
  }
}

/** Initialize filter event listeners */
export function initFilters(callback) {
  onFilterChange = callback;

  const searchInput = $('filterSearch');
  const categorySelect = $('filterCategory');

  if (searchInput) {
    let debounceTimer = null;
    searchInput.addEventListener('input', () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        state.filters.search = searchInput.value;
        if (onFilterChange) onFilterChange();
      }, 200);
    });
  }

  if (categorySelect) {
    categorySelect.addEventListener('change', () => {
      state.filters.category = categorySelect.value;
      if (onFilterChange) onFilterChange();
    });
  }
}
