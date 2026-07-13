/**
 * Contracts View
 * Panel 1: list of contracts (modal-panel)
 * Panel 2: full-screen contract card editor
 *
 * Items are entered manually; product name field has predictive autocomplete from the catalog.
 * СО-статус определяется по актам проверки СО или по переключателю в карточке контракта.
 */

import { state, addContract, addProduct, updateContract, deleteContract, getContractById, getProgramNames, getPrograms, calcContractDelivered, calcContractAssembled, findLotByNumber, getLotById, bindContractToLot, clearContractBindingFromLots, syncLotsWithContracts, syncLotsFromContractCards, buildProductFullCode, hasProductColorVariants, getProductColorVariants, getContractExecutionPolicy, getContractAdvanceAmount, buildOrderPaymentPlan } from '../state.js';
import { calcTotalNeedForProduct, calcTotalContractedForProduct } from '../state.js';
import { attachFrozenManager, refreshFrozenTable } from './frozen-table.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { getActsForContract, generateAndDownload, openActsRegistryWithAct } from './acts-registry-view.js';
import { renderLinkedContractsList } from './suppliers-view.js';
import { openPrimaryDocsRegistry, openPrimaryDocsModal } from './primary-docs-view.js';
import { initClaimsView, openClaimsModal } from './claims-view.js';
import { loadXLSX } from './lib-loader.js';
import { autofillContractExecutionPolicyFromDocument } from './contract-policy-import.js';
import { enhancePredictiveInput } from './filters.js';
import { confirmDeleteWithImpact } from './dom.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';


// Динамический импорт orders-view чтобы разорвать циклическую зависимость:
// contracts-view → orders-view → contracts-view
async function _openOrderCard(orderId, readonly) {
  const m = await import('./orders-view.js');
  m.openOrderCard(orderId, readonly);
}
async function _openOrdersModal() {
  const m = await import('./orders-view.js');
  m.openOrdersModal();
}

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

const fmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = v => fmt.format(Number(v) || 0);

const EXECUTION_ROUTE_LABELS = {
  direct: 'сразу получателю',
  warehouse: 'на склад',
  manual: 'определяет пользователь',
};

const EXECUTION_SCENARIO_LABELS = {
  full: 'полный расчёт',
  split: 'этапная схема',
};

const ADVANCE_OFFSET_MODE_LABELS = {
  sequential: 'приоритетный — вычитать из первых оплат до исчерпания аванса',
  proportional: 'пропорциональный — вычитать долю аванса из каждой оплаты',
  manual: 'ручной — пользователь сам распределяет зачёт по этапам',
};

const CONTRACT_DOC_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt,.xlsx,.xls,.odt';
const CONTRACT_DOC_MAX_BYTES = 12 * 1024 * 1024;
const _contractPolicyAutofillState = new Map();
const RENAME_ACT_EXPORT_HEADERS = [
  '№ позиции по ТЗ',
  'Наименование товара',
  'Характеристики',
  'Цена',
  'Наименование по спецификации',
  'Код товара',
];

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value <= 0) return '0 Б';
  if (value < 1024) return value + ' Б';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1).replace('.0', '') + ' КБ';
  return (value / (1024 * 1024)).toFixed(1).replace('.0', '') + ' МБ';
}

function buildStoredFileMeta(fileRecord) {
  if (!fileRecord) return '';
  const parts = [];
  if (fileRecord.originalName) parts.push(fileRecord.originalName);
  if (fileRecord.sizeBytes) parts.push(formatBytes(fileRecord.sizeBytes));
  if (fileRecord.uploadedAt) {
    try {
      parts.push(new Date(fileRecord.uploadedAt).toLocaleString('ru-RU'));
    } catch {
      parts.push(fileRecord.uploadedAt);
    }
  }
  return parts.join(' · ');
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

function makeLocalId(prefix = 'id') {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`;
}

function resolveCatalogProductForContractItem(item) {
  if (!item) return null;
  if (item.productRef != null) {
    const byId = state.products.find(product => product.id === item.productRef);
    if (byId) return byId;
  }
  const code = String(item.code || '').trim().toLowerCase();
  if (code) {
    const byCode = state.products.find(product => String(product.code || '').trim().toLowerCase() === code);
    if (byCode) return byCode;
  }
  const name = String(item.name || '').trim().toLowerCase();
  if (name) {
    return state.products.find(product => String(product.name || '').trim().toLowerCase() === name) || null;
  }
  return null;
}

function buildCharacteristicsFromProduct(product) {
  if (!product?.specs || !Array.isArray(product.specs) || product.specs.length === 0) return '';
  return product.specs
    .map((spec) => {
      const param = String(spec?.param || '').trim();
      const unit = String(spec?.unit || '').trim();
      const value = String(spec?.value || '').trim();
      const tail = [value, unit].filter(Boolean).join(' ');
      if (param && tail) return `${param}: ${tail}`;
      return param || tail;
    })
    .filter(Boolean)
    .join('\n');
}

function ensureContractItemIds(contract) {
  let changed = false;
  (contract?.items || []).forEach((item) => {
    if (!item.itemId) {
      item.itemId = makeLocalId('contract_item');
      changed = true;
    }
  });
  return changed;
}

function buildRenameActRowFromItem(item, index = 0, existingRow = null) {
  const product = resolveCatalogProductForContractItem(item);
  return {
    id: existingRow?.id || makeLocalId('rename_row'),
    contractItemId: item?.itemId || '',
    tzPosition: String(existingRow?.tzPosition || item?.tzPosition || index + 1).trim(),
    productName: String(item?.name || '').trim(),
    characteristics: buildCharacteristicsFromProduct(product) || String(item?.specSummary || existingRow?.characteristics || '').trim(),
    price: Number(item?.price) || 0,
    specificationName: String(item?.specificationName || existingRow?.specificationName || item?.name || '').trim(),
    productCode: String(item?.code || existingRow?.productCode || '').trim(),
  };
}

function ensureRenameActRows(contract) {
  if (!Array.isArray(contract.renameActRows)) {
    contract.renameActRows = [];
  }

  const previousByItemId = new Map(
    (contract.renameActRows || [])
      .filter(row => row?.contractItemId)
      .map(row => [String(row.contractItemId), row]),
  );

  const nextRows = (contract.items || []).map((item, index) => {
    const existing = previousByItemId.get(String(item?.itemId || '')) || contract.renameActRows[index] || null;
    return buildRenameActRowFromItem(item, index, existing);
  });

  const prevSignature = JSON.stringify(contract.renameActRows || []);
  const nextSignature = JSON.stringify(nextRows);
  contract.renameActRows = nextRows;
  return prevSignature !== nextSignature;
}

function findContractItemById(contract, itemId) {
  return (contract?.items || []).find(item => String(item.itemId || '') === String(itemId || '')) || null;
}

function getContractItemLabel(item, index = 0) {
  const specName = String(item?.specificationName || '').trim();
  const productName = String(item?.name || '').trim();
  const code = String(item?.code || '').trim();
  const parts = [specName || productName || `Строка ${index + 1}`];
  if (code) parts.push(code);
  return parts.join(' · ');
}

function parseRenameActValue(value) {
  return String(value ?? '').trim();
}

function findMatchingContractItem(contract, rowData) {
  const code = parseRenameActValue(rowData.productCode).toLowerCase();
  const specificationName = parseRenameActValue(rowData.specificationName).toLowerCase();
  const productName = parseRenameActValue(rowData.productName).toLowerCase();

  return (contract?.items || []).find(item => {
    const itemCode = String(item?.code || '').trim().toLowerCase();
    const itemSpec = String(item?.specificationName || '').trim().toLowerCase();
    const itemName = String(item?.name || '').trim().toLowerCase();
    if (code && itemCode && itemCode === code) return true;
    if (specificationName && itemSpec && itemSpec === specificationName) return true;
    if (productName && itemName && itemName === productName) return true;
    return false;
  }) || null;
}

function escapeCsv(value) {
  const str = String(value ?? '');
  if (!/[";,\n]/.test(str)) return str;
  return `"${str.replace(/"/g, '""')}"`;
}

function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function hasMeaningfulContractItems(contract) {
  return (contract?.items || []).some((item) => {
    return String(item?.name || '').trim()
      || Number(item?.qty) > 0
      || Number(item?.price) > 0
      || Number(item?.lotQty) > 0;
  });
}

function findMatchingContractItemForLot(contract, lotItem) {
  const productId = Number(lotItem?.productId) || null;
  const code = String(lotItem?.productCode || '').trim().toLowerCase();
  const name = String(lotItem?.productName || '').trim().toLowerCase();
  return (contract?.items || []).find((item) => {
    if (productId && Number(item?.productRef) === productId) return true;
    if (code && String(item?.code || '').trim().toLowerCase() === code) return true;
    if (name && String(item?.name || '').trim().toLowerCase() === name) return true;
    return false;
  }) || null;
}

function applyLotItemsToContract(contract, lot, { preserveQty = false } = {}) {
  const nextItems = (lot?.items || []).map((lotItem) => {
    const existing = findMatchingContractItemForLot(contract, lotItem);
    const qty = Number(lotItem?.qty) || 0;
    const hasLotNmcd = lotItem?.nmcd !== undefined && lotItem?.nmcd !== null && lotItem?.nmcd !== '';
    const lotNmcd = hasLotNmcd ? (Number(lotItem?.nmcd) || 0) : null;
    const product = resolveCatalogProductForContractItem(existing);
    return {
      itemId: existing?.itemId || makeLocalId('contract_item'),
      productRef: Number(lotItem?.productId) || existing?.productRef || null,
      name: String(lotItem?.productName || existing?.name || '').trim(),
      specificationName: String(existing?.specificationName || lotItem?.productName || '').trim(),
      code: String(existing?.code || lotItem?.productCode || '').trim(),
      unit: String(existing?.unit || lotItem?.unit || product?.unit || '').trim(),
      nmcd: lotNmcd != null ? lotNmcd : (Number(existing?.nmcd) || 0),
      price: Number(existing?.price) || 0,
      qty: preserveQty && existing ? (Number(existing.qty) || 0) : qty,
      lotQty: qty,
      ordered: Number(existing?.ordered) || 0,
      delivered: Number(existing?.delivered) || 0,
      paidAdvance: Number(existing?.paidAdvance) || 0,
      paid50: Number(existing?.paid50) || 0,
      paid30: Number(existing?.paid30) || 0,
      receiving: existing?.receiving || {},
    };
  });

  contract.items = nextItems.length
    ? nextItems
    : [{ itemId: makeLocalId('contract_item'), name: '', specificationName: '', price: 0, qty: 0, ordered: 0, delivered: 0, paidAdvance: 0, paid50: 0, paid30: 0 }];
  ensureRenameActRows(contract);
}

function getBoundLotForContract(contract) {
  if (!contract) return null;
  if (contract.lotId != null) {
    const byId = getLotById(contract.lotId);
    if (byId) return byId;
  }
  return contract.lotNumber ? findLotByNumber(contract.lotNumber) : null;
}

function syncContractItemsWithLot(contract) {
  if (!contract) return null;
  syncLotsWithContracts();
  const lot = getBoundLotForContract(contract);

  (contract.items || []).forEach((item) => {
    delete item.lotQty;
  });

  if (!lot) return null;

  if (!String(contract.lotNumber || '').trim() && lot.lotNumber) {
    contract.lotNumber = lot.lotNumber;
  }
  if (contract.lotId !== lot.id) {
    contract.lotId = lot.id;
  }

  if (!hasMeaningfulContractItems(contract)) {
    applyLotItemsToContract(contract, lot, { preserveQty: false });
    return lot;
  }

  (lot.items || []).forEach((lotItem) => {
    const existing = findMatchingContractItemForLot(contract, lotItem);
    if (existing) {
      existing.lotQty = Number(lotItem?.qty) || 0;
      if (lotItem?.nmcd !== undefined && lotItem?.nmcd !== null && lotItem?.nmcd !== '') {
        existing.nmcd = Number(lotItem.nmcd) || 0;
      }
    }
  });

  return lot;
}

function updateContractLotStatus(contract) {
  const hint = document.getElementById('cFieldLotStatus');
  const lotNumber = document.getElementById('cFieldLotNumber')?.value.trim() || '';
  if (!hint) return;
  if (!lotNumber) {
    hint.textContent = tf('lotting.contractLotHintEmpty', 'Укажите номер лота, чтобы подтянуть товары.');
    hint.className = 'mt-1.5 text-xs text-slate-500';
    return;
  }
  const lot = findLotByNumber(lotNumber);
  if (!lot) {
    hint.textContent = tf('lotting.contractLotHintMissing', 'Лот с таким номером не найден. Контракт сохранится без привязки.');
    hint.className = 'mt-1.5 text-xs text-amber-400';
    return;
  }
  const rowsCount = Array.isArray(lot.items) ? lot.items.length : 0;
  const totalQty = (lot.items || []).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  hint.textContent = tf('lotting.contractLotHintFound', 'Найден лот: {rows} поз., {qty} шт. После сохранения контракт будет привязан.', { rows: rowsCount, qty: totalQty });
  hint.className = 'mt-1.5 text-xs text-cyan-300';
}

function handleLotNumberChange(contract) {
  const lotNumber = document.getElementById('cFieldLotNumber')?.value.trim() || '';
  const lot = findLotByNumber(lotNumber);
  updateContractLotStatus(contract);
  if (!lot) return;
  if (String(contract.lotId || '') === String(lot.id)) return;

  const shouldReplace = !hasMeaningfulContractItems(contract) || window.confirm(
    tf('lotting.contractReplaceConfirm', 'Найден лот {number}. Заменить текущие строки контракта товарами из лота?', { number: lot.lotNumber })
  );
  if (!shouldReplace) return;

  applyLotItemsToContract(contract, lot, { preserveQty: false });
  contract.lotId = lot.id;
  showToast(tf('lotting.contractItemsLoaded', 'Товары из лота загружены в контракт'), 'success');
  renderItemsTable(contract);
  renderRenameActSection(contract);
  updateContractLotStatus(contract);
}

let _currentContract = null; // set during renderItemsTable so buildRowHtml can access it

function getAdvancePct() {
  return parseFloat(document.getElementById('cFieldAdvancePct')?.value) || 0;
}

let _editingId = null; // contract id being edited, null = new

// ─── Overlay helpers ──────────────────────────────────────────────

function overlay(id) { return document.getElementById(id); }

export function openContractsModal() {
  syncLotsWithContracts();
  overlay('contractEditPanel')?.classList.add('hidden');
  overlay('contractListPanel')?.classList.remove('hidden');
  closeContractSubPanel('contractOrdersSubPanel');
  closeContractSubPanel('contractActsSubPanel');
  renderContractsList();
  overlay('contractsModal')?.classList.add('open');
}

export function closeContractsModal() {
  overlay('contractEditPanel')?.classList.add('hidden');
  overlay('contractListPanel')?.classList.remove('hidden');
  closeContractSubPanel('contractOrdersSubPanel');
  closeContractSubPanel('contractActsSubPanel');
  overlay('contractsModal')?.classList.remove('open');
  updateContractsBadge();
  document.getElementById('contractsFilterBar')?.remove();
}

function openContractCard(id) {
  _editingId = id;
  renderContractCard(id);
  setContractCardReadonly(false);
  overlay('contractListPanel')?.classList.add('hidden');
  overlay('contractEditPanel')?.classList.remove('hidden');
}

export function openContractView(id) {
  _editingId = id;
  renderContractCard(id);
  setContractCardReadonly(true);
  overlay('contractListPanel')?.classList.add('hidden');
  overlay('contractEditPanel')?.classList.remove('hidden');
}

function closeContractCard() {
  overlay('contractEditPanel')?.classList.add('hidden');
  overlay('contractListPanel')?.classList.remove('hidden');
  // Close any open autocomplete
  closeAllDropdowns();
  renderContractsList();
}

function getOrderRowsForOrderedRecalc(order) {
  const rows = [];

  if (Array.isArray(order?.deliveryRows) && order.deliveryRows.length) {
    order.deliveryRows.forEach((row) => {
      const qty = Number(row?.qty) || (Array.isArray(row?.recipients)
        ? row.recipients.reduce((sum, recipient) => sum + (Number(recipient?.qty) || 0), 0)
        : 0);
      if (qty <= 0) return;
      rows.push({
        qty,
        itemId: String(row?.contractItemId || row?.itemId || '').trim(),
        code: String(row?.contractItemCode || row?.productCode || row?.baseCode || '').trim(),
        name: String(row?.contractItemName || row?.productName || row?.name || '').trim(),
      });
    });
    return rows;
  }

  if (Array.isArray(order?.items) && order.items.length) {
    order.items.forEach((item) => {
      if (item?.isTotalColorRow) return;
      const qty = Array.isArray(item?.deliverySchedules) && item.deliverySchedules.length
        ? item.deliverySchedules.reduce((sum, schedule) => sum + (Number(schedule?.qty) || 0), 0)
        : (Number(item?.qty) || 0);
      if (qty <= 0) return;
      rows.push({
        qty,
        itemId: String(item?.contractItemId || item?.itemId || '').trim(),
        code: String(item?.contractItemCode || item?.productCode || item?.code || item?.baseCode || '').trim(),
        name: String(item?.contractItemName || item?.productName || item?.name || '').trim(),
      });
    });
  }

  return rows;
}

function recalcContractOrderedFromOrders(contract) {
  if (!contract || !Array.isArray(contract.items)) return false;

  const contractId = String(contract.id || '');
  const orders = (state.orders || []).filter(order => String(order?.contractId || '') === contractId);
  const nextOrdered = new Map((contract.items || []).map(item => [String(item?.itemId || ''), 0]));

  const matchContractItem = (row) => {
    const rowItemId = String(row?.itemId || '').trim();
    const rowCode = String(row?.code || '').trim().toLowerCase();
    const rowName = String(row?.name || '').trim().toLowerCase();

    if (rowItemId) {
      const byId = (contract.items || []).find(item => String(item?.itemId || '').trim() === rowItemId);
      if (byId) return byId;
    }

    if (rowCode) {
      const byCode = (contract.items || []).find((item) => {
        const itemCode = String(item?.code || '').trim().toLowerCase();
        if (!itemCode) return false;
        return rowCode === itemCode || rowCode.startsWith(itemCode + '-');
      });
      if (byCode) return byCode;
    }

    if (rowName) {
      return (contract.items || []).find(item => String(item?.name || '').trim().toLowerCase() === rowName) || null;
    }

    return null;
  };

  orders.forEach((order) => {
    getOrderRowsForOrderedRecalc(order).forEach((row) => {
      const matchedItem = matchContractItem(row);
      if (!matchedItem) return;
      const itemKey = String(matchedItem?.itemId || '');
      nextOrdered.set(itemKey, (nextOrdered.get(itemKey) || 0) + (Number(row.qty) || 0));
    });
  });

  let changed = false;
  (contract.items || []).forEach((item) => {
    const itemKey = String(item?.itemId || '');
    const nextValue = nextOrdered.get(itemKey) || 0;
    if ((Number(item?.ordered) || 0) !== nextValue) {
      item.ordered = nextValue;
      changed = true;
    }
  });

  return changed;
}

/** Toggle read-only mode on the contract card */
function setContractCardReadonly(readonly) {
  const editPanel = overlay('contractEditPanel');
  if (!editPanel) return;

  // Disable all inputs, selects, textareas, buttons except back/edit
  editPanel.querySelectorAll('input, select, textarea').forEach(el => {
    el.disabled = readonly;
    el.style.opacity = readonly ? '0.7' : '';
    el.style.cursor = readonly ? 'default' : '';
  });
  // Hide save button, show edit button (or vice versa)
  const saveBtn = document.getElementById('contractCardSaveBtn');
  const editBtn = document.getElementById('contractCardEditBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', readonly);
  if (editBtn) editBtn.classList.toggle('hidden', !readonly);
  // Hide add-row / add-program buttons
  editPanel.querySelectorAll('#addItemRowBtn, #addProgBtn, .del-item-btn, .del-prog-btn').forEach(b => {
    b.classList.toggle('hidden', readonly);
  });
  editPanel.querySelectorAll('[data-readonly-hide="true"]').forEach(b => {
    b.classList.toggle('hidden', readonly);
  });
}

// ─── Sub-panels (orders / acts) inside contract card ─────────────

function openContractSubPanel(id) {
  document.getElementById(id)?.classList.remove('hidden');
}
function closeContractSubPanel(id) {
  document.getElementById(id)?.classList.add('hidden');
}

// ─── Badge ────────────────────────────────────────────────────────

