/**
 * Suppliers view.
 * Panel 1: list of suppliers.
 * Panel 2: full-screen supplier card:
 *   – Basic info: name, INN, address, email
 *   – Phones (multiple)
 *   – Contact persons (multiple)
 *   – Contracts: read-only list auto-synced from state.contracts
 *   – Contract cards are clickable → open in Contracts module
 */

import { $, el, clearChildren } from './dom.js';
import { state } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';
import { enhancePredictiveInput } from './filters.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

let editingSupplierId = null;
let editingPhones     = [];   // [{id, value}]
let editingPersons    = [];   // [{id, value}]
let supplierDeliveriesRecipientFilter = '';
let supplierDeliveriesProductFilter = '';
let supplierDeliveriesExportLoading = false;

// ─── Helpers ──────────────────────────────────────────────────────

function uid() { return Date.now() + Math.random(); }

function nextSupplierId() {
  if (!state.suppliers || state.suppliers.length === 0) return 1;
  return Math.max(...state.suppliers.map(s => s.id)) + 1;
}

function getSupplierById(id) {
  return (state.suppliers || []).find(s => s.id === id) || null;
}

function getOrderById(id) {
  return (state.orders || []).find(o => String(o.id) === String(id)) || null;
}

function getContractById(id) {
  return (state.contracts || []).find(c => String(c.id) === String(id)) || null;
}

function makeContract(overrides = {}) {
  return { id: uid(), number: '', email: '', phone: '', contactPerson: '', ...overrides };
}

function makePhone(value = '')   { return { id: uid(), value }; }
function makePerson(value = '')  { return { id: uid(), value }; }

function escapeFileNamePart(value) {
  return String(value || 'supplier')
    .replace(/[\\/:*?"<>|]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'supplier';
}

function fmtQty(value) {
  return Number(value || 0).toLocaleString('ru-RU', { maximumFractionDigits: 0 });
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    return new Date(value).toLocaleDateString('ru-RU');
  } catch {
    return value;
  }
}

function buildDeliverySourceBadge(sourceType) {
  const isDirect = sourceType === 'direct';
  return el('span', {
    className: 'inline-flex items-center rounded-lg px-2 py-0.5 text-[10px] font-semibold ' +
      (isDirect
        ? 'bg-fuchsia-400/15 text-fuchsia-300'
        : 'bg-cyan-400/15 text-cyan-300'),
  }, isDirect
    ? tf('delivery.badgeDirect', 'Прямая поставка')
    : tf('delivery.badgeWarehouse', 'Со склада'));
}

function getRecipientFilterKey(row) {
  return String(row?.recipientId ?? row?.recipientName ?? 'unknown');
}

function getSupplierRecipientOptions(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = getRecipientFilterKey(row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        name: row.recipientName || '—',
        address: row.recipientAddress || '',
        searchText: `${row.recipientName || ''} ${row.recipientAddress || ''}`.trim(),
      });
    }
  });
  return [...map.values()].sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));
}

function getProductFilterKey(row) {
  const code = String(row?.productCode || '').trim();
  const name = String(row?.productName || '').trim();
  return code || name || 'unknown-product';
}

function getSupplierProductOptions(rows) {
  const map = new Map();
  rows.forEach(row => {
    const key = getProductFilterKey(row);
    if (!map.has(key)) {
      map.set(key, {
        key,
        code: row.productCode || '',
        name: row.productName || '—',
        searchText: `${row.productName || ''} ${row.productCode || ''}`.trim(),
      });
    }
  });
  return [...map.values()].sort((a, b) => {
    const nameCmp = String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    if (nameCmp !== 0) return nameCmp;
    return String(a.code || '').localeCompare(String(b.code || ''), 'ru');
  });
}

function filterSupplierShipmentRows(rows) {
  if (!Array.isArray(rows)) return [];
  const recipientQuery = String(supplierDeliveriesRecipientFilter || '').trim().toLowerCase();
  const productQuery = String(supplierDeliveriesProductFilter || '').trim().toLowerCase();
  return rows.filter(row => {
    const recipientHaystack = `${row.recipientName || ''} ${row.recipientAddress || ''}`.toLowerCase();
    if (recipientQuery && !recipientHaystack.includes(recipientQuery)) {
      return false;
    }
    const productHaystack = `${row.productName || ''} ${row.productCode || ''} ${row.category || ''}`.toLowerCase();
    if (productQuery && !productHaystack.includes(productQuery)) {
      return false;
    }
    return true;
  });
}

