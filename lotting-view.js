import {
  state,
  getLots,
  getLotById,
  findLotByNumber,
  addLot,
  updateLot,
  deleteLot,
  getRecipientById,
  getProductById,
  calcTotalNeedForProduct,
  normalizeNeedEntry,
  hasProductColorVariants,
  getProductColorVariants,
  syncLotsWithContracts,
  syncLotsFromContractCards,
} from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';
import { confirmDeleteWithImpact } from './dom.js';
import { enhancePredictiveInput } from './filters.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

let initialized = false;
let currentEditingLotId = null;
let draftLot = null;
let registryFilters = { lot: '', product: '', recipient: '' };

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function modal(id) {
  return document.getElementById(id);
}

function normalizeRecipientIds(recipientIds = []) {
  const resolved = (Array.isArray(recipientIds) ? recipientIds : [])
    .map((value) => {
      if (typeof value === 'number') return Number(value) || 0;
      if (typeof value === 'string') {
        const trimmed = value.trim();
        const numeric = Number(trimmed);
        if (Number.isFinite(numeric) && numeric > 0) return numeric;
        const byName = (state.recipients || []).find((recipient) =>
          String(recipient?.name || '').trim().toLowerCase() === trimmed.toLowerCase()
        );
        return byName ? Number(byName.id) || 0 : 0;
      }
      if (value && typeof value === 'object') {
        const directId = Number(value.id ?? value.recipientId ?? value.value ?? value.key ?? 0) || 0;
        if (directId > 0) return directId;
        const name = String(value.name ?? value.recipientName ?? value.label ?? value.title ?? '').trim();
        if (!name) return 0;
        const byName = (state.recipients || []).find((recipient) =>
          String(recipient?.name || '').trim().toLowerCase() === name.toLowerCase()
        );
        return byName ? Number(byName.id) || 0 : 0;
      }
      return 0;
    })
    .filter(Boolean);
  return [...new Set(resolved)];
}

function findContractForLot(lot) {
  if (!lot) return null;

  if (lot.contractId != null) {
    const byId = (state.contracts || []).find(contract => String(contract.id) === String(lot.contractId));
    if (byId) return byId;
  }

  const contractNumber = String(lot.contractNumber || '').trim().toLowerCase();
  if (contractNumber) {
    const byNumber = (state.contracts || []).find(contract => String(contract.number || '').trim().toLowerCase() === contractNumber);
    if (byNumber) return byNumber;
  }

  const lotNumber = String(lot.lotNumber || '').trim().toLowerCase();
  if (lotNumber) {
    return (state.contracts || []).find(contract => String(contract.lotNumber || '').trim().toLowerCase() === lotNumber) || null;
  }

  return null;
}

function inferRecipientIdsFromContract(contract) {
  if (!contract?.id) return [];
  const ids = new Set();

  (state.orders || []).forEach((order) => {
    if (String(order?.contractId) !== String(contract.id)) return;
    (order.deliveryRows || []).forEach((row) => {
      (row.recipients || []).forEach((recipient) => {
        const recipientId = Number(recipient?.recipientId) || 0;
        if (recipientId > 0) ids.add(recipientId);
      });
    });
  });

  (state.directDeliveries || []).forEach((delivery) => {
    if (String(delivery?.contractId) !== String(contract.id)) return;
    (delivery.rows || []).forEach((row) => {
      const recipientId = Number(row?.recipientId) || 0;
      if (recipientId > 0) ids.add(recipientId);
    });
  });

  return [...ids];
}

function getEffectiveLotRecipientIds(lotOrRecipientIds = null) {
  if (Array.isArray(lotOrRecipientIds)) {
    const normalized = normalizeRecipientIds(lotOrRecipientIds);
    return normalized.length ? normalized : [];
  }

  const lot = lotOrRecipientIds;
  const explicitIds = normalizeRecipientIds(lot?.recipientIds);
  if (explicitIds.length) return explicitIds;

  const contract = findContractForLot(lot);
  return inferRecipientIdsFromContract(contract);
}

function cloneLot(lot) {
  const source = lot || {
    id: null,
    lotNumber: '',
    contractId: null,
    contractNumber: '',
    recipientIds: [],
    items: [],
  };
  return {
    id: source.id ?? null,
    lotNumber: source.lotNumber || '',
    contractId: source.contractId ?? null,
    contractNumber: source.contractNumber || '',
    recipientIds: getEffectiveLotRecipientIds(source),
    items: Array.isArray(source.items)
      ? source.items.map((item) => {
          const resolvedProductId = Number(item.productId) || Number(item.productRef) || null;
          const resolvedProduct = resolvedProductId ? getProductById(resolvedProductId) : null;
          return {
            productId: resolvedProductId,
            productName: item.productName || resolvedProduct?.name || '',
            productCode: item.productCode || resolvedProduct?.code || '',
            qty: Number(item.qty) || 0,
            nmcd: item?.nmcd != null && item?.nmcd !== '' ? (Number(item.nmcd) || 0) : 0,
          };
        })
      : [],
  };
}

function getEditableLot() {
  return draftLot || cloneLot(currentEditingLotId != null ? getLotById(currentEditingLotId) : null);
}

function summarizeLot(lot) {
  const items = Array.isArray(lot?.items) ? lot.items : [];
  return {
    itemCount: items.length,
    totalQty: items.reduce((sum, item) => sum + (Number(item.qty) || 0), 0),
    totalPrice: items.reduce((sum, item) => sum + ((Number(item.qty) || 0) * (Number(item.nmcd) || 0)), 0),
  };
}

function calcLotTotalPrice(items = []) {
  return (Array.isArray(items) ? items : []).reduce(
    (sum, item) => sum + ((Number(item?.qty) || 0) * (Number(item?.nmcd) || 0)),
    0,
  );
}

function getRecipientNamesFromIds(recipientIds = []) {
  return normalizeRecipientIds(recipientIds)
    .map((recipientId) => getRecipientById(recipientId)?.name || '')
    .filter(Boolean);
}

function getRecipientPrimaryAddress(recipient) {
  if (!recipient) return '';
  if (Array.isArray(recipient.addresses) && recipient.addresses.length) return recipient.addresses[0] || '';
  return recipient.address || '';
}

function getRecipientDisplay(recipient) {
  if (!recipient) return '';
  const address = getRecipientPrimaryAddress(recipient);
  return address ? `${recipient.name} — ${address}` : String(recipient.name || '');
}

function getRecipientOptions() {
  return [...(state.recipients || [])]
    .sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'))
    .map((recipient) => ({
      id: Number(recipient.id) || null,
      name: recipient.name || '',
      address: getRecipientPrimaryAddress(recipient),
      display: getRecipientDisplay(recipient),
    }))
    .filter(option => option.id && option.name);
}

function resolveRecipientOption(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return getRecipientOptions().find((option) => {
    if (option.display.trim().toLowerCase() === needle) return true;
    if (option.name.trim().toLowerCase() === needle) return true;
    return false;
  }) || null;
}

function getScopedRecipientIds(recipientIds = null) {
  const source = recipientIds == null ? getEditableLot() : recipientIds;
  const normalized = getEffectiveLotRecipientIds(source);
  return normalized.length ? normalized : null;
}