export function updateContractsBadge() {
  const badge = document.getElementById('contractsBadge');
  if (!badge) return;
  const n = state.contracts.length;
  if (n > 0) {
    badge.textContent = n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── List panel ───────────────────────────────────────────────────

let _listSearch = '';
let _listSupplierId = '';

/** Фильтрация списка контрактов по поиску и поставщику */
function _filterContracts() {
  const q = _listSearch.trim().toLowerCase();
  const sid = _listSupplierId ? Number(_listSupplierId) : null;
  return state.contracts.filter(c => {
    if (sid !== null && c.supplierId !== sid) return false;
    if (q) {
      const supplier = state.suppliers.find(s => s.id === c.supplierId);
      const supplierName = supplier ? supplier.name.toLowerCase() : '';
      const num = (c.number || '').toLowerCase();
      const lot = (c.lotNumber || '').toLowerCase();
      const title = (c.title || '').toLowerCase();
      if (!num.includes(q) && !lot.includes(q) && !title.includes(q) && !supplierName.includes(q)) return false;
    }
    return true;
  });
}

/** Строит или обновляет панель фильтров над списком контрактов */
function _buildOrUpdateContractsFilterBar() {
  const modal = document.getElementById('contractsModal');
  if (!modal) return;
  const listPanel = document.getElementById('contractListPanel');
  if (!listPanel) return;

  let bar = document.getElementById('contractsFilterBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'contractsFilterBar';
    bar.style.cssText = 'display:flex;gap:0.5rem;align-items:center;flex-wrap:wrap;padding:0 1.25rem 0.75rem;';

    // Search input
    const searchWrap = document.createElement('div');
    searchWrap.style.cssText = 'position:relative;flex:1;min-width:180px;';
    const contractSearchOptions = [...new Set(state.contracts.flatMap(c => {
      const supplier = state.suppliers.find(s => s.id === c.supplierId);
      return [c.number, c.lotNumber, c.title, supplier?.name]
        .map(v => String(v || '').trim())
        .filter(Boolean);
    }))].sort((a, b) => a.localeCompare(b, 'ru'));
    searchWrap.innerHTML =
      '<span style="position:absolute;left:0.75rem;top:50%;transform:translateY(-50%);font-size:0.8rem;pointer-events:none;opacity:0.5;">🔍</span>' +
      '<input id="contractsSearchInp" type="search" list="contractsSearchOptions" placeholder="' + escHtml(t('contracts.searchPlaceholder')) + '"' +
      ' style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.5rem 0.75rem 0.5rem 2rem;color:#fff;font-size:0.8rem;outline:none;"' +
      ' value="' + escHtml(_listSearch) + '">' +
      '<datalist id="contractsSearchOptions">' + contractSearchOptions.map(option => '<option value="' + escHtml(option) + '"></option>').join('') + '</datalist>';
    bar.appendChild(searchWrap);

    // Supplier autocomplete input
    const supplierWrap = document.createElement('div');
    supplierWrap.style.cssText = 'position:relative;min-width:160px;max-width:240px;';
    supplierWrap.innerHTML =
      '<input id="contractsSupplierInp" type="text" autocomplete="off" placeholder="Поставщик…"' +
      ' style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.5rem 0.75rem;color:#fff;font-size:0.8rem;outline:none;"' +
      ' value="">' +
      '<div id="contractsSupplierDropdown" style="display:none;position:absolute;top:calc(100% + 4px);left:0;right:0;z-index:300;background:rgb(30,41,59);border:1px solid rgba(255,255,255,0.12);border-radius:0.75rem;overflow-y:auto;max-height:180px;box-shadow:0 8px 32px rgba(0,0,0,0.5);"></div>';
    bar.appendChild(supplierWrap);

    // Reset button
    const resetBtn = document.createElement('button');
    resetBtn.id = 'contractsFilterResetBtn';
    resetBtn.textContent = '✕ Сброс';
    resetBtn.style.cssText = 'background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.5rem 0.75rem;color:rgb(148,163,184);font-size:0.75rem;cursor:pointer;white-space:nowrap;';
    bar.appendChild(resetBtn);

    // Insert before contractsListContainer
    const container = document.getElementById('contractsListContainer');
    if (container) container.parentElement?.insertBefore(bar, container);

    // Wire events — search
    document.getElementById('contractsSearchInp')?.addEventListener('input', e => {
      _listSearch = e.target.value;
      renderContractsList();
    });

    // Wire events — supplier autocomplete
    const supInp = document.getElementById('contractsSupplierInp');
    const supDrop = document.getElementById('contractsSupplierDropdown');

    function _showSupplierDrop(query) {
      if (!supDrop) return;
      const q = (query || '').trim().toLowerCase();
      const matches = q
        ? state.suppliers.filter(s => s.name.toLowerCase().includes(q))
        : state.suppliers;
      if (matches.length === 0) { supDrop.style.display = 'none'; return; }
      supDrop.innerHTML = matches.map(s =>
        '<div class="sup-ac-item" data-id="' + s.id + '" data-name="' + escHtml(s.name) + '"' +
        ' style="padding:0.5rem 0.75rem;cursor:pointer;font-size:0.8rem;color:rgb(203,213,225);transition:background 0.12s;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' +
        highlightMatch(s.name, query || '') +
        '</div>'
      ).join('');
      supDrop.style.display = 'block';
      supDrop.querySelectorAll('.sup-ac-item').forEach(item => {
        item.addEventListener('mouseenter', () => { item.style.background = 'rgba(34,211,238,0.1)'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('mousedown', e => {
          e.preventDefault();
          _listSupplierId = item.dataset.id;
          if (supInp) supInp.value = item.dataset.name;
          supDrop.style.display = 'none';
          renderContractsList();
        });
      });
    }

    supInp?.addEventListener('input', e => {
      _listSupplierId = '';
      _showSupplierDrop(e.target.value);
    });
    supInp?.addEventListener('focus', e => {
      _showSupplierDrop(e.target.value);
    });
    supInp?.addEventListener('blur', () => {
      setTimeout(() => { if (supDrop) supDrop.style.display = 'none'; }, 180);
    });
    supInp?.addEventListener('keydown', e => {
      if (e.key === 'Escape') { if (supDrop) supDrop.style.display = 'none'; supInp.blur(); }
      if (e.key === 'Enter') { if (supDrop) supDrop.style.display = 'none'; }
    });

    // Restore supplier name if filter was active
    if (_listSupplierId) {
      const sup = state.suppliers.find(s => String(s.id) === String(_listSupplierId));
      if (sup && supInp) supInp.value = sup.name;
    }

    resetBtn.addEventListener('click', () => {
      _listSearch = '';
      _listSupplierId = '';
      const searchInp = document.getElementById('contractsSearchInp');
      if (searchInp) searchInp.value = '';
      if (supInp) supInp.value = '';
      if (supDrop) supDrop.style.display = 'none';
      renderContractsList();
    });

    enhancePredictiveInput(document.getElementById('contractsSearchInp'), {
      listId: 'contractsSearchOptions',
      options: contractSearchOptions,
      icon: '🔍',
      minWidth: '220px',
    });
    searchWrap.querySelector('span')?.remove();
    enhancePredictiveInput(document.getElementById('contractsSupplierInp'), {
      icon: '🏢',
      minWidth: '180px',
    });
  } else {
    const searchList = document.getElementById('contractsSearchOptions');
    if (searchList) {
      const contractSearchOptions = [...new Set(state.contracts.flatMap(c => {
        const supplier = state.suppliers.find(s => s.id === c.supplierId);
        return [c.number, c.lotNumber, c.title, supplier?.name]
          .map(v => String(v || '').trim())
          .filter(Boolean);
      }))].sort((a, b) => a.localeCompare(b, 'ru'));
      searchList.innerHTML = contractSearchOptions.map(option => '<option value="' + escHtml(option) + '"></option>').join('');
    }

    // Restore supplier name label if filter persists
    if (_listSupplierId) {
      const supInp2 = document.getElementById('contractsSupplierInp');
      if (supInp2 && !supInp2.value) {
        const sup = state.suppliers.find(s => String(s.id) === String(_listSupplierId));
        if (sup) supInp2.value = sup.name;
      }
    }
  }
}


function renderContractsList() {
  const wrap = document.getElementById('contractsListContainer');
  if (!wrap) return;

  if (state.contracts.length === 0) {
    wrap.innerHTML =
      '<div class="flex flex-col items-center justify-center py-16 text-center">' +
      '<span class="text-5xl mb-4" aria-hidden="true">📝</span>' +
      '<p class="text-sm font-semibold text-slate-300">' + t('contracts.empty') + '</p>' +
      '<p class="text-xs text-slate-500 mt-1">' + t('contracts.emptyHint') + '</p>' +
      '</div>';
    return;
  }

  // ── Build / update filter bar ──────────────────────────────────
  _buildOrUpdateContractsFilterBar();

  const filtered = _filterContracts();

  if (filtered.length === 0) {
    wrap.innerHTML =
      '<div class="flex flex-col items-center justify-center py-12 text-center">' +
      '<span class="text-4xl mb-3" aria-hidden="true">🔍</span>' +
      '<p class="text-sm font-semibold text-slate-300">Ничего не найдено</p>' +
      '<p class="text-xs text-slate-500 mt-1">Попробуйте изменить параметры поиска</p>' +
      '</div>';
    return;
  }

  wrap.innerHTML = filtered.map(c => {
    const supplier = state.suppliers.find(s => s.id === c.supplierId);
    const supplierName = supplier ? supplier.name : t('contracts.noSupplier');
    const total = fmtNum(c.totalPrice);
    const itemCount = (c.items || []).filter(i => i.name && i.name.trim()).length;
    const numHtml = c.number ? ('№ ' + escHtml(c.number)) : t('contracts.noNumber');
    const lotHtml = c.lotNumber
      ? '<span class="inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">' + escHtml(t('contracts.lotBadge', { lot: c.lotNumber })) + '</span>'
      : '';
    const titleHtml = c.title ? '<p class="text-xs text-slate-200 mt-0.5 truncate">' + escHtml(c.title) + '</p>' : '';
    const dateHtml = c.date ? ' · ' + escHtml(c.date) : '';
    const itemsHtml = itemCount > 0 ? ' · ' + itemCount + ' ' + t('contracts.positions') : '';
    return '<div class="group flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.04] px-4 py-3 transition hover:bg-white/[0.07] hover:border-cyan-400/20 cursor-pointer contract-card" data-id="' + c.id + '">' +
      '<div class="flex-1 min-w-0 pointer-events-none">' +
      '<div class="flex items-center gap-2 flex-wrap"><p class="text-sm font-semibold text-white truncate">' + numHtml + '</p>' + lotHtml + '</div>' +
      titleHtml +
      '<p class="text-xs text-slate-400 mt-0.5 truncate">' + escHtml(supplierName) + dateHtml + '</p>' +
      '<p class="text-xs text-cyan-400 mt-0.5 tabular-nums">' + total + ' ₽' + itemsHtml + '</p>' +
      '</div>' +
      '<div class="flex gap-1 shrink-0">' +
      '<button class="edit-contract-btn rounded-xl p-2 text-slate-500 hover:bg-cyan-400/10 hover:text-cyan-400 transition" data-id="' + c.id + '" aria-label="' + t('actions.edit') + '" title="' + t('actions.edit') + '">' +
      '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4l5 5-9 9H2v-5L11 4z"/></svg>' +
      '</button>' +
      '<button class="del-contract-btn rounded-xl p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-400 transition" data-id="' + c.id + '" aria-label="' + t('actions.delete') + '" title="' + t('actions.delete') + '">' +
      '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h14M8 6V4h4v2M5 6l1 12h8l1-12"/></svg>' +
      '</button>' +
      '</div></div>';
  }).join('');

  wrap.querySelectorAll('.contract-card').forEach(card => {
    card.addEventListener('click', e => {
      if (!e.target.closest('button')) openContractView(Number(card.dataset.id));
    });
  });
  wrap.querySelectorAll('.edit-contract-btn').forEach(btn => {
    btn.addEventListener('click', () => openContractCard(Number(btn.dataset.id)));
  });
  wrap.querySelectorAll('.del-contract-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteContract(Number(btn.dataset.id)));
  });
}

async function handleDeleteContract(id) {
  const contract = getContractById(id);
  const subject = contract?.number
    ? `№ ${contract.number}${contract.title ? ` — ${contract.title}` : ''}`
    : (contract?.title || 'Контракт');
  if (!confirmDeleteWithImpact({
    title: 'Удалить контракт?',
    subject,
    impacts: [
      'контракт будет удалён из реестра вместе с таблицей товаров и файлами карточки',
    ],
    recalculations: [
      'сводные суммы и связанные показатели в списках будут обновлены',
    ],
    risks: [
      'заявки, акты, отгрузки, прямые поставки, претензии и первичные документы по этому контракту не удаляются автоматически',
    ],
  })) return;
  deleteContract(id);
  await saveToStorage();
  renderContractsList();
  updateContractsBadge();
  showToast(t('contracts.deleted'), 'success');
}

// ─── Contract card ────────────────────────────────────────────────

function renderContractCard(id) {
  let contract = id != null ? getContractById(id) : null;
  const isNew = !contract;
  if (isNew) {
    contract = addContract({
      programs: [{ name: '', price: 0 }],
      items: [{ name: '', unit: '', price: 0, qty: 0, ordered: 0, delivered: 0, paidAdvance: 0, paid50: 0, paid30: 0 }],
    });
    _editingId = contract.id;
    saveToStorage();
  }

  // Ensure items array has at least one empty row
  if (!Array.isArray(contract.items)) contract.items = [];
  if (contract.items.length === 0) {
    contract.items.push({ name: '', specificationName: '', unit: '', price: 0, qty: 0, ordered: 0, delivered: 0, paidAdvance: 0, paid50: 0, paid30: 0 });
  }

  ensureContractItemIds(contract);
  ensureRenameActRows(contract);
  syncContractItemsWithLot(contract);
  recalcContractOrderedFromOrders(contract);

  const titleEl = document.getElementById('contractCardTitle');
  if (titleEl) titleEl.textContent = contract.number
    ? (t('contracts.cardTitle') + ' № ' + contract.number)
    : t('contracts.newCard');

  renderCardHeader(contract);
  renderContractExecutionPolicy(contract);
  refreshAllProductCodes(contract);
  const claimsBtn = ensureContractClaimsButton(contract);
  if (claimsBtn) {
    claimsBtn.onclick = () => openClaimsModal(contract.id);
  }
  renderContractDocuments(contract);
  renderProgramsSection(contract);
  // Sync shipping/SO status from acts registry before rendering the table
  syncItemStatusesFromActs(contract);
  renderItemsTable(contract);
  renderRenameActSection(contract);
  renderProgramFinanceSummary(contract);
  renderContractSupplyHistory(contract);
  renderContractPrimaryDocs(contract);

  // Wire sub-panel buttons
  wireContractSubPanelButtons(contract);
}

function ensureContractPrimaryDocsWrap() {
  const body = document.querySelector('#contractEditPanel > .flex-1.overflow-auto');
  if (!body) return null;

  let section = document.getElementById('contractPrimaryDocsSection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'contractPrimaryDocsSection';
    section.innerHTML =
      '<h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Первичные документы</h3>' +
      '<div id="contractPrimaryDocsWrap"></div>';
    body.appendChild(section);
  }

  return document.getElementById('contractPrimaryDocsWrap');
}

function ensureContractSupplyHistoryWrap() {
  const body = document.querySelector('#contractEditPanel > .flex-1.overflow-auto');
  if (!body) return null;

  let section = document.getElementById('contractSupplyHistorySection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'contractSupplyHistorySection';
    section.innerHTML =
      '<h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">' + escHtml(t('contracts.supplyHistoryTitle')) + '</h3>' +
      '<div id="contractSupplyHistoryWrap"></div>';
    body.appendChild(section);
  }

  return document.getElementById('contractSupplyHistoryWrap');
}

function ensureContractDocumentsWrap() {
  const body = document.querySelector('#contractEditPanel > .flex-1.overflow-auto');
  if (!body) return null;

  let section = document.getElementById('contractDocumentsSection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'contractDocumentsSection';
    section.innerHTML =
      '<h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">' + escHtml(t('contracts.sectionDocuments')) + '</h3>' +
      '<div id="contractDocumentsWrap"></div>';

    const headerSection = document.getElementById('contractHeaderFields')?.closest('section');
    if (headerSection?.parentElement) {
      headerSection.insertAdjacentElement('afterend', section);
    } else {
      body.appendChild(section);
    }
  }

  return document.getElementById('contractDocumentsWrap');
}

function ensureContractExecutionPolicyWrap() {
  const body = document.querySelector('#contractEditPanel > .flex-1.overflow-auto');
  if (!body) return null;

  let section = document.getElementById('contractExecutionPolicySection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'contractExecutionPolicySection';
    section.innerHTML = '<h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">Схема исполнения и оплаты</h3><div id="contractExecutionPolicyWrap"></div>';

    const infoSection = document.getElementById('contractHeaderFields')?.closest('section');
    if (infoSection?.parentElement) infoSection.insertAdjacentElement('afterend', section);
    else body.appendChild(section);
  }

  return document.getElementById('contractExecutionPolicyWrap');
}

function getContractPolicyAutofillState(contractId) {
  return _contractPolicyAutofillState.get(String(contractId || 'new')) || null;
}

function setContractPolicyAutofillState(contractId, value) {
  const key = String(contractId || 'new');
  if (!value) {
    _contractPolicyAutofillState.delete(key);
    return;
  }
  _contractPolicyAutofillState.set(key, value);
}

function mergeContractExecutionPolicyPatch(basePolicy, patch = {}) {
  const next = { ...(basePolicy || {}) };

  if (typeof patch.usesReadiness === 'boolean') next.usesReadiness = patch.usesReadiness;
  if (['direct', 'warehouse', 'manual'].includes(patch.routeWhenReady)) next.routeWhenReady = patch.routeWhenReady;
  if (['direct', 'warehouse', 'manual'].includes(patch.routeWhenNotReady)) next.routeWhenNotReady = patch.routeWhenNotReady;
  if (['full', 'split'].includes(patch.scenarioWhenReady)) next.scenarioWhenReady = patch.scenarioWhenReady;
  if (['full', 'split'].includes(patch.scenarioWhenNotReady)) next.scenarioWhenNotReady = patch.scenarioWhenNotReady;

  const stage1 = Number(patch.stage1Percent);
  const stage2 = Number(patch.stage2Percent);
  const hasStage1 = Number.isFinite(stage1);
  const hasStage2 = Number.isFinite(stage2);
  if (hasStage1) next.stage1Percent = Math.max(0, Math.min(100, stage1));
  if (hasStage2) next.stage2Percent = Math.max(0, Math.min(100, stage2));

  const splitUsed = next.scenarioWhenReady === 'split' || next.scenarioWhenNotReady === 'split';
  if (splitUsed) {
    if (hasStage1 && !hasStage2) next.stage2Percent = Math.max(0, 100 - next.stage1Percent);
    if (!hasStage1 && hasStage2) next.stage1Percent = Math.max(0, 100 - next.stage2Percent);
    if (!Number.isFinite(Number(next.stage1Percent)) && !Number.isFinite(Number(next.stage2Percent))) {
      next.stage1Percent = 70;
      next.stage2Percent = 30;
    }
  }

  if (typeof patch.requireNotReadyAct === 'boolean') next.requireNotReadyAct = patch.requireNotReadyAct;
  if (typeof patch.requireReadyAct === 'boolean') next.requireReadyAct = patch.requireReadyAct;

  if (typeof patch.hasAdvance === 'boolean') next.hasAdvance = patch.hasAdvance;
  if (patch.advancePercent != null && patch.advancePercent !== '') {
    const percent = Math.max(0, Math.min(100, Number(patch.advancePercent) || 0));
    next.advancePercent = percent;
    if (percent > 0) next.hasAdvance = true;
  }
  if (next.hasAdvance === false) next.advancePercent = 0;

  if (['sequential', 'proportional', 'manual'].includes(patch.advanceOffsetMode)) {
    next.advanceOffsetMode = patch.advanceOffsetMode;
  }

  return next;
}

function matchSupplierByName(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;

  const exact = (state.suppliers || []).find((supplier) => {
    return String(supplier?.name || '').trim().toLowerCase() === target;
  });
  if (exact) return exact;

  const relaxedMatches = (state.suppliers || []).filter((supplier) => {
    const value = String(supplier?.name || '').trim().toLowerCase();
    return value && (value.includes(target) || target.includes(value));
  });
  return relaxedMatches.length === 1 ? relaxedMatches[0] : null;
}

function applyContractAutofillPatchToDom(contract, contractPatch = {}) {
  if (!contract || !contractPatch || typeof contractPatch !== 'object') return [];

  const evidence = [];
  const setInputValue = (id, value) => {
    const input = document.getElementById(id);
    if (input) input.value = value;
  };

  const title = String(contractPatch.title || '').trim();
  if (title) {
    contract.title = title;
    setInputValue('cFieldTitle', title);
    evidence.push(`Наименование договора: ${title}`);
  }

  const number = String(contractPatch.number || '').trim();
  if (number) {
    contract.number = number;
    setInputValue('cFieldNumber', number);
    const titleEl = document.getElementById('contractCardTitle');
    if (titleEl) titleEl.textContent = t('contracts.cardTitle') + ' № ' + number;
    evidence.push(`Номер договора: ${number}`);
  }

  const date = String(contractPatch.date || '').trim();
  if (date) {
    contract.date = date;
    setInputValue('cFieldDate', date);
    evidence.push(`Дата договора: ${date}`);
  }

  const totalPrice = Number(contractPatch.totalPrice);
  if (Number.isFinite(totalPrice) && totalPrice > 0) {
    contract.totalPrice = totalPrice;
    setInputValue('cFieldTotalPrice', String(totalPrice));
    evidence.push(`Цена договора: ${fmtNum(totalPrice)} ₽`);
  }

  const supplierName = String(contractPatch.supplierName || '').trim();
  if (supplierName) {
    const matchedSupplier = matchSupplierByName(supplierName);
    if (matchedSupplier) {
      contract.supplierId = matchedSupplier.id;
      setInputValue('cFieldSupplier', String(matchedSupplier.id));
      evidence.push(`Поставщик сопоставлен: ${matchedSupplier.name}`);
    }
  }

  const customerName = String(contractPatch.customerName || '').trim();
  if (customerName) contract.customerName = customerName;
  const customerSignerRole = String(contractPatch.customerSignerRole || '').trim();
  if (customerSignerRole) contract.customerSignerRole = customerSignerRole;
  const customerSignerName = String(contractPatch.customerSignerName || '').trim();
  if (customerSignerName) contract.customerSignerName = customerSignerName;
  const customerSignerBasis = String(contractPatch.customerSignerBasis || '').trim();
  if (customerSignerBasis) contract.customerSignerBasis = customerSignerBasis;

  const supplierSignerRole = String(contractPatch.supplierSignerRole || '').trim();
  if (supplierSignerRole) contract.supplierSignerRole = supplierSignerRole;
  const supplierSignerName = String(contractPatch.supplierSignerName || '').trim();
  if (supplierSignerName) contract.supplierSignerName = supplierSignerName;
  const supplierSignerBasis = String(contractPatch.supplierSignerBasis || '').trim();
  if (supplierSignerBasis) contract.supplierSignerBasis = supplierSignerBasis;

  if (customerSignerRole || customerSignerName) {
    evidence.push(`Подписант заказчика: ${[customerSignerRole, customerSignerName].filter(Boolean).join(' ')}`);
  }
  if (supplierSignerRole || supplierSignerName) {
    evidence.push(`Подписант поставщика: ${[supplierSignerRole, supplierSignerName].filter(Boolean).join(' ')}`);
  }

  const advancePercent = Number(contractPatch.advancePercent);
  if (Number.isFinite(advancePercent) && advancePercent >= 0) {
    contract.advancePct = advancePercent;
    setInputValue('cFieldAdvancePct', String(advancePercent));
    setInputValue('cPolicyAdvancePercent', String(advancePercent));
    evidence.push(`Аванс: ${advancePercent}%`);
  }

  refreshAllProductCodes(contract);
  checkPriceBalance(contract);
  return evidence;
}

function addRecognizedProductsToCatalog(products = []) {
  const result = {
    total: 0,
    added: 0,
    duplicates: 0,
    namesAdded: [],
    namesSkipped: [],
  };

  (Array.isArray(products) ? products : []).forEach((product) => {
    const name = String(product?.name || '').trim();
    if (!name) return;
    result.total += 1;

    const response = addProduct({
      name,
      category: '',
      productGroup: '',
      unit: String(product?.unit || '').trim(),
      assembly: product?.assembly === 'required' ? 'required' : 'not_required',
      specs: Array.isArray(product?.specs) ? product.specs : [],
      hasColorVariants: false,
      colorVariants: [],
    });

    if (response?.error === 'duplicate') {
      result.duplicates += 1;
      result.namesSkipped.push(name);
      return;
    }

    if (response?.ok) {
      result.added += 1;
      result.namesAdded.push(name);
    }
  });

  return result;
}

function findCatalogProductByName(name) {
  const target = String(name || '').trim().toLowerCase();
  if (!target) return null;
  return (state.products || []).find(product => String(product?.name || '').trim().toLowerCase() === target) || null;
}

function buildContractItemsFromRecognizedProducts(contract, products = []) {
  const recognized = Array.isArray(products)
    ? products.filter(product => String(product?.name || '').trim())
    : [];

  if (!recognized.length) {
    return { applied: 0, priced: 0, qtyFilled: 0 };
  }

  ensureContractItemIds(contract);
  const existingItems = Array.isArray(contract?.items) ? [...contract.items] : [];
  const usedIndexes = new Set();

  const pickExistingItem = (product) => {
    const targetName = String(product?.name || '').trim().toLowerCase();
    const targetSpec = String(product?.specificationName || '').trim().toLowerCase();
    const targetCode = String(product?.code || '').trim().toLowerCase();

    let index = existingItems.findIndex((item, idx) => {
      if (usedIndexes.has(idx)) return false;
      const itemCode = String(item?.code || '').trim().toLowerCase();
      const itemSpec = String(item?.specificationName || '').trim().toLowerCase();
      const itemName = String(item?.name || '').trim().toLowerCase();
      return Boolean(targetCode && itemCode && targetCode === itemCode)
        || Boolean(targetSpec && itemSpec && targetSpec === itemSpec)
        || Boolean(targetName && itemName && targetName === itemName);
    });

    if (index === -1) {
      index = existingItems.findIndex((item, idx) => {
        if (usedIndexes.has(idx)) return false;
        return !String(item?.name || '').trim()
          && !String(item?.specificationName || '').trim()
          && !(Number(item?.qty) || 0)
          && !(Number(item?.price) || 0);
      });
    }

    if (index === -1) return null;
    usedIndexes.add(index);
    return existingItems[index];
  };

  const nextItems = recognized.map((product, index) => {
    const existing = pickExistingItem(product);
    const catalogProduct = findCatalogProductByName(product.name);
    const qty = product?.qty != null ? Math.max(0, Number(product.qty) || 0) : (Number(existing?.qty) || 0);
    const price = product?.price != null ? Math.max(0, Number(product.price) || 0) : (Number(existing?.price) || 0);
    const specificationName = String(product?.specificationName || existing?.specificationName || product?.name || '').trim();
    const productName = String(product?.name || existing?.name || '').trim();
    const unit = String(product?.unit || existing?.unit || catalogProduct?.unit || '').trim();
    const code = String(product?.code || existing?.code || '').trim();

    return {
      itemId: existing?.itemId || makeLocalId('contract_item'),
      productRef: catalogProduct?.id || existing?.productRef || null,
      name: productName,
      specificationName,
      code,
      unit,
      price,
      qty,
      ordered: Number(existing?.ordered) || 0,
      delivered: Number(existing?.delivered) || 0,
      paidAdvance: Number(existing?.paidAdvance) || 0,
      paid50: Number(existing?.paid50) || 0,
      paid30: Number(existing?.paid30) || 0,
      receiving: existing?.receiving || {},
      tzPosition: existing?.tzPosition || String(index + 1),
    };
  });

  contract.items = nextItems.length
    ? nextItems
    : [{ itemId: makeLocalId('contract_item'), name: '', specificationName: '', unit: '', price: 0, qty: 0, ordered: 0, delivered: 0, paidAdvance: 0, paid50: 0, paid30: 0 }];
  ensureRenameActRows(contract);
  refreshAllProductCodes(contract);

  return {
    applied: nextItems.length,
    priced: nextItems.filter(item => Number(item?.price) > 0).length,
    qtyFilled: nextItems.filter(item => Number(item?.qty) > 0).length,
  };
}

function getContractPolicyAutofillConfidenceMeta(level) {
  if (level === 'high') {
    return {
      label: tf('contracts.policyAutofillConfidenceHigh', 'Высокая уверенность'),
      badgeClass: 'bg-emerald-400/15 text-emerald-300',
    };
  }
  if (level === 'low') {
    return {
      label: tf('contracts.policyAutofillConfidenceLow', 'Низкая уверенность'),
      badgeClass: 'bg-amber-400/15 text-amber-300',
    };
  }
  return {
    label: tf('contracts.policyAutofillConfidenceMedium', 'Средняя уверенность'),
    badgeClass: 'bg-cyan-400/15 text-cyan-300',
  };
}

function buildContractPolicyAutofillStateHtml(contract, filesCount) {
  const state = getContractPolicyAutofillState(contract?.id);
  if (!state) {
    if (filesCount > 0) return '';
    return '<div class="rounded-xl border border-amber-400/15 bg-amber-400/[0.06] px-4 py-3 text-xs text-amber-200">'
      + escHtml(tf('contracts.policyAutofillNoFiles', 'Сначала загрузите файл договора в блок «Файлы контракта», затем можно будет заполнить схему автоматически.'))
      + '</div>';
  }

  if (state.loading) {
    return '<div class="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.06] px-4 py-3 text-xs text-cyan-200">'
      + escHtml(state.message || tf('contracts.policyAutofillLoading', 'Анализируем договор и подбираем схему исполнения и оплаты…'))
      + '</div>';
  }

  if (state.error) {
    return '<div class="rounded-xl border border-red-400/15 bg-red-400/[0.06] px-4 py-3 space-y-2">'
      + '<p class="text-xs font-semibold text-red-200">' + escHtml(tf('contracts.policyAutofillError', 'Автозаполнение не удалось')) + '</p>'
      + '<p class="text-xs text-red-100">' + escHtml(state.error) + '</p>'
      + '</div>';
  }

  const confidence = getContractPolicyAutofillConfidenceMeta(state.confidence);
  const evidenceHtml = Array.isArray(state.evidence) && state.evidence.length
    ? '<div><p class="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">' + escHtml(tf('contracts.policyAutofillEvidenceTitle', 'На чём основано')) + '</p><ul class="space-y-1 text-xs text-slate-300 list-disc pl-4">' + state.evidence.map(line => '<li>' + escHtml(line) + '</li>').join('') + '</ul></div>'
    : '';
  const warningsHtml = Array.isArray(state.warnings) && state.warnings.length
    ? '<div><p class="text-[11px] font-semibold uppercase tracking-wider text-amber-300 mb-2">' + escHtml(tf('contracts.policyAutofillWarningsTitle', 'Что проверить вручную')) + '</p><ul class="space-y-1 text-xs text-amber-100 list-disc pl-4">' + state.warnings.map(line => '<li>' + escHtml(line) + '</li>').join('') + '</ul></div>'
    : '';

  return '<div class="rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3 space-y-3">'
    + '<div class="flex items-center gap-2 flex-wrap">'
      + '<span class="rounded-lg px-2 py-1 text-[10px] font-bold uppercase tracking-wide ' + confidence.badgeClass + '">' + escHtml(confidence.label) + '</span>'
      + '<span class="text-[11px] text-slate-500">' + escHtml(tf('contracts.policyAutofillSource', 'Источник: {file}', { file: state.fileName || '—' })) + '</span>'
    + '</div>'
    + '<p class="text-xs text-slate-200">' + escHtml(state.summary || tf('contracts.policyAutofillApplied', 'Схема заполнена по загруженному договору. Проверьте поля и сохраните карточку.')) + '</p>'
    + evidenceHtml
    + warningsHtml
    + '</div>';
}

async function handleContractPolicyAutofill(contract) {
  const files = getContractStoredDocuments(contract);
  if (!files.length) {
    const message = tf('contracts.policyAutofillNoFiles', 'Сначала загрузите файл договора в блок «Файлы контракта», затем можно будет заполнить схему автоматически.');
    setContractPolicyAutofillState(contract?.id, { error: message });
    renderContractExecutionPolicy(contract);
    showToast(tf('contracts.policyAutofillNoFilesToast', 'Сначала загрузите файл договора'), 'info');
    return;
  }

  setContractPolicyAutofillState(contract?.id, {
    loading: true,
    message: tf('contracts.policyAutofillLoading', 'Анализируем договор и подбираем схему исполнения и оплаты…'),
  });
  renderContractExecutionPolicy(contract);

  try {
    const totalPrice = Number(document.getElementById('cFieldTotalPrice')?.value) || Number(contract?.totalPrice) || 0;
    const result = await autofillContractExecutionPolicyFromDocument(files, {
      contractNumber: contract?.number,
      contractTitle: contract?.title,
      totalPrice,
    });

    const mergedPolicy = mergeContractExecutionPolicyPatch(getContractExecutionPolicy(contract), result.executionPolicy || {});
    contract.executionPolicy = mergedPolicy;
    contract.advancePct = mergedPolicy.hasAdvance ? (Number(mergedPolicy.advancePercent) || 0) : 0;

    const patchEvidence = applyContractAutofillPatchToDom(contract, result.contractPatch || {});
    const productImport = addRecognizedProductsToCatalog(result.products || []);
    const contractItemsFill = buildContractItemsFromRecognizedProducts(contract, result.products || []);

    const warnings = [...(result.warnings || [])];
    if (result.contractPatch?.supplierName && !contract.supplierId) {
      warnings.unshift(`Поставщик найден в договоре, но не сопоставлен автоматически: ${result.contractPatch.supplierName}`);
    }
    if (productImport.total > 0) {
      if (productImport.added > 0) {
        warnings.unshift(`В каталог добавлено товаров: ${productImport.added} из ${productImport.total}. Для новых карточек проверьте категорию и товарную группу вручную.`);
      }
      if (productImport.duplicates > 0) {
        warnings.push(`Пропущены как уже существующие в каталоге: ${productImport.duplicates}.`);
      }
    }
    if (contractItemsFill.applied > 0) {
      patchEvidence.unshift(`Строки контракта заполнены: ${contractItemsFill.applied}`);
      patchEvidence.unshift(`Цены заполнены: ${contractItemsFill.priced}`);
      patchEvidence.unshift(`Количества заполнены: ${contractItemsFill.qtyFilled}`);
    }

    const summaryParts = [String(result.summary || '').trim()].filter(Boolean);
    if (productImport.total > 0) {
      summaryParts.push(`Распознано товаров: ${productImport.total}. Добавлено в каталог: ${productImport.added}.`);
    }
    if (contractItemsFill.applied > 0) {
      summaryParts.push(`Строк в контракте заполнено: ${contractItemsFill.applied}.`);
    }

    setContractPolicyAutofillState(contract?.id, {
      fileName: result.fileName,
      confidence: result.confidence,
      summary: summaryParts.join(' '),
      evidence: [...patchEvidence, ...(result.evidence || [])],
      warnings,
    });
    renderCardHeader(contract);
    renderContractExecutionPolicy(contract);
    renderItemsTable(contract);
    renderRenameActSection(contract);
    const toastMessage = (productImport.added > 0 || contractItemsFill.applied > 0)
      ? tf('contracts.policyAutofillAppliedWithItems', 'Договор распознан: реквизиты, схема, товары и цены заполнены; новые товары добавлены в каталог.')
      : tf('contracts.policyAutofillApplied', 'Схема заполнена по загруженному договору. Проверьте поля и сохраните карточку.');
    showToast(toastMessage, 'success');
  } catch (error) {
    setContractPolicyAutofillState(contract?.id, {
      error: error?.message || tf('contracts.policyAutofillError', 'Автозаполнение не удалось'),
    });
    renderContractExecutionPolicy(contract);
    showToast(error?.message || tf('contracts.policyAutofillError', 'Автозаполнение не удалось'), 'error');
  }
}

function buildContractExecutionPolicySummary(policy) {
  return [
    policy.usesReadiness
      ? 'готовность места эксплуатации учитывается'
      : 'готовность места эксплуатации не влияет на оплату',
    policy.hasAdvance && policy.advancePercent > 0
      ? `аванс ${policy.advancePercent}% (${ADVANCE_OFFSET_MODE_LABELS[policy.advanceOffsetMode] || ADVANCE_OFFSET_MODE_LABELS.sequential})`
      : 'без авансирования',
    `если место готово: ${EXECUTION_ROUTE_LABELS[policy.routeWhenReady] || EXECUTION_ROUTE_LABELS.direct} → ${EXECUTION_SCENARIO_LABELS[policy.scenarioWhenReady] || EXECUTION_SCENARIO_LABELS.full}`,
    `если место не готово: ${EXECUTION_ROUTE_LABELS[policy.routeWhenNotReady] || EXECUTION_ROUTE_LABELS.warehouse} → ${EXECUTION_SCENARIO_LABELS[policy.scenarioWhenNotReady] || EXECUTION_SCENARIO_LABELS.split}`,
    (policy.scenarioWhenReady === 'split' || policy.scenarioWhenNotReady === 'split')
      ? `этапы оплаты: ${policy.stage1Percent}% / ${policy.stage2Percent}%`
      : 'этапы оплаты не используются',
  ];
}

function renderContractExecutionPolicy(contract) {
  const wrap = ensureContractExecutionPolicyWrap();
  if (!wrap || !contract) return;

  const policy = getContractExecutionPolicy(contract);
  const filesCount = getContractStoredDocuments(contract).length;
  const autofillState = getContractPolicyAutofillState(contract?.id);
  const autofillStateHtml = buildContractPolicyAutofillStateHtml(contract, filesCount);
  const headerAdvanceInput = document.getElementById('cFieldAdvancePct');
  if (headerAdvanceInput) headerAdvanceInput.value = policy.hasAdvance ? String(policy.advancePercent || '') : '';
  const totalPrice = Number(document.getElementById('cFieldTotalPrice')?.value) || Number(contract.totalPrice) || 0;
  const advanceAmount = getContractAdvanceAmount({ ...contract, executionPolicy: policy }, totalPrice);

  wrap.innerHTML = `
    <div class="rounded-2xl border border-white/10 bg-white/[0.04] p-4 space-y-4">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div class="min-w-0">
          <p class="text-sm font-semibold text-white">${escHtml(tf('contracts.policyAutofillTitle', 'Автозаполнение схемы'))}</p>
          <p class="mt-1 text-xs text-slate-500">${escHtml(tf('contracts.policyAutofillHint', 'Анализирует загруженный договор и заполняет схему исполнения, этапы оплаты и аванс.'))}</p>
        </div>
        <button id="cPolicyAutofillBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/15 hover:border-cyan-400/40 disabled:cursor-not-allowed disabled:opacity-50" ${autofillState?.loading ? 'disabled' : ''}>
          <span aria-hidden="true">🤖</span>
          <span>${escHtml(autofillState?.loading ? tf('contracts.policyAutofillLoadingShort', 'Анализ…') : tf('contracts.policyAutofillBtn', 'Заполнить из договора'))}</span>
        </button>
      </div>

      ${autofillStateHtml}

      <div class="grid gap-4 lg:grid-cols-2">
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Готовность места влияет на оплату</span>
          <select id="cPolicyUsesReadiness" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="0" ${policy.usesReadiness ? '' : 'selected'}>Нет</option>
            <option value="1" ${policy.usesReadiness ? 'selected' : ''}>Да</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Авансирование</span>
          <select id="cPolicyHasAdvance" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="0" ${policy.hasAdvance ? '' : 'selected'}>Без аванса</option>
            <option value="1" ${policy.hasAdvance ? 'selected' : ''}>С авансом</option>
          </select>
        </label>
      </div>

      <div id="cPolicyAdvanceWrap" class="grid gap-4 lg:grid-cols-2 ${policy.hasAdvance ? '' : 'hidden'}">
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Аванс, % от цены контракта</span>
          <input id="cPolicyAdvancePercent" type="number" min="0" max="100" step="1" value="${escHtml(policy.advancePercent)}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Правило зачёта аванса</span>
          <select id="cPolicyAdvanceOffsetMode" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="sequential" ${policy.advanceOffsetMode === 'sequential' ? 'selected' : ''}>Приоритетный</option>
            <option value="proportional" ${policy.advanceOffsetMode === 'proportional' ? 'selected' : ''}>Пропорциональный</option>
            <option value="manual" ${policy.advanceOffsetMode === 'manual' ? 'selected' : ''}>Ручной</option>
          </select>
          <p class="text-[11px] text-slate-500">Расчётный объём аванса: ${fmtNum(advanceAmount)} ₽</p>
        </label>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Если место готово: маршрут</span>
          <select id="cPolicyRouteWhenReady" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="direct" ${policy.routeWhenReady === 'direct' ? 'selected' : ''}>Сразу получателю</option>
            <option value="warehouse" ${policy.routeWhenReady === 'warehouse' ? 'selected' : ''}>На склад</option>
            <option value="manual" ${policy.routeWhenReady === 'manual' ? 'selected' : ''}>Определяет пользователь</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Если место готово: расчёт</span>
          <select id="cPolicyScenarioWhenReady" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="full" ${policy.scenarioWhenReady === 'full' ? 'selected' : ''}>Полный расчёт</option>
            <option value="split" ${policy.scenarioWhenReady === 'split' ? 'selected' : ''}>Этапная схема</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Если место не готово: маршрут</span>
          <select id="cPolicyRouteWhenNotReady" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="warehouse" ${policy.routeWhenNotReady === 'warehouse' ? 'selected' : ''}>На склад</option>
            <option value="direct" ${policy.routeWhenNotReady === 'direct' ? 'selected' : ''}>Сразу получателю</option>
            <option value="manual" ${policy.routeWhenNotReady === 'manual' ? 'selected' : ''}>Определяет пользователь</option>
          </select>
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Если место не готово: расчёт</span>
          <select id="cPolicyScenarioWhenNotReady" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
            <option value="split" ${policy.scenarioWhenNotReady === 'split' ? 'selected' : ''}>Этапная схема</option>
            <option value="full" ${policy.scenarioWhenNotReady === 'full' ? 'selected' : ''}>Полный расчёт</option>
          </select>
        </label>
      </div>

      <div id="cPolicyStageWrap" class="grid gap-4 lg:grid-cols-2 ${(policy.scenarioWhenReady === 'split' || policy.scenarioWhenNotReady === 'split') ? '' : 'hidden'}">
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Этап 1, %</span>
          <input id="cPolicyStage1Percent" type="number" min="0" max="100" step="1" value="${escHtml(policy.stage1Percent)}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
        </label>
        <label class="space-y-1.5">
          <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Этап 2, %</span>
          <input id="cPolicyStage2Percent" type="number" min="0" max="100" step="1" value="${escHtml(policy.stage2Percent)}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50">
        </label>
      </div>

      <div class="grid gap-3 lg:grid-cols-2">
        <label class="flex items-start gap-3 rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3">
          <input id="cPolicyRequireNotReadyAct" type="checkbox" class="mt-1 h-4 w-4 accent-cyan-400" ${policy.requireNotReadyAct ? 'checked' : ''}>
          <div>
            <span class="block text-sm font-semibold text-white">Требовать акт неготовности</span>
            <span class="mt-1 block text-xs text-slate-500">Показывать напоминание в заявке при сценарии «место не готово».</span>
          </div>
        </label>
        <label class="flex items-start gap-3 rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3">
          <input id="cPolicyRequireReadyAct" type="checkbox" class="mt-1 h-4 w-4 accent-cyan-400" ${policy.requireReadyAct ? 'checked' : ''}>
          <div>
            <span class="block text-sm font-semibold text-white">Требовать акт готовности</span>
            <span class="mt-1 block text-xs text-slate-500">Показывать напоминание перед финальным этапом по заявке.</span>
          </div>
        </label>
      </div>

      <div class="rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] px-4 py-3">
        <p class="text-xs font-semibold uppercase tracking-wider text-cyan-300 mb-2">Итоговая логика по контракту</p>
        <ul class="space-y-1 text-xs text-slate-300 list-disc pl-4">${buildContractExecutionPolicySummary(policy).map(line => `<li>${escHtml(line)}</li>`).join('')}</ul>
      </div>
    </div>`;

  const toggleStageWrap = () => {
    const hasAdvance = document.getElementById('cPolicyHasAdvance')?.value === '1';
    document.getElementById('cPolicyAdvanceWrap')?.classList.toggle('hidden', !hasAdvance);
    const split = document.getElementById('cPolicyScenarioWhenReady')?.value === 'split'
      || document.getElementById('cPolicyScenarioWhenNotReady')?.value === 'split';
    document.getElementById('cPolicyStageWrap')?.classList.toggle('hidden', !split);
  };

  document.getElementById('cPolicyHasAdvance')?.addEventListener('change', toggleStageWrap);
  document.getElementById('cPolicyScenarioWhenReady')?.addEventListener('change', toggleStageWrap);
  document.getElementById('cPolicyScenarioWhenNotReady')?.addEventListener('change', toggleStageWrap);
  document.getElementById('cPolicyAutofillBtn')?.addEventListener('click', () => handleContractPolicyAutofill(contract));
}

function ensureContractClaimsButton(contract) {
  const actsBtn = document.getElementById('contractActsBtn');
  if (!actsBtn) return null;

  let btn = document.getElementById('contractClaimsBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'contractClaimsBtn';
    btn.type = 'button';
    btn.className = 'inline-flex items-center gap-1.5 rounded-xl border border-amber-400/20 bg-amber-400/[0.08] px-3 py-2.5 text-sm font-medium text-amber-300 transition hover:bg-amber-400/[0.14] hover:border-amber-400/35 hover:text-amber-200 active:scale-[0.97]';
    actsBtn.insertAdjacentElement('afterend', btn);
  }

  const claimsCount = (state.claims || []).filter(claim => String(claim.contractId) === String(contract?.id)).length;
  btn.innerHTML = '<span aria-hidden="true">⚖️</span><span>' + escHtml(tf('claims.buttonTitle', 'Претензии')) + '</span>' +
    (claimsCount > 0
      ? '<span class="rounded-lg bg-amber-400/15 px-2 py-0.5 text-[10px] font-bold text-amber-200 tabular-nums">' + claimsCount + '</span>'
      : '');

  return btn;
}

function normalizeContractDocumentRecord(fileRecord, sourceType = 'bundle') {
  if (!fileRecord || !fileRecord.dataUrl) return null;
  return {
    id: fileRecord.id || ('doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now()),
    sourceType,
    originalName: fileRecord.originalName || t('contracts.mainDocumentTitle'),
    mimeType: fileRecord.mimeType || 'application/octet-stream',
    sizeBytes: Number(fileRecord.sizeBytes) || 0,
    uploadedAt: fileRecord.uploadedAt || new Date().toISOString(),
    dataUrl: fileRecord.dataUrl,
  };
}

function getContractStoredDocuments(contract) {
  const direct = Array.isArray(contract?.bundleDocuments)
    ? contract.bundleDocuments.map(file => normalizeContractDocumentRecord(file, file?.sourceType || 'bundle')).filter(Boolean)
    : [];
  if (direct.length) return direct;

  return [
    normalizeContractDocumentRecord(contract?.bundleDocument, 'bundle'),
    normalizeContractDocumentRecord(contract?.contractDocument, 'contract'),
    normalizeContractDocumentRecord(contract?.tzDocument, 'tz'),
  ].filter(Boolean);
}

function buildContractDocumentItemsHtml(files) {
  if (!files.length) {
    return '<div class="rounded-xl border border-dashed border-white/10 bg-slate-950/40 px-4 py-3">' +
      '<p class="text-sm text-slate-400">' + escHtml(t('contracts.documentEmpty')) + '</p>' +
    '</div>';
  }

  return '<div class="space-y-3">' + files.map((fileRecord, idx) => {
    const meta = buildStoredFileMeta(fileRecord);
    return '<div class="rounded-xl border border-white/10 bg-slate-950/40 px-4 py-3">' +
      '<div class="flex items-start justify-between gap-3 flex-wrap">' +
        '<div class="min-w-0 flex-1">' +
          '<div class="flex items-center gap-2 flex-wrap">' +
            '<span class="rounded-lg bg-white/8 px-2 py-1 text-[10px] font-semibold text-slate-300">' + escHtml(t('contracts.documentLabel', { index: idx + 1 })) + '</span>' +
            (fileRecord.sourceType && fileRecord.sourceType !== 'bundle'
              ? '<span class="rounded-lg bg-violet-400/15 px-2 py-1 text-[10px] font-semibold text-violet-300">' + escHtml(fileRecord.sourceType === 'contract' ? t('contracts.contractDocumentTitle') : t('contracts.tzDocumentTitle')) + '</span>'
              : '') +
          '</div>' +
          '<p class="mt-2 text-sm font-semibold text-white break-all">' + escHtml(fileRecord.originalName || t('contracts.mainDocumentTitle')) + '</p>' +
          '<p class="mt-1 text-xs text-slate-500">' + escHtml(meta || t('contracts.documentEmpty')) + '</p>' +
        '</div>' +
        '<div class="flex flex-wrap gap-2">' +
          '<button type="button" data-contract-doc-download="' + escHtml(String(fileRecord.id)) + '" class="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/15 hover:border-emerald-400/40">' +
            '<span aria-hidden="true">⬇️</span><span>' + escHtml(t('contracts.downloadFile')) + '</span></button>' +
          '<button type="button" data-contract-doc-remove="' + escHtml(String(fileRecord.id)) + '" data-readonly-hide="true" class="inline-flex items-center gap-1.5 rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-400/15 hover:border-red-400/40">' +
            '<span aria-hidden="true">🗑️</span><span>' + escHtml(t('contracts.removeFile')) + '</span></button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('') + '</div>';
}

function buildContractDocumentCard(files) {
  return '<article class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">' +
    '<div class="flex items-start justify-between gap-3 flex-wrap">' +
      '<div class="min-w-0">' +
        '<div class="flex items-center gap-2 flex-wrap">' +
          '<span class="rounded-lg bg-violet-400/15 px-2 py-1 text-[10px] font-bold text-violet-300 uppercase tracking-wide">' + escHtml(t('contracts.mainDocumentTitle')) + '</span>' +
          '<span class="rounded-lg bg-white/8 px-2 py-1 text-[10px] font-semibold text-slate-300">' + escHtml(t('contracts.filesCount', { count: files.length })) + '</span>' +
        '</div>' +
        '<p class="mt-2 text-xs text-slate-400">' + escHtml(t('contracts.mainDocumentHint')) + '</p>' +
      '</div>' +
    '</div>' +
    '<div class="mt-4">' + buildContractDocumentItemsHtml(files) + '</div>' +
    '<div class="mt-4 flex flex-col gap-3">' +
      '<div data-readonly-hide="true" class="rounded-xl border border-dashed border-cyan-400/20 bg-cyan-400/[0.04] px-4 py-4">' +
        '<div class="flex items-center justify-between gap-3 flex-wrap">' +
          '<div class="min-w-0">' +
            '<p class="text-sm font-semibold text-white">' + escHtml(files.length ? tf('contracts.addMoreFiles', 'Добавить ещё файлы') : tf('contracts.contractFilesTitle', 'Файлы договора')) + '</p>' +
            '<p class="mt-1 text-xs text-slate-400">' + escHtml(t('contracts.uploadMultipleHint')) + '</p>' +
          '</div>' +
          '<button id="contractBundlePickBtn" type="button" class="inline-flex cursor-pointer items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/12 px-4 py-2.5 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-400/18 hover:border-cyan-400/45 overflow-hidden">' +
            '<span aria-hidden="true">📎</span><span>' + escHtml(t('contracts.chooseFiles')) + '</span>' +
          '</button>' +
          '<input id="contractBundleInput" data-contract-doc-input="bundle" type="file" multiple accept="' + CONTRACT_DOC_ACCEPT + '" hidden aria-hidden="true">' +
        '</div>' +
      '</div>' +
    '</div>' +
  '</article>';
}

function renderContractDocuments(contract) {
  const wrap = ensureContractDocumentsWrap();
  if (!wrap || !contract) return;

  const files = getContractStoredDocuments(contract);
  if (!Array.isArray(contract.bundleDocuments) && files.length) {
    contract.bundleDocuments = files;
    contract.bundleDocument = null;
    contract.contractDocument = null;
    contract.tzDocument = null;
  }

  wrap.innerHTML =
    buildContractDocumentCard(files) +
    '<p class="mt-3 text-[11px] text-slate-500">' + escHtml(t('contracts.documentsStorageHint')) + '</p>';

  document.getElementById('contractBundlePickBtn')?.addEventListener('click', () => {
    document.getElementById('contractBundleInput')?.click();
  });

  wrap.querySelectorAll('[data-contract-doc-input]').forEach(input => {
    input.addEventListener('change', async () => {
      const selectedFiles = Array.from(input.files || []);
      input.value = '';
      if (!selectedFiles.length) return;

      const tooLarge = selectedFiles.find(file => file.size > CONTRACT_DOC_MAX_BYTES);
      if (tooLarge) {
        showToast(t('contracts.fileTooLarge', { size: formatBytes(CONTRACT_DOC_MAX_BYTES) }), 'error', 4500);
        return;
      }

      try {
        const prepared = await Promise.all(selectedFiles.map(async file => ({
          id: 'doc_' + Math.random().toString(36).slice(2, 10) + '_' + Date.now(),
          sourceType: 'bundle',
          originalName: file.name,
          mimeType: file.type || 'application/octet-stream',
          sizeBytes: file.size || 0,
          uploadedAt: new Date().toISOString(),
          dataUrl: await readFileAsDataUrl(file),
        })));

        contract.bundleDocuments = [...files, ...prepared];
        contract.bundleDocument = null;
        contract.contractDocument = null;
        contract.tzDocument = null;
        await saveToStorage();
        renderContractDocuments(contract);
        showToast(t('contracts.filesUploaded', { count: prepared.length }), 'success');
      } catch (error) {
        showToast(error?.message || t('toast.error'), 'error');
      }
    });
  });

  wrap.querySelectorAll('[data-contract-doc-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const fileRecord = getContractStoredDocuments(contract).find(file => String(file.id) === String(btn.dataset.contractDocDownload));
      if (!fileRecord?.dataUrl) return;
      const a = document.createElement('a');
      a.href = fileRecord.dataUrl;
      a.download = fileRecord.originalName || 'contract-document';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  wrap.querySelectorAll('[data-contract-doc-remove]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const docId = String(btn.dataset.contractDocRemove || '');
      contract.bundleDocuments = getContractStoredDocuments(contract).filter(file => String(file.id) !== docId);
      contract.bundleDocument = null;
      contract.contractDocument = null;
      contract.tzDocument = null;
      await saveToStorage();
      renderContractDocuments(contract);
      showToast(t('contracts.fileRemoved'), 'success');
    });
  });
}

function ensureRenameActWrap() {
  const body = document.querySelector('#contractEditPanel > .flex-1.overflow-auto');
  if (!body) return null;

  let section = document.getElementById('contractRenameActSection');
  if (!section) {
    section = document.createElement('section');
    section.id = 'contractRenameActSection';
    section.innerHTML =
      '<h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">' +
        escHtml(tf('contracts.renameActSection', 'Акт переименования')) +
      '</h3>' +
      '<div id="contractRenameActWrap"></div>';

    const financeSection = document.getElementById('contractFinanceSummaryWrap')?.closest('section');
    if (financeSection?.parentElement) {
      financeSection.insertAdjacentElement('beforebegin', section);
    } else {
      body.appendChild(section);
    }
  }

  return document.getElementById('contractRenameActWrap');
}

function syncRenameActRowsFromDom(contract) {
  const rows = Array.from(document.querySelectorAll('#renameActRows [data-rename-row]'));
  const nextRows = (contract.items || []).map((item, index) => {
    const rowEl = rows[index];
    const fallback = contract.renameActRows[index] || buildRenameActRowFromItem(item, index);
    return {
      id: rowEl?.dataset.renameRow || fallback.id || makeLocalId('rename_row'),
      contractItemId: item?.itemId || fallback.contractItemId || '',
      tzPosition: rowEl?.querySelector('[data-rename-field="tzPosition"]')?.value.trim() || fallback.tzPosition || String(index + 1),
      productName: String(item?.name || fallback.productName || '').trim(),
      characteristics: buildCharacteristicsFromProduct(resolveCatalogProductForContractItem(item)) || fallback.characteristics || '',
      price: parseFloat(rowEl?.querySelector('[data-rename-field="price"]')?.value || '') || 0,
      specificationName: rowEl?.querySelector('[data-rename-field="specificationName"]')?.value.trim() || String(item?.specificationName || fallback.specificationName || '').trim(),
      productCode: String(item?.code || fallback.productCode || '').trim(),
    };
  });
  contract.renameActRows = nextRows;
}

function getRenameActExportRows(contract) {
  syncRenameActRowsFromDom(contract);
  return (contract.renameActRows || []).map((row) => ({
    '№ позиции по ТЗ': row.tzPosition || '',
    'Наименование товара': row.productName || '',
    'Характеристики': row.characteristics || '',
    'Цена': row.price || '',
    'Наименование по спецификации': row.specificationName || '',
    'Код товара': row.productCode || '',
  }));
}

function getRenameActTemplateRows(contract) {
  syncRenameActRowsFromDom(contract);

  return (contract.items || []).map((item, index) => {
    const row = contract.renameActRows?.[index] || buildRenameActRowFromItem(item, index);
    const product = resolveCatalogProductForContractItem(item);
    const code = String(item?.code || row?.productCode || '').trim();
    const productName = String(item?.name || row?.productName || '').trim();
    const internalName = code ? `${productName} (${code})` : productName;
    const updName = String(item?.specificationName || row?.specificationName || '').trim();
    const unit = String(item?.unit || product?.unit || tf('contracts.defaultUnitPiece', 'штука')).trim();
    const price = Number(item?.price ?? row?.price) || 0;

    return {
      index: index + 1,
      internalName,
      tzName: productName,
      updName,
      code,
      unit,
      price,
    };
  });
}

function buildRenameActExcelXml(contract) {
  const supplier = state.suppliers.find(s => s.id === contract?.supplierId);
  const supplierName = supplier?.name || tf('contracts.noSupplier', 'Поставщик не указан');
  const customerName = 'Государственное автономное учреждение города Москвы "Центр технического оснащения и модернизации образования"';
  const contractNumber = String(contract?.number || '').trim() || '—';
  const contractDate = fmtDate(String(contract?.date || '').trim()) || String(contract?.date || '').trim() || '—';
  const rows = getRenameActTemplateRows(contract);

  const makeCell = ({ value = '', type = 'String', styleId = 'CellText', mergeAcross = 0 } = {}) => {
    const mergeAttr = mergeAcross ? ` ss:MergeAcross="${mergeAcross}"` : '';
    const cellValue = type === 'Number' ? String(value ?? 0) : escapeXml(value);
    return `<Cell ss:StyleID="${styleId}"${mergeAttr}><Data ss:Type="${type}">${cellValue}</Data></Cell>`;
  };

  const titleRows = [
    `<Row ss:Height="24">${makeCell({ value: 'АКТ', styleId: 'Title', mergeAcross: 6 })}</Row>`,
    `<Row ss:Height="20">${makeCell({ value: 'перевода наименования товаров', styleId: 'Subtitle', mergeAcross: 6 })}</Row>`,
    `<Row ss:Height="20">${makeCell({ value: `по договору № ${contractNumber} от ${contractDate}`, styleId: 'Subtitle', mergeAcross: 6 })}</Row>`,
    '<Row ss:Height="10"/>',
    `<Row ss:Height="24">${makeCell({ value: `Заказчик: ${customerName}`, styleId: 'Meta', mergeAcross: 6 })}</Row>`,
    '<Row ss:Height="10"/>',
    `<Row ss:Height="24">${makeCell({ value: `Подрядчик: ${supplierName}`, styleId: 'Meta', mergeAcross: 6 })}</Row>`,
    '<Row ss:Height="10"/>',
    '<Row ss:Height="10"/>',
  ].join('');

  const headerRow = `<Row ss:Height="42">${[
    '№ п/п',
    'Наименование\nтовара по внутренней номенклатуре',
    'Наименование\nтовара согласно технического задания',
    'Наименование\nтовара по УПД',
    'Код',
    'Единица измерения',
    'Стоимость за единицу товара',
  ].map(text => makeCell({ value: text, styleId: 'Header' })).join('')}</Row>`;

  const bodyRows = rows.map((row) => `<Row ss:AutoFitHeight="0" ss:Height="54">${[
    makeCell({ value: row.index, type: 'Number', styleId: 'CellCenter' }),
    makeCell({ value: row.internalName, styleId: 'CellText' }),
    makeCell({ value: row.tzName, styleId: 'CellText' }),
    makeCell({ value: row.updName, styleId: 'CellText' }),
    makeCell({ value: row.code, styleId: 'CellCenter' }),
    makeCell({ value: row.unit, styleId: 'CellCenter' }),
    makeCell({ value: Number(row.price || 0).toFixed(2), type: 'Number', styleId: 'CellPrice' }),
  ].join('')}</Row>`).join('');

  return `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel"
 xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:html="http://www.w3.org/TR/REC-html40">
 <Styles>
  <Style ss:ID="Default" ss:Name="Normal">
   <Alignment ss:Vertical="Center"/>
   <Borders/>
   <Font ss:FontName="Arial" ss:Size="10"/>
   <Interior/>
   <NumberFormat/>
   <Protection/>
  </Style>
  <Style ss:ID="Title"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="13" ss:Bold="1"/></Style>
  <Style ss:ID="Subtitle"><Alignment ss:Horizontal="Center" ss:Vertical="Center"/><Font ss:FontName="Arial" ss:Size="11"/></Style>
  <Style ss:ID="Meta"><Alignment ss:Horizontal="Left" ss:Vertical="Center" ss:WrapText="1"/><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="Header"><Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders><Font ss:FontName="Arial" ss:Size="10" ss:Bold="1"/><Interior ss:Color="#EDEDED" ss:Pattern="Solid"/></Style>
  <Style ss:ID="CellText"><Alignment ss:Horizontal="Left" ss:Vertical="Top" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="CellCenter"><Alignment ss:Horizontal="Center" ss:Vertical="Top" ss:WrapText="1"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders><Font ss:FontName="Arial" ss:Size="10"/></Style>
  <Style ss:ID="CellPrice"><Alignment ss:Horizontal="Right" ss:Vertical="Top"/><Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1"/><Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1"/></Borders><Font ss:FontName="Arial" ss:Size="10"/><NumberFormat ss:Format="Standard"/></Style>
 </Styles>
 <Worksheet ss:Name="Акт">
  <Table ss:ExpandedColumnCount="7" ss:ExpandedRowCount="${10 + rows.length}" x:FullColumns="1" x:FullRows="1" ss:DefaultRowHeight="15">
   <Column ss:AutoFitWidth="0" ss:Width="44"/>
   <Column ss:AutoFitWidth="0" ss:Width="240"/>
   <Column ss:AutoFitWidth="0" ss:Width="250"/>
   <Column ss:AutoFitWidth="0" ss:Width="250"/>
   <Column ss:AutoFitWidth="0" ss:Width="90"/>
   <Column ss:AutoFitWidth="0" ss:Width="115"/>
   <Column ss:AutoFitWidth="0" ss:Width="130"/>
   ${titleRows}
   ${headerRow}
   ${bodyRows}
  </Table>
  <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
   <PageSetup><Layout x:Orientation="Landscape"/><Header x:Margin="0.2"/><Footer x:Margin="0.2"/><PageMargins x:Bottom="0.5" x:Left="0.35" x:Right="0.35" x:Top="0.5"/></PageSetup>
   <FitToPage/>
   <Print><ValidPrinterInfo/><HorizontalResolution>600</HorizontalResolution><VerticalResolution>600</VerticalResolution></Print>
   <ProtectObjects>False</ProtectObjects>
   <ProtectScenarios>False</ProtectScenarios>
  </WorksheetOptions>
 </Worksheet>
</Workbook>`;
}

function extractRenameActObjectsFromAoa(aoa = []) {
  const nonEmptyRows = aoa.filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''));
  if (!nonEmptyRows.length) return [];

  const normalize = value => String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const headerIndex = nonEmptyRows.findIndex((row) => {
    const first = normalize(row[0]);
    const fourth = normalize(row[3]);
    return first === '№ п/п' || first === '№ позиции по тз' || fourth === 'наименование товара по упд';
  });

  if (headerIndex < 0) return [];
  const headers = (nonEmptyRows[headerIndex] || []).map(value => String(value ?? '').trim());
  const dataRows = nonEmptyRows.slice(headerIndex + 1);

  return dataRows
    .filter(row => Array.isArray(row) && row.some(cell => String(cell ?? '').trim() !== ''))
    .map(row => headers.reduce((acc, header, idx) => {
      acc[header] = row[idx] ?? '';
      return acc;
    }, {}));
}

async function exportRenameAct(contract) {
  const rows = getRenameActTemplateRows(contract);
  if (!rows.length) {
    showToast(tf('contracts.renameActEmptyExport', 'Сначала заполните строки акта переименования.'), 'info');
    return;
  }

  const contractNum = String(contract?.number || 'contract').replace(/[^0-9A-Za-zА-Яа-я_-]+/g, '-');
  const filenameBase = `akt-perevoda-naimenovaniya-${contractNum || 'contract'}`;

  try {
    const xml = buildRenameActExcelXml(contract);
    downloadBlob(
      new Blob([xml], { type: 'application/vnd.ms-excel;charset=utf-8' }),
      `${filenameBase}.xls`,
    );
    showToast(tf('contracts.renameActExported', 'Акт переименования выгружен.'), 'success');
  } catch (error) {
    const csvLines = [
      'АКТ перевода наименования товаров',
      `по договору № ${String(contract?.number || '').trim() || '—'} от ${fmtDate(String(contract?.date || '').trim()) || String(contract?.date || '').trim() || '—'}`,
      '',
      ['№ п/п', 'Наименование товара по внутренней номенклатуре', 'Наименование товара согласно технического задания', 'Наименование товара по УПД', 'Код', 'Единица измерения', 'Стоимость за единицу товара'].join(';'),
      ...rows.map((row) => [
        row.index,
        row.internalName,
        row.tzName,
        row.updName,
        row.code,
        row.unit,
        row.price,
      ].map(escapeCsv).join(';')),
    ];
    downloadBlob(new Blob([csvLines.join('\n')], { type: 'text/csv;charset=utf-8' }), `${filenameBase}.csv`);
    showToast(tf('contracts.renameActExportedCsv', 'Excel недоступен — выгружен CSV.'), 'success');
    console.warn('rename act export fallback:', error);
  }
}

async function importRenameActFile(file, contract) {
  if (!(file instanceof File)) return;

  let rows = [];
  const fileName = String(file.name || '').toLowerCase();

  if (fileName.endsWith('.csv')) {
    const text = await file.text();
    const aoa = text.split(/\r?\n/).map(line => line.split(';').map(parseRenameActValue));
    rows = extractRenameActObjectsFromAoa(aoa);
  } else {
    const XLSX = await loadXLSX();
    const buffer = await file.arrayBuffer();
    const workbook = XLSX.read(buffer, { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    rows = extractRenameActObjectsFromAoa(XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' }));
  }

  if (!rows.length) {
    throw new Error(tf('contracts.renameActImportEmpty', 'В файле нет строк для импорта.'));
  }

  ensureRenameActRows(contract);

  (contract.items || []).forEach((item, index) => {
    const raw = rows[index] || {};
    const row = contract.renameActRows[index] || buildRenameActRowFromItem(item, index);
    const specificationName = parseRenameActValue(raw['Наименование по спецификации'] || raw['Наименование товара по УПД'] || raw['Наименование для документов'] || raw['Наименование по контракту']);
    const price = parseFloat(String(raw['Цена'] || '').replace(/\s/g, '').replace(',', '.')) || 0;
    const tzPosition = parseRenameActValue(raw['№ позиции по ТЗ'] || raw['Позиция ТЗ'] || raw['№ позиции'] || raw['№'] || index + 1);

    if (specificationName) item.specificationName = specificationName;
    if (price) item.price = price;

    row.tzPosition = tzPosition || row.tzPosition || String(index + 1);
    row.productName = String(item.name || row.productName || '').trim();
    row.characteristics = buildCharacteristicsFromProduct(resolveCatalogProductForContractItem(item)) || row.characteristics || '';
    row.specificationName = String(item.specificationName || row.specificationName || item.name || '').trim();
    row.price = Number(item.price) || 0;
    row.productCode = String(item.code || row.productCode || '').trim();
    contract.renameActRows[index] = row;
  });

  await saveToStorage();
  renderRenameActSection(contract);
  showToast(tf('contracts.renameActImported', 'Акт переименования импортирован.'), 'success');
}

function renderRenameActSection(contract) {
  const wrap = ensureRenameActWrap();
  if (!wrap || !contract) return;

  ensureContractItemIds(contract);
  ensureRenameActRows(contract);

  const rowsHtml = (contract.renameActRows || []).map((row, index) => `
      <tr data-rename-row="${escHtml(String(row.id || makeLocalId('rename_row')))}" class="border-b border-white/5 align-top">
        <td class="px-2 py-2"><input data-rename-field="tzPosition" type="text" value="${escHtml(row.tzPosition || '')}" class="w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white"></td>
        <td class="px-2 py-2"><input data-rename-field="productName" type="text" readonly value="${escHtml(row.productName || '')}" class="w-full min-w-[220px] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-200"></td>
        <td class="px-2 py-2"><textarea data-rename-field="characteristics" rows="3" readonly class="w-full min-w-[260px] rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300 resize-y">${escHtml(row.characteristics || '')}</textarea></td>
        <td class="px-2 py-2"><input data-rename-field="specificationName" type="text" value="${escHtml(row.specificationName || '')}" class="w-full min-w-[220px] rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs text-white"></td>
        <td class="px-2 py-2"><input data-rename-field="price" type="number" min="0" step="0.01" value="${escHtml(row.price || '')}" class="w-28 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white tabular-nums"></td>
        <td class="px-2 py-2"><input data-rename-field="productCode" type="text" readonly value="${escHtml(row.productCode || '')}" class="w-28 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 font-mono"></td>
      </tr>`).join('');

  wrap.innerHTML = `
    <div class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">
      <div class="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <p class="text-sm font-semibold text-white">${escHtml(tf('contracts.renameActTitle', 'Таблица соответствия наименований'))}</p>
          <p class="mt-1 text-xs text-slate-500">${escHtml(tf('contracts.renameActHint', 'Здесь фиксируется связь между товаром, строкой контракта и наименованием по спецификации.'))}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button id="renameActImportBtn" type="button" data-readonly-hide="true" class="inline-flex cursor-pointer items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/10 hover:border-cyan-400/30 hover:text-white">📥 ${escHtml(tf('contracts.renameActImport', 'Импорт'))}</button>
          <input id="renameActImportInput" type="file" accept=".xlsx,.xls,.csv" hidden aria-hidden="true">
          <button id="renameActExportBtn" type="button" class="inline-flex items-center gap-1.5 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/15 hover:border-emerald-400/40">📤 ${escHtml(tf('contracts.renameActExport', 'Экспорт'))}</button>
        </div>
      </div>
      <div class="mt-4 overflow-x-auto rounded-xl border border-white/10">
        <table class="min-w-full text-left text-xs">
          <thead>
            <tr class="border-b border-white/10 bg-white/[0.03] text-slate-400">
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">№ ТЗ</th>
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">Наименование товара</th>
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">Характеристики</th>
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">Наименование по спецификации</th>
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">Цена</th>
              <th class="px-2 py-2 font-semibold uppercase tracking-wide">Код товара</th>
            </tr>
          </thead>
          <tbody id="renameActRows">${rowsHtml || `<tr><td colspan="6" class="px-4 py-6 text-center text-slate-500">${escHtml(tf('contracts.renameActEmpty', 'Строки акта переименования пока не заполнены.'))}</td></tr>`}</tbody>
        </table>
      </div>
    </div>`;

  document.getElementById('renameActExportBtn')?.addEventListener('click', () => {
    exportRenameAct(contract);
  });

  document.getElementById('renameActImportBtn')?.addEventListener('click', () => {
    document.getElementById('renameActImportInput')?.click();
  });

  document.getElementById('renameActImportInput')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importRenameActFile(file, contract);
    } catch (error) {
      showToast(error?.message || tf('contracts.renameActImportError', 'Не удалось импортировать акт переименования.'), 'error');
    }
  });

  wrap.querySelectorAll('[data-rename-field="specificationName"]').forEach((input) => {
    input.addEventListener('input', () => {
      const rowEl = input.closest('[data-rename-row]');
      if (!rowEl) return;
      const index = Array.from(document.querySelectorAll('#renameActRows [data-rename-row]')).indexOf(rowEl);
      const item = contract.items[index];
      if (!item) return;
      item.specificationName = input.value;
      if (contract.renameActRows[index]) contract.renameActRows[index].specificationName = input.value;
      const contractInput = document.querySelector(`.item-specification-name[data-row="${index}"]`);
      if (contractInput && contractInput !== input) contractInput.value = input.value;
    });
  });

  wrap.querySelectorAll('[data-rename-field="price"]').forEach((input) => {
    input.addEventListener('input', () => {
      const rowEl = input.closest('[data-rename-row]');
      if (!rowEl) return;
      const index = Array.from(document.querySelectorAll('#renameActRows [data-rename-row]')).indexOf(rowEl);
      const item = contract.items[index];
      if (!item) return;
      const value = parseFloat(input.value) || 0;
      item.price = value;
      if (contract.renameActRows[index]) contract.renameActRows[index].price = value;
      const contractInput = document.querySelector(`.item-price[data-row="${index}"]`);
      if (contractInput && contractInput !== input) contractInput.value = value ? String(value) : '';
      refreshCostCell(contract, index);
      refreshAdvanceCell(contract, index);
      updateItemsTotal(contract);
      checkNmcdForRow(contract, index);
    });
  });
}

function getPrimaryDocTypeLabel(type) {
  switch (type) {
    case 'upd': return 'УПД';
    case 'waybill': return 'Накладная';
    case 'invoice': return 'Счёт';
    case 'act': return 'Акт';
    case 'registry': return 'Реестр';
    default: return 'Документ';
  }
}

function buildSupplyHistorySourceBadge(sourceType) {
  const isDirect = sourceType === 'direct';
  const text = isDirect ? t('delivery.badgeDirect') : t('delivery.badgeWarehouse');
  const className = isDirect
    ? 'bg-fuchsia-400/15 text-fuchsia-300'
    : 'bg-cyan-400/15 text-cyan-300';
  return '<span class="inline-flex items-center rounded-lg px-2 py-1 text-[10px] font-semibold ' + className + '">' + escHtml(text) + '</span>';
}

const _contractSupplyHistoryUiState = new Map();

function getContractSupplyHistoryUiState(contractId) {
  const key = String(contractId || 'new');
  if (!_contractSupplyHistoryUiState.has(key)) {
    _contractSupplyHistoryUiState.set(key, {
      recipient: '',
      product: '',
      collapsedDates: {},
      activeField: '',
      caret: null,
    });
  }
  return _contractSupplyHistoryUiState.get(key);
}

function getContractSupplyHistory(contract) {
  const contractId = Number(contract?.id);
  if (!contractId) return [];

  const history = [];

  for (const shipment of (state.shipments || [])) {
    const shipmentDate = shipment.date || shipment.createdAt || '';
    for (const row of (shipment.rows || [])) {
      let rowOrderId = row?.orderId != null ? Number(row.orderId) || null : null;
      if (rowOrderId == null && row?.orderKey) {
        const parts = String(row.orderKey).split('::');
        if (parts.length === 2 && parts[1] !== 'noorder') rowOrderId = Number(parts[1]) || null;
      }
      const order = rowOrderId != null ? (state.orders || []).find(o => o.id === rowOrderId) : null;
      const rowContractId = Number(row.contractId ?? order?.contractId ?? 0);
      if (rowContractId !== contractId) continue;

      for (const recipientRow of (row.recipients || [])) {
        const qty = Number(recipientRow.qty) || 0;
        if (qty <= 0) continue;
        const recipient = recipientRow.recipientId != null
          ? (state.recipients || []).find(r => String(r.id) === String(recipientRow.recipientId))
          : null;
        history.push({
          sourceType: 'warehouse',
          date: shipmentDate,
          dateLabel: fmtDate(shipmentDate) || '—',
          recipientName: recipientRow.recipientName || recipient?.name || tf('contracts.historyUnknownRecipient', 'Получатель не указан'),
          recipientAddress: recipientRow.address || recipientRow.recipientAddress || recipient?.address || '',
          productName: row.productName || row.contractItemName || tf('contracts.historyUnknownProduct', 'Товар не указан'),
          productCode: row.productCode || row.contractItemCode || '',
          qty,
          supplierName: shipment.supplierName || '',
          orderNumber: order?.orderNumber || row.orderNum || '',
          shipmentLabel: shipment.number || shipment.shipmentNumber || '',
        });
      }
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    if (Number(delivery.contractId) !== contractId) continue;
    const deliveryDate = delivery.date || delivery.createdAt || '';
    for (const row of (delivery.rows || [])) {
      const qty = Number(row.actualQty) || 0;
      if (qty <= 0) continue;
      history.push({
        sourceType: 'direct',
        date: deliveryDate,
        dateLabel: fmtDate(deliveryDate) || '—',
        recipientName: row.recipientName || tf('contracts.historyUnknownRecipient', 'Получатель не указан'),
        recipientAddress: row.recipientAddress || '',
        productName: row.productName || tf('contracts.historyUnknownProduct', 'Товар не указан'),
        productCode: row.productCode || '',
        qty,
        supplierName: delivery.supplierName || '',
        orderNumber: delivery.orderNumber || '',
        shipmentLabel: '',
      });
    }
  }

  return history.sort((a, b) => {
    const dateCompare = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCompare !== 0) return dateCompare;
    const recipientCompare = String(a.recipientName || '').localeCompare(String(b.recipientName || ''), 'ru');
    if (recipientCompare !== 0) return recipientCompare;
    return String(a.productName || '').localeCompare(String(b.productName || ''), 'ru');
  });
}

function renderContractSupplyHistory(contract) {
  const wrap = ensureContractSupplyHistoryWrap();
  if (!wrap || !contract?.id) return;

  const allHistory = getContractSupplyHistory(contract);
  if (!allHistory.length) {
    wrap.innerHTML =
      '<div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-4">' +
      '<p class="text-sm font-semibold text-white">' + escHtml(tf('contracts.supplyHistoryEmpty', 'Поставок по контракту пока нет')) + '</p>' +
      '<p class="mt-1 text-xs text-slate-500">' + escHtml(tf('contracts.supplyHistoryEmptyHint', 'Когда начнутся отгрузки со склада или прямые поставки, история появится здесь.')) + '</p>' +
      '</div>';
    return;
  }

  const uiState = getContractSupplyHistoryUiState(contract.id);
  const recipientFilter = String(uiState.recipient || '');
  const recipientFilterLow = recipientFilter.trim().toLowerCase();
  const productFilter = String(uiState.product || '');
  const productFilterLow = productFilter.trim().toLowerCase();

  const recipientOptions = [...new Set(allHistory.map(item => item.recipientAddress ? `${item.recipientName} — ${item.recipientAddress}` : item.recipientName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
  const productOptions = [...new Set(allHistory.map(item => item.productCode ? `${item.productName} — ${item.productCode}` : item.productName).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));

  const history = allHistory.filter((item) => {
    const recipientHaystack = `${item.recipientName || ''} ${item.recipientAddress || ''}`.toLowerCase();
    if (recipientFilterLow && !recipientHaystack.includes(recipientFilterLow)) return false;
    const productHaystack = `${item.productName || ''} ${item.productCode || ''}`.toLowerCase();
    if (productFilterLow && !productHaystack.includes(productFilterLow)) return false;
    return true;
  });

  const totalQty = history.reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  const warehouseQty = history.reduce((sum, item) => sum + (item.sourceType === 'warehouse' ? (Number(item.qty) || 0) : 0), 0);
  const directQty = history.reduce((sum, item) => sum + (item.sourceType === 'direct' ? (Number(item.qty) || 0) : 0), 0);

  const dateGroups = [];
  const dateMap = new Map();
  history.forEach((item) => {
    const dateKey = item.dateLabel || '—';
    if (!dateMap.has(dateKey)) {
      const dateGroup = { key: dateKey, label: dateKey, recipients: [] };
      dateMap.set(dateKey, dateGroup);
      dateGroups.push(dateGroup);
    }
    const dateGroup = dateMap.get(dateKey);
    const recipientKey = `${item.recipientName}||${item.recipientAddress || ''}`;
    let recipientGroup = dateGroup.recipients.find(r => r.key === recipientKey);
    if (!recipientGroup) {
      recipientGroup = {
        key: recipientKey,
        name: item.recipientName,
        address: item.recipientAddress,
        items: [],
      };
      dateGroup.recipients.push(recipientGroup);
    }
    recipientGroup.items.push(item);
  });

  const filterBarHtml =
    '<div class="mb-3 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">' +
      '<div class="flex flex-wrap items-end gap-3">' +
        '<label class="min-w-[220px] flex-1">' +
          '<span class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">' + escHtml(tf('contracts.supplyHistoryRecipientFilter', 'Получатель')) + '</span>' +
          '<input id="contractSupplyHistoryRecipientFilter" list="contractSupplyHistoryRecipientOptions" type="text" value="' + escHtml(recipientFilter) + '" placeholder="' + escHtml(tf('contracts.supplyHistoryAllRecipients', 'Все получатели')) + '" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">' +
          '<datalist id="contractSupplyHistoryRecipientOptions">' +
            recipientOptions.map(name => '<option value="' + escHtml(name) + '"></option>').join('') +
          '</datalist>' +
        '</label>' +
        '<label class="min-w-[220px] flex-1">' +
          '<span class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">' + escHtml(tf('contracts.supplyHistoryProductFilter', 'Товар')) + '</span>' +
          '<input id="contractSupplyHistoryProductFilter" list="contractSupplyHistoryProductOptions" type="text" value="' + escHtml(productFilter) + '" placeholder="' + escHtml(tf('contracts.supplyHistoryProductPlaceholder', 'Введите название товара')) + '" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">' +
          '<datalist id="contractSupplyHistoryProductOptions">' +
            productOptions.map(name => '<option value="' + escHtml(name) + '"></option>').join('') +
          '</datalist>' +
        '</label>' +
        '<button id="contractSupplyHistoryResetBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.09] hover:border-white/20">✕ ' + escHtml(tf('actions.reset', 'Сброс')) + '</button>' +
      '</div>' +
    '</div>';

  wrap.innerHTML =
    filterBarHtml +
    '<div class="mb-3 flex flex-wrap items-center gap-2 text-xs text-slate-400">' +
      '<span class="rounded-lg bg-white/[0.04] px-2.5 py-1">' + escHtml(tf('contracts.supplyHistoryRows', 'Строк поставки: {count}', { count: history.length })) + '</span>' +
      '<span class="rounded-lg bg-white/[0.04] px-2.5 py-1">' + escHtml(tf('contracts.supplyHistoryTotalQty', 'Всего поставлено: {qty} шт.', { qty: totalQty })) + '</span>' +
      '<span class="rounded-lg bg-cyan-400/10 px-2.5 py-1 text-cyan-300">' + escHtml(tf('contracts.supplyHistoryWarehouseQty', 'Со склада: {qty} шт.', { qty: warehouseQty })) + '</span>' +
      '<span class="rounded-lg bg-fuchsia-400/10 px-2.5 py-1 text-fuchsia-300">' + escHtml(tf('contracts.supplyHistoryDirectQty', 'Прямые поставки: {qty} шт.', { qty: directQty })) + '</span>' +
    '</div>' +
    (history.length ? '<div class="space-y-4">' : '<div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-4 text-sm text-slate-400">' + escHtml(tf('contracts.supplyHistoryFilteredEmpty', 'По выбранным фильтрам поставок не найдено.')) + '</div>') +
    (history.length ?
      dateGroups.map((dateGroup) => {
        const dateQty = dateGroup.recipients.reduce((sum, recipientGroup) => sum + recipientGroup.items.reduce((s, row) => s + (Number(row.qty) || 0), 0), 0);
        const isCollapsed = !!uiState.collapsedDates[dateGroup.key];
        return '<article class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">' +
          '<div class="flex items-center justify-between gap-3 flex-wrap">' +
            '<div class="flex items-center gap-2 flex-wrap">' +
              '<button type="button" data-history-date-toggle="' + escHtml(dateGroup.key) + '" class="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/[0.05] px-2.5 py-1.5 text-left text-[10px] font-bold uppercase tracking-wide text-slate-300 transition hover:bg-white/[0.09] hover:border-white/20">' +
                '<span aria-hidden="true" class="text-xs">' + (isCollapsed ? '▸' : '▾') + '</span>' +
                '<span>' + escHtml(dateGroup.label) + '</span>' +
              '</button>' +
              '<span class="text-xs text-slate-500">' + escHtml(tf('contracts.supplyHistoryRecipientsCount', 'Получателей: {count}', { count: dateGroup.recipients.length })) + '</span>' +
            '</div>' +
            '<div class="text-xs font-semibold text-cyan-400">' + escHtml(tf('contracts.supplyHistoryDateQty', 'Всего за дату: {qty} шт.', { qty: dateQty })) + '</div>' +
          '</div>' +
          '<div class="mt-3 space-y-3' + (isCollapsed ? ' hidden' : '') + '" data-history-date-body="' + escHtml(dateGroup.key) + '">' +
            dateGroup.recipients.map((recipientGroup) => {
              const recipientQty = recipientGroup.items.reduce((sum, row) => sum + (Number(row.qty) || 0), 0);
              return '<div class="rounded-xl border border-white/8 bg-slate-950/35 px-3 py-3">' +
                '<div class="flex items-start justify-between gap-3 flex-wrap">' +
                  '<div class="min-w-0">' +
                    '<p class="text-sm font-semibold text-white">' + escHtml(recipientGroup.name) + '</p>' +
                    '<p class="mt-1 text-xs text-slate-500">' + escHtml(recipientGroup.address || tf('contracts.supplyHistoryNoAddress', 'Адрес не указан')) + '</p>' +
                  '</div>' +
                  '<div class="text-xs font-semibold text-emerald-400">' + escHtml(tf('contracts.supplyHistoryRecipientQty', 'Итого: {qty} шт.', { qty: recipientQty })) + '</div>' +
                '</div>' +
                '<div class="mt-3 space-y-2">' +
                  recipientGroup.items.map((row) => {
                    const metaParts = [];
                    if (row.orderNumber) metaParts.push(tf('contracts.supplyHistoryOrderMeta', 'Заявка: {num}', { num: row.orderNumber }));
                    if (row.shipmentLabel) metaParts.push(tf('contracts.supplyHistoryShipmentMeta', 'Отгрузка: {num}', { num: row.shipmentLabel }));
                    if (row.supplierName) metaParts.push(row.supplierName);
                    return '<div class="flex items-start justify-between gap-3 rounded-xl border border-white/6 bg-white/[0.03] px-3 py-2.5 flex-wrap">' +
                      '<div class="min-w-0 flex-1">' +
                        '<div class="flex items-center gap-2 flex-wrap">' +
                          buildSupplyHistorySourceBadge(row.sourceType) +
                          '<span class="text-sm font-medium text-white">' + escHtml(row.productName) + '</span>' +
                          (row.productCode ? '<span class="rounded-lg bg-white/[0.05] px-2 py-0.5 text-[10px] font-mono text-cyan-300">' + escHtml(row.productCode) + '</span>' : '') +
                        '</div>' +
                        '<p class="mt-1 text-xs text-slate-500">' + escHtml(metaParts.join(' · ') || tf('contracts.supplyHistoryNoMeta', 'Без дополнительных реквизитов')) + '</p>' +
                      '</div>' +
                      '<div class="text-right">' +
                        '<div class="text-[10px] uppercase tracking-wide text-slate-500">' + escHtml(tf('contracts.supplyHistoryQtyLabel', 'Количество')) + '</div>' +
                        '<div class="text-sm font-semibold text-cyan-400 tabular-nums">' + escHtml(String(row.qty)) + '</div>' +
                      '</div>' +
                    '</div>';
                  }).join('') +
                '</div>' +
              '</div>';
            }).join('') +
          '</div>' +
        '</article>';
      }).join('') +
    '</div>' : '');

  if (uiState.activeField === 'recipient' || uiState.activeField === 'product') {
    const restoreId = uiState.activeField === 'recipient'
      ? 'contractSupplyHistoryRecipientFilter'
      : 'contractSupplyHistoryProductFilter';
    requestAnimationFrame(() => {
      const input = document.getElementById(restoreId);
      if (!input) return;
      input.focus();
      const pos = Math.min(Number(uiState.caret ?? input.value.length), input.value.length);
      try { input.setSelectionRange(pos, pos); } catch {}
    });
  }

  document.getElementById('contractSupplyHistoryRecipientFilter')?.addEventListener('input', (event) => {
    uiState.recipient = event.target.value || '';
    uiState.activeField = 'recipient';
    uiState.caret = event.target.selectionStart;
    renderContractSupplyHistory(contract);
  });

  document.getElementById('contractSupplyHistoryProductFilter')?.addEventListener('input', (event) => {
    uiState.product = event.target.value || '';
    uiState.activeField = 'product';
    uiState.caret = event.target.selectionStart;
    renderContractSupplyHistory(contract);
  });

  document.getElementById('contractSupplyHistoryResetBtn')?.addEventListener('click', () => {
    uiState.recipient = '';
    uiState.product = '';
    uiState.activeField = '';
    uiState.caret = null;
    renderContractSupplyHistory(contract);
  });

  wrap.querySelectorAll('[data-history-date-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = String(btn.dataset.historyDateToggle || '');
      uiState.collapsedDates[key] = !uiState.collapsedDates[key];
      renderContractSupplyHistory(contract);
    });
  });

  enhancePredictiveInput(document.getElementById('contractSupplyHistoryRecipientFilter'), {
    listId: 'contractSupplyHistoryRecipientOptions',
    options: recipientOptions,
    icon: '👤',
    minWidth: '220px',
  });
  enhancePredictiveInput(document.getElementById('contractSupplyHistoryProductFilter'), {
    listId: 'contractSupplyHistoryProductOptions',
    options: productOptions,
    icon: '📦',
    minWidth: '220px',
  });
}

function getContractPrimaryDocs(contract) {
  const contractId = Number(contract?.id);
  const contractNumber = String(contract?.number || '').trim().toLowerCase();

  return [...(state.primaryDocs || [])]
    .filter(doc => {
      if (Number(doc.contractId) === contractId) return true;
      if (!contractNumber) return false;
      const docRefs = [doc.contract?.number, doc.contract?.ref, doc.field8]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return !!docRefs && docRefs.includes(contractNumber);
    })
    .sort((a, b) => String(b.updatedAt || b.savedAt || '').localeCompare(String(a.updatedAt || a.savedAt || '')));
}

function renderContractPrimaryDocs(contract) {
  const wrap = ensureContractPrimaryDocsWrap();
  if (!wrap || !contract?.id) return;

  const docs = getContractPrimaryDocs(contract);
  if (!docs.length) {
    wrap.innerHTML =
      '<div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-4">' +
      '<p class="text-sm font-semibold text-white">Пока нет привязанной первички</p>' +
      '<p class="mt-1 text-xs text-slate-500">Откройте модуль «📄 Первичка», распознайте документ и выберите этот контракт в поле «Контракт в проекте».</p>' +
      '<div class="mt-3"><button id="openPrimaryDocsFromContractEmptyBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/15 hover:border-cyan-400/40">📄 Открыть первичку</button></div>' +
      '</div>';
    document.getElementById('openPrimaryDocsFromContractEmptyBtn')?.addEventListener('click', () => {
      openPrimaryDocsModal();
    });
    return;
  }

  wrap.innerHTML =
    '<div class="mb-3 flex items-center justify-between gap-3 flex-wrap">' +
      '<div class="text-xs text-slate-500">Связано документов: <span class="font-semibold text-cyan-400">' + docs.length + '</span></div>' +
      '<div class="text-xs text-slate-500">Редактирование и загрузка — в модуле «Первичка»</div>' +
    '</div>' +
    '<div class="space-y-3">' +
      docs.map(doc => {
        const order = doc.orderId ? (state.orders || []).find(o => o.id === doc.orderId) : null;
        const amount = doc.totals?.amountWithVat || doc.totals?.amountNoVat || '';
        const seller = doc.seller?.name || '—';
        const buyer = doc.buyer?.name || '—';
        const num = doc.number || 'без номера';
        const date = doc.date || 'без даты';
        const type = escHtml(getPrimaryDocTypeLabel(doc.docType));
        const meta = [
          doc.status ? 'статус ' + String(doc.status) : '',
          doc.field8 ? 'поле 8: ' + String(doc.field8) : '',
          doc.sourceName || '',
        ].filter(Boolean).join(' · ');

        return '<article class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3">' +
          '<div class="flex items-start justify-between gap-3 flex-wrap">' +
            '<div class="min-w-0">' +
              '<div class="flex items-center gap-2 flex-wrap">' +
                '<span class="rounded-lg bg-cyan-400/15 px-2 py-1 text-[10px] font-bold text-cyan-400 uppercase tracking-wide">' + type + '</span>' +
                '<span class="text-sm font-semibold text-white">' + escHtml(num) + '</span>' +
                '<span class="text-xs text-slate-500">от ' + escHtml(date) + '</span>' +
              '</div>' +
              '<p class="mt-1 text-xs text-slate-300 truncate">' + escHtml(doc.title || doc.sourceName || 'Документ') + '</p>' +
            '</div>' +
            '<div class="text-right">' +
              '<div class="text-[10px] uppercase tracking-wide text-slate-500">Сумма</div>' +
              '<div class="text-sm font-semibold text-emerald-400 tabular-nums">' + (amount ? escHtml(String(amount)) : '—') + '</div>' +
            '</div>' +
          '</div>' +
          '<div class="mt-3 grid gap-2 sm:grid-cols-2">' +
            '<div class="rounded-xl bg-slate-950/40 px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-slate-500">Продавец</div><div class="mt-1 text-xs text-slate-200">' + escHtml(seller) + '</div></div>' +
            '<div class="rounded-xl bg-slate-950/40 px-3 py-2"><div class="text-[10px] uppercase tracking-wide text-slate-500">Покупатель</div><div class="mt-1 text-xs text-slate-200">' + escHtml(buyer) + '</div></div>' +
          '</div>' +
          '<div class="mt-3 flex items-center justify-between gap-3 flex-wrap text-xs text-slate-500">' +
            '<span>' + (order ? ('Заявка: ' + escHtml(order.orderNumber || ('#' + order.id))) : 'Заявка не привязана') + '</span>' +
            '<span>' + escHtml(meta || 'Без доп. реквизитов') + '</span>' +
          '</div>' +
          '<div class="mt-3 flex flex-wrap gap-2">' +
            '<button type="button" class="open-primary-doc-btn inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/15 hover:border-cyan-400/40" data-doc-id="' + escHtml(String(doc.id)) + '">🔍 Открыть документ</button>' +
            '<button type="button" class="open-primary-registry-btn inline-flex items-center gap-1.5 rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.09] hover:border-white/20" data-doc-id="' + escHtml(String(doc.id)) + '">🗂 Реестр первички</button>' +
          '</div>' +
        '</article>';
      }).join('') +
    '</div>';

  wrap.querySelectorAll('.open-primary-doc-btn, .open-primary-registry-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openPrimaryDocsRegistry(btn.dataset.docId);
    });
  });
}

