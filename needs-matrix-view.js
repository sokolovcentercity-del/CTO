/**
 * Needs Matrix View — сводная таблица потребностей.
 * Виртуализация: первые 50 строк сразу, по 50 при скролле к низу.
 * Режим «по программам» — тоже виртуализация по 50 строк.
 * Фильтр по получателям, категории, товарной группе, поиску.
 */

import { $, el, clearChildren } from './dom.js';
import { state, updateRecipientNeeds, getRecipientById, getLotNumbersForProduct, hasProductColorVariants, getProductColorVariants, normalizeNeedEntry, getProductVariantByKey, getContractItemCodesForProduct, getFullVariantCodesForProduct, getRecipientAddresses, getRecipientNeedMetrics, normalizeRecipientAddressNeeds, normalizeRecipientAddressNeedKey } from '../state.js';
import { saveToStorage } from '../storage.js';
import { loadXLSX } from './lib-loader.js';
import { openProductForm } from './product-form.js';
import { enhancePredictiveInput } from './filters.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── State ───────────────────────────────────────────────────────
let filterText        = '';
let filterCategory    = '';
let filterGroup       = '';
let filterRecipients  = new Set(); // пустой = показать всех
let sortField         = '';
let sortDir           = 1;
let groupMode         = 'all'; // 'all' | 'program'

let _lastProducts  = [];
let _lastRecipients = [];
let _needsMatrixSyncBound = false;
let _needsMatrixPending = new Map();
let _needsMatrixDirty = false;

function buildPendingKey(recipientId, productId, address = '', variantKey = '') {
  return [
    String(recipientId || ''),
    String(productId || ''),
    String(address || '').trim(),
    String(variantKey || '').trim(),
  ].join('::');
}

function getPendingQty(recipientId, productId, address = '', variantKey = '') {
  const key = buildPendingKey(recipientId, productId, address, variantKey);
  return _needsMatrixPending.has(key) ? _needsMatrixPending.get(key) : null;
}

function setPendingQty(recipientId, productId, address = '', variantKey = '', qty = 0) {
  const key = buildPendingKey(recipientId, productId, address, variantKey);
  _needsMatrixPending.set(key, Math.max(0, Number(qty) || 0));
  _needsMatrixDirty = true;
  updateNeedsMatrixSaveButton();
}

function syncVisibleInputsToPending() {
  document.querySelectorAll('input[data-product-id][data-recipient-id]').forEach((input) => {
    const productId = Number(input.dataset.productId || 0);
    const recipientId = Number(input.dataset.recipientId || 0);
    const address = String(input.dataset.address || '').trim();
    const variantKey = String(input.dataset.variantKey || '').trim();
    if (!productId || !recipientId) return;
    const qty = Math.max(0, parseInt(String(input.value || '').trim(), 10) || 0);
    setPendingQty(recipientId, productId, address, variantKey, qty);
  });
}

function clearPendingChanges() {
  _needsMatrixPending.clear();
  _needsMatrixDirty = false;
  updateNeedsMatrixSaveButton();
}

function updateNeedsMatrixSaveButton() {
  const btn = document.getElementById('needsMatrixSaveBtn');
  if (!btn) return;
  btn.disabled = !_needsMatrixDirty;
  btn.classList.toggle('opacity-50', !_needsMatrixDirty);
  btn.classList.toggle('cursor-not-allowed', !_needsMatrixDirty);
  btn.innerHTML = _needsMatrixDirty
    ? `💾 ${t('needsMatrix.saveChanges')}`
    : `✓ ${t('needsMatrix.savedState')}`;
}

function getRenderedProducts() {
  return Array.isArray(_lastProducts) && _lastProducts.length
    ? _lastProducts
    : applyFilters([...state.products].sort((a, b) => (a.number || 0) - (b.number || 0)));
}

function getRenderedRecipients() {
  return Array.isArray(_lastRecipients) && _lastRecipients.length
    ? _lastRecipients
    : getFilteredRecipients();
}

