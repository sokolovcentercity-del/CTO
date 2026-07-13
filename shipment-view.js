/**
 * Shipment module — «Новая отгрузка» + «Реестр отгрузок».
 *
 * Новая логика формирования отгрузки:
 *  - Таблица показывает ОДНУ строку на товар (без разбивки по заявкам).
 *  - Пользователь вводит количество для каждого получателя.
 *  - Автораспределение по заявкам: FIFO, приоритет одному поставщику.
 *  - Смешение поставщиков только если одного недостаточно для закрытия потребности.
 *  - Целевая программа заявки должна совпадать с программой получателя.
 */

import { $, el, clearChildren, confirmDeleteWithImpact } from './dom.js';
import { attachFrozenManager } from './frozen-table.js';
import {
  state, getWarehouseEntries, updateWarehouseEntry,
  addShipment, updateShipment, getShipments, deleteShipment, recalcAllDelivered,
  resolveProductVariantByContractCode, getRecipientNeedMetrics,
} from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── helpers ─────────────────────────────────────────────────────

function fmt(n) {
  return Number(n || 0).toLocaleString('ru-RU', { minimumFractionDigits: 0 });
}

function fmtDate(iso) {
  if (!iso) return '—';
  try { return new Date(iso).toLocaleDateString('ru-RU'); } catch { return iso; }
}

function getOrderById(id) { return (state.orders || []).find(o => o.id === id) || null; }
function getSupplierById(id) { return (state.suppliers || []).find(s => s.id === id) || null; }
function getContractById(id) { return (state.contracts || []).find(c => c.id === id) || null; }

function orderLabel(o) {
  if (!o) return '—';
  return o.orderNumber || ('Заявка #' + o.id);
}

function normalizeCompare(value) {
  return String(value || '').trim().toLowerCase();
}

function resolveShipmentVariantMeta(order, productCode, productName) {
  const codeLow = normalizeCompare(productCode);
  const nameLow = normalizeCompare(productName);

  const matchedOrderRow = Array.isArray(order?.deliveryRows)
    ? order.deliveryRows.find((row) => {
        const rowCode = normalizeCompare(row?.contractItemCode || row?.productCode || '');
        const rowName = normalizeCompare(row?.displayName || row?.contractItemName || row?.productName || '');
        return (codeLow && rowCode === codeLow) || (!codeLow && nameLow && rowName === nameLow);
      }) || null
    : null;

  if (matchedOrderRow) {
    const variantMeta = resolveProductVariantByContractCode(
      matchedOrderRow.contractItemCode || matchedOrderRow.productCode || productCode,
      matchedOrderRow.contractItemName || matchedOrderRow.productName || productName,
    );
    return {
      productId: matchedOrderRow.productId ?? variantMeta?.productId ?? null,
      variantId: matchedOrderRow.variantId || variantMeta?.variantId || '',
      colorCode: matchedOrderRow.colorCode || variantMeta?.colorCode || '',
      displayName: matchedOrderRow.displayName || matchedOrderRow.contractItemName || productName || '',
    };
  }

  const variantMeta = resolveProductVariantByContractCode(productCode, productName);
  return {
    productId: variantMeta?.productId ?? null,
    variantId: variantMeta?.variantId || '',
    colorCode: variantMeta?.colorCode || '',
    displayName: variantMeta?.productName || productName || '',
  };
}

function resolveShipmentRowSupplier(row) {
  if (!row) return { supplierId: null, supplierName: '—' };

  if (row.supplierId != null) {
    const supplier = getSupplierById(row.supplierId);
    if (supplier?.name) return { supplierId: row.supplierId, supplierName: supplier.name };
  }

  const directName = String(row.supplierName || '').trim();
  if (directName) return { supplierId: row.supplierId ?? null, supplierName: directName };

  const order = row.orderId != null ? getOrderById(row.orderId) : null;
  const contractId = row.contractId ?? order?.contractId ?? null;
  const contract = contractId != null ? getContractById(contractId) : null;
  const supplierId = row.supplierId ?? contract?.supplierId ?? null;
  const supplier = supplierId != null ? getSupplierById(supplierId) : null;

  return {
    supplierId,
    supplierName: supplier?.name || '—',
  };
}

function getShipmentSupplierNames(shipment) {
  return [...new Set(
    (shipment?.rows || [])
      .map(row => String(resolveShipmentRowSupplier(row).supplierName || '').trim())
      .filter(Boolean)
      .filter(name => name !== '—')
  )].sort((a, b) => a.localeCompare(b, 'ru'));
}

function resolveCategory(item) {
  if (item && item.category) return item.category;
  const code = (item?.productCode || '').trim().toLowerCase();
  const name = (item?.productName || '').trim().toLowerCase();
  if (!code && !name) return '';
  const products = state.products || [];
  if (code) {
    const p = products.find(p => p.code && p.code.trim().toLowerCase() === code);
    if (p?.category) return p.category;
  }
  if (name) {
    const p = products.find(p => p.name && p.name.trim().toLowerCase() === name);
    if (p?.category) return p.category;
  }
  return '';
}

/**
 * Нормализует название программы: ищет в state.programs по имени или коду.
 * Возвращает канонический name или исходную строку.
 */
function resolveProgName(val) {
  if (!val) return '';
  const v = val.trim().toLowerCase();
  const programs = state.programs || [];
  const byName = programs.find(p => (p.name || '').trim().toLowerCase() === v);
  if (byName) return byName.name;
  const byCode = programs.find(p => (p.code || '').trim().toLowerCase() === v);
  if (byCode) return byCode.name;
  return val.trim();
}

function formatProgramValueLabel(val) {
  return formatProgramLabel(getProgramByIdentity(val) || val);
}

/**
 * Проверяет совместимость целевой программы заявки и получателя.
 * Возвращает { allowed: boolean, reason: string }
 */
function isProgramAllowed(orderId, recipient) {
  const recipientProgram = (recipient.targetProgram || '').trim();

  if (!recipientProgram) {
    return {
      allowed: false,
      reason: 'У получателя «' + (recipient.name || '—') + '» не указана целевая программа.\nОткройте карточку получателя и выберите программу из модуля «Финансы».',
    };
  }

  if (!orderId) {
    return {
      allowed: false,
      reason: 'Товар поступил без привязки к заявке.\nОтгрузка получателю с программой «' + formatProgramValueLabel(recipientProgram) + '» невозможна — нельзя проверить целевую программу.',
    };
  }

  const order = getOrderById(orderId);
  if (!order) {
    return {
      allowed: false,
      reason: 'Заявка #' + orderId + ' не найдена в реестре.\nОтгрузка заблокирована.',
    };
  }

  const orderProgramRaw = (order.programCode || order.programName || '').trim();
  if (!orderProgramRaw) {
    return {
      allowed: false,
      reason: 'У заявки «' + (order.orderNumber || '#' + order.id) + '» не указана целевая программа.\nОткройте заявку и выберите программу из модуля «Финансы».',
    };
  }

  const orderProgram = resolveProgName(orderProgramRaw);
  const recipientProgramNorm = resolveProgName(recipientProgram);
  const orderProgramLabel = formatProgramValueLabel(orderProgramRaw || orderProgram);
  const recipientProgramLabel = formatProgramValueLabel(recipientProgramNorm || recipientProgram);

  if (orderProgram.toLowerCase() === recipientProgramNorm.toLowerCase()) {
    return { allowed: true, reason: '' };
  }

  return {
    allowed: false,
    reason: 'Целевые программы не совпадают:\n  заявка «' + (order.orderNumber || '#' + order.id) + '»: «' + orderProgramLabel + '»\n  получатель «' + (recipient.name || '—') + '»: «' + recipientProgramLabel + '»',
  };
}

// ─── Stock building ───────────────────────────────────────────────

/**
 * Единица доступного запаса по одной заявке (orderId) для одного товара (codeKey).
 * @typedef {{ codeKey: string, orderId: number|null, supplierId: number|null, supplierName: string,
 *             balance: number, entryIds: number[], orderNum: string, contractId: number|null }} StockSlot
 */

/**
 * Строит список StockSlot — доступных остатков, разбитых по (codeKey, orderId).
 * Отсортировано по FIFO (дата поступления), внутри одного codeKey.
 *
 * @param {object|null} excludeShipment — редактируемая отгрузка (её qty возвращается в баланс)
 * @returns {Map<string, StockSlot[]>} codeKey -> массив слотов в FIFO-порядке
 */
