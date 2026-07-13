/**
 * Acts Registry View — реестр сохранённых актов проверки.
 * Two registries: SO checks and delivery checks.
 * Поиск по номеру контракта или поставщику.
 * Кнопка редактирования — открывает act-form-view с загруженными данными.
 */

import { state, deleteAct } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { deleteActMedia, getActMediaPreviewUrl, getActMediaDownloadUrl } from './act-media-service.js';
import { enhancePredictiveInput } from './filters.js';
import { confirmDeleteWithImpact } from './dom.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

function getResultPrescriptionText(act) {
  const result = String(act?.result || '').trim();
  const prescription = String(act?.prescription || '').trim();
  if (result && prescription) return `${result}\n\nПредписания: ${prescription}`;
  return result || prescription || '';
}

function normalizeComparableText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseComparableNumber(value) {
  const normalized = String(value || '')
    .replace(/\u00A0/g, '')
    .replace(/\s+/g, '')
    .replace(/,/g, '.');
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function getSpecConforms(spec) {
  if (!spec) return false;
  if (typeof spec.nonConform === 'boolean') return spec.nonConform === true;
  const actual = normalizeComparableText(spec.checkResult);
  if (actual) {
    const expectedNum = parseComparableNumber(spec.value);
    const actualNum = parseComparableNumber(spec.checkResult);
    if (expectedNum != null && actualNum != null) {
      return Math.abs(expectedNum - actualNum) <= 0.001;
    }
    return normalizeComparableText(spec.value) === actual;
  }
  return false;
}

function hydrateActSelectedItem(si, contract) {
  if (!si || !contract) return si;

  const itemIdx = Number(si.itemIdx);
  const contractItem = Number.isFinite(itemIdx) ? (contract.items || [])[itemIdx] : null;
  if (!contractItem) return si;

  const product = contractItem.productRef != null
    ? (state.products || []).find(p => p.id === contractItem.productRef)
    : null;
  const productSpecs = Array.isArray(product?.specs) ? product.specs : [];
  const savedSpecs = Array.isArray(si.specs) ? si.specs : [];
  const specCount = Math.max(productSpecs.length, savedSpecs.length);
  const mergedSpecs = Array.from({ length: specCount }, (_, index) => {
    const savedSpec = savedSpecs[index] || {};
    const productSpec = productSpecs[index] || {};
    return {
      param: savedSpec.param || productSpec.param || '',
      unit: savedSpec.unit || productSpec.unit || '',
      value: savedSpec.value || productSpec.value || '',
      checkResult: savedSpec.checkResult || '',
      nonConform: typeof savedSpec.nonConform === 'boolean' ? savedSpec.nonConform : false,
    };
  });

  return {
    ...si,
    name: si.name || product?.name || contractItem.name || '',
    itemCode: si.itemCode || contractItem.code || '',
    contractQty: si.contractQty ?? contractItem.qty ?? '',
    specs: mergedSpecs,
  };
}

function getHydratedActSelectedItems(act, contract) {
  return (act.selectedItems || [])
    .filter(si => si.selected !== false)
    .map(si => hydrateActSelectedItem(si, contract));
}

function getHydratedActForDisplay(act) {
  if (!act) return null;
  const contract = act.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
  return {
    act,
    contract,
    supplier: contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null,
    selectedItems: getHydratedActSelectedItems(act, contract),
  };
}

function getRecipientRepresentativesList(act) {
  const list = Array.isArray(act?.recipientRepresentatives)
    ? act.recipientRepresentatives
    : [];
  if (list.length) {
    return list.map(item => ({
      role: String(item?.role || ''),
      organization: String(item?.organization || ''),
      name: String(item?.name || ''),
    }));
  }
  const legacy = act?.recipientRepresentative;
  if (legacy && (legacy.role || legacy.name)) {
    return [{ role: String(legacy.role || ''), organization: '', name: String(legacy.name || '') }];
  }
  return [];
}

function getActMediaItems(act) {
  return {
    attachments: Array.isArray(act?.attachments) ? act.attachments : [],
    photos: Array.isArray(act?.photos) ? act.photos : [],
    videos: Array.isArray(act?.videos) ? act.videos : [],
  };
}

async function deleteActMediaBundle(act) {
  const { attachments, photos, videos } = getActMediaItems(act);
  const all = [...attachments, ...photos, ...videos].filter(item => item?.id);
  await Promise.all(all.map(async (item) => {
    try {
      await deleteActMedia(item.id);
    } catch (err) {
      console.warn('delete act media bundle error:', err);
    }
  }));
}

// ─── Search state ─────────────────────────────────────────────────

let _soSearch       = '';
let _deliverySearch = '';
let _registryProductHistoryQuery = '';
let _registryProductHistoryContractQuery = '';
let _registryProductHistoryCollapsed = false;

// ─── Refresh hook (called after edit/delete) ──────────────────────

let _registryOpen = false;

export function refreshRegistryIfOpen() {
  if (_registryOpen) renderRegistry();
}

// ─── Inline (Receiving tab) state ─────────────────────────────────

let _inlineListWrap = null;

export function openActsRegistryInReceiving(container) {
  _inlineListWrap = container;
  _renderInlineRegistry(container);
}

function _renderInlineRegistry(container) {
  container.innerHTML = '';

  const historyWrap = document.createElement('div');
  container.appendChild(historyWrap);

  // Tabs
  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 mb-4 rounded-xl bg-white/[0.04] p-1';

  let activeTab = 'so';

  const soTabBtn  = _makeTabBtn('Акты проверки сигнальных образцов', true);
  const delTabBtn = _makeTabBtn('Акты проверки поставленного товара', false);
  tabBar.append(soTabBtn, delTabBtn);
  container.appendChild(tabBar);

  const listWrap = document.createElement('div');
  container.appendChild(listWrap);

  const rerenderInlineTab = () => {
    _renderActsListWithSearch(listWrap, activeTab, act => _openInlineDetail(act), () => _renderInlineRegistry(container));
  };

  renderRegistryProductHistory(historyWrap, (actId) => {
    const act = (state.acts || []).find(item => Number(item.id) === Number(actId));
    if (act) _openInlineDetail(act);
  }, rerenderInlineTab);

  function showTab(tab) {
    activeTab = tab;
    soTabBtn.classList.toggle('bg-white/10', tab === 'so');
    soTabBtn.classList.toggle('text-white',  tab === 'so');
    soTabBtn.classList.toggle('text-slate-400', tab !== 'so');
    delTabBtn.classList.toggle('bg-white/10', tab === 'delivery');
    delTabBtn.classList.toggle('text-white',  tab === 'delivery');
    delTabBtn.classList.toggle('text-slate-400', tab !== 'delivery');
    rerenderInlineTab();
  }

  soTabBtn.addEventListener('click',  () => showTab('so'));
  delTabBtn.addEventListener('click', () => showTab('delivery'));
  showTab('so');
}

function _makeTabBtn(label, active, count) {
  const btn = document.createElement('button');
  let html = esc(label);
  if (count != null && count > 0) {
    html += ` <span class="ml-1 rounded-full bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold">${count}</span>`;
  }
  btn.innerHTML = html;
  btn.className = `flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition
    ${active ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-slate-200'}`;
  return btn;
}

function _openInlineDetail(act) {
  const listPanel  = document.getElementById('receivingListPanel');
  const cardPanel  = document.getElementById('receivingCardPanel');
  const titleEl    = document.getElementById('receivingCardTitle');
  const bodyWrap   = document.getElementById('receivingCardWrap');
  const actSection = cardPanel?.querySelector('.rounded-2xl.border-dashed');

  if (!listPanel || !cardPanel) return;

  listPanel.classList.add('hidden');
  cardPanel.classList.remove('hidden');

  const contract = act.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
  if (titleEl) titleEl.textContent = contract?.number ? `Акт по контракту № ${contract.number}` : t('actsRegistry.noContract');

  if (bodyWrap) {
    bodyWrap.innerHTML = '';
    _renderActDetailHtml(act.id, bodyWrap);
  }

  if (actSection) actSection.style.display = 'none';

  const backBtn = document.getElementById('receivingCardBackBtn');
  if (backBtn) {
    const fresh = backBtn.cloneNode(true);
    backBtn.replaceWith(fresh);
    fresh.addEventListener('click', () => {
      cardPanel.classList.add('hidden');
      listPanel.classList.remove('hidden');
      if (actSection) actSection.style.display = '';
      const restored = fresh.cloneNode(true);
      fresh.replaceWith(restored);
      restored.addEventListener('click', () => {
        cardPanel.classList.add('hidden');
        listPanel.classList.remove('hidden');
      });
    });
  }
}

// ─── Open / Close (modal mode) ────────────────────────────────────

export function openActsRegistry() {
  const overlay = document.getElementById('actsRegistryModal');
  if (!overlay) return;
  _registryOpen = true;
  overlay.classList.add('open');
  renderRegistry();
  updateActsBadge();
}

export function openActsRegistryWithAct(actId) {
  const act = (state.acts || []).find(item => Number(item.id) === Number(actId));
  if (act) {
    _activeRegistryTab = isDeliveryAct(act) ? 'delivery' : 'so';
  }
  openActsRegistry();
  if (act) openActDetail(act.id);
}

export function closeActsRegistry() {
  _registryOpen = false;
  const overlay = document.getElementById('actsRegistryModal');
  if (overlay) overlay.classList.remove('open');
  closeActDetail();
}

export function initActsRegistryView() {
  const overlay = document.getElementById('actsRegistryModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeActsRegistry();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      const detail = document.getElementById('actDetailPanel');
      if (detail && !detail.classList.contains('hidden')) {
        closeActDetail();
      } else {
        closeActsRegistry();
      }
    }
  });

  document.getElementById('actsRegistryCloseBtn')?.addEventListener('click', closeActsRegistry);
  document.getElementById('actDetailBackBtn')?.addEventListener('click', closeActDetail);
}

