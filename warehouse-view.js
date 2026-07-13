/**
 * Warehouse module — склад: наличие и реестр поступлений.
 *
 * Panels:
 *  0. warehouseHomePanel   — главный экран (Наличие / Реестр поступлений)
 *  1. warehouseListPanel   — реестр поступлений (карточки)
 *  2. warehouseCardPanel   — карточка поступления (добавление/редактирование)
 *  3. warehouseImportPanel — импорт из Excel
 *  4. warehouseStockPanel  — таблица наличия (построчно, по каждому товару)
 */

import { $, el, clearChildren } from './dom.js';
import { state } from '../state.js';
import {
  addWarehouseEntry, updateWarehouseEntry, deleteWarehouseEntry,
  getWarehouseEntries, isShippingAllowedByActs, getWarehouseById,
  hasProductColorVariants, getProductColorVariants, buildProductFullCode,
} from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { attachFrozenManager } from './frozen-table.js';
import { enhancePredictiveInput } from './filters.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── Category resolution ──────────────────────────────────────────

/**
 * Получить категорию товара из каталога.
 * Порядок поиска:
 *  1. По productId (самый надёжный)
 *  2. Точное совпадение по коду (trim + lowercase)
 *  3. Частичное совпадение по коду
 *  4. Точное совпадение по имени (trim + lowercase)
 *  5. Частичное совпадение по имени
 */
function resolveCategory(productId, productCode, productName) {
  const products = state.products || [];

  // 1. По id
  if (productId) {
    const p = products.find(p => p.id === productId);
    if (p?.category) return p.category;
  }

  const code = (productCode || '').trim().toLowerCase();
  const name = (productName || '').trim().toLowerCase();

  // 2. Точный код
  if (code) {
    const p = products.find(p => p.code && p.code.trim().toLowerCase() === code);
    if (p?.category) return p.category;
  }

  // 3. Частичный код
  if (code) {
    const p = products.find(p => {
      const pc = (p.code || '').trim().toLowerCase();
      return pc && (pc === code || code.includes(pc) || pc.includes(code));
    });
    if (p?.category) return p.category;
  }

  // 4. Точное имя
  if (name) {
    const p = products.find(p => p.name && p.name.trim().toLowerCase() === name);
    if (p?.category) return p.category;
  }

  // 5. Частичное имя
  if (name) {
    const p = products.find(p => {
      const pn = (p.name || '').trim().toLowerCase();
      return pn && pn.length > 3 && (pn === name || name.includes(pn) || pn.includes(name));
    });
    if (p?.category) return p.category;
  }

  return '';
}

// ─── Act-based acceptance ─────────────────────────────────────────

function isActAccepted(productCode, productName) {
  return isShippingAllowedByActs(productCode, productName);
}

function effectiveAccepted(entry) {
  return entry.accepted || isActAccepted(entry.productCode, entry.productName);
}

// ─── Module state ─────────────────────────────────────────────────

// Current active warehouse context (null = summary/all mode)
let activeWarehouseId = null;

let searchQuery  = '';
let filterStatus = 'all';
let stockQuery   = '';

// Stock table sort / filter state
let stockSortCol = 'date';
let stockSortDir = 'asc';
let stockFilters = { category: '', supplier: '', contract: '', order: '', accepted: '' };
let stockFilterUiState = { active: '', caret: null };

// Хранит состояние раскрытых групп: Set<productKey>
const expandedGroups = new Set();

let editingEntryId = null;
let cardItems = [];

// ─── Panel navigation ─────────────────────────────────────────────

export function openWarehouseForLocation(warehouseId) {
  activeWarehouseId = warehouseId !== undefined ? warehouseId : null;
  const wh = activeWarehouseId != null ? getWarehouseById(activeWarehouseId) : null;
  // Update inner title (inside warehouseHomePanel)
  const titleEl = $('warehouseInnerTitle');
  if (titleEl) titleEl.textContent = activeWarehouseId == null
    ? 'Сводная логистика (все склады)'
    : (wh ? wh.name : t('warehouse.title'));
  const subtitleEl = $('warehouseModalSubtitle');
  if (subtitleEl) subtitleEl.textContent = activeWarehouseId == null
    ? 'Данные по всем складам и поставкам'
    : (wh ? (wh.address || t('warehouse.subtitle')) : t('warehouse.subtitle'));
  // Reset filters
  searchQuery  = '';
  filterStatus = 'all';
  stockQuery   = '';
  stockFilters = { category: '', supplier: '', contract: '', order: '', accepted: '' };

  const overlay = $('warehouseModal');
  if (!overlay) return;
  overlay.classList.add('open');
  showHomePanel();
  updateWarehouseBadge();
}

export function openWarehouseModal() {
  openWarehouseForLocation(null);
}

function _legacyOpenWarehouseModal() {
  const overlay = $('warehouseModal');
  if (!overlay) return;
  overlay.classList.add('open');
  showHomePanel();
  updateWarehouseBadge();
}

export function closeWarehouseModal() {
  const overlay = $('warehouseModal');
  if (overlay) overlay.classList.remove('open');
}