// ── Header fields ─────────────────────────────────────────────────

function renderCardHeader(contract) {
  const wrap = document.getElementById('contractHeaderFields');
  if (!wrap) return;

  const lotOptions = [...new Set(
    (state.lots || [])
      .map(lot => String(lot?.lotNumber || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ru'));

  const supplierOptions = state.suppliers.map(s =>
    '<option value="' + s.id + '" ' + (s.id === contract.supplierId ? 'selected' : '') + '>' + escHtml(s.name) + '</option>'
  ).join('');

  wrap.innerHTML =
    '<div class="grid grid-cols-1 sm:grid-cols-2 gap-4">' +
    '<div class="sm:col-span-2">' +
    '<label for="cFieldTitle" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldTitle') + '</label>' +
    '<input id="cFieldTitle" type="text" value="' + escHtml(contract.title || '') + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' placeholder="' + t('contracts.titlePlaceholder') + '">' +
    '</div>' +
    '<div>' +
    '<label for="cFieldNumber" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldNumber') + '</label>' +
    '<input id="cFieldNumber" type="text" value="' + escHtml(contract.number) + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' placeholder="' + t('contracts.numberPlaceholder') + '">' +
    '</div>' +
    '<div>' +
    '<label for="cFieldDate" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldDate') + '</label>' +
    '<input id="cFieldDate" type="date" value="' + escHtml(contract.date) + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">' +
    '</div>' +
    '<div class="sm:col-span-2">' +
    '<label for="cFieldLotNumber" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldLotNumber') + '</label>' +
    '<input id="cFieldLotNumber" type="text" list="contractLotNumberOptions" value="' + escHtml(contract.lotNumber || '') + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' placeholder="' + t('contracts.lotNumberPlaceholder') + '">' +
    '<datalist id="contractLotNumberOptions">' +
      lotOptions.map(option => '<option value="' + escHtml(option) + '"></option>').join('') +
    '</datalist>' +
    '<p id="cFieldLotStatus" class="mt-1.5 text-xs text-slate-500"></p>' +
    '</div>' +
    '<div class="sm:col-span-2">' +
    '<label for="cFieldSupplier" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldSupplier') + '</label>' +
    '<select id="cFieldSupplier" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]">' +
    '<option value="">' + t('contracts.selectSupplier') + '</option>' +
    supplierOptions +
    '</select></div>' +
    '<div>' +
    '<label for="cFieldTotalPrice" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldTotalPrice') + '</label>' +
    '<input id="cFieldTotalPrice" type="number" min="0" step="0.01" value="' + (contract.totalPrice || '') + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' placeholder="0.00">' +
    '<p id="cPriceWarning" class="mt-1.5 text-xs text-amber-400 hidden"></p>' +
    '</div>' +
    '<div>' +
    '<label for="cFieldAdvancePct" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">' + t('contracts.fieldAdvancePct') + '</label>' +
    '<div class="relative">' +
    '<input id="cFieldAdvancePct" type="number" min="0" max="100" step="1" value="' + (contract.advancePct != null ? contract.advancePct : '') + '"' +
    ' class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 pr-10 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' placeholder="0">' +
    '<span class="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>' +
    '</div>' +
    '<p id="cAdvanceAmount" class="mt-1.5 text-xs text-slate-400 tabular-nums hidden"></p>' +
    '</div></div>';

  document.getElementById('cFieldTotalPrice')?.addEventListener('input', () => checkPriceBalance(contract));

  // Advance % — live calculation of advance amount
  const advancePctEl = document.getElementById('cFieldAdvancePct');
  const advanceAmountEl = document.getElementById('cAdvanceAmount');
  function updateAdvanceAmount() {
    const pct = parseFloat(advancePctEl?.value) || 0;
    const total = parseFloat(document.getElementById('cFieldTotalPrice')?.value) || 0;
    if (advanceAmountEl) {
      if (pct > 0 && total > 0) {
        advanceAmountEl.textContent = 'Сумма аванса: ' + fmtNum(total * pct / 100) + ' ₽';
        advanceAmountEl.classList.remove('hidden');
      } else {
        advanceAmountEl.classList.add('hidden');
      }
    }
  }
  advancePctEl?.addEventListener('input', updateAdvanceAmount);
  advancePctEl?.addEventListener('input', () => refreshAdvanceColumn(contract));
  document.getElementById('cFieldTotalPrice')?.addEventListener('input', updateAdvanceAmount);
  updateAdvanceAmount();

  // ── Ползунок «Согласование СО» ─────────────────────────────────
  const soToggleWrap = document.createElement('div');
  soToggleWrap.className = 'sm:col-span-2 mt-2';
  soToggleWrap.innerHTML =
    '<div class="flex items-center justify-between rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">' +
    '<div>' +
    '<p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-0.5">Согласование сигнального образца</p>' +
    '<p class="text-xs text-slate-500">Распространяется на все товары контракта</p>' +
    '</div>' +
    '<label class="flex items-center gap-3 cursor-pointer select-none">' +
    '<span id="soToggleLabelLeft" class="text-xs font-semibold ' + (!contract.soApprovalRequired ? 'text-emerald-400' : 'text-slate-500') + '">Не предусмотрено</span>' +
    '<div class="relative inline-flex items-center">' +
    '<input type="checkbox" id="soApprovalToggle" class="sr-only" ' + (contract.soApprovalRequired !== false ? 'checked' : '') + '>' +
    '<div id="soApprovalTrack" class="w-12 h-6 rounded-full transition-all duration-200 flex items-center px-0.5 ' + (contract.soApprovalRequired !== false ? 'bg-red-500/70' : 'bg-emerald-500/70') + '">' +
    '<div id="soApprovalDot" class="w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200 ' + (contract.soApprovalRequired !== false ? 'translate-x-6' : 'translate-x-0') + '"></div>' +
    '</div>' +
    '</div>' +
    '<span id="soToggleLabelRight" class="text-xs font-semibold ' + (contract.soApprovalRequired !== false ? 'text-red-400' : 'text-slate-500') + '">Предусмотрено</span>' +
    '</label>' +
    '</div>';

  const headerGrid = wrap.querySelector('.grid');
  if (headerGrid) headerGrid.insertAdjacentElement('afterend', soToggleWrap);
  else wrap.appendChild(soToggleWrap);

  // Wire toggle
  const soToggle = document.getElementById('soApprovalToggle');
  const soTrack  = document.getElementById('soApprovalTrack');
  const soDot    = document.getElementById('soApprovalDot');
  const soLblL   = document.getElementById('soToggleLabelLeft');
  const soLblR   = document.getElementById('soToggleLabelRight');

  function updateSOToggleVisual(checked) {
    if (soTrack) {
      soTrack.classList.toggle('bg-red-500/70',     checked);
      soTrack.classList.toggle('bg-emerald-500/70', !checked);
    }
    if (soDot) {
      soDot.classList.toggle('translate-x-6', checked);
      soDot.classList.toggle('translate-x-0', !checked);
    }
    if (soLblL) { soLblL.classList.toggle('text-emerald-400', !checked); soLblL.classList.toggle('text-slate-500', checked); }
    if (soLblR) { soLblR.classList.toggle('text-red-400', checked); soLblR.classList.toggle('text-slate-500', !checked); }
  }

  soToggle?.addEventListener('change', () => {
    contract.soApprovalRequired = soToggle.checked;
    updateSOToggleVisual(soToggle.checked);
    // Немедленно перерисовываем колонку СО в таблице товаров
    syncItemStatusesFromActs(contract);
    renderItemsTable(contract);
  });
  // При переключении обновляем state немедленно, чтобы buildSOBadge видел новое значение
  // (buildSOBadge читает из state.contracts, поэтому нужно синхронизировать объект)
  // Уже обновляется через contract.soApprovalRequired выше — buildSOBadge теперь
  // использует локальный объект напрямую (см. исправление buildSOBadge ниже).

  document.getElementById('cFieldNumber')?.addEventListener('input', () => {
    refreshAllProductCodes(contract);
  });

  updateContractLotStatus(contract);
  const lotInput = document.getElementById('cFieldLotNumber');
  enhancePredictiveInput(lotInput, {
    listId: 'contractLotNumberOptions',
    options: lotOptions,
    icon: '🏷️',
    minWidth: '220px',
  });
  lotInput?.addEventListener('input', () => updateContractLotStatus(contract));
  lotInput?.addEventListener('change', () => handleLotNumberChange(contract));
  lotInput?.addEventListener('blur', () => handleLotNumberChange(contract));
}