// ─── Badge ────────────────────────────────────────────────────────

export function updateActsBadge() {
  const acts = state.acts || [];
  const soCount  = acts.filter(a => (a.mode || 'so') === 'so').length;
  const delCount = acts.filter(a => (a.mode || 'so') === 'delivery').length;
  const total = acts.length;

  _setBadge('actsBadge', total);
  _setBadge('actsBadgeSO', soCount);
  _setBadge('actsBadgeDelivery', delCount);
}

function _setBadge(id, count) {
  const el = document.getElementById(id);
  if (!el) return;
  if (count > 0) {
    el.textContent = count;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

// ─── Utility ──────────────────────────────────────────────────────

export function getActsForContract(contractId) {
  return (state.acts || [])
    .filter(a => a.contractId === contractId)
    .sort((a, b) => (b.id || 0) - (a.id || 0));
}

// ─── Search + List renderer ───────────────────────────────────────

/**
 * Renders a search box + act cards filtered by mode ('so' | 'delivery').
 */
function _renderActsListWithSearch(wrap, mode, onOpen, onDelete) {
  wrap.innerHTML = '';

  // Search box
  const searchId = `actSearch_${mode}`;
  const searchVal = mode === 'so' ? _soSearch : _deliverySearch;
  const searchListId = `actSearchOptions_${mode}`;
  const searchOptions = [...new Set(
    (state.acts || [])
      .filter(a => (a.mode || 'so') === mode)
      .flatMap(a => {
        const contract = a.contractId ? state.contracts.find(c => c.id === a.contractId) : null;
        const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;
        return [contract?.number, contract?.title, supplier?.name, a.location]
          .map(v => String(v || '').trim())
          .filter(Boolean);
      })
  )].sort((a, b) => a.localeCompare(b, 'ru'));

  const searchWrap = document.createElement('div');
  searchWrap.className = 'relative mb-4';
  searchWrap.innerHTML = `
    <span class="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 pointer-events-none text-sm">🔍</span>
    <input id="${searchId}" type="search" list="${searchListId}"
      class="w-full rounded-xl border border-white/10 bg-white/5 pl-9 pr-4 py-2.5 text-sm text-white
        placeholder-slate-500 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
      placeholder="Поиск по номеру контракта или поставщику…"
      value="${esc(searchVal)}">
    <datalist id="${searchListId}">${searchOptions.map(option => `<option value="${esc(option)}"></option>`).join('')}</datalist>`;
  wrap.appendChild(searchWrap);

  const listEl = document.createElement('div');
  wrap.appendChild(listEl);

  function renderList(q) {
    if (mode === 'so') _soSearch = q;
    else _deliverySearch = q;
    _renderActsFiltered(listEl, mode, q, onOpen, onDelete);
  }

  const inp = document.getElementById(searchId);
  if (inp) {
    inp.addEventListener('input', () => renderList(inp.value));
    inp.addEventListener('change', () => renderList(inp.value));
    enhancePredictiveInput(inp, {
      listId: searchListId,
      options: searchOptions,
      icon: '🔍',
      minWidth: '260px',
    });
    searchWrap.querySelector('span')?.remove();
  }

  renderList(searchVal);
}

/**
 * Renders filtered act cards into `listEl`.
 */
function _renderActsFiltered(listEl, mode, query, onOpen, onDelete) {
  listEl.innerHTML = '';
  const q = String(query || '').trim();

  // Filter by mode
  let acts = (state.acts || []).filter(a => (a.mode || 'so') === mode);

  // Filter by top product/contract history block
  acts = acts.filter(act => actMatchesHistoryFilters(act, {
    productQuery: _registryProductHistoryQuery,
    contractQuery: _registryProductHistoryContractQuery,
  }));

  // Filter by search query
  if (q) {
    acts = acts.filter(a => {
      return haystackMatchesQuery(getActContractHaystack(a), q);
    });
  }

  if (acts.length === 0) {
    const label = q ? 'Ничего не найдено' : (mode === 'so' ? 'Актов проверки сигнальных образцов пока нет' : 'Актов проверки поставленного товара пока нет');
    const hint  = q ? 'Попробуйте изменить запрос' : t('actsRegistry.emptyHint');
    listEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-12 text-center">
        <span class="text-4xl mb-3" aria-hidden="true">📋</span>
        <p class="text-sm font-semibold text-slate-300">${label}</p>
        <p class="text-xs text-slate-500 mt-1">${hint}</p>
      </div>`;
    return;
  }

  const sorted = [...acts].sort((a, b) => (b.id || 0) - (a.id || 0));

  sorted.forEach(act => {
    const contract = act.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
    const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;

    const contractLabel = contract
      ? [contract.number ? `№ ${contract.number}` : '', contract.title].filter(Boolean).join(' — ')
      : t('actsRegistry.noContract');
    const supplierName = supplier?.name || '';
    const actDate  = act.date    ? fmtDate(act.date)         : '—';
    const savedAt  = act.savedAt ? fmtDateTime(act.savedAt)  : '';
    const updatedAt = act.updatedAt ? fmtDateTime(act.updatedAt) : '';
    const itemCount = (act.selectedItems || []).filter(si => si.selected !== false).length;
    const selectedItems = getHydratedActSelectedItems(act, contract);
    const { attachments, photos, videos } = getActMediaItems(act);

    const isDeliveryAct = (act.mode || 'so') === 'delivery';
    const aggregateStatus = getActAggregateStatus(selectedItems, isDeliveryAct);
    const aggregateBadge = getRegistryResultBadge(aggregateStatus, isDeliveryAct, { compact: true });
    const hasShippingForbidden = isDeliveryAct && selectedItems.some(si => si.shippingAllowed === false);
    const allShippingAllowed   = isDeliveryAct && selectedItems.length > 0 &&
      selectedItems.every(si => si.shippingAllowed === true);
    const hasNotDelivered = isDeliveryAct && selectedItems.some(si => si.notDelivered);

    const card = document.createElement('div');
    card.className = 'rounded-xl border border-white/10 bg-white/5 mb-3 transition hover:border-cyan-400/20 overflow-hidden';

    // ── Header row (always visible, click to toggle) ──
    const headerRow = document.createElement('div');
    headerRow.className = 'flex items-center gap-2 px-4 py-3 cursor-pointer select-none group';
    headerRow.setAttribute('role', 'button');
    headerRow.setAttribute('aria-expanded', 'false');

    // Toggle arrow
    const arrow = document.createElement('span');
    arrow.className = 'text-slate-500 text-xs transition-transform shrink-0 select-none';
    arrow.textContent = '▶';
    arrow.style.transition = 'transform 0.2s';
    headerRow.appendChild(arrow);

    // Badges + title
    const titleWrap = document.createElement('div');
    titleWrap.className = 'flex-1 min-w-0 flex items-center gap-2 flex-wrap';
    titleWrap.innerHTML = `
      ${isDeliveryAct && selectedItems.length > 0
        ? allShippingAllowed
          ? `<span class="shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400">🚚 Разрешена</span>`
          : hasShippingForbidden
            ? `<span class="shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-400">⛔ Частично</span>`
            : ''
        : ''}
      ${hasNotDelivered ? `<span class="shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300">Не поставлен</span>` : ''}
      <span class="shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-semibold ${aggregateBadge.className}">${esc(aggregateBadge.text)}</span>
      <span class="shrink-0 rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider
        ${(act.mode || 'so') === 'so' ? 'bg-violet-500/10 text-violet-400' : 'bg-cyan-500/10 text-cyan-400'}">
        ${(act.mode || 'so') === 'so' ? 'Сигнальные образцы' : 'Поставка'}
      </span>
      <span class="text-sm font-semibold text-white truncate">${esc(contractLabel)}</span>
      ${supplierName ? `<span class="text-xs text-slate-400 truncate hidden sm:inline">${esc(supplierName)}</span>` : ''}
      <span class="text-xs text-slate-500">📅 ${esc(actDate)}</span>
      ${itemCount > 0 ? `<span class="text-xs text-slate-500">📦 ${itemCount} ${t('contracts.positions')}</span>` : ''}
      ${attachments.length ? `<span class="text-xs text-slate-500">📎 ${attachments.length}</span>` : ''}
      ${photos.length ? `<span class="text-xs text-slate-500">📷 ${photos.length}</span>` : ''}
      ${videos.length ? `<span class="text-xs text-slate-500">🎥 ${videos.length}</span>` : ''}`;
    headerRow.appendChild(titleWrap);

    // Action buttons (always visible in header)
    const actionsWrap = document.createElement('div');
    actionsWrap.className = 'flex items-center gap-1 shrink-0';
    actionsWrap.innerHTML = `
      <button class="act-edit-btn w-8 h-8 flex items-center justify-center rounded-lg
        text-slate-500 hover:text-cyan-400 hover:bg-cyan-400/10 transition"
        data-act-id="${act.id}" aria-label="Открыть акт" title="Открыть акт">📂</button>
      <button class="act-open-edit-btn w-8 h-8 flex items-center justify-center rounded-lg
        text-slate-500 hover:text-cyan-400 hover:bg-cyan-400/10 transition"
        data-act-id="${act.id}" aria-label="Редактировать акт" title="Редактировать акт">✏️</button>
      <button class="act-download-btn w-8 h-8 flex items-center justify-center rounded-lg
        text-slate-500 hover:text-cyan-400 hover:bg-cyan-400/10 transition"
        data-act-id="${act.id}" aria-label="${t('actsRegistry.download')}" title="${t('actsRegistry.download')}">📄</button>
      <button class="act-delete-btn w-8 h-8 flex items-center justify-center rounded-lg
        text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition"
        data-act-id="${act.id}" aria-label="${t('actions.delete')}">✕</button>`;
    headerRow.appendChild(actionsWrap);
    card.appendChild(headerRow);

    // ── Collapsible body ──
    const body = document.createElement('div');
    body.className = 'hidden border-t border-white/10 px-4 py-3 text-xs text-slate-400 space-y-1';
    if (act.location) body.innerHTML += `<div>📍 ${esc(act.location)}</div>`;
    if (savedAt) body.innerHTML += `<div class="text-slate-600">Сохранён: ${esc(savedAt)}</div>`;
    if (updatedAt) body.innerHTML += `<div class="text-cyan-600/70">Изм.: ${esc(updatedAt)}</div>`;
    card.appendChild(body);

    // Toggle expand/collapse on header click
    headerRow.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const expanded = headerRow.getAttribute('aria-expanded') === 'true';
      headerRow.setAttribute('aria-expanded', String(!expanded));
      arrow.style.transform = expanded ? '' : 'rotate(90deg)';
      body.classList.toggle('hidden', expanded);
    });

    // «Открыть» — показывает детальную панель (только просмотр)
    card.querySelector('.act-edit-btn')?.addEventListener('click', e => {
      e.stopPropagation();
      onOpen(act);
    });

    // «Редактировать» — открывает форму редактирования
    card.querySelector('.act-open-edit-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      const { openActFormForEdit } = await import('./act-form-view.js');
      openActFormForEdit(act.id);
    });

    card.querySelector('.act-download-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      await generateAndDownload(act.id);
    });

    card.querySelector('.act-delete-btn')?.addEventListener('click', async e => {
      e.stopPropagation();
      if (!confirmDeleteWithImpact({
        title: 'Удалить акт проверки?',
        subject: `${contractLabel}${actDate ? ` · ${actDate}` : ''}`,
        impacts: [
          'акт будет удалён из реестра вместе с прикреплёнными файлами, фото и видео',
        ],
        recalculations: [
          (act.mode || 'so') === 'delivery'
            ? 'статусы отгрузки и связанные сводные показатели по этому товару будут пересчитаны'
            : 'статусы проверки сигнальных образцов по этому товару будут пересчитаны',
          'связанные карточки контракта, приёмки и сводные блоки обновятся',
        ],
        risks: [
          'связанные контракты, заявки и строки графика не удаляются автоматически',
        ],
      })) return;
      await deleteActMediaBundle(act);
      deleteAct(act.id);
      await saveToStorage();
      showToast(t('actsRegistry.deleted'), 'success');
      updateActsBadge();
      if (onDelete) onDelete();
    });

    listEl.appendChild(card);
  });
}

// ─── Modal registry list — two tabs ──────────────────────────────

let _activeRegistryTab = 'so';

function normalizeActItemText(value) {
  return String(value || '')
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function buildSearchTokens(value) {
  return normalizeActItemText(value)
    .split(' ')
    .map(token => token.trim())
    .filter(Boolean);
}

function haystackMatchesQuery(haystack, query) {
  const normalizedHaystack = normalizeActItemText(haystack);
  const tokens = buildSearchTokens(query);
  if (!tokens.length) return true;
  return tokens.every(token => normalizedHaystack.includes(token));
}

function getActContractHaystack(act) {
  const contract = act?.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
  const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;
  return [
    contract?.number,
    contract?.title,
    supplier?.name,
    act?.orderNumber,
    act?.location,
  ].filter(Boolean).join(' ');
}

function getActItemHaystack(item) {
  return [
    item?.itemCode,
    item?.name,
    item?.description,
    item?.specificationName,
    item?.productName,
  ].filter(Boolean).join(' ');
}

function isDeliveryAct(act) {
  return (act?.mode || 'so') === 'delivery';
}

function actMatchesHistoryFilters(act, { productQuery = '', contractQuery = '' } = {}) {
  if (contractQuery && !haystackMatchesQuery(getActContractHaystack(act), contractQuery)) {
    return false;
  }

  if (!String(productQuery || '').trim()) return true;

  return (act?.selectedItems || []).some(item => {
    if (item?.selected === false) return false;
    return haystackMatchesQuery(getActItemHaystack(item), productQuery);
  });
}

function getActItemConforms(si, deliveryMode = false) {
  if (!si) return false;
  if (deliveryMode && si.notDelivered) return false;
  const specsOk = !Array.isArray(si.specs) || si.specs.length === 0 || si.specs.every(getSpecConforms);
  const normDocOk = !si.normDocEnabled || si.normDocConforms !== false;
  if (deliveryMode) {
    return (Number(si.qty || 0) > 0) && specsOk && normDocOk;
  }
  if (si.siSoNotRequired) return true;
  return specsOk && normDocOk && si.soConforms === true;
}

function getActItemStatus(si, deliveryMode = false) {
  if (!si) {
    return { key: 'unknown', positive: false, negative: false, incomplete: true };
  }

  const specsOk = !Array.isArray(si.specs) || si.specs.length === 0 || si.specs.every(getSpecConforms);
  const normDocOk = !si.normDocEnabled || si.normDocConforms !== false;

  if (deliveryMode) {
    if (si.notDelivered) {
      return { key: 'not_delivered', positive: false, negative: true, incomplete: false };
    }

    const qtyOk = Number(si.qty || 0) > 0;
    if (qtyOk && specsOk && normDocOk) {
      return { key: 'positive', positive: true, negative: false, incomplete: false };
    }

    const hasAnyRecordedResult = qtyOk
      || !!String(si.qty ?? '').trim()
      || (Array.isArray(si.specs) && si.specs.some(spec => String(spec?.checkResult || '').trim()))
      || !!si.normDocEnabled;

    return {
      key: hasAnyRecordedResult ? 'negative' : 'incomplete',
      positive: false,
      negative: hasAnyRecordedResult,
      incomplete: !hasAnyRecordedResult,
    };
  }

  if (si.siSoNotRequired) {
    return { key: 'skipped', positive: false, negative: false, incomplete: false };
  }

  if (si.soConforms === true && specsOk && normDocOk) {
    return { key: 'positive', positive: true, negative: false, incomplete: false };
  }

  if (si.soConforms === false || !specsOk || !normDocOk) {
    return { key: 'negative', positive: false, negative: true, incomplete: false };
  }

  return { key: 'incomplete', positive: false, negative: false, incomplete: true };
}

function getActAggregateStatus(selectedItems, deliveryMode = false) {
  const items = Array.isArray(selectedItems) ? selectedItems : [];
  if (!items.length) {
    return { key: 'incomplete', positive: false, negative: false, incomplete: true };
  }

  const statuses = items.map(item => getActItemStatus(item, deliveryMode));

  if (deliveryMode) {
    if (statuses.some(status => status.key === 'not_delivered' || status.key === 'negative')) {
      return { key: 'negative', positive: false, negative: true, incomplete: false };
    }
    if (statuses.every(status => status.key === 'positive')) {
      return { key: 'positive', positive: true, negative: false, incomplete: false };
    }
    return { key: 'incomplete', positive: false, negative: false, incomplete: true };
  }

  const nonSkipped = statuses.filter(status => status.key !== 'skipped');
  if (!nonSkipped.length) {
    return { key: 'skipped', positive: false, negative: false, incomplete: false };
  }
  if (nonSkipped.some(status => status.key === 'negative')) {
    return { key: 'negative', positive: false, negative: true, incomplete: false };
  }
  if (nonSkipped.every(status => status.key === 'positive')) {
    return { key: 'positive', positive: true, negative: false, incomplete: false };
  }
  return { key: 'incomplete', positive: false, negative: false, incomplete: true };
}

function getRegistryResultBadge(status, deliveryMode = false, options = {}) {
  const compact = options.compact !== false;

  if (deliveryMode) {
    if (status.key === 'positive') {
      return {
        text: compact ? 'Проверка пройдена' : 'Проверка пройдена',
        className: 'bg-green-500/15 text-green-400',
      };
    }
    if (status.key === 'negative') {
      return {
        text: compact ? 'Есть замечания' : 'Есть замечания',
        className: 'bg-red-500/15 text-red-300',
      };
    }
    return {
      text: 'Результат не зафиксирован',
      className: 'bg-slate-500/15 text-slate-300',
    };
  }

  if (status.key === 'skipped') {
    return {
      text: compact ? 'СО не предусмотрен' : 'СО не предусмотрен',
      className: 'bg-emerald-500/15 text-emerald-400',
    };
  }
  if (status.key === 'positive') {
    return {
      text: compact ? 'Проверка пройдена' : 'Проверка пройдена',
      className: 'bg-green-500/15 text-green-400',
    };
  }
  if (status.key === 'negative') {
    return {
      text: compact ? 'Есть замечания' : 'Есть замечания',
      className: 'bg-red-500/15 text-red-300',
    };
  }
  return {
    text: 'Результат не зафиксирован',
    className: 'bg-slate-500/15 text-slate-300',
  };
}

function isSameActItem(baseAct, baseItem, candidateAct, candidateItem) {
  const baseCode = normalizeActItemText(baseItem?.itemCode);
  const candidateCode = normalizeActItemText(candidateItem?.itemCode);
  if (baseCode && candidateCode) return baseCode === candidateCode;

  const baseName = normalizeActItemText(baseItem?.name);
  const candidateName = normalizeActItemText(candidateItem?.name);
  return !!baseName && baseName === candidateName;
}

function getActItemHistoryEntries(baseAct, baseItem) {
  const entries = [];
  for (const act of (state.acts || [])) {
    const contract = act?.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
    const contractLabel = contract
      ? [contract.number ? `№ ${contract.number}` : '', contract.title].filter(Boolean).join(' — ')
      : t('actsRegistry.noContract');
    const deliveryMode = isDeliveryAct(act);
    for (const item of (act.selectedItems || [])) {
      if (item?.selected === false) continue;
      if (!isSameActItem(baseAct, baseItem, act, item)) continue;

      const status = getActItemStatus(item, deliveryMode);
      let statusText = '';
      let statusClass = '';

      if (deliveryMode) {
        if (status.key === 'not_delivered') {
          statusText = 'Товар не поставлен';
          statusClass = 'bg-red-500/15 text-red-300';
        } else if (status.key === 'positive') {
          statusText = 'Проверка пройдена';
          statusClass = 'bg-green-500/15 text-green-400';
        } else if (status.key === 'incomplete') {
          statusText = 'Результат проверки не зафиксирован';
          statusClass = 'bg-slate-500/15 text-slate-300';
        } else {
          statusText = 'Есть замечания';
          statusClass = 'bg-red-500/15 text-red-300';
        }
      } else if (status.key === 'skipped') {
        statusText = 'СО не предусмотрен';
        statusClass = 'bg-emerald-500/15 text-emerald-400';
      } else if (status.key === 'positive') {
        statusText = 'Проверка пройдена';
        statusClass = 'bg-green-500/15 text-green-400';
      } else if (status.key === 'incomplete') {
        statusText = 'Результат проверки не зафиксирован';
        statusClass = 'bg-slate-500/15 text-slate-300';
      } else {
        statusText = 'Есть замечания';
        statusClass = 'bg-red-500/15 text-red-300';
      }

      entries.push({
        actId: act.id,
        isCurrent: Number(act.id) === Number(baseAct.id),
        modeLabel: deliveryMode ? 'Поставка' : 'СО',
        contractLabel,
        date: act.date || '',
        dateLabel: act.date ? fmtDate(act.date) : 'без даты',
        location: act.location || '',
        qty: deliveryMode ? Number(item.qty || 0) || 0 : null,
        shippingAllowed: deliveryMode ? item.shippingAllowed === true : null,
        statusKey: status.key,
        statusText,
        statusClass,
      });
    }
  }

  return entries.sort((a, b) => {
    const dateCompare = String(b.date || '').localeCompare(String(a.date || ''));
    if (dateCompare !== 0) return dateCompare;
    return Number(b.actId || 0) - Number(a.actId || 0);
  });
}

function getActItemHistorySearchOptions() {
  const values = new Set();
  for (const act of (state.acts || [])) {
    for (const item of (act.selectedItems || [])) {
      if (item?.selected === false) continue;
      const code = String(item?.itemCode || '').trim();
      const name = String(item?.name || '').trim();
      if (code) values.add(code);
      if (name) values.add(name);
      if (code && name) values.add(`${code} — ${name}`);
    }
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'ru'));
}

function getActHistoryContractSearchOptions() {
  const values = new Set();
  for (const act of (state.acts || [])) {
    const contract = act?.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
    if (!contract) continue;
    const number = String(contract.number || '').trim();
    const title = String(contract.title || '').trim();
    if (number) values.add(number);
    if (title) values.add(title);
    if (number && title) values.add(`${number} — ${title}`);
  }
  return [...values].sort((a, b) => a.localeCompare(b, 'ru'));
}

function getActItemGroupKey(act, item) {
  const code = normalizeActItemText(item?.itemCode);
  const name = normalizeActItemText(item?.name);
  return `${code || name}`;
}

function getActItemHistoryGroups(query, contractQuery = '') {
  const hasProductQuery = !!String(query || '').trim();
  const hasContractQuery = !!String(contractQuery || '').trim();
  if (!hasProductQuery && !hasContractQuery) return [];

  const groups = new Map();
  for (const act of (state.acts || [])) {
    if (hasContractQuery && !haystackMatchesQuery(getActContractHaystack(act), contractQuery)) continue;
    for (const item of (act.selectedItems || [])) {
      if (item?.selected === false) continue;
      if (hasProductQuery && !haystackMatchesQuery(getActItemHaystack(item), query)) continue;

      const key = getActItemGroupKey(act, item);
      if (groups.has(key)) continue;
      groups.set(key, { act, item });
    }
  }

  return [...groups.values()]
    .map(({ act, item }) => {
      const entries = getActItemHistoryEntries(act, item);
      const contractLabels = [...new Set(entries.map(entry => entry.contractLabel).filter(Boolean))];
      const contractSummary = contractLabels.length <= 1
        ? (contractLabels[0] || t('actsRegistry.noContract'))
        : `Контракты: ${contractLabels.length}`;
      return {
        act,
        item,
        contractSummary,
        contractLabels,
        itemCode: String(item?.itemCode || '').trim(),
        itemName: String(item?.name || '').trim(),
        entries,
      };
    })
    .filter(group => group.entries.length > 0)
    .sort((a, b) => {
      const dateA = a.entries[0]?.date || '';
      const dateB = b.entries[0]?.date || '';
      const dateCompare = String(dateB).localeCompare(String(dateA));
      if (dateCompare !== 0) return dateCompare;
      const contractCompare = a.contractSummary.localeCompare(b.contractSummary, 'ru');
      if (contractCompare !== 0) return contractCompare;
      return a.itemName.localeCompare(b.itemName, 'ru');
    });
}

function renderRegistryProductHistory(container, onOpenAct = null, onFiltersChanged = null) {
  const searchId = 'actsRegistryProductHistorySearch';
  const contractSearchId = 'actsRegistryProductHistoryContractSearch';

  container.innerHTML = `
    <div class="rounded-2xl border border-cyan-400/15 bg-cyan-400/[0.04] p-4 mb-5">
      <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
        <div>
          <h3 class="text-sm font-semibold text-white">История по товару</h3>
          <p class="mt-1 text-xs text-slate-400">Найдите товар по коду или наименованию и посмотрите все проверки по нему.</p>
        </div>
        <button type="button" id="actsRegistryProductHistoryToggle"
          class="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-white/10">
          ${_registryProductHistoryCollapsed ? '▾ Развернуть' : '▴ Свернуть'}
        </button>
      </div>
      <div id="actsRegistryProductHistoryBody" class="${_registryProductHistoryCollapsed ? 'hidden' : ''}">
        <div class="grid gap-3 md:grid-cols-2 mb-3">
          <div class="relative">
            <input id="${searchId}" type="search"
              class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
              placeholder="Товар: код или часть наименования"
              value="${esc(_registryProductHistoryQuery)}">
          </div>
          <div class="relative">
            <input id="${contractSearchId}" type="search"
              class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white placeholder-slate-500 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
              placeholder="Контракт: номер или наименование"
              value="${esc(_registryProductHistoryContractQuery)}">
          </div>
        </div>
        <div id="actsRegistryProductHistoryResults"></div>
      </div>
    </div>`;

  const openActFromHistory = typeof onOpenAct === 'function'
    ? onOpenAct
    : (actId) => openActDetail(actId);

  const input = container.querySelector(`#${searchId}`);
  const contractInput = container.querySelector(`#${contractSearchId}`);
  const resultsEl = container.querySelector('#actsRegistryProductHistoryResults');
  const bodyEl = container.querySelector('#actsRegistryProductHistoryBody');
  const toggleBtn = container.querySelector('#actsRegistryProductHistoryToggle');
  if (!input || !contractInput || !resultsEl || !bodyEl || !toggleBtn) return;

  toggleBtn.addEventListener('click', () => {
    _registryProductHistoryCollapsed = !_registryProductHistoryCollapsed;
    bodyEl.classList.toggle('hidden', _registryProductHistoryCollapsed);
    toggleBtn.textContent = _registryProductHistoryCollapsed ? '▾ Развернуть' : '▴ Свернуть';
  });

  const renderResults = (value, contractValue) => {
    _registryProductHistoryQuery = value;
    _registryProductHistoryContractQuery = contractValue;
    if (typeof onFiltersChanged === 'function') {
      onFiltersChanged(value, contractValue);
    }
    const hasProductQuery = !!String(value || '').trim();
    const hasContractQuery = !!String(contractValue || '').trim();
    if (!hasProductQuery && !hasContractQuery) {
      resultsEl.innerHTML = '<p class="text-xs text-slate-500">Введите код, наименование товара или номер контракта, чтобы открыть историю проверок.</p>';
      return;
    }

    const groups = getActItemHistoryGroups(value, contractValue);
    if (!groups.length) {
      resultsEl.innerHTML = `<p class="text-xs text-amber-300">По такому запросу${hasContractQuery ? ' в выбранном контракте' : ''} проверки не найдены.</p>`;
      return;
    }

    resultsEl.innerHTML = `
      <div class="space-y-3">
        ${groups.map(group => `
          <div class="rounded-xl border border-white/10 bg-slate-950/35 px-3 py-3">
            <div class="flex items-start justify-between gap-3 flex-wrap mb-3">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  ${group.itemCode ? `<span class="font-mono text-[11px] text-cyan-300 bg-cyan-400/10 rounded px-2 py-0.5">${esc(group.itemCode)}</span>` : ''}
                  <span class="text-sm font-semibold text-white">${esc(group.itemName || 'Без наименования')}</span>
                  <span class="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${group.entries.length}</span>
                </div>
                <p class="mt-1 text-xs text-slate-400">${esc(group.contractSummary)}</p>
              </div>
            </div>
            <div class="space-y-2">
              ${group.entries.map(entry => `
                <div class="flex items-start justify-between gap-3 flex-wrap rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
                  <div class="min-w-0">
                    <div class="flex items-center gap-2 flex-wrap">
                      <span class="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${esc(entry.modeLabel)}</span>
                      <span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold ${entry.statusClass}">${esc(entry.statusText)}</span>
                      ${entry.isCurrent ? '<span class="rounded-lg bg-cyan-400/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">Базовый акт</span>' : ''}
                    </div>
                    <p class="mt-1 text-xs text-slate-300">${esc(entry.dateLabel)}${entry.location ? ` · ${esc(entry.location)}` : ''}</p>
                    <p class="mt-1 text-[11px] text-slate-500">${esc(entry.contractLabel)}</p>
                    ${entry.qty != null ? `<p class="mt-1 text-[11px] text-slate-500">Фактическое количество: <span class="font-semibold text-slate-300">${esc(String(entry.qty))}</span>${entry.shippingAllowed === true ? ' · Отгрузка разрешена' : entry.shippingAllowed === false ? ' · Отгрузка запрещена' : ''}</p>` : ''}
                  </div>
                  <button type="button" class="act-history-open-btn inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-300" data-act-id="${entry.actId}">Открыть акт</button>
                </div>`).join('')}
            </div>
          </div>`).join('')}
      </div>`;

    resultsEl.querySelectorAll('.act-history-open-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openActFromHistory(Number(btn.dataset.actId));
      });
    });
  };

  input.addEventListener('input', () => renderResults(input.value, contractInput.value));
  input.addEventListener('change', () => renderResults(input.value, contractInput.value));
  contractInput.addEventListener('input', () => renderResults(input.value, contractInput.value));
  contractInput.addEventListener('change', () => renderResults(input.value, contractInput.value));
  enhancePredictiveInput(input, {
    icon: '📦',
    minWidth: '260px',
  });
  enhancePredictiveInput(contractInput, {
    icon: '📑',
    minWidth: '260px',
  });

  renderResults(_registryProductHistoryQuery, _registryProductHistoryContractQuery);
}

