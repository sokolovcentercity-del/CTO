/**
 * Direct deliveries view.
 * Логистика → Прямые поставки
 *
 * Сценарий:
 *  1. Пользователь выбирает поставщика.
 *  2. Выбирает прямую заявку этого поставщика.
 *  3. Получает разнарядку из order.deliveryRows.
 *  4. Вводит фактически поставленное количество.
 *  5. Сохраняет факт поставки в отдельный реестр directDeliveries.
 */

import { $, el, clearChildren, confirmDeleteWithImpact } from './dom.js';
import {
  state,
  addDirectDelivery,
  updateDirectDelivery,
  deleteDirectDelivery,
  getDirectDeliveryById,
  recalcAllDelivered,
} from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

let initialized = false;
let editingDeliveryId = null;
let currentSupplierId = null;
let currentOrderId = null;
let currentRows = [];
let currentRowsOrderId = null;
let cardViewState = {
  addressQuery: '',
  productQuery: '',
  groupBy: 'none',
};

function normalize(value) {
  return String(value || '').trim().toLowerCase();
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('ru-RU');
  } catch {
    return value;
  }
}

function fmtMoney(value) {
  return Number(value || 0).toLocaleString('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function fmtQty(value) {
  return Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function hideLogisticsPanels() {
  [
    'whLocationsListPanel',
    'whLocationCardPanel',
    'warehouseHomePanel',
    'warehouseListPanel',
    'warehouseCardPanel',
    'warehouseImportPanel',
    'warehouseStockPanel',
    'warehouseShipmentPanel',
    'warehouseShipmentsRegistryPanel',
    'directDeliveriesRegistryPanel',
    'directDeliveryCardPanel',
  ].forEach(id => document.getElementById(id)?.classList.add('hidden'));
}

function showRegistryPanel() {
  hideLogisticsPanels();
  $('directDeliveriesRegistryPanel')?.classList.remove('hidden');
}

function showCardPanel() {
  hideLogisticsPanels();
  $('directDeliveryCardPanel')?.classList.remove('hidden');
}

function closeLogisticsModal() {
  $('warehouseModal')?.classList.remove('open');
  hideLogisticsPanels();
}

function getSupplierById(id) {
  return (state.suppliers || []).find(s => String(s.id) === String(id)) || null;
}

function getContractById(id) {
  return (state.contracts || []).find(c => String(c.id) === String(id)) || null;
}

function getOrderById(id) {
  return (state.orders || []).find(o => String(o.id) === String(id)) || null;
}

function getDirectOrdersForSupplier(supplierId) {
  return (state.orders || []).filter(order => {
    if (order.deliveryMode !== 'direct') return false;
    const contract = getContractById(order.contractId);
    return contract && String(contract.supplierId) === String(supplierId);
  });
}

function resolveCategory(productCode, productName) {
  const code = normalize(productCode);
  const name = normalize(productName);
  const byCode = code
    ? (state.products || []).find(p => normalize(p.code) === code)
    : null;
  if (byCode?.category) return byCode.category;
  const byName = name
    ? (state.products || []).find(p => normalize(p.name) === name)
    : null;
  return byName?.category || '';
}

function buildRowKey(row) {
  return [
    String(row.recipientId ?? ''),
    normalize(row.address || row.recipientAddress || ''),
    normalize(row.contractItemCode || row.productCode || ''),
    normalize(row.contractItemName || row.productName || ''),
  ].join('||');
}

function getAlreadyDeliveredMap(orderId, excludeDeliveryId = null) {
  const map = new Map();
  (state.directDeliveries || []).forEach(delivery => {
    if (String(delivery.orderId) !== String(orderId)) return;
    if (excludeDeliveryId != null && String(delivery.id) === String(excludeDeliveryId)) return;
    (delivery.rows || []).forEach(row => {
      const key = buildRowKey({
        recipientId: row.recipientId,
        address: row.recipientAddress || row.address,
        contractItemCode: row.productCode,
        contractItemName: row.productName,
      });
      map.set(key, (map.get(key) || 0) + (Number(row.actualQty) || 0));
    });
  });
  return map;
}

function buildRowsFromOrder(order, existingRows = [], excludeDeliveryId = null) {
  const grouped = new Map();
  const existingMap = new Map(
    (existingRows || []).map(row => [
      buildRowKey({
        recipientId: row.recipientId,
        address: row.recipientAddress,
        contractItemCode: row.productCode,
        contractItemName: row.productName,
      }),
      row,
    ])
  );
  const alreadyMap = getAlreadyDeliveredMap(order.id, excludeDeliveryId);

  (order.deliveryRows || []).forEach(row => {
    const key = buildRowKey(row);
    if (!grouped.has(key)) {
      grouped.set(key, {
        key,
        recipientId: row.recipientId ?? null,
        recipientName: row.recipientName || '—',
        recipientAddress: row.address || '',
        productCode: row.contractItemCode || '',
        productName: row.contractItemName || '—',
        category: resolveCategory(row.contractItemCode, row.contractItemName),
        price: Number(row.price) || 0,
        plannedQty: 0,
        deliveredBefore: 0,
        availableQty: 0,
        actualQty: 0,
      });
    }
    grouped.get(key).plannedQty += Number(row.qty) || 0;
  });

  return [...grouped.values()].map(row => {
    const existing = existingMap.get(row.key);
    const deliveredBefore = alreadyMap.get(row.key) || 0;
    const availableQty = Math.max(0, row.plannedQty - deliveredBefore);
    return {
      ...row,
      deliveredBefore,
      availableQty,
      actualQty: Number(existing?.actualQty) || 0,
    };
  }).filter(row => Number(row.plannedQty) > 0).sort((a, b) => {
    const recCmp = String(a.recipientName || '').localeCompare(String(b.recipientName || ''), 'ru');
    if (recCmp !== 0) return recCmp;
    return String(a.productName || '').localeCompare(String(b.productName || ''), 'ru');
  });
}

function getCardTotals() {
  return currentRows.reduce((acc, row) => {
    const actualQty = Number(row.actualQty) || 0;
    acc.qty += actualQty;
    acc.cost += actualQty * (Number(row.price) || 0);
    return acc;
  }, { qty: 0, cost: 0 });
}

function getEntriesTotals(entries) {
  return entries.reduce((acc, entry) => {
    const row = entry?.row || entry;
    const actualQty = Number(row?.actualQty) || 0;
    acc.qty += actualQty;
    acc.cost += actualQty * (Number(row?.price) || 0);
    return acc;
  }, { qty: 0, cost: 0 });
}

function getFilteredEntries() {
  const addressQuery = normalize(cardViewState.addressQuery);
  const productQuery = normalize(cardViewState.productQuery);

  return currentRows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) => {
      const addressOk = !addressQuery || normalize(row.recipientAddress).includes(addressQuery);
      const productOk = !productQuery
        || normalize(row.productName).includes(productQuery)
        || normalize(row.productCode).includes(productQuery);
      return addressOk && productOk;
    });
}