// ── Programs section ──────────────────────────────────────────────

function renderProgramsSection(contract) {
  const wrap = document.getElementById('contractProgramsWrap');
  if (!wrap) return;

  const refreshFinanceSummaryLive = () => renderProgramFinanceSummary(contract);

  function render() {
    const progNames = getProgramNames();
    const programs  = getPrograms(); // full objects with limit

    // Reserved in other contracts for a given program name (excluding current)
    function reservedOther(progName) {
      return state.contracts.reduce((sum, c) => {
        if (c.id === contract.id) return sum;
        const p = (c.programs || []).find(p => p.name === progName);
        return sum + (parseFloat(p?.price) || 0);
      }, 0);
    }

    // Build <option> list for a select
    function buildOptions(selectedName) {
      if (progNames.length === 0) {
        return '<option value="" disabled selected>— Нет программ (добавьте в «Финансы») —</option>';
      }
      let opts = '<option value="" disabled ' + (!selectedName ? 'selected' : '') + '>— Выберите программу —</option>';
      progNames.forEach(name => {
        const fp = programs.find(p => p.name === name);
        const limit = parseFloat(fp?.limit) || 0;
        const reserved = reservedOther(name);
        const remaining = limit - reserved;
        const programLabel = formatProgramLabel(fp || { name });
        const hint = limit > 0 ? ' (остаток: ' + fmtNum(remaining) + ' ₽)' : '';
        opts += '<option value="' + escHtml(name) + '" ' + (selectedName === name ? 'selected' : '') + '>' + escHtml(programLabel) + hint + '</option>';
      });
      return opts;
    }

    let rowsHtml = '';
    contract.programs.forEach((prog, idx) => {
      rowsHtml +=
        '<div class="flex gap-2 items-start" data-prog-idx="' + idx + '">' +
        '<div class="flex-1 min-w-0">' +
        '<select class="prog-name w-full rounded-xl border border-white/10 bg-slate-800 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50" required data-idx="' + idx + '">' +
        buildOptions(prog.name) +
        '</select>' +
        '<p class="prog-budget-warn mt-1 text-xs text-red-400 hidden"></p>' +
        '</div>' +
        '<input type="number" min="0" step="0.01" class="prog-price w-36 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50"' +
        ' placeholder="0.00" value="' + (prog.price || '') + '">' +
        '<span class="text-xs text-slate-400 shrink-0 mt-2.5">₽</span>' +
        '<button class="del-prog-btn rounded-lg p-1.5 text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition mt-1" data-idx="' + idx + '" aria-label="' + t('actions.delete') + '">' +
        '<svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h14M8 6V4h4v2M5 6l1 12h8l1-12"/></svg>' +
        '</button>' +
        '</div>';
    });

    const noProgHint = progNames.length === 0
      ? '<p class="mt-2 text-xs text-amber-400/80">⚠ Сначала добавьте целевые программы в разделе «Финансы»</p>'
      : '';

    wrap.innerHTML =
      '<div class="space-y-2" id="programsList">' + rowsHtml + '</div>' +
      noProgHint +
      '<div class="flex items-center justify-between mt-3">' +
      '<button id="addProgBtn" type="button"' +
      ' class="inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-400/10 hover:border-cyan-400/30">' +
      '<span aria-hidden="true">＋</span> ' + t('contracts.addProgram') +
      '</button>' +
      '<span id="programsSum" class="text-xs text-slate-400 tabular-nums"></span>' +
      '</div>';

    updateProgramsSum(contract);
    refreshFinanceSummaryLive();

    wrap.querySelectorAll('.prog-name').forEach((sel, idx) => {
      sel.addEventListener('change', () => {
        contract.programs[idx].name = sel.value;
        checkBudgetForRow(contract, idx);
        checkPriceBalance(contract);
        refreshFinanceSummaryLive();
      });
    });
    wrap.querySelectorAll('.prog-price').forEach((inp, idx) => {
      inp.addEventListener('input', () => {
        contract.programs[idx].price = parseFloat(inp.value) || 0;
        updateProgramsSum(contract);
        checkPriceBalance(contract);
        checkBudgetForRow(contract, idx);
        refreshFinanceSummaryLive();
      });
    });
    wrap.querySelectorAll('.del-prog-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        contract.programs.splice(Number(btn.dataset.idx), 1);
        render();
        checkPriceBalance(contract);
        refreshFinanceSummaryLive();
      });
    });
    document.getElementById('addProgBtn')?.addEventListener('click', () => {
      contract.programs.push({ name: '', price: 0 });
      render();
      refreshFinanceSummaryLive();
    });

    // Run budget check on open for already-filled rows
    contract.programs.forEach((_, idx) => checkBudgetForRow(contract, idx));
  }

  render();
}