function showHomePanel() {
  $('whLocationsListPanel')?.classList.add('hidden');
  $('whLocationCardPanel')?.classList.add('hidden');
  $('warehouseHomePanel')?.classList.remove('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
  $('warehouseShipmentPanel')?.classList.add('hidden');
  $('warehouseShipmentsRegistryPanel')?.classList.add('hidden');
  $('directDeliveriesRegistryPanel')?.classList.add('hidden');
  $('directDeliveryCardPanel')?.classList.add('hidden');
}

function showListPanel() {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.remove('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
  renderList();
}

function showCardPanel() {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.remove('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
}

function showImportPanel() {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.remove('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
}

function showStockPanel() {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.remove('hidden');
  renderStockTable();
}

// ─── Badge ────────────────────────────────────────────────────────

export function updateWarehouseBadge() {
  const badge = $('warehouseBadge');
  if (!badge) return;
  const n = state.warehouseEntries.length;
  if (n > 0) {
    badge.textContent = n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function getContractById(id) { return state.contracts.find(c => c.id === id) || null; }
function getSupplierById(id) { return (state.suppliers || []).find(s => s.id === id) || null; }
function getOrderById(id)    { return (state.orders    || []).find(o => o.id === id) || null; }
function getScopedEntries() {
  const all = getWarehouseEntries();
  return activeWarehouseId == null ? all : all.filter(e => e.warehouseId === activeWarehouseId);
}

function getProductByRef(contractItem) {
  const ref = contractItem.productRef ?? contractItem.productId ?? null;
  if (ref == null) return null;
  return state.products.find(p => p.id === ref) || null;
}

function buildWarehouseRowsForContractItem(contractItem) {
  const product = getProductByRef(contractItem);
  const baseName = (contractItem.name && contractItem.name.trim()) ? contractItem.name.trim() : (product?.name || '');
  const baseCode = String(contractItem.code || product?.code || '').trim();
  const price = Number(contractItem.price) || 0;
  const productId = contractItem.productRef ?? contractItem.productId ?? product?.id ?? null;

  if (!hasProductColorVariants(product)) {
    return [{
      productId,
      productCode: baseCode,
      productName: baseName,
      displayName: baseName,
      category: resolveCategory(productId, baseCode, baseName),
      price,
      qty: 0,
      colorCode: '',
      variantId: '',
      isColorVariant: false,
    }];
  }

  return getProductColorVariants(product).map(variant => ({
    productId,
    productCode: variant.fullCode || buildProductFullCode(baseCode, variant.colorCode),
    productName: `${baseName} · ${variant.colorCode}`,
    displayName: `${baseName} · ${variant.colorCode}`,
    category: resolveCategory(productId, baseCode, baseName),
    price,
    qty: 0,
    colorCode: variant.colorCode,
    variantId: variant.id,
    isColorVariant: true,
  }));
}

function contractLabel(c) {
  if (!c) return '';
  return [c.number, c.title].filter(Boolean).join(' — ') || ('#' + c.id);
}
function supplierLabel(s) { return s?.name || ''; }
function orderLabel(o) {
  if (!o) return '';
  return o.orderNumber || ('Заявка #' + o.id);
}

function isWarehouseDeliveryOrder(order) {
  if (!order) return false;
  const mode = String(order.deliveryMode || '').trim().toLowerCase();
  return !mode || mode === 'warehouse' || mode === 'stock' || mode === 'склад';
}

function getSentOrders(contractId) {
  return (state.orders || []).filter(o =>
    o.sent === true &&
    isWarehouseDeliveryOrder(o) &&
    (!contractId || o.contractId === contractId),
  );
}

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0 });
}

// ─── Cumulative receipt helpers ───────────────────────────────────

function getAlreadyReceived(orderId, itemName, itemCode) {
  if (!orderId) return 0;
  let total = 0;
  state.warehouseEntries.forEach(e => {
    if (e.id === editingEntryId) return;
    if (e.orderId !== orderId) return;
    (e.items || []).forEach(ei => {
      const nameMatch = itemName && ei.productName &&
        ei.productName.trim().toLowerCase() === itemName.trim().toLowerCase();
      const codeMatch = itemCode && ei.productCode &&
        ei.productCode.trim().toLowerCase() === itemCode.trim().toLowerCase();
      if (nameMatch || codeMatch) total += Number(ei.qty) || 0;
    });
  });
  return total;
}

function getOrderedQty(orderId, itemName, itemCode) {
  const order = getOrderById(orderId);
  if (!order) return 0;
  let total = 0;
  (order.deliveryRows || []).forEach(r => {
    const nameMatch = itemName && r.contractItemName &&
      r.contractItemName.trim().toLowerCase() === itemName.trim().toLowerCase();
    const codeMatch = itemCode && r.contractItemCode &&
      r.contractItemCode.trim().toLowerCase() === itemCode.trim().toLowerCase();
    if (nameMatch || codeMatch) total += Number(r.qty) || 0;
  });
  return total;
}

// ═══════════════════════════════════════════════════════════════════
// STOCK TABLE (Наличие)
// Группировка: одна строка = один уникальный товар (по коду).
// При нажатии → раскрывается детализация по заявкам.
// Если товар поступал по одной заявке — строка не раскрывается.
// ═══════════════════════════════════════════════════════════════════

/** Строит плоский список строк (одна строка = один товар из одного поступления). */
function buildStockRows() {
  const entries = getScopedEntries();

  // Сортируем по дате, затем по id (стабильный хронологический порядок)
  const sorted = [...entries].sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da < db) return -1;
    if (da > db) return 1;
    return (a.id || 0) - (b.id || 0);
  });

  const allRows = [];

  sorted.forEach(entry => {
    const contract = getContractById(entry.contractId);
    const supplier = getSupplierById(entry.supplierId);
    const order    = getOrderById(entry.orderId);

    const supplierStr = supplierLabel(supplier);
    const contractStr = contractLabel(contract);
    const orderStr    = orderLabel(order);
    const programRaw = order ? (order.programName || order.programCode || '') : '';
    const programStr  = programRaw ? formatProgramLabel(getProgramByIdentity(programRaw) || programRaw) : '';

    let items = [];
    if (Array.isArray(entry.items) && entry.items.length > 0) {
      items = entry.items
        .filter(i => (i.productName || i.productCode) && Number(i.qty) > 0)
        .map(i => ({
          productId:   i.productId   ?? null,
          productCode: (i.productCode || '').trim(),
          productName: (i.productName || '').trim(),
          baseCode:    (i.baseCode || '').trim(),
          baseName:    i.productId ? (state.products.find(p => p.id === i.productId)?.name || '') : '',
          category:    i.category || resolveCategory(i.productId ?? null, (i.productCode || '').trim(), (i.productName || '').trim()),
          price:       Number(i.price) || 0,
          qty:         Number(i.qty)   || 0,
        }));
    }

    if (items.length === 0 && entry.orderId) {
      const ord = getOrderById(entry.orderId);
      if (ord) {
        const grouped = new Map();
        (ord.deliveryRows || []).forEach(r => {
          const key = (r.contractItemName || '').trim();
          if (!key) return;
          if (!grouped.has(key)) {
            grouped.set(key, {
              code:     (r.contractItemCode || '').trim(),
              price:    Number(r.price) || 0,
              totalQty: 0,
            });
          }
          grouped.get(key).totalQty += Number(r.qty) || 0;
        });
        grouped.forEach((v, name) => {
          const prod = v.code
            ? state.products.find(p => p.code && p.code.trim() === v.code)
            : state.products.find(p => p.name && p.name.trim().toLowerCase() === name.toLowerCase());
          items.push({
            productId:   prod ? prod.id   : null,
            productCode: v.code || (prod ? (prod.code || '') : ''),
            productName: prod ? prod.name : name,
            baseCode:    '',
            baseName:    prod ? prod.name : name,
            category:    prod ? (prod.category || '') : '',
            price:       v.price,
            qty:         v.totalQty,
          });
        });
      }
    }

    // ── Шаг 3: финальный fallback — одна строка из полей entry ─────
    if (items.length === 0) {
      const fallbackQty = Number(entry.received) || 0;
      if (entry.productName || entry.productCode || fallbackQty > 0) {
        const prod = entry.productId
          ? state.products.find(p => p.id === entry.productId)
          : (entry.productCode
            ? state.products.find(p => p.code && p.code === entry.productCode)
            : null);
        items = [{
          productId:   entry.productId   ?? null,
          productCode: (entry.productCode || '').trim(),
          productName: (entry.productName || '').trim(),
          baseCode:    '',
          baseName:    prod ? (prod.name || '') : (entry.productName || '').trim(),
          category:    prod ? (prod.category || '') : (entry.category || ''),
          price:       0,
          qty:         fallbackQty,
        }];
      }
    }

    if (items.length === 0) return; // нечего показывать

    // Общее кол-во в поступлении — для пропорционального распределения shipped
    const totalEntryQty = items.reduce((s, i) => s + i.qty, 0);
    const entryShipped  = Number(entry.shipped) || 0;

    // ── Шаг 4: каждый item → строка таблицы ───────────────────────
    items.forEach(item => {
      const code = item.productCode;
      const name = item.productName;

      // Кодовый ключ: код товара (предпочтительно) или строчное имя
      const codeKey = code.toLowerCase() || name.toLowerCase();
      if (!codeKey) return;

      const productId = item.productId ?? null;
      const category  = item.category || resolveCategory(productId, code, name) || '';
      const qty       = item.qty;

      const itemShipped = totalEntryQty > 0
        ? Math.round((qty / totalEntryQty) * entryShipped)
        : 0;

      const balance = qty - itemShipped;

      const accepted = isActAccepted(code, name)
        || isActAccepted(item.baseCode || '', item.baseName || '')
        || entry.accepted
        || false;

      const warehouseName = (() => {
        const wh = (state.warehouses || []).find(w => w.id === entry.warehouseId);
        return wh ? wh.name : '';
      })();

      allRows.push({
        entryId:     entry.id,
        productCode: code,
        productName: name,
        category,
        supplier:    supplierStr,
        contract:    contractStr,
        order:       orderStr,
        date:        entry.date || '',
        program:     programStr,
        qty,
        shipped:     itemShipped,
        balance,
        accepted,
        warehouseName,
      });
    });
  });

  return allRows;
}

// cumReceivedMap was removed — cumulative totals now computed per-group in buildGroupedStock

/**
 * Группирует плоские строки по коду товара.
 * Возвращает массив групп со сводными данными и детальными строками.
 */
function buildGroupedStock(flatRows) {
  const map = new Map();
  flatRows.forEach(row => {
    const key = row.productCode.toLowerCase() || row.productName.toLowerCase();
    if (!map.has(key)) {
      map.set(key, {
        productKey:    key,
        productCode:   row.productCode,
        productName:   row.productName,
        category:      row.category,
        warehouseName: row.warehouseName,
        totalQty:      0,
        totalShipped:  0,
        totalBalance:  0,
        accepted:      false,
        rows:          [],
      });
    }
    const g = map.get(key);
    g.totalQty     += row.qty;
    g.totalShipped += row.shipped;
    g.totalBalance += row.balance;
    if (row.accepted) g.accepted = true;
    g.rows.push(row);
  });
  // Считаем уникальные заявки
  map.forEach(g => {
    const uniqueOrders = new Set(g.rows.map(r => r.order).filter(Boolean));
    g.orderCount = uniqueOrders.size || g.rows.length;
  });
  return Array.from(map.values());
}

/** Фильтр групп по текстовому запросу */
function filterGroups(groups) {
  if (!stockQuery) return groups;
  const q = stockQuery.toLowerCase();
  return groups.filter(g =>
    g.productCode.toLowerCase().includes(q) ||
    g.productName.toLowerCase().includes(q) ||
    g.category.toLowerCase().includes(q) ||
    g.rows.some(r =>
      r.supplier.toLowerCase().includes(q) ||
      r.contract.toLowerCase().includes(q) ||
      r.order.toLowerCase().includes(q),
    ),
  );
}

/** Сортирует группы */
function sortGroups(groups) {
  const dir = stockSortDir === 'asc' ? 1 : -1;
  const colMap = { received: 'totalQty', qty: 'totalQty', shipped: 'totalShipped', balance: 'totalBalance' };
  const k = colMap[stockSortCol] || stockSortCol;
  return [...groups].sort((a, b) => {
    let va = a[k] ?? '';
    let vb = b[k] ?? '';
    if (['totalQty', 'totalShipped', 'totalBalance'].includes(k)) {
      return (Number(va) - Number(vb)) * dir;
    }
    va = String(va).toLowerCase(); vb = String(vb).toLowerCase();
    if (va < vb) return -1 * dir;
    if (va > vb) return  1 * dir;
    return 0;
  });
}

/** Применяет текстовой поиск и фильтры по столбцам */
function filterStockRows(rows) {
  let r = rows;

  if (stockQuery) {
    const q = stockQuery.toLowerCase();
    r = r.filter(row =>
      row.productCode.toLowerCase().includes(q) ||
      row.productName.toLowerCase().includes(q) ||
      row.category.toLowerCase().includes(q) ||
      row.supplier.toLowerCase().includes(q) ||
      row.contract.toLowerCase().includes(q) ||
      row.order.toLowerCase().includes(q)
    );
  }

  if (stockFilters.category) {
    const v = stockFilters.category.toLowerCase();
    r = r.filter(row => row.category.toLowerCase().includes(v));
  }
  if (stockFilters.supplier) {
    const v = stockFilters.supplier.toLowerCase();
    r = r.filter(row => row.supplier.toLowerCase().includes(v));
  }
  if (stockFilters.contract) {
    const v = stockFilters.contract.toLowerCase();
    r = r.filter(row => row.contract.toLowerCase().includes(v));
  }
  if (stockFilters.order) {
    const v = stockFilters.order.toLowerCase();
    r = r.filter(row => row.order.toLowerCase().includes(v));
  }
  if (stockFilters.accepted === 'yes') r = r.filter(row => row.accepted);
  if (stockFilters.accepted === 'no')  r = r.filter(row => !row.accepted);

  return r;
}

/** Сортирует строки таблицы */
function sortStockRows(rows) {
  const dir = stockSortDir === 'asc' ? 1 : -1;
  return [...rows].sort((a, b) => {
    let va = a[stockSortCol] ?? '';
    let vb = b[stockSortCol] ?? '';
    if (['received', 'qty', 'shipped', 'balance'].includes(stockSortCol)) {
      return (Number(va) - Number(vb)) * dir;
    }
    if (stockSortCol === 'accepted') {
      return ((va ? 1 : 0) - (vb ? 1 : 0)) * dir;
    }
    va = String(va).toLowerCase();
    vb = String(vb).toLowerCase();
    if (va < vb) return -1 * dir;
    if (va > vb) return  1 * dir;
    return 0;
  });
}