function formatContractCodes(codes = []) {
  return [...new Set((codes || []).map(code => String(code || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function getColorSummaryTotals(entry, product) {
  const normalized = normalizeNeedEntry(entry, product);
  if (!hasProductColorVariants(product)) {
    return {
      qty: Number(normalized.qty) || 0,
      delivered: Number(normalized.delivered) || 0,
      assembled: Number(normalized.assembled) || 0,
    };
  }

  const variants = Object.values(normalized.variants || {});
  return {
    qty: variants.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
    delivered: variants.reduce((sum, item) => sum + (Number(item.delivered) || 0), 0),
    assembled: variants.reduce((sum, item) => sum + (Number(item.assembled) || 0), 0),
  };
}

function getRowQtyForRecipient(recipient, rowData, address = '') {
  const product = rowData.product;
  if (!product || !recipient) return 0;

  if (rowData.isVariant) {
    const metrics = getRecipientNeedMetrics(recipient, {
      productId: product.id,
      variantId: rowData.variantKey,
      colorCode: rowData.colorCode || '',
      address,
    });
    const pending = getPendingQty(recipient.id, product.id, address, rowData.variantKey);
    return pending !== null ? pending : (Number(metrics.qty) || 0);
  }

  if (hasProductColorVariants(product)) {
    return getProductColorVariants(product).reduce((sum, variant) => {
      const metrics = getRecipientNeedMetrics(recipient, {
        productId: product.id,
        variantId: variant.id,
        colorCode: variant.colorCode || '',
        address,
      });
      const pending = getPendingQty(recipient.id, product.id, address, variant.id);
      return sum + (pending !== null ? pending : (Number(metrics.qty) || 0));
    }, 0);
  }

  const metrics = getRecipientNeedMetrics(recipient, {
    productId: product.id,
    variantId: '',
    colorCode: '',
    address,
  });
  const pending = getPendingQty(recipient.id, product.id, address, '');
  return pending !== null ? pending : (Number(metrics.qty) || 0);
}

function getRowTotalForColumns(rowData, cols) {
  return (cols || []).reduce((sum, col) => sum + getRowQtyForRecipient(col.recipient, rowData, col.address || ''), 0);
}

function buildMatrixRows(products) {
  return (products || []).flatMap(product => {
    const baseCodes = formatContractCodes(getContractItemCodesForProduct(product.id, product.name || ''));
    if (!hasProductColorVariants(product)) {
      return [{
        rowKey: `product:${product.id}`,
        product,
        rowType: 'single',
        isSummary: false,
        isVariant: false,
        variantKey: '',
        colorCode: '',
        codeList: baseCodes,
        codeText: baseCodes.join(', '),
        label: product.name || '—',
      }];
    }

    const variants = getProductColorVariants(product);
    const summaryCodes = formatContractCodes(
      variants.flatMap(variant => getFullVariantCodesForProduct(product.id, product.name || '', variant.colorCode || ''))
    );
    const summaryRow = {
      rowKey: `product:${product.id}:summary`,
      product,
      rowType: 'summary',
      isSummary: true,
      isVariant: false,
      variantKey: '',
      colorCode: '',
      codeList: summaryCodes,
      codeText: summaryCodes.join(', '),
      label: product.name || '—',
    };

    const variantRows = variants.map(variant => ({
      rowKey: `product:${product.id}:variant:${variant.id}`,
      product,
      rowType: 'variant',
      isSummary: false,
      isVariant: true,
      variantKey: variant.id,
      colorCode: variant.colorCode || '',
      codeList: formatContractCodes(getFullVariantCodesForProduct(product.id, product.name || '', variant.colorCode || '')),
      codeText: formatContractCodes(getFullVariantCodesForProduct(product.id, product.name || '', variant.colorCode || '')).join(', '),
      label: `в том числе: ${variant.colorCode || '—'}`,
    }));

    return [summaryRow, ...variantRows];
  });
}

// ─── Ширины фиксированных столбцов ───────────────────────────────
const LEFT_COLS = [
  { key: 'number',       label: () => t('needsMatrix.colNumber'),      w: 50  },
  { key: 'code',         label: () => t('needs.col.code'),             w: 170 },
  { key: 'name',         label: () => t('needsMatrix.colProduct'),      w: 200 },
  { key: 'category',     label: () => t('needsMatrix.colCategory'),     w: 130 },
  { key: 'lotNumbers',   label: () => t('needs.col.lotNumbers'),        w: 150 },
  { key: 'productGroup', label: () => t('needsMatrix.colProductGroup'), w: 130 },
];
const TOTAL_COL_WIDTH = 90;
const CHUNK_SIZE = 50;

const _leftOffsets = (() => {
  const offsets = [];
  let off = 0;
  LEFT_COLS.forEach(lc => { offsets.push(off); off += lc.w; });
  return offsets;
})();
const _totalColLeft = LEFT_COLS.reduce((s, lc) => s + lc.w, 0);

// ─── Public API ──────────────────────────────────────────────────

export function renderNeedsMatrix(containerId = 'needsMatrixWrap') {
  const wrap = $(containerId);
  if (!wrap) return;

  if (!_needsMatrixSyncBound) {
    window.addEventListener('recipient-needs-changed', (event) => {
      if (event?.detail?.source === 'needs-matrix') return;
      const modal = $('needsMatrixModal');
      if (!modal?.classList.contains('open')) return;
      requestAnimationFrame(() => renderNeedsMatrix(containerId));
    });
    _needsMatrixSyncBound = true;
  }

  // Найти или создать tableArea (после фильтр-бара)
  let tableArea = wrap.querySelector('.needs-table-area');
  if (!tableArea) {
    tableArea = document.createElement('div');
    tableArea.className = 'needs-table-area';
    tableArea.style.cssText = 'flex:1 1 0;min-height:0;overflow:hidden;display:flex;flex-direction:column;';
    wrap.appendChild(tableArea);
  }
  clearChildren(tableArea);

  const products   = state.products;

  if (products.length === 0 && state.recipients.length === 0) {
    tableArea.appendChild(emptyState('📊', t('needsMatrix.noData'), t('needsMatrix.noDataHint')));
    return;
  }
  if (products.length === 0) {
    tableArea.appendChild(emptyState('📋', t('needsMatrix.noProducts'), t('needsMatrix.noProductsHint')));
    return;
  }
  if (state.recipients.length === 0) {
    tableArea.appendChild(emptyState('👥', t('needsMatrix.noRecipients'), t('needsMatrix.noRecipientsHint')));
    return;
  }

  const sortedProducts = applyFilters([...products].sort((a, b) => (a.number || 0) - (b.number || 0)));
  const matrixRows = buildMatrixRows(sortedProducts);
  const recipients = getFilteredRecipients();
  _lastProducts    = sortedProducts;
  _lastRecipients  = recipients;

  if (recipients.length === 0) {
    tableArea.appendChild(emptyState('👥', 'Получатели не выбраны', 'Выберите получателей в фильтре выше'));
    return;
  }

  if (groupMode === 'program') {
    renderGroupedByProgram(tableArea, sortedProducts, matrixRows, recipients);
  } else {
    renderFlat(tableArea, sortedProducts, matrixRows, recipients);
  }
}

export function setGroupMode(mode) { groupMode = mode; }
export function getGroupMode()     { return groupMode; }

// ─── Excel Export ─────────────────────────────────────────────────

export async function exportNeedsMatrix() {
  const btn = document.getElementById('needsExportBtn');
  const origHTML = btn ? btn.innerHTML : '';
  if (btn) { btn.disabled = true; btn.innerHTML = '<span>⏳</span><span>Экспорт…</span>'; }
  try {
    const XLSX = await loadXLSX();
    const products   = applyFilters([...state.products].sort((a, b) => (a.number || 0) - (b.number || 0)));
    const matrixRows = buildMatrixRows(products);
    const recipients = getFilteredRecipients();
    const cols       = buildRecipientColumns(recipients);
    const spans      = buildRecipientSpans(cols);

    const row1 = ['№', 'Код', 'Наименование', 'Категория', 'Номера лотов', 'Товарная группа', 'Итого'];
    spans.forEach(({ recipient: r, span }) => {
      row1.push(r.name);
      for (let i = 1; i < span; i++) row1.push('');
    });
    const row2 = ['', '', '', '', '', '', ''];
    cols.forEach(col => row2.push(col.address || ''));
    const row3 = ['', '', '', '', '', '', ''];
    spans.forEach(({ recipient: r, span }) => {
      row3.push((r.targetProgram || '').trim() || '');
      for (let i = 1; i < span; i++) row3.push('');
    });
    const row4 = ['', '', '', '', '', '', 'Итого'];
    cols.forEach(col => {
      let colTotal = 0;
      products.forEach(p => { colTotal += getQty(col.recipient, p.id, col.address || ''); });
      row4.push(colTotal > 0 ? colTotal : '');
    });

    const ws_data = [row1, row2, row3, row4];
    matrixRows.forEach(row => {
      let rowTotal = 0;
      const qtyArr = [];
      cols.forEach(col => {
        const qty = getRowQtyForRecipient(col.recipient, row, col.address || '');
        rowTotal += qty;
        qtyArr.push(qty > 0 ? qty : '');
      });
      ws_data.push([
        row.isVariant ? '' : (row.product.number || ''),
        row.codeText || '',
        row.isSummary ? `${row.product.name || ''} (всего)` : (row.isVariant ? row.label : (row.product.name || '')),
        row.product.category || '',
        getLotNumbersForProduct(row.product.id, row.product.name || '').join(', '),
        row.product.productGroup || '',
        rowTotal > 0 ? rowTotal : '',
        ...qtyArr,
      ]);
    });

    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!cols'] = [
      { wch: 5 }, { wch: 22 }, { wch: 35 }, { wch: 20 }, { wch: 18 }, { wch: 22 }, { wch: 9 },
      ...cols.map(() => ({ wch: 12 })),
    ];
    const merges = [];
    let colIdx = 7;
    spans.forEach(({ span }) => {
      if (span > 1) {
        merges.push({ s: { r: 0, c: colIdx }, e: { r: 0, c: colIdx + span - 1 } });
        merges.push({ s: { r: 2, c: colIdx }, e: { r: 2, c: colIdx + span - 1 } });
      }
      colIdx += span;
    });
    if (merges.length) ws['!merges'] = merges;
    XLSX.utils.book_append_sheet(wb, ws, 'Потребность');
    const dateStr = new Date().toISOString().slice(0, 10);
    XLSX.writeFile(wb, `needs-matrix-${dateStr}.xlsx`);
    try { (await import('./toast.js')).showToast('✅ Файл экспортирован', 'success'); } catch { /**/ }
  } catch (err) {
    console.error('[needs-matrix] export error:', err);
    try { (await import('./toast.js')).showToast('❌ Ошибка экспорта: ' + (err?.message || err), 'error'); } catch { /**/ }
  } finally {
    if (btn) { btn.disabled = false; btn.innerHTML = origHTML; }
  }
}

// ─── Filters bar ─────────────────────────────────────────────────

export function renderFiltersBar(containerId = 'needsMatrixWrap') {
  const wrap = $(containerId);
  if (!wrap) return;

  const existing = wrap.querySelector('.needs-filter-bar');
  if (existing) {
    // обновить значения без пересоздания
    const inp = existing.querySelector('input[data-role=search]');
    if (inp) inp.value = filterText;
    _updateSelectOptions(existing);
    _updateRecipientFilter(existing, containerId);
    updateNeedsMatrixSaveButton();
    return;
  }

  const bar = document.createElement('div');
  bar.className = 'needs-filter-bar';
  bar.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.5rem;padding:0.6rem 1rem;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(2,6,23,0.7);flex-shrink:0;align-items:center;';

  // ── Поиск по товару ──
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'position:relative;flex:1;min-width:160px;max-width:240px;';
  const searchIcon = document.createElement('span');
  searchIcon.textContent = '🔍';
  searchIcon.style.cssText = 'position:absolute;left:0.65rem;top:50%;transform:translateY(-50%);pointer-events:none;font-size:0.75rem;';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.dataset.role = 'search';
  searchInput.setAttribute('list', 'needs-matrix-search-options');
  searchInput.placeholder = 'Поиск по товару…';
  searchInput.value = filterText;
  searchInput.setAttribute('aria-label', 'Поиск по товару');
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.65rem;padding:0.45rem 0.75rem 0.45rem 2rem;font-size:0.78rem;color:#fff;outline:none;';
  let _debounce = null;
  searchInput.addEventListener('input', () => {
    clearTimeout(_debounce);
    _debounce = setTimeout(() => {
      filterText = searchInput.value;
      requestAnimationFrame(() => renderNeedsMatrix(containerId));
      _updateSelectOptions(bar);
    }, 300);
  });
  searchWrap.append(searchIcon, searchInput);
  searchWrap.appendChild(_buildDatalist('needs-matrix-search-options', getProductSearchSuggestions(state.products)));
  bar.appendChild(searchWrap);

  // ── Категория ──
  const catWrap = _buildPredictiveInput('cat-sel', 'Все категории', 'needs-matrix-cat-options', getUniqueValues('category', state.products), filterCategory);
  const catSel = catWrap.querySelector('input');
  catSel?.setAttribute('aria-label', 'Фильтр по категории');
  catSel?.addEventListener('input', () => {
    filterCategory = catSel.value;
    requestAnimationFrame(() => renderNeedsMatrix(containerId));
  });
  bar.appendChild(catWrap);

  // ── Товарная группа ──
  const grpWrap = _buildPredictiveInput('grp-sel', 'Все группы', 'needs-matrix-group-options', getUniqueValues('productGroup', state.products), filterGroup);
  const grpSel = grpWrap.querySelector('input');
  grpSel?.setAttribute('aria-label', 'Фильтр по товарной группе');
  grpSel?.addEventListener('input', () => {
    filterGroup = grpSel.value;
    requestAnimationFrame(() => renderNeedsMatrix(containerId));
  });
  bar.appendChild(grpWrap);

  // ── Фильтр по получателям ──
  const recWrap = _buildRecipientFilterUI(containerId);
  bar.appendChild(recWrap);

  // ── Сброс фильтров ──
  const resetBtn = document.createElement('button');
  resetBtn.textContent = '✕ Сброс';
  resetBtn.setAttribute('aria-label', 'Сбросить фильтры');
  resetBtn.style.cssText = 'background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:0.65rem;padding:0.45rem 0.75rem;font-size:0.78rem;color:rgb(148,163,184);cursor:pointer;white-space:nowrap;flex-shrink:0;';
  resetBtn.addEventListener('click', () => {
    filterText       = '';
    filterCategory   = '';
    filterGroup      = '';
    filterRecipients = new Set();
    searchInput.value = '';
    catSel.value = '';
    grpSel.value = '';
    _updateRecipientFilter(bar, containerId);
    requestAnimationFrame(() => renderNeedsMatrix(containerId));
  });
  bar.appendChild(resetBtn);

  const saveBtn = document.createElement('button');
  saveBtn.id = 'needsMatrixSaveBtn';
  saveBtn.type = 'button';
  saveBtn.style.cssText = 'background:rgba(34,211,238,0.12);border:1px solid rgba(34,211,238,0.25);border-radius:0.65rem;padding:0.45rem 0.85rem;font-size:0.78rem;font-weight:600;color:rgb(165,243,252);cursor:pointer;white-space:nowrap;flex-shrink:0;';
  saveBtn.addEventListener('click', async () => {
    await persistNeedsMatrixChanges();
  });
  bar.appendChild(saveBtn);

  const tableArea = wrap.querySelector('.needs-table-area');
  wrap.insertBefore(bar, tableArea || wrap.firstChild);
  updateNeedsMatrixSaveButton();

  enhancePredictiveInput(searchInput, {
    listId: 'needs-matrix-search-options',
    options: getProductSearchSuggestions(state.products),
    icon: '🔍',
    minWidth: '180px',
  });
  searchIcon.remove();
  enhancePredictiveInput(catSel, {
    listId: 'needs-matrix-cat-options',
    options: getUniqueValues('category', state.products),
    icon: '🏷️',
    minWidth: '150px',
  });
  enhancePredictiveInput(grpSel, {
    listId: 'needs-matrix-group-options',
    options: getUniqueValues('productGroup', state.products),
    icon: '📂',
    minWidth: '150px',
  });
}

// ── Фильтр по получателям ──────────────────────────────────────

function _buildRecipientFilterUI(containerId) {
  const wrap = document.createElement('div');
  wrap.dataset.role = 'rec-filter-wrap';
  wrap.style.cssText = 'position:relative;flex-shrink:0;';

  const btn = document.createElement('button');
  btn.dataset.role = 'rec-filter-btn';
  btn.setAttribute('aria-label', 'Фильтр по получателям');
  btn.style.cssText = 'display:flex;align-items:center;gap:0.4rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.65rem;padding:0.45rem 0.75rem;font-size:0.78rem;color:rgb(203,213,225);cursor:pointer;white-space:nowrap;';
  btn.innerHTML = '<span>👥</span><span data-role="rec-btn-label">Получатели</span>';
  wrap.appendChild(btn);

  const dropdown = document.createElement('div');
  dropdown.dataset.role = 'rec-dropdown';
  dropdown.style.cssText = 'display:none;position:absolute;top:calc(100% + 4px);left:0;z-index:200;min-width:280px;max-width:360px;background:rgb(15,23,42);border:1px solid rgba(255,255,255,0.12);border-radius:0.75rem;box-shadow:0 8px 32px rgba(0,0,0,0.5);padding:0.5rem;';

  // Поиск внутри дропдауна
  const ddSearch = document.createElement('input');
  ddSearch.type = 'search';
  ddSearch.placeholder = 'Поиск получателя…';
  ddSearch.setAttribute('aria-label', 'Поиск получателя');
  ddSearch.style.cssText = 'width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;padding:0.4rem 0.65rem;font-size:0.78rem;color:#fff;outline:none;margin-bottom:0.4rem;';
  dropdown.appendChild(ddSearch);

  // Кнопки выбрать всё / снять всё
  const ddActions = document.createElement('div');
  ddActions.style.cssText = 'display:flex;gap:0.4rem;margin-bottom:0.4rem;';
  const selAllBtn = document.createElement('button');
  selAllBtn.textContent = 'Выбрать все';
  selAllBtn.style.cssText = 'flex:1;background:rgba(34,211,238,0.1);border:1px solid rgba(34,211,238,0.2);border-radius:0.5rem;padding:0.3rem 0.5rem;font-size:0.72rem;color:rgb(34,211,238);cursor:pointer;';
  const clearAllBtn = document.createElement('button');
  clearAllBtn.textContent = 'Снять все';
  clearAllBtn.style.cssText = 'flex:1;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;padding:0.3rem 0.5rem;font-size:0.72rem;color:rgb(148,163,184);cursor:pointer;';
  ddActions.append(selAllBtn, clearAllBtn);
  dropdown.appendChild(ddActions);

  // Список получателей
  const list = document.createElement('div');
  list.dataset.role = 'rec-list';
  list.style.cssText = 'max-height:220px;overflow-y:auto;display:flex;flex-direction:column;gap:0.15rem;';
  dropdown.appendChild(list);

  wrap.appendChild(dropdown);

  function buildList(searchQ) {
    clearChildren(list);
    const q = (searchQ || '').toLowerCase();
    const recipients = state.recipients.filter(r =>
      !q || (r.name || '').toLowerCase().includes(q)
    );
    recipients.forEach(r => {
      const item = document.createElement('label');
      item.style.cssText = 'display:flex;align-items:center;gap:0.5rem;padding:0.35rem 0.5rem;border-radius:0.4rem;cursor:pointer;transition:background 0.1s;';
      item.addEventListener('mouseenter', () => { item.style.background = 'rgba(255,255,255,0.05)'; });
      item.addEventListener('mouseleave', () => { item.style.background = ''; });
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = filterRecipients.size === 0 ? true
        : filterRecipients.has(-1) ? false
        : filterRecipients.has(r.id);
      cb.style.cssText = 'accent-color:rgb(34,211,238);flex-shrink:0;width:14px;height:14px;cursor:pointer;';
      const nameSpan = document.createElement('span');
      nameSpan.style.cssText = 'font-size:0.78rem;color:rgb(203,213,225);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
      nameSpan.textContent = r.name || '—';
      nameSpan.title = r.name || '';
      item.append(cb, nameSpan);
      cb.addEventListener('change', () => {
        if (filterRecipients.size === 0) {
          // Был «все» — переключаемся в режим явного выбора
          state.recipients.forEach(rec => filterRecipients.add(rec.id));
        } else if (filterRecipients.has(-1)) {
          // Был «снять все» — начинаем с пустого явного выбора
          filterRecipients = new Set();
        }
        if (cb.checked) {
          filterRecipients.add(r.id);
        } else {
          filterRecipients.delete(r.id);
        }
        // Если выбраны все — вернуться к «все»
        if (filterRecipients.size >= state.recipients.length) filterRecipients = new Set();
        _updateRecipientBtnLabel(wrap);
        requestAnimationFrame(() => renderNeedsMatrix(containerId));
      });
      list.appendChild(item);
    });
    if (recipients.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'font-size:0.75rem;color:rgb(100,116,139);padding:0.5rem;text-align:center;';
      empty.textContent = 'Не найдено';
      list.appendChild(empty);
    }
  }

  selAllBtn.addEventListener('click', () => {
    filterRecipients = new Set(); // пустой = все
    buildList(ddSearch.value);
    _updateRecipientBtnLabel(wrap);
    requestAnimationFrame(() => renderNeedsMatrix(containerId));
  });
  clearAllBtn.addEventListener('click', () => {
    // Снять все = filterRecipients содержит пустой Set, но getFilteredRecipients вернёт []
    // Используем специальный маркер: Set с несуществующим id
    filterRecipients = new Set([-1]); // -1 не совпадёт ни с одним recipient.id
    buildList(ddSearch.value);
    _updateRecipientBtnLabel(wrap);
    requestAnimationFrame(() => renderNeedsMatrix(containerId));
  });

  ddSearch.addEventListener('input', () => buildList(ddSearch.value));

  // Открыть/закрыть дропдаун
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const isOpen = dropdown.style.display !== 'none';
    if (isOpen) {
      dropdown.style.display = 'none';
    } else {
      buildList('');
      ddSearch.value = '';
      dropdown.style.display = 'block';
      setTimeout(() => ddSearch.focus(), 50);
    }
  });

  // Закрыть при клике вне
  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) dropdown.style.display = 'none';
  });

  _updateRecipientBtnLabel(wrap);
  return wrap;
}

