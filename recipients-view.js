/**
 * Recipients view.
 * Panel 1: list of recipients.
 * Panel 2: full-screen edit card (info + readiness text + needs expandable panel).
 * Needs panel: table with №, code, name, category, qty, delivered, assembled + sort/filter/export.
 *
 * «delivered» is READ-ONLY — populated automatically by shipments.
 * Needs are saved directly to state on each cell change; handleSaveRecipient only saves card fields
 * and, when the panel is open, merges DOM-visible qty/assembled INTO existing needs (never replaces).
 *
 * Delivery history: per-product breakdown of all shipments — date, order, qty.
 *
 * RULE: assembled ≤ delivered. Enforced both in manual input and when syncing from assembly acts.
 */

import { $, el, clearChildren } from './dom.js';
import { state, getRecipientById, addRecipient, deleteRecipient, updateRecipient, updateRecipientNeeds, getProgramNames, getAssemblyFifoByOrders, calcAssembledBySupplier, getRecipientAddresses, getLotNumbersForProduct, hasProductColorVariants, getProductColorVariants, normalizeNeedEntry, getProductVariantByKey, getContractItemCodesForProduct, getFullVariantCodesForProduct } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { makeColumnsResizable } from './resizable-cols.js';
import { attachFrozenManager, applyFrozenTable } from './frozen-table.js';
import { openProductForm } from './product-form.js';
import { enhancePredictiveInput } from './filters.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