function buildPredictiveFilterControl({ id, placeholder, options, value, onInput }) {
  const wrap = el('div', { className: 'relative min-w-[150px]' });
  const input = el('input', {
    id,
    type: 'search',
    list: `${id}Options`,
    value: value || '',
    placeholder,
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition focus:border-cyan-400/50',
    'aria-label': placeholder,
  });
  const list = el('datalist', { id: `${id}Options` });
  options.forEach(option => list.appendChild(el('option', { value: option })));
  input.addEventListener('input', event => onInput(event.currentTarget));
  wrap.append(input, list);
  enhancePredictiveInput(input, {
    listId: `${id}Options`,
    options,
    icon: '⌕',
    minWidth: '150px',
  });
  return wrap;
}

function renderStockTable() {
  const wrap = $('warehouseStockWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const allRows = buildStockRows();
  const categories = [...new Set(allRows.map(r => r.category).filter(Boolean))].sort();
  const suppliers  = [...new Set(allRows.map(r => r.supplier).filter(Boolean))].sort();
  const contracts  = [...new Set(allRows.map(r => r.contract).filter(Boolean))].sort();
  const orders     = [...new Set(allRows.map(r => r.order).filter(Boolean))].sort();

  const stockSearchInput = $('warehouseStockSearch');
  if (stockSearchInput) {
    stockSearchInput.setAttribute('list', 'warehouseStockSearchOptions');
    let stockSearchList = document.getElementById('warehouseStockSearchOptions');
    if (!stockSearchList) {
      stockSearchList = document.createElement('datalist');
      stockSearchList.id = 'warehouseStockSearchOptions';
      stockSearchInput.insertAdjacentElement('afterend', stockSearchList);
    }
    const options = [...new Set(allRows.flatMap(row => [
      row.productName,
      row.productCode,
      row.category,
      row.supplier,
      row.contract,
      row.order,
    ].map(v => String(v || '').trim()).filter(Boolean)))].sort((a, b) => a.localeCompare(b, 'ru'));
    stockSearchList.innerHTML = options.map(option => `<option value="${option.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`).join('');
    enhancePredictiveInput(stockSearchInput, {
      listId: 'warehouseStockSearchOptions',
      options,
      icon: '🔍',
      minWidth: '220px',
    });
  }

  // ── Панель фильтров ────────────────────────────────────────────
  const filterBar = el('div', { className: 'flex flex-wrap gap-2 mb-3 items-center' });
  filterBar.append(
    buildPredictiveFilterControl({
      id: 'warehouseStockFilterCategory',
      placeholder: 'Все категории',
      options: categories,
      value: stockFilters.category,
      onInput: (input) => {
        stockFilters.category = input.value;
        stockFilterUiState = { active: input.id, caret: input.selectionStart ?? null };
        renderStockTable();
      },
    }),
    buildPredictiveFilterControl({
      id: 'warehouseStockFilterSupplier',
      placeholder: 'Все поставщики',
      options: suppliers,
      value: stockFilters.supplier,
      onInput: (input) => {
        stockFilters.supplier = input.value;
        stockFilterUiState = { active: input.id, caret: input.selectionStart ?? null };
        renderStockTable();
      },
    }),
    buildPredictiveFilterControl({
      id: 'warehouseStockFilterContract',
      placeholder: 'Все контракты',
      options: contracts,
      value: stockFilters.contract,
      onInput: (input) => {
        stockFilters.contract = input.value;
        stockFilterUiState = { active: input.id, caret: input.selectionStart ?? null };
        renderStockTable();
      },
    }),
    buildPredictiveFilterControl({
      id: 'warehouseStockFilterOrder',
      placeholder: 'Все заявки',
      options: orders,
      value: stockFilters.order,
      onInput: (input) => {
        stockFilters.order = input.value;
        stockFilterUiState = { active: input.id, caret: input.selectionStart ?? null };
        renderStockTable();
      },
    }),
  );
  const accSel = el('select', {
    className: 'rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition focus:border-cyan-400/50 min-w-[110px]',
    'aria-label': 'Фильтр по приёмке',
  });
  [['', 'Вся приёмка'], ['yes', '✓ Принято'], ['no', '✗ Не принято']].forEach(([val, label]) => {
    const o = el('option', { value: val }, label);
    if (stockFilters.accepted === val) o.selected = true;
    accSel.appendChild(o);
  });
  accSel.addEventListener('change', () => { stockFilters.accepted = accSel.value; renderStockTable(); });
  filterBar.appendChild(accSel);
  const resetBtn = el('button', {
    type: 'button',
    className: 'rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/10 transition',
  }, '✕ Сбросить');
  resetBtn.addEventListener('click', () => {
    stockFilters = { category: '', supplier: '', contract: '', order: '', accepted: '' };
    stockFilterUiState = { active: '', caret: null };
    stockQuery = '';
    const searchEl = $('warehouseStockSearch');
    if (searchEl) searchEl.value = '';
    renderStockTable();
  });
  filterBar.appendChild(resetBtn);
  wrap.appendChild(filterBar);

  if (stockFilterUiState.active) {
    requestAnimationFrame(() => {
      const input = document.getElementById(stockFilterUiState.active);
      if (!(input instanceof HTMLInputElement)) return;
      input.focus();
      const pos = Math.min(Number(stockFilterUiState.caret ?? input.value.length), input.value.length);
      try { input.setSelectionRange(pos, pos); } catch {}
    });
  }

  // Группировка → фильтрация → сортировка
  const filteredFlat = filterStockRows(allRows);
  const groups       = filterGroups(buildGroupedStock(filteredFlat));
  const sortedGroups = sortGroups(groups);
  const hasActiveFilter = stockQuery || Object.values(stockFilters).some(Boolean);

  if (sortedGroups.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '📦'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' },
      hasActiveFilter ? 'Ничего не найдено' : t('warehouse.empty')));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' },
      hasActiveFilter ? 'Попробуйте изменить фильтры' : t('warehouse.emptyHint')));
    wrap.appendChild(empty);
    return;
  }

  // ── Итоги ──────────────────────────────────────────────────────
  const totQty     = sortedGroups.reduce((s, g) => s + g.totalQty, 0);
  const totShipped = sortedGroups.reduce((s, g) => s + g.totalShipped, 0);
  const totBalance = sortedGroups.reduce((s, g) => s + g.totalBalance, 0);
  const summary = el('div', { className: 'flex gap-4 flex-wrap mb-4 px-1' });
  const mkStat = (label, val, color) => {
    const s = el('div', { className: 'flex flex-col' });
    s.appendChild(el('span', { className: 'text-[10px] uppercase tracking-wider text-slate-500' }, label));
    s.appendChild(el('span', { className: 'text-sm font-bold ' + color + ' tabular-nums' }, fmt(val)));
    return s;
  };
  summary.append(
    mkStat('Позиций', sortedGroups.length, 'text-slate-300'),
    mkStat('Поступило', totQty, 'text-cyan-400'),
    mkStat('Отгружено', totShipped, 'text-amber-400'),
    mkStat('Наличие', totBalance, totBalance > 0 ? 'text-emerald-400' : 'text-slate-400'),
  );
  wrap.appendChild(summary);

  // Подсказка о раскрытии
  const expandableCount = sortedGroups.filter(g => g.orderCount > 1).length;
  if (expandableCount > 0) {
    const hint = el('p', { className: 'text-[11px] text-slate-500 mb-3 px-1' });
    hint.textContent = '▶ Нажмите на строку с несколькими заявками для просмотра детализации';
    wrap.appendChild(hint);
  }

  // ── Таблица ────────────────────────────────────────────────────
  const tableWrap = el('div', { className: 'overflow-x-auto rounded-2xl border border-white/10' });
  const table = el('table', { className: 'w-full text-xs text-slate-300 border-collapse' });

  const COLS = [
    ...(activeWarehouseId == null ? [{ key: 'warehouseName', label: 'Склад',        cls: 'text-left min-w-[90px]' }] : []),
    { key: 'category',    label: 'Категория',    cls: 'text-left min-w-[100px]' },
    { key: 'productName', label: 'Наименование', cls: 'text-left min-w-[160px]' },
    { key: 'productCode', label: 'Код товара',   cls: 'text-left whitespace-nowrap' },
    { key: 'qty',         label: 'Поступило',    cls: 'text-right whitespace-nowrap' },
    { key: 'shipped',     label: 'Отгружено',    cls: 'text-right whitespace-nowrap' },
    { key: 'balance',     label: 'Наличие',      cls: 'text-right whitespace-nowrap' },
    { key: 'accepted',    label: 'Приёмка',      cls: 'text-center whitespace-nowrap' },
    { key: '_expand',     label: '',             cls: 'w-8' },
  ];

  const thead = el('thead', {});
  const hrow  = el('tr', { className: 'border-b border-white/10 bg-white/5' });
  COLS.forEach(col => {
    const sortable = col.key !== '_expand';
    const isActive = sortable && stockSortCol === col.key;
    const indicator = isActive ? (stockSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const thCls = 'px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wide select-none transition ' +
      (sortable ? 'cursor-pointer ' : '') +
      (isActive ? 'text-cyan-400 ' : 'text-slate-400 hover:text-slate-200 ') + col.cls;
    const th = el('th', { className: thCls }, col.label + indicator);
    if (sortable) {
      th.addEventListener('click', () => {
        if (stockSortCol === col.key) stockSortDir = stockSortDir === 'asc' ? 'desc' : 'asc';
        else { stockSortCol = col.key; stockSortDir = 'asc'; }
        renderStockTable();
      });
    }
    hrow.appendChild(th);
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody', {});

  sortedGroups.forEach(group => {
    const canExpand = group.orderCount > 1;
    const isExpanded = expandedGroups.has(group.productKey);

    // ── Сводная строка группы ──────────────────────────────────
    const tr = el('tr', {
      className: 'border-b border-white/5 transition hover:bg-white/[0.06] ' +
        (canExpand ? 'cursor-pointer select-none' : ''),
      title: canExpand ? (isExpanded ? 'Свернуть' : 'Раскрыть детализацию по заявкам') : '',
    });

    if (activeWarehouseId == null) {
      const whTd = el('td', { className: 'px-3 py-2.5 text-slate-400 max-w-[110px]' });
      whTd.appendChild(el('span', { className: 'block truncate text-xs', title: group.warehouseName }, group.warehouseName || '—'));
      tr.appendChild(whTd);
    }

    const catTd = el('td', { className: 'px-3 py-2.5 text-slate-400 max-w-[120px]' });
    catTd.appendChild(el('span', { className: 'block truncate text-xs', title: group.category }, group.category || '—'));
    tr.appendChild(catTd);

    const nameTd = el('td', { className: 'px-3 py-2.5 max-w-[220px]' });
    const nameWrap = el('div', { className: 'flex items-center gap-1.5 min-w-0' });
    nameWrap.appendChild(el('span', { className: 'font-medium text-white text-xs truncate', title: group.productName }, group.productName || '—'));
    if (canExpand) {
      nameWrap.appendChild(el('span', {
        className: 'shrink-0 inline-flex items-center rounded bg-cyan-400/15 px-1 py-0.5 text-[9px] font-bold text-cyan-400 whitespace-nowrap',
      }, group.orderCount + ' зав.'));
    }
    nameTd.appendChild(nameWrap);
    tr.appendChild(nameTd);

    tr.appendChild(el('td', { className: 'px-3 py-2.5 font-mono text-cyan-400 whitespace-nowrap text-xs' }, group.productCode || '—'));
    tr.appendChild(el('td', { className: 'px-3 py-2.5 text-right font-bold text-cyan-400 tabular-nums whitespace-nowrap' }, fmt(group.totalQty)));
    tr.appendChild(el('td', { className: 'px-3 py-2.5 text-right tabular-nums text-amber-400 whitespace-nowrap' }, fmt(group.totalShipped)));
    const balCls = group.totalBalance > 0 ? 'text-emerald-400 font-bold' : 'text-slate-400';
    tr.appendChild(el('td', { className: 'px-3 py-2.5 text-right tabular-nums whitespace-nowrap ' + balCls }, fmt(group.totalBalance)));

    const accTd = el('td', { className: 'px-3 py-2.5 text-center' });
    accTd.appendChild(el('span', {
      className: group.accepted
        ? 'inline-block rounded-lg bg-emerald-400/15 px-2 py-0.5 text-[11px] font-semibold text-emerald-400'
        : 'inline-block rounded-lg bg-rose-400/10 px-2 py-0.5 text-[11px] font-semibold text-rose-400',
    }, group.accepted ? '✓ Принято' : '✗ Не принято'));
    tr.appendChild(accTd);

    const arrowTd = el('td', { className: 'px-2 py-2.5 text-center' });
    if (canExpand) {
      arrowTd.appendChild(el('span', {
        className: 'inline-block text-slate-400 text-[10px] transition-transform duration-200 ' + (isExpanded ? 'rotate-90' : ''),
        'aria-hidden': 'true',
      }, '▶'));
    }
    tr.appendChild(arrowTd);

    if (canExpand) {
      tr.addEventListener('click', () => {
        if (expandedGroups.has(group.productKey)) expandedGroups.delete(group.productKey);
        else expandedGroups.add(group.productKey);
        renderStockTable();
      });
    }
    tbody.appendChild(tr);

    // ── Детализация по заявкам ─────────────────────────────────
    if (canExpand && isExpanded) {
      const detailTr = el('tr', { className: 'bg-slate-800/50' });
      const detailTd = el('td', { colspan: String(COLS.length), className: 'p-0' });
      const detailTable = el('table', { className: 'w-full text-[11px] border-collapse' });

      const dHead = el('thead', {});
      const dHrow = el('tr', { className: 'bg-slate-700/40' });
      if (activeWarehouseId == null) dHrow.appendChild(el('th', { className: 'w-[90px]' }));
      [
        { label: '  ↳ Заявка',       cls: 'text-left pl-8 min-w-[130px]' },
        { label: 'Контракт',          cls: 'text-left min-w-[120px]' },
        { label: 'Поставщик',         cls: 'text-left min-w-[110px]' },
        { label: 'Целевая программа', cls: 'text-left min-w-[100px]' },
        { label: 'Дата',              cls: 'text-left whitespace-nowrap' },
        { label: 'Поступило',         cls: 'text-right whitespace-nowrap' },
        { label: 'Отгружено',         cls: 'text-right whitespace-nowrap' },
        { label: 'Наличие',           cls: 'text-right whitespace-nowrap' },
        { label: 'Приёмка',           cls: 'text-center whitespace-nowrap' },
        { label: '',                  cls: 'w-8' },
      ].forEach(dc => {
        dHrow.appendChild(el('th', {
          className: 'px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wide text-slate-500 ' + dc.cls,
        }, dc.label));
      });
      dHead.appendChild(dHrow);
      detailTable.appendChild(dHead);

      const dBody = el('tbody', {});
      group.rows.forEach((row, di) => {
        const dtr = el('tr', {
          className: 'border-t border-white/[0.04] transition ' +
            (di % 2 === 0 ? 'bg-slate-900/30' : 'bg-slate-800/20') + ' hover:bg-white/[0.03]',
        });
        if (activeWarehouseId == null) {
          dtr.appendChild(el('td', { className: 'px-3 py-2 text-slate-600 text-[10px]' }, row.warehouseName || ''));
        }
        const oTd = el('td', { className: 'pl-8 pr-3 py-2 text-slate-300 max-w-[150px]' });
        oTd.appendChild(el('span', { className: 'block truncate', title: row.order }, row.order || '—'));
        dtr.appendChild(oTd);
        const cTd = el('td', { className: 'px-3 py-2 text-slate-400 max-w-[140px]' });
        cTd.appendChild(el('span', { className: 'block truncate', title: row.contract }, row.contract || '—'));
        dtr.appendChild(cTd);
        const sTd = el('td', { className: 'px-3 py-2 text-slate-400 max-w-[130px]' });
        sTd.appendChild(el('span', { className: 'block truncate', title: row.supplier }, row.supplier || '—'));
        dtr.appendChild(sTd);
        const pTd = el('td', { className: 'px-3 py-2 max-w-[120px]' });
        if (row.program) {
          pTd.appendChild(el('span', {
            className: 'inline-block rounded bg-violet-400/15 px-1.5 py-0.5 text-[10px] font-medium text-violet-300 truncate max-w-full',
            title: row.program,
          }, row.program));
        } else {
          pTd.appendChild(el('span', { className: 'text-slate-600' }, '—'));
        }
        dtr.appendChild(pTd);
        dtr.appendChild(el('td', { className: 'px-3 py-2 text-slate-500 whitespace-nowrap' }, row.date || '—'));
        dtr.appendChild(el('td', { className: 'px-3 py-2 text-right tabular-nums text-cyan-400/80 whitespace-nowrap' }, fmt(row.qty)));
        dtr.appendChild(el('td', { className: 'px-3 py-2 text-right tabular-nums text-amber-400/70 whitespace-nowrap' }, fmt(row.shipped)));
        const dBal = row.balance > 0 ? 'text-emerald-400/80 font-semibold' : 'text-slate-500';
        dtr.appendChild(el('td', { className: 'px-3 py-2 text-right tabular-nums whitespace-nowrap ' + dBal }, fmt(row.balance)));
        const dAccTd = el('td', { className: 'px-3 py-2 text-center' });
        dAccTd.appendChild(el('span', {
          className: row.accepted
            ? 'inline-block rounded bg-emerald-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-400'
            : 'inline-block rounded bg-rose-400/10 px-1.5 py-0.5 text-[10px] font-semibold text-rose-400',
        }, row.accepted ? '✓' : '✗'));
        dtr.appendChild(dAccTd);
        dtr.appendChild(el('td', { className: 'w-8' }));
        dBody.appendChild(dtr);
      });
      detailTable.appendChild(dBody);
      detailTd.appendChild(detailTable);
      detailTr.appendChild(detailTd);
      tbody.appendChild(detailTr);
    }
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
  requestAnimationFrame(() => attachFrozenManager(table, 'warehouse-stock'));
}

// ─── Excel export for stock table ────────────────────────────────

function exportStockToExcel() {
  const rows = sortStockRows(filterStockRows(buildStockRows()));
  if (!rows.length) {
    showToast('Нет данных для экспорта', 'error');
    return;
  }

  const headers = [
    'Категория', 'Наименование товара', 'Код товара',
    'Поставщик', 'Контракт', 'Заявка', 'Дата поступления',
    'Поступило (нараст.)', 'Кол-во в поступлении', 'Отгружено', 'Наличие на складе', 'Приёмка',
  ];

  const data = rows.map(r => [
    r.category,
    r.productName,
    r.productCode,
    r.supplier,
    r.contract,
    r.order,
    r.date,
    r.received,
    r.qty,
    r.shipped,
    r.balance,
    r.accepted ? 'Принято' : 'Не принято',
  ]);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data]);
  ws['!cols'] = [18, 30, 15, 22, 28, 18, 14, 16, 16, 12, 16, 14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Наличие');
  XLSX.writeFile(wb, 'Склад_Наличие.xlsx');
  showToast('Файл экспортирован', 'success');
}

// ═══════════════════════════════════════════════════════════════════
// REGISTRY LIST
// ═══════════════════════════════════════════════════════════════════

function getFilteredEntries() {
  const q = searchQuery.toLowerCase().trim();
  return getScopedEntries().filter(e => {
    const accepted = effectiveAccepted(e);
    if (filterStatus === 'accepted'    && !accepted)              return false;
    if (filterStatus === 'notAccepted' &&  accepted)              return false;
    if (filterStatus === 'available'   && (!accepted || e.balance <= 0)) return false;
    if (q) {
      const contract = getContractById(e.contractId);
      const supplier = getSupplierById(e.supplierId);
      const order    = getOrderById(e.orderId);
      const hay = [
        e.productCode, e.productName,
        supplierLabel(supplier), contractLabel(contract), orderLabel(order),
        e.date, e.notes,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
}

function renderList() {
  const wrap = $('warehouseListWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const total = getScopedEntries();
  const searchInput = $('warehouseSearch');
  if (searchInput) {
    searchInput.setAttribute('list', 'warehouseRegistrySearchOptions');
    let list = document.getElementById('warehouseRegistrySearchOptions');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'warehouseRegistrySearchOptions';
      searchInput.insertAdjacentElement('afterend', list);
    }
    const options = [...new Set(total.flatMap(entry => {
      const contract = getContractById(entry.contractId);
      const supplier = getSupplierById(entry.supplierId);
      const order = getOrderById(entry.orderId);
      return [entry.productCode, entry.productName, supplierLabel(supplier), contractLabel(contract), orderLabel(order), entry.date]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    }))].sort((a, b) => a.localeCompare(b, 'ru'));
    list.innerHTML = options.map(option => `<option value="${option.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`).join('');
    enhancePredictiveInput(searchInput, {
      listId: 'warehouseRegistrySearchOptions',
      options,
      icon: '🔍',
      minWidth: '220px',
    });
  }

  const entries = getFilteredEntries();

  if (total.length > 0) {
    const totalReceived = total.reduce((s, e) => s + (e.received || 0), 0);
    const totalShipped  = total.reduce((s, e) => s + (e.shipped  || 0), 0);
    const totalBalance  = totalReceived - totalShipped;
    const summary = el('div', { className: 'flex gap-4 flex-wrap mb-3 px-1' });
    const mkStat = (label, val, color) => {
      const s = el('div', { className: 'flex flex-col' });
      s.appendChild(el('span', { className: 'text-[10px] uppercase tracking-wider text-slate-500' }, label));
      s.appendChild(el('span', { className: 'text-sm font-bold ' + color + ' tabular-nums' }, String(val)));
      return s;
    };
    summary.append(
      mkStat(t('warehouse.totalReceived'), totalReceived, 'text-cyan-400'),
      mkStat(t('warehouse.totalShipped'),  totalShipped,  'text-amber-400'),
      mkStat(t('warehouse.totalBalance'),  totalBalance,  totalBalance > 0 ? 'text-emerald-400' : 'text-slate-400'),
    );
    wrap.appendChild(summary);
  }

  if (entries.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-16 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '🏭'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' },
      total.length === 0 ? t('warehouse.empty') : 'Ничего не найдено'));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' },
      total.length === 0 ? t('warehouse.emptyHint') : 'Попробуйте изменить фильтры'));
    wrap.appendChild(empty);
    return;
  }

  entries.forEach(entry => {
    const contract = getContractById(entry.contractId);
    const supplier = getSupplierById(entry.supplierId);
    const order    = getOrderById(entry.orderId);
    const balance  = entry.balance;

    const card = el('div', {
      className: 'group relative rounded-2xl border border-white/10 bg-white/[0.04] p-4 hover:bg-white/[0.07] hover:border-cyan-400/20 transition cursor-pointer',
    });

    // Список товаров в поступлении
    const itemsList = Array.isArray(entry.items) && entry.items.length > 0
      ? entry.items.filter(i => Number(i.qty) > 0)
      : [];
    const itemsHtml = itemsList.length > 0
      ? itemsList.map(i => {
          const codeSpan = i.productCode
            ? '<span class="font-mono text-cyan-400/80 text-[10px] bg-cyan-400/10 rounded px-1">' + i.productCode + '</span> '
            : '';
          return '<span class="inline-flex items-center gap-1">' + codeSpan + (i.productName || '') + ' ×' + i.qty + '</span>';
        }).join('<span class="text-slate-600 mx-1">·</span>')
      : ('<span class="font-mono text-cyan-400/80 text-[10px] bg-cyan-400/10 rounded px-1">' +
          (entry.productCode || '') + '</span> ' + (entry.productName || '—'));

    const supplierHtml = supplier ? '<span>🏢 ' + supplierLabel(supplier) + '</span>' : '';
    const contractHtml = contract ? '<span>📝 ' + contractLabel(contract) + '</span>' : '';
    const orderHtml    = order    ? '<span>📋 ' + orderLabel(order) + '</span>' : '';
    const dateHtml     = entry.date ? '<span>📅 ' + entry.date + '</span>' : '';
    const balClass     = balance > 0 ? 'text-emerald-400' : 'text-slate-400';

    const wh = entry.warehouseId != null ? (state.warehouses || []).find(w => w.id === entry.warehouseId) : null;
    const warehouseHtml = (activeWarehouseId == null && wh) ? '<span>🏭 ' + wh.name + '</span>' : '';

    card.innerHTML =
      '<div class="flex items-start justify-between gap-3">' +
        '<div class="min-w-0 flex-1">' +
          '<p class="text-xs text-slate-300 flex flex-wrap gap-x-2 gap-y-0.5 mb-1.5">' + itemsHtml + '</p>' +
          '<div class="flex flex-wrap gap-x-4 gap-y-0.5 text-xs text-slate-400">' +
            warehouseHtml + supplierHtml + contractHtml + orderHtml + dateHtml +
          '</div>' +
        '</div>' +
        '<div class="shrink-0 text-right space-y-1">' +
          '<div class="text-xs text-slate-500">Поступило</div>' +
          '<div class="text-sm font-bold text-cyan-400 tabular-nums">' + entry.received + '</div>' +
          '<div class="text-xs text-slate-500">Остаток</div>' +
          '<div class="text-sm font-bold ' + balClass + ' tabular-nums">' + balance + '</div>' +
        '</div>' +
      '</div>';

    card.addEventListener('click', () => openCard(entry.id));

    const delBtn = el('button', {
      className: 'absolute top-3 right-3 hidden group-hover:flex items-center justify-center w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition text-xs',
      'aria-label': t('actions.delete'),
      title: t('actions.delete'),
    }, '✕');
    delBtn.addEventListener('click', e => { e.stopPropagation(); handleDelete(entry.id); });
    card.appendChild(delBtn);
    wrap.appendChild(card);
  });
}

// ═══════════════════════════════════════════════════════════════════
// CARD
// ═══════════════════════════════════════════════════════════════════

function openCard(entryId) {
  editingEntryId = entryId !== undefined ? entryId : null;
  cardItems = [];
  renderCard(editingEntryId);
  showCardPanel();
}

function renderCard(entryId) {
  const wrap = $('warehouseCardWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const entry = entryId != null
    ? state.warehouseEntries.find(e => e.id === entryId) || null
    : null;

  const title = $('warehouseCardTitle');
  if (title) title.textContent = entry ? t('warehouse.cardTitle') : t('warehouse.newCard');

  const form = el('div', { className: 'space-y-5' });

  // Contract
  const contractWrap = el('div', {});
  contractWrap.appendChild(el('label', {
    for: 'whContractSel',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, t('warehouse.fieldContract')));
  const contractSel = el('select', {
    id: 'whContractSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  contractSel.appendChild(el('option', { value: '' }, t('warehouse.selectContract')));
  state.contracts.forEach(c => {
    const opt = el('option', { value: String(c.id) }, contractLabel(c));
    if (entry && c.id === entry.contractId) opt.selected = true;
    contractSel.appendChild(opt);
  });
  contractWrap.appendChild(contractSel);
  form.appendChild(contractWrap);

  // Supplier (readonly)
  const supplierWrap = el('div', {});
  supplierWrap.appendChild(el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, t('warehouse.fieldSupplier')));
  const supplierDisplay = el('div', {
    id: 'whSupplierDisplay',
    className: 'rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-slate-300 min-h-[42px]',
  });
  if (entry && entry.contractId) {
    const c = getContractById(entry.contractId);
    const s = c ? getSupplierById(c.supplierId) : null;
    supplierDisplay.textContent = s ? supplierLabel(s) : '—';
    supplierDisplay.dataset.supplierId = String(c ? c.supplierId : '');
  } else {
    supplierDisplay.textContent = '—';
    supplierDisplay.dataset.supplierId = '';
  }
  supplierWrap.appendChild(supplierDisplay);
  form.appendChild(supplierWrap);

  // Order
  const orderWrap = el('div', {});
  orderWrap.appendChild(el('label', {
    for: 'whOrderSel',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, t('warehouse.fieldOrder')));
  const orderSel = el('select', {
    id: 'whOrderSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    required: 'true',
  });
  const initContractId = entry ? entry.contractId : null;
  populateOrderSelect(orderSel, initContractId, entry ? entry.orderId : null);
  orderWrap.appendChild(orderSel);
  orderWrap.appendChild(el('p', {
    className: 'mt-1 text-[11px] text-slate-500',
  }, 'Здесь доступны только отправленные заявки с поставкой на склад. Прямые поставки выбрать нельзя.'));
  form.appendChild(orderWrap);

  // Date
  const dateWrap = el('div', {});
  dateWrap.appendChild(el('label', {
    for: 'whDate',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, t('warehouse.fieldDate')));
  const dateInp = el('input', {
    id: 'whDate',
    type: 'date',
    value: entry ? (entry.date || '') : '',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  dateWrap.appendChild(dateInp);
  form.appendChild(dateWrap);

  // Items section
  const itemsSection = el('div', { id: 'whItemsSection', className: 'space-y-2' });
  form.appendChild(itemsSection);

  if (entry && entry.orderId) {
    renderItemsTableFromOrder(itemsSection, entry.orderId, initContractId, entry);
  } else {
    renderItemsTableFromContract(itemsSection, initContractId, entry);
  }

  // Notes
  const notesWrap = el('div', {});
  notesWrap.appendChild(el('label', {
    for: 'whNotes',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, t('warehouse.fieldNotes')));
  const notesTA = el('textarea', {
    id: 'whNotes',
    rows: '2',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07] resize-none',
    placeholder: t('warehouse.notesPlaceholder'),
  });
  notesTA.value = entry ? (entry.notes || '') : '';
  notesWrap.appendChild(notesTA);
  form.appendChild(notesWrap);

  // Import button
  const importBtnWrap = el('div', { className: 'pt-1' });
  const importBtn = el('button', {
    type: 'button',
    id: 'whImportFromCardBtn',
    className: 'inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:border-cyan-400/30 active:scale-[0.97] w-full justify-center',
  });
  importBtn.innerHTML = '<span aria-hidden="true">📄</span><span>Импорт из Excel</span>';
  importBtn.addEventListener('click', () => {
    renderImportPanel();
    showImportPanel();
  });
  importBtnWrap.appendChild(importBtn);
  form.appendChild(importBtnWrap);

  wrap.appendChild(form);

  // Wire: contract change
  contractSel.addEventListener('change', () => {
    const cid = contractSel.value ? Number(contractSel.value) : null;
    const c = cid ? getContractById(cid) : null;
    const s = c ? getSupplierById(c.supplierId) : null;
    const sd = document.getElementById('whSupplierDisplay');
    if (sd) {
      sd.textContent = s ? supplierLabel(s) : '—';
      sd.dataset.supplierId = String(c ? c.supplierId : '');
    }
    const oSel = document.getElementById('whOrderSel');
    if (oSel) populateOrderSelect(oSel, cid, null);
    const sec = document.getElementById('whItemsSection');
    if (sec) {
      clearChildren(sec);
      cardItems = [];
      renderItemsTableFromContract(sec, cid, null);
    }
  });

  // Wire: order change
  orderSel.addEventListener('change', () => {
    const oid = orderSel.value ? Number(orderSel.value) : null;
    const cid = contractSel.value ? Number(contractSel.value) : null;
    const sec = document.getElementById('whItemsSection');
    if (!sec) return;
    clearChildren(sec);
    cardItems = [];
    if (oid) {
      renderItemsTableFromOrder(sec, oid, cid, null);
    } else {
      renderItemsTableFromContract(sec, cid, null);
    }
  });
}

// ─── Order select population ──────────────────────────────────────

function populateOrderSelect(sel, contractId, selectedOrderId) {
  clearChildren(sel);
  sel.appendChild(el('option', { value: '' }, '— Выберите заявку —'));
  const sent = getSentOrders(contractId);
  sent.forEach(o => {
    const opt = el('option', { value: String(o.id) }, orderLabel(o));
    if (selectedOrderId && o.id === selectedOrderId) opt.selected = true;
    sel.appendChild(opt);
  });

  const selectedOrder = selectedOrderId ? getOrderById(selectedOrderId) : null;
  if (selectedOrder && !sent.some(o => o.id === selectedOrder.id) && !isWarehouseDeliveryOrder(selectedOrder)) {
    const legacyOpt = el(
      'option',
      { value: String(selectedOrder.id), selected: 'true', disabled: 'true' },
      (orderLabel(selectedOrder) || ('Заявка #' + selectedOrder.id)) + ' — прямая поставка, недоступна для склада',
    );
    sel.appendChild(legacyOpt);
  }

  if (sent.length === 0) {
    sel.appendChild(el('option', { value: '', disabled: 'true' },
      contractId ? 'Нет отправленных заявок на поставку на склад по этому контракту' : 'Выберите контракт'));
  }
}

// ─── Items table: from CONTRACT ───────────────────────────────────

function renderItemsTableFromContract(section, contractId, entry) {
  if (!contractId) {
    section.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, t('warehouse.selectContractFirst')));
    return;
  }
  const contract = getContractById(contractId);
  if (!contract) return;
  const contractItems = (contract.items || []).filter(i => i.qty > 0 && (i.name || '').trim());
  if (contractItems.length === 0) {
    section.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, t('warehouse.noProductsInContract')));
    return;
  }
  const entryItems = entry ? (entry.items || []) : [];
  cardItems = contractItems.flatMap(ci => buildWarehouseRowsForContractItem(ci).map(item => {
    const existing = entryItems.find(ei =>
      (item.variantId && (ei.variantId === item.variantId || ei.colorCode === item.colorCode)) ||
      (item.productCode && ei.productCode === item.productCode) ||
      (item.productId && ei.productId === item.productId && !item.variantId)
    );
    return {
      ...item,
      qty: existing ? existing.qty : 0,
    };
  })).filter(i => i.productName || i.productCode);
  renderItemsTableDOM(section, 'Товары контракта', null);
}

// ─── Items table: from ORDER ──────────────────────────────────────

function renderItemsTableFromOrder(section, orderId, contractId, entry) {
  if (!orderId) {
    renderItemsTableFromContract(section, contractId, entry);
    return;
  }
  const order = getOrderById(orderId);
  if (!order) {
    section.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, 'Заявка не найдена'));
    return;
  }
  const rows = order.deliveryRows || [];
  if (rows.length === 0) {
    section.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, 'В заявке нет товаров'));
    return;
  }
  const grouped = new Map();
  rows.forEach(r => {
    const productScope = String(
      r.productId
      || (r.baseCode || '').trim()
      || (r.contractItemCode || '').trim()
      || (r.contractItemName || '').trim()
    ).toLowerCase();
    const variantScope = String(r.variantId || r.colorCode || '').trim().toLowerCase();
    const key = variantScope
      ? `${productScope}::${variantScope}`
      : `${productScope}::base`;
    if (!productScope) return;
    if (!grouped.has(key)) {
      grouped.set(key, {
        code: (r.contractItemCode || '').trim(),
        baseCode: (r.baseCode || '').trim(),
        price: Number(r.price) || 0,
        totalQty: 0,
        productId: r.productId ?? null,
        variantId: r.variantId || '',
        colorCode: r.colorCode || '',
        displayName: r.displayName || r.contractItemName || '',
        contractItemName: r.contractItemName || '',
      });
    }
    grouped.get(key).totalQty += Number(r.qty) || 0;
  });
  const entryItems = entry ? (entry.items || []) : [];
  cardItems = [];
  grouped.forEach((v) => {
    let product = v.productId ? state.products.find(p => p.id === v.productId) : null;
    if (!product && v.code) product = state.products.find(p => p.code && p.code.trim() === v.code);
    if (!product && v.contractItemName) product = state.products.find(p => p.name && p.name.trim().toLowerCase() === v.contractItemName.toLowerCase());
    const existing = entryItems.find(ei => {
      const sameProduct =
        (v.productId && ei.productId && String(ei.productId) === String(v.productId)) ||
        (v.code && ei.productCode === v.code) ||
        (v.displayName && ei.productName === v.displayName) ||
        (v.contractItemName && ei.productName === v.contractItemName);

      if (v.variantId || v.colorCode) {
        return sameProduct && (ei.variantId === v.variantId || ei.colorCode === v.colorCode);
      }

      return sameProduct;
    });
    cardItems.push({
      productId:   product ? product.id : v.productId,
      productCode: v.code || (product ? product.code : '') || '',
      productName: v.displayName || v.contractItemName,
      displayName: v.displayName || v.contractItemName,
      category: resolveCategory(product ? product.id : v.productId, v.code || (product ? product.code : '') || '', v.contractItemName),
      price:       v.price,
      qty:         existing ? existing.qty : 0,
      baseCode:    v.baseCode || '',
      colorCode:   v.colorCode || '',
      variantId:   v.variantId || '',
      isColorVariant: Boolean(v.variantId || v.colorCode),
    });
  });
  renderItemsTableDOM(section, 'Товары заявки ' + (order.orderNumber || '#' + order.id), orderId);
}

// ─── Shared items table DOM builder ──────────────────────────────

function renderItemsTableDOM(section, sectionLabel, orderId) {
  if (cardItems.length === 0) {
    section.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, 'Нет товаров для отображения'));
    return;
  }
  section.appendChild(el('div', {
    className: 'text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1',
  }, sectionLabel));

  if (orderId) {
    const banner = el('div', {
      className: 'flex items-center gap-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] px-3 py-2 mb-2',
    });
    banner.appendChild(el('span', { className: 'text-cyan-400 text-xs' }, 'ℹ'));
    banner.appendChild(el('span', { className: 'text-xs text-slate-400' },
      'Кол-во поступившего отслеживается нарастающим итогом. Поле показывает: поступило сейчас / доступно по заявке.'));
    section.appendChild(banner);
  }

  const tableWrap = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
  const table = el('table', { className: 'w-full text-xs text-slate-300 border-collapse' });
  const thead = el('thead', {});
  const hrow = el('tr', { className: 'border-b border-white/10 bg-white/5' });
  [
    { label: t('warehouse.colName'),  cls: 'text-left' },
    { label: t('warehouse.colCode'),  cls: 'text-left' },
    { label: t('warehouse.colQty'),   cls: 'text-center w-36' },
    { label: t('warehouse.colPrice'), cls: 'text-right' },
    { label: t('warehouse.colCost'),  cls: 'text-right' },
  ].forEach(({ label, cls }) => {
    hrow.appendChild(el('th', { className: 'px-3 py-2 font-semibold text-slate-400 whitespace-nowrap ' + cls }, label));
  });
  thead.appendChild(hrow);
  table.appendChild(thead);
  const tbody = el('tbody', { id: 'whItemsTbody' });
  cardItems.forEach((item, idx) => renderItemRow(tbody, item, idx, orderId));
  table.appendChild(tbody);
  const tfoot = el('tfoot', {});
  const frow = el('tr', { className: 'border-t border-white/10 bg-white/[0.03]' });
  frow.appendChild(el('td', { colspan: '4', className: 'px-3 py-2 text-right text-xs font-semibold text-slate-400' }, 'Итого стоимость:'));
  frow.appendChild(el('td', { id: 'whTotalCost', className: 'px-3 py-2 text-right text-sm font-bold text-emerald-400 tabular-nums whitespace-nowrap' }, calcTotalCost()));
  tfoot.appendChild(frow);
  table.appendChild(tfoot);
  tableWrap.appendChild(table);
  section.appendChild(tableWrap);
}