function _updateRecipientBtnLabel(wrap) {
  const label = wrap.querySelector('[data-role=rec-btn-label]');
  if (!label) return;
  if (filterRecipients.size === 0) {
    label.textContent = 'Получатели';
  } else if (filterRecipients.has(-1)) {
    label.textContent = 'Получатели (0)';
  } else {
    label.textContent = `Получатели (${filterRecipients.size})`;
  }
}

function _updateRecipientFilter(bar, containerId) {
  const wrap = bar.querySelector('[data-role=rec-filter-wrap]');
  if (wrap) _updateRecipientBtnLabel(wrap);
}

// ── Получатели с учётом фильтра ────────────────────────────────

function getFilteredRecipients() {
  if (filterRecipients.size === 0) return state.recipients; // пустой = все
  if (filterRecipients.has(-1)) return []; // «снять все» маркер
  return state.recipients.filter(r => filterRecipients.has(r.id));
}

// ─── Select helpers ───────────────────────────────────────────────

function _buildPredictiveInput(className, placeholder, listId, options, value) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'position:relative;display:flex;flex-direction:column;gap:0;';

  const input = document.createElement('input');
  input.type = 'search';
  input.className = className;
  input.value = value || '';
  input.placeholder = placeholder;
  input.setAttribute('list', listId);
  input.style.cssText = 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.65rem;padding:0.45rem 0.65rem;font-size:0.78rem;color:rgb(203,213,225);min-width:130px;outline:none;flex-shrink:0;';

  wrap.appendChild(input);
  wrap.appendChild(_buildDatalist(listId, options));
  return wrap;
}