function resolveRecipientAddress(recipientId) {
  const recipient = (state.recipients || []).find(r => String(r.id) === String(recipientId));
  return recipient?.address || recipient?.addresses?.[0] || '';
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
  const contract = getContractById(row.contractId ?? order?.contractId ?? null);
  const supplierId = row.supplierId ?? contract?.supplierId ?? null;
  const supplier = supplierId != null ? getSupplierById(supplierId) : null;

  return {
    supplierId,
    supplierName: supplier?.name || '—',
  };
}

function rowBelongsToSupplier(row, supplier) {
  if (!row || !supplier) return false;
  const supplierMeta = resolveShipmentRowSupplier(row);
  if (supplierMeta.supplierId != null && supplier.id != null) {
    return String(supplierMeta.supplierId) === String(supplier.id);
  }
  const rowName = String(supplierMeta.supplierName || '').trim().toLowerCase();
  const supplierName = String(supplier.name || '').trim().toLowerCase();
  return !!rowName && !!supplierName && rowName === supplierName;
}

function collectSupplierShipmentRows(supplierId) {
  const supplier = getSupplierById(supplierId);
  if (!supplier) return [];

  const rows = [];
  for (const shipment of (state.shipments || [])) {
    const shipmentDate = shipment.date || shipment.createdAt || '';
    for (const row of (shipment.rows || [])) {
      if (!rowBelongsToSupplier(row, supplier)) continue;
      const supplierMeta = resolveShipmentRowSupplier(row);
      for (const recipientEntry of (row.recipients || [])) {
        const qty = Number(recipientEntry.qty) || 0;
        if (qty <= 0) continue;
        rows.push({
          shipmentId: shipment.id,
          shipmentDate,
          sourceType: 'warehouse',
          recipientId: recipientEntry.recipientId,
          recipientName: recipientEntry.recipientName || '—',
          recipientAddress: resolveRecipientAddress(recipientEntry.recipientId),
          productName: row.productName || '—',
          productCode: row.productCode || '',
          category: row.category || '',
          orderNum: row.orderNum || '—',
          supplierName: supplierMeta.supplierName || supplier.name || '—',
          qty,
        });
      }
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    const supplierMatches = delivery.supplierId != null
      ? String(delivery.supplierId) === String(supplier.id)
      : String(delivery.supplierName || '').trim().toLowerCase() === String(supplier.name || '').trim().toLowerCase();
    if (!supplierMatches) continue;

    const shipmentDate = delivery.date || delivery.createdAt || '';
    for (const row of (delivery.rows || [])) {
      const qty = Number(row.actualQty) || 0;
      if (qty <= 0) continue;
      rows.push({
        shipmentId: `direct-${delivery.id}`,
        shipmentDate,
        sourceType: 'direct',
        recipientId: row.recipientId,
        recipientName: row.recipientName || '—',
        recipientAddress: row.recipientAddress || resolveRecipientAddress(row.recipientId),
        productName: row.productName || '—',
        productCode: row.productCode || '',
        category: row.category || '',
        orderNum: delivery.orderNumber || '—',
        supplierName: delivery.supplierName || supplier.name || '—',
        qty,
      });
    }
  }

  return rows.sort((a, b) => {
    const dateCmp = String(b.shipmentDate || '').localeCompare(String(a.shipmentDate || ''));
    if (dateCmp !== 0) return dateCmp;
    const recCmp = String(a.recipientName || '').localeCompare(String(b.recipientName || ''), 'ru');
    if (recCmp !== 0) return recCmp;
    return String(a.productName || '').localeCompare(String(b.productName || ''), 'ru');
  });
}

function groupSupplierShipmentRowsByRecipient(rows) {
  const groups = new Map();
  rows.forEach(row => {
    const key = String(row.recipientId ?? row.recipientName ?? 'unknown');
    if (!groups.has(key)) {
      groups.set(key, {
        recipientId: row.recipientId,
        recipientName: row.recipientName || '—',
        recipientAddress: row.recipientAddress || '',
        rows: [],
        totalQty: 0,
        shipmentIds: new Set(),
      });
    }
    const group = groups.get(key);
    group.rows.push(row);
    group.totalQty += row.qty;
    if (row.shipmentId != null) group.shipmentIds.add(row.shipmentId);
  });

  return [...groups.values()]
    .sort((a, b) => String(a.recipientName || '').localeCompare(String(b.recipientName || ''), 'ru'));
}

function ensureSupplierDeliveriesSection() {
  const panel = $('supplierEditPanel');
  if (!panel) return null;
  const body = panel.querySelector('.flex-1.overflow-auto');
  if (!body) return null;

  let section = $('supplierDeliveriesSection');
  if (!section) {
    section = el('section', { id: 'supplierDeliveriesSection' });

    const header = el('div', { className: 'flex items-center justify-between gap-3 mb-3 flex-wrap' });
    const left = el('div', { className: 'min-w-0 flex-1' });
    left.appendChild(
      el('h3', {
        className: 'text-xs font-semibold uppercase tracking-wider text-slate-400',
      }, t('suppliers.sectionDeliveries')),
    );
    const filterRow = el('div', { className: 'mt-2 flex items-center gap-2 flex-wrap' });
    filterRow.appendChild(el('span', {
      className: 'text-[11px] font-medium text-slate-500',
    }, t('suppliers.filterRecipientLabel')));
    filterRow.appendChild(el('input', {
      id: 'supplierDeliveriesRecipientFilter',
      type: 'text',
      list: 'supplierDeliveriesRecipientFilterOptions',
      className: 'min-w-[220px] rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      placeholder: tf('suppliers.filterRecipientAll', 'Все получатели'),
      'aria-label': t('suppliers.filterRecipientLabel'),
    }));
    filterRow.appendChild(el('datalist', { id: 'supplierDeliveriesRecipientFilterOptions' }));
    filterRow.appendChild(el('span', {
      className: 'text-[11px] font-medium text-slate-500',
    }, t('suppliers.filterProductLabel')));
    filterRow.appendChild(el('input', {
      id: 'supplierDeliveriesProductFilter',
      type: 'text',
      list: 'supplierDeliveriesProductFilterOptions',
      className: 'min-w-[240px] rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      placeholder: tf('suppliers.filterProductAll', 'Все товары'),
      'aria-label': t('suppliers.filterProductLabel'),
    }));
    filterRow.appendChild(el('datalist', { id: 'supplierDeliveriesProductFilterOptions' }));
    left.appendChild(filterRow);
    header.appendChild(left);

    const actions = el('div', { className: 'flex items-center gap-2 flex-wrap' });
    actions.appendChild(el('span', {
      id: 'supplierDeliveriesMeta',
      className: 'text-xs text-slate-500',
    }));
    actions.appendChild(
      el('button', {
        id: 'supplierDeliveriesExportBtn',
        type: 'button',
        className: 'inline-flex items-center gap-1.5 rounded-xl border border-white/15 bg-white/5 px-3 py-1.5 text-xs font-semibold text-emerald-400 transition hover:bg-emerald-400/10 hover:border-emerald-400/30 active:scale-[0.97]',
      }, '📥 ' + t('suppliers.exportDeliveries')),
    );
    header.appendChild(actions);
    section.appendChild(header);
    section.appendChild(el('div', { id: 'supplierDeliveriesWrap', className: 'space-y-3' }));
    body.appendChild(section);
  }

  return {
    section,
    meta: $('supplierDeliveriesMeta'),
    wrap: $('supplierDeliveriesWrap'),
    exportBtn: $('supplierDeliveriesExportBtn'),
    recipientFilter: $('supplierDeliveriesRecipientFilter'),
    productFilter: $('supplierDeliveriesProductFilter'),
  };
}

async function exportSupplierDeliveries(supplierId, rowsOverride = null) {
  const supplier = getSupplierById(supplierId);
  if (!supplier) return;
  const rows = Array.isArray(rowsOverride)
    ? rowsOverride
    : filterSupplierShipmentRows(collectSupplierShipmentRows(supplierId));
  if (rows.length === 0) {
    showToast(t('suppliers.deliveriesEmpty'), 'info');
    return;
  }

  if (typeof XLSX === 'undefined') {
    supplierDeliveriesExportLoading = true;
    renderSupplierDeliveriesSection(supplierId);
    showToast(t('suppliers.exportPreparing'), 'info');
    try {
      await loadXLSX();
    } catch (error) {
      console.error('[suppliers] XLSX load failed', error);
      showToast(t('suppliers.exportLoadError'), 'error');
      supplierDeliveriesExportLoading = false;
      renderSupplierDeliveriesSection(supplierId);
      return;
    }
    supplierDeliveriesExportLoading = false;
    renderSupplierDeliveriesSection(supplierId);
  }

  const recipientGroups = groupSupplierShipmentRowsByRecipient(rows);
  const summary = recipientGroups.map(group => [
    group.recipientName,
    group.recipientAddress || '—',
    group.rows.length,
    group.shipmentIds.size,
    group.totalQty,
  ]);
  summary.push([
    'ИТОГО',
    '',
    rows.length,
    new Set(rows.map(row => row.shipmentId)).size,
    rows.reduce((sum, row) => sum + row.qty, 0),
  ]);

  const details = rows.map(row => [
    fmtDate(row.shipmentDate),
    row.recipientName,
    row.recipientAddress || '—',
    row.category || '—',
    row.productName,
    row.productCode || '—',
    row.orderNum || '—',
    row.qty,
  ]);

  const wb = XLSX.utils.book_new();
  const summarySheet = XLSX.utils.aoa_to_sheet([
    ['Получатель', 'Адрес', 'Строк поставок', 'Отгрузок', 'Всего, шт.'],
    ...summary,
  ]);
  summarySheet['!cols'] = [28, 34, 14, 12, 12].map(wch => ({ wch }));
  const detailsSheet = XLSX.utils.aoa_to_sheet([
    ['Дата отгрузки', 'Получатель', 'Адрес', 'Категория', 'Товар', 'Код', 'Заявка', 'Кол-во, шт.'],
    ...details,
  ]);
  detailsSheet['!cols'] = [14, 24, 34, 18, 32, 14, 18, 12].map(wch => ({ wch }));

  XLSX.utils.book_append_sheet(wb, summarySheet, 'Сводка');
  XLSX.utils.book_append_sheet(wb, detailsSheet, 'Поставки');
  XLSX.writeFile(wb, `Поставки_${escapeFileNamePart(supplier.name)}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(t('toast.exported'), 'success');
}

function renderSupplierDeliveriesSection(supplierId = editingSupplierId) {
  const ui = ensureSupplierDeliveriesSection();
  if (!ui || !supplierId) return;
  clearChildren(ui.wrap);

  const allRows = collectSupplierShipmentRows(supplierId);
  const recipientOptions = getSupplierRecipientOptions(allRows);
  const productOptions = getSupplierProductOptions(allRows);
  if (supplierDeliveriesRecipientFilter && !recipientOptions.some(opt => opt.searchText.toLowerCase().includes(String(supplierDeliveriesRecipientFilter).trim().toLowerCase()))) {
    supplierDeliveriesRecipientFilter = '';
  }
  if (supplierDeliveriesProductFilter && !productOptions.some(opt => opt.searchText.toLowerCase().includes(String(supplierDeliveriesProductFilter).trim().toLowerCase()))) {
    supplierDeliveriesProductFilter = '';
  }

  if (ui.recipientFilter) {
    const recipientList = document.getElementById('supplierDeliveriesRecipientFilterOptions');
    if (recipientList) {
      recipientList.innerHTML = recipientOptions.map(option => {
        const label = option.address ? `${option.name} — ${option.address}` : option.name;
        return `<option value="${label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`;
      }).join('');
    }
    ui.recipientFilter.value = supplierDeliveriesRecipientFilter;
    ui.recipientFilter.oninput = () => {
      supplierDeliveriesRecipientFilter = ui.recipientFilter.value || '';
      renderSupplierDeliveriesSection(supplierId);
    };
    ui.recipientFilter.disabled = recipientOptions.length === 0;
    enhancePredictiveInput(ui.recipientFilter, {
      listId: 'supplierDeliveriesRecipientFilterOptions',
      options: recipientOptions.map(option => option.address ? `${option.name} — ${option.address}` : option.name),
      icon: '👤',
      minWidth: '220px',
    });
  }

  if (ui.productFilter) {
    const productList = document.getElementById('supplierDeliveriesProductFilterOptions');
    if (productList) {
      productList.innerHTML = productOptions.map(option => {
        const label = option.code ? `${option.name} — ${option.code}` : option.name;
        return `<option value="${label.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`;
      }).join('');
    }
    ui.productFilter.value = supplierDeliveriesProductFilter;
    ui.productFilter.oninput = () => {
      supplierDeliveriesProductFilter = ui.productFilter.value || '';
      renderSupplierDeliveriesSection(supplierId);
    };
    ui.productFilter.disabled = productOptions.length === 0;
    enhancePredictiveInput(ui.productFilter, {
      listId: 'supplierDeliveriesProductFilterOptions',
      options: productOptions.map(option => option.code ? `${option.name} — ${option.code}` : option.name),
      icon: '📦',
      minWidth: '240px',
    });
  }

  const rows = filterSupplierShipmentRows(allRows);
  const recipientGroups = groupSupplierShipmentRowsByRecipient(rows);
  const totalQty = rows.reduce((sum, row) => sum + row.qty, 0);
  const shipmentCount = new Set(rows.map(row => row.shipmentId)).size;

  if (ui.meta) {
    ui.meta.textContent = rows.length > 0
      ? t('suppliers.deliveriesMeta', {
          recipients: recipientGroups.length,
          shipments: shipmentCount,
          qty: fmtQty(totalQty),
        })
      : t('suppliers.deliveriesEmptyShort');
  }

  if (ui.exportBtn) {
    ui.exportBtn.disabled = rows.length === 0;
    ui.exportBtn.classList.toggle('opacity-50', rows.length === 0);
    ui.exportBtn.classList.toggle('cursor-not-allowed', rows.length === 0);
    ui.exportBtn.textContent = supplierDeliveriesExportLoading
      ? '⏳ ' + t('actions.downloading')
      : '📥 ' + t('suppliers.exportDeliveries');
    ui.exportBtn.onclick = () => exportSupplierDeliveries(supplierId, rows);
  }

  if (allRows.length === 0) {
    ui.wrap.appendChild(el('div', {
      className: 'rounded-xl border border-dashed border-white/15 p-5 text-center text-sm text-slate-500',
    }, t('suppliers.deliveriesEmpty')));
    return;
  }

  if (rows.length === 0) {
    ui.wrap.appendChild(el('div', {
      className: 'rounded-xl border border-dashed border-white/15 p-5 text-center text-sm text-slate-500',
    }, t('suppliers.deliveriesNoMatch')));
    return;
  }

  recipientGroups.forEach(group => {
    const card = el('div', { className: 'rounded-2xl border border-white/10 bg-white/[0.04] overflow-hidden' });
    const header = el('div', { className: 'flex items-start justify-between gap-3 px-4 py-3 border-b border-white/10 bg-white/[0.03]' });

    const titleWrap = el('div', { className: 'min-w-0' });
    titleWrap.appendChild(el('p', { className: 'text-sm font-semibold text-white truncate' }, group.recipientName));
    if (group.recipientAddress) {
      titleWrap.appendChild(el('p', { className: 'text-xs text-slate-500 mt-0.5 truncate' }, '📍 ' + group.recipientAddress));
    }
    header.appendChild(titleWrap);

    const badgeWrap = el('div', { className: 'text-right shrink-0' });
    badgeWrap.appendChild(el('p', { className: 'text-sm font-bold text-cyan-400 tabular-nums' }, fmtQty(group.totalQty) + ' шт.'));
    badgeWrap.appendChild(el('p', { className: 'text-[11px] text-slate-500' }, t('suppliers.deliveriesRowsCount', { count: group.rows.length })));
    header.appendChild(badgeWrap);
    card.appendChild(header);

    const scroll = el('div', { className: 'overflow-x-auto' });
    const table = el('table', { className: 'w-full text-xs text-slate-300' });
    const thead = el('thead');
    const hrow = el('tr', { className: 'border-b border-white/[0.07] bg-slate-900/40' });
    [
      ['Источник', 'text-left whitespace-nowrap'],
      ['Дата', 'text-left whitespace-nowrap'],
      ['Товар', 'text-left min-w-[180px]'],
      ['Код', 'text-left whitespace-nowrap'],
      ['Заявка', 'text-left whitespace-nowrap'],
      ['Кол-во', 'text-right whitespace-nowrap'],
    ].forEach(([label, cls]) => {
      hrow.appendChild(el('th', {
        className: `px-3 py-2 font-semibold text-[10px] uppercase tracking-wide text-slate-500 ${cls}`,
      }, label));
    });
    thead.appendChild(hrow);
    table.appendChild(thead);

    const tbody = el('tbody');
    group.rows.forEach((row, index) => {
      const tr = el('tr', {
        className: 'border-b border-white/[0.05] ' + (index % 2 === 0 ? '' : 'bg-white/[0.012]') + ' hover:bg-white/[0.03] transition',
      });
      const sourceTd = el('td', { className: 'px-3 py-2 whitespace-nowrap' });
      sourceTd.appendChild(buildDeliverySourceBadge(row.sourceType));
      tr.appendChild(sourceTd);
      tr.appendChild(el('td', { className: 'px-3 py-2 whitespace-nowrap text-slate-400' }, fmtDate(row.shipmentDate)));

      const productTd = el('td', { className: 'px-3 py-2 min-w-[180px]' });
      productTd.appendChild(el('span', { className: 'block font-medium text-white truncate', title: row.productName }, row.productName));
      if (row.category) {
        productTd.appendChild(el('span', { className: 'block text-[10px] text-slate-500 truncate', title: row.category }, row.category));
      }
      tr.appendChild(productTd);

      tr.appendChild(el('td', { className: 'px-3 py-2 font-mono text-cyan-400 whitespace-nowrap text-[11px]' }, row.productCode || '—'));
      tr.appendChild(el('td', { className: 'px-3 py-2 whitespace-nowrap text-slate-300' }, row.orderNum || '—'));
      tr.appendChild(el('td', { className: 'px-3 py-2 text-right font-bold text-white tabular-nums whitespace-nowrap' }, fmtQty(row.qty) + ' шт.'));
      tbody.appendChild(tr);
    });

    const totalTr = el('tr', { className: 'border-t border-white/10 bg-slate-800/30' });
    totalTr.appendChild(el('td', { className: 'px-3 py-2 text-xs font-semibold text-slate-400', colspan: '5' }, 'Итого по получателю'));
    totalTr.appendChild(el('td', { className: 'px-3 py-2 text-right text-xs font-bold text-cyan-400 tabular-nums' }, fmtQty(group.totalQty) + ' шт.'));
    tbody.appendChild(totalTr);

    table.appendChild(tbody);
    scroll.appendChild(table);
    card.appendChild(scroll);
    ui.wrap.appendChild(card);
  });
}