// ─── Item row ─────────────────────────────────────────────────────

function renderItemRow(tbody, item, idx, orderId) {
  const tr = el('tr', { className: 'border-b border-white/5 hover:bg-white/[0.03] transition' });

  const hasOrder  = !!orderId;
  const ordered   = hasOrder ? getOrderedQty(orderId, item.productName, item.productCode) : 0;
  const received  = hasOrder ? getAlreadyReceived(orderId, item.productName, item.productCode) : 0;
  const limit     = hasOrder ? Math.max(0, ordered - received) : Infinity;
  const exhausted = hasOrder && limit === 0;

  if (hasOrder && item.qty > limit) item.qty = limit;

  const nameTd = el('td', { className: 'px-3 py-2 max-w-[180px]' });
  nameTd.appendChild(el('span', { className: 'block truncate text-white text-xs', title: item.productName }, item.productName || '—'));
  if (hasOrder && received > 0) {
    nameTd.appendChild(el('span', { className: 'block text-[10px] text-amber-400/80 mt-0.5' }, 'уже поступило: ' + received + ' шт.'));
  }
  tr.appendChild(nameTd);

  tr.appendChild(el('td', { className: 'px-3 py-2 font-mono text-cyan-400/80 whitespace-nowrap' }, item.productCode || '—'));

  const qtyTd = el('td', { className: 'px-2 py-1.5 text-center' });
  const qtyWrap = el('div', { className: 'flex flex-col items-center gap-1' });

  const inputBorderClass = exhausted
    ? 'border-rose-500/50 bg-rose-500/[0.08] cursor-not-allowed'
    : 'border-white/10 bg-white/5 focus:border-cyan-400/50';

  const limitStr = isFinite(limit) ? String(limit) : '';
  const titleStr = hasOrder
    ? ('По заявке: ' + ordered + ' шт. | Уже поступило: ' + received + ' шт. | Доступно: ' + (isFinite(limit) ? limit : '∞') + ' шт.')
    : '';

  const qtyInp = el('input', {
    type: 'number', min: '0',
    max: limitStr,
    value: String(item.qty),
    className: 'w-24 rounded-lg border px-2 py-1 text-center text-sm text-white focus:outline-none tabular-nums transition ' + inputBorderClass,
    'aria-label': 'Количество: ' + item.productName,
    title: titleStr,
  });
  if (exhausted) qtyInp.setAttribute('disabled', 'true');

  const limitBadge = el('div', { className: 'text-[10px] tabular-nums whitespace-nowrap' });
  function updateBadge(currentQty) {
    if (!hasOrder) { limitBadge.textContent = ''; return; }
    const totalAfter = received + currentQty;
    if (exhausted && currentQty === 0) {
      limitBadge.className = 'text-[10px] tabular-nums whitespace-nowrap text-rose-400 font-semibold';
      limitBadge.textContent = '✗ лимит исчерпан';
    } else if (totalAfter > ordered) {
      limitBadge.className = 'text-[10px] tabular-nums whitespace-nowrap text-rose-400 font-semibold';
      limitBadge.textContent = '⚠ +' + (totalAfter - ordered) + ' сверх';
    } else if (totalAfter === ordered) {
      limitBadge.className = 'text-[10px] tabular-nums whitespace-nowrap text-emerald-400 font-semibold';
      limitBadge.textContent = '✓ ' + currentQty + ' / ' + limit;
    } else {
      limitBadge.className = 'text-[10px] tabular-nums whitespace-nowrap text-slate-400';
      limitBadge.textContent = currentQty + ' / ' + (isFinite(limit) ? limit : '∞');
    }
  }
  updateBadge(item.qty);

  qtyInp.addEventListener('input', () => {
    let val = Number(qtyInp.value) || 0;
    if (hasOrder && isFinite(limit) && val > limit) {
      val = limit;
      qtyInp.value = String(val);
      qtyInp.style.borderColor = 'rgba(239,68,68,0.7)';
      qtyInp.style.background  = 'rgba(239,68,68,0.08)';
      setTimeout(() => { qtyInp.style.borderColor = ''; qtyInp.style.background = ''; }, 900);
    }
    cardItems[idx].qty = val;
    updateBadge(val);
    const costCell = tbody.querySelectorAll('tr')[idx]?.querySelector('.whCostCell');
    if (costCell) costCell.textContent = fmt(val * cardItems[idx].price) + ' ₽';
    const totalCell = document.getElementById('whTotalCost');
    if (totalCell) totalCell.textContent = calcTotalCost();
  });

  qtyWrap.append(qtyInp, limitBadge);
  qtyTd.appendChild(qtyWrap);
  tr.appendChild(qtyTd);

  tr.appendChild(el('td', { className: 'px-3 py-2 text-right tabular-nums text-slate-300 whitespace-nowrap' }, fmt(item.price) + ' ₽'));
  tr.appendChild(el('td', { className: 'px-3 py-2 text-right tabular-nums text-emerald-400 font-semibold whitespace-nowrap whCostCell' }, fmt(item.qty * item.price) + ' ₽'));

  tbody.appendChild(tr);
}