function _buildDatalist(id, options) {
  const list = document.createElement('datalist');
  list.id = id;
  options.forEach(o => {
    const opt = document.createElement('option');
    opt.value = o;
    list.appendChild(opt);
  });
  return list;
}

function getProductSearchSuggestions(products) {
  const values = [];
  const seen = new Set();
  (products || []).forEach(p => {
    const name = String(p?.name || '').trim();
    const codes = getContractItemCodesForProduct(p?.id, p?.name || '');
    const primaryCode = String(codes[0] || '').trim();
    const pair = name && primaryCode ? `${name} — ${primaryCode}` : (name || primaryCode);
    [pair, name, ...codes].filter(Boolean).forEach(value => {
      const key = String(value).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      values.push(String(value));
    });
  });
  return values.sort((a, b) => a.localeCompare(b, 'ru'));
}

function _updateSelectOptions(bar) {
  const searchList = bar.querySelector('#needs-matrix-search-options');
  const catList = bar.querySelector('#needs-matrix-cat-options');
  const grpList = bar.querySelector('#needs-matrix-group-options');

  if (searchList) {
    clearChildren(searchList);
    getProductSearchSuggestions(state.products).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      searchList.appendChild(opt);
    });
  }

  if (catList) {
    clearChildren(catList);
    getUniqueValues('category', state.products).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      catList.appendChild(opt);
    });
  }

  if (grpList) {
    clearChildren(grpList);
    getUniqueValues('productGroup', state.products).forEach(o => {
      const opt = document.createElement('option');
      opt.value = o;
      grpList.appendChild(opt);
    });
  }
}

// ─── Filter helpers ───────────────────────────────────────────────

function applyFilters(products) {
  let result = products;
  const q = filterText.trim().toLowerCase();
  if (q) result = result.filter(p => {
    const baseCodes = getContractItemCodesForProduct(p.id, p.name || '').join(' ').toLowerCase();
    const variantBits = hasProductColorVariants(p)
      ? getProductColorVariants(p).map(v => v.colorCode || '').join(' ').toLowerCase()
      : '';
    return (p.name || '').toLowerCase().includes(q)
      || baseCodes.includes(q)
      || variantBits.includes(q);
  });
  if (filterCategory) {
    const fc = filterCategory.trim().toLowerCase();
    result = result.filter(p => (p.category || '').toLowerCase().includes(fc));
  }
  if (filterGroup) {
    const fg = filterGroup.trim().toLowerCase();
    result = result.filter(p => (p.productGroup || '').toLowerCase().includes(fg));
  }
  if (sortField) {
    result = [...result].sort((a, b) => {
      const va = (a[sortField] || '').toLowerCase();
      const vb = (b[sortField] || '').toLowerCase();
      return va < vb ? -sortDir : va > vb ? sortDir : 0;
    });
  }
  return result;
}

function getUniqueValues(field, products) {
  const set = new Set();
  (products || []).forEach(p => { if (p[field]) set.add(p[field]); });
  return [...set].sort((a, b) => a.localeCompare(b));
}

// ─── Helpers ─────────────────────────────────────────────────────

function emptyState(icon, title, hint) {
  return el('div', { className: 'flex flex-col items-center justify-center py-16 text-center' },
    el('span', { className: 'text-4xl mb-3' }, icon),
    el('p',    { className: 'text-sm font-semibold text-slate-300 mb-1' }, title),
    el('p',    { className: 'text-xs text-slate-500' }, hint),
  );
}

function getQty(recipient, productId, address = '') {
  const product = state.products.find(p => p.id === productId) || null;
  if (!product) {
    const metrics = getRecipientNeedMetrics(recipient, { productId, address });
    const pending = getPendingQty(recipient?.id, productId, address, '');
    return pending !== null ? pending : (Number(metrics.qty) || 0);
  }

  if (hasProductColorVariants(product)) {
    return getProductColorVariants(product).reduce((sum, variant) => {
      const metrics = getRecipientNeedMetrics(recipient, {
        productId,
        address,
        variantId: variant.id,
        colorCode: variant.colorCode || '',
      });
      const pending = getPendingQty(recipient?.id, productId, address, variant.id);
      return sum + (pending !== null ? pending : (Number(metrics.qty) || 0));
    }, 0);
  }

  const metrics = getRecipientNeedMetrics(recipient, { productId, address });
  const pending = getPendingQty(recipient?.id, productId, address, '');
  return pending !== null ? pending : (Number(metrics.qty) || 0);
}

function buildRecipientColumns(recipients) {
  const cols = [];
  recipients.forEach(r => {
    const addresses = getRecipientAddresses(r);
    if (addresses.length === 0) {
      cols.push({ recipient: r, address: '' });
      return;
    }
    addresses.forEach(addr => cols.push({ recipient: r, address: addr }));
  });
  return cols;
}

function buildRecipientSpans(cols) {
  const spans = [];
  let i = 0;
  while (i < cols.length) {
    const r = cols[i].recipient;
    const start = i;
    while (i < cols.length && cols[i].recipient.id === r.id) i++;
    spans.push({ recipient: r, span: i - start });
  }
  return spans;
}

// ─── Общий scroll-контейнер ───────────────────────────────────────
// overflow:auto по обеим осям — горизонтальная прокрутка работает

function makeScrollWrap() {
  const wrap = document.createElement('div');
  wrap.style.cssText = [
    'flex:1 1 0',
    'min-height:0',
    'overflow-x:scroll',
    'overflow-y:auto',
    'scrollbar-gutter:stable',
    '-webkit-overflow-scrolling:touch',
  ].join(';');
  wrap.scrollTop  = 0;
  wrap.scrollLeft = 0;
  return wrap;
}

// ─── Flat render с виртуализацией ────────────────────────────────