function getGroupValue(row, groupBy) {
  if (groupBy === 'address') return row.recipientAddress || '—';
  if (groupBy === 'product') return row.productName || row.productCode || '—';
  return '';
}

function buildVisibleGroups(entries) {
  if (cardViewState.groupBy === 'none') {
    return [{ key: 'all', label: '', entries }];
  }

  const groups = new Map();
  entries.forEach(entry => {
    const label = getGroupValue(entry.row, cardViewState.groupBy);
    const key = normalize(label) || '__empty__';
    if (!groups.has(key)) groups.set(key, { key, label, entries: [] });
    groups.get(key).entries.push(entry);
  });

  return [...groups.values()].sort((a, b) =>
    String(a.label || '').localeCompare(String(b.label || ''), 'ru')
  );
}

function renderGroupHeaderRow(group, colspan) {
  const totals = getEntriesTotals(group.entries);
  const subtitle = cardViewState.groupBy === 'address'
    ? tf('warehouse.directGroupAddress', 'Адрес')
    : tf('warehouse.directGroupProduct', 'Товар');

  return el('tr', { className: 'bg-slate-900/70' },
    el('td', {
      colspan: String(colspan),
      className: 'px-3 py-2.5 text-xs text-slate-300',
    },
      `${subtitle}: ${group.label || '—'} · ${tf('warehouse.directRowsCount', 'Строк')}: ${group.entries.length} · ${tf('warehouse.directActualQty', 'Факт')}: ${fmtQty(totals.qty)} шт. · ${tf('orders.colCost', 'Стоимость')}: ${fmtMoney(totals.cost)} ₽`
    )
  );
}

function updateCardTotalsUI() {
  const totals = getCardTotals();
  const summaryQtyEl = $('directDeliverySummaryQty');
  const summaryCostEl = $('directDeliverySummaryCost');
  const totalQtyEl = $('directDeliveryTotalQty');
  const totalCostEl = $('directDeliveryTotalCost');
  const visibleFactEl = $('directDeliveryVisibleFact');
  const visibleCostEl = $('directDeliveryVisibleCost');

  if (summaryQtyEl) summaryQtyEl.textContent = `${fmtQty(totals.qty)} шт.`;
  if (summaryCostEl) summaryCostEl.textContent = `${fmtMoney(totals.cost)} ₽`;
  if (totalQtyEl) totalQtyEl.textContent = fmtQty(totals.qty);
  if (totalCostEl) totalCostEl.textContent = `${fmtMoney(totals.cost)} ₽`;

  const visibleTotals = getEntriesTotals(getFilteredEntries());
  if (visibleFactEl) visibleFactEl.textContent = `${fmtQty(visibleTotals.qty)} шт.`;
  if (visibleCostEl) visibleCostEl.textContent = `${fmtMoney(visibleTotals.cost)} ₽`;
}

function updateActualInputState(index, inputEl) {
  const row = currentRows[index];
  if (!row || !inputEl) return;

  const actualQty = Number(row.actualQty) || 0;
  inputEl.style.borderColor = actualQty > Number(row.availableQty)
    ? 'rgb(248,113,113)'
    : '';

  const rowCostEl = $(`directDeliveryRowCost-${index}`);
  if (rowCostEl) {
    rowCostEl.textContent = `${fmtMoney(actualQty * (Number(row.price) || 0))} ₽`;
  }

  updateCardTotalsUI();
}