// ─── List render ──────────────────────────────────────────────────

function renderSuppliersList() {
  const container = $('suppliersList');
  if (!container) return;
  clearChildren(container);

  const suppliers = state.suppliers || [];

  if (suppliers.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-16 text-center' });
    empty.appendChild(el('span', { className: 'text-5xl mb-4' }, '🏢'));
    empty.appendChild(el('p', { className: 'text-sm text-slate-500' }, t('suppliers.empty')));
    container.appendChild(empty);
    return;
  }

  const grid = el('div', { className: 'flex flex-col gap-3' });

  suppliers.forEach(sup => {
    const contractCount = (state.contracts || []).filter(c => c.supplierId === sup.id).length;

    const card = el('div', {
      className: 'rounded-2xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/[0.07] cursor-pointer',
    });

    // Top row
    const top = el('div', { className: 'flex items-start justify-between gap-3 mb-2' });
    const nameWrap = el('div', { className: 'flex-1 min-w-0' });
    nameWrap.appendChild(el('h3', { className: 'text-base font-semibold text-white truncate' }, sup.name));
    if (sup.inn) {
      nameWrap.appendChild(el('p', { className: 'text-xs text-slate-500 mt-0.5' }, 'ИНН: ' + sup.inn));
    }
    if (sup.address) {
      nameWrap.appendChild(el('p', { className: 'text-xs text-slate-500 mt-0.5 truncate' }, '📍 ' + sup.address));
    }
    // First phone
    const phones = sup.phones || [];
    if (phones.length > 0 && phones[0].value) {
      nameWrap.appendChild(el('p', { className: 'text-xs text-slate-500 mt-0.5' }, '📞 ' + phones[0].value));
    }
    top.appendChild(nameWrap);

    if (contractCount > 0) {
      top.appendChild(el('span', {
        className: 'rounded-lg bg-cyan-400/15 px-2 py-0.5 text-xs font-bold text-cyan-400 tabular-nums shrink-0',
      }, t('suppliers.contractCount', { count: contractCount })));
    }
    card.appendChild(top);

    // Small action buttons
    const actions = el('div', { className: 'flex gap-1 justify-end' });
    actions.appendChild(el('button', {
      className: 'rounded-xl p-2 text-slate-500 hover:bg-cyan-400/10 hover:text-cyan-400 transition',
      'aria-label': t('actions.edit'),
      title: t('actions.edit'),
      onClick: (e) => { e.stopPropagation(); openEditSupplier(sup.id); },
    }, '✎'));
    actions.appendChild(el('button', {
      className: 'rounded-xl p-2 text-slate-500 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': t('actions.delete'),
      title: t('actions.delete'),
      onClick: (e) => { e.stopPropagation(); handleDeleteSupplier(sup); },
    }, '✕'));
    card.appendChild(actions);

    card.addEventListener('click', () => openViewSupplier(sup.id));

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

// ─── Open / close edit panel ──────────────────────────────────────

function openEditSupplier(supplierId) {
  const sup = getSupplierById(supplierId);
  if (!sup) return;
  _supplierReadonly = false;
  editingSupplierId = supplierId;
  editingPhones     = (sup.phones    || []).map(p => ({ ...p }));
  editingPersons    = (sup.persons   || []).map(p => ({ ...p }));

  $('editSupplierName').value    = sup.name    || '';
  $('editSupplierInn').value     = sup.inn     || '';
  $('editSupplierAddress').value = sup.address || '';
  $('editSupplierEmail').value   = sup.email   || '';

  renderPhonesList();
  renderPersonsList();
  renderLinkedContractsList();
  renderSupplierDeliveriesSection(sup.id);

  $('supplierListPanel').classList.add('hidden');
  $('supplierEditPanel').classList.remove('hidden');
  setTimeout(() => $('editSupplierName')?.focus(), 100);
}

let _supplierReadonly = false;

function openViewSupplier(supplierId) {
  openEditSupplier(supplierId);
  setSupplierCardReadonly(true);
}

function setSupplierCardReadonly(readonly) {
  _supplierReadonly = readonly;
  const panel = $('supplierEditPanel');
  if (!panel) return;
  panel.querySelectorAll('input, select, textarea').forEach(inp => {
    inp.disabled = readonly;
    inp.style.opacity = readonly ? '0.7' : '';
    inp.style.cursor = readonly ? 'default' : '';
  });
  const saveBtn = $('supplierEditSaveBtn');
  const editBtn = $('supplierEditEditBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', readonly);
  if (editBtn) editBtn.classList.toggle('hidden', !readonly);
  // Hide add/remove buttons for phones, persons
  panel.querySelectorAll(
    '#addPhoneBtn, #addPersonBtn, [aria-label="' + t('actions.delete') + '"]'
  ).forEach(b => {
    b.classList.toggle('hidden', readonly);
  });
}

function closeEditSupplier() {
  editingSupplierId = null;
  editingPhones     = [];
  editingPersons    = [];
  $('supplierEditPanel').classList.add('hidden');
  $('supplierListPanel').classList.remove('hidden');
  renderSuppliersList();
}

// ─── Save ─────────────────────────────────────────────────────────

function handleSaveSupplier() {
  const name = ($('editSupplierName').value || '').trim();
  if (!name) {
    showToast(t('form.required'), 'error');
    $('editSupplierName').focus();
    return;
  }

  const phones    = collectMulti('supplierPhonesWrap',  'phone-value');
  const persons   = collectMulti('supplierPersonsWrap', 'person-value');

  const sup = getSupplierById(editingSupplierId);
  if (sup) {
    sup.name     = name;
    sup.inn      = ($('editSupplierInn').value     || '').trim();
    sup.address  = ($('editSupplierAddress').value || '').trim();
    sup.email    = ($('editSupplierEmail').value   || '').trim();
    sup.phones    = phones;
    sup.persons   = persons;
  }

  saveToStorage();
  showToast(t('toast.saved'), 'success');
  closeEditSupplier();
}

// ─── Multi-value helpers (phones / persons) ───────────────────────

/** Render a list of removable text inputs inside a wrapper element */
function renderMultiList({ wrapperId, items, dataProp, placeholder, addBtnId }) {
  const wrap = $(wrapperId);
  if (!wrap) return;
  clearChildren(wrap);

  if (items.length === 0) {
    wrap.appendChild(el('p', {
      className: 'text-xs text-slate-500 italic py-1',
    }, t('suppliers.noneYet')));
    return;
  }

  items.forEach((item, idx) => {
    const row = el('div', { className: 'flex gap-2 items-center' });

    const input = el('input', {
      type: dataProp === 'phone-value' ? 'tel' : 'text',
      className: 'flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      placeholder,
      'data-multi': dataProp,
      'data-idx': String(idx),
    });
    input.value = item.value || '';

    const removeBtn = el('button', {
      type: 'button',
      className: 'rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-slate-400 transition hover:bg-red-500/15 hover:text-red-400 shrink-0',
      'aria-label': t('actions.delete'),
      onClick: () => {
        items.splice(idx, 1);
        renderMultiList({ wrapperId, items, dataProp, placeholder, addBtnId });
      },
    }, '✕');

    row.appendChild(input);
    row.appendChild(removeBtn);
    wrap.appendChild(row);
  });
}

function collectMulti(wrapperId, dataProp) {
  const wrap = $(wrapperId);
  if (!wrap) return [];
  return [...wrap.querySelectorAll(`[data-multi="${dataProp}"]`)].map((inp, idx) => ({
    id: uid(),
    value: inp.value.trim(),
  })).filter(x => x.value);
}

function renderPhonesList() {
  renderMultiList({
    wrapperId: 'supplierPhonesWrap',
    items: editingPhones,
    dataProp: 'phone-value',
    placeholder: '+7 (999) 000-00-00',
    addBtnId: 'addPhoneBtn',
  });
}

function renderPersonsList() {
  renderMultiList({
    wrapperId: 'supplierPersonsWrap',
    items: editingPersons,
    dataProp: 'person-value',
    placeholder: 'Иванов Иван Иванович',
    addBtnId: 'addPersonBtn',
  });
}

// ─── Contracts list (read-only, auto-synced from state.contracts) ─

/** Render read-only list of contracts linked to current supplier */
export function renderLinkedContractsList(supplierId) {
  const id = supplierId ?? editingSupplierId;
  const wrap = $('contractsListWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const linked = (state.contracts || []).filter(c => c.supplierId === id);
  const fmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  if (linked.length === 0) {
    wrap.appendChild(el('div', {
      className: 'rounded-xl border border-dashed border-white/15 p-5 text-center',
    }, el('p', { className: 'text-sm text-slate-500' },
      'Контрактов пока нет — добавьте контракт в разделе «Контракты»')));
    return;
  }

  linked.forEach(contract => {
    const card = el('div', {
      className: 'rounded-xl border border-white/10 bg-white/5 px-4 py-3 space-y-1.5 cursor-pointer transition hover:bg-white/[0.09] hover:border-cyan-400/25 group',
    });

    // Number + date
    const header = el('div', { className: 'flex items-center gap-2 flex-wrap' });
    const numSpan = el('span', {
      className: 'text-sm font-semibold text-cyan-400 flex-1',
    }, contract.number ? `№ ${contract.number}` : t('contracts.noNumber'));
    header.appendChild(numSpan);
    if (contract.date) {
      header.appendChild(el('span', { className: 'text-xs text-slate-500' }, contract.date));
    }
    // «Открыть →» hint
    header.appendChild(el('span', {
      className: 'text-xs text-cyan-400 opacity-0 group-hover:opacity-100 transition ml-auto shrink-0',
    }, 'Открыть →'));
    card.appendChild(header);

    if (contract.title) {
      card.appendChild(el('p', { className: 'text-xs text-slate-300 truncate' }, contract.title));
    }

    // Price + positions + programs
    const itemCount = (contract.items || []).filter(i => i.name && i.name.trim()).length;
    const meta = el('div', { className: 'flex gap-3 text-xs text-slate-500 flex-wrap' });
    meta.appendChild(el('span', { className: 'tabular-nums text-slate-400' },
      fmt.format(Number(contract.totalPrice) || 0) + ' ₽'));
    if (itemCount > 0) meta.appendChild(el('span', {}, `${itemCount} ${t('contracts.positions')}`));
    const progNames = (contract.programs || []).map(p => p.name).filter(Boolean).join(', ');
    if (progNames) meta.appendChild(el('span', {}, '📋 ' + progNames));
    card.appendChild(meta);

    // Click → open contract card in Contracts module
    card.addEventListener('click', () => {
      // Close suppliers modal first, then open contracts modal at this contract
      import('./contracts-view.js').then(m => {
        closeSuppliersModal();
        m.openContractsModal();
        // Small delay to let the contracts list render before opening the card
        setTimeout(() => {
          m.openContractView(contract.id);
        }, 60);
      });
    });

    wrap.appendChild(card);
  });
}

// ─── Delete supplier ──────────────────────────────────────────────

function handleDeleteSupplier(sup) {
  if (!confirm(t('suppliers.confirmDelete') + '\n' + sup.name)) return;
  state.suppliers = (state.suppliers || []).filter(s => s.id !== sup.id);
  saveToStorage();
  showToast(t('toast.deleted'), 'success');
  renderSuppliersList();
}

// ─── Add supplier ─────────────────────────────────────────────────

function handleAddSupplier() {
  const input = $('newSupplierInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  if (!state.suppliers) state.suppliers = [];
  const sup = {
    id: nextSupplierId(),
    name,
    inn:       '',
    address:   '',
    email:     '',
    phones:    [],
    persons:   [],
    contracts: [],
  };
  state.suppliers.push(sup);
  saveToStorage();
  showToast(t('suppliers.added'), 'success');
  input.value = '';
  openEditSupplier(sup.id);
}

// ─── Open / Close modal ───────────────────────────────────────────

export function openSuppliersModal() {
  const overlay = $('suppliersModal');
  if (!overlay) return;
  $('supplierListPanel').classList.remove('hidden');
  $('supplierEditPanel').classList.add('hidden');
  renderSuppliersList();
  overlay.classList.add('open');
  setTimeout(() => $('newSupplierInput')?.focus(), 100);
}

export function closeSuppliersModal() {
  editingSupplierId = null;
  const overlay = $('suppliersModal');
  if (overlay) overlay.classList.remove('open');
}

// ─── Init ─────────────────────────────────────────────────────────

export function initSuppliersView() {
  const overlay = $('suppliersModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeSuppliersModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      if (!$('supplierEditPanel').classList.contains('hidden')) {
        closeEditSupplier();
      } else {
        closeSuppliersModal();
      }
    }
  });

  $('addSupplierBtn')?.addEventListener('click', handleAddSupplier);
  $('newSupplierInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleAddSupplier(); }
  });
  $('suppliersCloseBtn')?.addEventListener('click', closeSuppliersModal);
  $('supplierEditBackBtn')?.addEventListener('click', closeEditSupplier);
  $('supplierEditSaveBtn')?.addEventListener('click', handleSaveSupplier);
  $('supplierEditEditBtn')?.addEventListener('click', () => setSupplierCardReadonly(false));

  // Add phone
  $('addPhoneBtn')?.addEventListener('click', () => {
    editingPhones.push(makePhone());
    renderPhonesList();
  });

  // Add contact person
  $('addPersonBtn')?.addEventListener('click', () => {
    editingPersons.push(makePerson());
    renderPersonsList();
  });

  // Note: contracts are managed in the Contracts module and auto-appear here
}