function renderFlat(tableArea, sortedProducts, matrixRows, recipients) {
  // Единый контейнер — горизонтальный + вертикальный скролл
  const scrollWrap = makeScrollWrap();

  const cols  = buildRecipientColumns(recipients);
  const spans = buildRecipientSpans(cols);

  const { table, tbody } = buildTableHead(cols, spans, sortedProducts, 'all');

  appendChunk(tbody, matrixRows, cols, 'all', 0, Math.min(CHUNK_SIZE, matrixRows.length));

  let nextIndex = Math.min(CHUNK_SIZE, matrixRows.length);

  const observer = new IntersectionObserver((entries) => {
    if (!entries[0].isIntersecting) return;
    if (nextIndex >= matrixRows.length) { observer.disconnect(); return; }
    const end = Math.min(nextIndex + CHUNK_SIZE, matrixRows.length);
    appendChunk(tbody, matrixRows, cols, 'all', nextIndex, end);
    nextIndex = end;
    if (nextIndex >= matrixRows.length) { observer.disconnect(); }
  }, { root: null, threshold: 0 });

  const wrapper = document.createElement('div');
  wrapper.style.cssText = 'padding:1rem 1.25rem;min-width:max-content;';
  wrapper.appendChild(table);
  scrollWrap.appendChild(wrapper);

  // Sentinel внутри wrapper — следит за вертикальным скроллом внутри scrollWrap
  const sentinel = makeSentinel();
  wrapper.appendChild(sentinel);
  observer.observe(sentinel);

  tableArea.appendChild(scrollWrap);
}

// ─── Grouped by program render ────────────────────────────────────

function renderGroupedByProgram(tableArea, sortedProducts, matrixRows, recipients) {
  const programMap = new Map();
  const noProgram  = t('needsMatrix.noProgram');

  recipients.forEach(r => {
    const prog = (r.targetProgram || '').trim() || noProgram;
    if (!programMap.has(prog)) programMap.set(prog, []);
    programMap.get(prog).push(r);
  });

  const programNames = [...programMap.keys()].sort((a, b) => {
    if (a === noProgram) return 1;
    if (b === noProgram) return -1;
    return a.localeCompare(b);
  });

  // Внешний скролл-контейнер — вертикальный (список секций)
  const outerScroll = document.createElement('div');
  outerScroll.style.cssText = 'flex:1 1 0;min-height:0;overflow-y:auto;padding:1rem 1.25rem;display:flex;flex-direction:column;gap:1.5rem;scrollbar-gutter:stable;';

  programNames.forEach(progName => {
    const progRecipients = programMap.get(progName);
    const section = document.createElement('div');
    section.style.cssText = 'border-radius:1rem;border:1px solid rgba(255,255,255,0.1);overflow:hidden;flex-shrink:0;';

    // Заголовок секции
    const header = document.createElement('div');
    header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;background:rgba(255,255,255,0.04);border-bottom:1px solid rgba(255,255,255,0.1);';
    const titleWrap = document.createElement('div');
    titleWrap.style.cssText = 'display:flex;align-items:center;gap:0.5rem;min-width:0;';
    titleWrap.innerHTML = `<span>🎯</span><span style="font-size:0.875rem;font-weight:700;color:#fff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${progName}</span>
      <span style="flex-shrink:0;border-radius:0.5rem;background:rgba(71,85,105,0.5);padding:0.1rem 0.5rem;font-size:0.75rem;font-weight:600;color:rgb(203,213,225);">${progRecipients.length} ${recipientsWord(progRecipients.length)}</span>`;
    header.appendChild(titleWrap);

    const progTotal = calcGroupTotal(sortedProducts, progRecipients);
    const badge = document.createElement('span');
    badge.style.cssText = 'flex-shrink:0;border-radius:0.5rem;background:rgba(34,211,238,0.15);padding:0.25rem 0.625rem;font-size:0.75rem;font-weight:700;color:rgb(34,211,238);';
    badge.dataset.programTotalBadge = progName;
    badge.textContent = t('needsMatrix.programTotal') + ': ' + progTotal;
    header.appendChild(badge);
    section.appendChild(header);

    const cols  = buildRecipientColumns(progRecipients);
    const spans = buildRecipientSpans(cols);
    const { table, tbody } = buildTableHead(cols, spans, sortedProducts, progName);

    // Горизонтальный скролл внутри секции + виртуализация строк
    const sectionScroll = document.createElement('div');
    sectionScroll.style.cssText = [
      'overflow-x:auto',
      'overflow-y:auto',
      'max-height:60vh',
      'scrollbar-gutter:stable',
      '-webkit-overflow-scrolling:touch',
    ].join(';');

    // Рендерим первый чанк
    appendChunk(tbody, matrixRows, cols, progName, 0, Math.min(CHUNK_SIZE, matrixRows.length));

    const sentinel = makeSentinel();
    let nextIndex = Math.min(CHUNK_SIZE, matrixRows.length);

    const observer = new IntersectionObserver((entries) => {
      if (!entries[0].isIntersecting) return;
      if (nextIndex >= matrixRows.length) { observer.disconnect(); sentinel.remove(); return; }
      const end = Math.min(nextIndex + CHUNK_SIZE, matrixRows.length);
      appendChunk(tbody, matrixRows, cols, progName, nextIndex, end);
      nextIndex = end;
      if (nextIndex >= matrixRows.length) { observer.disconnect(); sentinel.remove(); }
    }, { root: sectionScroll, threshold: 0 });

    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'padding:0 1rem 1rem;min-width:max-content;';
    wrapper.appendChild(table);
    sectionScroll.appendChild(wrapper);
    sectionScroll.appendChild(sentinel);
    observer.observe(sentinel);

    section.appendChild(sectionScroll);
    outerScroll.appendChild(section);
  });

  if (programNames.length > 1) {
    const grandTotal = calcGroupTotal(sortedProducts, recipients);
    const grandRow = document.createElement('div');
    grandRow.dataset.grandTotalWrap = 'true';
    grandRow.style.cssText = 'display:flex;align-items:center;justify-content:space-between;border-radius:1rem;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.03);padding:0.75rem 1rem;flex-shrink:0;';
    grandRow.innerHTML = `<span style="font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgb(148,163,184);">${t('needsMatrix.grandTotal')}</span>
      <span data-grand-total-value="true" style="border-radius:0.5rem;background:rgba(34,211,238,0.2);padding:0.25rem 0.75rem;font-size:0.875rem;font-weight:700;color:rgb(34,211,238);">${grandTotal}</span>`;
    outerScroll.appendChild(grandRow);
  }

  tableArea.appendChild(outerScroll);
}

function makeSentinel() {
  const s = document.createElement('div');
  s.style.cssText = 'height:1px;width:100%;flex-shrink:0;';
  return s;
}

function calcGroupTotal(products, recipients) {
  let total = 0;
  recipients.forEach(r => {
    products.forEach(p => {
      total += getColorSummaryTotals(r.needs?.[p.id], p).qty;
    });
  });
  return total;
}

function recipientsWord(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'получатель';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'получателя';
  return 'получателей';
}

// ─── Добавить чанк строк в tbody ─────────────────────────────────

function appendChunk(tbody, rows, cols, groupKey, fromIdx, toIdx) {
  const end = (toIdx !== undefined) ? toIdx : Math.min(fromIdx + CHUNK_SIZE, rows.length);
  const fragment = document.createDocumentFragment();
  for (let i = fromIdx; i < end; i++) {
    fragment.appendChild(buildProductRow(rows[i], cols, groupKey));
  }
  tbody.appendChild(fragment);
}

// ─── Table head builder ───────────────────────────────────────────