function getCardScrollHost() {
  return $('directDeliveryCardWrap')?.closest('.flex-1')
    || $('directDeliveryCardPanel')?.querySelector('.flex-1')
    || document.scrollingElement
    || document.documentElement;
}

function rerenderCardPreservingScroll() {
  const scrollHost = getCardScrollHost();
  const prevScrollTop = scrollHost?.scrollTop || 0;
  renderCard(editingDeliveryId);
  requestAnimationFrame(() => {
    if (scrollHost) scrollHost.scrollTop = prevScrollTop;
  });
}

function rerenderCardPreservingInteraction({ focusId = '', selectionStart = null, selectionEnd = null } = {}) {
  const scrollHost = getCardScrollHost();
  const prevScrollTop = scrollHost?.scrollTop || 0;
  renderCard(editingDeliveryId);
  requestAnimationFrame(() => {
    if (scrollHost) scrollHost.scrollTop = prevScrollTop;
    if (!focusId) return;
    const nextField = document.getElementById(focusId);
    if (!(nextField instanceof HTMLInputElement) && !(nextField instanceof HTMLTextAreaElement)) return;
    nextField.focus({ preventScroll: true });
    if (typeof selectionStart === 'number' && typeof nextField.setSelectionRange === 'function') {
      const safeEnd = typeof selectionEnd === 'number' ? selectionEnd : selectionStart;
      nextField.setSelectionRange(selectionStart, safeEnd);
    }
  });
}

function renderRegistry() {
  const wrap = $('directDeliveriesRegistryWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const items = [...(state.directDeliveries || [])].sort((a, b) =>
    String(b.date || b.createdAt || '').localeCompare(String(a.date || a.createdAt || ''))
  );

  if (!items.length) {
    wrap.appendChild(el('div', {
      className: 'rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-6 py-12 text-center',
    },
      el('div', { className: 'text-5xl mb-3' }, '🚛'),
      el('p', { className: 'text-sm font-semibold text-white' }, tf('warehouse.directEmpty', 'Прямых поставок пока нет')),
      el('p', { className: 'text-xs text-slate-500 mt-1' }, tf('warehouse.directEmptyHint', 'Создайте первую карточку прямой поставки по заявке поставщика')),
    ));
    return;
  }

  items.forEach(delivery => {
    const contract = getContractById(delivery.contractId);
    const order = getOrderById(delivery.orderId);
    const card = el('div', {
      className: 'rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4 hover:bg-white/[0.07] hover:border-fuchsia-400/20 transition cursor-pointer',
    });

    card.appendChild(el('div', { className: 'flex items-start justify-between gap-3' },
      el('div', { className: 'min-w-0 flex-1' },
        el('div', { className: 'flex items-center gap-2 flex-wrap' },
          el('span', { className: 'rounded-lg bg-fuchsia-400/15 px-2 py-1 text-[10px] font-bold text-fuchsia-300 uppercase tracking-wide' }, 'прямая поставка'),
          el('span', { className: 'text-sm font-semibold text-white truncate' }, delivery.orderNumber || order?.orderNumber || '—')
        ),
        el('p', { className: 'mt-2 text-xs text-slate-300 truncate' }, delivery.supplierName || getSupplierById(delivery.supplierId)?.name || '—'),
        el('p', { className: 'mt-1 text-xs text-slate-500 truncate' }, contract?.number ? `Контракт № ${contract.number}` : 'Контракт не указан')
      ),
      el('div', { className: 'text-right shrink-0' },
        el('div', { className: 'text-sm font-bold text-cyan-400 tabular-nums' }, `${fmtQty(delivery.totalQty)} шт.`),
        el('div', { className: 'text-xs text-slate-500 mt-1' }, fmtDate(delivery.date || delivery.createdAt)),
        el('div', { className: 'text-xs text-emerald-400 mt-1 tabular-nums' }, `${fmtMoney(delivery.totalCost)} ₽`)
      )
    ));

    const footer = el('div', { className: 'mt-4 flex items-center justify-between gap-3' });
    footer.appendChild(el('div', { className: 'text-xs text-slate-500' },
      `Строк: ${delivery.rows?.length || 0}`
    ));
    const actions = el('div', { className: 'flex items-center gap-2' });
    const openBtn = el('button', {
      type: 'button',
      className: 'rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-300 transition hover:bg-white/[0.1] hover:text-white',
    }, 'Открыть');
    openBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      openDirectDeliveryCard(delivery.id);
    });
    const deleteBtn = el('button', {
      type: 'button',
      className: 'rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-400/15',
    }, t('actions.delete'));
    deleteBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      if (!confirmDeleteWithImpact({
        title: 'Удалить прямую поставку?',
        subject: `${delivery.orderNumber || order?.orderNumber || '—'} · ${fmtDate(delivery.date || delivery.createdAt)}`,
        impacts: [
          'запись будет удалена из реестра прямых поставок',
        ],
        recalculations: [
          'поля «Доставлено» у получателей будут пересчитаны',
          'история поставок и связанные сводки обновятся',
        ],
      })) return;
      deleteDirectDelivery(delivery.id);
      recalcAllDelivered();
      await saveToStorage();
      showToast(tf('warehouse.directDeleted', 'Прямая поставка удалена'), 'success');
      renderRegistry();
      window.dispatchEvent(new Event('direct-deliveries-changed'));
    });
    actions.append(openBtn, deleteBtn);
    footer.appendChild(actions);
    card.appendChild(footer);

    card.addEventListener('click', () => openDirectDeliveryCard(delivery.id));
    wrap.appendChild(card);
  });
}

