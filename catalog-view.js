/**
 * Catalog view — sortable table of products.
 * Opens as a full-screen modal panel.
 */

import { $, el, clearChildren } from './dom.js';
import { state, getFilteredProducts, setSort, getLotNumbersForProduct, hasProductColorVariants, getProductColorVariants } from '../state.js';
import { updateFilterOptions, updateProductCount } from './filters.js';
import { makeColumnsResizable } from './resizable-cols.js';
import { attachFrozenManager, refreshFrozenTable } from './frozen-table.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

let onEditCallback   = null;
let onDeleteCallback = null;
let onViewCallback   = null;

/** Column definitions */
const COLUMNS = [
  { key: 'number',          labelKey: 'catalog.col.number',       sortable: true,  width: 'w-[60px]' },
  { key: 'name',            labelKey: 'catalog.col.name',         sortable: true,  width: '' },
  { key: 'category',        labelKey: 'catalog.col.category',     sortable: true,  width: 'w-[130px]' },
  { key: 'lotNumbers',      labelKey: 'catalog.col.lotNumbers',   sortable: false, width: 'w-[170px]' },
  { key: 'productGroup',    labelKey: 'catalog.col.productGroup', sortable: true,  width: 'w-[130px]' },
  { key: 'assembly',        labelKey: 'catalog.col.assembly',     sortable: true,  width: 'w-[130px]' },
  { key: 'characteristics', labelKey: 'catalog.col.specs',        sortable: true,  width: '' },
  { key: 'actions',         labelKey: '',                          sortable: false, width: 'w-[80px]' },
];

function sortIndicator(colKey) {
  if (state.sort.key !== colKey) return '';
  return state.sort.dir === 'asc' ? ' ▲' : ' ▼';
}

function renderTableHeader() {
  const thead = el('thead', { className: 'sticky top-0 z-10 bg-slate-900' });
  const row   = el('tr', {});

  COLUMNS.forEach(col => {
    const th = el('th', {
      className: `px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 select-none ${col.sortable ? 'cursor-pointer hover:text-cyan-400 transition' : ''} ${col.width}`,
    });

    if (col.key === 'actions') {
      th.textContent = '';
    } else {
      th.textContent = t(col.labelKey) + sortIndicator(col.key);
    }

    if (col.sortable) {
      th.addEventListener('click', () => {
        setSort(col.key);
        renderCatalogTable();
      });
    }

    row.appendChild(th);
  });

  thead.appendChild(row);
  return thead;
}

function renderRow(product) {
  const openProduct = () => (onViewCallback || onEditCallback)?.(product);

  const row = el('tr', {
    className: 'border-b border-white/5 hover:bg-white/[0.03] transition group cursor-pointer',
    tabindex: '0',
    role: 'button',
    'aria-label': `${t('actions.view')}: ${product.name || product.number || 'товар'}`,
    title: t('actions.view'),
    onClick: openProduct,
    onKeydown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        openProduct();
      }
    },
  });

  // Number
  row.appendChild(
    el('td', { className: 'px-3 py-3 text-sm font-bold text-cyan-400 tabular-nums whitespace-nowrap' },
      String(product.number)),
  );

  // Name
  const nameCell = el('td', { className: 'px-3 py-3 text-sm font-medium text-white' });
  if (hasProductColorVariants(product)) {
    const stack = el('div', { className: 'flex flex-col gap-1' });
    stack.appendChild(el('span', { className: 'text-white' }, product.name || '—'));
    const chips = el('div', { className: 'flex flex-wrap gap-1.5' });
    getProductColorVariants(product).forEach(variant => {
      chips.appendChild(el('span', {
        className: 'inline-flex items-center rounded-lg bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300',
        title: variant.fullCode || variant.colorCode,
      }, `RAL ${variant.colorCode}`));
    });
    stack.appendChild(chips);
    nameCell.appendChild(stack);
  } else {
    nameCell.textContent = product.name || '—';
  }
  row.appendChild(nameCell);

  // Category
  row.appendChild(
    el('td', { className: 'px-3 py-3 text-sm text-slate-400' },
      product.category || '—'),
  );

  // Lot numbers
  const lotCell = el('td', { className: 'px-3 py-3 text-sm' });
  const lotNumbers = getLotNumbersForProduct(product.id, product.name || '');
  if (lotNumbers.length > 0) {
    const lotWrap = el('div', { className: 'flex flex-wrap gap-1.5' });
    lotNumbers.forEach(lot => {
      const badge = el('span', {
        className: 'inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-0.5 text-[11px] font-semibold text-violet-300',
        title: lot,
      });
      badge.textContent = lot;
      lotWrap.appendChild(badge);
    });
    lotCell.appendChild(lotWrap);
  } else {
    lotCell.textContent = '—';
    lotCell.classList.add('text-slate-600');
  }
  row.appendChild(lotCell);

  // Product Group
  const pgCell = el('td', { className: 'px-3 py-3 text-sm' });
  if (product.productGroup) {
    const badge = el('span', {
      className: 'inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-0.5 text-xs font-medium text-violet-300',
    });
    badge.textContent = product.productGroup;
    pgCell.appendChild(badge);
  } else {
    pgCell.textContent = '—';
    pgCell.classList.add('text-slate-600');
  }
  row.appendChild(pgCell);

  // Assembly
  const assemblyCell = el('td', { className: 'px-3 py-3 text-sm' });
  const isRequired   = product.assembly === 'required';
  const badge = el('span', {
    className: isRequired
      ? 'inline-flex items-center gap-1 rounded-lg bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-400'
      : 'inline-flex items-center gap-1 rounded-lg bg-slate-700/60 px-2 py-0.5 text-xs font-medium text-slate-400',
  });
  badge.textContent = isRequired ? '🔧 ' + t('form.assemblyRequired') : t('form.assemblyNotRequired');
  assemblyCell.appendChild(badge);
  row.appendChild(assemblyCell);

  // Characteristics
  const specsCell = el('td', { className: 'px-3 py-3 text-sm text-slate-500 max-w-[300px]' });
  const specs = Array.isArray(product.specs) ? product.specs.filter(Boolean) : [];
  if (specs.length > 0) {
    const wrap = el('div', { className: 'flex flex-col gap-1' });
    specs.slice(0, 3).forEach(s => {
      const line = el('div', { className: 'flex items-baseline gap-1 min-w-0' });
      const paramSpan = el('span', { className: 'text-xs text-slate-300 truncate shrink-0 max-w-[120px]' });
      paramSpan.textContent = s.param || '—';
      line.appendChild(paramSpan);
      if (s.value || s.unit) {
        line.appendChild(el('span', { className: 'text-[10px] text-slate-600 shrink-0' }, ':'));
        const valSpan = el('span', { className: 'text-xs text-cyan-400/80 truncate' });
        valSpan.textContent = [s.value, s.unit].filter(Boolean).join(' ');
        line.appendChild(valSpan);
      }
      wrap.appendChild(line);
    });
    if (specs.length > 3) {
      wrap.appendChild(el('span', { className: 'text-[10px] text-slate-600 mt-0.5' }, `+${specs.length - 3} ещё`));
    }
    specsCell.appendChild(wrap);
  } else {
    specsCell.textContent = '—';
  }
  row.appendChild(specsCell);

  // Actions
  const actionsCell = el('td', { className: 'px-3 py-3' });
  const actions = el('div', { className: 'flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity' });

  const editBtn = el('button', {
    className: 'rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white transition',
    'aria-label': t('actions.edit'),
    title: t('actions.edit'),
    onClick: (e) => { e.stopPropagation(); onEditCallback?.(product); },
  }, '✎');

  const deleteBtn = el('button', {
    className: 'rounded-lg p-2 text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
    'aria-label': t('actions.delete'),
    title: t('actions.delete'),
    onClick: (e) => { e.stopPropagation(); onDeleteCallback?.(product); },
  }, '✕');

  actions.append(editBtn, deleteBtn);
  actionsCell.appendChild(actions);
  row.appendChild(actionsCell);

  return row;
}