function buildActItemHistoryHtml(baseAct, baseItem) {
  const entries = getActItemHistoryEntries(baseAct, baseItem);
  if (!entries.length) return '';

  return `
    <details class="mt-3 rounded-xl border border-white/10 bg-slate-950/35 px-3 py-3">
      <summary class="cursor-pointer list-none flex items-center justify-between gap-3 text-xs font-semibold text-cyan-300">
        <span>История проверок по товару</span>
        <span class="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] font-bold text-slate-300">${entries.length}</span>
      </summary>
      <div class="mt-3 space-y-2">
        ${entries.map(entry => `
          <div class="rounded-xl border border-white/8 bg-white/[0.03] px-3 py-2.5">
            <div class="flex items-start justify-between gap-3 flex-wrap">
              <div class="min-w-0">
                <div class="flex items-center gap-2 flex-wrap">
                  <span class="rounded-lg bg-white/10 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${esc(entry.modeLabel)}</span>
                  <span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold ${entry.statusClass}">${esc(entry.statusText)}</span>
                  ${entry.isCurrent ? '<span class="rounded-lg bg-cyan-400/15 px-2 py-0.5 text-[10px] font-semibold text-cyan-300">Текущий акт</span>' : ''}
                </div>
                <p class="mt-1 text-xs text-slate-300">${esc(entry.dateLabel)}${entry.location ? ` · ${esc(entry.location)}` : ''}</p>
                <p class="mt-1 text-[11px] text-slate-500">${esc(entry.contractLabel)}</p>
                ${entry.qty != null ? `<p class="mt-1 text-[11px] text-slate-500">Фактическое количество: <span class="font-semibold text-slate-300">${esc(String(entry.qty))}</span>${entry.shippingAllowed === true ? ' · Отгрузка разрешена' : entry.shippingAllowed === false ? ' · Отгрузка запрещена' : ''}</p>` : ''}
              </div>
              ${entry.isCurrent ? '' : `<button type="button" class="act-history-open-btn inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.05] px-3 py-1.5 text-[11px] font-semibold text-slate-300 transition hover:bg-cyan-400/10 hover:border-cyan-400/30 hover:text-cyan-300" data-act-id="${entry.actId}">Открыть акт</button>`}
            </div>
          </div>`).join('')}
      </div>
    </details>`;
}