function sumLegacyAggregateNeed(productId, recipientIds = null) {
  const numericId = Number(productId) || 0;
  if (numericId <= 0) return 0;

  const scopedRecipientIds = getScopedRecipientIds(recipientIds);
  let total = 0;

  for (const recipient of (state.recipients || [])) {
    if (scopedRecipientIds && !scopedRecipientIds.includes(Number(recipient.id) || 0)) continue;
    const rawEntry = recipient?.needs?.[numericId];
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const normalized = normalizeNeedEntry(rawEntry, getProductById(numericId));
    const hasVariants = normalized?.variants && Object.keys(normalized.variants).length > 0;
    if (hasVariants) continue;
    total += Number(normalized?.qty) || 0;
  }

  return total;
}

function sumNeedByProductIdentity({ productId = null, productName = '', productCode = '' } = {}, recipientIds = null) {
  const numericId = Number(productId) || 0;
  const nameNeedle = String(productName || '').trim().toLowerCase();
  const codeNeedle = String(productCode || '').trim().toLowerCase();
  const scopedRecipientIds = getScopedRecipientIds(recipientIds);
  let total = 0;

  for (const recipient of (state.recipients || [])) {
    if (scopedRecipientIds && !scopedRecipientIds.includes(Number(recipient.id) || 0)) continue;
    const needs = recipient?.needs && typeof recipient.needs === 'object' ? recipient.needs : null;
    if (!needs) continue;

    for (const [rawProductId, rawEntry] of Object.entries(needs)) {
      const needProductId = Number(rawProductId) || 0;
      if (!needProductId) continue;

      const needProduct = getProductById(needProductId);
      const needName = String(needProduct?.name || '').trim().toLowerCase();
      const needCode = String(needProduct?.code || '').trim().toLowerCase();

      const matchById = numericId > 0 && needProductId === numericId;
      const matchByCode = !matchById && codeNeedle && needCode && codeNeedle === needCode;
      const matchByName = !matchById && !matchByCode && nameNeedle && needName && nameNeedle === needName;
      if (!matchById && !matchByCode && !matchByName) continue;

      const normalized = normalizeNeedEntry(rawEntry, needProduct);
      const hasVariants = normalized?.variants && Object.keys(normalized.variants).length > 0;
      if (hasVariants) {
        total += Object.values(normalized.variants).reduce((sum, variant) => sum + (Number(variant?.qty) || 0), 0);
      } else {
        total += Number(normalized?.qty) || 0;
      }
    }
  }

  return total;
}

function lotMatchesRecipientScope(lot, scopedRecipientIds = null) {
  if (!scopedRecipientIds || scopedRecipientIds.length === 0) return true;
  const lotRecipientIds = getScopedRecipientIds(lot);
  if (!lotRecipientIds || lotRecipientIds.length === 0) return false;
  const scope = new Set(scopedRecipientIds.map(id => String(id)));
  return lotRecipientIds.some(id => scope.has(String(id)));
}

function getProductNeed(productRef, recipientIds = null) {
  const numericId = typeof productRef === 'object'
    ? (Number(productRef?.productId) || Number(productRef?.id) || 0)
    : (Number(productRef) || 0);
  const product = typeof productRef === 'object'
    ? (getProductById(numericId) || productRef || null)
    : getProductById(numericId);
  const productName = typeof productRef === 'object'
    ? (productRef?.productName || productRef?.name || product?.name || '')
    : (product?.name || '');
  const productCode = typeof productRef === 'object'
    ? (productRef?.productCode || productRef?.code || product?.code || '')
    : (product?.code || '');

  if (numericId <= 0 && !productName && !productCode) return 0;
  const scopedRecipientIds = getScopedRecipientIds(recipientIds);
  const total = Number(calcTotalNeedForProduct(numericId, scopedRecipientIds)) || 0;
  if (total > 0) return total;

  const fallbackIdentityTotal = sumNeedByProductIdentity({ productId: numericId, productName, productCode }, scopedRecipientIds);
  if (fallbackIdentityTotal > 0) return fallbackIdentityTotal;

  if (!hasProductColorVariants(product)) return total;

  return sumLegacyAggregateNeed(numericId, scopedRecipientIds);
}

function getAllocatedNeedForProduct(productId, recipientIds = null, excludeLotId = null) {
  const numericId = Number(productId) || 0;
  if (numericId <= 0) return 0;
  const totals = getLotValidationMap(excludeLotId, null, recipientIds);
  return Number(totals.get(numericId) || 0);
}

function getUnlottedNeed(productId, recipientIds = null, excludeLotId = null) {
  const product = getProductById(Number(productId) || 0);
  const totalNeed = getProductNeed(product || { id: productId }, recipientIds);
  const allocated = getAllocatedNeedForProduct(productId, recipientIds, excludeLotId);
  return Math.max(0, totalNeed - allocated);
}

function getProductDisplay(product) {
  const number = product?.number != null && product.number !== '' ? String(product.number) : '—';
  const code = String(product?.code || '').trim();
  const codePart = code ? ` · ${code}` : '';
  return `${number}${codePart} · ${product?.name || ''}`;
}

function getProductOptions() {
  const lot = getEditableLot();
  const selectedIds = new Set((lot.items || []).map(item => Number(item.productId)).filter(Boolean));
  const scopedRecipientIds = getScopedRecipientIds(lot.recipientIds);
  return [...(state.products || [])]
    .filter((product) => getUnlottedNeed(product.id, scopedRecipientIds, currentEditingLotId) > 0 || selectedIds.has(Number(product.id)))
    .sort((a, b) => {
      const aNum = Number(a.number) || Number.MAX_SAFE_INTEGER;
      const bNum = Number(b.number) || Number.MAX_SAFE_INTEGER;
      if (aNum !== bNum) return aNum - bNum;
      return String(a.name || '').localeCompare(String(b.name || ''), 'ru');
    })
    .map((product) => ({
      id: Number(product.id) || null,
      number: product.number,
      name: product.name || '',
      code: product.code || '',
      category: product.category || '',
      display: getProductDisplay(product),
      needQty: getUnlottedNeed(product.id, scopedRecipientIds, currentEditingLotId),
    }))
    .filter(option => option.id && option.name);
}

function formatQty(value) {
  return new Intl.NumberFormat('ru-RU').format(Number(value) || 0);
}

function formatMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function resolveProductOption(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return getProductOptions().find((option) => {
    if (option.display.trim().toLowerCase() === needle) return true;
    if (String(option.name || '').trim().toLowerCase() === needle) return true;
    if (String(option.code || '').trim().toLowerCase() === needle) return true;
    return false;
  }) || null;
}