/**
 * Check if the price entered for a program row exceeds remaining budget.
 * Shows a warning inline under the select.
 */
function checkBudgetForRow(contract, idx) {
  const prog = contract.programs[idx];
  if (!prog || !prog.name) return;

  const programs = getPrograms();
  const finProg  = programs.find(p => p.name === prog.name);
  const limit    = parseFloat(finProg?.limit) || 0;

  const rowEl  = document.querySelector('#programsList [data-prog-idx="' + idx + '"]');
  const warnEl = rowEl?.querySelector('.prog-budget-warn');
  if (!warnEl) return;

  if (limit <= 0) { warnEl.classList.add('hidden'); return; }

  const reservedOther = state.contracts.reduce((sum, c) => {
    if (c.id === contract.id) return sum;
    const p = (c.programs || []).find(p => p.name === prog.name);
    return sum + (parseFloat(p?.price) || 0);
  }, 0);

  const remaining = limit - reservedOther;
  const entered   = parseFloat(prog.price) || 0;

  if (entered > remaining + 0.01) {
    const over = entered - remaining;
    warnEl.textContent = '⚠ Превышение остатка по программе «' + prog.name + '»: доступно ' + fmtNum(remaining) + ' ₽, введено ' + fmtNum(entered) + ' ₽ (превышение: ' + fmtNum(over) + ' ₽)';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }
}

function updateProgramsSum(contract) {
  const sum = contract.programs.reduce((acc, p) => acc + (parseFloat(p.price) || 0), 0);
  const el = document.getElementById('programsSum');
  if (el) el.textContent = t('contracts.programsSum') + ': ' + fmtNum(sum) + ' ₽';
}

function checkPriceBalance(contract) {
  const totalEl = document.getElementById('cFieldTotalPrice');
  const warnEl = document.getElementById('cPriceWarning');
  if (!totalEl || !warnEl) return;
  const total = parseFloat(totalEl.value) || 0;
  const sum = contract.programs.reduce((acc, p) => acc + (parseFloat(p.price) || 0), 0);
  if (contract.programs.length === 0 || total === 0) { warnEl.classList.add('hidden'); return; }
  const diff = Math.abs(total - sum);
  if (diff > 0.01) {
    const sign = sum > total ? '+' : '';
    warnEl.textContent = '⚠ ' + t('contracts.priceMismatch') + ': сумма программ ' + fmtNum(sum) + ' ₽ (' + sign + fmtNum(sum - total) + ' ₽)';
    warnEl.classList.remove('hidden');
  } else {
    warnEl.classList.add('hidden');
  }
}

// ── Items table (manual rows with autocomplete) ───────────────────

// ── Sync item statuses from acts ──────────────────────────────────