function normalizeRecipientAddressNeedKey(address = '') {
  return String(address || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

function normalizeRecipientAddressNeeds(addressNeeds, recipient = null) {
  const source = addressNeeds && typeof addressNeeds === 'object' ? addressNeeds : {};
  const knownAddresses = getRecipientAddresses(recipient);
  const knownByKey = new Map(
    knownAddresses.map(address => [normalizeRecipientAddressNeedKey(address), address])
  );
  const result = {};

  Object.entries(source).forEach(([rawKey, rawValue]) => {
    if (!rawValue || typeof rawValue !== 'object') return;

    const sourceAddress = typeof rawValue.address === 'string'
      ? rawValue.address
      : (knownByKey.get(normalizeRecipientAddressNeedKey(rawKey)) || rawKey);
    const normalizedAddress = String(sourceAddress || '').trim();
    if (!normalizedAddress) return;

    const key = normalizeRecipientAddressNeedKey(normalizedAddress);
    if (!key) return;

    const rawNeeds = rawValue.needs && typeof rawValue.needs === 'object'
      ? rawValue.needs
      : rawValue;

    const nextNeeds = {};
    Object.entries(rawNeeds || {}).forEach(([productId, entry]) => {
      const product = state.products.find(p => String(p.id) === String(productId)) || null;
      nextNeeds[productId] = normalizeNeedEntry(entry, product);
    });

    result[key] = {
      address: knownByKey.get(key) || normalizedAddress,
      needs: nextNeeds,
    };
  });

  return result;
}

function seedRecipientAddressNeedsFromAggregate(recipient) {
  if (!recipient || typeof recipient !== 'object') return false;

  const addresses = getRecipientAddresses(recipient);
  if (addresses.length === 0) return false;

  if (!recipient.addressNeeds || typeof recipient.addressNeeds !== 'object') {
    recipient.addressNeeds = {};
  }
  recipient.addressNeeds = normalizeRecipientAddressNeeds(recipient.addressNeeds, recipient);

  const hasAddressData = Object.values(recipient.addressNeeds).some((entry) => {
    const needs = entry?.needs && typeof entry.needs === 'object' ? entry.needs : null;
    return !!(needs && Object.keys(needs).length > 0);
  });
  if (hasAddressData) return false;

  const aggregateNeeds = recipient.needs && typeof recipient.needs === 'object'
    ? recipient.needs
    : {};
  const productIds = Object.keys(aggregateNeeds);
  if (productIds.length === 0) return false;

  const firstAddress = addresses[0];
  const firstKey = normalizeRecipientAddressNeedKey(firstAddress);
  if (!firstKey) return false;

  const nextNeeds = {};
  productIds.forEach((productId) => {
    const product = state.products.find(p => String(p.id) === String(productId)) || null;
    nextNeeds[productId] = normalizeNeedEntry(aggregateNeeds[productId], product);
  });

  recipient.addressNeeds = {
    [firstKey]: {
      address: firstAddress,
      needs: nextNeeds,
    },
  };
  return true;
}

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

// ─── Delivery history helpers ────────────────────────────────────

/**
 * Builds a delivery history for a recipient.
 * Returns Map<productId, Array<{ date, orderNum, orderId, qty, supplierName }>> sorted by date asc.
 *
 * Source: state.shipments — each shipment.rows[].recipients[] entry.
 *
 * Supplier resolution chain (per shipment row):
 *  1. warehouseEntry.supplierId  (direct — most reliable)
 *  2. warehouseEntry.contractId → contract.supplierId
 *  3. row.orderId → order.contractId → contract.supplierId
 *
 * Order number resolution (per shipment row):
 *  The row's orderId points to the warehouse entry's order (the purchase order).
 *  We resolve the number from state.orders by that id.
 *  The orderKey encodes the exact (codeKey, orderId) pair used at shipment time —
 *  we extract orderId from it as the most reliable source.
 */
function getDeliveryHistoryForRecipient(recipientId) {
  const history = new Map(); // key -> [{ date, orderNum, orderId, qty, supplierName }]

  // Helper: find supplier name by supplierId
  function resolveSupplierName(supplierId) {
    if (!supplierId) return '';
    const s = (state.suppliers || []).find(x => x.id === supplierId);
    return s ? (s.name || '') : '';
  }

  // Helper: find supplier name via contractId
  function resolveSupplierByContract(contractId) {
    if (!contractId) return '';
    const c = (state.contracts || []).find(x => x.id === contractId);
    return c ? resolveSupplierName(c.supplierId) : '';
  }

  for (const shipment of (state.shipments || [])) {
    const date = shipment.date || '';

    for (const row of (shipment.rows || [])) {
      const recEntry = (row.recipients || []).find(r => r.recipientId === recipientId);
      if (!recEntry || !recEntry.qty || recEntry.qty <= 0) continue;

      // ── Resolve productId from catalog ──────────────────────────
      const code = (row.productCode || '').trim().toLowerCase();
      const name = (row.productName || '').trim().toLowerCase();
      let prod = row.productId
        ? state.products.find(p => p.id === row.productId)
        : null;
      if (!prod && code) prod = state.products.find(p => (p.code || '').trim().toLowerCase() === code);
      if (!prod && name) prod = state.products.find(p => (p.name || '').trim().toLowerCase() === name);

      const productId = prod ? prod.id : null;
      const key = productId !== null ? productId : ('name:' + (row.productName || ''));
      if (!history.has(key)) history.set(key, []);

      // ── Resolve orderId ─────────────────────────────────────────
      // Primary: extract from orderKey (format: "codeKey::orderId")
      // because orderKey is set at save time and is the most accurate link
      // to the warehouse entry's order.
      let rowOrderId = null;
      if (row.orderKey) {
        const parts = row.orderKey.split('::');
        if (parts.length === 2 && parts[1] !== 'noorder') {
          const parsed = Number(parts[1]);
          if (!isNaN(parsed) && parsed > 0) rowOrderId = parsed;
        }
      }
      // Fallback: use row.orderId saved at shipment time
      if (rowOrderId === null) rowOrderId = row.orderId ?? null;

      // ── Resolve order number ────────────────────────────────────
      const order = rowOrderId ? (state.orders || []).find(o => o.id === rowOrderId) : null;
      let resolvedOrderNum;
      if (order && order.orderNumber) {
        resolvedOrderNum = order.orderNumber;
      } else if (row.orderNum) {
        resolvedOrderNum = row.orderNum;
      } else if (rowOrderId) {
        resolvedOrderNum = 'Заявка #' + rowOrderId;
      } else {
        resolvedOrderNum = '—';
      }

      // ── Resolve supplier ────────────────────────────────────────
      // 1. Find the warehouse entry that matches this row's (codeKey, orderId)
      //    and read its supplierId / contractId directly.
      let supplierName = '';
      const ck = row.codeKey || code || name;
      const matchingEntry = (state.warehouseEntries || []).find(e => {
        // Match by orderId first
        if (rowOrderId && e.orderId !== rowOrderId) return false;
        // Then match by product code/name inside entry.items
        const items = Array.isArray(e.items) ? e.items : [];
        if (items.length > 0) {
          return items.some(item => {
            const ic = (item.productCode || '').trim().toLowerCase();
            const iname = (item.productName || '').trim().toLowerCase();
            return (ck && ic && ic === ck) || (ck && iname && iname === ck);
          });
        }
        // Old-format entry: single product
        const ec = (e.productCode || '').trim().toLowerCase();
        const en = (e.productName || '').trim().toLowerCase();
        return (ck && ec && ec === ck) || (ck && en && en === ck);
      });

      if (matchingEntry) {
        // Path 1: direct supplierId on the entry
        if (matchingEntry.supplierId) {
          supplierName = resolveSupplierName(matchingEntry.supplierId);
        }
        // Path 2: via entry's contractId
        if (!supplierName && matchingEntry.contractId) {
          supplierName = resolveSupplierByContract(matchingEntry.contractId);
        }
      }
      // Path 3: via order → contractId (if still not resolved)
      if (!supplierName && order && order.contractId) {
        supplierName = resolveSupplierByContract(order.contractId);
      }

      history.get(key).push({
        date,
        sourceType:  'warehouse',
        orderNum:    resolvedOrderNum,
        orderId:     rowOrderId,
        qty:         Number(recEntry.qty),
        productCode: row.productCode || '',
        productName: row.productName || '',
        supplierName,
      });
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    const date = delivery.date || delivery.createdAt || '';
    const orderId = delivery.orderId ?? null;
    const order = orderId ? (state.orders || []).find(o => o.id === orderId) : null;
    const orderNum = order?.orderNumber || delivery.orderNumber || (orderId ? ('Заявка #' + orderId) : '—');
    const supplierName = delivery.supplierName || '';

    for (const row of (delivery.rows || [])) {
      if (String(row.recipientId) !== String(recipientId)) continue;
      const qty = Number(row.actualQty) || 0;
      if (qty <= 0) continue;

      const code = (row.productCode || '').trim().toLowerCase();
      const name = (row.productName || '').trim().toLowerCase();
      let prod = row.productId
        ? state.products.find(p => p.id === row.productId)
        : null;
      if (!prod && code) prod = state.products.find(p => (p.code || '').trim().toLowerCase() === code);
      if (!prod && name) prod = state.products.find(p => (p.name || '').trim().toLowerCase() === name);

      const productId = prod ? prod.id : null;
      const key = productId !== null ? productId : ('name:' + (row.productName || ''));
      if (!history.has(key)) history.set(key, []);

      history.get(key).push({
        date,
        sourceType: 'direct',
        orderNum,
        orderId,
        qty,
        productCode: row.productCode || '',
        productName: row.productName || '',
        supplierName,
      });
    }
  }

  // Sort each product's entries by date ascending
  history.forEach(entries => {
    entries.sort((a, b) => (a.date || '').localeCompare(b.date || ''));
  });

  return history;
}

let editingRecipientId = null;
let _recipientNeedsSyncBound = false;

function getWorkingRecipientAddresses(recipient) {
  if (editingRecipientId !== recipient?.id) return getRecipientAddresses(recipient);
  const domAddresses = collectRecipientAddressesFromDom();
  return domAddresses.length > 0 ? domAddresses : getRecipientAddresses(recipient);
}

function getRecipientAddressNeedsMap(recipient) {
  if (!recipient) return {};
  if (!recipient.addressNeeds || typeof recipient.addressNeeds !== 'object') {
    recipient.addressNeeds = {};
  }
  recipient.addressNeeds = normalizeRecipientAddressNeeds(recipient.addressNeeds, recipient);
  return recipient.addressNeeds;
}

function getRecipientAddressNeedEntry(recipient, address, product) {
  const key = normalizeRecipientAddressNeedKey(address);
  if (!key || !recipient || !product) return normalizeNeedEntry(null, product);
  const addressNeeds = getRecipientAddressNeedsMap(recipient);
  const entry = addressNeeds[key]?.needs?.[product.id];
  if (entry) return normalizeNeedEntry(entry, product);

  const addresses = getWorkingRecipientAddresses(recipient);
  const hasAnyAddressProductData = Object.values(addressNeeds).some((addressEntry) => {
    const needs = addressEntry?.needs && typeof addressEntry.needs === 'object' ? addressEntry.needs : null;
    return !!(needs && needs[product.id]);
  });
  const isFirstAddress = normalizeRecipientAddressNeedKey(addresses[0] || '') === key;
  if (isFirstAddress && !hasAnyAddressProductData) {
    return normalizeNeedEntry(recipient.needs?.[product.id], product);
  }

  return normalizeNeedEntry(null, product);
}

function mergeNeedEntry(target, source) {
  const nextTarget = target || { qty: 0, delivered: 0, assembled: 0 };
  nextTarget.qty = (Number(nextTarget.qty) || 0) + (Number(source.qty) || 0);
  nextTarget.delivered = (Number(nextTarget.delivered) || 0) + (Number(source.delivered) || 0);
  nextTarget.assembled = (Number(nextTarget.assembled) || 0) + (Number(source.assembled) || 0);

  if (source.variants && typeof source.variants === 'object') {
    if (!nextTarget.variants || typeof nextTarget.variants !== 'object') nextTarget.variants = {};
    Object.entries(source.variants).forEach(([variantKey, variantEntry]) => {
      if (!nextTarget.variants[variantKey]) {
        nextTarget.variants[variantKey] = {
          id: variantEntry.id || variantKey,
          colorCode: variantEntry.colorCode || '',
          qty: 0,
          delivered: 0,
          assembled: 0,
        };
      }
      nextTarget.variants[variantKey].qty += Number(variantEntry.qty) || 0;
      nextTarget.variants[variantKey].delivered += Number(variantEntry.delivered) || 0;
      nextTarget.variants[variantKey].assembled += Number(variantEntry.assembled) || 0;
    });
  }

  return nextTarget;
}

function rebuildRecipientNeedTotalsFromAddresses(recipient) {
  if (!recipient) return;

  const currentNeeds = recipient.needs || {};
  const nextNeeds = {};
  Object.keys(currentNeeds).forEach(pid => {
    const product = state.products.find(p => String(p.id) === String(pid)) || null;
    nextNeeds[pid] = normalizeNeedEntry(currentNeeds[pid], product);
  });

  const aggregateByProduct = new Map();
  const touchedProducts = new Set();
  const addressNeeds = getRecipientAddressNeedsMap(recipient);

  Object.values(addressNeeds).forEach((addressEntry) => {
    const productNeeds = addressEntry?.needs || {};
    Object.entries(productNeeds).forEach(([productId, entry]) => {
      const product = state.products.find(p => String(p.id) === String(productId)) || null;
      const normalized = normalizeNeedEntry(entry, product);
      touchedProducts.add(String(productId));
      const merged = aggregateByProduct.get(String(productId)) || { qty: 0, delivered: 0, assembled: 0 };
      aggregateByProduct.set(String(productId), mergeNeedEntry(merged, normalized));
    });
  });

  touchedProducts.forEach((productId) => {
    const aggregated = aggregateByProduct.get(String(productId));
    if (!aggregated || ((Number(aggregated.qty) || 0) === 0 && (Number(aggregated.delivered) || 0) === 0 && (Number(aggregated.assembled) || 0) === 0)) {
      delete nextNeeds[productId];
      return;
    }
    nextNeeds[productId] = aggregated;
  });

  recipient.needs = nextNeeds;
  updateRecipientNeeds(recipient.id, nextNeeds);
}

function pruneRecipientAddressNeeds(recipient, addresses) {
  if (!recipient) return;
  const allowedKeys = new Set((addresses || []).map(address => normalizeRecipientAddressNeedKey(address)).filter(Boolean));
  const nextAddressNeeds = {};
  Object.values(getRecipientAddressNeedsMap(recipient)).forEach((entry) => {
    const address = String(entry?.address || '').trim();
    const key = normalizeRecipientAddressNeedKey(address);
    if (!allowedKeys.has(key)) return;
    nextAddressNeeds[key] = {
      address,
      needs: entry?.needs || {},
    };
  });
  recipient.addressNeeds = nextAddressNeeds;
}

function formatContractCodes(codes = []) {
  return [...new Set((codes || []).map(code => String(code || '').trim()).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function dispatchNeedsChanged(recipientId, productId) {
  window.dispatchEvent(new CustomEvent('recipient-needs-changed', {
    detail: { recipientId, productId },
  }));
}

// ── Needs panel state ────────────────────────────────────────────
let needsPanelOpen = false;
let needsSort = { key: 'number', dir: 'asc' };
let needsFilter = '';
// Advanced filters
let needsFilterSupplier  = '';
let needsFilterOrder     = '';
let needsFilterDateFrom  = '';
let needsFilterDateTo    = '';
let needsFilterDelivered = 'all'; // 'all' | 'delivered' | 'partial' | 'none'
let needsFilterName      = '';
let needsFilterCategory  = '';
let needsFilterGroup     = '';
let needsAddressFilter   = '';

// Cache of delivery history for current recipient (rebuilt on each renderNeedsTable)
let deliveryHistoryCache = new Map();

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

function buildDeliverySourceBadge(sourceType) {
  const isDirect = sourceType === 'direct';
  return el('span', {
    className: 'inline-flex items-center rounded-lg px-1.5 py-0.5 text-[9px] font-semibold whitespace-nowrap ' +
      (isDirect
        ? 'bg-fuchsia-400/15 text-fuchsia-300'
        : 'bg-cyan-400/15 text-cyan-300'),
  }, isDirect ? t('delivery.badgeDirect') : t('delivery.badgeWarehouse'));
}

function getActiveNeedsAddress(recipient) {
  const addresses = getWorkingRecipientAddresses(recipient);
  if (addresses.length === 0) return '';
  if (needsAddressFilter && addresses.includes(needsAddressFilter)) return needsAddressFilter;
  return addresses[0] || '';
}

function getNeedsQtyForSelectedAddress(rowData, recipient) {
  const selectedAddress = getActiveNeedsAddress(recipient);
  if (!selectedAddress) return rowData.qty || 0;
  const addressKey = normalizeRecipientAddressNeedKey(selectedAddress);
  return Number(rowData.addressValues?.[addressKey]?.qty) || 0;
}

// ─── Recipients List ─────────────────────────────────────────────

function renderRecipientsList() {
  const container = $('recipientsList');
  if (!container) return;
  clearChildren(container);

  if (state.recipients.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-16 text-center' });
    empty.appendChild(el('span', { className: 'text-5xl mb-4' }, '👥'));
    empty.appendChild(el('p', { className: 'text-sm text-slate-500' }, t('recipients.empty')));
    container.appendChild(empty);
    return;
  }

  const grid = el('div', { className: 'flex flex-col gap-3' });

  state.recipients.forEach(rec => {
    const needs = rec.needs || {};
    const needCount = Object.values(needs).reduce((s, n) => s + (typeof n === 'object' ? (n.qty || 0) : (n || 0)), 0);

    const card = el('div', {
      className: 'rounded-2xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/[0.07] cursor-pointer',
    });

    // Top row: name + need badge
    const top = el('div', { className: 'flex items-start justify-between gap-3 mb-2' });
    const nameWrap = el('div', { className: 'flex-1 min-w-0' });
    nameWrap.appendChild(el('h3', { className: 'text-base font-semibold text-white truncate' }, rec.name));
    const recipientAddresses = getRecipientAddresses(rec);
    if (recipientAddresses[0]) {
      const addressLabel = recipientAddresses.length > 1
        ? `📍 ${recipientAddresses[0]} (+${recipientAddresses.length - 1})`
        : `📍 ${recipientAddresses[0]}`;
      nameWrap.appendChild(el('p', {
        className: 'text-xs text-slate-500 mt-0.5 truncate',
        title: recipientAddresses.join('\n'),
      }, addressLabel));
    }
    if (rec.targetProgram) {
      const programLabel = formatProgramLabel(getProgramByIdentity(rec.targetProgram) || rec.targetProgram);
      nameWrap.appendChild(el('p', { className: 'text-xs text-slate-400 mt-0.5 truncate', title: programLabel }, '🎯 ' + programLabel));
    }
    top.appendChild(nameWrap);

    if (needCount > 0) {
      top.appendChild(el('span', {
        className: 'rounded-lg bg-cyan-400/15 px-2 py-0.5 text-xs font-bold text-cyan-400 tabular-nums shrink-0',
      }, t('recipients.needsCount', { count: needCount })));
    }
    card.appendChild(top);

    // Readiness status badge
    if (rec.readinessStatus) {
      const badge = el('div', { className: 'mb-3' });
      badge.appendChild(el('span', {
        className: 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 text-slate-300',
      }, '📋 ' + rec.readinessStatus));
      card.appendChild(badge);
    }

    // Delivered summary badge
    const totalDelivered = Object.values(needs).reduce((s, n) => s + (typeof n === 'object' ? (n.delivered || 0) : 0), 0);
    if (totalDelivered > 0) {
      const dbadge = el('div', { className: 'mb-2' });
      dbadge.appendChild(el('span', {
        className: 'inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1 text-xs font-medium bg-emerald-400/15 text-emerald-400',
      }, '🚚 Доставлено: ' + totalDelivered + ' шт.'));
      card.appendChild(dbadge);
    }

    // Small action buttons (edit + delete)
    const actions = el('div', { className: 'flex gap-1 justify-end' });
    actions.appendChild(el('button', {
      className: 'rounded-xl p-2 text-slate-500 hover:bg-cyan-400/10 hover:text-cyan-400 transition',
      'aria-label': t('actions.edit'),
      title: t('actions.edit'),
      onClick: (e) => { e.stopPropagation(); openEditRecipient(rec.id); },
    }, '✎'));
    actions.appendChild(el('button', {
      className: 'rounded-xl p-2 text-slate-500 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': t('actions.delete'),
      title: t('actions.delete'),
      onClick: (e) => { e.stopPropagation(); handleDeleteRecipient(rec); },
    }, '✕'));
    card.appendChild(actions);

    card.addEventListener('click', () => openViewRecipient(rec.id));

    grid.appendChild(card);
  });

  container.appendChild(grid);
}

// ─── Needs Panel helpers ─────────────────────────────────────────

function buildNeedsRows(recipient) {
  const needs = recipient.needs || {};
  const recipientAddresses = getWorkingRecipientAddresses(recipient);
  return state.products.flatMap(product => {
    const entry = normalizeNeedEntry(needs[product.id], product);
    const baseCodes = formatContractCodes(getContractItemCodesForProduct(product.id, product.name || ''));
    const summaryTotals = getColorSummaryTotals(entry, product);
    const addressValues = Object.fromEntries(
      recipientAddresses.map(address => {
        const addressEntry = getRecipientAddressNeedEntry(recipient, address, product);
        const totals = getColorSummaryTotals(addressEntry, product);
        return [normalizeRecipientAddressNeedKey(address), totals];
      })
    );

    if (!hasProductColorVariants(product)) {
      return [{
        product,
        rowType: 'single',
        variantKey: '',
        colorCode: '',
        codeList: baseCodes,
        codeText: baseCodes.join(', '),
        displayName: product.name || '—',
        qty: entry.qty || 0,
        delivered: entry.delivered || 0,
        assembled: entry.assembled || 0,
        addressValues,
        isVariant: false,
        isSummary: false,
      }];
    }

    const variants = getProductColorVariants(product);
    const summaryCodes = formatContractCodes(
      variants.flatMap(variant => getFullVariantCodesForProduct(product.id, product.name || '', variant.colorCode || ''))
    );
    const summaryRow = {
      product,
      rowType: 'summary',
      variantKey: '',
      colorCode: '',
      codeList: summaryCodes,
      codeText: summaryCodes.join(', '),
      displayName: product.name || '—',
      qty: summaryTotals.qty,
      delivered: summaryTotals.delivered,
      assembled: summaryTotals.assembled,
      addressValues,
      isVariant: false,
      isSummary: true,
    };

    const variantRows = variants.map(variant => {
      const variantEntry = entry.variants?.[variant.id] || { qty: 0, delivered: 0, assembled: 0 };
      const fullCodes = formatContractCodes(getFullVariantCodesForProduct(product.id, product.name || '', variant.colorCode || ''));
      const variantAddressValues = Object.fromEntries(
        recipientAddresses.map(address => {
          const addressEntry = getRecipientAddressNeedEntry(recipient, address, product);
          const addressVariantEntry = addressEntry.variants?.[variant.id] || { qty: 0, delivered: 0, assembled: 0 };
          return [normalizeRecipientAddressNeedKey(address), {
            qty: Number(addressVariantEntry.qty) || 0,
            delivered: Number(addressVariantEntry.delivered) || 0,
            assembled: Number(addressVariantEntry.assembled) || 0,
          }];
        })
      );
      return {
        product,
        rowType: 'variant',
        variantKey: variant.id,
        colorCode: variant.colorCode || '',
        codeList: fullCodes,
        codeText: fullCodes.join(', '),
        displayName: `${product.name || '—'} · ${variant.colorCode || '—'}`,
        qty: Number(variantEntry.qty) || 0,
        delivered: Number(variantEntry.delivered) || 0,
        assembled: Number(variantEntry.assembled) || 0,
        addressValues: variantAddressValues,
        isVariant: true,
        isSummary: false,
      };
    });

    return [summaryRow, ...variantRows];
  });
}

function getSortedFilteredRows(recipient) {
  let rows = buildNeedsRows(recipient);

  // Basic text search (name / number / category)
  const q = needsFilter.toLowerCase().trim();
  if (q) {
    rows = rows.filter(r =>
      String(r.product.number).includes(q) ||
      (r.displayName || '').toLowerCase().includes(q) ||
      (r.codeText || '').toLowerCase().includes(q) ||
      (r.product.category || '').toLowerCase().includes(q) ||
      (r.product.productGroup || '').toLowerCase().includes(q)
    );
  }

  // Column-specific filters
  if (needsFilterName) {
    const nq = needsFilterName.toLowerCase();
    rows = rows.filter(r => (r.displayName || '').toLowerCase().includes(nq));
  }
  if (needsFilterCategory) {
    const cq = needsFilterCategory.toLowerCase();
    rows = rows.filter(r => (r.product.category || '').toLowerCase().includes(cq));
  }
  if (needsFilterGroup) {
    const gq = needsFilterGroup.toLowerCase();
    rows = rows.filter(r => (r.product.productGroup || '').toLowerCase().includes(gq));
  }

  // Filter by supplier (checks delivery history cache)
  if (needsFilterSupplier) {
    const sq = needsFilterSupplier.toLowerCase();
    rows = rows.filter(r => {
      const hist = deliveryHistoryCache.get(r.product.id) || [];
      return hist.some(e => (e.supplierName || '').toLowerCase().includes(sq));
    });
  }

  // Filter by order number
  if (needsFilterOrder) {
    const oq = needsFilterOrder.toLowerCase();
    rows = rows.filter(r => {
      const hist = deliveryHistoryCache.get(r.product.id) || [];
      return hist.some(e => (e.orderNum || '').toLowerCase().includes(oq));
    });
  }

  // Filter by date range (any delivery entry within range)
  if (needsFilterDateFrom || needsFilterDateTo) {
    rows = rows.filter(r => {
      const hist = deliveryHistoryCache.get(r.product.id) || [];
      if (hist.length === 0) return false;
      return hist.some(e => {
        const d = e.date || '';
        if (needsFilterDateFrom && d < needsFilterDateFrom) return false;
        if (needsFilterDateTo   && d > needsFilterDateTo)   return false;
        return true;
      });
    });
  }

  // Filter by delivery status
  if (needsFilterDelivered !== 'all') {
    rows = rows.filter(r => {
      const pct = r.qty > 0 ? r.delivered / r.qty : 0;
      if (needsFilterDelivered === 'delivered') return pct >= 1;
      if (needsFilterDelivered === 'partial')   return pct > 0 && pct < 1;
      if (needsFilterDelivered === 'none')      return r.delivered === 0;
      return true;
    });
  }

  const { key, dir } = needsSort;
  const mult = dir === 'asc' ? 1 : -1;
  rows.sort((a, b) => {
    if (key === 'number')    return ((a.product.number || 0) - (b.product.number || 0)) * mult;
    if (key === 'code')      { const va = (a.codeText || '').toLowerCase(); const vb = (b.codeText || '').toLowerCase(); return va.localeCompare(vb) * mult; }
    if (key === 'qty')       return (a.qty - b.qty) * mult;
    if (key === 'delivered') return (a.delivered - b.delivered) * mult;
    if (key === 'assembled') return (a.assembled - b.assembled) * mult;
    if (key === 'productGroup') { const va = (a.product.productGroup || '').toLowerCase(); const vb = (b.product.productGroup || '').toLowerCase(); return va.localeCompare(vb) * mult; }
    if (key === 'lotNumbers') {
      const va = getLotNumbersForProduct(a.product.id, a.product.name || '').join(', ').toLowerCase();
      const vb = getLotNumbersForProduct(b.product.id, b.product.name || '').join(', ').toLowerCase();
      return va.localeCompare(vb) * mult;
    }
    if (key === 'supplier') {
      // Sort by first supplier name in delivery history
      const va = ((deliveryHistoryCache.get(a.product.id) || [])[0]?.supplierName || '').toLowerCase();
      const vb = ((deliveryHistoryCache.get(b.product.id) || [])[0]?.supplierName || '').toLowerCase();
      return va.localeCompare(vb) * mult;
    }
    let va = '', vb = '';
    if (key === 'name')     { va = (a.displayName || a.product.name || '').toLowerCase(); vb = (b.displayName || b.product.name || '').toLowerCase(); }
    if (key === 'category') { va = (a.product.category || '').toLowerCase(); vb = (b.product.category || '').toLowerCase(); }
    return va.localeCompare(vb) * mult;
  });

  return rows;
}

// ─── Needs Panel render ──────────────────────────────────────────

function renderNeedsPanel(recipient) {
  const wrap = document.getElementById('needsPanelWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const needsAddressSelectorLabel = 'Адрес';

  if (!needsPanelOpen) return;

  deliveryHistoryCache = getDeliveryHistoryForRecipient(recipient.id);
  const allRowsForFilters = buildNeedsRows(recipient);
  const toSortedOptions = (values) => [...new Set(
    values
      .map(value => String(value || '').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ru'));
  const historyEntries = [...deliveryHistoryCache.values()].flat();
  const supplierOptions = toSortedOptions(historyEntries.map(entry => entry.supplierName));
  const orderOptions = toSortedOptions(historyEntries.map(entry => entry.orderNum));
  const nameOptions = toSortedOptions(allRowsForFilters.map(row => row.product.name));
  const categoryOptions = toSortedOptions(allRowsForFilters.map(row => row.product.category));
  const groupOptions = toSortedOptions(allRowsForFilters.map(row => row.product.productGroup));

  if (state.products.length === 0) {
    wrap.appendChild(
      el('div', { className: 'rounded-xl border border-white/10 p-6 text-center' },
        el('p', { className: 'text-sm text-slate-500' }, t('recipients.emptyNeeds'))
      )
    );
    return;
  }

  // Toolbar
  const toolbar = el('div', { className: 'flex flex-col sm:flex-row gap-2 mb-3' });

  const searchWrap = el('div', { className: 'relative flex-1' });
  const searchIcon = el('span', { className: 'pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm' });
  searchIcon.textContent = '🔍';
  searchIcon.setAttribute('aria-hidden', 'true');
  searchWrap.appendChild(searchIcon);

  const searchInput = el('input', {
    type: 'search',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-2 pl-9 pr-4 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: t('filters.search'),
  });
  searchInput.value = needsFilter;
  searchInput.addEventListener('input', e => {
    needsFilter = e.target.value;
    renderNeedsTable(recipient, wrap);
  });
  searchWrap.appendChild(searchInput);
  toolbar.appendChild(searchWrap);

  const exportBtn = el('button', {
    type: 'button',
    className: 'inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm font-medium text-slate-200 transition hover:bg-white/10 shrink-0',
  });
  exportBtn.innerHTML = '📥 ' + t('actions.exportExcel');
  exportBtn.addEventListener('click', () => exportNeedsToExcel(recipient));
  toolbar.appendChild(exportBtn);
  wrap.appendChild(toolbar);

  // ── Column-specific filter row ────────────────────────────────
  const colFilterRow = el('div', { className: 'flex flex-wrap gap-2 mb-2' });

  // Name filter
  const nameFilterWrap = el('div', { className: 'relative flex-1 min-w-[180px]' });
  const nameFilterInput = el('input', {
    type: 'search',
    list: 'recipientNeedsNameOptions',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: 'Товар…',
    'aria-label': 'Фильтр по наименованию товара',
  });
  nameFilterInput.value = needsFilterName;
  nameFilterInput.addEventListener('input', e => { needsFilterName = e.target.value; renderNeedsTable(recipient, wrap); });
  const nameIcon = el('span', { className: 'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs' });
  nameIcon.textContent = '📦';
  nameFilterWrap.append(nameIcon, nameFilterInput);
  const nameDataList = el('datalist', { id: 'recipientNeedsNameOptions' });
  nameOptions.forEach(option => nameDataList.appendChild(el('option', { value: option })));
  nameFilterWrap.appendChild(nameDataList);
  colFilterRow.appendChild(nameFilterWrap);

  // Category filter
  const catFilterWrap = el('div', { className: 'relative flex-1 min-w-[150px]' });
  const catFilterInput = el('input', {
    type: 'search',
    list: 'recipientNeedsCategoryOptions',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: 'Категория…',
    'aria-label': 'Фильтр по категории',
  });
  catFilterInput.value = needsFilterCategory;
  catFilterInput.addEventListener('input', e => { needsFilterCategory = e.target.value; renderNeedsTable(recipient, wrap); });
  const catIcon = el('span', { className: 'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs' });
  catIcon.textContent = '🏷';
  catFilterWrap.append(catIcon, catFilterInput);
  const catDataList = el('datalist', { id: 'recipientNeedsCategoryOptions' });
  categoryOptions.forEach(option => catDataList.appendChild(el('option', { value: option })));
  catFilterWrap.appendChild(catDataList);
  colFilterRow.appendChild(catFilterWrap);

  // Product group filter
  const grpFilterWrap = el('div', { className: 'relative flex-1 min-w-[150px]' });
  const grpFilterInput = el('input', {
    type: 'search',
    list: 'recipientNeedsGroupOptions',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 pl-8 pr-3 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: 'Товарная группа…',
    'aria-label': 'Фильтр по товарной группе',
  });
  grpFilterInput.value = needsFilterGroup;
  grpFilterInput.addEventListener('input', e => { needsFilterGroup = e.target.value; renderNeedsTable(recipient, wrap); });
  const grpIcon = el('span', { className: 'pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500 text-xs' });
  grpIcon.textContent = '📂';
  grpFilterWrap.append(grpIcon, grpFilterInput);
  const grpDataList = el('datalist', { id: 'recipientNeedsGroupOptions' });
  groupOptions.forEach(option => grpDataList.appendChild(el('option', { value: option })));
  grpFilterWrap.appendChild(grpDataList);
  colFilterRow.appendChild(grpFilterWrap);

  wrap.appendChild(colFilterRow);

  // ── Advanced filters row ─────────────────────────────────────
  const advRow = el('div', { className: 'flex flex-wrap gap-2 mb-3' });

  // Supplier filter
  const supplierInput = el('input', {
    type: 'search',
    list: 'recipientNeedsSupplierOptions',
    className: 'flex-1 min-w-[130px] rounded-xl border border-white/10 bg-white/5 py-1.5 px-3 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: '🏭 Поставщик…',
    'aria-label': 'Фильтр по поставщику',
  });
  supplierInput.value = needsFilterSupplier;
  supplierInput.addEventListener('input', e => { needsFilterSupplier = e.target.value; renderNeedsTable(recipient, wrap); });
  advRow.appendChild(supplierInput);
  const supplierDataList = el('datalist', { id: 'recipientNeedsSupplierOptions' });
  supplierOptions.forEach(option => supplierDataList.appendChild(el('option', { value: option })));
  advRow.appendChild(supplierDataList);

  // Order filter
  const orderInput = el('input', {
    type: 'search',
    list: 'recipientNeedsOrderOptions',
    className: 'flex-1 min-w-[120px] rounded-xl border border-white/10 bg-white/5 py-1.5 px-3 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50',
    placeholder: '📋 Заявка…',
    'aria-label': 'Фильтр по номеру заявки',
  });
  orderInput.value = needsFilterOrder;
  orderInput.addEventListener('input', e => { needsFilterOrder = e.target.value; renderNeedsTable(recipient, wrap); });
  advRow.appendChild(orderInput);
  const orderDataList = el('datalist', { id: 'recipientNeedsOrderOptions' });
  orderOptions.forEach(option => orderDataList.appendChild(el('option', { value: option })));
  advRow.appendChild(orderDataList);

  // Date from
  const dateFromWrap = el('div', { className: 'flex flex-col gap-0.5 flex-1 min-w-[120px]' });
  dateFromWrap.appendChild(el('label', { className: 'text-[10px] text-slate-500 pl-1' }, 'Дата от'));
  const dateFromInput = el('input', {
    type: 'date',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 px-3 text-sm text-white transition focus:border-cyan-400/50',
    'aria-label': 'Дата отгрузки от',
  });
  dateFromInput.value = needsFilterDateFrom;
  dateFromInput.addEventListener('change', e => { needsFilterDateFrom = e.target.value; renderNeedsTable(recipient, wrap); });
  dateFromWrap.appendChild(dateFromInput);
  advRow.appendChild(dateFromWrap);

  // Date to
  const dateToWrap = el('div', { className: 'flex flex-col gap-0.5 flex-1 min-w-[120px]' });
  dateToWrap.appendChild(el('label', { className: 'text-[10px] text-slate-500 pl-1' }, 'Дата до'));
  const dateToInput = el('input', {
    type: 'date',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 py-1.5 px-3 text-sm text-white transition focus:border-cyan-400/50',
    'aria-label': 'Дата отгрузки до',
  });
  dateToInput.value = needsFilterDateTo;
  dateToInput.addEventListener('change', e => { needsFilterDateTo = e.target.value; renderNeedsTable(recipient, wrap); });
  dateToWrap.appendChild(dateToInput);
  advRow.appendChild(dateToWrap);

  // Delivery status
  const statusSel = el('select', {
    className: 'flex-1 min-w-[150px] rounded-xl border border-white/10 bg-slate-900 py-1.5 px-3 text-sm text-white transition focus:border-cyan-400/50',
    'aria-label': 'Фильтр по статусу доставки',
  });
  [
    { value: 'all',       label: 'Все статусы' },
    { value: 'delivered', label: '✅ Полностью доставлено' },
    { value: 'partial',   label: '🟡 Частично' },
    { value: 'none',      label: '⬜ Не доставлено' },
  ].forEach(opt => {
    const o = el('option', { value: opt.value }, opt.label);
    if (opt.value === needsFilterDelivered) o.selected = true;
    statusSel.appendChild(o);
  });
  statusSel.addEventListener('change', e => { needsFilterDelivered = e.target.value; renderNeedsTable(recipient, wrap); });
  advRow.appendChild(statusSel);

  // Reset filters
  const resetBtn = el('button', {
    type: 'button',
    className: 'inline-flex items-center gap-1 rounded-xl border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition shrink-0',
    title: 'Сбросить все фильтры',
    'aria-label': 'Сбросить фильтры',
  }, '✕ Сброс');
  resetBtn.addEventListener('click', () => {
    needsFilter = '';
    needsFilterSupplier = '';
    needsFilterOrder = '';
    needsFilterDateFrom = '';
    needsFilterDateTo = '';
    needsFilterDelivered = 'all';
    needsFilterName = '';
    needsFilterCategory = '';
    needsFilterGroup = '';
    renderNeedsPanel(recipient);
  });
  advRow.appendChild(resetBtn);
  wrap.appendChild(advRow);

  const recipientAddresses = getWorkingRecipientAddresses(recipient);
  if (recipientAddresses.length > 0) {
    if (!recipientAddresses.includes(needsAddressFilter)) {
      needsAddressFilter = recipientAddresses[0] || '';
    }

    const addressBar = el('div', { className: 'flex flex-wrap items-center gap-2 mb-3' });
    addressBar.appendChild(el('span', {
      className: 'text-xs font-semibold uppercase tracking-wider text-slate-400',
    }, needsAddressSelectorLabel));

    const addressSelect = el('select', {
      className: 'rounded-xl border border-white/10 bg-slate-900 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50',
      'aria-label': needsAddressSelectorLabel,
    });
    recipientAddresses.forEach((address) => {
      const option = el('option', { value: address }, address);
      if (address === needsAddressFilter) option.selected = true;
      addressSelect.appendChild(option);
    });
    addressSelect.addEventListener('change', (event) => {
      needsAddressFilter = String(event.target.value || '');
      renderNeedsTable(recipient, wrap);
    });
    addressBar.appendChild(addressSelect);

    const currentAddress = recipientAddresses.find(address => address === needsAddressFilter) || recipientAddresses[0] || '';
    if (currentAddress) {
      addressBar.appendChild(el('span', {
        className: 'text-xs text-slate-500 truncate',
        title: currentAddress,
      }, currentAddress));
    }

    wrap.appendChild(addressBar);
  } else {
    needsAddressFilter = '';
  }

  [
    [nameFilterInput, 'recipientNeedsNameOptions', nameOptions, '📦', '180px'],
    [catFilterInput, 'recipientNeedsCategoryOptions', categoryOptions, '🏷️', '150px'],
    [grpFilterInput, 'recipientNeedsGroupOptions', groupOptions, '📂', '150px'],
    [supplierInput, 'recipientNeedsSupplierOptions', supplierOptions, '🏭', '150px'],
    [orderInput, 'recipientNeedsOrderOptions', orderOptions, '📋', '150px'],
  ].forEach(([input, listId, options, icon, minWidth]) => {
    enhancePredictiveInput(input, { listId, options, icon, minWidth });
  });
  nameIcon.remove();
  catIcon.remove();
  grpIcon.remove();

  // Delivery summary banner
  const totalDelivered = Object.values(recipient.needs || {}).reduce((s, n) => s + (typeof n === 'object' ? (n.delivered || 0) : 0), 0);
  const deliveryHistory = deliveryHistoryCache;
  const totalShipments = state.shipments
    ? state.shipments.filter(s => (s.rows || []).some(row => (row.recipients || []).some(r => r.recipientId === recipient.id && r.qty > 0))).length
    : 0;
  if (totalDelivered > 0) {
    const banner = el('div', {
      className: 'mb-3 flex items-center gap-2 rounded-xl border border-emerald-400/20 bg-emerald-400/10 px-4 py-2.5 text-xs text-emerald-400',
    });
    banner.innerHTML = '🚚 <strong>Доставлено ' + totalDelivered + ' шт.</strong> в ' + totalShipments + ' отгрузках — история по каждому товару в колонке «История доставок»';
    wrap.appendChild(banner);
  }

  // Table wrapper
  const tableWrap = el('div', { id: 'needsTableWrap', className: 'rounded-xl border border-white/10' });
  tableWrap.style.cssText = [
    'overflow-x:scroll',
    'overflow-y:auto',
    'max-height:55vh',
    'scrollbar-gutter:stable',
    '-webkit-overflow-scrolling:touch',
  ].join(';');
  wrap.appendChild(tableWrap);

  renderNeedsTable(recipient, wrap);
}

function renderNeedsTable(recipient, wrap) {
  let tableWrap = document.getElementById('needsTableWrap');
  if (!tableWrap) {
    tableWrap = el('div', { id: 'needsTableWrap', className: 'rounded-xl border border-white/10' });
    tableWrap.style.cssText = [
      'overflow-x:scroll',
      'overflow-y:auto',
      'max-height:55vh',
      'scrollbar-gutter:stable',
      '-webkit-overflow-scrolling:touch',
    ].join(';');
    wrap.appendChild(tableWrap);
  }
  clearChildren(tableWrap);

  // Rebuild history cache BEFORE filtering (supplier/order filters depend on it)
  deliveryHistoryCache = getDeliveryHistoryForRecipient(recipient.id);
  const rows = getSortedFilteredRows(recipient);
  const deliveryHistory = deliveryHistoryCache;
  const recipientAddresses = getWorkingRecipientAddresses(recipient);
  const selectedAddress = getActiveNeedsAddress(recipient);

  if (rows.length === 0) {
    tableWrap.appendChild(
      el('div', { className: 'p-6 text-center text-sm text-slate-500' }, t('filters.noResults'))
    );
    return;
  }

  const table = el('table', { className: 'w-full text-sm' });

  const COLS = [
    { key: 'number',    label: t('needs.col.number'),    cls: 'w-12' },
    { key: 'code',      label: t('needs.col.code'),      cls: 'w-24' },
    { key: 'name',      label: t('needs.col.name'),      cls: '' },
    { key: 'category',  label: t('needs.col.category'),  cls: '' },
    { key: 'lotNumbers', label: t('needs.col.lotNumbers'), cls: 'min-w-[150px]' },
    { key: 'productGroup', label: 'Товарная группа',     cls: 'min-w-[140px]' },
    { key: 'qty',       label: t('needs.col.quantity'),  cls: 'w-24 text-center' },
    { key: 'delivered', label: t('needs.col.delivered'), cls: 'w-28 text-center' },
  ];
  // Extra columns: supplier, history, assembled — appended after qty/delivered
  const HISTORY_COL = { key: 'history', label: 'История доставок', cls: 'min-w-[220px]' };

  // Show «assembled» column only when at least one product REQUIRES assembly
  const hasAssemblable = rows.some(r => (r.product.assembly ?? 'not_required') === 'required');
  const hasHistory = deliveryHistory.size > 0;

  const thead = el('thead', { className: 'bg-slate-900/80' });
  const hrow = el('tr', {});
  COLS.forEach(col => {
    if (col.assemblyOnly) return;
    const th = el('th', {
      className: 'px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 cursor-pointer select-none hover:text-white transition ' + col.cls,
    });
    const inner = el('span', { className: 'inline-flex items-center gap-1' });
    inner.textContent = col.label;
    // Mark delivered column as auto-filled
    if (col.key === 'delivered') {
      const hint = el('span', { className: 'text-[9px] text-emerald-400/60 ml-1 normal-case font-normal', title: 'Заполняется автоматически при отгрузке' });
      hint.textContent = '🚚';
      inner.appendChild(hint);
    }
    if (needsSort.key === col.key) {
      const arrow = el('span', { className: 'text-cyan-400' });
      arrow.textContent = needsSort.dir === 'asc' ? ' ↑' : ' ↓';
      inner.appendChild(arrow);
    }
    th.appendChild(inner);
    th.addEventListener('click', () => {
      if (needsSort.key === col.key) {
        needsSort.dir = needsSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        needsSort.key = col.key;
        needsSort.dir = 'asc';
      }
      renderNeedsTable(recipient, wrap);
    });
    hrow.appendChild(th);
  });

  if (hasHistory) {
    // ── Supplier column header ──
    const thS = el('th', {
      className: 'px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 min-w-[150px] cursor-pointer select-none hover:text-white transition',
    });
    const innerS = el('span', { className: 'inline-flex items-center gap-1' });
    innerS.textContent = 'Поставщик';
    if (needsSort.key === 'supplier') {
      const arrowS = el('span', { className: 'text-cyan-400' });
      arrowS.textContent = needsSort.dir === 'asc' ? ' ↑' : ' ↓';
      innerS.appendChild(arrowS);
    }
    thS.appendChild(innerS);
    thS.addEventListener('click', () => {
      if (needsSort.key === 'supplier') {
        needsSort.dir = needsSort.dir === 'asc' ? 'desc' : 'asc';
      } else {
        needsSort.key = 'supplier';
        needsSort.dir = 'asc';
      }
      renderNeedsTable(recipient, wrap);
    });
    hrow.appendChild(thS);

    // ── History column header ──
    const thH = el('th', {
      className: 'px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 ' + HISTORY_COL.cls,
    });
    const innerH = el('span', { className: 'inline-flex items-center gap-1' });
    innerH.textContent = HISTORY_COL.label;
    const hintH = el('span', {
      className: 'text-[9px] text-cyan-400/60 ml-1 normal-case font-normal',
      title: 'Все отгрузки по данному товару для этого получателя: заявка, дата, кол-во',
    });
    hintH.textContent = '🚚';
    innerH.appendChild(hintH);
    thH.appendChild(innerH);
    hrow.appendChild(thH);
  }

  // ── Assembled column header — after history ──────────────────────
  if (hasAssemblable) {
    const thA = el('th', {
      className: 'px-3 py-3 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 cursor-pointer select-none hover:text-white transition w-32 text-center',
    });
    const innerA = el('span', { className: 'inline-flex items-center gap-1' });
    innerA.textContent = t('needs.col.assembled');
    const hintA = el('span', {
      className: 'text-[9px] text-amber-400/60 ml-1 normal-case font-normal',
      title: 'Нарастающим итогом из актов сборки (FIFO по заявкам)',
    });
    hintA.textContent = '🔧';
    innerA.appendChild(hintA);
    if (needsSort.key === 'assembled') {
      const arrowA = el('span', { className: 'text-cyan-400' });
      arrowA.textContent = needsSort.dir === 'asc' ? ' ↑' : ' ↓';
      innerA.appendChild(arrowA);
    }
    thA.appendChild(innerA);
    thA.addEventListener('click', () => {
      needsSort.key = 'assembled';
      needsSort.dir = needsSort.key === 'assembled' && needsSort.dir === 'asc' ? 'desc' : 'asc';
      renderNeedsTable(recipient, wrap);
    });
    hrow.appendChild(thA);
  }

  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody', { className: 'divide-y divide-white/5' });
  rows.forEach(({ product, qty, delivered, assembled, codeList, displayName, isVariant, isSummary, colorCode, variantKey, rowType, addressValues }) => {
    const needsAssembly = (product.assembly ?? 'not_required') === 'required';
    const row = el('tr', {
      className: 'hover:bg-white/[0.03] transition cursor-pointer' + (isSummary ? ' bg-white/[0.02]' : ''),
      tabindex: '0',
      role: 'button',
      'aria-label': `${t('actions.view')}: ${product.name || product.number || 'товар'}`,
      title: t('actions.view'),
    });

    const openProductCard = () => openProductForm(product, null, { mode: 'view' });
    row.addEventListener('click', e => {
      if (e.target.closest('input, button, a, select, textarea, label')) return;
      openProductCard();
    });
    row.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      if (e.target.closest('input, button, a, select, textarea, label')) return;
      e.preventDefault();
      openProductCard();
    });

    const numCell = el('td', { className: 'px-3 py-2.5 text-sm font-bold text-cyan-400 tabular-nums whitespace-nowrap' });
    numCell.textContent = String(product.number || '—');
    row.appendChild(numCell);

    const codeCell = el('td', { className: 'px-3 py-2.5 text-xs text-slate-400 tabular-nums' });
    const normalizedCodes = formatContractCodes(codeList);
    if (normalizedCodes.length > 0) {
      const codeWrap = el('div', { className: 'flex flex-col gap-1' });
      normalizedCodes.forEach(code => {
        codeWrap.appendChild(el('span', {
          className: 'inline-flex self-start rounded-lg bg-slate-800/70 px-2 py-0.5 text-[10px] text-slate-300 whitespace-nowrap',
          title: code,
        }, code));
      });
      codeCell.appendChild(codeWrap);
    } else {
      codeCell.textContent = '—';
    }
    row.appendChild(codeCell);

    const nameCell = el('td', { className: 'px-3 py-2.5 text-sm text-white' });
    if (isSummary) {
      const stack = el('div', { className: 'flex flex-col gap-1' });
      stack.appendChild(el('span', { className: 'text-white font-medium' }, product.name || '—'));
      stack.appendChild(el('span', {
        className: 'inline-flex items-center self-start rounded-lg bg-slate-700/60 px-2 py-0.5 text-[10px] font-semibold text-slate-300',
      }, 'всего'));
      nameCell.appendChild(stack);
    } else if (isVariant) {
      const stack = el('div', { className: 'flex flex-col gap-1' });
      stack.appendChild(el('span', { className: 'text-slate-300 pl-4' }, `в том числе: ${colorCode || '—'}`));
      stack.appendChild(el('span', {
        className: 'inline-flex items-center self-start rounded-lg bg-cyan-400/10 px-2 py-0.5 text-[10px] font-semibold text-cyan-300 ml-4',
      }, `RAL ${colorCode || '—'}`));
      nameCell.appendChild(stack);
    } else {
      nameCell.textContent = displayName || product.name || '—';
    }
    row.appendChild(nameCell);

    const catCell = el('td', { className: 'px-3 py-2.5 text-sm text-slate-500 whitespace-nowrap' });
    catCell.textContent = product.category || '—';
    row.appendChild(catCell);

    const lotCell = el('td', { className: 'px-3 py-2.5 text-sm text-slate-400 whitespace-nowrap' });
    const lotNumbers = getLotNumbersForProduct(product.id, product.name || '');
    if (lotNumbers.length > 0) {
      const lotWrap = el('div', { className: 'flex flex-wrap gap-1.5' });
      lotNumbers.forEach(lot => {
        const badge = el('span', {
          className: 'inline-flex items-center rounded-lg bg-violet-400/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300',
          title: lot,
        });
        badge.textContent = lot;
        lotWrap.appendChild(badge);
      });
      lotCell.appendChild(lotWrap);
    } else {
      lotCell.textContent = '—';
    }
    row.appendChild(lotCell);

    // productGroup cell
    const grpCell = el('td', { className: 'px-3 py-2.5 text-sm text-slate-400 whitespace-nowrap' });
    grpCell.textContent = product.productGroup || '—';
    row.appendChild(grpCell);

    const addressKey = normalizeRecipientAddressNeedKey(selectedAddress);
    const selectedAddressValues = addressKey ? (addressValues?.[addressKey] || null) : null;
    const addressQty = selectedAddressValues ? (Number(selectedAddressValues.qty) || 0) : getNeedsQtyForSelectedAddress({ addressValues, qty }, recipient);
    const addressDelivered = selectedAddressValues ? (Number(selectedAddressValues.delivered) || 0) : (Number(delivered) || 0);
    const addressAssembled = selectedAddressValues ? (Number(selectedAddressValues.assembled) || 0) : (Number(assembled) || 0);
    if (recipientAddresses.length > 0) {
      row.appendChild(makeReadonlyQtyCell(addressQty, isSummary ? '∑' : ''));
    } else {
      row.appendChild(makeReadonlyQtyCell(qty, isSummary ? '∑' : ''));
    }

    // delivered — readonly, set by shipments
    row.appendChild(makeDeliveredCell(recipientAddresses.length > 0 ? addressDelivered : delivered, recipientAddresses.length > 0 ? addressQty : qty));

    // ── Supplier + History cells ──────────────────────────────────
    if (hasHistory) {
      const prodId = product.id;
      const histEntries = isVariant ? [] : (deliveryHistory.get(prodId) || []);

      // ── Compute FIFO assembly distribution for this product ──────
      const fifoAssembly = hasAssemblable && needsAssembly
        ? getAssemblyFifoByOrders(recipient.id, prodId, histEntries)
        : [];
      // Total assembled from acts (FIFO sum)
      const totalAssembledFromActs = fifoAssembly.reduce((s, e) => s + (e.assembledQty || 0), 0);

      // ── Supplier cell ──
      const supplierTd = el('td', { className: 'px-3 py-2 align-top min-w-[150px]' });
      const uniqueSuppliers = [...new Set(histEntries.map(e => e.supplierName).filter(Boolean))];
      if (uniqueSuppliers.length === 0) {
        supplierTd.appendChild(el('span', { className: 'text-xs text-slate-600' }, '—'));
      } else {
        const sWrap = el('div', { className: 'flex flex-col gap-0.5' });
        uniqueSuppliers.forEach(sName => {
          const badge = el('span', {
            className: 'inline-flex items-center rounded-lg bg-blue-400/15 px-2 py-0.5 text-[10px] font-medium text-blue-300 whitespace-nowrap max-w-[180px] truncate',
            title: sName,
          });
          badge.textContent = '🏭 ' + sName;
          sWrap.appendChild(badge);
        });
        supplierTd.appendChild(sWrap);
      }
      row.appendChild(supplierTd);

      // ── History cell ──
      const histTd = el('td', { className: 'px-3 py-2 align-top' });

      if (histEntries.length === 0) {
        histTd.appendChild(el('span', { className: 'text-xs text-slate-600' }, '—'));
      } else {
        const histWrap = el('div', { className: 'flex flex-col gap-0.5' });
        histEntries.forEach(entry => {
          const chip = el('div', {
            className: 'inline-flex flex-wrap items-center gap-x-1.5 gap-y-0.5 rounded-lg bg-slate-800/60 border border-white/[0.06] px-2 py-1',
            title: [
              'Источник: ' + (entry.sourceType === 'direct' ? t('delivery.badgeDirect') : t('delivery.badgeWarehouse')),
              'Поставщик: ' + (entry.supplierName || '—'),
              'Заявка: ' + entry.orderNum,
              'Дата: ' + (entry.date || '—'),
              'Кол-во: ' + entry.qty + ' шт.',
            ].join(' | '),
          });

          chip.appendChild(buildDeliverySourceBadge(entry.sourceType));

          // Date badge
          if (entry.date) {
            const dateBadge = el('span', { className: 'text-[10px] text-slate-400 whitespace-nowrap tabular-nums' });
            try {
              dateBadge.textContent = '📅 ' + new Date(entry.date).toLocaleDateString('ru-RU');
            } catch {
              dateBadge.textContent = '📅 ' + entry.date;
            }
            chip.appendChild(dateBadge);
          }

          // Order badge
          if (entry.orderNum && entry.orderNum !== '—') {
            const orderBadge = el('span', {
              className: 'inline-flex items-center rounded bg-violet-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-violet-300 whitespace-nowrap',
            });
            orderBadge.textContent = '📋 ' + entry.orderNum;
            chip.appendChild(orderBadge);
          }

          // Qty badge
          const qtyBadge = el('span', { className: 'text-[10px] font-bold text-emerald-400 tabular-nums whitespace-nowrap' });
          qtyBadge.textContent = '+' + entry.qty + ' шт.';
          chip.appendChild(qtyBadge);

          histWrap.appendChild(chip);
        });
        histTd.appendChild(histWrap);
      }
      row.appendChild(histTd);
    }

    // ── Assembled cell — FIFO from assembly acts, after history ───
    if (hasAssemblable) {
      const asmTd = el('td', { className: 'px-3 py-2 align-top' });

      if (!needsAssembly) {
        asmTd.appendChild(el('span', { className: 'text-xs text-slate-600' }, '—'));
      } else if (isVariant) {
        if ((Number(assembled) || 0) > 0) {
          asmTd.appendChild(el('span', {
            className: 'inline-block rounded-lg bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-300 tabular-nums',
          }, String(Number(assembled) || 0)));
        } else {
          asmTd.appendChild(el('span', { className: 'text-xs text-slate-600' }, '—'));
        }
      } else {
        // Разбивка собранного по поставщикам
        const bySupplier = calcAssembledBySupplier(recipient.id, product.id);
        const totalFromActs = [...bySupplier.values()].reduce((s, v) => s + v, 0);

        if (totalFromActs === 0 && assembled === 0) {
          asmTd.appendChild(el('span', { className: 'text-xs text-slate-600' }, '—'));
        } else if (totalFromActs > 0) {
          const pctAsm = delivered > 0 ? totalFromActs / delivered : 0;
          const colorCls = pctAsm >= 1
            ? 'text-emerald-400 font-bold'
            : pctAsm > 0 ? 'text-amber-400 font-semibold' : 'text-slate-500';

          const asmWrap = el('div', { className: 'flex flex-col gap-0.5' });

          // ── Итого ──
          const totalRow = el('div', { className: 'flex items-center gap-1.5' });
          const totalBadge = el('span', {
            className: 'inline-block rounded-lg px-2 py-0.5 text-xs font-bold tabular-nums ' +
              (pctAsm >= 1 ? 'bg-emerald-400/20 text-emerald-300' : pctAsm > 0 ? 'bg-amber-400/15 text-amber-400' : 'bg-slate-800/60 text-slate-500'),
            title: `Собрано всего: ${totalFromActs} шт. из ${delivered} доставленных`,
          });
          totalBadge.textContent = '∑ ' + totalFromActs;
          totalRow.appendChild(totalBadge);
          if (delivered > 0) {
            const pctBadge = el('span', { className: 'text-[9px] text-slate-500 tabular-nums' });
            pctBadge.textContent = Math.round(pctAsm * 100) + '%';
            totalRow.appendChild(pctBadge);
          }
          asmWrap.appendChild(totalRow);

          // ── В том числе по поставщикам ──
          if (bySupplier.size > 1 || (bySupplier.size === 1 && [...bySupplier.keys()][0] !== null)) {
            const dividerSpan = el('span', { className: 'text-[9px] text-slate-600 mt-0.5' });
            dividerSpan.textContent = 'в т.ч.:';
            asmWrap.appendChild(dividerSpan);

            bySupplier.forEach((qty, sid) => {
              const supplier = sid !== null
                ? (state.suppliers || []).find(s => s.id === sid)
                : null;
              const sName = supplier?.name || (sid !== null ? `Поставщик #${sid}` : 'Неизвестен');
              const sRow = el('div', {
                className: 'flex items-center gap-1 flex-wrap',
                title: `${sName}: ${qty} шт.`,
              });
              const sBadge = el('span', {
                className: 'inline-flex items-center gap-1 rounded bg-blue-400/10 border border-blue-400/15 px-1.5 py-0.5 text-[10px] text-blue-300 max-w-[160px] truncate',
              });
              sBadge.textContent = '🏭 ' + sName;
              const sQty = el('span', { className: 'text-[10px] font-semibold text-white tabular-nums shrink-0' });
              sQty.textContent = qty + ' шт.';
              sRow.append(sBadge, sQty);
              asmWrap.appendChild(sRow);
            });
          }

          if (assembled !== totalFromActs) {
            const diffNote = el('div', { className: 'text-[10px] text-amber-400/70 mt-0.5' });
            diffNote.textContent = `⚠ В карточке: ${assembled}`;
            asmWrap.appendChild(diffNote);
          }
          asmTd.appendChild(asmWrap);
        } else if (assembled > 0) {
          const manualWrap = el('div', { className: 'flex flex-col gap-0.5' });
          const manualBadge = el('span', {
            className: 'inline-block rounded-lg bg-slate-700/60 px-2 py-0.5 text-xs text-slate-400 tabular-nums',
            title: 'Введено вручную — не подтверждено актами сборки',
          });
          manualBadge.textContent = '✎ ' + assembled + ' шт.';
          manualWrap.appendChild(manualBadge);
          const note = el('div', { className: 'text-[10px] text-slate-600 mt-0.5' });
          note.textContent = 'нет актов сборки';
          manualWrap.appendChild(note);
          asmTd.appendChild(manualWrap);
        }
      }

      row.appendChild(asmTd);
    }

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);

  makeColumnsResizable(table, 'recipient-needs');
  requestAnimationFrame(() => {
    applyFrozenTable(table, 'recipient-needs');
    attachFrozenManager(table, 'recipient-needs');
  });
  updateNeedsSummaryLive();
}

/**
 * Editable number input for qty.
 * «assembled» is now read-only — populated from assembly acts (FIFO).
 * @param {number} productId
 * @param {'qty'} field
 * @param {number} value
 */
function makeEditableInput(productId, field, value, variantKey = '') {
  const td = el('td', { className: 'px-2 py-2 text-center' });
  const input = el('input', {
    type: 'number',
    min: '0',
    className: 'w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-sm text-white tabular-nums transition focus:border-cyan-400/50',
  });
  input.value = String(value);
  input.dataset.productId = String(productId);
  input.dataset.field = field;
  if (variantKey) input.dataset.variantKey = String(variantKey);
  input.addEventListener('input', updateNeedsSummaryLive);
  input.addEventListener('input', () => syncRecipientNeedInput(input, { save: false }));
  input.addEventListener('change', () => syncRecipientNeedInput(input, { save: true }));
  td.appendChild(input);
  return td;
}

function makeAddressEditableInput(productId, address, value, variantKey = '') {
  const td = el('td', { className: 'px-2 py-2 text-center' });
  const input = el('input', {
    type: 'number',
    min: '0',
    className: 'w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-center text-sm text-white tabular-nums transition focus:border-cyan-400/50',
    value: String(value || 0),
    'data-product-id': String(productId),
    'data-address': String(address || ''),
  });
  if (variantKey) input.dataset.variantKey = String(variantKey);
  input.addEventListener('input', updateNeedsSummaryLive);
  input.addEventListener('input', () => syncRecipientAddressNeedInput(input, { save: false }));
  input.addEventListener('change', () => syncRecipientAddressNeedInput(input, { save: true }));
  td.appendChild(input);
  return td;
}

function makeReadonlyQtyCell(value, prefix = '') {
  const td = el('td', { className: 'px-2 py-2 text-center' });
  const badge = el('span', {
    className: 'inline-flex items-center gap-1 rounded-lg bg-slate-800/70 px-2.5 py-1 text-sm font-semibold text-cyan-300 tabular-nums',
  }, `${prefix ? `${prefix} ` : ''}${value || 0}`);
  td.appendChild(badge);
  return td;
}

/**
 * Read-only «delivered» cell — shows value from state, styled differently.
 * Uses a hidden input with data-product-id / data-field so handleSaveRecipient
 * can still read the value (it will preserve it as-is from state).
 */
function makeDeliveredCell(delivered, qty) {
  const td = el('td', { className: 'px-2 py-2 text-center' });

  // Determine color: green if fully delivered, amber if partial, slate if none
  const pct = qty > 0 ? delivered / qty : 0;
  const colorCls = delivered === 0
    ? 'text-slate-500'
    : pct >= 1
      ? 'text-emerald-400 font-bold'
      : 'text-amber-400 font-semibold';

  const display = el('div', {
    className: 'flex flex-col items-center gap-0.5',
    title: 'Заполняется автоматически при проведении отгрузки. Изменить вручную нельзя.',
  });

  const valSpan = el('span', { className: 'tabular-nums text-sm ' + colorCls });
  valSpan.textContent = String(delivered);
  display.appendChild(valSpan);

  if (qty > 0) {
    const pctSpan = el('span', { className: 'text-[9px] text-slate-500' });
    pctSpan.textContent = Math.round(pct * 100) + '%';
    display.appendChild(pctSpan);
  }

  td.appendChild(display);
  return td;
}

function syncRecipientNeedInput(input, { save = false } = {}) {
  if (editingRecipientId === null || !input) return;
  const productId = Number(input.dataset.productId) || 0;
  const field = String(input.dataset.field || '');
  const variantKey = String(input.dataset.variantKey || '').trim();
  if (!productId || field !== 'qty') return;

  const recipient = getRecipientById(editingRecipientId);
  if (!recipient) return;
  const product = state.products.find(p => p.id === productId) || null;
  const existingEntry = normalizeNeedEntry(recipient.needs?.[productId], product);
  const value = Math.max(0, parseInt(input.value, 10) || 0);

  const nextNeeds = { ...(recipient.needs || {}) };

  if (variantKey && hasProductColorVariants(product)) {
    if (!existingEntry.variants) existingEntry.variants = {};
    const variant = getProductVariantByKey(product, variantKey);
    if (!variant) return;
    const currentVariant = existingEntry.variants[variant.id] || {
      id: variant.id,
      colorCode: variant.colorCode,
      qty: 0,
      delivered: 0,
      assembled: 0,
    };
    currentVariant.qty = value;
    existingEntry.variants[variant.id] = currentVariant;
    existingEntry.qty = Object.values(existingEntry.variants).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
    existingEntry.delivered = Object.values(existingEntry.variants).reduce((sum, item) => sum + (Number(item.delivered) || 0), 0) || (Number(existingEntry.delivered) || 0);
    existingEntry.assembled = Object.values(existingEntry.variants).reduce((sum, item) => sum + (Number(item.assembled) || 0), 0) || (Number(existingEntry.assembled) || 0);
    if (existingEntry.qty === 0 && existingEntry.delivered === 0 && existingEntry.assembled === 0) {
      delete nextNeeds[productId];
    } else {
      nextNeeds[productId] = existingEntry;
    }
  } else {
    if (value === 0 && (Number(existingEntry.delivered) || 0) === 0 && (Number(existingEntry.assembled) || 0) === 0) {
      delete nextNeeds[productId];
    } else {
      existingEntry.qty = value;
      nextNeeds[productId] = existingEntry;
    }
  }

  updateRecipientNeeds(editingRecipientId, nextNeeds);
  dispatchNeedsChanged(editingRecipientId, productId);

  if (needsPanelOpen && save) {
    const currentRecipient = getRecipientById(editingRecipientId);
    if (currentRecipient) renderNeedsTable(currentRecipient, $('needsPanelWrap'));
  }

  if (save) saveToStorage();
}

function syncRecipientAddressNeedInput(input, { save = false } = {}) {
  if (editingRecipientId === null || !input) return;
  const productId = Number(input.dataset.productId) || 0;
  const variantKey = String(input.dataset.variantKey || '').trim();
  const address = String(input.dataset.address || '').trim();
  if (!productId || !address) return;

  const recipient = getRecipientById(editingRecipientId);
  if (!recipient) return;
  const product = state.products.find(p => p.id === productId) || null;
  const addressKey = normalizeRecipientAddressNeedKey(address);
  const addressNeeds = getRecipientAddressNeedsMap(recipient);
  if (!addressNeeds[addressKey]) {
    addressNeeds[addressKey] = { address, needs: {} };
  }

  const currentEntry = normalizeNeedEntry(addressNeeds[addressKey].needs[productId], product);
  const value = Math.max(0, parseInt(input.value, 10) || 0);

  if (variantKey && hasProductColorVariants(product)) {
    const variant = getProductVariantByKey(product, variantKey);
    if (!variant) return;
    if (!currentEntry.variants) currentEntry.variants = {};
    const currentVariant = currentEntry.variants[variant.id] || {
      id: variant.id,
      colorCode: variant.colorCode,
      qty: 0,
      delivered: 0,
      assembled: 0,
    };
    currentVariant.qty = value;
    currentEntry.variants[variant.id] = currentVariant;
    currentEntry.qty = Object.values(currentEntry.variants).reduce((sum, item) => sum + (Number(item.qty) || 0), 0);
  } else {
    currentEntry.qty = value;
  }

  if ((Number(currentEntry.qty) || 0) === 0 && (Number(currentEntry.delivered) || 0) === 0 && (Number(currentEntry.assembled) || 0) === 0) {
    delete addressNeeds[addressKey].needs[productId];
  } else {
    addressNeeds[addressKey].needs[productId] = currentEntry;
  }

  if (Object.keys(addressNeeds[addressKey].needs).length === 0) {
    delete addressNeeds[addressKey];
  }

  recipient.addressNeeds = addressNeeds;
  rebuildRecipientNeedTotalsFromAddresses(recipient);
  dispatchNeedsChanged(editingRecipientId, productId);

  if (needsPanelOpen && save) {
    const currentRecipient = getRecipientById(editingRecipientId);
    if (currentRecipient) renderNeedsTable(currentRecipient, $('needsPanelWrap'));
  }

  if (save) saveToStorage();
}

function updateNeedsSummaryLive() {
  let total = 0;
  const addressInputs = document.querySelectorAll('[data-product-id][data-address]');
  if (addressInputs.length > 0) {
    addressInputs.forEach(input => {
      total += parseInt(input.value, 10) || 0;
    });
  } else {
    document.querySelectorAll('[data-product-id][data-field="qty"]').forEach(input => {
      total += parseInt(input.value, 10) || 0;
    });
  }
  const summary = $('editNeedsSummary');
  if (!summary) return;
  if (total > 0) {
    summary.textContent = t('recipients.totalItems', { count: total });
    summary.classList.remove('hidden');
  } else {
    summary.classList.add('hidden');
  }
}

function syncAllRecipientNeedInputsFromDom() {
  if (editingRecipientId === null) return;

  document.querySelectorAll('#needsPanelWrap [data-product-id][data-address]').forEach(input => {
    syncRecipientAddressNeedInput(input, { save: false });
  });

  document.querySelectorAll('#needsPanelWrap [data-product-id][data-field="qty"]').forEach(input => {
    syncRecipientNeedInput(input, { save: false });
  });
}

// ─── Export to Excel ─────────────────────────────────────────────

async function exportNeedsToExcel(recipient) {
  try {
    let XLSX = window.XLSX;
    if (!XLSX) {
      await new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
        s.onload = () => { XLSX = window.XLSX; resolve(); };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }

    const rows = getSortedFilteredRows(recipient);
    const deliveryHistoryExport = getDeliveryHistoryForRecipient(recipient.id);

    // For qty/assembled read from DOM inputs; for delivered read from state (readonly)
    const inputMap = {};
    document.querySelectorAll('[data-product-id][data-field]').forEach(input => {
      const pid = input.dataset.productId;
      const field = input.dataset.field;
      if (!inputMap[pid]) inputMap[pid] = {};
      inputMap[pid][field] = parseInt(input.value, 10) || 0;
    });

    // Build flat rows — one row per delivery history entry (multiple rows per product if delivered in multiple shipments)
    const excelRows = [];
    rows.forEach(r => {
      const vals = inputMap[String(r.product.id)] || {};
      const qty      = vals.qty      !== undefined ? vals.qty      : r.qty;
      const assembled = vals.assembled !== undefined ? vals.assembled : r.assembled;
      const histEntries = r.isVariant ? [] : (deliveryHistoryExport.get(r.product.id) || []);

      if (histEntries.length === 0) {
        excelRows.push({
          '№': r.product.number,
          'Код': r.codeText || '',
          'Наименование': r.displayName || r.product.name,
          'Категория': r.product.category || '',
          'Количество': qty,
          'Доставлено': r.delivered,
          'Собрано': assembled,
          'Поставщик': '',
          'Дата отгрузки': '',
          'Заявка': '',
          'Кол-во в отгрузке': '',
        });
      } else {
        histEntries.forEach((entry, idx) => {
          let dateStr = entry.date || '';
          try { if (dateStr) dateStr = new Date(dateStr).toLocaleDateString('ru-RU'); } catch { /* */ }
          excelRows.push({
            '№':            idx === 0 ? r.product.number                    : '',
            'Код':          idx === 0 ? (r.codeText || '') : '',
            'Наименование': idx === 0 ? (r.displayName || r.product.name)    : '',
            'Категория':    idx === 0 ? (r.product.category || '') : '',
            'Количество':   idx === 0 ? qty                       : '',
            'Доставлено':   idx === 0 ? r.delivered               : '',
            'Собрано':      idx === 0 ? assembled                  : '',
            'Поставщик':        entry.supplierName || '—',
            'Дата отгрузки':    dateStr,
            'Заявка':           entry.orderNum || '—',
            'Кол-во в отгрузке': entry.qty,
          });
        });
      }
    });

    const ws = XLSX.utils.json_to_sheet(excelRows);
    ws['!cols'] = [
      { wch: 6 },  // №
      { wch: 14 }, // Код
      { wch: 36 }, // Наименование
      { wch: 16 }, // Категория
      { wch: 12 }, // Количество
      { wch: 12 }, // Доставлено
      { wch: 10 }, // Собрано
      { wch: 24 }, // Поставщик
      { wch: 14 }, // Дата отгрузки
      { wch: 20 }, // Заявка
      { wch: 16 }, // Кол-во в отгрузке
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Потребность');
    XLSX.writeFile(wb, 'Потребность_' + recipient.name.replace(/[^\wа-яёА-ЯЁ]/gi, '_') + '.xlsx');
    showToast(t('toast.exported'), 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast(t('toast.error'), 'error');
  }
}

// ─── Edit Recipient card ─────────────────────────────────────────

function openEditRecipient(recipientId) {
  const recipient = getRecipientById(recipientId);
  if (!recipient) return;
  editingRecipientId = recipientId;
  needsPanelOpen = false;
  needsFilter = '';
  needsSort = { key: 'number', dir: 'asc' };
  needsFilterSupplier = '';
  needsFilterOrder = '';
  needsFilterDateFrom = '';
  needsFilterDateTo = '';
  needsFilterDelivered = 'all';
  needsFilterName = '';
  needsFilterCategory = '';
  needsFilterGroup = '';
  needsAddressFilter = '';
  deliveryHistoryCache = new Map();

  $('editRecipientName').value = recipient.name;
  const initialAddresses = getRecipientAddresses(recipient);
  needsAddressFilter = initialAddresses[0] || '';
  renderRecipientAddressesEditor(initialAddresses);
  $('editRecipientReadiness').value = recipient.readinessStatus || '';

  // Populate program <select> from Finance module (single source of truth)
  const programSel = $('editRecipientProgram');
  const programHint = document.getElementById('editRecipientProgramHint');
  if (programSel) {
    const names = getProgramNames();
    const programs = state.programs || [];
    // Rebuild options: placeholder (disabled) + one per program from Finance
    const placeholderOpt = '<option value="" disabled>— Выберите программу —</option>';
    programSel.innerHTML = placeholderOpt +
      programs.map(program => {
        const value = String(program?.name || '').trim();
        const escValue = value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        const label = formatProgramLabel(program).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
        return `<option value="${escValue}">${label}</option>`;
      }).join('');
    // Select current value only if it exists in Finance programs
    const current = recipient.targetProgram || '';
    if (current && names.includes(current)) {
      programSel.value = current;
    } else {
      // Legacy or empty — reset to placeholder (force re-selection)
      programSel.value = '';
    }
    // Show hint when no programs have been created yet
    if (programHint) programHint.classList.toggle('hidden', names.length > 0);
  }

  // Reset needs toggle icon
  const icon = document.getElementById('needsToggleIcon');
  if (icon) icon.textContent = '▼';

  // Clear needs panel
  const wrap = document.getElementById('needsPanelWrap');
  if (wrap) clearChildren(wrap);

  // Update summary badge
  const needs = recipient.needs || {};
  const total = Object.values(needs).reduce((s, n) => s + (typeof n === 'object' ? (n.qty || 0) : (n || 0)), 0);
  const summary = $('editNeedsSummary');
  if (summary) {
    if (total > 0) {
      summary.textContent = t('recipients.totalItems', { count: total });
      summary.classList.remove('hidden');
    } else {
      summary.classList.add('hidden');
    }
  }

  $('recipientsPanel').classList.add('hidden');
  $('editRecipientPanel').classList.remove('hidden');
  setRecipientCardReadonly(false);
  setTimeout(() => $('editRecipientName')?.focus(), 100);
}

function collectRecipientAddressesFromDom() {
  const values = [];
  document.querySelectorAll('.recipient-address-input').forEach(input => {
    const value = input.value.trim();
    if (!value) return;
    if (!values.some(existing => existing.toLowerCase() === value.toLowerCase())) {
      values.push(value);
    }
  });
  return values;
}

function resolveNextNeedsAddressAfterAddressEdit(addresses = []) {
  if (addresses.includes(needsAddressFilter)) return needsAddressFilter;
  return addresses[0] || '';
}

function renderRecipientAddressesEditor(addresses = []) {
  const wrap = $('editRecipientAddressesWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const rows = addresses.length ? [...addresses] : [''];

  rows.forEach((address, idx) => {
    const row = el('div', {
      className: 'flex items-start gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-2.5',
    });

    const input = el('input', {
      type: 'text',
      className: 'recipient-address-input flex-1 rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      placeholder: t('recipients.addressPlaceholder') !== 'recipients.addressPlaceholder'
        ? t('recipients.addressPlaceholder')
        : 'г. Москва, ул. Примерная, д. 1',
      value: String(address || ''),
    });
    input.addEventListener('input', () => {
      needsAddressFilter = resolveNextNeedsAddressAfterAddressEdit(collectRecipientAddressesFromDom());
      if (needsPanelOpen && editingRecipientId !== null) {
        const recipient = getRecipientById(editingRecipientId);
        if (recipient) renderNeedsPanel(recipient);
      }
    });

    const delBtn = el('button', {
      type: 'button',
      className: 'recipient-address-action rounded-xl p-2 text-slate-500 hover:bg-red-500/15 hover:text-red-400 transition shrink-0',
      title: t('actions.delete'),
      'aria-label': t('actions.delete'),
      onClick: () => {
        const nextAddresses = [...wrap.querySelectorAll('.recipient-address-input')].map(inp => inp.value);
        nextAddresses.splice(idx, 1);
        needsAddressFilter = resolveNextNeedsAddressAfterAddressEdit(nextAddresses.map(value => String(value || '').trim()).filter(Boolean));
        renderRecipientAddressesEditor(nextAddresses);
        if (needsPanelOpen && editingRecipientId !== null) {
          const recipient = getRecipientById(editingRecipientId);
          if (recipient) renderNeedsPanel(recipient);
        }
      },
    }, '✕');

    row.append(input, delBtn);
    wrap.appendChild(row);
  });
}

function openViewRecipient(recipientId) {
  openEditRecipient(recipientId);
  setRecipientCardReadonly(true);
}

function setRecipientCardReadonly(readonly) {
  const panel = $('editRecipientPanel');
  if (!panel) return;
  panel.querySelectorAll('input, select, textarea').forEach(el => {
    el.disabled = readonly;
    el.style.opacity = readonly ? '0.7' : '';
    el.style.cursor = readonly ? 'default' : '';
  });
  const saveBtn = $('editRecipientSaveBtn');
  const editBtn = $('editRecipientEditBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', readonly);
  if (editBtn) editBtn.classList.toggle('hidden', !readonly);
  panel.querySelectorAll('[data-product-id]').forEach(inp => {
    inp.disabled = readonly;
    inp.style.opacity = readonly ? '0.7' : '';
    inp.style.cursor = readonly ? 'default' : '';
  });
  panel.querySelectorAll('#editRecipientAddAddressBtn, .recipient-address-action').forEach(btn => {
    btn.disabled = readonly;
    btn.style.opacity = readonly ? '0.5' : '';
    btn.style.cursor = readonly ? 'default' : '';
  });
}

function closeEditRecipient() {
  editingRecipientId = null;
  needsPanelOpen = false;
  $('editRecipientPanel').classList.add('hidden');
  $('recipientsPanel').classList.remove('hidden');
  renderRecipientsList();
}

/**
 * Save recipient card.
 * IMPORTANT: «delivered» is NOT read from DOM — it is preserved from the current state
 * so that shipment-applied values are never overwritten.
 */
function handleSaveRecipient() {
  if (editingRecipientId === null) return;

  syncAllRecipientNeedInputsFromDom();

  const name = $('editRecipientName').value.trim();
  if (!name) {
    showToast(t('form.required'), 'error');
    $('editRecipientName').focus();
    return;
  }

  // Целевая программа обязательна и должна быть из модуля «Финансы»
  const programSel = $('editRecipientProgram');
  const selectedProgram = programSel ? programSel.value.trim() : '';
  const validPrograms = getProgramNames();
  if (!selectedProgram || !validPrograms.includes(selectedProgram)) {
    showToast(t('recipients.programRequired'), 'error');
    // Highlight the select
    if (programSel) {
      programSel.style.borderColor = 'rgb(239,68,68)';
      programSel.focus();
      setTimeout(() => { programSel.style.borderColor = ''; }, 2500);
    }
    return;
  }

  const nextAddresses = collectRecipientAddressesFromDom();
  updateRecipient(editingRecipientId, {
    name,
    addresses: nextAddresses,
    readinessStatus: $('editRecipientReadiness').value.trim(),
    targetProgram: selectedProgram,
  });

  const updatedRecipient = getRecipientById(editingRecipientId);
  if (updatedRecipient) {
    seedRecipientAddressNeedsFromAggregate(updatedRecipient);
    pruneRecipientAddressNeeds(updatedRecipient, nextAddresses);
    rebuildRecipientNeedTotalsFromAddresses(updatedRecipient);
  }

  saveToStorage();
  showToast(t('toast.saved'), 'success');
  closeEditRecipient();
}

// ─── Delete Recipient ────────────────────────────────────────────

function handleDeleteRecipient(recipient) {
  if (!confirm(t('recipients.confirmDeleteTitle') + '\n' + t('recipients.confirmDeleteMessage'))) return;
  deleteRecipient(recipient.id);
  saveToStorage();
  showToast(t('toast.deleted'), 'success');
  renderRecipientsList();
}

// ─── Add Recipient ───────────────────────────────────────────────

function handleAddRecipient() {
  const input = $('newRecipientInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  const recipient = addRecipient(name);
  if (!recipient) return;
  saveToStorage();
  showToast(t('toast.recipientAdded'), 'success');
  input.value = '';
  openEditRecipient(recipient.id);
}

// ─── Open / Close ────────────────────────────────────────────────

export function openRecipientsModal() {
  const overlay = $('recipientsModal');
  if (!overlay) return;

  $('recipientsPanel').classList.remove('hidden');
  $('editRecipientPanel').classList.add('hidden');

  renderRecipientsList();
  overlay.classList.add('open');
  setTimeout(() => $('newRecipientInput')?.focus(), 100);
}

export function closeRecipientsModal() {
  editingRecipientId = null;
  const overlay = $('recipientsModal');
  if (overlay) overlay.classList.remove('open');
}

// ─── Init ────────────────────────────────────────────────────────

export function initRecipientsView() {
  const overlay = $('recipientsModal');
  if (!overlay) return;

  if (!_recipientNeedsSyncBound) {
    window.addEventListener('recipient-needs-saved', () => {
      const modal = $('recipientsModal');
      if (!modal?.classList.contains('open')) return;
      if (!$('recipientsPanel').classList.contains('hidden')) {
        renderRecipientsList();
      }
      if (editingRecipientId !== null && needsPanelOpen) {
        const recipient = getRecipientById(editingRecipientId);
        if (recipient) renderNeedsPanel(recipient);
      }
    });
    _recipientNeedsSyncBound = true;
  }

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeRecipientsModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      if (!$('editRecipientPanel').classList.contains('hidden')) {
        closeEditRecipient();
      } else {
        closeRecipientsModal();
      }
    }
  });

  const addBtn = $('addRecipientBtn');
  if (addBtn) addBtn.addEventListener('click', handleAddRecipient);
  const addInput = $('newRecipientInput');
  if (addInput) {
    addInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); handleAddRecipient(); }
    });
  }

  const editBackBtn = $('editRecipientBackBtn');
  if (editBackBtn) editBackBtn.addEventListener('click', closeEditRecipient);
  const editSaveBtn = $('editRecipientSaveBtn');
  if (editSaveBtn) editSaveBtn.addEventListener('click', handleSaveRecipient);

  const addAddressBtn = $('editRecipientAddAddressBtn');
  if (addAddressBtn) {
    addAddressBtn.addEventListener('click', () => {
      const addresses = collectRecipientAddressesFromDom();
      addresses.push('');
      needsAddressFilter = resolveNextNeedsAddressAfterAddressEdit(addresses.filter(Boolean));
      renderRecipientAddressesEditor(addresses);
      if (needsPanelOpen && editingRecipientId !== null) {
        const recipient = getRecipientById(editingRecipientId);
        if (recipient) renderNeedsPanel(recipient);
      }
      const inputs = document.querySelectorAll('.recipient-address-input');
      inputs[inputs.length - 1]?.focus();
    });
  }

  const editEditBtn = $('editRecipientEditBtn');
  if (editEditBtn) editEditBtn.addEventListener('click', () => setRecipientCardReadonly(false));

  const recipientsCloseBtn = $('recipientsCloseBtn');
  if (recipientsCloseBtn) recipientsCloseBtn.addEventListener('click', closeRecipientsModal);

  // Needs toggle button
  const needsToggleBtn = $('needsToggleBtn');
  if (needsToggleBtn) {
    needsToggleBtn.addEventListener('click', () => {
      if (editingRecipientId === null) return;
      needsPanelOpen = !needsPanelOpen;
      const recipient = getRecipientById(editingRecipientId);
      const icon = document.getElementById('needsToggleIcon');
      if (icon) icon.textContent = needsPanelOpen ? '▲' : '▼';
      renderNeedsPanel(recipient);
    });
  }
}