function renderRegistry() {
  const listPanel = document.getElementById('actsRegistryList');
  if (!listPanel) return;

  const historyWrap = document.createElement('div');
  listPanel.innerHTML = '';
  listPanel.appendChild(historyWrap);

  // Tab bar
  const tabBar = document.createElement('div');
  tabBar.className = 'flex gap-1 mb-5 rounded-xl bg-white/[0.04] p-1';

  const soCount  = (state.acts || []).filter(a => (a.mode || 'so') === 'so').length;
  const delCount = (state.acts || []).filter(a => (a.mode || 'so') === 'delivery').length;

  const soTab  = _makeTabBtn('Акты проверки сигнальных образцов', _activeRegistryTab === 'so', soCount);
  const delTab = _makeTabBtn('Акты проверки поставленного товара', _activeRegistryTab === 'delivery', delCount);
  tabBar.append(soTab, delTab);
  listPanel.appendChild(tabBar);

  const contentWrap = document.createElement('div');
  listPanel.appendChild(contentWrap);

  const rerenderActiveTab = () => {
    _renderActsListWithSearch(
      contentWrap,
      _activeRegistryTab,
      act => openActDetail(act.id),
      () => renderRegistry()
    );
  };

  renderRegistryProductHistory(historyWrap, null, rerenderActiveTab);

  function showTab(tab) {
    _activeRegistryTab = tab;
    soTab.classList.toggle('bg-cyan-400/20',   tab === 'so');
    soTab.classList.toggle('text-white',        tab === 'so');
    soTab.classList.toggle('text-slate-400',    tab !== 'so');
    delTab.classList.toggle('bg-cyan-400/20',   tab === 'delivery');
    delTab.classList.toggle('text-white',        tab === 'delivery');
    delTab.classList.toggle('text-slate-400',    tab !== 'delivery');
    rerenderActiveTab();
  }

  soTab.addEventListener('click',  () => showTab('so'));
  delTab.addEventListener('click', () => showTab('delivery'));
  showTab(_activeRegistryTab);
}