function buildStockSlots(excludeShipment = null) {
  const entries = getWarehouseEntries();

  // Сортируем по дате FIFO
  const sorted = [...entries].sort((a, b) => {
    const da = a.date || '';
    const db = b.date || '';
    if (da < db) return -1;
    if (da > db) return 1;
    return (a.id || 0) - (b.id || 0);
  });

  // Считаем уже отгруженное по (codeKey, orderId) из всех отгрузок кроме редактируемой
  const deliveredBySlot = new Map(); // `${codeKey}::${orderId}` -> qty
  for (const sh of (state.shipments || [])) {
    if (excludeShipment && sh.id === excludeShipment.id) continue;
    for (const row of (sh.rows || [])) {
      const rowTotal = (row.recipients || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
      if (rowTotal <= 0) continue;
      const key = row.orderKey || (row.codeKey + '::noorder');
      deliveredBySlot.set(key, (deliveredBySlot.get(key) || 0) + rowTotal);
    }
  }

  // Если редактируем — возвращаем в баланс то, что было отгружено этой отгрузкой
  const prevAllocBySlot = new Map(); // orderKey -> qty
  if (excludeShipment) {
    for (const row of (excludeShipment.rows || [])) {
      const ok = row.orderKey || (row.codeKey + '::noorder');
      const rowTotal = (row.recipients || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
      prevAllocBySlot.set(ok, (prevAllocBySlot.get(ok) || 0) + rowTotal);
    }
  }

  // slotMap: codeKey -> Map<orderId_str, StockSlot>
  const slotMap = new Map();

  for (const entry of sorted) {
    const items = Array.isArray(entry.items) && entry.items.length > 0
      ? entry.items.filter(i => Number(i.qty) > 0)
      : [];
    if (items.length === 0) continue;

    const orderId = entry.orderId ?? null;
    const order = orderId ? getOrderById(orderId) : null;
    const orderNum = order ? orderLabel(order) : (orderId ? 'Заявка #' + orderId : null);
    const supplierId = entry.supplierId ?? (order ? null : null);
    // Поставщик: из записи поступления, или из контракта
    let resolvedSupplierId = entry.supplierId ?? null;
    if (!resolvedSupplierId && entry.contractId) {
      const contract = (state.contracts || []).find(c => c.id === entry.contractId);
      if (contract) resolvedSupplierId = contract.supplierId ?? null;
    }
    if (!resolvedSupplierId && order?.contractId) {
      const contract = (state.contracts || []).find(c => c.id === order.contractId);
      if (contract) resolvedSupplierId = contract.supplierId ?? null;
    }
    const supplier = resolvedSupplierId ? getSupplierById(resolvedSupplierId) : null;
    const supplierName = supplier?.name || (resolvedSupplierId ? 'Поставщик #' + resolvedSupplierId : '—');
    const contractId = entry.contractId ?? order?.contractId ?? null;

    for (const item of items) {
      const code = (item.productCode || '').trim();
      const name = (item.productName || '').trim();
      const codeKey = code.toLowerCase() || name.toLowerCase();
      if (!codeKey) continue;
      const variantMeta = resolveShipmentVariantMeta(order, code, name);

      const qty = Number(item.qty) || 0;
      const orderKeyPart = orderId != null ? String(orderId) : 'noorder';
      const orderKey = `${codeKey}::${orderKeyPart}`;

      const slotBalance = qty;

      if (!slotMap.has(codeKey)) slotMap.set(codeKey, new Map());
      const byOrder = slotMap.get(codeKey);

      if (!byOrder.has(orderKeyPart)) {
        // Считаем баланс по этому слоту
        const delivered = deliveredBySlot.get(orderKey) || 0;
        const prevAlloc = prevAllocBySlot.get(orderKey) || 0;
        byOrder.set(orderKeyPart, {
          codeKey,
          productCode: code,
          productName: name,
          displayName: variantMeta.displayName || name,
          productId: variantMeta.productId ?? null,
          variantId: variantMeta.variantId || '',
          colorCode: variantMeta.colorCode || '',
          category: resolveCategory(item),
          orderId,
          orderNum,
          orderKey,
          supplierId: resolvedSupplierId,
          supplierName,
          contractId,
          balance: 0,       // накопим ниже
          receivedTotal: 0, // накопим
          deliveredTotal: delivered,
          prevAlloc,
          entryIds: [],
        });
      }
      const slot = byOrder.get(orderKeyPart);
      slot.receivedTotal += qty;
      slot.balance = Math.max(0, slot.receivedTotal - slot.deliveredTotal + slot.prevAlloc);
      slot.entryIds.push(entry.id);
      // Обновляем метаданные из последнего поступления если не заполнены
      if (!slot.category) slot.category = resolveCategory(item);
      if (!slot.productCode) slot.productCode = code;
      if (!slot.productName) slot.productName = name;
      if (!slot.displayName) slot.displayName = variantMeta.displayName || name;
      if (!slot.productId && variantMeta.productId) slot.productId = variantMeta.productId;
      if (!slot.variantId && variantMeta.variantId) slot.variantId = variantMeta.variantId;
      if (!slot.colorCode && variantMeta.colorCode) slot.colorCode = variantMeta.colorCode;
    }
  }

  // Преобразуем в Map<codeKey, StockSlot[]> — только слоты с balance > 0
  const result = new Map();
  for (const [codeKey, byOrder] of slotMap.entries()) {
    const slots = [...byOrder.values()].filter(s => s.balance > 0);
    if (slots.length > 0) result.set(codeKey, slots);
  }

  // При редактировании: убеждаемся, что все codeKey из предыдущей отгрузки присутствуют
  if (excludeShipment) {
    for (const row of (excludeShipment.rows || [])) {
      const ck = row.codeKey;
      if (!ck) continue;
      if (!result.has(ck)) {
        // Добавляем виртуальный слот
        const ok = row.orderKey || (ck + '::noorder');
        const rowTotal = (row.recipients || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
        if (rowTotal > 0) {
          result.set(ck, [{
            codeKey: ck,
            productCode: row.productCode || '',
            productName: row.productName || '',
            displayName: row.displayName || row.productName || '',
            productId: row.productId ?? null,
            variantId: row.variantId || '',
            colorCode: row.colorCode || '',
            category: row.category || '',
            orderId: row.orderId ?? null,
            orderNum: row.orderNum || null,
            orderKey: ok,
            supplierId: null,
            supplierName: '—',
            contractId: null,
            balance: rowTotal,
            receivedTotal: rowTotal,
            deliveredTotal: 0,
            prevAlloc: rowTotal,
            entryIds: [],
          }]);
        }
      }
    }
  }

  return result;
}

/**
 * Строит сводную строку по товару из слотов.
 * @typedef {{ codeKey, productCode, productName, category, totalBalance,
 *             slots: StockSlot[], supplierNames: string[] }} ProductStockRow
 */
function buildProductRows(slotMap) {
  const rows = [];
  for (const [codeKey, slots] of slotMap.entries()) {
    const first = slots[0];
    const totalBalance = slots.reduce((s, sl) => s + sl.balance, 0);
    const supplierNames = [...new Set(slots.map(s => s.supplierName).filter(n => n && n !== '—'))];
    rows.push({
      // Наличие по каждому поставщику: supplierId -> { name, balance }
      stockBySupplier: (() => {
        const map = new Map();
        for (const slot of slots) {
          const key = String(slot.supplierId ?? 'none');
          if (!map.has(key)) map.set(key, { name: slot.supplierName, balance: 0 });
          map.get(key).balance += slot.balance;
        }
        return [...map.values()];
      })(),
      codeKey,
      productCode: first.productCode,
      productName: first.productName,
      displayName: first.displayName || first.productName,
      productId: first.productId ?? null,
      variantId: first.variantId || '',
      colorCode: first.colorCode || '',
      category: first.category,
      totalBalance,
      slots, // FIFO-порядок
      supplierNames,
    });
  }
  return rows.sort((a, b) => {
    const ca = a.category || ''; const cb = b.category || '';
    if (ca !== cb) return ca.localeCompare(cb);
    return (a.productName || '').localeCompare(b.productName || '');
  });
}

// ─── FIFO auto-distribution ───────────────────────────────────────

/**
 * Автоматически распределяет запрошенное количество по слотам FIFO.
 *
 * Правила:
 * 1. Проверяем программу каждого слота для данного получателя.
 * 2. Группируем доступные слоты по поставщику.
 * 3. Ищем поставщика, у которого достаточно товара для закрытия всей потребности.
 *    Если такой есть — берём только у него (FIFO внутри поставщика).
 * 4. Если ни у одного поставщика не хватает — смешиваем: сначала тот у кого больше, FIFO.
 * 5. Возвращает массив { slot, qty } — сколько взять из каждого слота.
 *
 * @param {StockSlot[]} slots — доступные слоты для товара (FIFO-порядок)
 * @param {number} requested — запрошенное количество
 * @param {object} recipient — получатель
 * @param {Map<string, number>} alreadyTaken — orderKey -> уже взято в этой отгрузке другими получателями
 * @returns {{ allocations: Array<{slot, qty}>, blocked: string|null }}
 */
function autoDistribute(slots, requested, recipient, alreadyTaken) {
  if (requested <= 0) return { allocations: [], blocked: null };

  // Фильтруем слоты по программе и остатку
  const eligible = slots.map(slot => {
    const progCheck = isProgramAllowed(slot.orderId, recipient);
    const taken = alreadyTaken.get(slot.orderKey) || 0;
    const avail = Math.max(0, slot.balance - taken);
    return { slot, avail, progCheck };
  }).filter(x => x.progCheck.allowed && x.avail > 0);

  if (eligible.length === 0) {
    // Нет доступных слотов — выясняем причину
    const progBlocked = slots.some(s => {
      const pc = isProgramAllowed(s.orderId, recipient);
      return !pc.allowed;
    });
    if (progBlocked) {
      const firstBlocked = slots.find(s => !isProgramAllowed(s.orderId, recipient).allowed);
      const reason = firstBlocked ? isProgramAllowed(firstBlocked.orderId, recipient).reason : 'Программы не совпадают';
      return { allocations: [], blocked: reason };
    }
    return { allocations: [], blocked: null };
  }

  // Группируем по поставщику
  const bySupplier = new Map(); // supplierId_str -> eligible[]
  for (const e of eligible) {
    const key = String(e.slot.supplierId ?? 'none');
    if (!bySupplier.has(key)) bySupplier.set(key, []);
    bySupplier.get(key).push(e);
  }

  // Ищем поставщика с достаточным количеством
  let chosenSupplierKey = null;
  let maxAvail = 0;
  for (const [key, items] of bySupplier.entries()) {
    const total = items.reduce((s, x) => s + x.avail, 0);
    if (total >= requested) {
      // Этого поставщика достаточно — выбираем его
      chosenSupplierKey = key;
      break;
    }
    if (total > maxAvail) { maxAvail = total; chosenSupplierKey = key; }
  }

  // Если ни один поставщик не покрывает полностью — используем всех (FIFO по дате)
  let workList;
  if (chosenSupplierKey !== null) {
    const supplierTotal = bySupplier.get(chosenSupplierKey).reduce((s, x) => s + x.avail, 0);
    if (supplierTotal >= requested) {
      workList = bySupplier.get(chosenSupplierKey);
    } else {
      // Недостаточно у лучшего поставщика — берём у него всё, остальное добираем у других
      workList = [...eligible].sort((a, b) => {
        // Сначала предпочтительный поставщик
        if (a.slot.supplierId === bySupplier.get(chosenSupplierKey)[0].slot.supplierId) return -1;
        if (b.slot.supplierId === bySupplier.get(chosenSupplierKey)[0].slot.supplierId) return 1;
        return 0;
      });
    }
  } else {
    workList = eligible;
  }

  // Распределяем по FIFO
  const allocations = [];
  let remaining = requested;
  for (const { slot, avail } of workList) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, avail);
    if (take > 0) {
      allocations.push({ slot, qty: take });
      remaining -= take;
    }
  }

  return { allocations, blocked: null };
}

// ─── Module state ─────────────────────────────────────────────────

/**
 * shipmentInput: codeKey -> { recipientId -> qty }
 * Хранит введённые пользователем количества.
 */
let shipmentInput = {};

/**
 * distributionResult: codeKey -> { recipientId -> [{slot, qty}] }
 * Результат автораспределения по слотам.
 */
let distributionResult = {};

const collapsedShipments = new Set();
let shipSortCol = 'category';
let shipSortDir = 'asc';
let shipFilterCategory = '';
let shipFilterSearch = '';
let editingShipmentId = null;

// ─── Panel show/hide ──────────────────────────────────────────────

export function showShipmentPanel(shipmentToEdit = null) {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
  $('warehouseShipmentsRegistryPanel')?.classList.add('hidden');
  $('warehouseShipmentPanel')?.classList.remove('hidden');

  editingShipmentId = shipmentToEdit ? shipmentToEdit.id : null;
  shipmentInput = {};
  distributionResult = {};

  const titleEl = $('warehouseShipmentPanelTitle');
  if (titleEl) titleEl.textContent = editingShipmentId ? 'Редактировать отгрузку' : 'Новая отгрузка';

  // При редактировании восстанавливаем введённые количества
  if (shipmentToEdit) {
    (shipmentToEdit.rows || []).forEach(row => {
      const ck = row.codeKey;
      if (!ck) return;
      if (!shipmentInput[ck]) shipmentInput[ck] = {};
      (row.recipients || []).forEach(r => {
        shipmentInput[ck][r.recipientId] = (shipmentInput[ck][r.recipientId] || 0) + r.qty;
      });
    });
  }

  renderShipmentPanel();
}

export function hideShipmentPanel() {
  $('warehouseShipmentPanel')?.classList.add('hidden');
  editingShipmentId = null;
  shipmentInput = {};
  distributionResult = {};
  $('warehouseHomePanel')?.classList.remove('hidden');
}

export function showShipmentsRegistry() {
  $('warehouseHomePanel')?.classList.add('hidden');
  $('warehouseListPanel')?.classList.add('hidden');
  $('warehouseCardPanel')?.classList.add('hidden');
  $('warehouseImportPanel')?.classList.add('hidden');
  $('warehouseStockPanel')?.classList.add('hidden');
  $('warehouseShipmentPanel')?.classList.add('hidden');
  $('warehouseShipmentsRegistryPanel')?.classList.remove('hidden');
  renderShipmentsRegistry();
}

export function hideShipmentsRegistry() {
  $('warehouseShipmentsRegistryPanel')?.classList.add('hidden');
  $('warehouseHomePanel')?.classList.remove('hidden');
}

// ─── Render shipment panel ────────────────────────────────────────

function recalcDistribution(productRows, recipients) {
  distributionResult = {};

  for (const prow of productRows) {
    distributionResult[prow.codeKey] = {};
    // Накапливаем «уже взято» по слотам для предыдущих получателей
    const alreadyTaken = new Map(); // orderKey -> qty

    for (const rec of recipients) {
      const requested = (shipmentInput[prow.codeKey] || {})[rec.id] || 0;
      if (requested <= 0) {
        distributionResult[prow.codeKey][rec.id] = [];
        continue;
      }
      const { allocations, blocked } = autoDistribute(prow.slots, requested, rec, alreadyTaken);
      distributionResult[prow.codeKey][rec.id] = blocked ? [] : allocations;
      // Обновляем alreadyTaken
      for (const { slot, qty } of allocations) {
        alreadyTaken.set(slot.orderKey, (alreadyTaken.get(slot.orderKey) || 0) + qty);
      }
    }
  }
}

function renderShipmentPanel() {
  const wrap = $('warehouseShipmentWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const existingShipment = editingShipmentId != null
    ? getShipments().find(s => s.id === editingShipmentId) || null
    : null;

  const slotMap = buildStockSlots(existingShipment);
  let productRows = buildProductRows(slotMap);
  const recipients = (state.recipients || []).filter(r => r.id);

  if (productRows.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '📦'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' }, 'Нет товаров в наличии'));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' }, 'Добавьте поступления в раздел «Реестр поступлений»'));
    wrap.appendChild(empty);
    return;
  }

  if (recipients.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '👥'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' }, 'Нет получателей'));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' }, 'Добавьте получателей в разделе «Получатели»'));
    wrap.appendChild(empty);
    return;
  }

  // ── Предупреждения ───────────────────────────────────────────────
  const recipientsWithoutProgram = recipients.filter(r => !(r.targetProgram || '').trim());
  if (recipientsWithoutProgram.length > 0) {
    const warnBanner = el('div', {
      className: 'flex items-start gap-2 rounded-xl border border-rose-500/30 bg-rose-500/[0.07] px-3 py-2 mb-3',
    });
    warnBanner.appendChild(el('span', { className: 'text-rose-400 text-sm mt-0.5 shrink-0' }, '⛔'));
    const warnText = el('div', { className: 'text-xs text-rose-300' });
    warnText.appendChild(el('strong', {}, 'Отгрузка заблокирована для получателей без целевой программы:'));
    const warnList = el('ul', { className: 'mt-1 ml-2 space-y-0.5 text-rose-400/80' });
    recipientsWithoutProgram.forEach(r => {
      const li = el('li', {});
      li.textContent = '• ' + (r.name || '—') + ' — откройте карточку и выберите программу';
      warnList.appendChild(li);
    });
    warnText.appendChild(warnList);
    warnBanner.appendChild(warnText);
    wrap.appendChild(warnBanner);
  }

  const ordersWithoutProgram = [];
  for (const [, slots] of slotMap.entries()) {
    for (const slot of slots) {
      if (!slot.orderId) continue;
      const order = getOrderById(slot.orderId);
      if (order && !(order.programName || order.programCode || '').trim()) {
        if (!ordersWithoutProgram.find(o => o.id === order.id)) ordersWithoutProgram.push(order);
      }
    }
  }
  if (ordersWithoutProgram.length > 0) {
    const warnBanner2 = el('div', {
      className: 'flex items-start gap-2 rounded-xl border border-amber-500/30 bg-amber-500/[0.07] px-3 py-2 mb-3',
    });
    warnBanner2.appendChild(el('span', { className: 'text-amber-400 text-sm mt-0.5 shrink-0' }, '⚠'));
    const warnText2 = el('div', { className: 'text-xs text-amber-300' });
    warnText2.appendChild(el('strong', {}, 'Заявки без целевой программы — отгрузка по ним заблокирована:'));
    const warnList2 = el('ul', { className: 'mt-1 ml-2 space-y-0.5 text-amber-400/80' });
    ordersWithoutProgram.forEach(o => {
      const li = el('li', {});
      li.textContent = '• ' + (o.orderNumber || 'Заявка #' + o.id) + ' — откройте заявку и выберите программу';
      warnList2.appendChild(li);
    });
    warnText2.appendChild(warnList2);
    warnBanner2.appendChild(warnText2);
    wrap.appendChild(warnBanner2);
  }

  // ── Инфо-баннер ─────────────────────────────────────────────────
  const infoBanner = el('div', {
    className: 'flex items-start gap-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] px-3 py-2 mb-3',
  });
  infoBanner.appendChild(el('span', { className: 'text-cyan-400 text-sm mt-0.5' }, 'ℹ'));
  const infoText = el('span', { className: 'text-xs text-slate-400' });
  infoText.textContent = 'Введите количество для каждого получателя. Товар автоматически распределится по заявкам: сначала от одного поставщика по очередности поступления, смешение поставщиков — только при нехватке.';
  infoBanner.appendChild(infoText);
  wrap.appendChild(infoBanner);

  // ── Toolbar ──────────────────────────────────────────────────────
  const toolbar = el('div', { className: 'flex flex-wrap gap-2 mb-3 items-center' });

  const searchWrap = el('div', { className: 'relative flex-1 min-w-[160px]' });
  const searchIcon = el('span', { className: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm' });
  searchIcon.textContent = '🔍';
  searchWrap.appendChild(searchIcon);
  const searchInp = el('input', {
    type: 'search',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 pl-9 pr-4 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50 focus:outline-none',
    placeholder: 'Поиск по наименованию, коду…',
    'aria-label': 'Поиск товаров',
    value: shipFilterSearch,
  });
  searchInp.addEventListener('input', () => { shipFilterSearch = searchInp.value; renderShipmentPanel(); });
  searchWrap.appendChild(searchInp);
  toolbar.appendChild(searchWrap);

  const categories = [...new Set(productRows.map(r => r.category).filter(Boolean))].sort();
  if (categories.length > 0) {
    const catSel = el('select', {
      className: 'rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300 transition focus:border-cyan-400/50 min-w-[110px]',
      'aria-label': 'Фильтр по категории',
    });
    catSel.appendChild(el('option', { value: '' }, 'Все категории'));
    categories.forEach(cat => {
      const o = el('option', { value: cat }, cat);
      if (shipFilterCategory === cat) o.selected = true;
      catSel.appendChild(o);
    });
    catSel.addEventListener('change', () => { shipFilterCategory = catSel.value; renderShipmentPanel(); });
    toolbar.appendChild(catSel);
  }

  const resetBtn = el('button', {
    type: 'button',
    className: 'rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 hover:text-white hover:bg-white/10 transition',
  }, '✕ Сбросить');
  resetBtn.addEventListener('click', () => {
    shipFilterSearch = '';
    shipFilterCategory = '';
    shipmentInput = {};
    distributionResult = {};
    if (existingShipment) {
      (existingShipment.rows || []).forEach(row => {
        const ck = row.codeKey;
        if (!ck) return;
        if (!shipmentInput[ck]) shipmentInput[ck] = {};
        (row.recipients || []).forEach(r => {
          shipmentInput[ck][r.recipientId] = (shipmentInput[ck][r.recipientId] || 0) + r.qty;
        });
      });
    }
    renderShipmentPanel();
  });
  toolbar.appendChild(resetBtn);
  wrap.appendChild(toolbar);

  // ── Фильтрация и сортировка ──────────────────────────────────────
  let rows = [...productRows];
  if (shipFilterCategory) rows = rows.filter(r => r.category === shipFilterCategory);
  if (shipFilterSearch) {
    const q = shipFilterSearch.toLowerCase();
    rows = rows.filter(r =>
      (r.displayName || r.productName).toLowerCase().includes(q) ||
      r.productCode.toLowerCase().includes(q) ||
      r.category.toLowerCase().includes(q)
    );
  }
  const dir = shipSortDir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    const va = a[shipSortCol] ?? '';
    const vb = b[shipSortCol] ?? '';
    if (shipSortCol === 'totalBalance') return (Number(va) - Number(vb)) * dir;
    return String(va).localeCompare(String(vb)) * dir;
  });

  if (rows.length === 0) {
    wrap.appendChild(el('p', { className: 'text-sm text-slate-500 py-8 text-center' }, 'Ничего не найдено'));
    return;
  }

  // Пересчитываем распределение
  recalcDistribution(rows, recipients);

  // ── Таблица ──────────────────────────────────────────────────────
  const tableWrap = el('div', {
    id: 'shipmentTableWrap',
    style: 'overflow-x:auto;overflow-y:auto;max-height:62vh;scrollbar-gutter:stable;border-radius:1rem;border:1px solid rgba(255,255,255,0.1);',
  });
  const table = el('table', { className: 'w-full text-xs text-slate-300 border-collapse' });

  // Заголовок
  const thead = el('thead', {});
  const hrow = el('tr', { className: 'border-b border-white/10 bg-slate-900/80' });

  const FIXED_COLS = [
    { key: 'category',      label: 'Категория',    cls: 'text-left min-w-[90px] sticky left-0 z-20 bg-slate-900' },
    { key: 'productName',   label: 'Наименование', cls: 'text-left min-w-[150px]' },
    { key: 'productCode',   label: 'Код',          cls: 'text-left whitespace-nowrap' },
    { key: 'totalBalance',  label: 'Наличие (по поставщикам)', cls: 'text-left min-w-[160px]' },
  ];

  FIXED_COLS.forEach(col => {
    const isActive = shipSortCol === col.key;
    const ind = isActive ? (shipSortDir === 'asc' ? ' ▲' : ' ▼') : '';
    const th = el('th', {
      className: 'px-3 py-2.5 font-semibold text-[11px] uppercase tracking-wide cursor-pointer select-none transition ' +
        (isActive ? 'text-cyan-400 ' : 'text-slate-400 hover:text-slate-200 ') + col.cls,
      title: 'Сортировать',
    }, col.label + ind);
    th.addEventListener('click', () => {
      if (shipSortCol === col.key) shipSortDir = shipSortDir === 'asc' ? 'desc' : 'asc';
      else { shipSortCol = col.key; shipSortDir = 'asc'; }
      renderShipmentPanel();
    });
    hrow.appendChild(th);
  });

  recipients.forEach(rec => {
    const recipientProgramLabel = rec.targetProgram
      ? formatProgramValueLabel(rec.targetProgram)
      : '';
    const th = el('th', {
      className: 'px-2 py-2.5 font-semibold text-[11px] uppercase tracking-wide text-slate-400 text-center min-w-[100px] max-w-[130px] whitespace-nowrap',
      title: (rec.name || '') + (rec.address ? '\n' + rec.address : '') + (recipientProgramLabel ? '\n🎯 ' + recipientProgramLabel : ''),
    });
    const nameSpan = el('span', { className: 'block truncate max-w-[120px]' });
    nameSpan.textContent = rec.name || '—';
    th.appendChild(nameSpan);
    if (recipientProgramLabel) {
      const prog = el('span', { className: 'block text-[9px] text-cyan-400/70 truncate max-w-[120px]' });
      prog.textContent = '🎯 ' + recipientProgramLabel;
      th.appendChild(prog);
    }
    if (rec.address) {
      const addr = el('span', { className: 'block text-[9px] text-slate-500 truncate max-w-[120px]' });
      addr.textContent = '📍 ' + rec.address;
      th.appendChild(addr);
    }
    hrow.appendChild(th);
  });

  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody', {});

  rows.forEach((prow, rowIdx) => {
    const tr = el('tr', {
      className: 'border-b border-white/5 transition ' + (rowIdx % 2 === 0 ? '' : 'bg-white/[0.015]') + ' hover:bg-white/[0.04]',
    });

    // Категория (sticky)
    const catTd = el('td', { className: 'px-3 py-2 text-slate-400 max-w-[100px] sticky left-0 z-10 bg-slate-950 border-r border-white/5' });
    catTd.appendChild(el('span', { className: 'block truncate text-xs', title: prow.category }, prow.category || '—'));
    tr.appendChild(catTd);

    // Наименование
    const nameTd = el('td', { className: 'px-3 py-2 max-w-[200px]' });
    nameTd.appendChild(el('span', { className: 'block font-medium text-white text-xs truncate', title: prow.displayName || prow.productName }, prow.displayName || prow.productName || '—'));
    tr.appendChild(nameTd);

    // Код
    tr.appendChild(el('td', { className: 'px-3 py-2 font-mono text-cyan-400 whitespace-nowrap text-xs' }, prow.productCode || '—'));

    // Наличие по поставщикам
    const balTd = el('td', {
      className: 'px-3 py-2 min-w-[160px]',
      id: 'ship-bal-' + prow.codeKey.replace(/[^a-z0-9]/g, '_'),
    });
    if (prow.stockBySupplier.length === 0) {
      balTd.appendChild(el('span', { className: 'text-slate-600 text-xs' }, '—'));
    } else {
      const stockWrap = el('div', { className: 'flex flex-col gap-0.5' });
      prow.stockBySupplier.forEach(({ name, balance }) => {
        const row2 = el('div', { className: 'flex items-center justify-between gap-2 whitespace-nowrap' });
        const nameSpan = el('span', {
          className: 'text-[10px] text-emerald-300 truncate max-w-[110px]',
          title: name,
        });
        nameSpan.textContent = name === '—' ? 'Без поставщика' : name;
        const qtySpan = el('span', {
          className: 'text-[11px] font-bold text-emerald-400 tabular-nums shrink-0',
          'data-supplier-bal': name,
          'data-supplier-orig': String(balance),
        });
        qtySpan.textContent = fmt(balance);
        row2.appendChild(nameSpan);
        row2.appendChild(qtySpan);
        stockWrap.appendChild(row2);
      });
      // Итого если >1 поставщика
      if (prow.stockBySupplier.length > 1) {
        const totalLine = el('div', { className: 'flex items-center justify-between gap-2 border-t border-white/10 pt-0.5 mt-0.5' });
        totalLine.appendChild(el('span', { className: 'text-[9px] text-slate-500 uppercase tracking-wide' }, 'Итого'));
        const totalQtySpan = el('span', {
          className: 'text-[11px] font-bold text-white tabular-nums shrink-0',
          id: 'ship-bal-total-' + prow.codeKey.replace(/[^a-z0-9]/g, '_'),
        });
        totalQtySpan.textContent = fmt(prow.totalBalance);
        totalLine.appendChild(totalQtySpan);
        stockWrap.appendChild(totalLine);
      }
      balTd.appendChild(stockWrap);
    }
    tr.appendChild(balTd);

    // Ячейки получателей
    recipients.forEach(rec => {
      const td = el('td', { className: 'px-1 py-1 text-center' });

      // Проверяем программу по всем слотам
      const programOk = prow.slots.some(slot => isProgramAllowed(slot.orderId, rec).allowed);
      if (!programOk) {
        const firstCheck = isProgramAllowed(prow.slots[0]?.orderId ?? null, rec);
        const blockedDiv = el('div', { className: 'flex flex-col items-center' });
        const blockedInp = el('input', {
          type: 'number', value: '0',
          className: 'w-16 rounded-lg border border-rose-500/30 bg-rose-500/[0.04] px-1 py-1 text-center text-xs text-slate-600 cursor-not-allowed tabular-nums',
          disabled: 'true',
          title: firstCheck.reason,
          'aria-label': 'Отгрузка заблокирована',
        });
        blockedDiv.appendChild(blockedInp);
        blockedDiv.appendChild(el('span', {
          className: 'text-[9px] text-rose-400/80 mt-0.5 whitespace-nowrap font-semibold',
          title: firstCheck.reason,
        }, '⛔ прогр.'));
        td.appendChild(blockedDiv);
        tr.appendChild(td);
        return;
      }

      // Потребность получателя
      const need = getRecipientNeed(
        rec,
        prow.productCode,
        prow.productName,
        prow.productId ?? null,
        prow.variantId || '',
        prow.colorCode || '',
      );
      const delivered = getRecipientDelivered(
        rec,
        prow.productCode,
        prow.productName,
        prow.productId ?? null,
        prow.variantId || '',
        prow.colorCode || '',
        editingShipmentId,
      );
      const maxByNeed = Math.max(0, need - delivered);
      const currentVal = (shipmentInput[prow.codeKey] || {})[rec.id] || 0;

      if (maxByNeed === 0 && currentVal === 0) {
        const blockedDiv = el('div', { className: 'flex flex-col items-center' });
        blockedDiv.appendChild(el('input', {
          type: 'number', value: '0',
          className: 'w-16 rounded-lg border border-white/5 bg-white/[0.02] px-1 py-1 text-center text-xs text-slate-600 cursor-not-allowed tabular-nums',
          disabled: 'true',
          title: 'Потребность исчерпана (потребность: ' + need + ', доставлено: ' + delivered + ')',
        }));
        if (need > 0) {
          blockedDiv.appendChild(el('span', { className: 'text-[9px] text-slate-500 mt-0.5 whitespace-nowrap' }, '✓ выдано'));
        }
        td.appendChild(blockedDiv);
        tr.appendChild(td);
        return;
      }

      const cellDiv = el('div', { className: 'flex flex-col items-center gap-0.5' });

      const inp = el('input', {
        type: 'number',
        min: '0',
        max: String(Math.min(maxByNeed, prow.totalBalance)),
        value: String(currentVal),
        className: 'w-16 rounded-lg border border-white/10 bg-white/5 px-1 py-1 text-center text-xs text-white tabular-nums transition focus:border-cyan-400/50 focus:outline-none focus:bg-white/[0.08]',
        'aria-label': 'Кол-во для ' + rec.name + ': ' + prow.productName,
        title: 'Потребность: ' + need + ' шт. | Доставлено: ' + delivered + ' шт. | Осталось: ' + maxByNeed + ' шт. | Наличие: ' + prow.totalBalance + ' шт.',
      });

      // Строка «остаток потребности»
      const needHint = el('span', { className: 'text-[9px] tabular-nums whitespace-nowrap ' + (currentVal > 0 ? 'text-cyan-400 font-semibold' : 'text-slate-500') });
      needHint.textContent = currentVal > 0 ? currentVal + ' / ' + maxByNeed : '/ ' + maxByNeed;

      // Блок распределения по заявкам (раскрывается после ввода)
      const distBlock = el('div', {
        className: 'w-full mt-0.5 rounded-md border border-cyan-400/15 bg-cyan-400/[0.04] px-1.5 py-1 text-[9px] text-slate-300' + (currentVal > 0 ? '' : ' hidden'),
        style: 'min-width:90px;max-width:140px;',
      });

      // Заполняем distBlock при начальном рендере если currentVal > 0
      if (currentVal > 0) {
        const initAllocs = (distributionResult[prow.codeKey] || {})[rec.id] || [];
        if (initAllocs.length > 0) {
          const uSuppliers = new Set(initAllocs.map(a => a.slot.supplierId));
          if (uSuppliers.size > 1) {
            const warnEl = el('div', { className: 'flex items-center gap-1 mb-1 text-amber-400 font-semibold' });
            warnEl.textContent = '⚠ Смешение поставщиков';
            distBlock.appendChild(warnEl);
          }
          initAllocs.forEach(a => {
            const line = el('div', { className: 'flex items-start gap-1 leading-tight py-0.5 border-b border-white/5 last:border-0' });
            const left = el('div', { className: 'flex flex-col min-w-0 flex-1' });
            const orderEl = el('span', { className: 'text-violet-300 font-semibold truncate', title: a.slot.orderNum || 'Без заявки' });
            orderEl.textContent = '📋 ' + (a.slot.orderNum || 'б/з');
            const suppEl = el('span', { className: 'text-[8px] text-emerald-300/80 truncate', title: a.slot.supplierName });
            suppEl.textContent = a.slot.supplierName !== '—' ? a.slot.supplierName : '';
            left.appendChild(orderEl);
            if (suppEl.textContent) left.appendChild(suppEl);
            const qtyEl = el('span', { className: 'text-white font-bold tabular-nums shrink-0 text-[10px]' });
            qtyEl.textContent = a.qty + ' шт.';
            line.appendChild(left);
            line.appendChild(qtyEl);
            distBlock.appendChild(line);
          });
        }
      }

      inp.addEventListener('change', () => {
        let val = Number(inp.value) || 0;
        if (val < 0) val = 0;
        if (val > maxByNeed) {
          val = maxByNeed;
          inp.style.borderColor = 'rgba(251,191,36,0.7)';
          setTimeout(() => { inp.style.borderColor = ''; }, 700);
        }
        inp.value = String(val);

        if (!shipmentInput[prow.codeKey]) shipmentInput[prow.codeKey] = {};
        if (val > 0) shipmentInput[prow.codeKey][rec.id] = val;
        else delete shipmentInput[prow.codeKey][rec.id];

        // Пересчитываем распределение для этого товара
        const alreadyTaken = new Map();
        for (const r2 of recipients) {
          if (r2.id === rec.id) break;
          const req2 = (shipmentInput[prow.codeKey] || {})[r2.id] || 0;
          if (req2 <= 0) continue;
          const { allocations: alloc2 } = autoDistribute(prow.slots, req2, r2, alreadyTaken);
          for (const { slot, qty } of alloc2) {
            alreadyTaken.set(slot.orderKey, (alreadyTaken.get(slot.orderKey) || 0) + qty);
          }
        }
        const { allocations, blocked } = autoDistribute(prow.slots, val, rec, alreadyTaken);
        if (!distributionResult[prow.codeKey]) distributionResult[prow.codeKey] = {};
        distributionResult[prow.codeKey][rec.id] = blocked ? [] : allocations;

        // Обновляем блок распределения по заявкам
        clearChildren(distBlock);
        if (val > 0 && allocations.length > 0) {
          distBlock.classList.remove('hidden');
          const uniqueSuppliers = new Set(allocations.map(a => a.slot.supplierId));
          if (uniqueSuppliers.size > 1) {
            const warnEl = el('div', { className: 'flex items-center gap-1 mb-1 text-amber-400 font-semibold' });
            warnEl.textContent = '⚠ Смешение поставщиков';
            distBlock.appendChild(warnEl);
          }
          allocations.forEach(a => {
            const line = el('div', { className: 'flex items-start gap-1 leading-tight py-0.5 border-b border-white/5 last:border-0' });
            const left = el('div', { className: 'flex flex-col min-w-0 flex-1' });
            const orderEl = el('span', { className: 'text-violet-300 font-semibold truncate', title: a.slot.orderNum || 'Без заявки' });
            orderEl.textContent = '📋 ' + (a.slot.orderNum || 'б/з');
            const suppEl = el('span', { className: 'text-[8px] text-emerald-300/80 truncate', title: a.slot.supplierName });
            suppEl.textContent = a.slot.supplierName !== '—' ? a.slot.supplierName : '';
            left.appendChild(orderEl);
            if (suppEl.textContent) left.appendChild(suppEl);
            const qtyEl = el('span', { className: 'text-white font-bold tabular-nums shrink-0 text-[10px]' });
            qtyEl.textContent = a.qty + ' шт.';
            line.appendChild(left);
            line.appendChild(qtyEl);
            distBlock.appendChild(line);
          });
          needHint.textContent = val + ' / ' + maxByNeed;
          needHint.className = 'text-[9px] tabular-nums whitespace-nowrap text-cyan-400 font-semibold';
        } else if (blocked) {
          distBlock.classList.remove('hidden');
          const blockedEl = el('div', { className: 'text-rose-400 font-semibold text-[9px]' });
          blockedEl.textContent = '⛔ ' + blocked.split('\n')[0];
          distBlock.appendChild(blockedEl);
          needHint.textContent = '⛔';
          needHint.className = 'text-[9px] text-rose-400 font-semibold';
        } else {
          distBlock.classList.add('hidden');
          needHint.textContent = '/ ' + maxByNeed;
          needHint.className = 'text-[9px] tabular-nums whitespace-nowrap text-slate-500';
        }

        // Обновляем баланс
        const totalUsed = Object.values(shipmentInput[prow.codeKey] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
        const newBal = prow.totalBalance - totalUsed;
        // Пересчитываем остаток по каждому поставщику с учётом распределения
        const usedBySupplier = new Map(); // supplierName -> used
        for (const [recId2, allocs] of Object.entries(distributionResult[prow.codeKey] || {})) {
          for (const { slot, qty } of (allocs || [])) {
            usedBySupplier.set(slot.supplierName, (usedBySupplier.get(slot.supplierName) || 0) + qty);
          }
        }
        // Обновляем строки поставщиков в ячейке
        const balCell = document.getElementById('ship-bal-' + prow.codeKey.replace(/[^a-z0-9]/g, '_'));
        if (balCell) {
          const stockRows = balCell.querySelectorAll('[data-supplier-bal]');
          stockRows.forEach(el2 => {
            const sName = el2.getAttribute('data-supplier-bal');
            const orig = Number(el2.getAttribute('data-supplier-orig') || 0);
            const used = usedBySupplier.get(sName) || 0;
            const rem = orig - used;
            el2.textContent = fmt(Math.max(0, rem));
            el2.className = 'text-[11px] font-bold tabular-nums shrink-0 ' + (rem < 0 ? 'text-rose-400' : 'text-emerald-400');
          });
          // Итого
          const totalEl = document.getElementById('ship-bal-total-' + prow.codeKey.replace(/[^a-z0-9]/g, '_'));
          if (totalEl) {
            totalEl.textContent = fmt(Math.max(0, newBal));
            totalEl.className = 'text-[11px] font-bold tabular-nums shrink-0 ' + (newBal < 0 ? 'text-rose-400' : 'text-white');
          }
        }
      });

      cellDiv.appendChild(inp);
      cellDiv.appendChild(needHint);
      cellDiv.appendChild(distBlock);
      td.appendChild(cellDiv);
      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  requestAnimationFrame(() => attachFrozenManager(table, 'shipment-grid'));

  // Итог
  const totalAllocated = Object.values(shipmentInput).reduce((s, recMap) =>
    s + Object.values(recMap).reduce((ss, v) => ss + (Number(v) || 0), 0), 0);
  if (totalAllocated > 0) {
    const totalRow = el('div', { className: 'mt-3 flex items-center gap-2 px-1' });
    totalRow.appendChild(el('span', { className: 'text-xs text-slate-400' }, 'Итого к отгрузке:'));
    totalRow.appendChild(el('span', { className: 'text-sm font-bold text-cyan-400 tabular-nums' }, fmt(totalAllocated) + ' шт.'));
    wrap.appendChild(totalRow);
  }
}

// ─── Helpers: потребности получателя ─────────────────────────────

function getRecipientNeed(recipient, productCode, productName, productId = null, variantId = '', colorCode = '') {
  return getRecipientNeedMetrics(recipient, {
    productId,
    productName,
    contractCode: productCode,
    variantId,
    colorCode,
  }).qty;
}

function getRecipientDelivered(recipient, productCode, productName, productId = null, variantId = '', colorCode = '', editingShipmentId = null) {
  let delivered = getRecipientNeedMetrics(recipient, {
    productId,
    productName,
    contractCode: productCode,
    variantId,
    colorCode,
  }).delivered;

  if (editingShipmentId != null) {
    const shipment = getShipments().find(s => s.id === editingShipmentId);
    if (shipment) {
      const codeKey = (productCode || '').trim().toLowerCase() || (productName || '').trim().toLowerCase();
      for (const row of (shipment.rows || [])) {
        if (row.codeKey !== codeKey) continue;
        const sameVariant = String(row.variantId || '').trim().toLowerCase() === String(variantId || '').trim().toLowerCase()
          || (!variantId && !row.variantId);
        if (!sameVariant) continue;
        const recEntry = (row.recipients || []).find(r => r.recipientId === recipient.id);
        if (recEntry) delivered = Math.max(0, delivered - (Number(recEntry.qty) || 0));
      }
    }
  }
  return delivered;
}

// ─── Save shipment ────────────────────────────────────────────────

export async function saveShipment() {
  const totalAllocated = Object.values(shipmentInput).reduce((s, recMap) =>
    s + Object.values(recMap).reduce((ss, v) => ss + (Number(v) || 0), 0), 0);

  if (totalAllocated === 0) {
    showToast('Введите количество для отгрузки', 'error');
    return;
  }

  const isEdit = editingShipmentId != null;
  const oldShipment = isEdit ? getShipments().find(s => s.id === editingShipmentId) || null : null;

  // Откатываем старую отгрузку
  if (isEdit && oldShipment) {
    for (const row of (oldShipment.rows || [])) {
      const rowTotal = (row.recipients || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
      if (rowTotal <= 0) continue;
      // Ищем warehouseEntry по orderKey
      const ok = row.orderKey || (row.codeKey + '::noorder');
      const parts = ok.split('::');
      const orderId = parts[1] && parts[1] !== 'noorder' ? Number(parts[1]) : null;
      // Находим записи склада, которые поставляли этот товар
      const entries = getWarehouseEntries().filter(e =>
        (orderId ? e.orderId === orderId : !e.orderId) &&
        (e.items || []).some(i => {
          const c = (i.productCode || '').trim().toLowerCase();
          const n = (i.productName || '').trim().toLowerCase();
          return c === row.codeKey || n === row.codeKey;
        })
      );
      // Возвращаем shipped обратно
      let remaining = rowTotal;
      for (const entry of entries) {
        if (remaining <= 0) break;
        const revert = Math.min(remaining, entry.shipped || 0);
        if (revert > 0) {
          const e = state.warehouseEntries.find(x => x.id === entry.id);
          if (e) e.shipped = Math.max(0, e.shipped - revert);
          remaining -= revert;
        }
      }
    }
  }

  // Получаем свежие слоты (без исключения старой отгрузки — уже откатили)
  const slotMap = buildStockSlots(null);
  const productRows = buildProductRows(slotMap);
  const recipients = (state.recipients || []).filter(r => r.id);

  // Пересчитываем финальное распределение
  const finalDist = {}; // codeKey -> recId -> [{slot, qty}]
  for (const prow of productRows) {
    finalDist[prow.codeKey] = {};
    const alreadyTaken = new Map();
    for (const rec of recipients) {
      const requested = (shipmentInput[prow.codeKey] || {})[rec.id] || 0;
      if (requested <= 0) { finalDist[prow.codeKey][rec.id] = []; continue; }
      const { allocations } = autoDistribute(prow.slots, requested, rec, alreadyTaken);
      finalDist[prow.codeKey][rec.id] = allocations;
      for (const { slot, qty } of allocations) {
        alreadyTaken.set(slot.orderKey, (alreadyTaken.get(slot.orderKey) || 0) + qty);
      }
    }
  }

  // Применяем shipped к warehouseEntries
  // Сначала собираем: entryId -> addShipped
  const entryShipMap = new Map();
  for (const [codeKey, recMap] of Object.entries(finalDist)) {
    for (const allocations of Object.values(recMap)) {
      for (const { slot, qty } of allocations) {
        // Находим конкретные записи по entryIds слота
        for (const entryId of slot.entryIds) {
          // Берём пропорционально — FIFO внутри слота
          entryShipMap.set(entryId, (entryShipMap.get(entryId) || 0) + qty);
          break; // упрощение: добавляем к первой записи слота
        }
      }
    }
  }

  // Более корректный FIFO внутри слота: берём из записей последовательно
  // Сбрасываем и пересчитываем
  const entryShipMapFinal = new Map();
  for (const [codeKey, recMap] of Object.entries(finalDist)) {
    const prow = productRows.find(r => r.codeKey === codeKey);
    if (!prow) continue;

    // Для каждого слота — суммарное кол-во
    const slotTotals = new Map(); // orderKey -> total qty
    for (const allocations of Object.values(recMap)) {
      for (const { slot, qty } of allocations) {
        slotTotals.set(slot.orderKey, (slotTotals.get(slot.orderKey) || 0) + qty);
      }
    }

    // Применяем FIFO по entryIds внутри слота
    for (const slot of prow.slots) {
      const total = slotTotals.get(slot.orderKey) || 0;
      if (total <= 0) continue;
      let remaining = total;
      for (const entryId of slot.entryIds) {
        if (remaining <= 0) break;
        const entry = state.warehouseEntries.find(e => e.id === entryId);
        if (!entry) continue;
        const items = Array.isArray(entry.items) ? entry.items : [];
        const itemQty = items.reduce((s, i) => {
          const c = (i.productCode || '').trim().toLowerCase();
          const n = (i.productName || '').trim().toLowerCase();
          return (c === codeKey || n === codeKey) ? s + (Number(i.qty) || 0) : s;
        }, 0);
        const avail = Math.max(0, itemQty - (entry.shipped || 0));
        const take = Math.min(remaining, avail);
        if (take > 0) {
          entryShipMapFinal.set(entryId, (entryShipMapFinal.get(entryId) || 0) + take);
          remaining -= take;
        }
      }
    }
  }

  entryShipMapFinal.forEach((addShipped, entryId) => {
    const entry = state.warehouseEntries.find(e => e.id === entryId);
    if (entry) entry.shipped = (entry.shipped || 0) + addShipped;
  });

  // Строим строки отгрузки: группируем по (codeKey, orderId)
  const shipmentRows = [];
  // Собираем: codeKey -> orderKey -> { slot, recipients: [{id, name, qty}] }
  const rowsByOrderKey = new Map(); // `${codeKey}::${orderKey}` -> row

  for (const [codeKey, recMap] of Object.entries(finalDist)) {
    const prow = productRows.find(r => r.codeKey === codeKey);
    if (!prow) continue;
    for (const [recIdStr, allocations] of Object.entries(recMap)) {
      const recId = Number(recIdStr);
      const rec = recipients.find(r => r.id === recId);
      if (!rec) continue;
      for (const { slot, qty } of allocations) {
        if (qty <= 0) continue;
        const rowKey = codeKey + '|||' + slot.orderKey;
        if (!rowsByOrderKey.has(rowKey)) {
          rowsByOrderKey.set(rowKey, {
            orderKey: slot.orderKey,
            codeKey,
            productCode: prow.productCode,
            productName: prow.productName,
            displayName: prow.displayName || prow.productName,
            productId: slot.productId ?? prow.productId ?? null,
            variantId: slot.variantId || prow.variantId || '',
            colorCode: slot.colorCode || prow.colorCode || '',
            category: prow.category,
            orderId: slot.orderId,
            orderNum: slot.orderNum,
            supplierId: slot.supplierId,
            supplierName: slot.supplierName,
            recipients: [],
            rowTotal: 0,
          });
        }
        const rowObj = rowsByOrderKey.get(rowKey);
        const existing = rowObj.recipients.find(r => r.recipientId === recId);
        if (existing) existing.qty += qty;
        else rowObj.recipients.push({ recipientId: recId, recipientName: rec.name || '—', qty });
        rowObj.rowTotal += qty;
      }
    }
  }

  // Также добавляем строки для получателей без распределения по слотам (если ввели кол-во, но слоты не нашлись)
  // (это редкий случай при редактировании)

  const shipmentData = {
    date: isEdit ? (oldShipment?.date || new Date().toISOString().slice(0, 10)) : new Date().toISOString().slice(0, 10),
    rows: [...rowsByOrderKey.values()],
    totalQty: totalAllocated,
    note: oldShipment?.note || '',
  };

  if (isEdit) {
    updateShipment(editingShipmentId, shipmentData);
  } else {
    addShipment(shipmentData);
  }

  recalcAllDelivered();
  await saveToStorage();
  showToast((isEdit ? 'Отгрузка обновлена: ' : 'Отгрузка сохранена: ') + fmt(totalAllocated) + ' шт.', 'success');

  editingShipmentId = null;
  shipmentInput = {};
  distributionResult = {};
  $('warehouseShipmentPanel')?.classList.add('hidden');
  showShipmentsRegistry();
}

// ─── Excel export (разнарядка) ────────────────────────────────────

export function exportShipmentToExcel() {
  if (typeof XLSX === 'undefined') {
    showToast('Модуль Эксель ещё загружается, попробуйте снова', 'error');
    return;
  }
  const existingShipment = editingShipmentId != null
    ? getShipments().find(s => s.id === editingShipmentId) || null
    : null;
  const slotMap = buildStockSlots(existingShipment);
  let productRows = buildProductRows(slotMap);
  const recipients = (state.recipients || []).filter(r => r.id);

  if (shipFilterCategory) productRows = productRows.filter(r => r.category === shipFilterCategory);
  if (shipFilterSearch) {
    const q = shipFilterSearch.toLowerCase();
    productRows = productRows.filter(r =>
      r.productName.toLowerCase().includes(q) || r.productCode.toLowerCase().includes(q)
    );
  }

  if (productRows.length === 0) { showToast('Нет данных для экспорта', 'error'); return; }

  const headers = [
    'Категория', 'Наименование', 'Код', 'Поставщик(и)', 'Наличие на складе',
    ...recipients.map(r => r.name + (r.address ? ' (' + r.address + ')' : '')),
    'Итого к отгрузке',
  ];

  const data = productRows.map(r => {
    const recipientVals = recipients.map(rec => (shipmentInput[r.codeKey] || {})[rec.id] || 0);
    const rowTotal = recipientVals.reduce((s, v) => s + v, 0);
    const totalUsed = Object.values(shipmentInput[r.codeKey] || {}).reduce((s, v) => s + (Number(v) || 0), 0);
    return [r.category, r.displayName || r.productName, r.productCode, r.supplierNames.join(', ') || '—',
      r.totalBalance - totalUsed, ...recipientVals, rowTotal];
  });

  const totalRow = ['ИТОГО', '', '', '', '', ...recipients.map((_, i) =>
    productRows.reduce((s, r) => s + ((shipmentInput[r.codeKey] || {})[recipients[i].id] || 0), 0)
  ), productRows.reduce((s, r) =>
    s + Object.values(shipmentInput[r.codeKey] || {}).reduce((ss, v) => ss + (Number(v) || 0), 0), 0)
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data, totalRow]);
  ws['!cols'] = [16, 32, 14, 20, 14, ...recipients.map(() => 18), 16].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Разнарядка');
  XLSX.writeFile(wb, 'Разнарядка_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('Разнарядка экспортирована', 'success');
}

// ─── Shipments registry ───────────────────────────────────────────

function buildShipmentDetailTable(shipment) {
  const rows = shipment.rows || [];

  const recipientMap = new Map();
  rows.forEach(row => {
    (row.recipients || []).forEach(r => {
      if (!recipientMap.has(r.recipientId)) recipientMap.set(r.recipientId, r.recipientName || '—');
    });
  });

  const recipientIds = [...recipientMap.keys()];
  if (recipientIds.length === 0) return el('div', {});

  const container = el('div', { className: 'flex flex-col gap-3' });

  recipientIds.forEach(recId => {
    const recName = recipientMap.get(recId);
    const recRows = [];
    rows.forEach(row => {
      const recEntry = (row.recipients || []).find(r => r.recipientId === recId);
      if (!recEntry || !recEntry.qty || recEntry.qty <= 0) return;
      const supplierMeta = resolveShipmentRowSupplier(row);
      recRows.push({
        category:     row.category     || '',
        productName:  row.displayName || row.productName || '—',
        productCode:  row.productCode  || '',
        orderNum:     row.orderNum     || null,
        supplierName: supplierMeta.supplierName || '—',
        qty:          Number(recEntry.qty),
      });
    });
    if (recRows.length === 0) return;

    const block = el('div', { className: 'rounded-xl border border-white/10 overflow-hidden' });
    const recHeader = el('div', { className: 'flex items-center gap-2 px-3 py-2 bg-slate-800/60 border-b border-white/10' });
    recHeader.appendChild(el('span', { className: 'text-xs' }, '🏫'));
    const recNameEl = el('span', { className: 'text-xs font-semibold text-slate-200 truncate' });
    recNameEl.textContent = recName;
    recHeader.appendChild(recNameEl);
    const recTotal = recRows.reduce((s, r) => s + r.qty, 0);
    const recTotalBadge = el('span', { className: 'ml-auto text-xs font-bold text-cyan-400 tabular-nums shrink-0' });
    recTotalBadge.textContent = fmt(recTotal) + ' шт.';
    recHeader.appendChild(recTotalBadge);
    block.appendChild(recHeader);

    const tbl = el('table', { className: 'w-full text-xs' });
    const thead = el('thead', {});
    const hr = el('tr', { className: 'border-b border-white/[0.07] bg-slate-900/40' });
    [
      { label: 'Наименование', cls: 'text-left min-w-[120px]' },
      { label: 'Код',          cls: 'text-left whitespace-nowrap' },
      { label: 'Заявка',       cls: 'text-left whitespace-nowrap min-w-[100px]' },
      { label: 'Поставщик',    cls: 'text-left min-w-[100px]' },
      { label: 'Кол-во',       cls: 'text-right whitespace-nowrap' },
    ].forEach(h => {
      const th = el('th', { className: `px-3 py-1.5 font-semibold text-[10px] uppercase tracking-wide text-slate-500 ${h.cls}` });
      th.textContent = h.label;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);

    const tbody = el('tbody', {});
    recRows.forEach((row, ri) => {
      const tr = el('tr', {
        className: 'border-b border-white/[0.05] ' + (ri % 2 === 0 ? '' : 'bg-white/[0.012]') + ' hover:bg-white/[0.03] transition',
      });
      const nameTd = el('td', { className: 'px-3 py-1.5 font-medium text-white max-w-[200px]' });
      nameTd.appendChild(el('span', { className: 'block truncate', title: row.productName }, row.productName));
      tr.appendChild(nameTd);
      tr.appendChild(el('td', { className: 'px-3 py-1.5 font-mono text-cyan-400 whitespace-nowrap text-[11px]' }, row.productCode || '—'));

      const orderTd = el('td', { className: 'px-3 py-1.5 whitespace-nowrap' });
      if (row.orderNum) {
        const badge = el('span', { className: 'inline-flex items-center gap-1 rounded-md bg-violet-400/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300' });
        badge.textContent = '📋 ' + row.orderNum;
        orderTd.appendChild(badge);
      } else {
        orderTd.appendChild(el('span', { className: 'text-slate-600' }, '—'));
      }
      tr.appendChild(orderTd);

      const supplierTd = el('td', { className: 'px-3 py-1.5 text-[11px] text-emerald-300' });
      supplierTd.textContent = row.supplierName || '—';
      tr.appendChild(supplierTd);

      tr.appendChild(el('td', { className: 'px-3 py-1.5 text-right font-bold text-white tabular-nums whitespace-nowrap' }, fmt(row.qty) + ' шт.'));
      tbody.appendChild(tr);
    });

    const totalTr = el('tr', { className: 'border-t border-white/10 bg-slate-800/30' });
    totalTr.appendChild(el('td', { className: 'px-3 py-1.5 text-xs font-semibold text-slate-400', colspan: '4' }, 'Итого'));
    totalTr.appendChild(el('td', { className: 'px-3 py-1.5 text-right text-xs font-bold text-cyan-400 tabular-nums' }, fmt(recTotal) + ' шт.'));
    tbody.appendChild(totalTr);
    tbl.appendChild(tbody);
    block.appendChild(tbl);
    container.appendChild(block);
  });

  if (recipientIds.length > 1) {
    const totalAll = rows.reduce((s, row) =>
      s + (row.recipients || []).reduce((ss, r) => ss + (Number(r.qty) || 0), 0), 0);
    const totalRow = el('div', { className: 'flex items-center justify-between px-3 py-2 rounded-xl border border-white/10 bg-white/[0.04]' });
    totalRow.appendChild(el('span', { className: 'text-xs font-semibold text-slate-400' }, 'Итого по отгрузке'));
    totalRow.appendChild(el('span', { className: 'text-sm font-bold text-cyan-400 tabular-nums' }, fmt(totalAll) + ' шт.'));
    container.appendChild(totalRow);
  }

  return container;
}

function renderShipmentsRegistry() {
  const wrap = $('warehouseShipmentsRegistryWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const shipments = [...getShipments()].sort((a, b) => {
    const da = a.date || a.createdAt || '';
    const db = b.date || b.createdAt || '';
    return db.localeCompare(da);
  });

  if (shipments.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '🚚'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' }, 'Отгрузок пока нет'));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' }, 'Создайте отгрузку через «Новая отгрузка»'));
    wrap.appendChild(empty);
    return;
  }

  const totalAll = shipments.reduce((s, sh) => s + (sh.totalQty || 0), 0);
  const summaryRow = el('div', { className: 'flex items-center gap-4 px-1 mb-1' });
  summaryRow.appendChild(el('span', { className: 'text-[10px] uppercase tracking-wider text-slate-500' }, 'Всего отгрузок:'));
  summaryRow.appendChild(el('span', { className: 'text-sm font-bold text-cyan-400 tabular-nums' }, String(shipments.length)));
  summaryRow.appendChild(el('span', { className: 'text-[10px] uppercase tracking-wider text-slate-500 ml-3' }, 'Итого шт.:'));
  summaryRow.appendChild(el('span', { className: 'text-sm font-bold text-emerald-400 tabular-nums' }, fmt(totalAll)));
  wrap.appendChild(summaryRow);

  shipments.forEach(shipment => {
    const sid = shipment.id;
    const isCollapsed = collapsedShipments.has(sid);

    const card = el('div', { className: 'rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden transition' });

    const header = el('div', {
      className: 'flex items-center gap-2 px-4 py-3 cursor-pointer select-none hover:bg-white/[0.03] transition',
      role: 'button', tabindex: '0',
      'aria-expanded': isCollapsed ? 'false' : 'true',
    });

    const arrow = el('span', { className: 'text-slate-400 text-xs transition-transform shrink-0 w-4 text-center' });
    arrow.textContent = isCollapsed ? '▶' : '▼';
    header.appendChild(arrow);

    const info = el('div', { className: 'flex items-center gap-3 min-w-0 flex-1' });
    const dateSpan = el('span', { className: 'text-xs font-semibold text-cyan-400 tabular-nums whitespace-nowrap' });
    dateSpan.textContent = '📅 ' + fmtDate(shipment.date);
    info.appendChild(dateSpan);
    const totalSpan = el('span', { className: 'text-sm font-bold text-white whitespace-nowrap' });
    totalSpan.textContent = fmt(shipment.totalQty) + ' шт.';
    info.appendChild(totalSpan);

    const recMap = new Map();
    (shipment.rows || []).forEach(row => {
      (row.recipients || []).forEach(r => {
        if (!recMap.has(r.recipientId)) recMap.set(r.recipientId, r.recipientName || '—');
      });
    });
    if (recMap.size > 0) {
      const recNames = [...recMap.values()].slice(0, 3).join(', ') + (recMap.size > 3 ? ` +${recMap.size - 3}` : '');
      const recSpan = el('span', { className: 'text-xs text-slate-400 truncate min-w-0' });
      recSpan.textContent = '👥 ' + recNames;
      info.appendChild(recSpan);
    }
    const supplierNames = getShipmentSupplierNames(shipment);
    if (supplierNames.length > 0) {
      const suppliersShort = supplierNames.slice(0, 2).join(', ') + (supplierNames.length > 2 ? ` +${supplierNames.length - 2}` : '');
      const supplierSpan = el('span', {
        className: 'text-xs text-emerald-300/90 truncate min-w-0',
        title: supplierNames.join(', '),
      });
      supplierSpan.textContent = '🏢 ' + suppliersShort;
      info.appendChild(supplierSpan);
    }
    if (shipment.updatedAt) {
      const updSpan = el('span', { className: 'text-[10px] text-slate-500 whitespace-nowrap shrink-0' });
      updSpan.textContent = '✏ ' + fmtDate(shipment.updatedAt.slice(0, 10));
      info.appendChild(updSpan);
    }
    header.appendChild(info);

    const actions = el('div', { className: 'flex gap-1.5 shrink-0 items-center' });

    const editBtn = el('button', {
      type: 'button',
      className: 'inline-flex items-center gap-1 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-400/20 transition',
      'aria-label': 'Редактировать отгрузку',
    });
    editBtn.appendChild(el('span', {}, '✎'));
    editBtn.appendChild(el('span', {}, 'Изменить'));
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      shipFilterSearch = ''; shipFilterCategory = '';
      showShipmentPanel(shipment);
    });
    actions.appendChild(editBtn);

    const exportBtn = el('button', {
      type: 'button',
      className: 'inline-flex items-center gap-1 rounded-xl border border-white/15 bg-white/5 px-2.5 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/10 hover:text-white transition',
      'aria-label': 'Выгрузить в Эксель',
    });
    exportBtn.appendChild(el('span', {}, '📥'));
    exportBtn.appendChild(el('span', {}, 'Эксель'));
    exportBtn.addEventListener('click', (e) => { e.stopPropagation(); exportShipmentRecordToExcel(shipment); });
    actions.appendChild(exportBtn);

    const delBtn = el('button', {
      type: 'button',
      className: 'rounded-xl border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': 'Удалить отгрузку',
    });
    delBtn.textContent = '✕';
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirmDeleteWithImpact({
        title: 'Удалить запись об отгрузке?',
        subject: `${fmtDate(shipment.date)} · ${fmt(shipment.totalQty)} шт.`,
        impacts: [
          'запись будет удалена из реестра отгрузок',
        ],
        recalculations: [
          'поля «Доставлено» у получателей будут пересчитаны',
          'история поставок, карточки контрактов и поставщиков обновятся',
        ],
      })) return;
      collapsedShipments.delete(sid);
      deleteShipment(sid);
      await saveToStorage();
      showToast('Запись удалена', 'success');
      renderShipmentsRegistry();
    });
    actions.appendChild(delBtn);
    header.appendChild(actions);

    function toggleCollapse() {
      if (collapsedShipments.has(sid)) {
        collapsedShipments.delete(sid);
        body.style.display = '';
        arrow.textContent = '▼';
        header.setAttribute('aria-expanded', 'true');
      } else {
        collapsedShipments.add(sid);
        body.style.display = 'none';
        arrow.textContent = '▶';
        header.setAttribute('aria-expanded', 'false');
      }
    }
    header.addEventListener('click', toggleCollapse);
    header.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCollapse(); } });
    card.appendChild(header);

    const body = el('div', { className: 'border-t border-white/[0.07] px-4 py-3' });
    if (isCollapsed) body.style.display = 'none';
    if (Array.isArray(shipment.rows) && shipment.rows.length > 0) {
      body.appendChild(buildShipmentDetailTable(shipment));
    } else {
      body.appendChild(el('p', { className: 'text-xs text-slate-500 py-2' }, 'Нет данных о товарах'));
    }
    card.appendChild(body);
    wrap.appendChild(card);
  });
}