function buildSupplierOptions(selectedId = null) {
  return (state.suppliers || []).map(supplier => {
    const selected = String(selectedId) === String(supplier.id);
    return `<option value="${supplier.id}" ${selected ? 'selected' : ''}>${escapeHtml(supplier.name || '—')}</option>`;
  }).join('');
}

function buildOrderOptions(supplierId, selectedOrderId = null) {
  return getDirectOrdersForSupplier(supplierId).map(order => {
    const contract = getContractById(order.contractId);
    const selected = String(selectedOrderId) === String(order.id);
    const label = `${order.orderNumber || ('Заявка #' + order.id)}${contract?.number ? ' · № ' + contract.number : ''}`;
    return `<option value="${order.id}" ${selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
  }).join('');
}

function renderCard(deliveryId = null, forceLoadExisting = false) {
  const existing = deliveryId != null ? getDirectDeliveryById(deliveryId) : null;
  if (existing) {
    editingDeliveryId = existing.id;
    if (forceLoadExisting) {
      currentSupplierId = existing.supplierId ?? null;
      currentOrderId = existing.orderId ?? null;
    }
  } else {
    editingDeliveryId = null;
    currentSupplierId = currentSupplierId ?? null;
    currentOrderId = currentOrderId ?? null;
  }

  const titleEl = $('directDeliveryCardTitle');
  if (titleEl) titleEl.textContent = editingDeliveryId != null
    ? 'Прямая поставка'
    : tf('warehouse.directAddBtn', 'Новая поставка');

  const wrap = $('directDeliveryCardWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const supplier = currentSupplierId != null ? getSupplierById(currentSupplierId) : null;
  const orders = supplier ? getDirectOrdersForSupplier(supplier.id) : [];
  if (!orders.some(order => String(order.id) === String(currentOrderId))) currentOrderId = orders[0]?.id ?? null;
  const order = currentOrderId != null ? getOrderById(currentOrderId) : null;

  const sourceRows = forceLoadExisting
    ? (existing?.rows || [])
    : (order && String(currentRowsOrderId ?? '') === String(order.id))
      ? currentRows
      : (existing?.rows || []);

  currentRows = order ? buildRowsFromOrder(order, sourceRows, existing?.id ?? null) : [];
  currentRowsOrderId = order?.id ?? null;
  const totals = getCardTotals();

  const fieldGrid = el('div', { className: 'grid grid-cols-1 gap-4 lg:grid-cols-2' });
  fieldGrid.innerHTML = `
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directFieldSupplier', 'Поставщик'))}</label>
      <select id="directDeliverySupplierSel" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
        <option value="">${escapeHtml(tf('warehouse.directSelectSupplier', 'Выберите поставщика'))}</option>
        ${buildSupplierOptions(currentSupplierId)}
      </select>
    </div>
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directFieldOrder', 'Прямая заявка'))}</label>
      <select id="directDeliveryOrderSel" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]" ${supplier ? '' : 'disabled'}>
        <option value="">${escapeHtml(tf('warehouse.directSelectOrder', 'Выберите заявку на прямую поставку'))}</option>
        ${supplier ? buildOrderOptions(supplier.id, currentOrderId) : ''}
      </select>
      <p class="mt-1 text-xs text-slate-500">${supplier ? '' : escapeHtml(tf('warehouse.directNoOrders', 'Сначала выберите поставщика'))}</p>
    </div>
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directFieldDate', 'Дата поставки'))}</label>
      <input id="directDeliveryDateInp" type="date" value="${escapeHtml(existing?.date || new Date().toISOString().slice(0, 10))}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
    </div>
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.fieldNotes', 'Примечание'))}</label>
      <input id="directDeliveryNotesInp" type="text" value="${escapeHtml(existing?.notes || '')}" placeholder="${escapeHtml(tf('warehouse.notesPlaceholder', 'Дополнительная информация…'))}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
    </div>
  `;
  wrap.appendChild(fieldGrid);

  const contractInfo = el('div', {
    className: 'mt-4 rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-3',
  });
  contractInfo.innerHTML = order
    ? `<div class="flex flex-wrap items-center gap-3 text-xs text-slate-400">
        <span class="rounded-lg bg-fuchsia-400/15 px-2 py-1 text-[10px] font-semibold text-fuchsia-300">${escapeHtml(order.orderNumber || '—')}</span>
        <span>Контракт: <strong class="text-white">${escapeHtml(getContractById(order.contractId)?.number || '—')}</strong></span>
        <span>Плановых строк: <strong class="text-white">${currentRows.length}</strong></span>
        <span>Факт: <strong id="directDeliverySummaryQty" class="text-cyan-400">${fmtQty(totals.qty)} шт.</strong></span>
        <span>Сумма: <strong id="directDeliverySummaryCost" class="text-emerald-400">${fmtMoney(totals.cost)} ₽</strong></span>
      </div>`
    : `<p class="text-sm text-slate-500">${escapeHtml(tf('warehouse.directNoRows', 'Выберите прямую заявку, чтобы увидеть разнарядку.'))}</p>`;
  wrap.appendChild(contractInfo);

  const tableSection = el('section', { className: 'mt-6' });
  tableSection.appendChild(el('h3', {
    className: 'mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, tf('warehouse.directRowsTitle', 'Фактическая поставка по разнарядке')));

  if (!order || currentRows.length === 0) {
    tableSection.appendChild(el('div', {
      className: 'rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-5 py-10 text-center text-sm text-slate-500',
    }, tf('warehouse.directNoRows', 'Выберите прямую заявку, чтобы увидеть разнарядку.')));
  } else {
    const addressOptions = [...new Set(currentRows.map(row => String(row.recipientAddress || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const productOptions = [...new Set(currentRows.map(row => row.productCode ? `${row.productName || '—'} — ${row.productCode}` : (row.productName || '—')).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
    const filterBar = el('div', {
      className: 'mb-4 grid grid-cols-1 gap-3 lg:grid-cols-[1.2fr_1.2fr_220px_auto]',
    });
    filterBar.innerHTML = `
      <div>
        <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directFilterAddress', 'Фильтр по адресу'))}</label>
        <input id="directDeliveryFilterAddress" list="directDeliveryFilterAddressOptions" type="text" value="${escapeHtml(cardViewState.addressQuery)}" placeholder="${escapeHtml(tf('warehouse.directFilterAddressPlaceholder', 'Введите часть адреса'))}" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
        <datalist id="directDeliveryFilterAddressOptions">${addressOptions.map(value => `<option value="${escapeHtml(value)}"></option>`).join('')}</datalist>
      </div>
      <div>
        <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directFilterProduct', 'Фильтр по товару'))}</label>
        <input id="directDeliveryFilterProduct" list="directDeliveryFilterProductOptions" type="text" value="${escapeHtml(cardViewState.productQuery)}" placeholder="${escapeHtml(tf('warehouse.directFilterProductPlaceholder', 'Наименование или код товара'))}" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
        <datalist id="directDeliveryFilterProductOptions">${productOptions.map(value => `<option value="${escapeHtml(value)}"></option>`).join('')}</datalist>
      </div>
      <div>
        <label class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escapeHtml(tf('warehouse.directGroupBy', 'Группировка'))}</label>
        <select id="directDeliveryGroupBySel" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white transition focus:border-fuchsia-400/50 focus:bg-white/[0.07]">
          <option value="none" ${cardViewState.groupBy === 'none' ? 'selected' : ''}>${escapeHtml(tf('warehouse.directGroupNone', 'Без группировки'))}</option>
          <option value="address" ${cardViewState.groupBy === 'address' ? 'selected' : ''}>${escapeHtml(tf('warehouse.directGroupAddress', 'По адресу'))}</option>
          <option value="product" ${cardViewState.groupBy === 'product' ? 'selected' : ''}>${escapeHtml(tf('warehouse.directGroupProduct', 'По товару'))}</option>
        </select>
      </div>
      <div class="flex items-end">
        <button id="directDeliveryResetFiltersBtn" type="button" class="w-full rounded-xl border border-white/10 bg-white/[0.05] px-4 py-2.5 text-sm font-semibold text-slate-300 transition hover:bg-white/[0.1] hover:text-white">
          ${escapeHtml(tf('actions.reset', 'Сбросить'))}
        </button>
      </div>
    `;
    tableSection.appendChild(filterBar);

    const visibleEntries = getFilteredEntries();
    const visibleGroups = buildVisibleGroups(visibleEntries);
    const visibleTotals = getEntriesTotals(visibleEntries);

    tableSection.appendChild(el('div', {
      className: 'mb-3 flex flex-wrap items-center gap-3 text-xs text-slate-400',
    },
      el('span', { className: 'rounded-lg bg-white/[0.04] px-2.5 py-1' },
        `${tf('warehouse.directVisibleRows', 'Показано строк')}: ${visibleEntries.length} / ${currentRows.length}`
      ),
      el('span', { className: 'rounded-lg bg-white/[0.04] px-2.5 py-1' },
        `${tf('warehouse.directVisibleFact', 'Факт по выборке')}: `,
        el('strong', { id: 'directDeliveryVisibleFact', className: 'text-white font-semibold' }, `${fmtQty(visibleTotals.qty)} шт.`)
      ),
      el('span', { className: 'rounded-lg bg-white/[0.04] px-2.5 py-1' },
        `${tf('warehouse.directVisibleCost', 'Сумма по выборке')}: `,
        el('strong', { id: 'directDeliveryVisibleCost', className: 'text-white font-semibold' }, `${fmtMoney(visibleTotals.cost)} ₽`)
      ),
      cardViewState.groupBy !== 'none'
        ? el('span', { className: 'rounded-lg bg-fuchsia-400/10 px-2.5 py-1 text-fuchsia-300' },
            `${tf('warehouse.directVisibleGroups', 'Групп')}: ${visibleGroups.length}`
          )
        : null
    ));

    const tableWrap = el('div', { className: 'overflow-x-auto rounded-2xl border border-white/10 bg-slate-950/30' });
    const table = el('table', { className: 'w-full text-sm' });
    table.innerHTML = `
      <thead class="bg-slate-900/70 text-slate-400">
        <tr>
          <th class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide">Получатель</th>
          <th class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide">Адрес</th>
          <th class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide">Товар</th>
          <th class="px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wide">Код</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(tf('warehouse.directPlannedQty', 'План'))}</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(tf('warehouse.directDeliveredBefore', 'Уже поставлено'))}</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(tf('warehouse.directAvailable', 'Доступно'))}</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(tf('warehouse.directActualQty', 'Факт'))}</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(t('orders.colPrice'))}</th>
          <th class="px-3 py-2 text-right text-[10px] font-semibold uppercase tracking-wide">${escapeHtml(t('orders.colCost'))}</th>
        </tr>
      </thead>
    `;
    const tbody = el('tbody', { className: 'divide-y divide-white/5' });

    if (!visibleEntries.length) {
      tbody.appendChild(el('tr', {},
        el('td', {
          colspan: '10',
          className: 'px-4 py-10 text-center text-sm text-slate-500',
        }, tf('warehouse.directFilterEmpty', 'По текущим фильтрам ничего не найдено'))
      ));
    } else {
      visibleGroups.forEach(group => {
        if (cardViewState.groupBy !== 'none') {
          tbody.appendChild(renderGroupHeaderRow(group, 10));
        }

        group.entries.forEach(({ row, index }) => {
          const tr = el('tr', { className: 'hover:bg-white/[0.03] transition' });
          tr.appendChild(el('td', { className: 'px-3 py-2 text-sm text-white' }, row.recipientName || '—'));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-xs text-slate-400 min-w-[220px]' }, row.recipientAddress || '—'));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-sm text-white min-w-[220px]' }, row.productName || '—'));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-xs font-mono text-cyan-400 whitespace-nowrap' }, row.productCode || '—'));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-right text-sm text-slate-300 tabular-nums whitespace-nowrap' }, fmtQty(row.plannedQty)));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-right text-sm text-amber-400 tabular-nums whitespace-nowrap' }, fmtQty(row.deliveredBefore)));
          tr.appendChild(el('td', { className: 'px-3 py-2 text-right text-sm text-emerald-400 tabular-nums whitespace-nowrap' }, fmtQty(row.availableQty)));

          const actualTd = el('td', { className: 'px-3 py-2 text-right' });
          const actualInput = el('input', {
            type: 'number',
            min: '0',
            step: '1',
            value: String(row.actualQty || 0),
            className: 'w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-right text-sm text-white tabular-nums focus:border-fuchsia-400/50 focus:outline-none',
            'data-row-index': String(index),
            'aria-label': `${tf('warehouse.directActualQty', 'Фактически поставлено')} ${row.productName}`,
          });
          actualInput.addEventListener('input', () => {
            const value = Math.max(0, parseInt(actualInput.value, 10) || 0);
            currentRows[index].actualQty = value;
            updateActualInputState(index, actualInput);
          });
          actualInput.addEventListener('change', () => {
            const value = Math.max(0, parseInt(actualInput.value, 10) || 0);
            currentRows[index].actualQty = value;
            actualInput.value = String(value);
            updateActualInputState(index, actualInput);
          });
          updateActualInputState(index, actualInput);
          actualTd.appendChild(actualInput);
          tr.appendChild(actualTd);

          tr.appendChild(el('td', { className: 'px-3 py-2 text-right text-sm text-slate-300 tabular-nums whitespace-nowrap' }, `${fmtMoney(row.price)} ₽`));
          tr.appendChild(el('td', {
            id: `directDeliveryRowCost-${index}`,
            className: 'px-3 py-2 text-right text-sm font-semibold text-cyan-400 tabular-nums whitespace-nowrap',
          }, `${fmtMoney((Number(row.actualQty) || 0) * (Number(row.price) || 0))} ₽`));
          tbody.appendChild(tr);
        });
      });
    }

    const totalsTr = el('tr', { className: 'bg-slate-900/50' });
    totalsTr.appendChild(el('td', { colspan: '7', className: 'px-3 py-3 text-right text-xs font-semibold uppercase tracking-wide text-slate-400' }, tf('orders.totalLabel', 'Итого')));
    totalsTr.appendChild(el('td', {
      id: 'directDeliveryTotalQty',
      className: 'px-3 py-3 text-right text-sm font-bold text-white tabular-nums whitespace-nowrap',
    }, fmtQty(totals.qty)));
    totalsTr.appendChild(el('td', { className: 'px-3 py-3 text-right text-xs font-semibold text-slate-400' }, ''));
    totalsTr.appendChild(el('td', {
      id: 'directDeliveryTotalCost',
      className: 'px-3 py-3 text-right text-sm font-bold text-emerald-400 tabular-nums whitespace-nowrap',
    }, `${fmtMoney(totals.cost)} ₽`));
    tbody.appendChild(totalsTr);

    table.appendChild(tbody);
    tableWrap.appendChild(table);
    tableSection.appendChild(tableWrap);
  }

  wrap.appendChild(tableSection);

  $('directDeliveryFilterAddress')?.addEventListener('input', (event) => {
    const field = event.currentTarget;
    cardViewState.addressQuery = $('directDeliveryFilterAddress')?.value || '';
    rerenderCardPreservingInteraction({
      focusId: field?.id || 'directDeliveryFilterAddress',
      selectionStart: field?.selectionStart ?? null,
      selectionEnd: field?.selectionEnd ?? null,
    });
  });

  $('directDeliveryFilterProduct')?.addEventListener('input', (event) => {
    const field = event.currentTarget;
    cardViewState.productQuery = $('directDeliveryFilterProduct')?.value || '';
    rerenderCardPreservingInteraction({
      focusId: field?.id || 'directDeliveryFilterProduct',
      selectionStart: field?.selectionStart ?? null,
      selectionEnd: field?.selectionEnd ?? null,
    });
  });

  $('directDeliveryGroupBySel')?.addEventListener('change', () => {
    cardViewState.groupBy = $('directDeliveryGroupBySel')?.value || 'none';
    rerenderCardPreservingScroll();
  });

  $('directDeliveryResetFiltersBtn')?.addEventListener('click', () => {
    cardViewState = { addressQuery: '', productQuery: '', groupBy: 'none' };
    rerenderCardPreservingScroll();
  });

  $('directDeliverySupplierSel')?.addEventListener('change', () => {
    currentSupplierId = $('directDeliverySupplierSel').value ? Number($('directDeliverySupplierSel').value) : null;
    currentOrderId = null;
    currentRowsOrderId = null;
    renderCard(editingDeliveryId);
  });

  $('directDeliveryOrderSel')?.addEventListener('change', () => {
    currentOrderId = $('directDeliveryOrderSel').value ? Number($('directDeliveryOrderSel').value) : null;
    currentRowsOrderId = null;
    renderCard(editingDeliveryId);
  });
}

function validateCurrentCard() {
  if (!currentSupplierId) {
    showToast(tf('warehouse.directSelectSupplier', 'Выберите поставщика'), 'error');
    return false;
  }
  if (!currentOrderId) {
    showToast(tf('warehouse.directSelectOrder', 'Выберите заявку на прямую поставку'), 'error');
    return false;
  }
  const exceeded = currentRows.find(row => Number(row.actualQty) > Number(row.availableQty));
  if (exceeded) {
    showToast(tf('warehouse.directValidationExceeded', 'Фактическое количество не должно превышать доступное по заявке'), 'error', 5000);
    return false;
  }
  return true;
}

async function saveCurrentCard() {
  if (!validateCurrentCard()) return;
  const supplier = getSupplierById(currentSupplierId);
  const order = getOrderById(currentOrderId);
  const contract = getContractById(order?.contractId);
  const rows = currentRows.map(row => ({
    recipientId: row.recipientId,
    recipientName: row.recipientName,
    recipientAddress: row.recipientAddress,
    productCode: row.productCode,
    productName: row.productName,
    category: row.category,
    price: Number(row.price) || 0,
    plannedQty: Number(row.plannedQty) || 0,
    actualQty: Number(row.actualQty) || 0,
  }));
  const totals = getCardTotals();
  const payload = {
    supplierId: supplier?.id ?? null,
    supplierName: supplier?.name || '',
    contractId: contract?.id ?? null,
    orderId: order?.id ?? null,
    orderNumber: order?.orderNumber || '',
    date: $('directDeliveryDateInp')?.value || '',
    notes: $('directDeliveryNotesInp')?.value?.trim() || '',
    rows,
    totalQty: totals.qty,
    totalCost: totals.cost,
  };

  if (editingDeliveryId != null) updateDirectDelivery(editingDeliveryId, payload);
  else {
    const created = addDirectDelivery(payload);
    editingDeliveryId = created.id;
  }

  recalcAllDelivered();
  await saveToStorage();
  showToast(tf('warehouse.directSaved', 'Прямая поставка сохранена'), 'success');
  renderRegistry();
  showRegistryPanel();
  window.dispatchEvent(new Event('direct-deliveries-changed'));
}

async function exportCurrentCardToExcel() {
  if (!currentOrderId || currentRows.length === 0) {
    showToast(tf('warehouse.directNoRows', 'Нет данных для выгрузки'), 'info');
    return;
  }
  const XLSX = window.XLSX || await loadXLSX().catch(() => null);
  if (!XLSX) {
    showToast(tf('suppliers.exportLoadError', 'Не удалось загрузить модуль Эксель'), 'error');
    return;
  }

  const order = getOrderById(currentOrderId);
  const supplier = getSupplierById(currentSupplierId);
  const rows = currentRows.map(row => ({
    'Получатель': row.recipientName,
    'Адрес': row.recipientAddress,
    'Код товара': row.productCode,
    'Наименование': row.productName,
    'План, шт.': row.plannedQty,
    'Уже поставлено, шт.': row.deliveredBefore,
    'Доступно, шт.': row.availableQty,
    'Фактически поставлено, шт.': row.actualQty,
    'Цена, ₽': Number(row.price) || 0,
    'Стоимость, ₽': (Number(row.actualQty) || 0) * (Number(row.price) || 0),
  }));

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = [24, 32, 18, 38, 12, 16, 14, 20, 12, 14].map(wch => ({ wch }));
  XLSX.utils.book_append_sheet(wb, ws, 'Прямая поставка');
  const supplierPart = String(supplier?.name || 'supplier').replace(/[\\/:*?"<>|]+/g, '_');
  const orderPart = String(order?.orderNumber || 'order').replace(/[\\/:*?"<>|]+/g, '_');
  XLSX.writeFile(wb, `Прямая_поставка_${supplierPart}_${orderPart}.xlsx`);
}

function findImportColumnIndex(headers, variants) {
  const normalizedHeaders = headers.map(cell => normalize(cell));
  return normalizedHeaders.findIndex(cell => variants.some(variant => cell.includes(variant)));
}

async function importCurrentCardFromExcel(file) {
  if (!file) return;
  const XLSX = window.XLSX || await loadXLSX().catch(() => null);
  if (!XLSX) {
    showToast(tf('suppliers.exportLoadError', 'Не удалось загрузить модуль Эксель'), 'error');
    return;
  }

  try {
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!aoa.length) throw new Error(tf('warehouse.directImportError', 'Файл пуст или не распознан'));

    const headers = aoa[0] || [];
    const recipientIdx = findImportColumnIndex(headers, ['получатель']);
    const addressIdx = findImportColumnIndex(headers, ['адрес']);
    const codeIdx = findImportColumnIndex(headers, ['код товара', 'код']);
    const nameIdx = findImportColumnIndex(headers, ['наименование', 'товар']);
    const actualIdx = findImportColumnIndex(headers, ['фактически поставлено', 'поставлено, шт', 'факт']);

    if (recipientIdx < 0 || addressIdx < 0 || actualIdx < 0 || (codeIdx < 0 && nameIdx < 0)) {
      throw new Error(tf('warehouse.directImportError', 'Не удалось распознать столбцы Excel'));
    }

    const map = new Map();
    currentRows.forEach((row, index) => {
      const key = [
        normalize(row.recipientName),
        normalize(row.recipientAddress),
        normalize(row.productCode),
        normalize(row.productName),
      ].join('||');
      map.set(key, index);
    });

    let matched = 0;
    aoa.slice(1).forEach(row => {
      if (!Array.isArray(row)) return;
      const recipientName = String(row[recipientIdx] || '').trim();
      const address = String(row[addressIdx] || '').trim();
      const code = codeIdx >= 0 ? String(row[codeIdx] || '').trim() : '';
      const name = nameIdx >= 0 ? String(row[nameIdx] || '').trim() : '';
      const actualQty = Math.max(0, parseInt(row[actualIdx], 10) || 0);
      const key = [normalize(recipientName), normalize(address), normalize(code), normalize(name)].join('||');
      const index = map.get(key);
      if (index == null) return;
      currentRows[index].actualQty = actualQty;
      matched += 1;
    });

    renderCard(editingDeliveryId);
    showToast(tf('warehouse.directImported', 'Excel-данные загружены') + `: ${matched}`, 'success');
  } catch (error) {
    console.error('[direct-deliveries] import error', error);
    showToast(error?.message || tf('warehouse.directImportError', 'Не удалось загрузить Excel'), 'error');
  }
}

function openDirectDeliveryCard(deliveryId = null) {
  editingDeliveryId = deliveryId;
  cardViewState = { addressQuery: '', productQuery: '', groupBy: 'none' };
  if (deliveryId == null) {
    currentOrderId = null;
    currentRows = [];
    currentRowsOrderId = null;
  } else {
    currentSupplierId = null;
    currentOrderId = null;
    currentRowsOrderId = null;
  }
  renderCard(deliveryId, deliveryId != null);
  showCardPanel();
}

function backToRegistry() {
  renderRegistry();
  showRegistryPanel();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function openDirectDeliveriesRegistry() {
  initDirectDeliveriesView();
  $('warehouseModal')?.classList.add('open');
  renderRegistry();
  showRegistryPanel();
}

export function initDirectDeliveriesView() {
  if (initialized) return;
  initialized = true;

  $('directDeliveriesBackBtn')?.addEventListener('click', () => {
    hideLogisticsPanels();
    $('warehouseHomePanel')?.classList.remove('hidden');
  });
  $('directDeliveriesCloseBtn')?.addEventListener('click', closeLogisticsModal);
  $('directDeliveriesAddBtn')?.addEventListener('click', () => {
    editingDeliveryId = null;
    currentSupplierId = null;
    currentOrderId = null;
    currentRows = [];
    currentRowsOrderId = null;
    openDirectDeliveryCard(null);
  });

  $('directDeliveryCardBackBtn')?.addEventListener('click', backToRegistry);
  $('directDeliverySaveBtn')?.addEventListener('click', saveCurrentCard);
  $('directDeliveryExportBtn')?.addEventListener('click', exportCurrentCardToExcel);
  $('directDeliveryImportBtn')?.addEventListener('click', () => $('directDeliveryImportFileInput')?.click());
  $('directDeliveryImportFileInput')?.addEventListener('change', async () => {
    const file = $('directDeliveryImportFileInput')?.files?.[0];
    if (!file) return;
    await importCurrentCardFromExcel(file);
    $('directDeliveryImportFileInput').value = '';
  });
}