function syncItemStatusesFromActs(contract) {
  const deliveryActs = (state.acts || []).filter(
    a => a.contractId === contract.id && a.mode === 'delivery'
  );

  // Если СО не предусмотрен контрактом — автоматически ставим «not-required» всем товарам
  if (contract.soApprovalRequired === false) {
    (contract.items || []).forEach(item => {
      if (!item.receiving) item.receiving = {};
      item.receiving.soResult = 'not-required';
    });
    // Статус отгрузки всё равно берём из актов поставки
    (contract.items || []).forEach(item => {
      if (!item.receiving) item.receiving = {};
      const itemCode = (item.code || '').trim();
      const itemNameNorm = (item.name || '').trim().toLowerCase();
      function matchSI(si) {
        if (si.selected === false) return false;
        if (itemCode) return (si.itemCode || '').trim() === itemCode;
        return (si.name || '').trim().toLowerCase() === itemNameNorm;
      }
      item.receiving.shippingAllowed = deliveryActs.length > 0 &&
        deliveryActs.some(act =>
          (act.selectedItems || []).some(si => matchSI(si) && si.shippingAllowed === true)
        );
      item.receiving.soResult = 'not-required'; // гарантированно
    });
    return;
  }

  const soActs = (state.acts || []).filter(
    a => a.contractId === contract.id && (!a.mode || a.mode === 'so')
  );

  (contract.items || []).forEach(item => {
    if (!item.receiving) item.receiving = {};

    const itemCode = (item.code || '').trim();
    const itemNameNorm = (item.name || '').trim().toLowerCase();

    function matchSI(si) {
      if (si.selected === false) return false;
      if (itemCode) return (si.itemCode || '').trim() === itemCode;
      return (si.name || '').trim().toLowerCase() === itemNameNorm;
    }

    item.receiving.shippingAllowed = deliveryActs.length > 0 &&
      deliveryActs.some(act =>
        (act.selectedItems || []).some(si => matchSI(si) && si.shippingAllowed === true)
      );

    const soConfirmed = soActs.length > 0 &&
      soActs.some(act =>
        (act.selectedItems || []).some(si =>
          matchSI(si) && (si.soConforms === true || si.siSoNotRequired === true)
        )
      );
    const soNotRequired = soActs.length > 0 &&
      soActs.some(act =>
        (act.selectedItems || []).some(si => matchSI(si) && si.siSoNotRequired === true)
      );
    item.receiving.soResult = soNotRequired ? 'not-required' : (soConfirmed ? 'passed' : '');
  });
}

// ── Receiving-derived status badges ──────────────────────────────

function isShippingAllowed(item, contractId) {
  const itemCode = (item.code || '').trim();
  const itemNameNorm = (item.name || '').trim().toLowerCase();
  const deliveryActs = (state.acts || []).filter(a =>
    a.contractId === contractId && a.mode === 'delivery'
  );
  if (deliveryActs.length === 0) return false;
  return deliveryActs.some(act =>
    (act.selectedItems || []).some(si =>
      si.selected !== false &&
      si.shippingAllowed === true &&
      (itemCode
        ? (si.itemCode || '').trim() === itemCode
        : (si.name || '').trim().toLowerCase() === itemNameNorm)
    )
  );
}

function buildShippingBadge(item, contractId) {
  const allowed = isShippingAllowed(item, contractId);
  return allowed
    ? '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400 whitespace-nowrap">' + t('contracts.shippingAllowed') + '</span>'
    : '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400 whitespace-nowrap">' + t('contracts.shippingForbidden') + '</span>';
}

function getContractItemDeliveryBreakdown(contractId, item) {
  const codeLow = String(item?.code || '').trim().toLowerCase();
  const nameLow = String(item?.name || '').trim().toLowerCase();
  let warehouseQty = 0;
  let directQty = 0;

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      let rowOrderId = row?.orderId != null ? Number(row.orderId) || null : null;
      if (rowOrderId == null && row?.orderKey) {
        const parts = String(row.orderKey).split('::');
        if (parts.length === 2 && parts[1] !== 'noorder') {
          rowOrderId = Number(parts[1]) || null;
        }
      }
      const rowOrder = rowOrderId != null ? (state.orders || []).find(o => o.id === rowOrderId) : null;
      const rowContractId = row.contractId ?? rowOrder?.contractId ?? null;
      if (String(rowContractId) !== String(contractId)) continue;

      const rowCode = String(row.productCode || '').trim().toLowerCase();
      const rowName = String(row.productName || '').trim().toLowerCase();
      const matchCode = codeLow && rowCode && rowCode === codeLow;
      const matchName = nameLow && rowName && rowName === nameLow;
      if (!matchCode && !matchName) continue;

      warehouseQty += (row.recipients || []).reduce((sum, rec) => sum + (Number(rec.qty) || 0), 0);
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    if (String(delivery.contractId) !== String(contractId)) continue;
    for (const row of (delivery.rows || [])) {
      const rowCode = String(row.productCode || '').trim().toLowerCase();
      const rowName = String(row.productName || '').trim().toLowerCase();
      const matchCode = codeLow && rowCode && rowCode === codeLow;
      const matchName = nameLow && rowName && rowName === nameLow;
      if (!matchCode && !matchName) continue;
      directQty += Number(row.actualQty) || 0;
    }
  }

  return {
    warehouseQty,
    directQty,
    total: warehouseQty + directQty,
  };
}

function buildDeliveredSourceSummaryHtml({ warehouseQty, directQty }) {
  const chips = [];
  if (warehouseQty > 0) {
    chips.push('<span class="inline-flex items-center rounded-lg bg-cyan-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-cyan-300 whitespace-nowrap">' +
      escHtml(t('delivery.badgeWarehouse')) + ': ' + warehouseQty + '</span>');
  }
  if (directQty > 0) {
    chips.push('<span class="inline-flex items-center rounded-lg bg-fuchsia-400/15 px-1.5 py-0.5 text-[9px] font-semibold text-fuchsia-300 whitespace-nowrap">' +
      escHtml(t('delivery.badgeDirect')) + ': ' + directQty + '</span>');
  }
  if (!chips.length) return '<span class="text-[9px] text-slate-600">—</span>';
  return '<div class="mt-1 flex flex-col items-center gap-1">' + chips.join('') + '</div>';
}

function isSOApproved(item, contractId) {
  const itemCode = (item.code || '').trim();
  const itemNameNorm = (item.name || '').trim().toLowerCase();
  const soActs = (state.acts || []).filter(a =>
    a.contractId === contractId && (!a.mode || a.mode === 'so')
  );
  if (soActs.length === 0) return false;
  return soActs.some(act =>
    (act.selectedItems || []).some(si =>
      si.selected !== false &&
      (si.soConforms === true || si.siSoNotRequired === true) &&
      (itemCode
        ? (si.itemCode || '').trim() === itemCode
        : (si.name || '').trim().toLowerCase() === itemNameNorm)
    )
  );
}

function buildSOBadge(item, contractId) {
  // Используем _currentContract (локальный объект в памяти) — он всегда актуален
  // даже до сохранения в state. Fallback — поиск в state.contracts.
  const contract = (_currentContract && _currentContract.id === contractId)
    ? _currentContract
    : (contractId ? state.contracts.find(c => c.id === contractId) : null);
  if (contract && contract.soApprovalRequired === false) {
    return '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 whitespace-nowrap">СО не предусмотрен</span>';
  }

  const itemCode = (item.code || '').trim();
  const itemNameNorm = (item.name || '').trim().toLowerCase();
  const soActs = (state.acts || []).filter(a =>
    a.contractId === contractId && (!a.mode || a.mode === 'so')
  );
  const soNotRequired = soActs.length > 0 && soActs.some(act =>
    (act.selectedItems || []).some(si =>
      si.selected !== false &&
      si.siSoNotRequired === true &&
      (itemCode
        ? (si.itemCode || '').trim() === itemCode
        : (si.name || '').trim().toLowerCase() === itemNameNorm)
    )
  );
  if (soNotRequired) {
    return '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400 whitespace-nowrap">СО не предусмотрен</span>';
  }
  const passed = isSOApproved(item, contractId);
  return passed
    ? '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400 whitespace-nowrap">' + t('contracts.soApproved') + '</span>'
    : '<span class="inline-block rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400 whitespace-nowrap">' + t('contracts.soNotApproved') + '</span>';
}

function contractActSpecConforms(spec) {
  if (!spec) return false;
  if (typeof spec.nonConform === 'boolean') return spec.nonConform === true;

  const normalizeText = (value) => String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
  const parseNum = (value) => {
    const normalized = String(value || '')
      .replace(/\u00A0/g, '')
      .replace(/\s+/g, '')
      .replace(/,/g, '.');
    if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  };

  const actual = normalizeText(spec.checkResult);
  if (!actual) return false;

  const expectedNum = parseNum(spec.value);
  const actualNum = parseNum(spec.checkResult);
  if (expectedNum != null && actualNum != null) {
    return Math.abs(expectedNum - actualNum) <= 0.001;
  }

  return normalizeText(spec.value) === actual;
}

function contractActItemConforms(si, isDelivery = false) {
  if (!si) return false;
  const specsOk = !Array.isArray(si.specs) || si.specs.length === 0 || si.specs.every(contractActSpecConforms);
  const normDocOk = !si?.normDocEnabled || si.normDocConforms !== false;

  if (isDelivery) {
    if (si.notDelivered) return false;
    return Number(si.qty || 0) > 0 && specsOk && normDocOk;
  }

  if (si.siSoNotRequired) return true;
  return specsOk && normDocOk && si.soConforms === true;
}

function getContractActAggregateStatus(selectedItems, isDelivery = false) {
  const items = Array.isArray(selectedItems) ? selectedItems.filter(si => si?.selected !== false) : [];
  if (!items.length) {
    return { key: 'incomplete', text: 'Результат не зафиксирован', badgeClass: 'bg-slate-500/15 text-slate-300' };
  }

  if (isDelivery) {
    const hasNegative = items.some(si => {
      if (si?.notDelivered) return true;
      const hasAnyRecordedResult = (Number(si?.qty || 0) > 0)
        || !!String(si?.qty ?? '').trim()
        || (Array.isArray(si?.specs) && si.specs.some(spec => String(spec?.checkResult || '').trim()))
        || !!si?.normDocEnabled;
      return hasAnyRecordedResult && !contractActItemConforms(si, true);
    });
    if (hasNegative) {
      return { key: 'negative', text: 'Есть замечания', badgeClass: 'bg-red-500/15 text-red-300' };
    }
    if (items.every(si => contractActItemConforms(si, true))) {
      return { key: 'positive', text: 'Проверка пройдена', badgeClass: 'bg-green-500/15 text-green-400' };
    }
    return { key: 'incomplete', text: 'Результат не зафиксирован', badgeClass: 'bg-slate-500/15 text-slate-300' };
  }

  const nonSkipped = items.filter(si => !si?.siSoNotRequired);
  if (!nonSkipped.length) {
    return { key: 'skipped', text: 'СО не предусмотрен', badgeClass: 'bg-emerald-500/15 text-emerald-400' };
  }
  if (nonSkipped.some(si => {
    const specsOk = !Array.isArray(si?.specs) || si.specs.length === 0 || si.specs.every(contractActSpecConforms);
    const normDocOk = !si?.normDocEnabled || si.normDocConforms !== false;
    return si?.soConforms === false || !specsOk || !normDocOk;
  })) {
    return { key: 'negative', text: 'Есть замечания', badgeClass: 'bg-red-500/15 text-red-300' };
  }
  if (nonSkipped.every(si => contractActItemConforms(si, false))) {
    return { key: 'positive', text: 'Проверка пройдена', badgeClass: 'bg-green-500/15 text-green-400' };
  }
  return { key: 'incomplete', text: 'Результат не зафиксирован', badgeClass: 'bg-slate-500/15 text-slate-300' };
}

function normalizeProgramIdentityValue(value) {
  const direct = getProgramByIdentity(value);
  if (direct?.name) return String(direct.name || '').trim();
  return String(value || '').trim();
}

function getContractProgramDescriptors(contract) {
  const seen = new Set();
  const result = [];

  (contract?.programs || []).forEach((programRow) => {
    const rawName = typeof programRow === 'string' ? programRow : programRow?.name;
    const normalizedName = normalizeProgramIdentityValue(rawName);
    if (!normalizedName) return;

    const key = normalizedName.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    const program = getProgramByIdentity(rawName)
      || getProgramByIdentity(normalizedName)
      || (state.programs || []).find((entry) => String(entry?.name || '').trim().toLowerCase() === key)
      || null;

    result.push({
      key,
      name: normalizedName,
      label: formatProgramLabel(program || { name: normalizedName }),
    });
  });

  return result;
}

function getRecipientProgramKey(recipient) {
  const name = normalizeProgramIdentityValue(recipient?.targetProgram);
  return name ? name.toLowerCase() : '';
}

function getContractItemMetricsMatchMeta(item) {
  const resolvedProduct = resolveCatalogProductForContractItem(item);
  return {
    itemId: String(item?.itemId || '').trim(),
    productId: Number(item?.productRef) || Number(resolvedProduct?.id) || null,
    code: String(item?.code || '').trim().toLowerCase(),
    name: String(item?.name || '').trim().toLowerCase(),
  };
}

function matchesContractItemMetricsRow(matchMeta, row = {}) {
  const rowItemId = String(row?.contractItemId || row?.itemId || '').trim();
  if (matchMeta.itemId && rowItemId && rowItemId === matchMeta.itemId) return true;

  const rowProductId = Number(row?.productId || row?.productRef) || null;
  if (matchMeta.productId && rowProductId && rowProductId === matchMeta.productId) return true;

  const rowCode = String(row?.contractItemCode || row?.productCode || row?.code || row?.baseCode || '').trim().toLowerCase();
  if (matchMeta.code && rowCode) {
    if (rowCode === matchMeta.code || rowCode.startsWith(matchMeta.code + '-')) return true;
  }

  const rowName = String(row?.contractItemName || row?.productName || row?.name || '').trim().toLowerCase();
  return Boolean(matchMeta.name && rowName && rowName === matchMeta.name);
}

function parseOrderIdFromMetricsRow(row) {
  if (row?.orderId != null && row.orderId !== '') return Number(row.orderId) || null;
  if (!row?.orderKey) return null;
  const parts = String(row.orderKey).split('::');
  if (parts.length !== 2 || parts[1] === 'noorder') return null;
  const parsed = Number(parts[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function getOrderProgramKey(order) {
  const name = normalizeProgramIdentityValue(order?.programCode || order?.programName || '');
  return name ? name.toLowerCase() : '';
}

function getOrderManualAdvanceOffsets(order) {
  return order?.manualAdvanceOffsets
    || order?.advanceManualOffsets
    || order?.advanceOffsets
    || {};
}

function getOrderMetricsRows(order) {
  const rows = [];

  if (Array.isArray(order?.deliveryRows) && order.deliveryRows.length) {
    order.deliveryRows.forEach((row) => {
      const qty = Number(row?.qty) || (Array.isArray(row?.recipients)
        ? row.recipients.reduce((sum, recipient) => sum + (Number(recipient?.qty) || 0), 0)
        : 0);
      if (qty <= 0) return;
      const price = Number(row?.price) || 0;
      rows.push({
        qty,
        price,
        amount: qty * price,
        contractItemId: String(row?.contractItemId || row?.itemId || '').trim(),
        productId: Number(row?.productId || row?.productRef) || null,
        code: String(row?.contractItemCode || row?.productCode || row?.baseCode || '').trim(),
        name: String(row?.contractItemName || row?.productName || row?.name || '').trim(),
        orderId: order?.id,
      });
    });
    return rows;
  }

  if (Array.isArray(order?.items) && order.items.length) {
    order.items.forEach((item) => {
      if (item?.isTotalColorRow) return;
      const qty = Array.isArray(item?.deliverySchedules) && item.deliverySchedules.length
        ? item.deliverySchedules.reduce((sum, schedule) => sum + (Number(schedule?.qty) || 0), 0)
        : (Number(item?.qty) || 0);
      if (qty <= 0) return;
      const price = Number(item?.price) || 0;
      rows.push({
        qty,
        price,
        amount: qty * price,
        contractItemId: String(item?.contractItemId || item?.itemId || '').trim(),
        productId: Number(item?.productId || item?.productRef) || null,
        code: String(item?.contractItemCode || item?.productCode || item?.code || item?.baseCode || '').trim(),
        name: String(item?.contractItemName || item?.productName || item?.name || '').trim(),
        orderId: order?.id,
      });
    });
  }

  return rows;
}

function getOrderTotalAmount(order, metricRows = null) {
  const rows = Array.isArray(metricRows) ? metricRows : getOrderMetricsRows(order);
  const rowsAmount = rows.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0);
  if (rowsAmount > 0) return rowsAmount;
  if (Number(order?.totalCost) > 0) return Number(order.totalCost);
  if (Number(order?.totalAmount) > 0) return Number(order.totalAmount);
  return 0;
}

function getProgramMetricsQtyFromNeeds(matchMeta, programKey) {
  if (!matchMeta.productId || !programKey) return 0;

  return (state.recipients || []).reduce((sum, recipient) => {
    if (getRecipientProgramKey(recipient) !== programKey) return sum;
    const entry = recipient?.needs?.[matchMeta.productId];
    return sum + (Number(entry?.qty) || 0);
  }, 0);
}

function buildContractProgramMetrics(contract, item) {
  const descriptors = getContractProgramDescriptors(contract);
  if (descriptors.length <= 1) return [];

  const metrics = descriptors.map((descriptor) => ({
    programKey: descriptor.key,
    programName: descriptor.name,
    programLabel: descriptor.label,
    qty: 0,
    cost: 0,
    ordered: 0,
    delivered: 0,
    assembled: 0,
    advance: 0,
    paid50: 0,
    paid30: 0,
  }));

  const byProgram = new Map(metrics.map((metric) => [metric.programKey, metric]));
  const matchMeta = getContractItemMetricsMatchMeta(item);
  const price = Number(item?.price) || 0;

  metrics.forEach((metric) => {
    metric.qty = getProgramMetricsQtyFromNeeds(matchMeta, metric.programKey);
    metric.cost = metric.qty * price;
  });

  const contractOrders = (state.orders || []).filter((order) => String(order?.contractId) === String(contract?.id));
  contractOrders.forEach((order) => {
    const programKey = getOrderProgramKey(order);
    const bucket = byProgram.get(programKey);
    if (!bucket) return;

    const metricRows = getOrderMetricsRows(order);
    const matchedRows = metricRows.filter((row) => matchesContractItemMetricsRow(matchMeta, row));
    if (!matchedRows.length) return;

    const matchedQty = matchedRows.reduce((sum, row) => sum + (Number(row?.qty) || 0), 0);
    const matchedAmount = matchedRows.reduce((sum, row) => sum + (Number(row?.amount) || 0), 0);
    bucket.ordered += matchedQty;

    const orderTotalAmount = getOrderTotalAmount(order, metricRows);
    if (matchedAmount > 0 && orderTotalAmount > 0) {
      const plan = buildOrderPaymentPlan(
        contract,
        { ...order, totalAmount: orderTotalAmount },
        getOrderManualAdvanceOffsets(order),
      );
      const share = matchedAmount / orderTotalAmount;
      bucket.advance += (Number(plan?.advanceAmount) || 0) * share;
      bucket.paid50 += (Number(plan?.stage1Payable) || 0) * share;
      bucket.paid30 += (Number(plan?.stage2Payable) || 0) * share;
    }
  });

  (state.shipments || []).forEach((shipment) => {
    (shipment.rows || []).forEach((row) => {
      if (!matchesContractItemMetricsRow(matchMeta, row)) return;
      const rowOrderId = parseOrderIdFromMetricsRow(row);
      const rowOrder = rowOrderId != null ? (state.orders || []).find(order => String(order.id) === String(rowOrderId)) : null;
      (row.recipients || []).forEach((recipientRow) => {
        const qty = Number(recipientRow?.qty) || 0;
        if (qty <= 0) return;
        const recipient = recipientRow?.recipientId != null
          ? (state.recipients || []).find(entry => String(entry.id) === String(recipientRow.recipientId))
          : null;
        const programKey = getRecipientProgramKey(recipient) || getOrderProgramKey(rowOrder);
        const bucket = byProgram.get(programKey);
        if (!bucket) return;
        bucket.delivered += qty;
      });
    });
  });

  (state.directDeliveries || []).forEach((delivery) => {
    if (String(delivery?.contractId) !== String(contract?.id)) return;
    const order = delivery?.orderId != null
      ? (state.orders || []).find(entry => String(entry.id) === String(delivery.orderId))
      : null;
    (delivery.rows || []).forEach((row) => {
      if (!matchesContractItemMetricsRow(matchMeta, row)) return;
      const qty = Number(row?.actualQty) || 0;
      if (qty <= 0) return;
      const recipient = row?.recipientId != null
        ? (state.recipients || []).find(entry => String(entry.id) === String(row.recipientId))
        : null;
      const programKey = getRecipientProgramKey(recipient) || getOrderProgramKey(order);
      const bucket = byProgram.get(programKey);
      if (!bucket) return;
      bucket.delivered += qty;
    });
  });

  (state.assemblyActs || []).forEach((act) => {
    if (String(act?.contractId) !== String(contract?.id)) return;
    const recipient = act?.recipientId != null
      ? (state.recipients || []).find(entry => String(entry.id) === String(act.recipientId))
      : null;
    const programKey = getRecipientProgramKey(recipient);
    const bucket = byProgram.get(programKey);
    if (!bucket) return;
    (act.items || []).forEach((actItem) => {
      if (!matchesContractItemMetricsRow(matchMeta, actItem)) return;
      bucket.assembled += Number(actItem?.assembled) || 0;
    });
  });

  return metrics;
}

function formatProgramMetricQty(value) {
  const numeric = Number(value) || 0;
  if (Number.isInteger(numeric)) return String(numeric);
  return String(Math.round(numeric * 100) / 100).replace('.', ',');
}

function buildProgramMetricCell(value, type = 'qty') {
  if (type === 'money') {
    return '<span class="tabular-nums text-slate-300">' + fmtNum(value) + '</span>';
  }
  return '<span class="tabular-nums text-slate-300">' + formatProgramMetricQty(value) + '</span>';
}

function buildProgramNeedBadge(value) {
  const qtyText = formatProgramMetricQty(value);
  const badgeTemplate = tf('contracts.programNeedBadge', 'Потребность: {qty}');
  const badgeText = String(badgeTemplate || 'Потребность: {qty}').includes('{qty}')
    ? String(badgeTemplate || 'Потребность: {qty}').replace('{qty}', qtyText)
    : `${badgeTemplate} ${qtyText}`;

  return '<span class="inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-1 text-[10px] font-semibold text-violet-300">'
    + escHtml(badgeText)
    + '</span>';
}

function buildContractProgramSubrowsHtml(item, programMetrics = []) {
  if (!Array.isArray(programMetrics) || programMetrics.length <= 1) return '';

  return programMetrics.map((metric, idx) => {
    const isLast = idx === programMetrics.length - 1;
    const programLabel = metric.programLabel || metric.programName || tf('orders.noProgram', 'Без программы');
    const programLineTemplate = tf('contracts.programBreakdownLine', 'ЦП: {program}');
    const programLineText = String(programLineTemplate || 'ЦП: {program}').includes('{program}')
      ? String(programLineTemplate || 'ЦП: {program}').replace('{program}', programLabel)
      : `${programLineTemplate} ${programLabel}`;
    return '<tr class="bg-slate-950/25 ' + (isLast ? '' : 'border-b border-white/[0.04]') + '" data-program-subrow="true">' +
      '<td class="py-1.5 px-3 text-[10px] text-slate-600"></td>' +
      '<td colspan="6" class="py-1.5 pr-2">' +
        '<div class="pl-4">' +
          '<span class="inline-flex items-center gap-2 rounded-lg border border-cyan-400/15 bg-cyan-400/[0.06] px-2.5 py-1 text-[10px] font-semibold text-cyan-300">' +
            '<span aria-hidden="true">↳</span>' +
            escHtml(programLineText) +
          '</span>' +
          '<div class="mt-1.5">' + buildProgramNeedBadge(metric.qty) + '</div>' +
        '</div>' +
      '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs"><span class="text-slate-600">—</span></td>' +
      '<td class="py-1.5 pr-3 text-right text-xs">' + buildProgramMetricCell(metric.cost, 'money') + '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs">' + buildProgramMetricCell(metric.ordered, 'qty') + '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs">' + buildProgramMetricCell(metric.delivered, 'qty') + '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs">' + buildProgramMetricCell(metric.assembled, 'qty') + '</td>' +
      '<td class="py-1.5 pr-3 text-right text-xs">' + buildProgramMetricCell(metric.advance, 'money') + '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs">' + buildProgramMetricCell(metric.paid50, 'money') + '</td>' +
      '<td class="py-1.5 pr-2 text-center text-xs">' + buildProgramMetricCell(metric.paid30, 'money') + '</td>' +
      '<td class="py-1.5 pr-2"></td>' +
      '<td class="py-1.5 px-1"></td>' +
      '<td class="py-1.5"></td>' +
    '</tr>';
  }).join('');
}

// Автокод для новой строки контракта:
// 4 цифры номера товара из каталога + '/' + последние 4 цифры номера контракта.
// Ручной код не затираем: автогенерация применяется только если поле ещё пустое.
function buildProductCode(productRef, contractNumber) {
  const prod = productRef != null ? state.products.find(p => p.id === productRef) : null;
  if (!prod) return '';
  const prodNum = String(prod.number || '').padStart(4, '0');
  if (!prodNum.trim()) return '';
  const contractDigits = String(contractNumber ?? '').replace(/\D/g, '');
  const contractSuffix = contractDigits.length >= 4
    ? contractDigits.slice(-4)
    : contractDigits.padStart(4, '0');
  if (!contractSuffix.trim()) return '';
  return prodNum + '/' + contractSuffix;
}

function getContractItemAllCodes(item) {
  const product = resolveCatalogProductForContractItem(item);
  const baseCode = String(item?.code || '').trim();
  if (!product || !baseCode || !hasProductColorVariants(product)) return [];

  return getProductColorVariants(product)
    .map((variant) => ({
      variantId: String(variant?.id || '').trim(),
      colorCode: String(variant?.colorCode || '').trim(),
      fullCode: buildProductFullCode(baseCode, variant?.colorCode || ''),
    }))
    .filter(meta => meta.colorCode && meta.fullCode);
}

function buildContractItemCodesPreviewHtml(item) {
  const allCodes = getContractItemAllCodes(item);
  if (!allCodes.length) return '';

  return '<div class="mt-1 space-y-1">'
    + '<div class="text-[9px] font-semibold uppercase tracking-wide text-slate-500">'
    + escHtml(tf('contracts.allColorCodesLabel', 'Все коды по цветам'))
    + '</div>'
    + allCodes.map((meta) => (
      '<div class="rounded-lg border border-white/8 bg-white/[0.03] px-2 py-1 text-[10px] leading-tight">'
      + '<span class="text-slate-500">' + escHtml(meta.colorCode) + '</span>'
      + '<span class="mx-1 text-slate-600">→</span>'
      + '<span class="font-mono text-cyan-300 break-all">' + escHtml(meta.fullCode) + '</span>'
      + '</div>'
    )).join('')
    + '</div>';
}

function buildContractItemLotHintHtml(item) {
  const lotQty = Number(item?.lotQty) || 0;
  if (lotQty <= 0) return '';

  return '<div class="mt-1 inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-1 text-[10px] font-semibold text-violet-300 whitespace-nowrap">'
    + escHtml(tf('contracts.lotBadge', 'Лот: {lot}', { lot: lotQty }))
    + '</div>';
}

function updateContractItemCodesPreview(contract, rowIdx) {
  const host = document.querySelector('[data-contract-code-preview-row="' + rowIdx + '"]');
  if (!host) return;
  host.innerHTML = buildContractItemCodesPreviewHtml(contract.items[rowIdx]);
}

function refreshAllProductCodes(contract) {
  const numberVal = document.getElementById('cFieldNumber')?.value.trim() ?? contract.number ?? '';
  contract.items.forEach((item, idx) => {
    const currentCode = String(item?.code || '').trim();
    const generatedCode = buildProductCode(item?.productRef, numberVal);
    if (!currentCode && generatedCode) {
      item.code = generatedCode;
    }

    const input = document.querySelector('.item-code[data-row="' + idx + '"]');
    if (input && !String(input.value || '').trim() && generatedCode) {
      input.value = generatedCode;
    }

    if (contract.renameActRows?.[idx] && !String(contract.renameActRows[idx].productCode || '').trim() && generatedCode) {
      contract.renameActRows[idx].productCode = generatedCode;
    }

    updateContractItemCodesPreview(contract, idx);
  });
}

// Active autocomplete state
let _acRowIdx = null;
let _acListEl = null;

/**
 * Рассчитывает потребность и уже законтрактованное количество для строки.
 * Возвращает { need, contractedOther, available, exceeded }
 */
function calcNeedInfo(item, contractId) {
  // productRef = id каталога; если нет — пробуем найти по имени
  let productId = item.productRef ?? null;
  if (!productId && item.name) {
    const found = state.products.find(
      p => (p.name || '').trim().toLowerCase() === (item.name || '').trim().toLowerCase()
    );
    productId = found?.id ?? null;
  }

  const need = productId ? calcTotalNeedForProduct(productId) : 0;
  if (need === 0) return { need: 0, contractedOther: 0, available: 0, exceeded: false };

  const contractedOther = calcTotalContractedForProduct(productId, item.name, contractId);
  const available = Math.max(0, need - contractedOther);
  const currentQty = Number(item.qty) || 0;
  const exceeded = (contractedOther + currentQty) > need;
  return { need, contractedOther, available, exceeded, productId };
}

/**
 * Строит tooltip-текст с данными о потребности.
 */
function buildNeedTooltip(item, contractId) {
  const { need, contractedOther, available, exceeded } = calcNeedInfo(item, contractId);
  if (need === 0) return '';
  const lines = [
    'Суммарная потребность: ' + need + ' шт.',
    'В других контрактах: ' + contractedOther + ' шт.',
    'Доступно для этого контракта: ' + available + ' шт.',
  ];
  if (exceeded) lines.push('⚠ ПРЕВЫШЕНИЕ потребности!');
  return lines.join('\n');
}

function closeAllDropdowns() {
  if (_acListEl) { _acListEl.remove(); _acListEl = null; }
  _acRowIdx = null;
}

function renderItemsTable(contract) {
  const wrap = document.getElementById('contractItemsWrap');
  if (!wrap) return;

  function renderTable() {
    _currentContract = contract;
    const rows = contract.items.map((item, idx) => {
      const programMetrics = buildContractProgramMetrics(contract, item);
      return buildRowHtml(item, idx, programMetrics);
    }).join('');

    wrap.innerHTML =
      '<div class="overflow-x-auto rounded-xl border border-white/10" id="itemsTableScroll">' +
      '<table class="text-left border-collapse" style="table-layout:fixed;width:100%" id="itemsTable">' +
      '<thead><tr class="border-b border-white/10 bg-white/[0.03]">' +
      '<th class="py-2.5 px-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">#</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + t('contracts.colProduct') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + escHtml(tf('contracts.colSpecificationName', 'Наименование по спецификации')) + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + t('contracts.colCode') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">НМЦД, ₽</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + t('contracts.colPrice') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + escHtml(tf('contracts.colUnit', 'Ед. изм.')) + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden">' + t('contracts.colQty') + '</th>' +
      '<th class="py-2.5 pr-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-right">' + t('contracts.colCost') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colOrdered') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colDelivered') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">Собрано</th>' +
      '<th class="py-2.5 pr-3 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-right">Аванс, ₽</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colPaid50') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colPaid30') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colSO') + '</th>' +
      '<th class="py-2.5 pr-2 text-[10px] font-semibold uppercase tracking-wider text-slate-500 overflow-hidden text-center">' + t('contracts.colShipping') + '</th>' +
      '<th class="py-2.5 overflow-hidden"></th>' +
      '</tr></thead>' +
      '<tbody id="itemsTbody">' + rows + '</tbody>' +
      '<tfoot><tr class="border-t border-white/10 bg-white/[0.03]">' +
      '<td colspan="8" class="py-2.5 px-3 text-xs font-semibold text-slate-400 uppercase tracking-wider">' + t('contracts.totalCost') + '</td>' +
      '<td class="py-2.5 pr-3 text-sm font-bold text-cyan-400 tabular-nums text-right" id="itemsTotalCost"></td>' +
      '<td colspan="3"></td>' +
      '<td class="py-2.5 pr-3 text-xs font-semibold text-slate-400 uppercase tracking-wider text-right">Аванс итого</td>' +
      '<td class="py-2.5 pr-3 text-sm font-bold text-amber-400 tabular-nums text-right" id="itemsAdvanceTotalCost"></td>' +
      '<td colspan="4"></td>' +
      '</tr></tfoot>' +
      '</table></div>' +
      '<button id="addItemRowBtn" type="button"' +
      ' class="mt-3 inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-400/10 hover:border-cyan-400/30 active:scale-[0.97]">' +
      '<span aria-hidden="true">＋</span> ' + t('contracts.addItem') +
      '</button>';

    bindTableEvents(contract, renderTable);
    updateItemsTotal(contract);
    const tbl = document.getElementById('itemsTable');
    if (tbl) {
      setupResizableTable(tbl);
      requestAnimationFrame(() => attachFrozenManager(tbl, 'contracts-items'));
    }
  }

  renderTable();
}