// ─── Modal detail panel ───────────────────────────────────────────

let _detailActId = null;

function openActDetail(actId) {
  _detailActId = actId;
  const listPanel   = document.getElementById('actsRegistryListPanel');
  const detailPanel = document.getElementById('actDetailPanel');
  if (listPanel)   listPanel.classList.add('hidden');
  if (detailPanel) detailPanel.classList.remove('hidden');
  renderActDetail(actId);
}

function closeActDetail() {
  _detailActId = null;
  const listPanel   = document.getElementById('actsRegistryListPanel');
  const detailPanel = document.getElementById('actDetailPanel');
  if (detailPanel) detailPanel.classList.add('hidden');
  if (listPanel)   listPanel.classList.remove('hidden');
}

function renderActDetail(actId) {
  const wrap = document.getElementById('actDetailBody');
  if (!wrap) return;
  _renderActDetailHtml(actId, wrap);

  const titleEl = document.getElementById('actDetailTitle');
  const act = (state.acts || []).find(a => a.id === actId);
  const contract = act?.contractId ? state.contracts.find(c => c.id === act.contractId) : null;
  if (titleEl) titleEl.textContent = contract?.number ? `№ ${contract.number}` : t('actsRegistry.noContract');
}

// ─── Shared act detail HTML builder ──────────────────────────────