function renderEmpty(hasFilters) {
  const container = $('catalogTableWrap');
  if (!container) return;
  clearChildren(container);

  const wrap = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });

  if (hasFilters) {
    wrap.appendChild(el('span', { className: 'text-5xl mb-4' }, '🔍'));
    wrap.appendChild(el('p', { className: 'text-sm text-slate-500' }, t('filters.noResults')));
  } else {
    wrap.appendChild(el('span', { className: 'text-5xl mb-4' }, t('empty.icon')));
    wrap.appendChild(el('h3', { className: 'text-lg font-semibold text-slate-300 mb-2' }, t('empty.title')));
    wrap.appendChild(el('p', { className: 'text-sm text-slate-500 max-w-xs' }, t('empty.subtitle')));
  }

  container.appendChild(wrap);
}

export function renderCatalogTable() {
  const container = $('catalogTableWrap');
  if (!container) return;

  // ── Сохраняем позицию скролла перед перерисовкой ──
  // Скролл живёт либо на самом контейнере, либо на родительском scroll-контейнере модала
  const scrollEl = container.closest('.overflow-y-auto') || container.parentElement;
  const savedScroll = scrollEl ? scrollEl.scrollTop : 0;

  clearChildren(container);

  const products   = getFilteredProducts();
  const hasFilters = !!(state.filters.search || state.filters.category);

  if (products.length === 0) {
    renderEmpty(hasFilters);
    return;
  }

  const wrapper = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
  const table   = el('table', { className: 'w-full text-sm' });

  table.appendChild(renderTableHeader());

  const tbody = el('tbody', { className: 'divide-y divide-white/5' });
  products.forEach(p => tbody.appendChild(renderRow(p)));
  table.appendChild(tbody);

  wrapper.appendChild(table);
  wrapper.setAttribute('data-frozen-key', 'catalog');
  makeColumnsResizable(table, 'catalog');
  container.appendChild(wrapper);
  requestAnimationFrame(() => {
    attachFrozenManager(table, 'catalog');
    // ── Восстанавливаем позицию скролла после рендера ──
    if (scrollEl && savedScroll > 0) scrollEl.scrollTop = savedScroll;
  });

  updateProductCount(products.length, state.products.length);
}

export function openCatalog(onView, onEdit, onDelete) {
  if (typeof onDelete === 'undefined') {
    onViewCallback   = null;
    onEditCallback   = onView;
    onDeleteCallback = onEdit;
  } else {
    onViewCallback   = onView;
    onEditCallback   = onEdit;
    onDeleteCallback = onDelete;
  }

  const overlay = $('catalogModal');
  if (!overlay) return;

  // Show the inner panel (hidden by default to prevent click-through)
  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');

  updateFilterOptions();
  renderCatalogTable();
  overlay.classList.add('open');
}

export function closeCatalog() {
  const overlay = $('catalogModal');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.querySelector('.catalog-panel')?.classList.add('hidden');
}

export function updateCatalogBadge() {
  const badge = $('catalogBadge');
  if (!badge) return;

  const count = state.products.length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}