// ── Column resize ─────────────────────────────────────────────────

const COL_DEFAULTS = [32, 180, 220, 110, 90, 100, 90, 72, 100, 72, 72, 72, 100, 72, 72, 90, 90, 36];
const COL_MIN      = [24,  80, 140,  70, 60,  70, 70, 48,  70, 48, 48, 48,  70, 48, 48, 70, 70, 28];
let _colWidths = [...COL_DEFAULTS];

function applyColWidths(table) {
  const cols = table.querySelectorAll('colgroup col');
  cols.forEach((col, i) => {
    col.style.width = (_colWidths[i] ?? 60) + 'px';
  });
}

function injectColgroup(table) {
  let cg = table.querySelector('colgroup');
  if (!cg) {
    cg = document.createElement('colgroup');
    for (let i = 0; i < COL_DEFAULTS.length; i++) {
      cg.appendChild(document.createElement('col'));
    }
    table.prepend(cg);
  }
  applyColWidths(table);
}

function addResizeHandles(table) {
  const ths = table.querySelectorAll('thead th');
  ths.forEach((th, colIdx) => {
    if (colIdx >= COL_DEFAULTS.length - 1) return;

    th.style.position = 'relative';
    th.style.userSelect = 'none';
    th.style.overflow = 'visible';

    const handle = document.createElement('span');
    handle.setAttribute('aria-hidden', 'true');
    handle.style.cssText = [
      'position:absolute', 'right:-3px', 'top:0', 'bottom:0',
      'width:7px', 'cursor:col-resize', 'z-index:10',
      'display:flex', 'align-items:center', 'justify-content:center',
    ].join(';');
    const bar = document.createElement('span');
    bar.style.cssText = 'width:2px;height:60%;background:rgba(100,116,139,0.3);border-radius:1px;pointer-events:none;transition:background 0.15s';
    handle.appendChild(bar);

    handle.addEventListener('mouseenter', () => { bar.style.background = 'rgba(34,211,238,0.65)'; });
    handle.addEventListener('mouseleave', () => { bar.style.background = 'rgba(100,116,139,0.3)'; });

    handle.addEventListener('mousedown', e => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = _colWidths[colIdx];
      bar.style.background = 'rgba(34,211,238,0.9)';

      const onMove = mv => {
        const delta = mv.clientX - startX;
        _colWidths[colIdx] = Math.max(COL_MIN[colIdx] ?? 40, startW + delta);
        applyColWidths(table);
      };
      const onUp = () => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        bar.style.background = 'rgba(100,116,139,0.3)';
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });

    th.appendChild(handle);
  });
}

function setupResizableTable(table) {
  injectColgroup(table);
  addResizeHandles(table);
}

/**
 * Строит ячейку количества с tooltip потребности, индикатором превышения и live-валидацией.
 */
function buildQtyCell(item, idx, contractId) {
  const { need, contractedOther, available, exceeded } = calcNeedInfo(item, contractId);
  const tooltip = buildNeedTooltip(item, contractId);

  // Цвет рамки input
  const borderColor = exceeded ? 'border-red-500/70' : 'border-white/10';

  // Подсказка под полем
  let hintHtml = '';
  if (need > 0) {
    if (exceeded) {
      const over = (contractedOther + (Number(item.qty) || 0)) - need;
      hintHtml = '<div class="qty-need-warn absolute bottom-0 left-0 right-0 text-[9px] text-red-400 whitespace-nowrap leading-tight" data-row="' + idx + '">⚠ Превышение на ' + over + ' шт.</div>';
    } else {
      hintHtml = '<div class="qty-need-info absolute bottom-0 left-0 right-0 text-[9px] text-slate-500 whitespace-nowrap leading-tight" data-row="' + idx + '">Потр.: ' + need + ' · Доступно: ' + available + '</div>';
    }
  }

  return '<td class="py-1.5 pr-2"><div class="relative pb-4" title="' + escHtml(tooltip) + '">' +
    '<input type="number" min="0" step="1" class="item-qty w-full rounded-lg border ' + borderColor + ' bg-white/5 px-2 py-2 text-sm text-white tabular-nums transition focus:border-cyan-400/50" value="' + (item.qty || '') + '" placeholder="0" data-row="' + idx + '" data-need="' + need + '" data-contracted-other="' + contractedOther + '">' +
    hintHtml +
    '</div></td>';
}

function buildRowHtml(item, idx, programMetrics = []) {
  const cost = (parseFloat(item.price) || 0) * (parseFloat(item.qty) || 0);
  const numVal = (field) => (typeof item[field] === 'boolean' ? (item[field] ? 1 : 0) : (parseFloat(item[field]) || 0));
  const productCode = String(item.code || '').trim();
  const advancePct = getAdvancePct();
  const advanceAmt = (parseFloat(item.price) || 0) * (parseFloat(item.ordered) || 0) * advancePct / 100;
  const contractId = _currentContract ? _currentContract.id : null;
  const hasProgramBreakdown = Array.isArray(programMetrics) && programMetrics.length > 1;
  const programBreakdownBadge = hasProgramBreakdown
    ? '<div class="mt-1"><span class="inline-flex items-center rounded-lg bg-cyan-400/[0.08] px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-cyan-300">' + escHtml(tf('contracts.programBreakdownBadge', 'Разбивка по ЦП')) + '</span></div>'
    : '';

  const deliveredBreakdown = contractId ? getContractItemDeliveryBreakdown(contractId, item) : { warehouseQty: 0, directQty: 0, total: 0 };
  const delivered = deliveredBreakdown.total;
  const qty = parseFloat(item.qty) || 0;
  const deliveredColor = delivered >= qty && qty > 0
    ? 'text-green-400' : delivered > 0 ? 'text-amber-400' : 'text-slate-500';

  const prod = item.productRef ? state.products.find(p => p.id === item.productRef) : null;
  const needsAssembly = prod ? prod.assembly === 'required' : false;
  let assembledHtml = '<span class="text-slate-600">—</span>';
  if (needsAssembly) {
    const assembled = contractId
      ? calcContractAssembled(contractId, item.name, productCode, item.productRef)
      : 0;
    const asmColor = assembled >= qty && qty > 0
      ? 'text-green-400' : assembled > 0 ? 'text-amber-400' : 'text-slate-500';
    assembledHtml = '<span class="' + asmColor + ' tabular-nums font-semibold">' + (assembled > 0 ? assembled : '—') + '</span>';
  }

  const codeHtml = productCode
    ? escHtml(productCode)
    : '<span class="text-slate-600">—</span>';

  return '<tr class="border-b border-white/5 hover:bg-white/[0.02]" data-row="' + idx + '">' +
    '<td class="py-2 px-3 text-xs text-slate-500 tabular-nums">' + (idx + 1) + '</td>' +
    '<td class="py-1.5 pr-2 relative name-cell"><div class="relative">' +
    '<input type="text" class="item-name w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"' +
    ' value="' + escHtml(item.name || '') + '" placeholder="' + t('contracts.itemNamePlaceholder') + '"' +
    ' data-row="' + idx + '" autocomplete="off" spellcheck="false">' +
    programBreakdownBadge +
    '</div></td>' +
    '<td class="py-1.5 pr-2"><input type="text" class="item-specification-name w-full min-w-[220px] rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]" value="' + escHtml(item.specificationName || '') + '" placeholder="' + escHtml(tf('contracts.specificationNamePlaceholder', 'Наименование по спецификации')) + '" data-row="' + idx + '"></td>' +
    '<td class="py-1.5 pr-2"><div><input type="text" class="item-code w-full min-w-[150px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white font-mono tabular-nums transition focus:border-cyan-400/50" value="' + escHtml(productCode) + '" placeholder="Код товара" data-row="' + idx + '" aria-label="' + t('contracts.colCode') + '"><div data-contract-code-preview-row="' + idx + '">' + buildContractItemCodesPreviewHtml(item) + '</div>' + buildContractItemLotHintHtml(item) + '</div></td>' +
    '<td class="py-1.5 pr-2"><input type="number" min="0" step="0.01" class="item-nmcd w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-slate-300 tabular-nums transition focus:border-cyan-400/50" value="' + (item.nmcd || '') + '" placeholder="0.00" data-row="' + idx + '" aria-label="НМЦД"></td>' +
    '<td class="py-1.5 pr-2"><div class="relative pb-4"><input type="number" min="0" step="0.01" class="item-price w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white tabular-nums transition focus:border-cyan-400/50" value="' + (item.price || '') + '" placeholder="0.00" data-row="' + idx + '"><div class="nmcd-warn' + ((parseFloat(item.nmcd) > 0 && parseFloat(item.price) > parseFloat(item.nmcd) ? '' : ' hidden')) + ' absolute bottom-0 left-0 right-0 text-[9px] text-red-400 whitespace-nowrap leading-tight" data-row="' + idx + '">⚠ Превышает НМЦД</div></div></td>' +
    '<td class="py-1.5 pr-2"><input type="text" class="item-unit w-full min-w-[90px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white transition focus:border-cyan-400/50" value="' + escHtml(item.unit || '') + '" placeholder="' + escHtml(tf('contracts.colUnit', 'Ед. изм.')) + '" data-row="' + idx + '" aria-label="' + escHtml(tf('contracts.colUnit', 'Ед. изм.')) + '"></td>' +
    buildQtyCell(item, idx, contractId) +
    '<td class="py-2 pr-3 text-sm text-slate-300 tabular-nums text-right cost-cell" data-row="' + idx + '">' + fmtNum(cost) + '</td>' +
    '<td class="py-2 pr-2 text-center"><span class="inline-flex min-w-[56px] items-center justify-center rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-sm font-semibold text-slate-300 tabular-nums ordered-cell" data-row="' + idx + '">' + formatProgramMetricQty(numVal('ordered')) + '</span></td>' +
    '<td class="py-2 pr-2 text-center"><div class="flex flex-col items-center"><span class="' + deliveredColor + ' tabular-nums font-semibold text-sm">' + (delivered > 0 ? delivered : '—') + '</span>' + buildDeliveredSourceSummaryHtml(deliveredBreakdown) + '</div></td>' +
    '<td class="py-2 pr-2 text-center">' + assembledHtml + '</td>' +
    '<td class="py-2 pr-3 text-sm text-amber-400 tabular-nums text-right advance-cell" data-row="' + idx + '">' + fmtNum(advanceAmt) + '</td>' +
    '<td class="py-1.5 pr-2"><input type="number" min="0" step="0.01" class="item-num w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white tabular-nums text-center transition focus:border-cyan-400/50" data-row="' + idx + '" data-field="paid50" value="' + numVal('paid50') + '" placeholder="0" aria-label="' + t('contracts.colPaid50') + '"></td>' +
    '<td class="py-1.5 pr-2"><input type="number" min="0" step="0.01" class="item-num w-full rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-sm text-white tabular-nums text-center transition focus:border-cyan-400/50" data-row="' + idx + '" data-field="paid30" value="' + numVal('paid30') + '" placeholder="0" aria-label="' + t('contracts.colPaid30') + '"></td>' +
    '<td class="py-2 text-center">' + buildSOBadge(item, contractId) + '</td>' +
    '<td class="py-2 px-1 text-center">' + buildShippingBadge(item, contractId) + '</td>' +
    '<td class="py-2 text-center"><button class="del-item-btn rounded-lg p-1.5 text-slate-600 hover:text-red-400 hover:bg-red-400/10 transition" data-row="' + idx + '" aria-label="' + t('actions.delete') + '">' +
    '<svg width="13" height="13" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h14M8 6V4h4v2M5 6l1 12h8l1-12"/></svg>' +
    '</button></td>' +
    '</tr>' +
    buildContractProgramSubrowsHtml(item, programMetrics);
}

function bindTableEvents(contract, rerenderFn) {
  const wrap = document.getElementById('contractItemsWrap');
  if (!wrap) return;

  wrap.querySelector('#addItemRowBtn')?.addEventListener('click', () => {
    contract.items.push({ name: '', specificationName: '', unit: '', price: 0, qty: 0, ordered: 0, delivered: 0, paidAdvance: 0, paid50: 0, paid30: 0, itemId: makeLocalId('contract_item') });
    rerenderFn();
    requestAnimationFrame(() => {
      const inputs = wrap.querySelectorAll('.item-name');
      inputs[inputs.length - 1]?.focus();
    });
  });

  wrap.querySelectorAll('.del-item-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      closeAllDropdowns();
      contract.items.splice(Number(btn.dataset.row), 1);
      rerenderFn();
    });
  });

  wrap.querySelectorAll('.item-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      contract.items[idx].name = inp.value;
      showAutocomplete(inp, idx, contract, rerenderFn);
    });
    inp.addEventListener('focus', () => {
      const idx = Number(inp.dataset.row);
      showAutocomplete(inp, idx, contract, rerenderFn);
    });
    inp.addEventListener('keydown', e => {
      handleAutocompleteKeydown(e, inp, contract, rerenderFn);
    });
    inp.addEventListener('blur', () => {
      setTimeout(closeAllDropdowns, 150);
    });
  });

  wrap.querySelectorAll('.item-specification-name').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      if (contract.items[idx]) contract.items[idx].specificationName = inp.value;
      if (contract.renameActRows?.[idx]) contract.renameActRows[idx].specificationName = inp.value;
      const renameInput = document.querySelector(`#renameActRows [data-rename-row]:nth-child(${idx + 1}) [data-rename-field="specificationName"]`);
      if (renameInput && renameInput !== inp) renameInput.value = inp.value;
    });
  });

  wrap.querySelectorAll('.item-code').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      if (contract.items[idx]) contract.items[idx].code = inp.value.trim();
      if (contract.renameActRows?.[idx]) contract.renameActRows[idx].productCode = inp.value.trim();
      const renameInput = document.querySelector(`#renameActRows [data-rename-row]:nth-child(${idx + 1}) [data-rename-field="productCode"]`);
      if (renameInput && renameInput !== inp) renameInput.value = inp.value.trim();
      updateContractItemCodesPreview(contract, idx);
    });
  });

  wrap.querySelectorAll('.item-nmcd').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      contract.items[idx].nmcd = parseFloat(inp.value) || 0;
      checkNmcdForRow(contract, idx);
    });
  });

  wrap.querySelectorAll('.item-price').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      const value = parseFloat(inp.value) || 0;
      contract.items[idx].price = value;
      if (contract.renameActRows?.[idx]) contract.renameActRows[idx].price = value;
      const renameInput = document.querySelector(`#renameActRows [data-rename-row]:nth-child(${idx + 1}) [data-rename-field="price"]`);
      if (renameInput && renameInput !== inp) renameInput.value = value ? String(value) : '';
      refreshCostCell(contract, idx);
      refreshAdvanceCell(contract, idx);
      updateItemsTotal(contract);
      checkNmcdForRow(contract, idx);
    });
  });

  wrap.querySelectorAll('.item-unit').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      if (contract.items[idx]) contract.items[idx].unit = inp.value.trim();
    });
  });

  wrap.querySelectorAll('.item-qty').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      contract.items[idx].qty = parseFloat(inp.value) || 0;
      refreshCostCell(contract, idx);
      updateItemsTotal(contract);
      checkNeedForRow(contract, idx, inp);
    });
  });

  wrap.querySelectorAll('.item-num').forEach(inp => {
    inp.addEventListener('input', () => {
      const idx = Number(inp.dataset.row);
      const field = inp.dataset.field;
      contract.items[idx][field] = parseFloat(inp.value) || 0;
      if (field === 'ordered') refreshAdvanceCell(contract, idx);
    });
  });
}

// ── Autocomplete ──────────────────────────────────────────────────

function getProductSuggestions(query) {
  const q = query.trim().toLowerCase();
  if (!q) return state.products.slice(0, 20);
  return state.products.filter(p =>
    p.name?.toLowerCase().includes(q) ||
    String(p.number).includes(q) ||
    p.category?.toLowerCase().includes(q)
  ).slice(0, 20);
}

function showAutocomplete(inp, rowIdx, contract, rerenderFn) {
  closeAllDropdowns();
  const suggestions = getProductSuggestions(inp.value);
  if (suggestions.length === 0) return;

  _acRowIdx = rowIdx;

  const list = document.createElement('div');
  list.id = 'acDropdown';
  list.className = [
    'absolute z-[200] left-0 right-0',
    'mt-1 rounded-xl border border-white/15 bg-slate-800 shadow-2xl',
    'overflow-y-auto max-h-52',
  ].join(' ');
  list.setAttribute('role', 'listbox');

  list.innerHTML = suggestions.map((p, i) =>
    '<div class="ac-item flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-cyan-400/10 transition" role="option" data-idx="' + i + '" data-pid="' + p.id + '">' +
    '<span class="text-xs text-slate-500 tabular-nums w-6 shrink-0">' + p.number + '</span>' +
    '<div class="flex-1 min-w-0">' +
    '<p class="text-sm text-white truncate">' + highlightMatch(p.name, inp.value) + '</p>' +
    (p.category ? '<p class="text-[10px] text-slate-500">' + escHtml(p.category) + '</p>' : '') +
    '</div></div>'
  ).join('');

  const parent = inp.parentElement;
  parent.style.position = 'relative';
  parent.appendChild(list);
  _acListEl = list;

  list.querySelectorAll('.ac-item').forEach((el, i) => {
    el.addEventListener('mousedown', e => {
      e.preventDefault();
      const prod = suggestions[i];
      applyAutocomplete(inp, rowIdx, prod, contract, rerenderFn);
    });
  });
}

function applyAutocomplete(inp, rowIdx, prod, contract, rerenderFn) {
  closeAllDropdowns();
  contract.items[rowIdx].name = prod.name;
  inp.value = prod.name;
  contract.items[rowIdx].productRef = prod.id;
  if (!String(contract.items[rowIdx].unit || '').trim()) {
    contract.items[rowIdx].unit = String(prod.unit || prod.specs?.[0]?.unit || '').trim();
  }
  if (!String(contract.items[rowIdx].specificationName || '').trim()) {
    contract.items[rowIdx].specificationName = prod.name;
  }
  if (!String(contract.items[rowIdx].code || '').trim()) {
    const contractNumber = document.getElementById('cFieldNumber')?.value.trim() ?? contract.number ?? '';
    const generatedCode = buildProductCode(prod.id, contractNumber);
    if (generatedCode) {
      contract.items[rowIdx].code = generatedCode;
      if (contract.renameActRows?.[rowIdx] && !String(contract.renameActRows[rowIdx].productCode || '').trim()) {
        contract.renameActRows[rowIdx].productCode = generatedCode;
      }
    }
  }
  rerenderFn();
}

function handleAutocompleteKeydown(e, inp, contract, rerenderFn) {
  const list = _acListEl;
  if (!list) return;
  const items = list.querySelectorAll('.ac-item');
  const active = list.querySelector('.ac-item.bg-cyan-400\\/10');
  const activeIdx = active ? Number(active.dataset.idx) : -1;

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const next = Math.min(activeIdx + 1, items.length - 1);
    items.forEach(el => el.classList.remove('bg-cyan-400/10'));
    items[next]?.classList.add('bg-cyan-400/10');
    items[next]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prev = Math.max(activeIdx - 1, 0);
    items.forEach(el => el.classList.remove('bg-cyan-400/10'));
    items[prev]?.classList.add('bg-cyan-400/10');
    items[prev]?.scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'Enter' && activeIdx >= 0) {
    e.preventDefault();
    const row = Number(inp.dataset.row);
    const suggestions = getProductSuggestions(inp.value);
    const prod = suggestions[activeIdx];
    if (prod) applyAutocomplete(inp, row, prod, contract, rerenderFn);
  } else if (e.key === 'Escape') {
    closeAllDropdowns();
  }
}

function highlightMatch(text, query) {
  if (!query.trim()) return escHtml(text);
  const idx = text.toLowerCase().indexOf(query.toLowerCase().trim());
  if (idx === -1) return escHtml(text);
  return escHtml(text.slice(0, idx))
    + '<mark class="bg-cyan-400/20 text-cyan-300 rounded">' + escHtml(text.slice(idx, idx + query.trim().length)) + '</mark>'
    + escHtml(text.slice(idx + query.trim().length));
}

// ── NMCD validation ───────────────────────────────────────────────