function _renderActDetailHtml(actId, wrap) {
  const act = (state.acts || []).find(a => a.id === actId);
  if (!act) return;

  const hydrated = getHydratedActForDisplay(act);
  const contract = hydrated?.contract || null;
  const supplier = hydrated?.supplier || null;
  const selected = hydrated?.selectedItems || [];
  const { attachments, photos, videos } = getActMediaItems(act);
  const isDelivery = (act.mode || 'so') === 'delivery';
  const aggregateStatus = getActAggregateStatus(selected, isDelivery);
  const aggregateBadge = getRegistryResultBadge(aggregateStatus, isDelivery, { compact: true });
  const actHasNotDelivered = isDelivery && selected.some(si => si.notDelivered);
  const actAllShipping = isDelivery && selected.length > 0 && selected.every(si => si.shippingAllowed === true);
  const actSomeShipping = isDelivery && selected.some(si => si.shippingAllowed === true);

  const commissionRows = (act.commission || []).filter(p => p.role || p.name)
    .map(p => `<tr>
      <td class="py-1 pr-4 text-sm text-slate-300 align-top">${esc(p.role)}</td>
      <td class="py-1 text-sm text-slate-200">${esc(p.name)}</td>
    </tr>`).join('') || `<tr><td colspan="2" class="py-2 text-xs text-slate-500">${t('commission.empty')}</td></tr>`;

  const supplierRepRows = (act.supplierReps || []).filter(p => p.role || p.name)
    .map(p => `<tr>
      <td class="py-1 pr-4 text-sm text-slate-300 align-top">${esc(p.role)}</td>
      <td class="py-1 text-sm text-slate-200">${esc(p.name)}</td>
    </tr>`).join('') || `<tr><td colspan="2" class="py-2 text-xs text-slate-500">—</td></tr>`;
  const participantRows = [
    ...getRecipientRepresentativesList(act),
    ...((act.invitedExperts || []).map(item => ({
      role: String(item?.role || ''),
      organization: String(item?.organization || ''),
      name: String(item?.name || ''),
    }))),
  ]
    .filter(item => item.role || item.organization || item.name)
    .map(item => `<tr>
        <td class="py-1 pr-4 text-sm text-slate-300 align-top">${esc(item.role || '—')}</td>
        <td class="py-1 pr-4 text-sm text-slate-300 align-top">${esc(item.organization || '—')}</td>
        <td class="py-1 text-sm text-slate-200">${esc(item.name || '—')}</td>
      </tr>`).join('') || `<tr><td colspan="3" class="py-2 text-xs text-slate-500">—</td></tr>`;

  wrap.innerHTML = `
    <div class="space-y-6">

      <!-- Header info -->
      <div class="rounded-xl border border-white/10 bg-white/5 p-4 space-y-2">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div class="flex flex-wrap gap-x-4 gap-y-1">
            ${contract ? `<div class="flex gap-2 flex-wrap">
              <span class="text-xs text-slate-500">Контракт:</span>
              <span class="text-sm text-white font-medium">${esc([contract.number ? `№ ${contract.number}` : '', contract.title].filter(Boolean).join(' — '))}</span>
            </div>` : ''}
            ${supplier ? `<div class="flex gap-2 flex-wrap">
              <span class="text-xs text-slate-500">Поставщик:</span>
              <span class="text-sm text-white">${esc(supplier.name)}</span>
            </div>` : ''}
            ${act.orderNumber ? `<div class="flex gap-2 flex-wrap">
              <span class="text-xs text-slate-500">Заявка:</span>
              <span class="text-sm text-white">${esc(act.orderNumber)}</span>
            </div>` : ''}
            ${act.location ? `<div class="flex gap-2 flex-wrap">
              <span class="text-xs text-slate-500">Место:</span>
              <span class="text-sm text-white">${esc(act.location)}</span>
            </div>` : ''}
            ${act.date ? `<div class="flex gap-2 flex-wrap">
              <span class="text-xs text-slate-500">Дата:</span>
              <span class="text-sm text-white">${esc(fmtDate(act.date))}</span>
            </div>` : ''}
          </div>
          <div class="flex items-center gap-2 shrink-0 flex-wrap">
            <span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold ${aggregateBadge.className}">${esc(aggregateBadge.text)}</span>
            ${isDelivery && selected.length > 0
              ? actAllShipping
                ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400">🚚 Отгрузка разрешена</span>`
                : actSomeShipping
                  ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-amber-500/15 text-amber-400">⛔ Отгрузка частично</span>`
                  : `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400">⛔ Отгрузка запрещена</span>`
              : ''}
            ${actHasNotDelivered ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300">Товар не поставлен</span>` : ''}
            ${attachments.length ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-white/10 text-slate-300">📎 ${attachments.length}</span>` : ''}
            ${photos.length ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-white/10 text-slate-300">📷 ${photos.length}</span>` : ''}
            ${videos.length ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-white/10 text-slate-300">🎥 ${videos.length}</span>` : ''}
            <span class="rounded-lg px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider
              ${(act.mode || 'so') === 'so' ? 'bg-violet-500/15 text-violet-400' : 'bg-cyan-500/15 text-cyan-400'}">
              ${(act.mode || 'so') === 'so' ? 'Проверка сигнальных образцов' : 'Проверка поставленного товара'}
            </span>
            <button class="act-detail-edit-btn inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30
              bg-cyan-400/5 px-3 py-1.5 text-xs font-semibold text-cyan-400
              hover:bg-cyan-400/15 transition"
              data-act-id="${act.id}">
              ✏️ Редактировать
            </button>
          </div>
        </div>
      </div>

      <!-- Commission -->
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">${t('act.sectionCommission')}</h4>
        <div class="overflow-hidden rounded-xl border border-white/10">
          <table class="w-full text-sm">
            <thead class="bg-white/[0.04] border-b border-white/10">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/2">${t('act.roleLabel')}</th>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/2">${t('act.nameLabel')}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 px-3">${commissionRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Supplier reps -->
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">${t('act.sectionSupplierReps')}</h4>
        <div class="overflow-hidden rounded-xl border border-white/10">
          <table class="w-full text-sm">
            <thead class="bg-white/[0.04] border-b border-white/10">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/2">${t('act.roleLabel')}</th>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/2">${t('act.nameLabel')}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 px-3">${supplierRepRows}</tbody>
          </table>
        </div>
      </div>

      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">${tf('act.participantsTitle', 'При участии представителей')}</h4>
        <div class="overflow-hidden rounded-xl border border-white/10">
          <table class="w-full text-sm">
            <thead class="bg-white/[0.04] border-b border-white/10">
              <tr>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/3">${tf('act.roleLabel', 'Должность')}</th>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/3">${tf('experts.fieldOrganization', 'Организация')}</th>
                <th class="px-3 py-2 text-left text-xs font-semibold text-slate-400 w-1/3">${tf('act.nameLabel', 'ФИО')}</th>
              </tr>
            </thead>
            <tbody class="divide-y divide-white/5 px-3">${participantRows}</tbody>
          </table>
        </div>
      </div>

      <!-- Items & specs -->
      ${selected.length > 0 ? `
      <div>
        <h4 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">${tf('act.sectionItems', 'Проверяемые товары')}</h4>
        <div class="space-y-3">
          ${selected.map(si => {
            const itemStatus = getActItemStatus(si, isDelivery);
            const siFail = itemStatus.key === 'negative' || itemStatus.key === 'not_delivered';
            const itemBadge = (() => {
              if (isDelivery) {
                if (itemStatus.key === 'not_delivered') {
                  return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300">Товар не поставлен</span>`;
                }
                if (itemStatus.key === 'positive') {
                  return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400">Проверка пройдена</span>`;
                }
                if (itemStatus.key === 'incomplete') {
                  return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-slate-500/15 text-slate-300">Результат не зафиксирован</span>`;
                }
                return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300">Есть замечания</span>`;
              }
              if (itemStatus.key === 'skipped') {
                return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-emerald-500/15 text-emerald-400">СО не предусмотрен</span>`;
              }
              if (itemStatus.key === 'positive') {
                return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400">Проверка пройдена</span>`;
              }
              if (itemStatus.key === 'incomplete') {
                return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-slate-500/15 text-slate-300">Результат не зафиксирован</span>`;
              }
              return `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-300">Есть замечания</span>`;
            })();
            const shippingBadge = isDelivery
              ? si.shippingAllowed === true
                ? `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-green-500/15 text-green-400">🚚 Отгрузка разрешена</span>`
                : `<span class="rounded-lg px-2 py-0.5 text-[10px] font-semibold bg-red-500/15 text-red-400">⛔ Отгрузка запрещена</span>`
              : '';
            const borderCls = siFail
              ? 'border-red-500/20'
              : itemStatus.key === 'incomplete'
                ? 'border-slate-500/20'
                : (isDelivery && si.shippingAllowed === false)
                  ? 'border-amber-500/20'
                  : itemStatus.key === 'skipped'
                    ? 'border-emerald-500/20'
                    : 'border-green-500/15';
            const soResultHtml = !isDelivery && !si.siSoNotRequired
              ? `<div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300"><span class="font-semibold text-slate-200">Итог проверки СО:</span> ${si.soConforms === false ? '<span class="text-red-300 font-semibold">Не соответствует</span>' : '<span class="text-green-400 font-semibold">Соответствует</span>'}</div>`
              : '';
            const deliveryMetaHtml = isDelivery
              ? `<div class="grid gap-2 sm:grid-cols-2">
                  <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300"><span class="font-semibold text-slate-200">Количество по контракту:</span> ${esc(String(si.contractQty ?? '—'))}</div>
                  <div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300"><span class="font-semibold text-slate-200">Фактическое количество:</span> ${si.notDelivered ? '<span class="text-red-300 font-semibold">0 (не поставлен)</span>' : esc(String(si.qty || '—'))}</div>
                </div>`
              : '';
            const normDocHtml = si.normDocEnabled
              ? `<div class="rounded-lg border ${si.normDocConforms === false ? 'border-red-500/20 bg-red-500/10' : 'border-green-500/20 bg-green-500/10'} px-3 py-2.5 text-xs">
                  <div class="flex items-center gap-2 flex-wrap">
                    <span class="font-semibold text-slate-100">Иные замечания:</span>
                    ${si.normDocConforms === false
                      ? '<span class="text-red-300 font-semibold">Есть замечание</span>'
                      : '<span class="text-green-400 font-semibold">Без замечаний</span>'}
                  </div>
                  ${si.normDocComment ? `<div class="mt-1.5 text-slate-300 whitespace-pre-line"><span class="font-semibold text-slate-200">Комментарий:</span> ${esc(si.normDocComment)}</div>` : ''}
                </div>`
              : `<div class="rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-400"><span class="font-semibold text-slate-300">Соответствие нормативным документам:</span> блок не заполнялся</div>`;
            return `
            <div class="rounded-xl border ${borderCls} bg-white/5 p-3">
              <div class="flex items-center gap-2 flex-wrap mb-2">
                ${si.itemCode ? `<span class="font-mono text-xs text-cyan-400/80 bg-cyan-400/10 rounded px-1.5 py-0.5">${esc(si.itemCode)}</span>` : ''}
                <span class="text-sm font-semibold text-white">${esc(si.name)}</span>
                ${itemBadge}
                ${shippingBadge}
              </div>
              ${si.description ? `<div class="mb-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-xs text-slate-300"><span class="font-semibold text-slate-200">Описание товара:</span> ${esc(si.description)}</div>` : ''}
              <div class="space-y-2 mb-2">
                ${soResultHtml}
                ${deliveryMetaHtml}
                ${normDocHtml}
              </div>
              ${si.notDelivered
                ? `<div class="rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-xs font-semibold text-red-200">Товар не поставлен. Фактические значения характеристик отсутствуют.</div>`
                : si.specs && si.specs.length > 0 ? `
              <div class="overflow-x-auto rounded-lg border border-white/10">
                <table class="w-full text-xs">
                  <thead class="bg-white/[0.04]">
                    <tr>
                      <th class="px-3 py-1.5 text-left text-slate-400">${tf('act.colParam', 'Параметр')}</th>
                      <th class="px-3 py-1.5 text-left text-slate-400">${tf('act.colUnit', 'Единица измерения')}</th>
                      <th class="px-3 py-1.5 text-left text-slate-400">${tf('act.colContractValue', 'Значение по договору')}</th>
                      <th class="px-3 py-1.5 text-left text-slate-400">${tf('act.colCheckResult', 'Фактическое значение')}</th>
                      <th class="px-3 py-1.5 text-left text-slate-400">${tf('act.colRemark', 'Замечание')}</th>
                    </tr>
                  </thead>
                  <tbody class="divide-y divide-white/5">
                    ${si.specs.map(spec => {
                      const specFail = !getSpecConforms(spec);
                      return `
                      <tr class="${specFail ? 'bg-red-500/5' : 'bg-green-500/5'}">
                        <td class="px-3 py-1.5 ${specFail ? 'text-red-300 font-semibold' : 'text-slate-300'}">${esc(spec.param || '—')}</td>
                        <td class="px-3 py-1.5 text-slate-400">${esc(spec.unit || '—')}</td>
                        <td class="px-3 py-1.5 text-cyan-400/80">${esc(spec.value || '—')}</td>
                        <td class="px-3 py-1.5 text-slate-200">${esc(spec.checkResult || '—')}</td>
                        <td class="px-3 py-1.5">
                          ${getSpecConforms(spec)
                            ? `<span class="text-green-400 text-xs font-semibold">${tf('act.remarkNone', 'Без замечаний')}</span>`
                            : `<span class="text-red-400 text-xs font-semibold">${tf('act.remarkHas', 'Есть замечание')}</span>`}
                        </td>
                      </tr>`;
                    }).join('')}
                  </tbody>
                </table>
              </div>` : `<p class="text-xs text-slate-500">${t('act.noSpecs')}</p>`}
              ${buildActItemHistoryHtml(act, si)}
            </div>`;
          }).join('')}
        </div>
      </div>` : ''}

      <!-- Result / Prescription / Deadline -->
      ${(getResultPrescriptionText(act) || act.deadline) ? `
      <div class="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
        ${getResultPrescriptionText(act) ? `<div>
          <p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">${tf('act.fieldResultPrescription', 'Результаты и предписания')}</p>
          <p class="text-sm text-white whitespace-pre-line">${esc(getResultPrescriptionText(act))}</p>
        </div>` : ''}
        ${act.deadline ? `<div>
          <p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-1">${t('act.fieldDeadline')}</p>
          <p class="text-sm text-white">${esc(fmtDate(act.deadline))}</p>
        </div>` : ''}
      </div>` : ''}

      ${(attachments.length || photos.length || videos.length) ? `
      <div class="rounded-xl border border-white/10 bg-white/5 p-4 space-y-4">
        ${attachments.length ? `
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Вложения</p>
            <div class="space-y-2">
              ${attachments.map(file => `
                <div class="flex items-center gap-3 rounded-lg border border-white/10 bg-slate-950/40 px-3 py-2.5">
                  <span aria-hidden="true">📎</span>
                  <div class="min-w-0 flex-1">
                    <p class="truncate text-sm text-white">${esc(file.originalName || 'file')}</p>
                    <p class="text-xs text-slate-500">${esc(fmtSize(file.sizeBytes) || '—')}</p>
                  </div>
                  <a href="${esc(getActMediaDownloadUrl(file))}" target="_blank" rel="noopener" download="${esc(file.originalName || 'file')}" class="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10">${t('contracts.downloadFile')}</a>
                </div>`).join('')}
            </div>
          </div>` : ''}
        ${photos.length ? `
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Фотографии</p>
            <div class="grid grid-cols-2 sm:grid-cols-3 gap-3">
              ${photos.map(photo => `
                <a href="${esc(getActMediaPreviewUrl(photo))}" target="_blank" rel="noopener" class="rounded-xl overflow-hidden border border-white/10 bg-slate-950/40 block">
                  <img src="${esc(getActMediaPreviewUrl(photo))}" alt="${esc(photo.originalName || 'photo')}" class="aspect-square w-full object-cover">
                  <span class="block truncate px-3 py-2 text-xs text-slate-300">${esc(photo.originalName || 'photo')}</span>
                </a>`).join('')}
            </div>
          </div>` : ''}
        ${videos.length ? `
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-2">Видео</p>
            <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
              ${videos.map(video => `
                <div class="rounded-xl overflow-hidden border border-white/10 bg-slate-950/40">
                  <video src="${esc(getActMediaPreviewUrl(video))}" class="aspect-video w-full object-cover" preload="metadata" controls playsinline></video>
                  <div class="flex items-center gap-2 px-3 py-2">
                    <span class="min-w-0 flex-1 truncate text-xs text-slate-300">${esc(video.originalName || 'video')}</span>
                    <a href="${esc(getActMediaDownloadUrl(video))}" target="_blank" rel="noopener" download="${esc(video.originalName || 'video.webm')}" class="rounded-lg border border-white/10 px-2 py-1 text-[11px] font-semibold text-slate-300 transition hover:bg-white/10">${t('contracts.downloadFile')}</a>
                  </div>
                </div>`).join('')}
            </div>
          </div>` : ''}
      </div>` : ''}

      <!-- Buttons -->
      <div class="flex gap-3 justify-end flex-wrap">
        <button class="act-detail-edit-btn2 inline-flex items-center gap-2 rounded-xl border border-cyan-400/30
          bg-cyan-400/5 px-5 py-2.5 text-sm font-semibold text-cyan-400
          hover:bg-cyan-400/15 transition active:scale-[0.97]"
          data-act-id="${act.id}">
          ✏️ Редактировать
        </button>
        <button class="act-detail-dl-btn inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-5 py-2.5
          text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 active:scale-[0.97]">
          <span aria-hidden="true">📄</span>
          ${t('actsRegistry.download')}
        </button>
      </div>

    </div>`;

  // Wire edit buttons
  wrap.querySelectorAll('.act-detail-edit-btn, .act-detail-edit-btn2').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { openActFormForEdit } = await import('./act-form-view.js');
      openActFormForEdit(act.id);
    });
  });

  wrap.querySelectorAll('.act-history-open-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openActDetail(Number(btn.dataset.actId));
    });
  });

  wrap.querySelector('.act-detail-dl-btn')?.addEventListener('click', () => generateAndDownload(actId));
}

// ─── Re-generate Word from saved act ─────────────────────────────

export async function generateAndDownload(actId) {
  const act = (state.acts || []).find(a => a.id === actId);
  if (!act) return;

  try {
    const { buildActDocx } = await import('./act-form-view.js');
    const hydrated = getHydratedActForDisplay(act);
    const contract = hydrated?.contract || null;
    const supplier = hydrated?.supplier || null;
    const selected = hydrated?.selectedItems || [];
    const docAct = {
      ...act,
      selectedItems: selected,
    };

    const blob = await buildActDocx(docAct, contract, supplier, selected);
    const typeLabel = (act.mode || 'so') === 'so' ? 'сигнальных_образцов' : 'поставки';
    const fname = `Акт_проверки_${typeLabel}_${contract?.number || 'б_н'}.docx`;
    downloadBlob(blob, fname);
    showToast(t('act.generated'), 'success');
  } catch (err) {
    console.error('Re-generate error:', err);
    showToast(t('act.generateError'), 'error');
  }
}

// ─── Helpers ──────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtSize(sizeBytes) {
  const size = Number(sizeBytes || 0);
  if (!size) return '';
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / 1024 / 1024).toFixed(2)} МБ`;
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  } catch { return iso; }
}

function fmtDateTime(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