function exportShipmentRecordToExcel(shipment) {
  if (typeof XLSX === 'undefined') { showToast('Модуль Эксель ещё загружается', 'error'); return; }
  if (!Array.isArray(shipment.rows) || shipment.rows.length === 0) { showToast('Нет данных', 'error'); return; }

  const recMap = new Map();
  shipment.rows.forEach(row => {
    (row.recipients || []).forEach(r => {
      if (!recMap.has(r.recipientId)) recMap.set(r.recipientId, r.recipientName);
    });
  });
  const recIds = [...recMap.keys()];
  const recNames = recIds.map(id => recMap.get(id));

  const headers = ['Дата', 'Категория', 'Наименование', 'Код', 'Заявка', 'Поставщик', ...recNames, 'Итого'];
  const data = shipment.rows.map(row => {
    const supplierMeta = resolveShipmentRowSupplier(row);
    const recQtys = recIds.map(id => {
      const r = (row.recipients || []).find(x => x.recipientId === id);
      return r ? r.qty : 0;
    });
    return [fmtDate(shipment.date), row.category || '', row.displayName || row.productName || '', row.productCode || '',
      row.orderNum || '—', supplierMeta.supplierName || '—', ...recQtys, row.rowTotal || 0];
  });

  const totalRow = ['ИТОГО', '', '', '', '', '',
    ...recIds.map(id => shipment.rows.reduce((s, row) => {
      const r = (row.recipients || []).find(x => x.recipientId === id);
      return s + (r ? r.qty : 0);
    }, 0)),
    shipment.totalQty || 0,
  ];

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([headers, ...data, totalRow]);
  ws['!cols'] = [12, 16, 32, 14, 16, 20, ...recNames.map(() => 18), 14].map(w => ({ wch: w }));
  XLSX.utils.book_append_sheet(wb, ws, 'Отгрузка');
  XLSX.writeFile(wb, 'Отгрузка_' + (shipment.date || 'unknown') + '.xlsx');
  showToast('Отгрузка экспортирована', 'success');
}