function checkNmcdForRow(contract, rowIdx) {
  const item = contract.items[rowIdx];
  if (!item) return;
  const nmcd  = parseFloat(item.nmcd)  || 0;
  const price = parseFloat(item.price) || 0;
  const warnEl  = document.querySelector('.nmcd-warn[data-row="' + rowIdx + '"]');
  const priceInp = document.querySelector('.item-price[data-row="' + rowIdx + '"]');
  if (!warnEl || !priceInp) return;
  const exceeded = nmcd > 0 && price > nmcd;
  warnEl.classList.toggle('hidden', !exceeded);
  priceInp.style.borderColor = exceeded ? 'rgb(239,68,68)' : '';
}

// ── Need validation ───────────────────────────────────────────────

/**
 * Live-валидация при вводе qty: обновляет рамку и подсказку под полем.
 * Блокирует сохранение если введённое кол-во превышает потребность.
 * @param {object} contract
 * @param {number} rowIdx
 * @param {HTMLInputElement} inp — input.item-qty
 */
function checkNeedForRow(contract, rowIdx, inp) {
  const item = contract.items[rowIdx];
  if (!item) return;

  const { need, contractedOther, available, exceeded } = calcNeedInfo(item, contract?.id);
  const currentQty = Number(item.qty) || 0;
  const total = contractedOther + currentQty;

  if (inp) {
    inp.dataset.need = String(need || 0);
    inp.dataset.contractedOther = String(contractedOther || 0);
    inp.style.borderColor = exceeded ? 'rgb(239,68,68)' : '';
    inp.classList.toggle('border-red-500/70', exceeded);
    if (!exceeded) {
      inp.classList.remove('border-red-500/70');
    }
  }

  const holder = inp?.parentElement || null;
  if (holder) {
    holder.setAttribute('title', buildNeedTooltip(item, contract?.id));
  }

  const warnEl = document.querySelector('.qty-need-warn[data-row="' + rowIdx + '"]');
  const infoEl = document.querySelector('.qty-need-info[data-row="' + rowIdx + '"]');

  if (need === 0) {
    if (warnEl) {
      warnEl.textContent = '';
      warnEl.classList.add('hidden');
    }
    if (infoEl) {
      infoEl.textContent = '';
      infoEl.classList.add('hidden');
    }
    return;
  }

  if (exceeded) {
    const over = total - need;
    if (warnEl) {
      warnEl.className = 'qty-need-warn absolute bottom-0 left-0 right-0 text-[9px] text-red-400 whitespace-nowrap leading-tight';
      warnEl.setAttribute('data-row', String(rowIdx));
      warnEl.textContent = '⚠ Превышение на ' + over + ' шт.';
      warnEl.classList.remove('hidden');
    } else if (infoEl) {
      infoEl.className = 'qty-need-warn absolute bottom-0 left-0 right-0 text-[9px] text-red-400 whitespace-nowrap leading-tight';
      infoEl.setAttribute('data-row', String(rowIdx));
      infoEl.textContent = '⚠ Превышение на ' + over + ' шт.';
      infoEl.classList.remove('hidden');
    }
  } else {
    const nextText = 'Потр.: ' + need + ' · Доступно: ' + available;
    if (warnEl) {
      warnEl.className = 'qty-need-info absolute bottom-0 left-0 right-0 text-[9px] text-slate-500 whitespace-nowrap leading-tight';
      warnEl.setAttribute('data-row', String(rowIdx));
      warnEl.textContent = nextText;
      warnEl.classList.remove('hidden');
    }
    if (infoEl) {
      infoEl.className = 'qty-need-info absolute bottom-0 left-0 right-0 text-[9px] text-slate-500 whitespace-nowrap leading-tight';
      infoEl.setAttribute('data-row', String(rowIdx));
      infoEl.textContent = nextText;
      infoEl.classList.remove('hidden');
    }
  }
}

/**
 * Проверяет все строки таблицы на превышение потребности перед сохранением.
 * Возвращает массив строк с превышением.
 */
function checkAllNeedsBeforeSave(contract) {
  const violations = [];
  contract.items.forEach((item, idx) => {
    if (!item.name) return;
    const { need, contractedOther, exceeded } = calcNeedInfo(item, contract.id);
    if (need > 0 && exceeded) {
      const over = (contractedOther + (Number(item.qty) || 0)) - need;
      violations.push({ name: item.name, over, need, contractedOther, qty: Number(item.qty) || 0 });
    }
  });
  return violations;
}

// ── Cost helpers ──────────────────────────────────────────────────

function refreshCostCell(contract, rowIdx) {
  const item = contract.items[rowIdx];
  if (!item) return;
  const cost = (parseFloat(item.price) || 0) * (parseFloat(item.qty) || 0);
  const cell = document.querySelector('.cost-cell[data-row="' + rowIdx + '"]');
  if (cell) cell.textContent = fmtNum(cost);
}

function updateItemsTotal(contract) {
  const total = contract.items.reduce((acc, i) =>
    acc + (parseFloat(i.price) || 0) * (parseFloat(i.qty) || 0), 0);
  const el = document.getElementById('itemsTotalCost');
  if (el) el.textContent = fmtNum(total) + ' ₽';
}

function refreshAdvanceCell(contract, rowIdx) {
  const item = contract.items[rowIdx];
  if (!item) return;
  const pct = getAdvancePct();
  const amt = (parseFloat(item.price) || 0) * (parseFloat(item.ordered) || 0) * pct / 100;
  const cell = document.querySelector('.advance-cell[data-row="' + rowIdx + '"]');
  if (cell) cell.textContent = fmtNum(amt);
  updateAdvanceTotal(contract);
}

function refreshAdvanceColumn(contract) {
  contract.items.forEach((_, idx) => refreshAdvanceCell(contract, idx));
}

function updateAdvanceTotal(contract) {
  const pct = getAdvancePct();
  const total = contract.items.reduce((acc, i) =>
    acc + (parseFloat(i.price) || 0) * (parseFloat(i.ordered) || 0) * pct / 100, 0);
  const el = document.getElementById('itemsAdvanceTotalCost');
  if (el) el.textContent = fmtNum(total) + ' ₽';
}

// ─── Save contract card ───────────────────────────────────────────

async function saveContractCard() {
  const contract = getContractById(_editingId);
  if (!contract) return;

  // ── Validate programs: all must have a name from Finance ──
  const validProgNames = new Set(getProgramNames());
  for (let i = 0; i < contract.programs.length; i++) {
    // Читаем актуальное значение из DOM <select>, а не из объекта в памяти
    const rowEl = document.querySelector('#programsList [data-prog-idx="' + i + '"]');
    const sel   = rowEl?.querySelector('.prog-name');
    const domName = sel ? sel.value : '';
    // Синхронизируем объект из DOM
    if (domName) contract.programs[i].name = domName;
    const nameToCheck = domName || contract.programs[i].name || '';
    if (!nameToCheck || !validProgNames.has(nameToCheck)) {
      showToast(t('contracts.programRequired'), 'error');
      if (sel) {
        sel.style.borderColor = 'rgb(239,68,68)';
        setTimeout(() => { sel.style.borderColor = ''; }, 2500);
        sel.focus();
      }
      return;
    }
  }

  // ── Проверка превышения потребности ──────────────────────────────
  const needViolations = checkAllNeedsBeforeSave(contract);
  if (needViolations.length > 0) {
    const lines = needViolations.map(v =>
      '• ' + v.name + ': введено ' + v.qty + ', потребность ' + v.need +
      ', в других контрактах ' + v.contractedOther + ' (превышение: ' + v.over + ' шт.)'
    );
    const proceed = confirm(
      '⚠ Количество товара превышает суммарную потребность:\n\n' + lines.join('\n') +
      '\n\nСохранить всё равно?'
    );
    if (!proceed) return;
  }

  // Sync item values from DOM before saving
  document.querySelectorAll('.item-specification-name').forEach(inp => {
    const idx = Number(inp.dataset.row);
    if (contract.items[idx]) contract.items[idx].specificationName = inp.value.trim();
  });
  document.querySelectorAll('.item-code').forEach(inp => {
    const idx = Number(inp.dataset.row);
    if (contract.items[idx]) contract.items[idx].code = inp.value.trim();
  });
  document.querySelectorAll('.item-nmcd').forEach(inp => {
    const idx = Number(inp.dataset.row);
    if (contract.items[idx]) contract.items[idx].nmcd = parseFloat(inp.value) || 0;
  });
  document.querySelectorAll('.item-unit').forEach(inp => {
    const idx = Number(inp.dataset.row);
    if (contract.items[idx]) contract.items[idx].unit = inp.value.trim();
  });
  syncRenameActRowsFromDom(contract);
  (contract.renameActRows || []).forEach((row) => {
    const item = findContractItemById(contract, row.contractItemId);
    if (!item) return;
    if (row.specificationName) item.specificationName = row.specificationName;
    if (row.productCode) item.code = row.productCode;
    if (row.price) item.price = row.price;
  });

  const title = document.getElementById('cFieldTitle')?.value.trim() || '';
  const number = document.getElementById('cFieldNumber')?.value.trim() || '';
  const date = document.getElementById('cFieldDate')?.value || '';
  const lotNumber = document.getElementById('cFieldLotNumber')?.value.trim() || '';
  const supplierId = Number(document.getElementById('cFieldSupplier')?.value) || null;
  const totalPrice = parseFloat(document.getElementById('cFieldTotalPrice')?.value) || 0;
  const advancePct = parseFloat(document.getElementById('cFieldAdvancePct')?.value) ?? null;
  const executionPolicy = {
    usesReadiness: document.getElementById('cPolicyUsesReadiness')?.value === '1',
    allowWarehouseRoute: true,
    allowDirectRoute: true,
    routeWhenReady: document.getElementById('cPolicyRouteWhenReady')?.value || 'direct',
    routeWhenNotReady: document.getElementById('cPolicyRouteWhenNotReady')?.value || 'warehouse',
    scenarioWhenReady: document.getElementById('cPolicyScenarioWhenReady')?.value || 'full',
    scenarioWhenNotReady: document.getElementById('cPolicyScenarioWhenNotReady')?.value || 'split',
    stage1Percent: parseFloat(document.getElementById('cPolicyStage1Percent')?.value) || 0,
    stage2Percent: parseFloat(document.getElementById('cPolicyStage2Percent')?.value) || 0,
    requireNotReadyAct: !!document.getElementById('cPolicyRequireNotReadyAct')?.checked,
    requireReadyAct: !!document.getElementById('cPolicyRequireReadyAct')?.checked,
    hasAdvance: document.getElementById('cPolicyHasAdvance')?.value === '1' || (parseFloat(document.getElementById('cFieldAdvancePct')?.value) || 0) > 0,
    advancePercent: parseFloat(document.getElementById('cPolicyAdvancePercent')?.value) || (parseFloat(document.getElementById('cFieldAdvancePct')?.value) || 0),
    advanceOffsetMode: document.getElementById('cPolicyAdvanceOffsetMode')?.value || 'sequential',
  };

  const matchedLot = lotNumber ? findLotByNumber(lotNumber) : null;
  if (matchedLot && String(contract.lotId || '') !== String(matchedLot.id)) {
    if (!hasMeaningfulContractItems(contract)) {
      applyLotItemsToContract(contract, matchedLot, { preserveQty: false });
    }
    contract.lotId = matchedLot.id;
  }
  if (!lotNumber) {
    contract.lotId = null;
    clearContractBindingFromLots(contract.id);
  }

  updateContract(contract.id, {
    title,
    number,
    lotNumber,
    lotId: contract.lotId ?? null,
    date,
    supplierId,
    totalPrice,
    advancePct: executionPolicy.hasAdvance ? (isNaN(advancePct) ? executionPolicy.advancePercent : advancePct) : 0,
    executionPolicy,
    programs: contract.programs,
    items: contract.items,
    renameActRows: contract.renameActRows,
    soApprovalRequired: contract.soApprovalRequired !== false,
  });

  if (lotNumber) {
    syncLotsFromContractCards(contract.id, { forceUpdate: true });
    const syncedLot = contract.lotId != null ? getLotById(contract.lotId) : findLotByNumber(lotNumber);
    if (syncedLot) {
      contract.lotId = syncedLot.id;
      bindContractToLot(syncedLot.id, contract.id, number);
      clearContractBindingFromLots(contract.id, syncedLot.id);
    }
  }

  const titleEl = document.getElementById('contractCardTitle');
  if (titleEl) titleEl.textContent = number ? (t('contracts.cardTitle') + ' № ' + number) : t('contracts.newCard');

  await saveToStorage();
  showToast(t('contracts.saved'), 'success');
  updateContractsBadge();

  if (supplierId) {
    renderLinkedContractsList(supplierId);
  }
}

// ─── Program Finance Summary ──────────────────────────────────────

export function refreshContractItemsOrdered(contractId) {
  const editPanel = document.getElementById('contractEditPanel');
  if (!editPanel || editPanel.classList.contains('hidden')) return;
  if (_editingId !== contractId) return;

  const contract = getContractById(contractId);
  if (!contract) return;

  contract.items.forEach((item, idx) => {
    const cell = document.querySelector('.ordered-cell[data-row="' + idx + '"]');
    if (cell) {
      cell.textContent = formatProgramMetricQty(item.ordered || 0);
      cell.style.transition = 'background 0.3s';
      cell.style.background = 'rgba(34,211,238,0.18)';
      setTimeout(() => { cell.style.background = ''; }, 900);
    }
  });

  renderProgramFinanceSummary(contract);
}

export function renderProgramFinanceSummary(contract) {
  const wrap = document.getElementById('contractFinanceSummaryWrap');
  if (!wrap) return;

  wrap.innerHTML = '';

  if (!contract.programs || contract.programs.length === 0) {
    wrap.innerHTML = '<p class="text-xs text-slate-600 italic">Целевые программы не заданы</p>';
    return;
  }

  const contractOrders = (state.orders || []).filter(o => o.contractId === contract.id);

  function orderedForProgram(progName) {
    let sum = 0;
    contractOrders.forEach(order => {
      const globalProg = (state.programs || []).find(p =>
        (p.code && p.code === order.programCode) || p.name === order.programCode
      );
      const matchByGlobalProg = globalProg ? (globalProg.name === progName) : false;
      const matchByDirectName = order.programCode === progName;
      if (!matchByGlobalProg && !matchByDirectName) return;

      if (Array.isArray(order.deliveryRows) && order.deliveryRows.length > 0) {
        order.deliveryRows.forEach(r => {
          sum += (Number(r.qty) || 0) * (Number(r.price) || 0);
        });
      } else {
        (order.items || []).forEach(it => {
          const scheds = Array.isArray(it.deliverySchedules) ? it.deliverySchedules : [];
          if (scheds.length > 0) {
            scheds.forEach(sc => {
              sum += (Number(sc.qty) || 0) * (Number(sc.price) || Number(it.price) || 0);
            });
          } else {
            sum += (Number(it.qty) || 0) * (Number(it.price) || 0);
          }
        });
      }
    });
    return sum;
  }

  // Also get global Finance limit for each program
  const finPrograms = getPrograms();

  const title = document.createElement('h3');
  title.className = 'text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3';
  title.textContent = 'Финансы по программам';
  wrap.appendChild(title);

  const tableWrap = document.createElement('div');
  tableWrap.className = 'overflow-x-auto rounded-xl border border-white/10';

  const table = document.createElement('table');
  table.className = 'w-full text-sm border-collapse';
  table.innerHTML =
    '<thead><tr class="border-b border-white/10 bg-white/[0.03]">' +
    '<th class="py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-left">Программа</th>' +
    '<th class="py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">Лимит (Финансы), ₽</th>' +
    '<th class="py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">Бюджет контракта, ₽</th>' +
    '<th class="py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">Сумма заказов, ₽</th>' +
    '<th class="py-2.5 px-4 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">Остаток по заказам, ₽</th>' +
    '</tr></thead>';

  const tbody = document.createElement('tbody');
  contract.programs.forEach(prog => {
    const budget  = parseFloat(prog.price) || 0;
    const ordered = orderedForProgram(prog.name);
    const remain  = budget - ordered;
    const remainClass = remain < 0 ? 'text-red-400' : remain === 0 ? 'text-slate-400' : 'text-emerald-400';

    // Global Finance limit and reserved
    const finProg = finPrograms.find(p => p.name === prog.name);
    const finLimit = parseFloat(finProg?.limit) || 0;
    const finReserved = state.contracts.reduce((sum, c) => {
      const p = (c.programs || []).find(p => p.name === prog.name);
      return sum + (parseFloat(p?.price) || 0);
    }, 0);
    const finRemaining = finLimit - finReserved;
    const finLimitHtml = finLimit > 0
      ? '<span class="text-cyan-400/80">' + fmtNum(finLimit) + '</span>' +
        '<span class="text-slate-600 text-[10px] ml-1">(ост. ' + fmtNum(finRemaining) + ')</span>'
      : '<span class="text-slate-600">—</span>';

    const tr = document.createElement('tr');
    tr.className = 'border-b border-white/5 hover:bg-white/[0.02]';
    const programLabel = formatProgramLabel(finProg || { name: prog.name });
    tr.innerHTML =
      '<td class="py-2.5 px-4 text-sm text-white">' + escHtml(programLabel || '—') + '</td>' +
      '<td class="py-2.5 px-4 text-sm tabular-nums text-right">' + finLimitHtml + '</td>' +
      '<td class="py-2.5 px-4 text-sm text-slate-300 tabular-nums text-right">' + fmtNum(budget) + '</td>' +
      '<td class="py-2.5 px-4 text-sm text-cyan-400 tabular-nums text-right">' + fmtNum(ordered) + '</td>' +
      '<td class="py-2.5 px-4 text-sm font-semibold tabular-nums text-right ' + remainClass + '">' + fmtNum(remain) + '</td>';
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
}

// ─── Contract sub-panels: Orders & Acts ──────────────────────────

function wireContractSubPanelButtons(contract) {
  const ordersBtn = document.getElementById('contractOrdersBtn');
  const actsBtn   = document.getElementById('contractActsBtn');

  if (ordersBtn) {
    const fresh = ordersBtn.cloneNode(true);
    ordersBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => renderContractOrdersPanel(contract));
  }

  if (actsBtn) {
    const fresh = actsBtn.cloneNode(true);
    actsBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => renderContractActsPanel(contract));
  }

  document.getElementById('contractOrdersPanelClose')?.addEventListener('click', () =>
    closeContractSubPanel('contractOrdersSubPanel'));
  document.getElementById('contractActsPanelClose')?.addEventListener('click', () =>
    closeContractSubPanel('contractActsSubPanel'));
}

function renderContractOrdersPanel(contract) {
  const panel = document.getElementById('contractOrdersSubPanel');
  if (!panel) return;

  const wrap = document.getElementById('contractOrdersPanelBody');
  if (!wrap) return;
  wrap.innerHTML = '';

  const orders = (state.orders || []).filter(o => o.contractId === contract.id);

  if (orders.length === 0) {
    wrap.innerHTML =
      '<div class="flex flex-col items-center justify-center py-12 text-center">' +
      '<span class="text-4xl mb-3" aria-hidden="true">📋</span>' +
      '<p class="text-sm font-semibold text-slate-300">Заявок по контракту нет</p>' +
      '<p class="text-xs text-slate-500 mt-1">Добавьте заявки в разделе «Заявки»</p>' +
      '</div>';
  } else {
    [...orders].reverse().forEach(order => {
      const totalCost = (order.deliveryRows || []).reduce(
        (s, r) => s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
      const uniqueItems = new Set((order.deliveryRows || []).map(r => r.contractItemName)).size;
      const dateStr = order.createdAt
        ? new Date(order.createdAt).toLocaleDateString('ru-RU') : '';
      const programLabel = order.programCode
        ? formatProgramLabel(getProgramByIdentity(order.programCode) || getProgramByIdentity(order.programName) || order.programCode)
        : '';

      const card = document.createElement('div');
      card.className = 'rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-1 cursor-pointer transition hover:bg-white/[0.08] hover:border-cyan-400/20 group';
      card.innerHTML =
        '<div class="flex items-center justify-between">' +
        '<p class="text-sm font-bold text-cyan-400">' + escHtml(order.orderNumber || ('#' + order.id)) + '</p>' +
        '<span class="text-[10px] text-cyan-400 opacity-0 group-hover:opacity-100 transition shrink-0 ml-2">Открыть →</span>' +
        '</div>' +
        (programLabel ? '<p class="text-xs text-slate-400">Программа: ' + escHtml(programLabel) + '</p>' : '') +
        (order.deliveryAddress ? '<p class="text-xs text-slate-400 truncate">📍 ' + escHtml(order.deliveryAddress) + '</p>' : '') +
        '<div class="flex gap-3 text-xs text-slate-500 flex-wrap">' +
        '<span>' + uniqueItems + ' поз.</span>' +
        '<span class="text-cyan-400/70 tabular-nums">' + fmtNum(totalCost) + ' ₽</span>' +
        (dateStr ? '<span>' + dateStr + '</span>' : '') +
        '</div>';

      card.addEventListener('click', () => {
        closeContractSubPanel('contractOrdersSubPanel');
        closeContractCard();
        closeContractsModal();
        _openOrdersModal();
        setTimeout(() => _openOrderCard(order.id, true), 60);
      });

      wrap.appendChild(card);
    });
  }

  openContractSubPanel('contractOrdersSubPanel');
}

function renderContractActsPanel(contract) {
  const panel = document.getElementById('contractActsSubPanel');
  if (!panel) return;

  const wrap = document.getElementById('contractActsPanelBody');
  if (!wrap) return;
  wrap.innerHTML = '';

  const acts = getActsForContract(contract.id);

  if (acts.length === 0) {
    wrap.innerHTML =
      '<div class="flex flex-col items-center justify-center py-12 text-center">' +
      '<span class="text-4xl mb-3" aria-hidden="true">🔍</span>' +
      '<p class="text-sm font-semibold text-slate-300">Проверок по контракту нет</p>' +
      '<p class="text-xs text-slate-500 mt-1">Создайте акт в разделе «Приёмка» → «Сформировать акт»</p>' +
      '</div>';
  } else {
    acts.forEach(act => {
      const actDate = act.date ? fmtDate(act.date) : '—';
      const savedAt = act.savedAt
        ? new Date(act.savedAt).toLocaleString('ru-RU', {
            day: '2-digit', month: '2-digit', year: 'numeric',
            hour: '2-digit', minute: '2-digit' }) : '';
      const selectedItems = (act.selectedItems || []).filter(si => si.selected !== false);
      const itemCount = selectedItems.length;
      const isDeliveryAct = (act.mode || 'so') === 'delivery';
      const aggregateStatus = getContractActAggregateStatus(selectedItems, isDeliveryAct);

      const card = document.createElement('div');
      card.className = 'rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-1 cursor-pointer transition hover:bg-white/[0.09] hover:border-cyan-400/20 group';
      card.innerHTML =
        '<div class="flex items-center gap-2 flex-wrap">' +
        '<p class="text-sm font-semibold text-white">Проверка от ' + escHtml(actDate) + '</p>' +
        '<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold ' + aggregateStatus.badgeClass + '">' + escHtml(aggregateStatus.text) + '</span>' +
        '<span class="ml-auto opacity-0 group-hover:opacity-100 transition text-xs text-cyan-400">Открыть →</span>' +
        '</div>' +
        (act.location ? '<p class="text-xs text-slate-400">📍 ' + escHtml(act.location) + '</p>' : '') +
        '<div class="flex gap-3 text-xs text-slate-500 flex-wrap">' +
        (itemCount > 0 ? '<span>' + itemCount + ' поз.</span>' : '') +
        (savedAt ? '<span>Сохранён: ' + escHtml(savedAt) + '</span>' : '') +
        '</div>' +
        (act.result ? '<p class="text-xs text-slate-300 mt-1 line-clamp-2">' + escHtml(act.result) + '</p>' : '') +
        '<div class="flex gap-2 pt-1">' +
        '<button class="act-open-btn inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-400" data-act-id="' + act.id + '" aria-label="Открыть акт">🔍 Просмотр</button>' +
        '<button class="act-dl-btn inline-flex items-center gap-1.5 rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-medium text-slate-300 transition hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-400" data-act-id="' + act.id + '" aria-label="Скачать акт">📄 .docx</button>' +
        '</div>';

      const openExactAct = (event) => {
        if (event) event.stopPropagation();
        closeContractSubPanel('contractActsSubPanel');
        closeContractCard();
        closeContractsModal();
        openActsRegistryWithAct(act.id);
      };

      card.addEventListener('click', openExactAct);

      card.querySelector('.act-open-btn')?.addEventListener('click', openExactAct);

      card.querySelector('.act-dl-btn')?.addEventListener('click', e => {
        e.stopPropagation();
        generateAndDownload(act.id);
      });

      wrap.appendChild(card);
    });
  }

  openContractSubPanel('contractActsSubPanel');
}

function fmtDate(iso) {
  if (!iso) return '';
  try { const [y, m, d] = iso.split('-'); return d + '.' + m + '.' + y; } catch { return iso; }
}

// ─── Init ──────────────────────────────────────────────────────────

export function initContractsView() {
  initClaimsView();

  window.addEventListener('claims-changed', () => {
    const panel = document.getElementById('contractEditPanel');
    if (!panel || panel.classList.contains('hidden') || !_editingId) return;
    const contract = getContractById(_editingId);
    if (!contract) return;
    const claimsBtn = ensureContractClaimsButton(contract);
    if (claimsBtn) claimsBtn.onclick = () => openClaimsModal(contract.id);
  });

  window.addEventListener('primary-docs-changed', () => {
    const panel = document.getElementById('contractEditPanel');
    if (!panel || panel.classList.contains('hidden') || !_editingId) return;
    const contract = getContractById(_editingId);
    if (contract) renderContractPrimaryDocs(contract);
  });

  document.getElementById('addContractListBtn')?.addEventListener('click', () => openContractCard(null));
  document.getElementById('contractsCloseBtn')?.addEventListener('click', closeContractsModal);
  document.getElementById('contractCardBackBtn')?.addEventListener('click', closeContractCard);
  document.getElementById('contractCardSaveBtn')?.addEventListener('click', saveContractCard);
  document.getElementById('contractCardEditBtn')?.addEventListener('click', () => {
    setContractCardReadonly(false);
  });

  const modal = document.getElementById('contractsModal');
  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === modal) closeContractsModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        const editPanel = document.getElementById('contractEditPanel');
        if (editPanel && !editPanel.classList.contains('hidden')) {
          closeContractCard();
        } else {
          closeContractsModal();
        }
      }
    });
  }
}

// ─── Utility ──────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