function resolveItemProduct(item) {
  const directProductId = Number(item?.productId) || Number(item?.productRef) || null;
  if (directProductId) {
    const byDirectId = getProductById(directProductId);
    if (byDirectId) return byDirectId;
  }

  const productId = Number(item?.productId) || null;
  if (productId) {
    const product = getProductById(productId);
    if (product) return product;
  }

  const code = String(item?.productCode || '').trim().toLowerCase();
  if (code) {
    for (const contract of (state.contracts || [])) {
      const contractItem = (contract.items || []).find((entry) => {
        const entryCode = String(entry?.code || '').trim().toLowerCase();
        return entryCode && entryCode === code;
      });
      const resolvedId = Number(contractItem?.productRef) || Number(contractItem?.productId) || null;
      if (resolvedId) {
        const byContractCode = getProductById(resolvedId);
        if (byContractCode) return byContractCode;
      }
    }

    const byCode = (state.products || []).find(product => String(product.code || '').trim().toLowerCase() === code);
    if (byCode) return byCode;
  }

  const name = String(item?.productName || '').trim().toLowerCase();
  if (name) {
    const byName = (state.products || []).find(product => String(product.name || '').trim().toLowerCase() === name);
    if (byName) return byName;

    const byContractName = (state.contracts || [])
      .flatMap(contract => contract.items || [])
      .find((entry) => String(entry?.name || '').trim().toLowerCase() === name && (entry?.productRef != null || entry?.productId != null));
    const resolvedId = Number(byContractName?.productRef) || Number(byContractName?.productId) || null;
    if (resolvedId) {
      const byMappedName = getProductById(resolvedId);
      if (byMappedName) return byMappedName;
    }
  }
  return null;
}

function getLotValidationMap(excludeLotId = null, itemsOverride = null, recipientIds = null) {
  const totals = new Map();
  const scopedRecipientIds = getScopedRecipientIds(recipientIds);
  (getLots() || []).forEach((lot) => {
    if (excludeLotId != null && String(lot.id) === String(excludeLotId)) return;
    if (!lotMatchesRecipientScope(lot, scopedRecipientIds)) return;
    (lot.items || []).forEach((item) => {
      const productId = Number(item.productId) || resolveItemProduct(item)?.id || null;
      if (!productId) return;
      totals.set(productId, (totals.get(productId) || 0) + (Number(item.qty) || 0));
    });
  });
  if (Array.isArray(itemsOverride)) {
    itemsOverride.forEach((item) => {
      const productId = Number(item.productId) || resolveItemProduct(item)?.id || null;
      if (!productId) return;
      totals.set(productId, (totals.get(productId) || 0) + (Number(item.qty) || 0));
    });
  }
  return totals;
}

function getItemValidation(item, excludeLotId = null) {
  const lot = getEditableLot();
  const product = resolveItemProduct(item);
  const productId = Number(item.productId) || product?.id || null;
  const qty = Number(item.qty) || 0;
  const totalNeedQty = getProductNeed({
    id: productId,
    productId,
    productName: item?.productName || product?.name || '',
    productCode: item?.productCode || product?.code || '',
  }, lot?.recipientIds);
  const otherLotsQty = productId ? getAllocatedNeedForProduct(productId, lot?.recipientIds, excludeLotId) : 0;
  const needQty = productId ? Math.max(0, totalNeedQty - otherLotsQty) : 0;
  const totalQty = otherLotsQty + qty;
  const diff = needQty - qty;

  let status = 'under';
  if ((!productId && !item?.productName && !item?.productCode) || totalNeedQty <= 0) status = qty > 0 ? 'noneed' : 'empty';
  else if (diff < 0) status = 'over';
  else if (diff === 0) status = 'exact';

  return {
    product,
    productId,
    qty,
    totalNeedQty,
    needQty,
    otherLotsQty,
    totalQty,
    diff,
    status,
  };
}

function getDraftValidationSummary() {
  const lot = getEditableLot();
  const summary = { exact: 0, under: 0, over: 0, noneed: 0 };
  (lot.items || []).forEach((item) => {
    const result = getItemValidation(item, currentEditingLotId);
    if (result.status === 'exact') summary.exact += 1;
    else if (result.status === 'over') summary.over += 1;
    else if (result.status === 'noneed') summary.noneed += 1;
    else summary.under += 1;
  });
  return summary;
}

function getFilteredLots() {
  const lotQuery = String(registryFilters.lot || '').trim().toLowerCase();
  const productQuery = String(registryFilters.product || '').trim().toLowerCase();
  const recipientQuery = String(registryFilters.recipient || '').trim().toLowerCase();

  return [...getLots()].filter((lot) => {
    const recipientNames = getRecipientNamesFromIds(lot.recipientIds).join(' ').toLowerCase();
    const productHaystack = (lot.items || [])
      .map((item) => `${item.productName || ''} ${item.productCode || ''}`)
      .join(' ')
      .toLowerCase();
    const lotHaystack = `${lot.lotNumber || ''} ${lot.contractNumber || ''}`.toLowerCase();

    if (lotQuery && !lotHaystack.includes(lotQuery)) return false;
    if (productQuery && !productHaystack.includes(productQuery)) return false;
    if (recipientQuery && !recipientNames.includes(recipientQuery)) return false;
    return true;
  }).sort((a, b) => String(a.lotNumber || '').localeCompare(String(b.lotNumber || ''), 'ru'));
}