function buildTableHead(cols, spans, sorted, groupKey) {
  const leftOffsets  = _leftOffsets;
  const totalColLeft = _totalColLeft;
  const fixedWidth   = totalColLeft + TOTAL_COL_WIDTH;

  const table = document.createElement('table');
  table.className = 'w-full text-sm border-collapse';
  table.style.minWidth = `${fixedWidth + cols.length * 110}px`;

  const sticky = 'sticky z-10 bg-slate-900';
  const thead = document.createElement('thead');
  thead.style.cssText = 'position:sticky;top:0;z-index:18;';

  // Row 1: фиксированные заголовки (rowspan=4) + Итого + имена
  const row1 = document.createElement('tr');
  LEFT_COLS.forEach((lc, i) => {
    const th = document.createElement('th');
    th.className = `${sticky} px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-white/10 align-middle`;
    th.rowSpan = 4;
    th.style.left   = leftOffsets[i] + 'px';
    th.style.zIndex = '22';
    th.textContent  = lc.label();
    row1.appendChild(th);
  });

  const totalTh = document.createElement('th');
  totalTh.className = `${sticky} px-3 py-2 text-center text-xs font-semibold text-cyan-400 uppercase tracking-wider border-b border-white/10 border-l border-r border-white/15 align-middle`;
  totalTh.rowSpan = 4;
  totalTh.style.left     = totalColLeft + 'px';
  totalTh.style.zIndex   = '22';
  totalTh.style.minWidth = TOTAL_COL_WIDTH + 'px';
  totalTh.textContent    = t('needsMatrix.colTotal');
  row1.appendChild(totalTh);

  spans.forEach(({ recipient: r, span }) => {
    const th = document.createElement('th');
    th.className = 'px-3 py-2 text-center text-xs font-semibold text-slate-300 uppercase tracking-wider border-b border-white/10 border-l border-white/5';
    th.colSpan = span;
    const nameSpan = document.createElement('span');
    nameSpan.className = 'block truncate max-w-[200px] mx-auto';
    nameSpan.title = r.name;
    nameSpan.textContent = r.name;
    th.appendChild(nameSpan);
    row1.appendChild(th);
  });
  thead.appendChild(row1);

  // Row 2: адреса
  const row2 = document.createElement('tr');
  row2.style.cssText = 'position:sticky;top:36px;z-index:17;';
  cols.forEach((col, ci) => {
    const isFirst = ci === 0 || cols[ci - 1].recipient.id !== col.recipient.id;
    const td = document.createElement('td');
    td.className = `px-2 py-1.5 text-[10px] border-b border-white/8 align-middle text-center ${isFirst ? 'border-l border-white/5' : ''} ${col.address ? 'text-slate-400' : 'text-slate-600'}`;
    td.style.background = 'rgb(11,17,34)';
    td.textContent = col.address || '—';
    if (col.address) td.title = col.address;
    row2.appendChild(td);
  });
  thead.appendChild(row2);

  // Row 3: программы
  const row3 = document.createElement('tr');
  row3.style.cssText = 'position:sticky;top:60px;z-index:17;';
  spans.forEach(({ recipient: r, span }) => {
    const td = document.createElement('td');
    td.className = 'px-2 py-1.5 text-[10px] border-b border-white/10 text-center align-middle border-l border-white/5';
    td.colSpan = span;
    td.style.background = 'rgb(9,14,28)';
    const prog = (r.targetProgram || '').trim();
    const programLabel = prog ? formatProgramLabel(getProgramByIdentity(prog) || prog) : '';
    td.textContent = programLabel || '—';
    if (programLabel) { td.title = programLabel; td.classList.add('text-amber-400/80', 'font-medium'); }
    else td.classList.add('text-slate-600');
    row3.appendChild(td);
  });
  thead.appendChild(row3);

  // Row 4: итоги по столбцам
  const row4 = document.createElement('tr');
  row4.style.cssText = 'position:sticky;top:84px;z-index:17;';
  cols.forEach((col, ci) => {
    const r = col.recipient;
    let colTotal = 0;
    sorted.forEach(p => { colTotal += getQty(r, p.id, col.address || ''); });
    const isFirst = ci === 0 || cols[ci - 1].recipient.id !== r.id;
    const td = document.createElement('td');
    td.className = `px-3 py-2 text-center border-b-2 border-white/20 ${isFirst ? 'border-l border-white/5' : ''}`;
    td.style.background = 'rgb(15,23,42)';
    td.dataset.totalColRecipient = String(r.id);
    td.dataset.totalColAddress = col.address || '';
    td.dataset.group    = groupKey;
    const span = document.createElement('span');
    span.className = `text-sm font-bold tabular-nums ${colTotal > 0 ? 'text-cyan-400' : 'text-slate-600'}`;
    span.textContent = colTotal > 0 ? String(colTotal) : '—';
    td.appendChild(span);
    row4.appendChild(td);
  });
  thead.appendChild(row4);

  const tbody = document.createElement('tbody');
  table.appendChild(thead);
  table.appendChild(tbody);

  return { table, tbody };
}

// ─── Single product row builder ───────────────────────────────────