function calcTotalCost() {
  return fmt(cardItems.reduce((s, i) => s + (i.qty * i.price), 0)) + ' ₽';
}

// ─── Overage check ────────────────────────────────────────────────

function checkOverages(orderId) {
  if (!orderId) return [];
  return cardItems.flatMap(item => {
    const ordered  = getOrderedQty(orderId, item.productName, item.productCode);
    const received = getAlreadyReceived(orderId, item.productName, item.productCode);
    const newTotal = received + item.qty;
    if (newTotal > ordered && ordered > 0) {
      return ['«' + item.productName + '»: по заявке ' + ordered + ' шт., уже поступило ' + received + ' шт., сейчас вводится ' + item.qty + ' шт. → итого ' + newTotal + ' (превышение: ' + (newTotal - ordered) + ')'];
    }
    return [];
  });
}

// ─── Save Card ────────────────────────────────────────────────────

async function saveCard() {
  const contractIdRaw = document.getElementById('whContractSel')?.value;
  const contractId = contractIdRaw ? Number(contractIdRaw) : null;
  const orderIdRaw = document.getElementById('whOrderSel')?.value;
  const orderId = orderIdRaw ? Number(orderIdRaw) : null;
  const selectedOrder = orderId ? getOrderById(orderId) : null;

  if (!orderId) {
    showToast('Выберите заявку (только отправленные)', 'error');
    return;
  }
  if (!isWarehouseDeliveryOrder(selectedOrder)) {
    showToast('Для поступления на склад можно выбрать только заявку на поставку на склад', 'error');
    return;
  }
  if (cardItems.length > 0 && !cardItems.some(i => i.qty > 0)) {
    showToast('Укажите количество хотя бы для одного товара', 'error');
    return;
  }

  const overages = checkOverages(orderId);
  if (overages.length > 0) {
    const msg = '⚠️ Количество поступившего превышает количество в заявке:\n\n' +
      overages.map(o => '• ' + o).join('\n') +
      '\n\nСохранить несмотря на превышение?';
    if (!confirm(msg)) return;
  }

  const contract   = contractId ? getContractById(contractId) : null;
  const supplierId = contract ? contract.supplierId : null;
  const date  = document.getElementById('whDate')?.value || '';
  const notes = (document.getElementById('whNotes')?.value || '').trim();
  const itemsWithQty = cardItems.filter(i => i.qty > 0);
  const totalReceived = itemsWithQty.reduce((s, i) => s + i.qty, 0);

  const existingEntry = editingEntryId != null
    ? state.warehouseEntries.find(e => e.id === editingEntryId)
    : null;

  const data = {
    contractId, supplierId, orderId, date, notes,
    received: totalReceived,
    shipped: existingEntry ? (existingEntry.shipped || 0) : 0,
    accepted: false, // вычисляется динамически из актов
    warehouseId: activeWarehouseId,
    items: itemsWithQty.map(i => ({
      productId: i.productId,
      productCode: i.productCode,
      productName: i.productName,
      baseCode: i.baseCode || '',
      colorCode: i.colorCode || '',
      variantId: i.variantId || '',
      category: i.category || resolveCategory(i.productId, i.productCode, i.productName),
      price: i.price,
      qty: i.qty,
      cost: i.qty * i.price,
    })),
    productId:   itemsWithQty[0] ? itemsWithQty[0].productId   : null,
    productCode: itemsWithQty[0] ? itemsWithQty[0].productCode : '',
    productName: itemsWithQty.length === 1
      ? (itemsWithQty[0].productName || '') : (itemsWithQty.length + ' товаров'),
    category: itemsWithQty.length === 1
      ? (itemsWithQty[0].category || resolveCategory(itemsWithQty[0].productId, itemsWithQty[0].productCode, itemsWithQty[0].productName)) : '',
  };

  if (editingEntryId != null) {
    updateWarehouseEntry(editingEntryId, data);
  } else {
    addWarehouseEntry(data);
  }

  await saveToStorage();
  showToast(t('warehouse.saved'), 'success');
  updateWarehouseBadge();
  cardItems = [];
  showListPanel();
}