// ─── Init ─────────────────────────────────────────────────────────

export function initShipmentView() {
  $('warehouseShipmentBackBtn')?.addEventListener('click', () => {
    editingShipmentId = null;
    shipmentInput = {};
    distributionResult = {};
    $('warehouseShipmentPanel')?.classList.add('hidden');
    showShipmentsRegistry();
  });
  $('warehouseShipmentSaveBtn')?.addEventListener('click', saveShipment);
  $('warehouseShipmentExportBtn')?.addEventListener('click', exportShipmentToExcel);
  $('warehouseShipmentsRegistryBackBtn')?.addEventListener('click', hideShipmentsRegistry);
  $('warehouseShipmentsRegistryCloseBtn')?.addEventListener('click', hideShipmentsRegistry);

  const exportAllBtn = document.getElementById('warehouseShipmentsExportAllBtn');
  if (exportAllBtn) exportAllBtn.addEventListener('click', exportAllShipmentsToExcel);
}

function exportAllShipmentsToExcel() {
  if (typeof XLSX === 'undefined') { showToast('Модуль Эксель ещё загружается', 'error'); return; }
  try {
    const allShipments = getShipments();
    if (!allShipments || allShipments.length === 0) { showToast('Нет данных для экспорта', 'error'); return; }

    const shipments = [...allShipments].sort((a, b) => (a.date || '').localeCompare(b.date || ''));
    const wb = XLSX.utils.book_new();

    const summaryHeaders = ['Дата отгрузки', 'Категория', 'Наименование товара', 'Код товара', 'Заявка', 'Поставщик', 'Получатель', 'Кол-во'];
    const summaryData = [];
    shipments.forEach(shipment => {
      (shipment.rows || []).forEach(row => {
        (row.recipients || []).forEach(r => {
          const qty = Number(r.qty) || 0;
          if (qty <= 0) return;
          const supplierMeta = resolveShipmentRowSupplier(row);
          summaryData.push([fmtDate(shipment.date), row.category || '', row.displayName || row.productName || '',
            row.productCode || '', row.orderNum || '—', supplierMeta.supplierName || '—', r.recipientName || '—', qty]);
        });
      });
    });

    if (summaryData.length === 0) { showToast('Нет строк для экспорта', 'error'); return; }
    const summaryTotal = summaryData.reduce((s, r) => s + (Number(r[7]) || 0), 0);
    summaryData.push(['ИТОГО', '', '', '', '', '', '', summaryTotal]);

    const wsSummary = XLSX.utils.aoa_to_sheet([summaryHeaders, ...summaryData]);
    wsSummary['!cols'] = [14, 18, 34, 14, 18, 20, 28, 10].map(w => ({ wch: w }));
    XLSX.utils.book_append_sheet(wb, wsSummary, 'Сводный реестр');

    const usedNames = new Set(['Сводный реестр']);
    shipments.forEach((shipment, idx) => {
      if (!Array.isArray(shipment.rows) || shipment.rows.length === 0) return;
      const recMap = new Map();
      shipment.rows.forEach(row => {
        (row.recipients || []).forEach(r => { if (!recMap.has(r.recipientId)) recMap.set(r.recipientId, r.recipientName || '—'); });
      });
      const recIds = [...recMap.keys()];
      const recNames = recIds.map(id => recMap.get(id));

      const headers = ['Дата', 'Категория', 'Наименование', 'Код', 'Заявка', 'Поставщик', ...recNames, 'Итого'];
      const data = shipment.rows.map(row => {
        const supplierMeta = resolveShipmentRowSupplier(row);
        const recQtys = recIds.map(id => { const r = (row.recipients || []).find(x => x.recipientId === id); return Number(r ? (r.qty || 0) : 0); });
        return [fmtDate(shipment.date), row.category || '', row.displayName || row.productName || '', row.productCode || '',
          row.orderNum || '—', supplierMeta.supplierName || '—', ...recQtys, recQtys.reduce((s, v) => s + v, 0)];
      });
      const totalRow = ['ИТОГО', '', '', '', '', '',
        ...recIds.map(id => shipment.rows.reduce((s, row) => { const r = (row.recipients || []).find(x => x.recipientId === id); return s + Number(r ? (r.qty || 0) : 0); }, 0)),
        shipment.rows.reduce((s, row) => s + (row.recipients || []).reduce((ss, r) => ss + Number(r.qty || 0), 0), 0),
      ];

      const ws = XLSX.utils.aoa_to_sheet([headers, ...data, totalRow]);
      ws['!cols'] = [12, 16, 32, 14, 16, 20, ...recNames.map(() => 18), 14].map(w => ({ wch: w }));
      let sheetName = ('Отгр_' + (shipment.date || String(idx + 1))).slice(0, 31);
      if (usedNames.has(sheetName)) sheetName = (sheetName.slice(0, 28) + '_' + idx).slice(0, 31);
      usedNames.add(sheetName);
      XLSX.utils.book_append_sheet(wb, ws, sheetName);
    });

    XLSX.writeFile(wb, 'Реестр_отгрузок_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    showToast('Реестр отгрузок экспортирован (' + shipments.length + ' отгрузок)', 'success');
  } catch (err) {
    console.error('exportAllShipmentsToExcel error:', err);
    showToast('Ошибка экспорта: ' + (err.message || String(err)), 'error');
  }
}