function buildProductRow(rowData, cols, groupKey) {
  const { product, isSummary, isVariant, variantKey, colorCode, codeList, codeText, label, rowKey } = rowData;
  const sticky = 'sticky z-10 bg-slate-900';
  const row = document.createElement('tr');
  row.className = 'group hover:bg-white/[0.03] transition-colors';

  const openProductCard = () => {
    const needsModal = $('needsMatrixModal');
    if (needsModal) {
      needsModal.classList.remove('open');
      needsModal.querySelector('.catalog-panel')?.classList.add('hidden');
    }
    requestAnimationFrame(() => {
      openProductForm(product, null, {
        mode: 'view',
        onClose: () => {
          const modal = $('needsMatrixModal');
          if (!modal) return;
          modal.querySelector('.catalog-panel')?.classList.remove('hidden');
          modal.classList.add('open');
          requestAnimationFrame(() => renderNeedsMatrix('needsMatrixWrap'));
        },
      });
    });
  };

  // №
  const numCell = document.createElement('td');
  numCell.className = `${sticky} group-hover:bg-slate-900/90 px-2 py-2.5 text-xs font-bold text-cyan-400 tabular-nums text-center transition-colors`;
  numCell.style.left = _leftOffsets[0] + 'px'; numCell.style.zIndex = '11';
  numCell.textContent = isVariant ? '' : String(product.number || '');
  row.appendChild(numCell);

  // Код
  const codeCell = document.createElement('td');
  codeCell.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2.5 transition-colors`;
  codeCell.style.left = _leftOffsets[1] + 'px';
  codeCell.style.zIndex = '11';
  codeCell.style.minWidth = '150px';
  codeCell.style.maxWidth = '210px';
  if (codeList?.length) {
    const codeWrap = document.createElement('div');
    codeWrap.style.cssText = 'display:flex;flex-direction:column;gap:0.25rem;';
    codeList.forEach((code) => {
      const badge = document.createElement('span');
      badge.className = 'inline-flex items-center self-start rounded-lg bg-slate-800/70 px-2 py-0.5 text-[10px] text-slate-300 whitespace-nowrap';
      badge.textContent = code;
      badge.title = code;
      codeWrap.appendChild(badge);
    });
    codeCell.appendChild(codeWrap);
  } else {
    codeCell.textContent = '—';
    codeCell.classList.add('text-slate-600', 'text-xs');
  }
  row.appendChild(codeCell);

  // Наименование
  const nameCell = document.createElement('td');
  nameCell.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2.5 transition-colors`;
  nameCell.style.left = _leftOffsets[2] + 'px'; nameCell.style.zIndex = '11';
  nameCell.style.minWidth = '180px'; nameCell.style.maxWidth = '240px';
  const nameSpan = document.createElement('span');
  nameSpan.className = 'text-sm text-white font-medium block truncate cursor-pointer hover:text-cyan-300 transition-colors';
  nameSpan.title = product.name || '';
  nameSpan.textContent = isVariant ? (label || product.name || '—') : (product.name || '—');
  nameSpan.tabIndex = 0;
  nameSpan.setAttribute('role', 'button');
  nameSpan.setAttribute('aria-label', `${t('actions.view')}: ${product.name || product.number || 'товар'}`);
  nameSpan.addEventListener('click', (e) => {
    e.stopPropagation();
    openProductCard();
  });
  nameSpan.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    openProductCard();
  });
  nameCell.appendChild(nameSpan);
  if (isSummary) {
    const badge = document.createElement('span');
    badge.className = 'inline-flex items-center rounded-lg bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300 mt-1';
    badge.textContent = 'всего';
    nameCell.appendChild(badge);
  } else if (isVariant) {
    const badge = document.createElement('span');
    badge.className = 'inline-flex items-center rounded-lg bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 mt-1 ml-4';
    badge.textContent = `RAL ${colorCode || '—'}`;
    nameCell.appendChild(badge);
  }
  row.appendChild(nameCell);

  // Категория
  const catCell = document.createElement('td');
  catCell.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2.5 transition-colors`;
  catCell.style.left = _leftOffsets[3] + 'px'; catCell.style.zIndex = '11';
  catCell.style.minWidth = '110px'; catCell.style.maxWidth = '150px';
  const catSpan = document.createElement('span');
  catSpan.className = 'text-xs text-slate-400 block truncate';
  catSpan.title = product.category || '';
  catSpan.textContent = product.category || '—';
  catCell.appendChild(catSpan);
  row.appendChild(catCell);

  // Номера лотов
  const lotCell = document.createElement('td');
  lotCell.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2.5 transition-colors`;
  lotCell.style.left = _leftOffsets[4] + 'px';
  lotCell.style.zIndex = '11';
  lotCell.style.minWidth = '130px';
  lotCell.style.maxWidth = '180px';
  const lotNumbers = getLotNumbersForProduct(product.id, product.name || '');
  if (lotNumbers.length > 0) {
    const lotWrap = document.createElement('div');
    lotWrap.style.cssText = 'display:flex;flex-wrap:wrap;gap:0.25rem;';
    lotNumbers.forEach((lot) => {
      const badge = document.createElement('span');
      badge.className = 'inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300';
      badge.textContent = lot;
      badge.title = lot;
      lotWrap.appendChild(badge);
    });
    lotCell.appendChild(lotWrap);
  } else {
    lotCell.textContent = '—';
    lotCell.classList.add('text-slate-600', 'text-xs');
  }
  row.appendChild(lotCell);

  // Товарная группа
  const pgCell = document.createElement('td');
  pgCell.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2.5 transition-colors`;
  pgCell.style.left = _leftOffsets[5] + 'px'; pgCell.style.zIndex = '11';
  pgCell.style.minWidth = '110px'; pgCell.style.maxWidth = '150px';
  if (product.productGroup) {
    const pgBadge = document.createElement('span');
    pgBadge.className = 'text-xs text-violet-300 block truncate';
    pgBadge.title = product.productGroup;
    pgBadge.textContent = product.productGroup;
    pgCell.appendChild(pgBadge);
  } else {
    pgCell.textContent = '—';
    pgCell.classList.add('text-slate-600', 'text-xs');
  }
  row.appendChild(pgCell);

  // Итого по строке
  const rowTotal = getRowTotalForColumns(rowData, cols);
  const totalRowTd = document.createElement('td');
  totalRowTd.className = `${sticky} group-hover:bg-slate-900/90 px-3 py-2 text-center border-l border-r border-white/15 transition-colors`;
  totalRowTd.style.left = _totalColLeft + 'px'; totalRowTd.style.zIndex = '11';
  totalRowTd.dataset.totalRow = String(product.id);
  totalRowTd.dataset.rowKey   = rowKey;
  totalRowTd.dataset.rowType  = rowData.rowType;
  if (variantKey) totalRowTd.dataset.variantKey = String(variantKey);
  totalRowTd.dataset.group    = groupKey;
  const totalSpan = document.createElement('span');
  totalSpan.className = `text-sm font-semibold tabular-nums ${rowTotal > 0 ? 'text-cyan-400' : 'text-slate-600'}`;
  totalSpan.textContent = rowTotal > 0 ? String(rowTotal) : '—';
  totalRowTd.appendChild(totalSpan);
  row.appendChild(totalRowTd);

  // Ячейки получателей
  cols.forEach((col, ci) => {
    const r   = col.recipient;
    const qty = getRowQtyForRecipient(r, rowData, col.address || '');
    const isFirst = ci === 0 || cols[ci - 1].recipient.id !== r.id;
    const td = document.createElement('td');
    td.className = `px-2 py-2 text-center ${isFirst ? 'border-l border-white/5' : ''}`;
    td.dataset.productId   = String(product.id);
    td.dataset.recipientId = String(r.id);
    td.dataset.address     = col.address || '';
    td.dataset.rowKey      = rowKey;
    td.dataset.rowType     = rowData.rowType;
    if (variantKey) td.dataset.variantKey = String(variantKey);
    td.dataset.group       = groupKey;

    if (isSummary) {
      const span = document.createElement('span');
      span.className = `inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-semibold tabular-nums ${qty > 0 ? 'bg-slate-800/70 text-cyan-300' : 'text-slate-600'}`;
      span.textContent = qty > 0 ? String(qty) : '—';
      td.appendChild(span);
    } else {
      const input = document.createElement('input');
      input.type        = 'number';
      input.min         = '0';
      input.value       = qty > 0 ? String(qty) : '';
      input.placeholder = '—';
      input.className   = 'w-full rounded-lg border border-transparent bg-transparent text-center text-sm text-slate-200 tabular-nums py-1.5 px-1 transition focus:border-cyan-400/60 focus:bg-white/[0.07] hover:bg-white/5 placeholder-slate-600 focus:outline-none';
      input.setAttribute('aria-label', `${product.name} — ${r.name}`);
      input.dataset.productId = String(product.id);
      input.dataset.recipientId = String(r.id);
      input.dataset.address = col.address || '';
      input.dataset.rowKey = rowKey;
      input.dataset.rowType = rowData.rowType;
      input.dataset.group = groupKey;
      if (isVariant) input.dataset.variantKey = String(variantKey || '');
      input.addEventListener('input', () => handleCellInput(product.id, r.id, input));
      input.addEventListener('change', () => handleCellChange(product.id, r.id, input));
      input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
      td.appendChild(input);
    }
    row.appendChild(td);
  });

  return row;
}

// ─── Cell change handler ─────────────────────────────────────────

function applyMatrixChangeToState(productId, recipientId, address, variantKey, qty) {
  const recipient = getRecipientById(recipientId);
  if (!recipient) return false;
  const product = state.products.find(p => p.id === productId) || null;

  if (address) {
    const addressNeeds = normalizeRecipientAddressNeeds(recipient.addressNeeds, recipient);
    const addressKey = normalizeRecipientAddressNeedKey(address);
    if (!addressNeeds[addressKey]) addressNeeds[addressKey] = { address, needs: {} };

    const addressEntry = normalizeNeedEntry(addressNeeds[addressKey].needs[productId], product);
    if (variantKey && hasProductColorVariants(product)) {
      if (!addressEntry.variants) addressEntry.variants = {};
      const variant = getProductVariantByKey(product, variantKey);
      if (!variant) return false;
      const currentVariant = addressEntry.variants[variant.id] || {
        id: variant.id,
        colorCode: variant.colorCode,
        qty: 0,
        delivered: 0,
        assembled: 0,
      };
      currentVariant.qty = qty;
      addressEntry.variants[variant.id] = currentVariant;
      addressEntry.qty = Object.values(addressEntry.variants).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    } else {
      addressEntry.qty = qty;
    }

    if ((Number(addressEntry.qty) || 0) === 0 && (Number(addressEntry.delivered) || 0) === 0 && (Number(addressEntry.assembled) || 0) === 0) {
      delete addressNeeds[addressKey].needs[productId];
    } else {
      addressNeeds[addressKey].needs[productId] = addressEntry;
    }
    if (Object.keys(addressNeeds[addressKey].needs).length === 0) delete addressNeeds[addressKey];
    recipient.addressNeeds = addressNeeds;

    const aggregated = { qty: 0, delivered: 0, assembled: 0 };
    let hasAggregate = false;
    Object.values(addressNeeds).forEach((addressNeed) => {
      const source = addressNeed?.needs?.[productId];
      if (!source) return;
      const normalizedSource = normalizeNeedEntry(source, product);
      aggregated.qty += Number(normalizedSource.qty) || 0;
      aggregated.delivered += Number(normalizedSource.delivered) || 0;
      aggregated.assembled += Number(normalizedSource.assembled) || 0;
      if (normalizedSource.variants && typeof normalizedSource.variants === 'object') {
        if (!aggregated.variants) aggregated.variants = {};
        Object.entries(normalizedSource.variants).forEach(([key, variantValue]) => {
          if (!aggregated.variants[key]) {
            aggregated.variants[key] = {
              id: variantValue.id || key,
              colorCode: variantValue.colorCode || '',
              qty: 0,
              delivered: 0,
              assembled: 0,
            };
          }
          aggregated.variants[key].qty += Number(variantValue.qty) || 0;
          aggregated.variants[key].delivered += Number(variantValue.delivered) || 0;
          aggregated.variants[key].assembled += Number(variantValue.assembled) || 0;
        });
      }
      hasAggregate = true;
    });

    const nextNeeds = { ...(recipient.needs || {}) };
    if (hasAggregate && ((Number(aggregated.qty) || 0) > 0 || (Number(aggregated.delivered) || 0) > 0 || (Number(aggregated.assembled) || 0) > 0)) {
      nextNeeds[productId] = aggregated;
    } else {
      delete nextNeeds[productId];
    }
    updateRecipientNeeds(recipientId, nextNeeds);
    return true;
  }

  const entry = normalizeNeedEntry(recipient.needs?.[productId], product);
  const nextNeeds = { ...(recipient.needs || {}) };
  if (variantKey && hasProductColorVariants(product)) {
    if (!entry.variants) entry.variants = {};
    const variant = getProductVariantByKey(product, variantKey);
    if (!variant) return false;
    const currentVariant = entry.variants[variant.id] || {
      id: variant.id,
      colorCode: variant.colorCode,
      qty: 0,
      delivered: 0,
      assembled: 0,
    };
    currentVariant.qty = qty;
    entry.variants[variant.id] = currentVariant;
    entry.qty = Object.values(entry.variants).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    entry.delivered = Object.values(entry.variants).reduce((sum, item) => sum + (Number(item.delivered) || 0), 0) || (Number(entry.delivered) || 0);
    entry.assembled = Object.values(entry.variants).reduce((sum, item) => sum + (Number(item.assembled) || 0), 0) || (Number(entry.assembled) || 0);
    if (entry.qty === 0 && entry.delivered === 0 && entry.assembled === 0) {
      delete nextNeeds[productId];
    } else {
      nextNeeds[productId] = entry;
    }
  } else {
    if (qty === 0 && (Number(entry.delivered) || 0) === 0 && (Number(entry.assembled) || 0) === 0) {
      delete nextNeeds[productId];
    } else {
      entry.qty = qty;
      nextNeeds[productId] = entry;
    }
  }
  updateRecipientNeeds(recipientId, nextNeeds);
  return true;
}

async function persistNeedsMatrixChanges() {
  syncVisibleInputsToPending();
  if (!_needsMatrixDirty || _needsMatrixPending.size === 0) return;

  const changedRecipients = new Set();
  const changedProducts = [];

  for (const [key, qty] of _needsMatrixPending.entries()) {
    const [recipientIdRaw, productIdRaw, addressRaw, variantKeyRaw] = key.split('::');
    const recipientId = Number(recipientIdRaw || 0);
    const productId = Number(productIdRaw || 0);
    const address = String(addressRaw || '').trim();
    const variantKey = String(variantKeyRaw || '').trim();
    if (!recipientId || !productId) continue;
    const ok = applyMatrixChangeToState(productId, recipientId, address, variantKey, Number(qty) || 0);
    if (!ok) continue;
    changedRecipients.add(recipientId);
    changedProducts.push({ recipientId, productId });
  }

  await saveToStorage();
  clearPendingChanges();

  changedProducts.forEach(({ recipientId, productId }) => {
    window.dispatchEvent(new CustomEvent('recipient-needs-changed', {
      detail: { recipientId, productId, source: 'needs-matrix-save' },
    }));
  });
  window.dispatchEvent(new CustomEvent('recipient-needs-saved', {
    detail: { recipientIds: [...changedRecipients], source: 'needs-matrix-save' },
  }));

  try { (await import('./toast.js')).showToast(t('needsMatrix.saveSuccess'), 'success'); } catch {}
  renderNeedsMatrix();
}

async function handleCellChange(productId, recipientId, input) {
  const rawVal = input.value.trim();
  const qty = rawVal === '' ? 0 : Math.max(0, parseInt(rawVal, 10) || 0);
  input.value = qty > 0 ? String(qty) : '';
  const variantKey = String(input.dataset.variantKey || '').trim();
  const address = String(input.dataset.address || '').trim();

  setPendingQty(recipientId, productId, address, variantKey, qty);
  refreshRenderedProduct(productId);
  updateAllColTotals(recipientId);
  updateGroupedSummaryBadges();
}

function handleCellInput(productId, recipientId, input) {
  const rawVal = input.value.trim();
  const qty = rawVal === '' ? 0 : Math.max(0, parseInt(rawVal, 10) || 0);
  const variantKey = String(input.dataset.variantKey || '').trim();
  const address = String(input.dataset.address || '').trim();

  setPendingQty(recipientId, productId, address, variantKey, qty);
  refreshRenderedProduct(productId);
  updateAllColTotals(recipientId);
  updateGroupedSummaryBadges();
}

// ─── Partial re-renders ──────────────────────────────────────────

function refreshRenderedProduct(productId) {
  const product = state.products.find(p => p.id === productId);
  if (!product) return;

  document.querySelectorAll(`[data-total-row="${productId}"]`).forEach(cell => {
    const rowType = cell.dataset.rowType || 'single';
    const variantKey = String(cell.dataset.variantKey || '');
    const rowData = {
      product,
      rowType,
      isSummary: rowType === 'summary',
      isVariant: rowType === 'variant',
      variantKey,
      colorCode: rowType === 'variant' ? (getProductVariantByKey(product, variantKey)?.colorCode || '') : '',
    };
    const rowTotal = getRowTotalForColumns(rowData, getGroupRecipientColumns(cell.dataset.group || 'all'));
    clearChildren(cell);
    const span = document.createElement('span');
    span.className = `text-sm font-semibold tabular-nums ${rowTotal > 0 ? 'text-cyan-400' : 'text-slate-600'}`;
    span.textContent = rowTotal > 0 ? String(rowTotal) : '—';
    cell.appendChild(span);
  });

  document.querySelectorAll(`[data-product-id="${productId}"][data-row-type="summary"]`).forEach(cell => {
    const recipientId = Number(cell.dataset.recipientId || 0);
    const recipient = getRecipientById(recipientId);
    if (!recipient) return;
    const qty = getRowQtyForRecipient(recipient, {
      product,
      rowType: 'summary',
      isSummary: true,
      isVariant: false,
      variantKey: '',
      colorCode: '',
    }, cell.dataset.address || '');
    clearChildren(cell);
    const span = document.createElement('span');
    span.className = `inline-flex items-center rounded-lg px-2.5 py-1 text-sm font-semibold tabular-nums ${qty > 0 ? 'bg-slate-800/70 text-cyan-300' : 'text-slate-600'}`;
    span.textContent = qty > 0 ? String(qty) : '—';
    cell.appendChild(span);
  });
}

function updateAllRowTotals(productId) {
  document.querySelectorAll(`[data-total-row="${productId}"]`).forEach(cell => {
    const groupKey        = cell.dataset.group || 'all';
    const groupRecipients = getGroupRecipients(groupKey);
    const product = state.products.find(p => p.id === productId);
    if (!product) return;
    const rowType = cell.dataset.rowType || 'single';
    const variantKey = String(cell.dataset.variantKey || '');
    const rowData = {
      product,
      rowType,
      isSummary: rowType === 'summary',
      isVariant: rowType === 'variant',
      variantKey,
      colorCode: rowType === 'variant' ? (getProductVariantByKey(product, variantKey)?.colorCode || '') : '',
    };
    const rowTotal = getRowTotalForColumns(rowData, getGroupRecipientColumns(groupKey));
    clearChildren(cell);
    const span = document.createElement('span');
    span.className = `text-sm font-semibold tabular-nums ${rowTotal > 0 ? 'text-cyan-400' : 'text-slate-600'}`;
    span.textContent = rowTotal > 0 ? String(rowTotal) : '—';
    cell.appendChild(span);
  });
}

function updateAllColTotals(recipientId) {
  document.querySelectorAll(`[data-total-col-recipient="${recipientId}"]`).forEach(cell => {
    const r = getRecipientById(recipientId);
    if (!r) return;
    const address = cell.dataset.totalColAddress || '';
    let colTotal = 0;
    getRenderedProducts().forEach(p => { colTotal += getQty(r, p.id, address); });
    clearChildren(cell);
    const span = document.createElement('span');
    span.className = `text-sm font-bold tabular-nums ${colTotal > 0 ? 'text-cyan-400' : 'text-slate-600'}`;
    span.textContent = colTotal > 0 ? String(colTotal) : '—';
    cell.appendChild(span);
  });
}

function updateGroupedSummaryBadges() {
  const renderedProducts = getRenderedProducts();
  const filteredRecipients = getRenderedRecipients();
  const noProgram = t('needsMatrix.noProgram');

  document.querySelectorAll('[data-program-total-badge]').forEach((badge) => {
    const groupKey = badge.dataset.programTotalBadge || '';
    const recipients = filteredRecipients.filter((recipient) => {
      const program = (recipient.targetProgram || '').trim() || noProgram;
      return program === groupKey;
    });
    const total = calcGroupTotal(renderedProducts, recipients);
    badge.textContent = t('needsMatrix.programTotal') + ': ' + total;
  });

  const grandValue = document.querySelector('[data-grand-total-value="true"]');
  if (grandValue) {
    const total = calcGroupTotal(renderedProducts, filteredRecipients);
    grandValue.textContent = String(total);
  }
}

function getGroupRecipients(groupKey) {
  if (groupKey === 'all') return getFilteredRecipients();
  const noProgram = t('needsMatrix.noProgram');
  return getFilteredRecipients().filter(r => {
    const prog = (r.targetProgram || '').trim() || noProgram;
    return prog === groupKey;
  });
}

function getGroupRecipientColumns(groupKey) {
  return buildRecipientColumns(getGroupRecipients(groupKey));
}