// ─── Delete ───────────────────────────────────────────────────────

async function handleDelete(id) {
  if (!confirm(t('warehouse.confirmDelete'))) return;
  deleteWarehouseEntry(id);
  await saveToStorage();
  showToast(t('warehouse.deleted'), 'success');
  updateWarehouseBadge();
  renderList();
}

// ═══════════════════════════════════════════════════════════════════
// IMPORT PANEL
// ═══════════════════════════════════════════════════════════════════

let importRows = [];

function renderImportPanel() {
  const preview = $('warehouseImportPreview');
  if (preview) clearChildren(preview);
  const confirmBtn = $('warehouseImportConfirmBtn');
  if (confirmBtn) confirmBtn.classList.add('hidden');
  importRows = [];
  const status = $('warehouseImportStatus');
  if (status) status.textContent = '';
}

function handleImportFile(file) {
  if (!file) return;
  const status = $('warehouseImportStatus');
  if (status) status.textContent = 'Читаем файл…';

  const reader = new FileReader();
  reader.onload = e => {
    try {
      const wb = XLSX.read(e.target.result, { type: 'binary' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      const rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (!rows.length) {
        if (status) status.textContent = t('warehouse.importNoData');
        return;
      }

      const colMap = {
        code:     ['код товара', 'код', 'code', 'артикул'],
        name:     ['наименование', 'товар', 'name', 'наименование товара'],
        supplier: ['поставщик', 'supplier'],
        contract: ['контракт', 'contract', 'номер контракта'],
        order:    ['заявка', 'order', 'номер заявки'],
        date:     ['дата поступления', 'дата', 'date'],
        qty:      ['кол-во', 'количество', 'qty', 'количество поступившего', 'кол-во поступило'],
      };

      function findCol(row, aliases) {
        for (const key of Object.keys(row)) {
          const lk = key.toLowerCase().trim();
          if (aliases.some(a => lk.includes(a))) return key;
        }
        return null;
      }

      const firstRow = rows[0];
      const keys = {};
      for (const [field, aliases] of Object.entries(colMap)) {
        keys[field] = findCol(firstRow, aliases);
      }

      importRows = rows.map(row => {
        const code     = String(row[keys.code]     || '').trim();
        const name     = String(row[keys.name]     || '').trim();
        const supplier = String(row[keys.supplier] || '').trim();
        const contract = String(row[keys.contract] || '').trim();
        const order    = String(row[keys.order]    || '').trim();
        const date     = String(row[keys.date]     || '').trim();
        const qty      = Number(row[keys.qty]      || 0);

        const matchedSupplier = (state.suppliers || []).find(s =>
          s.name.toLowerCase().includes(supplier.toLowerCase()) && supplier);
        const matchedContract = state.contracts.find(c =>
          (c.number && c.number.toLowerCase().includes(contract.toLowerCase()) && contract) ||
          (c.title  && c.title.toLowerCase().includes(contract.toLowerCase())  && contract));
        const matchedOrder = (state.orders || []).find(o =>
          o.orderNumber &&
          o.orderNumber.toLowerCase().includes(order.toLowerCase()) &&
          order &&
          isWarehouseDeliveryOrder(o));
        const matchedProduct = code
          ? state.products.find(p => p.code && p.code.toLowerCase() === code.toLowerCase()) : null;
        const resolvedCategory = resolveCategory(matchedProduct ? matchedProduct.id : null, code, matchedProduct ? matchedProduct.name : name);

        return {
          productCode: code,
          productName: matchedProduct ? matchedProduct.name : name,
          productId:   matchedProduct ? matchedProduct.id : null,
          category:    resolvedCategory,
          supplierId:  matchedSupplier ? matchedSupplier.id : null,
          contractId:  matchedContract ? matchedContract.id : null,
          orderId:     matchedOrder    ? matchedOrder.id    : null,
          date, notes: '',
          items: [{
            productCode: code,
            productName: matchedProduct ? matchedProduct.name : name,
            productId:   matchedProduct ? matchedProduct.id  : null,
            category: resolvedCategory, price: 0, qty, cost: 0,
          }],
          received: qty, shipped: 0, accepted: false,
        };
      }).filter(r => r.productName || r.productCode);

      if (status) status.textContent = 'Найдено строк: ' + importRows.length;

      const preview = $('warehouseImportPreview');
      if (preview) {
        clearChildren(preview);
        if (importRows.length > 0) {
          const tableWrap = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
          const t2 = el('table', { className: 'w-full text-xs text-slate-300 border-collapse' });
          const thead2 = el('thead', {});
          const hrow2 = el('tr', { className: 'border-b border-white/10 bg-white/5' });
          ['Код', 'Наименование', 'Контракт/Заявка', 'Дата', 'Кол-во'].forEach(h => {
            hrow2.appendChild(el('th', { className: 'px-3 py-2 text-left font-semibold text-slate-400 whitespace-nowrap' }, h));
          });
          thead2.appendChild(hrow2);
          t2.appendChild(thead2);
          const tbody2 = el('tbody', {});
          importRows.slice(0, 10).forEach(r => {
            const tr = el('tr', { className: 'border-b border-white/5' });
            const rc = getContractById(r.contractId);
            const ro = getOrderById(r.orderId);
            const coStr = [contractLabel(rc), orderLabel(ro)].filter(Boolean).join(' / ') || '—';
            [r.productCode, r.productName, coStr, r.date, String(r.received)].forEach(val => {
              tr.appendChild(el('td', { className: 'px-3 py-2 max-w-[140px] truncate' }, val || '—'));
            });
            tbody2.appendChild(tr);
          });
          if (importRows.length > 10) {
            const tr2 = el('tr', {});
            tr2.appendChild(el('td', { colspan: '6', className: 'px-3 py-2 text-slate-500 text-center' }, '… и ещё ' + (importRows.length - 10) + ' строк'));
            tbody2.appendChild(tr2);
          }
          t2.appendChild(tbody2);
          tableWrap.appendChild(t2);
          preview.appendChild(tableWrap);
        }
      }

      const confirmBtn = $('warehouseImportConfirmBtn');
      if (confirmBtn && importRows.length > 0) {
        confirmBtn.textContent = t('warehouse.importConfirm', { count: importRows.length });
        confirmBtn.classList.remove('hidden');
      }
    } catch (err) {
      console.error(err);
      if (status) status.textContent = t('warehouse.importError');
    }
  };
  reader.readAsBinaryString(file);
}

async function confirmImport() {
  if (!importRows.length) return;
  importRows.forEach(r => addWarehouseEntry({ ...r, warehouseId: activeWarehouseId }));
  await saveToStorage();
  showToast(t('warehouse.importSuccess', { count: importRows.length }), 'success');
  updateWarehouseBadge();
  importRows = [];
  showListPanel();
}

// ═══════════════════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════════════════

export function initWarehouseView() {
  const overlay = $('warehouseModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeWarehouseModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeWarehouseModal();
  });

  // Home panel
  // warehouseBackHomeBtn is wired in main.js to go back to locations list
  $('warehouseCloseBtn')?.addEventListener('click', () => {
    // Return to locations list instead of closing modal
    $('warehouseHomePanel')?.classList.add('hidden');
    $('whLocationsListPanel')?.classList.remove('hidden');
  });
  $('warehouseGoStockBtn')?.addEventListener('click', showStockPanel);
  $('warehouseGoRegistryBtn')?.addEventListener('click', showListPanel);
  $('warehouseGoShipmentBtn')?.addEventListener('click', () => {
    import('./shipment-view.js').then(m => m.showShipmentPanel());
  });
  $('warehouseGoShipmentsRegistryBtn')?.addEventListener('click', () => {
    import('./shipment-view.js').then(m => m.showShipmentsRegistry());
  });
  $('warehouseGoDirectDeliveriesBtn')?.addEventListener('click', () => {
    import('./direct-deliveries-view.js').then(m => m.openDirectDeliveriesRegistry());
  });
  $('warehouseShipmentsRegistryCloseBtn')?.addEventListener('click', closeWarehouseModal);

  // Stock panel
  $('warehouseStockBackBtn')?.addEventListener('click', showHomePanel);
  $('warehouseStockCloseBtn')?.addEventListener('click', closeWarehouseModal);
  $('warehouseStockExportBtn')?.addEventListener('click', exportStockToExcel);
  $('warehouseStockSearch')?.addEventListener('input', e => {
    stockQuery = e.target.value;
    renderStockTable();
  });

  // Registry list panel
  $('warehouseListBackBtn')?.addEventListener('click', showHomePanel);
  $('warehouseListCloseBtn')?.addEventListener('click', closeWarehouseModal);
  $('warehouseAddBtn')?.addEventListener('click', () => openCard(null));
  $('warehouseSearch')?.addEventListener('input', e => {
    searchQuery = e.target.value;
    renderList();
  });

  document.querySelectorAll('[data-wh-filter]').forEach(btn => {
    btn.addEventListener('click', () => {
      filterStatus = btn.dataset.whFilter;
      document.querySelectorAll('[data-wh-filter]').forEach(b => {
        const active = b.dataset.whFilter === filterStatus;
        b.classList.toggle('bg-cyan-400/20', active);
        b.classList.toggle('text-white', active);
        b.classList.toggle('text-slate-400', !active);
      });
      renderList();
    });
  });

  // Card panel
  $('warehouseCardBackBtn')?.addEventListener('click', () => {
    cardItems = [];
    showListPanel();
  });
  $('warehouseCardSaveBtn')?.addEventListener('click', saveCard);

  // Import panel
  $('warehouseImportBackBtn')?.addEventListener('click', () => showListPanel());

  const fileInput = $('warehouseImportFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      if (e.target.files[0]) handleImportFile(e.target.files[0]);
    });
  }

  const dropZone = $('warehouseImportDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file) handleImportFile(file);
    });
  }

  $('warehouseImportConfirmBtn')?.addEventListener('click', confirmImport);
  $('warehouseImportCancelBtn')?.addEventListener('click', () => showListPanel());
}