function getAllLotOptions() {
  return [...new Set(getLots().map((lot) => String(lot.lotNumber || '').trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru'));
}

function getAllRecipientOptions() {
  return [...new Set(getLots().flatMap((lot) => getRecipientNamesFromIds(lot.recipientIds)))].sort((a, b) => a.localeCompare(b, 'ru'));
}

function getAllProductOptions() {
  return [...new Set(getLots().flatMap((lot) => (lot.items || []).map((item) => item.productCode ? `${item.productName} — ${item.productCode}` : item.productName)).filter(Boolean))]
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

function ensureLottingModal() {
  if (modal('lottingModal')) return;
  const root = document.createElement('div');
  root.innerHTML = `
    <div id="lottingModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="lottingModalTitle">
      <div id="lottingListPanel" class="modal-panel module-hub-modal w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl mx-4 max-h-[85vh] flex flex-col overflow-hidden" style="width:min(97vw,1380px);max-width:none;max-height:94vh;">
        <div class="flex items-center justify-between gap-3 mb-4 shrink-0 flex-wrap">
          <div>
            <h2 id="lottingModalTitle" class="text-xl font-bold text-white">${escHtml(tf('lotting.title', 'Лотирование'))}</h2>
            <p class="mt-1 text-xs text-slate-500">${escHtml(tf('lotting.subtitle', 'Распределение потребности по лотам'))}</p>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button id="lottingImportBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-200 transition hover:bg-white/10 active:scale-[0.97]">📥 ${escHtml(tf('lotting.importBtn', 'Импорт Excel'))}</button>
            <button id="lottingSyncContractsBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-violet-400/25 bg-violet-400/10 px-4 py-2.5 text-sm font-medium text-violet-200 transition hover:bg-violet-400/15 active:scale-[0.97]">🔄 ${escHtml(tf('lotting.syncFromContractsBtn', 'Сформировать из контрактов'))}</button>
            <button id="lottingExportBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-4 py-2.5 text-sm font-semibold text-emerald-300 transition hover:bg-emerald-400/15 active:scale-[0.97]">📤 ${escHtml(tf('lotting.exportBtn', 'Экспорт Excel'))}</button>
            <button id="lottingAddBtn" type="button" class="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 active:scale-[0.97]">＋ ${escHtml(tf('lotting.addBtn', 'Новый лот'))}</button>
            <input id="lottingImportInput" type="file" accept=".xlsx,.xls" hidden>
          </div>
        </div>
        <div class="grid grid-cols-1 gap-3 md:grid-cols-3 mb-4 shrink-0">
          <label>
            <span class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.filterLot', 'Лот'))}</span>
            <input id="lottingFilterLot" list="lottingFilterLotOptions" type="text" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.filterLotPlaceholder', 'Номер лота'))}">
            <datalist id="lottingFilterLotOptions"></datalist>
          </label>
          <label>
            <span class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.filterProduct', 'Товар'))}</span>
            <input id="lottingFilterProduct" list="lottingFilterProductOptions" type="text" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.filterProductPlaceholder', 'Наименование товара'))}">
            <datalist id="lottingFilterProductOptions"></datalist>
          </label>
          <label>
            <span class="mb-1.5 block text-[11px] font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.filterRecipient', 'Получатель'))}</span>
            <input id="lottingFilterRecipient" list="lottingFilterRecipientOptions" type="text" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.filterRecipientPlaceholder', 'Получатель'))}">
            <datalist id="lottingFilterRecipientOptions"></datalist>
          </label>
        </div>
        <div id="lottingListWrap" class="flex-1 overflow-auto"></div>
        <div class="mt-4 flex justify-end shrink-0">
          <button id="lottingCloseBtn" type="button" class="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10">${escHtml(tf('actions.close', 'Закрыть'))}</button>
        </div>
      </div>
      <div id="lottingEditPanel" class="hidden catalog-panel w-full h-full flex flex-col bg-slate-950 overflow-hidden">
        <div class="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10 bg-slate-950/80 backdrop-blur-sm shrink-0 gap-3 flex-wrap">
          <div class="flex items-center gap-3">
            <button id="lottingCardBackBtn" type="button" class="rounded-xl p-2 text-slate-400 hover:bg-white/10 hover:text-white transition" aria-label="${escHtml(tf('actions.close', 'Закрыть'))}">←</button>
            <div>
              <p class="text-xs font-semibold uppercase tracking-wider text-cyan-400">${escHtml(tf('lotting.title', 'Лотирование'))}</p>
              <h2 id="lottingCardTitle" class="text-lg font-bold text-white">${escHtml(tf('lotting.newCard', 'Новый лот'))}</h2>
            </div>
          </div>
          <div class="flex items-center gap-2 flex-wrap">
            <button id="lottingDeleteBtn" type="button" class="hidden rounded-xl border border-red-400/25 bg-red-400/10 px-4 py-2.5 text-sm font-semibold text-red-300 transition hover:bg-red-400/15">🗑️ ${escHtml(tf('actions.delete', 'Удалить'))}</button>
            <button id="lottingSaveBtn" type="button" class="rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">${escHtml(tf('actions.save', 'Сохранить'))}</button>
          </div>
        </div>
        <div id="lottingCardBody" class="flex-1 overflow-auto px-4 sm:px-6 py-5"></div>
      </div>
    </div>`;
  document.body.appendChild(root.firstElementChild);
}

function syncLotRegistryFromContracts(showFeedback = false, forceUpdate = false) {
  const stats = syncLotsFromContractCards(null, { forceUpdate });
  syncLotsWithContracts();
  const touched = (stats.created || 0) + (stats.updated || 0) + (stats.linked || 0);
  if (touched > 0) {
    Promise.resolve(saveToStorage()).catch(() => {});
  }
  if (showFeedback) {
    const touched = (stats.created || 0) + (stats.updated || 0);
    if (touched > 0) {
      showToast(
        tf('lotting.syncFromContractsDone', 'Лоты обновлены из карточек контрактов: {count}', { count: touched }),
        'success'
      );
    } else {
      showToast(
        tf('lotting.syncFromContractsEmpty', 'Контрактов с номерами лотов для синхронизации не найдено'),
        'info'
      );
    }
  }
  return stats;
}

function renderLottingList() {
  const wrap = modal('lottingListWrap');
  if (!wrap) return;

  const lots = getFilteredLots();
  const lotOptions = getAllLotOptions();
  const productOptions = getAllProductOptions();
  const recipientOptions = getAllRecipientOptions();

  const lotList = modal('lottingFilterLotOptions');
  const productList = modal('lottingFilterProductOptions');
  const recipientList = modal('lottingFilterRecipientOptions');
  if (lotList) lotList.innerHTML = lotOptions.map((value) => `<option value="${escHtml(value)}"></option>`).join('');
  if (productList) productList.innerHTML = productOptions.map((value) => `<option value="${escHtml(value)}"></option>`).join('');
  if (recipientList) recipientList.innerHTML = recipientOptions.map((value) => `<option value="${escHtml(value)}"></option>`).join('');

  if (!lots.length) {
    wrap.innerHTML = `
      <div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-12 text-center">
        <div class="text-5xl mb-3">🧩</div>
        <p class="text-sm font-semibold text-white">${escHtml(tf('lotting.empty', 'Лоты пока не созданы'))}</p>
        <p class="mt-1 text-xs text-slate-500">${escHtml(tf('lotting.emptyHint', 'Добавьте первый лот и распределите товары по нему'))}</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="tbl-scroll">
      <table class="min-w-full text-sm text-left">
        <thead>
          <tr class="border-b border-white/10 bg-white/[0.03]">
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colLot', 'Лот'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colContract', 'Контракт'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colItems', 'Товаров'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colQty', 'Количество'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colLotPrice', 'Цена лота, ₽'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colRecipients', 'Получатели'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">${escHtml(tf('actions.view', 'Просмотр'))}</th>
          </tr>
        </thead>
        <tbody>
          ${lots.map((lot) => {
            const stats = summarizeLot(lot);
            const recipients = getRecipientNamesFromIds(lot.recipientIds);
            return `
              <tr class="border-b border-white/5 hover:bg-white/[0.02] cursor-pointer" data-open-lot="${lot.id}">
                <td class="px-3 py-3">
                  <div class="text-sm font-semibold text-white">${escHtml(lot.lotNumber || '—')}</div>
                  <div class="mt-1 text-[11px] text-slate-500">${escHtml(tf('lotting.rowsCount', '{count} строк', { count: stats.itemCount }))}</div>
                </td>
                <td class="px-3 py-3 text-sm ${lot.contractNumber ? 'text-cyan-300' : 'text-slate-500'}">${escHtml(lot.contractNumber || tf('lotting.noContract', 'Не привязан'))}</td>
                <td class="px-3 py-3 text-sm text-slate-200 tabular-nums">${stats.itemCount}</td>
                <td class="px-3 py-3 text-sm text-emerald-300 tabular-nums">${stats.totalQty}</td>
                <td class="px-3 py-3 text-sm text-amber-200 tabular-nums">${formatMoney(stats.totalPrice)}</td>
                <td class="px-3 py-3 text-xs text-slate-400">${escHtml(recipients.length ? recipients.join(', ') : tf('lotting.noRecipients', 'Без получателей'))}</td>
                <td class="px-3 py-3 text-right"><button type="button" data-open-lot-btn="${lot.id}" class="rounded-xl border border-white/10 bg-white/[0.05] px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/[0.09]">${escHtml(tf('actions.edit', 'Редактировать'))}</button></td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  wrap.querySelectorAll('[data-open-lot], [data-open-lot-btn]').forEach((el) => {
    el.addEventListener('click', () => openLotCard(Number(el.dataset.openLot || el.dataset.openLotBtn)));
  });
}

function renderRecipientChips(recipientIds) {
  if (!recipientIds.length) {
    return `<div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-4 text-sm text-slate-500">${escHtml(tf('lotting.recipientSelectedEmpty', 'Получатели не выбраны'))}</div>`;
  }
  return `
    <div class="flex flex-wrap gap-2">
      ${recipientIds.map((recipientId) => {
        const recipient = getRecipientById(recipientId);
        if (!recipient) return '';
        const address = getRecipientPrimaryAddress(recipient);
        return `
          <span class="inline-flex max-w-full items-center gap-2 rounded-full border border-cyan-400/20 bg-cyan-400/10 px-3 py-1.5 text-xs text-cyan-100">
            <span class="truncate">${escHtml(recipient.name || '')}${address ? ` · ${escHtml(address)}` : ''}</span>
            <button type="button" data-remove-recipient="${recipientId}" class="rounded-full bg-white/10 px-1.5 py-0.5 text-[11px] text-white hover:bg-white/20" aria-label="${escHtml(tf('lotting.removeRecipient', 'Убрать получателя'))}">✕</button>
          </span>`;
      }).join('')}
    </div>`;
}

function renderSelectedItemsTable(items) {
  if (!items.length) {
    return `<div class="rounded-2xl border border-dashed border-white/10 bg-white/[0.02] px-4 py-5 text-sm text-slate-500">${escHtml(tf('lotting.productSelectedEmpty', 'Товары в лот пока не добавлены'))}</div>`;
  }

  const rows = [...items].sort((a, b) => {
    const productA = resolveItemProduct(a);
    const productB = resolveItemProduct(b);
    const aNum = Number(productA?.number) || Number.MAX_SAFE_INTEGER;
    const bNum = Number(productB?.number) || Number.MAX_SAFE_INTEGER;
    if (aNum !== bNum) return aNum - bNum;
    return String((productA?.name || a.productName || '')).localeCompare(String((productB?.name || b.productName || '')), 'ru');
  });

  return `
    <div class="tbl-scroll">
      <table class="min-w-full text-sm text-left">
        <thead>
          <tr class="border-b border-white/10 bg-white/[0.03]">
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">№</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colProduct', 'Товар'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colCode', 'Код'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colNmcd', 'НМЦД, ₽'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colNeed', 'Потребность'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colQty', 'Количество'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500">${escHtml(tf('lotting.colStatus', 'Статус'))}</th>
            <th class="px-3 py-2.5 text-[10px] font-semibold uppercase tracking-wider text-slate-500 text-right">${escHtml(tf('lotting.colActions', 'Действия'))}</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((item) => {
            const product = resolveItemProduct(item);
            const number = product?.number != null && product.number !== '' ? String(product.number) : '—';
            const name = item.productName || product?.name || tf('warehouse.unknownProduct', 'Товар удалён');
            const code = item.productCode || product?.code || '—';
            const category = product?.category || '';
            const pid = Number(item.productId) || product?.id || 0;
            return `
              <tr class="border-b border-white/5 align-top" data-lot-row="${pid}">
                <td class="px-3 py-3 text-xs text-slate-500 tabular-nums">${escHtml(number)}</td>
                <td class="px-3 py-3">
                  <div class="text-sm font-medium text-white">${escHtml(name)}</div>
                  ${category ? `<div class="mt-1 text-[11px] text-slate-500">${escHtml(category)}</div>` : ''}
                </td>
                <td class="px-3 py-3 text-xs font-mono text-cyan-300">${escHtml(code)}</td>
                <td class="px-3 py-3">
                  <input data-nmcd-input="${pid}" type="number" min="0" step="0.01" value="${escHtml(item.nmcd || '')}" class="w-32 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white tabular-nums" placeholder="0.00">
                </td>
                <td class="px-3 py-3">
                  <div data-need-summary="${pid}" class="text-xs text-slate-400"></div>
                </td>
                <td class="px-3 py-3">
                  <input data-qty-input="${pid}" type="number" min="0" step="1" value="${escHtml(item.qty || '')}" class="w-28 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white tabular-nums" placeholder="0">
                </td>
                <td class="px-3 py-3">
                  <span data-need-badge="${pid}" class="inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold"></span>
                </td>
                <td class="px-3 py-3 text-right">
                  <button type="button" data-remove-product="${pid}" class="rounded-xl border border-red-400/20 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-200 transition hover:bg-red-400/15">✕</button>
                </td>
              </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;
}

function renderLotCard() {
  const wrap = modal('lottingCardBody');
  const titleEl = modal('lottingCardTitle');
  const deleteBtn = modal('lottingDeleteBtn');
  if (!wrap || !titleEl || !deleteBtn) return;

  const lot = getEditableLot();
  const lotTotalPrice = calcLotTotalPrice(lot.items || []);
  const recipientOptions = getRecipientOptions();
  const productOptions = getProductOptions();

  titleEl.textContent = lot.lotNumber
    ? tf('lotting.cardTitle', 'Лот {number}', { number: lot.lotNumber })
    : tf('lotting.newCard', 'Новый лот');
  deleteBtn.classList.toggle('hidden', !lot.id);

  wrap.innerHTML = `
    <div class="space-y-6">
      <section>
        <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">${escHtml(tf('lotting.sectionInfo', 'Основная информация'))}</h3>
        <div class="grid grid-cols-1 gap-4 lg:grid-cols-3">
          <label>
            <span class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.fieldNumber', 'Номер лота'))}</span>
            <input id="lotCardNumber" type="text" value="${escHtml(lot.lotNumber || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.fieldNumberPlaceholder', 'Например: КР2026-176П1'))}">
          </label>
          <div>
            <span class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.fieldContractNumber', 'Номер контракта'))}</span>
            <div class="rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm ${lot.contractNumber ? 'text-cyan-300' : 'text-slate-500'}">${escHtml(lot.contractNumber || tf('lotting.contractAutoHint', 'Подтянется после сохранения контракта'))}</div>
          </div>
          <div>
            <span class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.fieldLotPrice', 'Цена лота, ₽'))}</span>
            <div class="rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-2.5 text-sm font-semibold text-amber-100 tabular-nums">${escHtml(formatMoney(lotTotalPrice))}</div>
          </div>
        </div>
      </section>

      <section>
        <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">${escHtml(tf('lotting.sectionRecipients', 'Получатели (необязательно)'))}</h3>
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label class="flex-1 min-w-0">
            <span class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.recipientPickerLabel', 'Получатель'))}</span>
            <input id="lotCardRecipientPicker" list="lotCardRecipientPickerOptions" type="text" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.recipientPickerPlaceholder', 'Начните вводить имя получателя'))}">
            <datalist id="lotCardRecipientPickerOptions">${recipientOptions.map(option => `<option value="${escHtml(option.display)}"></option>`).join('')}</datalist>
          </label>
          <button id="lotCardRecipientAddBtn" type="button" class="rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-4 py-2.5 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/15">${escHtml(tf('lotting.recipientAddBtn', 'Добавить получателя'))}</button>
        </div>
        <div id="lotCardRecipientChips" class="mt-3">${renderRecipientChips(lot.recipientIds || [])}</div>
      </section>

      <section>
        <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">${escHtml(tf('lotting.sectionItems', 'Товары лота'))}</h3>
        <div class="flex flex-col gap-3 lg:flex-row lg:items-end">
          <label class="flex-1 min-w-0">
            <span class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('lotting.productPickerLabel', 'Товар'))}</span>
            <input id="lotCardProductPicker" list="lotCardProductPickerOptions" type="text" class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2.5 text-sm text-white" placeholder="${escHtml(tf('lotting.productPickerPlaceholder', 'Начните вводить товар или код'))}">
            <datalist id="lotCardProductPickerOptions">${productOptions.map(option => `<option value="${escHtml(option.display)}"></option>`).join('')}</datalist>
          </label>
          <button id="lotCardProductAddBtn" type="button" class="rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-4 py-2.5 text-sm font-semibold text-cyan-200 transition hover:bg-cyan-400/15">${escHtml(tf('lotting.productAddBtn', 'Добавить товар'))}</button>
        </div>
        <div id="lotCardValidationSummary" class="mt-3 rounded-2xl border border-white/10 bg-white/[0.03] px-4 py-3 text-sm text-slate-300"></div>
        <div class="mt-3">${renderSelectedItemsTable(lot.items || [])}</div>
      </section>
    </div>`;

  enhancePredictiveInput(modal('lotCardRecipientPicker'), {
    listId: 'lotCardRecipientPickerOptions',
    options: recipientOptions.map(option => option.display),
    icon: '👤',
    clearLabel: tf('actions.clear', 'Очистить'),
  });
  enhancePredictiveInput(modal('lotCardProductPicker'), {
    listId: 'lotCardProductPickerOptions',
    options: productOptions.map(option => option.display),
    icon: '📦',
    clearLabel: tf('actions.clear', 'Очистить'),
  });

  bindLotCardEvents();
  refreshNeedIndicators();
}

function renderValidationSummaryContent(summary) {
  const parts = [
    `${tf('lotting.validationExactCount', 'Полностью распределены: {count}', { count: summary.exact })}`,
    `${tf('lotting.validationUnderCount', 'Остаток не распределён: {count}', { count: summary.under })}`,
  ];
  if (summary.over) parts.push(`${tf('lotting.validationOverCount', 'Есть превышения: {count}', { count: summary.over })}`);
  if (summary.noneed) parts.push(`${tf('lotting.validationNoNeedCount', 'Без потребности: {count}', { count: summary.noneed })}`);
  return parts.join(' · ');
}

function applyQtyInputState(input, status) {
  if (!input) return;
  input.classList.remove(
    'border-white/10',
    'border-emerald-400/50',
    'border-amber-400/50',
    'border-red-400/60',
    'bg-white/5',
    'bg-emerald-400/10',
    'bg-amber-400/10',
    'bg-red-400/10',
  );

  if (status === 'exact') {
    input.classList.add('border-emerald-400/50', 'bg-emerald-400/10');
  } else if (status === 'over' || status === 'noneed') {
    input.classList.add('border-red-400/60', 'bg-red-400/10');
  } else {
    input.classList.add('border-amber-400/50', 'bg-amber-400/10');
  }
}

function refreshNeedIndicators() {
  const lot = getEditableLot();
  const summary = getDraftValidationSummary();
  const summaryEl = modal('lotCardValidationSummary');
  if (summaryEl) {
    summaryEl.textContent = renderValidationSummaryContent(summary);
    summaryEl.className = 'mt-3 rounded-2xl border px-4 py-3 text-sm';
    if (summary.over || summary.noneed) {
      summaryEl.classList.add('border-red-400/25', 'bg-red-400/10', 'text-red-100');
    } else if (summary.under) {
      summaryEl.classList.add('border-amber-400/25', 'bg-amber-400/10', 'text-amber-100');
    } else {
      summaryEl.classList.add('border-emerald-400/25', 'bg-emerald-400/10', 'text-emerald-100');
    }
  }

  (lot.items || []).forEach((item) => {
    const result = getItemValidation(item, currentEditingLotId);
    const pid = Number(item.productId) || result.product?.id || 0;
    if (!pid) return;

    const summaryNode = document.querySelector(`[data-need-summary="${pid}"]`);
    const badgeNode = document.querySelector(`[data-need-badge="${pid}"]`);
    const inputNode = document.querySelector(`[data-qty-input="${pid}"]`);

    let summaryText = '';
    let badgeText = '';
    let badgeClass = 'inline-flex rounded-full border px-2.5 py-1 text-[11px] font-semibold ';

    if (result.status === 'noneed') {
      summaryText = tf('lotting.needSummaryNoNeed', 'Потребность не задана. В других лотах: {other} шт.', { other: result.otherLotsQty });
      badgeText = tf('lotting.statusNoNeed', 'Нет потребности');
      badgeClass += 'border-red-400/25 bg-red-400/10 text-red-200';
    } else if (result.status === 'over') {
      summaryText = tf('lotting.needSummaryOver', 'Незалотированная потребность: {need} · в других лотах: {other} · в этом лоте: {current} · превышение: {over}', {
        need: result.needQty,
        other: result.otherLotsQty,
        current: result.qty,
        over: Math.abs(result.diff),
      });
      badgeText = tf('lotting.statusOver', 'Превышение');
      badgeClass += 'border-red-400/25 bg-red-400/10 text-red-200';
    } else if (result.status === 'exact') {
      summaryText = tf('lotting.needSummaryExact', 'Незалотированная потребность: {need} · в других лотах: {other} · в этом лоте: {current} · распределено полностью', {
        need: result.needQty,
        other: result.otherLotsQty,
        current: result.qty,
      });
      badgeText = tf('lotting.statusExact', 'Полностью');
      badgeClass += 'border-emerald-400/25 bg-emerald-400/10 text-emerald-200';
    } else {
      summaryText = tf('lotting.needSummaryUnder', 'Незалотированная потребность: {need} · в других лотах: {other} · в этом лоте: {current} · осталось: {left}', {
        need: result.needQty,
        other: result.otherLotsQty,
        current: result.qty,
        left: Math.max(0, result.diff),
      });
      badgeText = tf('lotting.statusUnder', 'Остаток');
      badgeClass += 'border-amber-400/25 bg-amber-400/10 text-amber-200';
    }

    if (summaryNode) summaryNode.textContent = summaryText;
    if (badgeNode) {
      badgeNode.textContent = badgeText;
      badgeNode.className = badgeClass;
    }
    applyQtyInputState(inputNode, result.status);
  });
}

function syncDraftLotNumber() {
  if (!draftLot) return;
  draftLot.lotNumber = modal('lotCardNumber')?.value.trim() || '';
}

function addRecipientToDraft() {
  const input = modal('lotCardRecipientPicker');
  if (!input) return;
  const option = resolveRecipientOption(input.value);
  if (!option) {
    showToast(tf('lotting.recipientNotFound', 'Выберите получателя из списка'), 'error');
    input.focus();
    return;
  }
  if (!draftLot.recipientIds.includes(option.id)) {
    draftLot.recipientIds.push(option.id);
  } else {
    showToast(tf('lotting.recipientDuplicate', 'Получатель уже добавлен'), 'info');
  }
  input.value = '';
  renderLotCard();
}

function removeRecipientFromDraft(recipientId) {
  draftLot.recipientIds = (draftLot.recipientIds || []).filter(id => String(id) !== String(recipientId));
  renderLotCard();
}

function addProductToDraft() {
  const input = modal('lotCardProductPicker');
  if (!input) return;
  const option = resolveProductOption(input.value);
  if (!option) {
    showToast(tf('lotting.productNotFound', 'Выберите товар из списка'), 'error');
    input.focus();
    return;
  }
  const exists = (draftLot.items || []).some(item => String(item.productId) === String(option.id));
  if (exists) {
    showToast(tf('lotting.productDuplicate', 'Товар уже добавлен в лот'), 'info');
    input.value = '';
    return;
  }
  draftLot.items.push({
    productId: option.id,
    productName: option.name,
    productCode: option.code,
    qty: 0,
    nmcd: 0,
  });
  input.value = '';
  renderLotCard();
}

function removeProductFromDraft(productId) {
  draftLot.items = (draftLot.items || []).filter(item => String(item.productId) !== String(productId));
  renderLotCard();
}

function updateDraftItemQty(productId, value) {
  const item = (draftLot.items || []).find(entry => String(entry.productId) === String(productId));
  if (!item) return;
  item.qty = Math.max(0, Number(value) || 0);
  refreshNeedIndicators();
}

function updateDraftItemNmcd(productId, value) {
  const item = (draftLot.items || []).find(entry => String(entry.productId) === String(productId));
  if (!item) return;
  item.nmcd = value === '' ? 0 : Math.max(0, Number(value) || 0);
}

function bindLotCardEvents() {
  modal('lotCardNumber')?.addEventListener('input', syncDraftLotNumber);

  const recipientInput = modal('lotCardRecipientPicker');
  recipientInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addRecipientToDraft();
  });
  modal('lotCardRecipientAddBtn')?.addEventListener('click', addRecipientToDraft);
  document.querySelectorAll('[data-remove-recipient]').forEach((button) => {
    button.addEventListener('click', () => removeRecipientFromDraft(button.dataset.removeRecipient));
  });

  const productInput = modal('lotCardProductPicker');
  productInput?.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addProductToDraft();
  });
  modal('lotCardProductAddBtn')?.addEventListener('click', addProductToDraft);
  document.querySelectorAll('[data-remove-product]').forEach((button) => {
    button.addEventListener('click', () => removeProductFromDraft(button.dataset.removeProduct));
  });
  document.querySelectorAll('[data-qty-input]').forEach((input) => {
    input.addEventListener('input', () => updateDraftItemQty(input.dataset.qtyInput, input.value));
    input.addEventListener('change', () => updateDraftItemQty(input.dataset.qtyInput, input.value));
  });
  document.querySelectorAll('[data-nmcd-input]').forEach((input) => {
    input.addEventListener('input', () => updateDraftItemNmcd(input.dataset.nmcdInput, input.value));
    input.addEventListener('change', () => updateDraftItemNmcd(input.dataset.nmcdInput, input.value));
  });
}

function collectLotFormData() {
  syncDraftLotNumber();
  return {
    lotNumber: draftLot.lotNumber || '',
    contractId: draftLot.contractId ?? null,
    contractNumber: draftLot.contractNumber || '',
    recipientIds: [...new Set((draftLot.recipientIds || []).map(id => Number(id)).filter(Boolean))],
    items: (draftLot.items || [])
      .map((item) => {
        const resolvedProduct = resolveItemProduct(item);
        return {
          productId: Number(item.productId) || resolvedProduct?.id || null,
          productName: item.productName || resolvedProduct?.name || '',
          productCode: item.productCode || resolvedProduct?.code || '',
          qty: Math.max(0, Number(item.qty) || 0),
          nmcd: item?.nmcd != null && item?.nmcd !== '' ? Math.max(0, Number(item.nmcd) || 0) : 0,
        };
      })
      .filter(item => item.productId && item.qty > 0),
  };
}

async function saveLotCard() {
  const data = collectLotFormData();
  if (!data.lotNumber) {
    showToast(tf('lotting.numberRequired', 'Укажите номер лота'), 'error');
    modal('lotCardNumber')?.focus();
    return;
  }
  if (!data.items.length) {
    showToast(tf('lotting.itemsRequired', 'Добавьте хотя бы один товар в лот'), 'error');
    return;
  }

  const duplicate = findLotByNumber(data.lotNumber);
  if (duplicate && String(duplicate.id) !== String(currentEditingLotId ?? '')) {
    showToast(tf('lotting.numberDuplicate', 'Лот с таким номером уже существует'), 'error');
    modal('lotCardNumber')?.focus();
    return;
  }

  const validations = data.items.map(item => getItemValidation(item, currentEditingLotId));
  const hasOver = validations.some(item => item.status === 'over');
  const hasNoNeed = validations.some(item => item.status === 'noneed');
  const hasUnder = validations.some(item => item.status === 'under');

  if (hasOver || hasNoNeed) {
    showToast(tf('lotting.saveBlockedOver', 'Исправьте превышение или товары без потребности перед сохранением'), 'error');
    return;
  }

  if (currentEditingLotId != null) updateLot(currentEditingLotId, data);
  else {
    const created = addLot(data);
    currentEditingLotId = created.id;
  }

  await saveToStorage();
  window.dispatchEvent(new CustomEvent('lotting-changed'));
  showToast(hasUnder
    ? tf('lotting.savedWithRemainder', 'Лот сохранён. По части товаров ещё остался нераспределённый объём.')
    : tf('lotting.saved', 'Лот сохранён'), hasUnder ? 'info' : 'success');
  backToLottingList();
}

async function handleDeleteLot(id) {
  const lot = getLotById(id);
  if (!lot) return;
  if (!confirmDeleteWithImpact({
    title: tf('lotting.confirmDeleteTitle', 'Удалить лот?'),
    subject: lot.lotNumber || tf('lotting.newCard', 'Лот'),
    impacts: [tf('lotting.confirmDeleteImpact', 'лот и его распределение товаров будут удалены')],
    risks: [tf('lotting.confirmDeleteRisk', 'контракты не удаляются автоматически; у них останется номер лота в карточке')],
  })) return;

  deleteLot(id);
  await saveToStorage();
  window.dispatchEvent(new CustomEvent('lotting-changed'));
  showToast(tf('lotting.deleted', 'Лот удалён'), 'success');
  backToLottingList();
}

function backToLottingList() {
  currentEditingLotId = null;
  draftLot = null;
  modal('lottingEditPanel')?.classList.add('hidden');
  modal('lottingListPanel')?.classList.remove('hidden');
  renderLottingList();
}

function openLotCard(lotId = null) {
  syncLotRegistryFromContracts(false);
  currentEditingLotId = lotId;
  draftLot = cloneLot(lotId != null ? getLotById(lotId) : null);
  renderLotCard();
  modal('lottingListPanel')?.classList.add('hidden');
  modal('lottingEditPanel')?.classList.remove('hidden');
}

export function openLottingModal() {
  syncLotRegistryFromContracts(false);
  ensureLottingModal();
  modal('lottingListPanel')?.classList.remove('hidden');
  modal('lottingEditPanel')?.classList.add('hidden');
  renderLottingList();
  modal('lottingModal')?.classList.add('open');
}

export function closeLottingModal() {
  modal('lottingModal')?.classList.remove('open');
  backToLottingList();
}

async function exportLotsExcel() {
  const lots = getLots();
  if (!lots.length) {
    showToast(tf('lotting.exportEmpty', 'Нет данных для экспорта'), 'info');
    return;
  }

  const XLSX = await loadXLSX();
  const summaryRows = lots.map((lot) => {
    const summary = summarizeLot(lot);
    return {
      'Номер лота': lot.lotNumber || '',
      'Номер контракта': lot.contractNumber || '',
      'Получатели': getRecipientNamesFromIds(lot.recipientIds).join('; '),
      'Товаров': summary.itemCount,
      'Количество': summary.totalQty,
      'Цена лота, ₽': summary.totalPrice,
    };
  });
  const itemRows = lots.flatMap((lot) => (lot.items || []).map((item) => ({
    'Номер лота': lot.lotNumber || '',
    'Номер контракта': lot.contractNumber || '',
    'Получатели': getRecipientNamesFromIds(lot.recipientIds).join('; '),
    'Код товара': item.productCode || '',
    'Наименование товара': item.productName || '',
    'НМЦД, ₽': Number(item.nmcd) || 0,
    'Количество': Number(item.qty) || 0,
    'Сумма строки, ₽': (Number(item.nmcd) || 0) * (Number(item.qty) || 0),
  })));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summaryRows), 'Лоты');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(itemRows), 'Позиции');
  XLSX.writeFile(wb, `lotting-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(tf('lotting.exported', 'Лоты выгружены в Excel'), 'success');
}

function detectHeader(row, variants) {
  const normalized = Object.keys(row || {}).reduce((acc, key) => {
    acc[String(key).trim().toLowerCase()] = row[key];
    return acc;
  }, {});
  for (const variant of variants) {
    const key = variant.toLowerCase();
    if (normalized[key] !== undefined) return normalized[key];
  }
  return '';
}

async function importLotsExcel(file) {
  const XLSX = await loadXLSX();
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames.find((name) => String(name).trim().toLowerCase() === 'позиции') || workbook.SheetNames[0];
  const firstSheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(firstSheet, { defval: '' });
  if (!rows.length) throw new Error(tf('lotting.importEmpty', 'Файл не содержит данных'));

  const grouped = new Map();
  rows.forEach((row) => {
    const lotNumber = String(detectHeader(row, ['Номер лота', 'Лот', 'lotNumber'])).trim();
    const productName = String(detectHeader(row, ['Наименование товара', 'Товар', 'productName'])).trim();
    const productCode = String(detectHeader(row, ['Код товара', 'Код', 'productCode'])).trim();
    const nmcd = Number(detectHeader(row, ['НМЦД, ₽', 'НМЦД', 'nmcd'])) || 0;
    const qty = Number(detectHeader(row, ['Количество', 'Кол-во', 'qty'])) || 0;
    const contractNumber = String(detectHeader(row, ['Номер контракта', 'Контракт', 'contractNumber'])).trim();
    const recipientsRaw = String(detectHeader(row, ['Получатели', 'Получатель', 'recipientNames'])).trim();
    if (!lotNumber || qty <= 0 || (!productName && !productCode)) return;

    if (!grouped.has(lotNumber)) {
      grouped.set(lotNumber, {
        lotNumber,
        contractNumber,
        recipientIds: [],
        items: [],
      });
    }

    const lot = grouped.get(lotNumber);
    if (recipientsRaw) {
      recipientsRaw.split(/[;,]/).map((name) => name.trim()).filter(Boolean).forEach((name) => {
        const recipient = (state.recipients || []).find((item) => String(item.name || '').trim().toLowerCase() === name.toLowerCase());
        if (recipient && !lot.recipientIds.includes(recipient.id)) lot.recipientIds.push(recipient.id);
      });
    }

    const matchedProduct = productCode
      ? (state.products || []).find((product) => String(product.code || '').trim().toLowerCase() === productCode.toLowerCase())
      : (state.products || []).find((product) => String(product.name || '').trim().toLowerCase() === productName.toLowerCase());
    const existingItem = lot.items.find((item) =>
      (matchedProduct?.id && item.productId === matchedProduct.id)
      || (!matchedProduct?.id && productCode && item.productCode === productCode)
      || (!matchedProduct?.id && !productCode && item.productName === productName)
    );

    if (existingItem) {
      existingItem.qty += qty;
      if (nmcd > 0) existingItem.nmcd = nmcd;
    } else {
      lot.items.push({
        productId: matchedProduct?.id || null,
        productName: productName || matchedProduct?.name || '',
        productCode: productCode || matchedProduct?.code || '',
        qty,
        nmcd,
      });
    }
  });

  if (!grouped.size) throw new Error(tf('lotting.importEmpty', 'Файл не содержит данных'));

  grouped.forEach((payload, lotNumber) => {
    const existing = findLotByNumber(lotNumber);
    if (existing) updateLot(existing.id, payload);
    else addLot(payload);
  });

  await saveToStorage();
  window.dispatchEvent(new CustomEvent('lotting-changed'));
  renderLottingList();
  showToast(tf('lotting.imported', 'Лоты импортированы из Excel'), 'success');
}

function bindLottingEvents() {
  modal('lottingCloseBtn')?.addEventListener('click', closeLottingModal);
  modal('lottingCardBackBtn')?.addEventListener('click', backToLottingList);
  modal('lottingAddBtn')?.addEventListener('click', () => openLotCard(null));
  modal('lottingSyncContractsBtn')?.addEventListener('click', async () => {
    syncLotRegistryFromContracts(true, true);
    await saveToStorage();
    renderLottingList();
  });
  modal('lottingSaveBtn')?.addEventListener('click', saveLotCard);
  modal('lottingDeleteBtn')?.addEventListener('click', () => {
    if (currentEditingLotId != null) handleDeleteLot(currentEditingLotId);
  });
  modal('lottingExportBtn')?.addEventListener('click', exportLotsExcel);
  modal('lottingImportBtn')?.addEventListener('click', () => modal('lottingImportInput')?.click());
  modal('lottingImportInput')?.addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    try {
      await importLotsExcel(file);
    } catch (error) {
      showToast(error?.message || tf('lotting.importError', 'Не удалось импортировать Excel'), 'error');
    }
  });

  modal('lottingFilterLot')?.addEventListener('input', (event) => {
    registryFilters.lot = event.target.value || '';
    renderLottingList();
  });
  modal('lottingFilterProduct')?.addEventListener('input', (event) => {
    registryFilters.product = event.target.value || '';
    renderLottingList();
  });
  modal('lottingFilterRecipient')?.addEventListener('input', (event) => {
    registryFilters.recipient = event.target.value || '';
    renderLottingList();
  });

  const overlayEl = modal('lottingModal');
  overlayEl?.addEventListener('click', (event) => {
    if (event.target === overlayEl) closeLottingModal();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (!overlayEl?.classList.contains('open')) return;
    if (!modal('lottingEditPanel')?.classList.contains('hidden')) backToLottingList();
    else closeLottingModal();
  });
}

function ensureMenuButton() {
  return document.getElementById('lottingMenuBtn');
}

export function initLottingView() {
  if (initialized) return;
  initialized = true;
  syncLotRegistryFromContracts(false);
  ensureLottingModal();
  bindLottingEvents();

  const menuBtn = ensureMenuButton();
  if (menuBtn) menuBtn.addEventListener('click', openLottingModal);

  window.addEventListener('lotting-changed', () => {
    syncLotsWithContracts();
    if (modal('lottingModal')?.classList.contains('open')) renderLottingList();
  });
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => initLottingView());
} else {
  initLottingView();
}
