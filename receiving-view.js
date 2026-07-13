/**
 * Receiving View — модуль «Приёмка».
 * Список контрактов (синхр. с модулем Контракты).
 * В каждом контракте — список товаров с полями приёмки + вкладка реестра актов.
 *
 * Структура item в контракте:
 *   item.name       — наименование (введено вручную или выбрано из каталога)
 *   item.productRef — id товара из каталога (только если выбран через автодополнение)
 *   item.price, item.qty — цена и количество
 *   item.receiving  — объект с данными приёмки
 */

import { state } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { openActForm } from './act-form-view.js';
import { loadXLSX } from './lib-loader.js';
import { enhancePredictiveInput } from './filters.js';
import { confirmDeleteWithImpact } from './dom.js';
import {
  addCommissionMember,
  updateCommissionMember,
  removeCommissionMember,
  addInvitedExpert,
  updateInvitedExpert,
  removeInvitedExpert,
  addInspectionSchedule,
  updateInspectionSchedule,
  deleteInspectionSchedule,
  getRecipientAddresses,
} from '../state.js';
import { openActsRegistryInReceiving } from './acts-registry-view.js';
import { updateActsBadge } from './acts-registry-view.js';


const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

function normalizeInspectionType(value) {
  return String(value || '').trim().toLowerCase() === 'so' ? 'so' : 'delivery';
}

function normalizeScheduleTime(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const match = raw.match(/^(\d{1,2}):(\d{2})/);
  if (!match) return '';
  const hours = Math.max(0, Math.min(23, Number(match[1]) || 0));
  const minutesRaw = Number(match[2]) || 0;
  const minutes = Math.max(0, Math.min(45, Math.round(minutesRaw / 15) * 15));
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;
}

function buildQuarterHourOptions(selectedValue = '') {
  const normalized = normalizeScheduleTime(selectedValue);
  const result = [`<option value="">${escHtml(tr('receivingSchedule.selectTime', 'Выберите время'))}</option>`];
  for (let hour = 9; hour <= 20; hour += 1) {
    [0, 15, 30, 45].forEach((minute) => {
      const value = `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
      result.push(`<option value="${value}" ${value === normalized ? 'selected' : ''}>${value}</option>`);
    });
  }
  return result.join('');
}

function getScheduleAcceptanceStatusOptions() {
  return [
    ['', tr('receivingSchedule.statusPlanned', 'Плановые задачи')],
    ['Плановые задачи', tr('receivingSchedule.statusPlanned', 'Плановые задачи')],
    ['Принято', tr('receivingSchedule.statusAccepted', 'Принято')],
    ['Принято с замечаниями', tr('receivingSchedule.statusAcceptedWithNotes', 'Принято с замечаниями')],
    ['Не принято (замечания)', tr('receivingSchedule.statusRejectedNotes', 'Не принято (замечания)')],
    ['Не принято (непоставка)', tr('receivingSchedule.statusRejectedNoDelivery', 'Не принято (непоставка)')],
  ];
}

function getScheduleExperts(entry) {
  const ids = Array.isArray(entry?.expertIds) ? entry.expertIds.map(id => Number(id) || 0).filter(Boolean) : [];
  const names = Array.isArray(entry?.expertNames) ? entry.expertNames.map(name => String(name || '').trim()).filter(Boolean) : [];
  if (ids.length || names.length) {
    return ids.map((id, index) => ({ id, name: names[index] || ((state.commission || []).find(item => Number(item.id) === Number(id))?.name || '') }))
      .concat(names.slice(ids.length).map(name => ({ id: null, name })))
      .filter(item => item.name || item.id);
  }
  if (entry?.expertId || entry?.expertName) {
    return [{ id: entry.expertId ?? null, name: entry.expertName || ((state.commission || []).find(item => Number(item.id) === Number(entry.expertId))?.name || '') }]
      .filter(item => item.name || item.id);
  }
  return [];
}

function setScheduleExperts(entry, experts) {
  const normalized = (Array.isArray(experts) ? experts : [])
    .map(item => ({ id: item?.id ? Number(item.id) : null, name: String(item?.name || '').trim() }))
    .filter(item => item.name || item.id);
  entry.expertIds = normalized.map(item => item.id).filter(Boolean);
  entry.expertNames = normalized.map(item => item.name || ((state.commission || []).find(expert => Number(expert.id) === Number(item.id))?.name || '')).filter(Boolean);
  entry.expertId = entry.expertIds[0] ?? null;
  entry.expertName = entry.expertNames[0] || '';
}

function isRepeatInspectionEntry(entry) {
  const entryType = normalizeInspectionType(entry?.inspectionType);
  const currentId = String(entry?.id || '');
  const peers = (state.inspectionSchedules || []).filter(item => String(item.id || '') !== currentId);
  return peers.some(item => {
    if (normalizeInspectionType(item?.inspectionType) !== entryType) return false;
    const sameContract = (entry?.contractId && item?.contractId && String(entry.contractId) === String(item.contractId))
      || (!entry?.contractId && !item?.contractId && String(entry?.contractNumber || '').trim() && String(entry?.contractNumber || '').trim() === String(item?.contractNumber || '').trim());
    const sameRecipient = (entry?.recipientId && item?.recipientId && String(entry.recipientId) === String(item.recipientId))
      || (!entry?.recipientId && !item?.recipientId && String(entry?.recipientName || '').trim() && String(entry?.recipientName || '').trim() === String(item?.recipientName || '').trim());
    return sameContract && sameRecipient;
  });
}

function getInspectionTypeLabel(value) {
  return normalizeInspectionType(value) === 'so'
    ? tr('receivingSchedule.inspectionTypeSo', 'Проверка сигнального образца')
    : tr('receivingSchedule.inspectionTypeDelivery', 'Проверка поставленного товара');
}

function getInspectionTypeOptions(selectedValue) {
  const normalized = normalizeInspectionType(selectedValue);
  return [
    { value: 'so', label: tr('receivingSchedule.inspectionTypeSo', 'Проверка сигнального образца') },
    { value: 'delivery', label: tr('receivingSchedule.inspectionTypeDelivery', 'Проверка поставленного товара') },
  ].map(option => `<option value="${option.value}" ${option.value === normalized ? 'selected' : ''}>${escHtml(option.label)}</option>`).join('');
}

// ─── Open / Close ─────────────────────────────────────────────────

// Active tab: 'receiving' | 'acts'
let _activeTab = 'receiving';
let _inspectionScheduleModalOpen = false;
let _inspectionScheduleFilters = {
  contract: '',
  recipient: '',
  expert: '',
  status: '',
  inspectionType: '',
};
const _newInspectionScheduleIds = new Set();
const _editingInspectionScheduleIds = new Set();

function sortInspectionScheduleEntries(entries) {
  return [...(entries || [])].sort((a, b) => {
    const aIsNew = _newInspectionScheduleIds.has(String(a?.id || ''));
    const bIsNew = _newInspectionScheduleIds.has(String(b?.id || ''));
    if (aIsNew !== bIsNew) return aIsNew ? -1 : 1;
    const timeCompare = `${a?.date || ''} ${normalizeScheduleTime(a?.time) || ''}`
      .localeCompare(`${b?.date || ''} ${normalizeScheduleTime(b?.time) || ''}`);
    if (timeCompare !== 0) return timeCompare;
    return Number(a?.id || 0) - Number(b?.id || 0);
  });
}

export function openReceivingModal() {
  const overlay = document.getElementById('receivingModal');
  if (!overlay) return;
  overlay.classList.add('open');
  _activeTab = 'receiving';
  ensureInspectionScheduleMount();
  ensureInspectionScheduleModal();
  renderListView();
  renderCommissionBlock();
  renderInvitedExpertsBlock();
  renderInspectionScheduleBlock();
  updateCommissionBadge();
  updateInvitedExpertsBadge();
  updateInspectionScheduleBadge();
  updateActsBadge();
}

export function closeReceivingModal() {
  closeInspectionScheduleModal();
  const overlay = document.getElementById('receivingModal');
  if (overlay) overlay.classList.remove('open');
}

export function initReceivingView() {
  const overlay = document.getElementById('receivingModal');
  if (!overlay) return;

  ensureInspectionScheduleMount();
  ensureInspectionScheduleModal();

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeReceivingModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      if (_inspectionScheduleModalOpen) {
        closeInspectionScheduleModal();
        return;
      }
      const cardPanel = document.getElementById('receivingCardPanel');
      if (cardPanel && !cardPanel.classList.contains('hidden')) {
        closeContractCard();
      } else {
        closeReceivingModal();
      }
    }
  });

  const closeBtn = document.getElementById('receivingCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeReceivingModal);

  const backBtn = document.getElementById('receivingCardBackBtn');
  if (backBtn) backBtn.addEventListener('click', closeContractCard);

  const generateActBtn = document.getElementById('generateActBtn');
  if (generateActBtn) {
    generateActBtn.addEventListener('click', () => {
      openActForm(_currentContractId, 'delivery');
    });
  }

  // Tab buttons
  document.getElementById('receivingTabReceiving')?.addEventListener('click', () => {
    _activeTab = 'receiving';
    renderListView();
  });
  document.getElementById('receivingTabActs')?.addEventListener('click', () => {
    _activeTab = 'acts';
    renderListView();
  });

  // Commission block init
  renderCommissionBlock();
  renderInvitedExpertsBlock();
  renderInspectionScheduleBlock();
  updateCommissionBadge();
  updateInvitedExpertsBadge();
  updateInspectionScheduleBadge();

  // Toggle commission panel
  const toggleBtn = document.getElementById('commissionToggleBtn');
  const panelWrap = document.getElementById('commissionPanelWrap');
  const toggleIcon = document.getElementById('commissionToggleIcon');
  if (toggleBtn && panelWrap) {
    toggleBtn.addEventListener('click', () => {
      const isOpen = !panelWrap.classList.contains('hidden');
      panelWrap.classList.toggle('hidden', isOpen);
      if (toggleIcon) toggleIcon.textContent = isOpen ? '▼' : '▲';
    });
  }

  const expertsToggleBtn = document.getElementById('invitedExpertsToggleBtn');
  const expertsPanelWrap = document.getElementById('invitedExpertsPanelWrap');
  const expertsToggleIcon = document.getElementById('invitedExpertsToggleIcon');
  if (expertsToggleBtn && expertsPanelWrap) {
    expertsToggleBtn.addEventListener('click', () => {
      const isOpen = !expertsPanelWrap.classList.contains('hidden');
      expertsPanelWrap.classList.toggle('hidden', isOpen);
      if (expertsToggleIcon) expertsToggleIcon.textContent = isOpen ? '▼' : '▲';
    });
  }

  document.getElementById('inspectionScheduleOpenBtn')?.addEventListener('click', openInspectionScheduleModal);
  document.getElementById('inspectionScheduleQuickOpenBtn')?.addEventListener('click', openInspectionScheduleModal);
  document.getElementById('inspectionScheduleModalCloseBtn')?.addEventListener('click', closeInspectionScheduleModal);
}

// ─── List panel ───────────────────────────────────────────────────

function renderListView() {
  _renderTabBar();
  // Show/hide commission block depending on active tab
  const commToggle = document.getElementById('commissionToggleBtn');
  if (commToggle) {
    const commBlock = commToggle.closest('.mb-4') || commToggle.parentElement;
    if (commBlock) commBlock.style.display = _activeTab === 'acts' ? 'none' : '';
  }
  const expertsToggle = document.getElementById('invitedExpertsToggleBtn');
  if (expertsToggle) {
    const expertsBlock = expertsToggle.closest('.mb-4') || expertsToggle.parentElement;
    if (expertsBlock) expertsBlock.style.display = _activeTab === 'acts' ? 'none' : '';
  }
  const scheduleToggle = document.getElementById('inspectionScheduleToggleBtn');
  if (scheduleToggle) {
    const scheduleBlock = scheduleToggle.closest('.mb-4') || scheduleToggle.parentElement;
    if (scheduleBlock) scheduleBlock.style.display = _activeTab === 'acts' ? 'none' : '';
  }

  if (_activeTab === 'acts') {
    _renderActsTab();
  } else {
    renderReceivingButtons();
  }
}

function _renderTabBar() {
  const tabBar = document.getElementById('receivingTabBar');
  if (!tabBar) return;
  const isReceiving = _activeTab === 'receiving';
  const activeCls = 'bg-cyan-400/20 text-white border-b-2 border-cyan-400';
  const inactiveCls = 'text-slate-400 hover:text-slate-200';
  const rBtn = document.getElementById('receivingTabReceiving');
  const aBtn = document.getElementById('receivingTabActs');
  if (rBtn) {
    rBtn.className = `flex-1 py-2.5 text-sm font-semibold transition rounded-tl-xl ${isReceiving ? activeCls : inactiveCls}`;
    rBtn.setAttribute('aria-selected', String(isReceiving));
  }
  if (aBtn) {
    aBtn.className = `flex-1 py-2.5 text-sm font-semibold transition rounded-tr-xl ${!isReceiving ? activeCls : inactiveCls}`;
    aBtn.setAttribute('aria-selected', String(!isReceiving));
  }
}

function _renderActsTab() {
  const wrap = document.getElementById('receivingListContainer');
  if (!wrap) return;
  wrap.innerHTML = '';
  openActsRegistryInReceiving(wrap);
}

function getReceivingContracts() {
  return [...(state.contracts || [])]
    .filter(contract => Array.isArray(contract.items) && contract.items.some(item => (item.name || '').trim()))
    .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || (b.id || 0) - (a.id || 0));
}

function getContractReceivingStats(contract) {
  const items = (contract.items || []).filter(item => (item.name || '').trim());
  const filled = items.filter(item => {
    const r = item.receiving || {};
    return !!(
      r.soDeadline || r.soResult ||
      r.warehouseDeadline || r.warehouseResult ||
      r.recipientId || r.recipientName || r.recipientResult
    );
  }).length;
  return { items, total: items.length, filled };
}

function renderReceivingButtons() {
  const wrap = document.getElementById('receivingListContainer');
  if (!wrap) return;

  const scheduleCount = (state.inspectionSchedules || []).length;

  wrap.innerHTML = `
    <div class="space-y-6 py-2">
      <div class="receiving-main-grid">
        <button id="btnCheckSO" type="button"
          class="receiving-main-card">
          <span class="receiving-main-card__icon" aria-hidden="true">🔬</span>
          <div class="receiving-main-card__body">
            <p class="receiving-main-card__title">Проверка сигнальных образцов</p>
            <p class="receiving-main-card__text">Акт проверки соответствия характеристик образцов условиям договора</p>
          </div>
          <svg class="receiving-main-card__arrow" width="18" height="18"
            viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h6M13 7l3 3-3 3"/></svg>
        </button>

        <button id="btnCheckDelivery" type="button"
          class="receiving-main-card">
          <span class="receiving-main-card__icon" aria-hidden="true">📦</span>
          <div class="receiving-main-card__body">
            <p class="receiving-main-card__title">Проверка поставленного товара</p>
            <p class="receiving-main-card__text">Акт проверки поставленного товара с указанием фактического количества</p>
          </div>
          <svg class="receiving-main-card__arrow" width="18" height="18"
            viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h6M13 7l3 3-3 3"/></svg>
        </button>

        <button id="btnInspectionSchedule" type="button"
          class="receiving-main-card">
          <span class="receiving-main-card__icon" aria-hidden="true">🗓️</span>
          <div class="receiving-main-card__body">
            <div class="receiving-main-card__title-row">
              <p class="receiving-main-card__title">${tr('receivingSchedule.title', 'График проверок')}</p>
              ${scheduleCount > 0 ? `<span class="receiving-main-card__badge">${scheduleCount}</span>` : ''}
            </div>
            <p class="receiving-main-card__text">${tr('receivingSchedule.hint', 'Пользователь заполняет график, а результаты акта проверки автоматически возвращаются в эту строку.')}</p>
          </div>
          <svg class="receiving-main-card__arrow" width="18" height="18"
            viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2"
            stroke-linecap="round" stroke-linejoin="round"><path d="M7 10h6M13 7l3 3-3 3"/></svg>
        </button>
      </div>
    </div>`;

  document.getElementById('btnCheckSO')?.addEventListener('click', () => {
    openActForm(null, 'so');
  });
  document.getElementById('btnCheckDelivery')?.addEventListener('click', () => {
    openActForm(null, 'delivery');
  });
  document.getElementById('btnInspectionSchedule')?.addEventListener('click', () => {
    openInspectionScheduleModal();
  });
}

// ─── Contract card (full-screen) ──────────────────────────────────

let _currentContractId = null;

function openContractCard(contractId) {
  _currentContractId = contractId;
  const listPanel = document.getElementById('receivingListPanel');
  const cardPanel = document.getElementById('receivingCardPanel');
  if (listPanel) listPanel.classList.add('hidden');
  if (cardPanel) cardPanel.classList.remove('hidden');
  renderContractCard(contractId);
}

function closeContractCard() {
  _currentContractId = null;
  const listPanel = document.getElementById('receivingListPanel');
  const cardPanel = document.getElementById('receivingCardPanel');
  if (cardPanel) cardPanel.classList.add('hidden');
  if (listPanel) listPanel.classList.remove('hidden');
  renderReceivingButtons();
}

function renderContractCard(contractId) {
  const contract = state.contracts.find(c => c.id === contractId);
  if (!contract) return;

  const titleEl = document.getElementById('receivingCardTitle');
  if (titleEl) titleEl.textContent = contract.number || t('contracts.noNumber');

  const wrap = document.getElementById('receivingCardWrap');
  if (!wrap) return;

  // Only show rows that have a name (skip empty placeholder rows)
  const items = (contract.items || []).filter(i => i.name && i.name.trim());

  if (items.length === 0) {
    wrap.innerHTML = `<p class="text-sm text-slate-400 py-8 text-center">${t('receiving.noItems')}</p>`;
    return;
  }

  // Recipient options for datalist
  const recipientOptions = (state.recipients || [])
    .map(r => `<option value="${escHtml(r.name)}" data-id="${r.id}">`)
    .join('');

  wrap.innerHTML = `
    <datalist id="receivingRecipientList">${recipientOptions}</datalist>
    <div class="space-y-4">
      ${items.map((item, idx) => renderItemCard(contract, item, idx)).join('')}
    </div>
  `;

  // Wire save buttons
  items.forEach((item, idx) => {
    wireItemCard(wrap, contract, item, idx);
  });
}

// ─── Build product info from item ─────────────────────────────────

function resolveProduct(item) {
  // productRef is set only when user picks from autocomplete in contracts view
  if (item.productRef != null) {
    const p = state.products.find(p => p.id === item.productRef);
    if (p) return p;
  }
  return null;
}

/**
 * Get the item code directly from item.code (set by contracts-view when
 * product is selected via autocomplete). Falls back to empty string.
 */
function getItemCode(item) {
  return (item.code || '').trim();
}

// ─── Item card HTML ───────────────────────────────────────────────

function renderItemCard(contract, item, idx) {
  const product = resolveProduct(item);
  // Name: prefer catalog name, then manually entered name
  const productName = product ? product.name : (item.name || t('receiving.unknownProduct'));
  // Code comes directly from item.code (set and persisted by contracts-view)
  const code = getItemCode(item);

  const r = item.receiving || {};

  // Recipient display name
  const recipientName = r.recipientId
    ? (state.recipients.find(rec => rec.id === r.recipientId)?.name || r.recipientName || '')
    : (r.recipientName || '');

  return `
    <div class="rounded-2xl border border-white/10 bg-white/5 p-5" data-item-idx="${idx}">
      <!-- Product header -->
      <div class="flex items-start gap-3 mb-4">
        <div class="flex-1 min-w-0">
          <div class="flex items-center gap-2 flex-wrap">
            ${code ? `<span class="font-mono text-xs text-cyan-400/80 bg-cyan-400/10 rounded px-1.5 py-0.5">${escHtml(code)}</span>` : ''}
            <span class="text-sm font-semibold text-white">${escHtml(productName)}</span>
          </div>
          <div class="flex gap-4 mt-1 text-xs text-slate-500">
            ${item.qty ? `<span>${t('receiving.qty')}: <b class="text-slate-300">${item.qty}</b></span>` : ''}
            ${item.price ? `<span>${t('receiving.price')}: <b class="text-slate-300">${fmtNum(item.price)} ₽</b></span>` : ''}
          </div>
        </div>
      </div>

      <!-- Receiving fields grid -->
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4">

        <!-- СО Deadline -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="soDeadline_${idx}">${t('receiving.soDeadline')}</label>
          <input id="soDeadline_${idx}" type="date"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            value="${escHtml(r.soDeadline || '')}"
            data-field="soDeadline" data-idx="${idx}">
        </div>

        <!-- СО Result -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="soResult_${idx}">${t('receiving.soResult')}</label>
          <select id="soResult_${idx}"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            data-field="soResult" data-idx="${idx}">
            <option value="" ${!r.soResult ? 'selected' : ''}>${t('receiving.resultNone')}</option>
            <option value="passed" ${r.soResult === 'passed' ? 'selected' : ''}>${t('receiving.resultPassed')}</option>
            <option value="failed" ${r.soResult === 'failed' ? 'selected' : ''}>${t('receiving.resultFailed')}</option>
            <option value="partial" ${r.soResult === 'partial' ? 'selected' : ''}>${t('receiving.resultPartial')}</option>
          </select>
        </div>

        <!-- Warehouse Deadline -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="warehouseDeadline_${idx}">${t('receiving.warehouseDeadline')}</label>
          <input id="warehouseDeadline_${idx}" type="date"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            value="${escHtml(r.warehouseDeadline || '')}"
            data-field="warehouseDeadline" data-idx="${idx}">
        </div>

        <!-- Warehouse Result -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="warehouseResult_${idx}">${t('receiving.warehouseResult')}</label>
          <select id="warehouseResult_${idx}"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            data-field="warehouseResult" data-idx="${idx}">
            <option value="" ${!r.warehouseResult ? 'selected' : ''}>${t('receiving.resultNone')}</option>
            <option value="passed" ${r.warehouseResult === 'passed' ? 'selected' : ''}>${t('receiving.resultPassed')}</option>
            <option value="failed" ${r.warehouseResult === 'failed' ? 'selected' : ''}>${t('receiving.resultFailed')}</option>
            <option value="partial" ${r.warehouseResult === 'partial' ? 'selected' : ''}>${t('receiving.resultPartial')}</option>
          </select>
        </div>

        <!-- Recipient (autocomplete from recipients module) -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="recipient_${idx}">${t('receiving.recipient')}</label>
          <input id="recipient_${idx}" type="text" list="receivingRecipientList"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            placeholder="${t('receiving.recipientPlaceholder')}"
            value="${escHtml(recipientName)}"
            data-field="recipientName" data-idx="${idx}">
        </div>

        <!-- Recipient Result -->
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
            for="recipientResult_${idx}">${t('receiving.recipientResult')}</label>
          <select id="recipientResult_${idx}"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            data-field="recipientResult" data-idx="${idx}">
            <option value="" ${!r.recipientResult ? 'selected' : ''}>${t('receiving.resultNone')}</option>
            <option value="passed" ${r.recipientResult === 'passed' ? 'selected' : ''}>${t('receiving.resultPassed')}</option>
            <option value="failed" ${r.recipientResult === 'failed' ? 'selected' : ''}>${t('receiving.resultFailed')}</option>
            <option value="partial" ${r.recipientResult === 'partial' ? 'selected' : ''}>${t('receiving.resultPartial')}</option>
          </select>
        </div>

      </div>

      <!-- Shipping status (read-only, driven by delivery acts) -->
      <div class="mt-3 flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.03] px-4 py-3">
        <span class="text-xs font-semibold uppercase tracking-wider text-slate-500">${t('receiving.shippingAllowed')}</span>
        ${r.shippingAllowed
          ? `<span class="ml-auto text-xs font-semibold text-green-400 bg-green-400/10 rounded-lg px-2 py-0.5">✓ ${t('receiving.shippingAllowedYes')}</span>`
          : `<span class="ml-auto text-xs font-semibold text-red-400 bg-red-400/10 rounded-lg px-2 py-0.5">✕ ${t('receiving.shippingAllowedNo')}</span>`}
        <span class="text-[10px] text-slate-600 ml-1">${t('receiving.shippingSourceAct')}</span>
      </div>

      <div class="mt-4 flex justify-end">
        <button type="button"
          class="save-item-btn inline-flex items-center gap-2 rounded-xl bg-cyan-400/10 border border-cyan-400/20 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-400/20 active:scale-[0.97]"
          data-idx="${idx}">
          ✓ ${t('receiving.saveItem')}
        </button>
      </div>
    </div>
  `;
}

// ─── Wire save button ─────────────────────────────────────────────

function wireItemCard(wrap, contract, item, idx) {
  const saveBtn = wrap.querySelector(`.save-item-btn[data-idx="${idx}"]`);
  if (saveBtn) {
    saveBtn.addEventListener('click', async () => {
      await saveItemReceiving(wrap, contract, item, idx);
    });
  }
}

async function saveItemReceiving(wrap, contract, item, idx) {
  const fields = ['soDeadline', 'soResult', 'warehouseDeadline', 'warehouseResult', 'recipientResult'];
  const receiving = { ...(item.receiving || {}) };

  fields.forEach(field => {
    const el = wrap.querySelector(`[data-field="${field}"][data-idx="${idx}"]`);
    if (el) receiving[field] = el.value;
  });

  // Note: shippingAllowed is now read-only (set by delivery acts sync), not saved here.

  // Recipient: resolve name → id
  const recipientInput = wrap.querySelector(`[data-field="recipientName"][data-idx="${idx}"]`);
  if (recipientInput) {
    const name = recipientInput.value.trim();
    const found = state.recipients.find(r => r.name === name);
    receiving.recipientId = found ? found.id : null;
    receiving.recipientName = name;
  }

  // Save directly on the original item reference (works because item is a reference into contract.items)
  item.receiving = receiving;

  await saveToStorage();
  showToast(t('receiving.saved'), 'success');

  // Visual feedback on button
  const saveBtn = wrap.querySelector(`.save-item-btn[data-idx="${idx}"]`);
  if (saveBtn) {
    const orig = saveBtn.innerHTML;
    saveBtn.innerHTML = `✓ ${t('receiving.savedOk')}`;
    saveBtn.classList.add('bg-cyan-400/30');
    setTimeout(() => {
      saveBtn.innerHTML = orig;
      saveBtn.classList.remove('bg-cyan-400/30');
    }, 1800);
  }
}

// ─── Commission block ─────────────────────────────────────────────

/**
 * Renders the «Комиссия» block inside the receiving list panel.
 * The block is appended to #receivingCommissionWrap (must exist in HTML).
 */
export function renderCommissionBlock() {
  const wrap = document.getElementById('receivingCommissionWrap');
  if (!wrap) return;

  const members = state.commission || [];
  const inputCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

  wrap.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-white/10 receiving-table-wrap">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-white/[0.04] border-b border-white/10">
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-1/2">${t('commission.fieldRole')}</th>
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-1/2">${t('commission.fieldName')}</th>
            <th class="w-10"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/5" id="commissionTableBody">
          ${members.length === 0
            ? `<tr><td colspan="3" class="px-4 py-4 text-xs text-slate-500 text-center">${t('commission.empty')}</td></tr>`
            : members.map((m, i) => `
              <tr data-member-id="${m.id}">
                <td class="px-2 py-1.5">
                  <input type="text" class="${inputCls} comm-role-inp"
                    placeholder="${t('commission.fieldRole')}"
                    value="${escHtml(m.role)}" data-id="${m.id}">
                </td>
                <td class="px-2 py-1.5">
                  <input type="text" class="${inputCls} comm-name-inp"
                    placeholder="${t('commission.fieldName')}"
                    value="${escHtml(m.name)}" data-id="${m.id}">
                </td>
                <td class="px-2 py-1.5 text-center">
                  <button class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500
                    hover:text-red-400 hover:bg-red-400/10 transition comm-del-btn mx-auto"
                    data-id="${m.id}" aria-label="${t('actions.delete')}">✕</button>
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <button id="commAddBtn" type="button"
        class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed
          border-white/20 bg-white/[0.03] px-3 py-2 text-xs font-medium text-slate-400 transition
          hover:border-cyan-400/30 hover:text-cyan-400 hover:bg-cyan-400/5">
        <span aria-hidden="true">＋</span> ${t('commission.add')}
      </button>
      <button id="commSaveBtn" type="button"
        class="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/10 border border-cyan-400/20
          px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-400/20 active:scale-[0.97]">
        ✓ ${t('commission.save')}
      </button>
    </div>`;

  // Add member
  document.getElementById('commAddBtn')?.addEventListener('click', () => {
    addCommissionMember('', '');
    renderCommissionBlock();
  });

  // Save all
  document.getElementById('commSaveBtn')?.addEventListener('click', async () => {
    _saveCommissionFromDOM(wrap);
    await saveToStorage();
    showToast(t('commission.saved'), 'success');
    renderCommissionBlock();
  });

  // Delete member
  wrap.querySelectorAll('.comm-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      removeCommissionMember(id);
      await saveToStorage();
      renderCommissionBlock();
    });
  });
}

/** Update badge showing commission member count */
function updateCommissionBadge() {
  const badge = document.getElementById('commissionCountBadge');
  if (!badge) return;
  const count = (state.commission || []).length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

export function renderInvitedExpertsBlock() {
  const wrap = document.getElementById('receivingInvitedExpertsWrap');
  if (!wrap) return;

  const experts = state.invitedExperts || [];
  const inputCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';
  const fieldRole = t('experts.fieldRole') !== 'experts.fieldRole' ? t('experts.fieldRole') : 'Должность';
  const fieldOrganization = t('experts.fieldOrganization') !== 'experts.fieldOrganization' ? t('experts.fieldOrganization') : 'Организация';
  const fieldName = t('experts.fieldName') !== 'experts.fieldName' ? t('experts.fieldName') : 'ФИО';
  const expertsEmpty = t('experts.empty') !== 'experts.empty' ? t('experts.empty') : 'Список экспертов пока пуст';
  const expertsAdd = t('experts.add') !== 'experts.add' ? t('experts.add') : 'Добавить эксперта';
  const expertsSave = t('experts.save') !== 'experts.save' ? t('experts.save') : 'Сохранить экспертов';
  const expertsSaved = t('experts.saved') !== 'experts.saved' ? t('experts.saved') : 'Список экспертов сохранён';

  wrap.innerHTML = `
    <div class="overflow-x-auto rounded-xl border border-white/10 receiving-table-wrap">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-white/[0.04] border-b border-white/10">
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[28%]">${fieldRole}</th>
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[32%]">${fieldOrganization}</th>
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[32%]">${fieldName}</th>
            <th class="w-10"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/5">
          ${experts.length === 0
            ? `<tr><td colspan="4" class="px-4 py-4 text-xs text-slate-500 text-center">${expertsEmpty}</td></tr>`
            : experts.map(expert => `
              <tr data-expert-id="${expert.id}">
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} expert-role-inp" placeholder="${fieldRole}" value="${escHtml(expert.role)}" data-id="${expert.id}"></td>
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} expert-org-inp" placeholder="${fieldOrganization}" value="${escHtml(expert.organization)}" data-id="${expert.id}"></td>
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} expert-name-inp" placeholder="${fieldName}" value="${escHtml(expert.name)}" data-id="${expert.id}"></td>
                <td class="px-2 py-1.5 text-center">
                  <button class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition expert-del-btn mx-auto" data-id="${expert.id}" aria-label="${t('actions.delete')}">✕</button>
                </td>
              </tr>`).join('')
          }
        </tbody>
      </table>
    </div>
    <div class="mt-2 flex items-center gap-2">
      <button id="expertAddBtn" type="button"
        class="flex-1 inline-flex items-center justify-center gap-1.5 rounded-xl border border-dashed border-white/20 bg-white/[0.03] px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-cyan-400/30 hover:text-cyan-400 hover:bg-cyan-400/5">
        <span aria-hidden="true">＋</span> ${expertsAdd}
      </button>
      <button id="expertSaveBtn" type="button"
        class="inline-flex items-center gap-1.5 rounded-xl bg-cyan-400/10 border border-cyan-400/20 px-4 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-400/20 active:scale-[0.97]">
        ✓ ${expertsSave}
      </button>
    </div>`;

  document.getElementById('expertAddBtn')?.addEventListener('click', () => {
    addInvitedExpert('', '', '');
    renderInvitedExpertsBlock();
  });

  document.getElementById('expertSaveBtn')?.addEventListener('click', async () => {
    _saveInvitedExpertsFromDOM(wrap);
    await saveToStorage();
    showToast(expertsSaved, 'success');
    renderInvitedExpertsBlock();
  });

  wrap.querySelectorAll('.expert-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id);
      removeInvitedExpert(id);
      await saveToStorage();
      renderInvitedExpertsBlock();
    });
  });

  updateInvitedExpertsBadge();
}

function updateInvitedExpertsBadge() {
  const badge = document.getElementById('invitedExpertsCountBadge');
  if (!badge) return;
  const count = (state.invitedExperts || []).length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function tr(key, fallback, vals) {
  const value = t(key, vals);
  return value && value !== key ? value : fallback;
}

function ensureInspectionScheduleMount() {
  document.getElementById('inspectionScheduleToggleBtn')?.closest('.mb-4')?.remove();
}

function ensureInspectionScheduleModal() {
  if (document.getElementById('inspectionScheduleModal')) return;
  const overlay = document.createElement('div');
  overlay.id = 'inspectionScheduleModal';
  overlay.className = 'modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'inspectionScheduleModalTitle');
  overlay.innerHTML = `
    <div class="hidden catalog-panel w-full h-full flex flex-col bg-slate-950 overflow-hidden">
      <div class="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10 bg-slate-950/80 backdrop-blur-sm shrink-0">
        <div class="flex items-center gap-3">
          <button id="inspectionScheduleModalCloseBtn" type="button" class="rounded-xl p-2 text-slate-400 hover:bg-white/10 hover:text-white transition" aria-label="Назад">
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 10H5M8 6l-4 4 4 4"/></svg>
          </button>
          <div>
            <p class="text-xs font-semibold uppercase tracking-wider text-cyan-400">${tr('receiving.title', 'Приёмка')}</p>
            <h2 id="inspectionScheduleModalTitle" class="text-lg font-bold text-white">${tr('receivingSchedule.title', 'График проверок')}</h2>
          </div>
        </div>
        <div class="flex items-center gap-2 flex-wrap justify-end receiving-modal-actions">
          <button id="inspectionSchedulePrintBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-white/10 hover:border-cyan-400/30">
            <span aria-hidden="true">🖨️</span>
            <span>Печать</span>
          </button>
          <button id="inspectionScheduleExportBtn" type="button" class="inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-semibold text-slate-100 transition hover:bg-white/10 hover:border-cyan-400/30">
            <span aria-hidden="true">📊</span>
            <span>${tr('actions.exportExcel', 'Экспорт в Excel')}</span>
          </button>
          <button id="inspectionScheduleAddBtn" type="button" class="inline-flex items-center gap-2 rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300 active:scale-[0.97]">
            <span aria-hidden="true">＋</span>
            <span>${tr('receivingSchedule.addRow', 'Добавить строку')}</span>
          </button>
        </div>
      </div>
      <div class="px-4 sm:px-6 py-3 border-b border-white/10 bg-slate-950/50 shrink-0">
        <p class="text-xs text-slate-500">${tr('receivingSchedule.hint', 'Пользователь заполняет график, а результаты акта проверки автоматически возвращаются в эту строку.')}</p>
      </div>
      <div id="receivingInspectionScheduleWrap" class="flex-1 overflow-auto px-4 sm:px-6 py-4 receiving-schedule-wrap"></div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeInspectionScheduleModal();
  });
}

function openInspectionScheduleModal() {
  ensureInspectionScheduleModal();
  const overlay = document.getElementById('inspectionScheduleModal');
  if (!overlay) return;
  _inspectionScheduleModalOpen = true;
  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');
  overlay.classList.add('open');
  renderInspectionScheduleBlock();
}

function closeInspectionScheduleModal() {
  const overlay = document.getElementById('inspectionScheduleModal');
  if (!overlay) return;
  _inspectionScheduleModalOpen = false;
  overlay.classList.remove('open');
  overlay.querySelector('.catalog-panel')?.classList.add('hidden');
}

function getScheduleContractDisplay(contract) {
  if (!contract) return '';
  return [contract.number ? `№ ${contract.number}` : '', contract.title || '']
    .filter(Boolean)
    .join(' — ');
}

function resolveScheduleContract(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  const contracts = state.contracts || [];
  return contracts.find(contract => {
    const number = String(contract.number || '').toLowerCase();
    const title = String(contract.title || '').toLowerCase();
    const full = getScheduleContractDisplay(contract).toLowerCase();
    return number === needle || full === needle || (number && number.includes(needle)) || (title && title.includes(needle));
  }) || null;
}

function resolveScheduleRecipient(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return (state.recipients || []).find(item => String(item.name || '').trim().toLowerCase() === needle)
    || (state.recipients || []).find(item => String(item.name || '').trim().toLowerCase().includes(needle))
    || null;
}

function resolveScheduleExpert(value) {
  const needle = String(value || '').trim().toLowerCase();
  if (!needle) return null;
  return (state.commission || []).find(item => String(item.name || '').trim().toLowerCase() === needle)
    || (state.commission || []).find(item => String(item.name || '').trim().toLowerCase().includes(needle))
    || null;
}

function renderPredictiveInput({ id, value, listId, placeholder, options, className = '', disabled = false }) {
  return `
    <input id="${id}" type="text" list="${listId}" value="${escHtml(value || '')}" placeholder="${escHtml(placeholder || '')}"
      class="${className || 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white'}" ${disabled ? 'disabled' : ''}>
    <datalist id="${listId}">
      ${options.map(option => `<option value="${escHtml(option)}"></option>`).join('')}
    </datalist>`;
}

function renderAddressInput({ id, value, options, className = '', disabled = false }) {
  const listId = `${id}_list`;
  const normalized = String(value || '').trim();
  const values = normalized && !options.includes(normalized) ? [...options, normalized] : options;
  return `
    <input id="${id}" type="text" list="${listId}" value="${escHtml(value || '')}" placeholder="${escHtml(tr('receivingSchedule.addressPlaceholder', 'Адрес проверки'))}"
      class="${className || 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white'}" ${disabled ? 'disabled' : ''}>
    <datalist id="${listId}">
      ${values.map(option => `<option value="${escHtml(option)}"></option>`).join('')}
    </datalist>`;
}

function renderExpertsMultiSelect(entry, options) {
  const experts = getScheduleExperts(entry);
  return `
    <div class="space-y-2">
      <div class="flex gap-2 items-start">
        ${renderPredictiveInput({
          id: `sched_expert_${entry.id}`,
          value: '',
          listId: `sched_expert_list_${entry.id}`,
          placeholder: tr('receivingSchedule.selectExpert', 'Выберите эксперта'),
          options,
          className: 'sched-expert-input w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white'
        })}
        <button type="button" class="sched-expert-add shrink-0 inline-flex items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-[11px] font-semibold text-cyan-300 transition hover:bg-cyan-400/20" data-id="${entry.id}">＋</button>
      </div>
      <div class="flex flex-wrap gap-1.5">
        ${experts.length
          ? experts.map((expert, index) => `<span class="inline-flex items-center gap-1 rounded-lg bg-cyan-400/10 px-2 py-1 text-[10px] font-semibold text-cyan-200"><span>${escHtml(expert.name || 'Эксперт')}</span><button type="button" class="sched-expert-remove text-cyan-300 hover:text-white transition" data-id="${entry.id}" data-idx="${index}" aria-label="Удалить эксперта">✕</button></span>`).join('')
          : `<span class="text-[10px] text-slate-500">${escHtml(tr('receivingSchedule.expertsEmpty', 'Эксперты не выбраны'))}</span>`}
      </div>
    </div>`;
}

function normalizeScheduleSearch(value) {
  return String(value || '').trim().toLowerCase();
}

function entryMatchesInspectionFilters(entry) {
  const contractNeedle = normalizeScheduleSearch(_inspectionScheduleFilters.contract);
  const recipientNeedle = normalizeScheduleSearch(_inspectionScheduleFilters.recipient);
  const expertNeedle = normalizeScheduleSearch(_inspectionScheduleFilters.expert);
  const statusNeedle = normalizeScheduleSearch(_inspectionScheduleFilters.status);
  const inspectionTypeNeedle = normalizeInspectionType(_inspectionScheduleFilters.inspectionType || '');

  if (_inspectionScheduleFilters.inspectionType) {
    if (normalizeInspectionType(entry.inspectionType) !== inspectionTypeNeedle) return false;
  }

  if (contractNeedle) {
    const haystack = [entry.contractNumber, entry.contractTitle, entry.supplierName].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(contractNeedle)) return false;
  }
  if (recipientNeedle) {
    const haystack = [entry.recipientName, entry.address].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(recipientNeedle)) return false;
  }
  if (expertNeedle) {
    const haystack = String(entry.expertName || '').toLowerCase();
    if (!haystack.includes(expertNeedle)) return false;
  }
  if (statusNeedle) {
    const haystack = String(entry.acceptanceStatus || '').toLowerCase();
    if (!haystack.includes(statusNeedle)) return false;
  }
  return true;
}

function openInspectionSchedulePrint() {
  const schedules = [...(state.inspectionSchedules || [])]
    .filter(entryMatchesInspectionFilters)
    .sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`));

  const rowsHtml = schedules.map((entry, index) => `
    <tr>
      <td>${index + 1}</td>
      <td>${escHtml(entry.date || '')}</td>
      <td>${escHtml(normalizeScheduleTime(entry.time) || '')}</td>
      <td>${escHtml(getInspectionTypeLabel(entry.inspectionType))}</td>
      <td>${escHtml(entry.contractNumber || '')}</td>
      <td>${escHtml(entry.contractTitle || '')}</td>
      <td>${escHtml(entry.supplierName || '')}</td>
      <td>${escHtml(entry.recipientName || '')}</td>
      <td>${escHtml(entry.address || '')}</td>
      <td>${escHtml(entry.recipientRepresentative || '')}</td>
      <td>${escHtml(getScheduleExperts(entry).map(expert => expert.name).filter(Boolean).join(', '))}</td>
      <td>${escHtml(entry.acceptanceStatus || '')}</td>
      <td>${escHtml(entry.correctionDeadline || '')}</td>
      <td>${escHtml(entry.shortResult || '')}</td>
    </tr>`).join('');

  const html = `<!doctype html>
  <html lang="ru">
  <head>
    <meta charset="utf-8">
    <title>График проверок</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 24px; color: #111827; }
      h1 { margin: 0 0 6px; font-size: 22px; }
      .meta { margin: 0 0 18px; font-size: 12px; color: #4b5563; }
      table { width: 100%; border-collapse: collapse; font-size: 11px; }
      th, td { border: 1px solid #9ca3af; padding: 6px 8px; vertical-align: top; }
      th { background: #e5e7eb; text-align: left; }
      @media print { body { margin: 10mm; } }
    </style>
  </head>
  <body>
    <h1>График проверок</h1>
    <p class="meta">Модуль «Приёмка». Дата печати: ${new Date().toLocaleString('ru-RU')}</p>
    <table>
      <thead>
        <tr>
          <th>№</th>
          <th>Дата</th>
          <th>Время</th>
          <th>Вид проверки</th>
          <th>Номер контракта</th>
          <th>Наименование контракта</th>
          <th>Поставщик</th>
          <th>Получатель</th>
          <th>Адрес</th>
          <th>Представитель ОО</th>
          <th>Эксперты</th>
          <th>Статус приёмки</th>
          <th>Срок устранения</th>
          <th>Результаты</th>
        </tr>
      </thead>
      <tbody>${rowsHtml || '<tr><td colspan="14">Нет данных</td></tr>'}</tbody>
    </table>
    <script>window.onload = () => { window.print(); };</script>
  </body>
  </html>`;

  const printWindow = window.open('', '_blank', 'width=1200,height=800');
  if (!printWindow) {
    showToast('Не удалось открыть окно печати', 'error');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

function updateInspectionScheduleBadge() {
  const badge = document.getElementById('inspectionScheduleCountBadge');
  if (!badge) return;
  const count = (state.inspectionSchedules || []).length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

function applyContractToSchedule(entry, contractId) {
  const contract = (state.contracts || []).find(item => Number(item.id) === Number(contractId)) || null;
  entry.contractId = contract ? contract.id : null;
  entry.contractDate = contract?.date || '';
  entry.contractNumber = contract?.number || '';
  entry.contractTitle = contract?.title || '';
  entry.supplierId = contract?.supplierId ?? null;
  entry.supplierName = contract?.supplierId
    ? ((state.suppliers || []).find(item => item.id === contract.supplierId)?.name || '')
    : '';
}

function applyRecipientToSchedule(entry, recipientId) {
  const recipient = (state.recipients || []).find(item => Number(item.id) === Number(recipientId)) || null;
  entry.recipientId = recipient ? recipient.id : null;
  entry.recipientName = recipient?.name || '';
  const addresses = recipient ? getRecipientAddresses(recipient) : [];
  if (!addresses.includes(entry.address || '')) entry.address = addresses[0] || '';
}

function applyExpertToSchedule(entry, expertId) {
  const expert = (state.commission || []).find(item => Number(item.id) === Number(expertId)) || null;
  entry.expertId = expert ? expert.id : null;
  entry.expertName = expert?.name || '';
}

async function exportInspectionScheduleToExcel() {
  const XLSX = await loadXLSX();
  if (!XLSX) throw new Error(tr('orders.excelLibMissing', 'Библиотека Excel не загружена'));

  const rows = [...(state.inspectionSchedules || [])]
    .sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`))
    .map((entry, index) => ([
      index + 1,
      entry.date || '',
      normalizeScheduleTime(entry.time) || '',
      getInspectionTypeLabel(entry.inspectionType),
      entry.supplierName || '',
      entry.contractDate || '',
      entry.contractNumber || '',
      entry.contractTitle || '',
      entry.recipientName || '',
      entry.address || '',
      entry.recipientRepresentative || '',
      getScheduleExperts(entry).map(expert => expert.name).filter(Boolean).join(', '),
      entry.supplierNoticeDate || '',
      entry.supplierNoticeNumber || '',
      entry.note || '',
      entry.contractOwner || '',
      entry.acceptanceStatus || '',
      entry.correctionDeadline || '',
      entry.shortResult || '',
      entry.incorrectTz || '',
    ]));

  const generatedAt = new Date();
  const aoa = [
    [tr('receivingSchedule.title', 'График проверок')],
    ['Модуль «Приёмка»'],
    [`Дата выгрузки: ${generatedAt.toLocaleDateString('ru-RU')} ${generatedAt.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`],
    [],
    [
      '№',
      tr('receivingSchedule.fieldDate', 'Дата'),
      tr('receivingSchedule.fieldTime', 'Время'),
      tr('receivingSchedule.fieldInspectionType', 'Вид проверки'),
      tr('receivingSchedule.fieldSupplier', 'Поставщик'),
      tr('receivingSchedule.fieldContractDate', 'Дата контракта'),
      tr('receivingSchedule.fieldContractNumber', 'Номер контракта'),
      tr('receivingSchedule.fieldContractTitle', 'Наименование контракта'),
      tr('receivingSchedule.fieldRecipient', 'Получатель'),
      tr('receivingSchedule.fieldAddress', 'Адрес'),
      tr('receivingSchedule.fieldRecipientRepresentative', 'Представитель ОО'),
      tr('receivingSchedule.fieldExpert', 'Эксперт'),
      tr('receivingSchedule.fieldNoticeDate', 'Дата уведомления поставщика'),
      tr('receivingSchedule.fieldNoticeNumber', 'Номер уведомления поставщика'),
      tr('receivingSchedule.fieldNote', 'Примечание'),
      tr('receivingSchedule.fieldContractOwner', 'Ответственный за контракт'),
      tr('receivingSchedule.fieldAcceptanceStatus', 'Статус приёмки'),
      tr('receivingSchedule.fieldCorrectionDeadline', 'Срок устранения нарушений'),
      tr('receivingSchedule.fieldShortResult', 'Результаты (коротко)'),
      tr('receivingSchedule.fieldIncorrectTz', 'Некорректное ТЗ'),
    ],
    ...(rows.length ? rows : [['', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '']]),
  ];

  const worksheet = XLSX.utils.aoa_to_sheet(aoa);
  worksheet['!merges'] = [
    XLSX.utils.decode_range('A1:T1'),
    XLSX.utils.decode_range('A2:T2'),
    XLSX.utils.decode_range('A3:T3'),
  ];
  worksheet['!cols'] = [
    { wch: 6 }, { wch: 12 }, { wch: 10 }, { wch: 28 }, { wch: 28 }, { wch: 16 },
    { wch: 18 }, { wch: 34 }, { wch: 28 }, { wch: 34 }, { wch: 24 }, { wch: 24 },
    { wch: 26 }, { wch: 18 }, { wch: 24 }, { wch: 22 }, { wch: 24 }, { wch: 24 }, { wch: 36 }, { wch: 44 },
  ];
  worksheet['!rows'] = [
    { hpt: 24 },
    { hpt: 20 },
    { hpt: 20 },
    { hpt: 8 },
    { hpt: 42 },
  ];
  worksheet['!autofilter'] = { ref: `A5:T${aoa.length}` };

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'График проверок');
  XLSX.writeFile(workbook, `inspection-schedule-${new Date().toISOString().slice(0, 10)}.xlsx`);
  showToast(tr('toast.exported', 'Файл экспортирован'), 'success');
}

function getScheduleStatusTone(status, isRepeat = false) {
  if (isRepeat) return 'bg-sky-500/15 text-sky-300';
  const value = String(status || '').toLowerCase();
  if (!value) return 'bg-white/5 text-slate-400';
  if (value.includes('принято с замечаниями')) return 'bg-amber-500/15 text-amber-300';
  if (value.includes('принято')) return 'bg-emerald-500/15 text-emerald-400';
  if (value.includes('непринято') || value.includes('не принято') || value.includes('замеч') || value.includes('непостав')) return 'bg-red-500/15 text-red-300';
  if (value.includes('план')) return 'bg-cyan-500/15 text-cyan-300';
  return 'bg-slate-500/15 text-slate-300';
}

function isNewInspectionScheduleEntry(entry) {
  return _newInspectionScheduleIds.has(String(entry?.id || ''));
}

function isEditingInspectionScheduleEntry(entry) {
  return _editingInspectionScheduleIds.has(String(entry?.id || ''));
}

function isManualRepeatInspectionEntry(entry) {
  return !!entry?.repeatInspection;
}

function rerenderInspectionSchedulePreservingViewport(focusSelector = '') {
  const wrap = document.getElementById('receivingInspectionScheduleWrap');
  const scrollTop = wrap?.scrollTop || 0;
  const scrollLeft = wrap?.scrollLeft || 0;
  renderInspectionScheduleBlock();
  requestAnimationFrame(() => {
    const nextWrap = document.getElementById('receivingInspectionScheduleWrap');
    if (nextWrap) {
      nextWrap.scrollTop = scrollTop;
      nextWrap.scrollLeft = scrollLeft;
    }
    if (focusSelector) {
      const focusEl = document.querySelector(focusSelector);
      if (focusEl) {
        focusEl.focus();
        if (typeof focusEl.selectionStart === 'number' && typeof focusEl.value === 'string') {
          const end = focusEl.value.length;
          focusEl.setSelectionRange(end, end);
        }
      }
    }
  });
}

function getScheduleSummary(entry) {
  const date = entry.date ? entry.date.split('-').reverse().join('.') : '—';
  const time = entry.time || '—';
  const contractLabel = entry.contractNumber || tr('contracts.noNumber', 'Без номера');
  const recipient = entry.recipientName || '—';
  return `${date} · ${time} · ${contractLabel} · ${recipient}`;
}

function replaceAddressOptions(row, entry) {
  const addressInput = row?.querySelector('.sched-address-input');
  if (!addressInput) return;
  const recipient = (state.recipients || []).find(item => Number(item.id) === Number(entry.recipientId));
  const addresses = recipient ? getRecipientAddresses(recipient) : [];
  if (!entry.address && addresses.length) {
    entry.address = addresses[0];
  }
  addressInput.value = entry.address || '';
  const listId = addressInput.getAttribute('list');
  const datalist = listId ? document.getElementById(listId) : null;
  if (datalist) {
    const values = entry.address && !addresses.includes(entry.address) ? [...addresses, entry.address] : addresses;
    datalist.innerHTML = values.map(address => `<option value="${escHtml(address)}"></option>`).join('');
  }
}

function updateContractCells(row, entry) {
  const fields = {
    contractDate: entry.contractDate || '—',
    contractNumber: entry.contractNumber || '—',
    contractTitle: entry.contractTitle || '—',
    supplierName: entry.supplierName || '—',
  };
  Object.entries(fields).forEach(([field, value]) => {
    const cell = row?.querySelector(`[data-display="${field}"]`);
    if (cell) cell.textContent = value;
  });
}

export function renderInspectionScheduleBlock() {
  updateInspectionScheduleBadge();
  const wrap = document.getElementById('receivingInspectionScheduleWrap');
  if (!wrap) return;

  const allSchedules = sortInspectionScheduleEntries((state.inspectionSchedules || [])
    .map(entry => {
      if (!entry.inspectionType) entry.inspectionType = 'delivery';
      return entry;
    }));
  const schedules = allSchedules.filter(entryMatchesInspectionFilters);
  const contracts = state.contracts || [];
  const recipients = state.recipients || [];
  const experts = state.commission || [];
  const contractFilterOptions = contracts.map(getScheduleContractDisplay).filter(Boolean);
  const recipientFilterOptions = recipients.map(recipient => recipient.name).filter(Boolean);
  const expertFilterOptions = experts.map(expert => expert.name || expert.role || '').filter(Boolean);
  const inspectionTypeOptions = [
    ['', 'Все виды проверок'],
    ['so', tr('receivingSchedule.inspectionTypeSo', 'Проверка сигнального образца')],
    ['delivery', tr('receivingSchedule.inspectionTypeDelivery', 'Проверка поставленного товара')],
  ];
  const statusOptions = getScheduleAcceptanceStatusOptions();

  wrap.innerHTML = `
    <div class="mb-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
      <div class="inspection-schedule-filters-grid">
        <label class="flex flex-col gap-1.5 text-xs text-slate-400">
          <span>Контракт / поставщик</span>
          <input id="inspectionScheduleFilterContract" type="text" list="inspectionScheduleFilterContractOptions" value="${escHtml(_inspectionScheduleFilters.contract)}" placeholder="Номер, контракт или поставщик"
            class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
          <datalist id="inspectionScheduleFilterContractOptions">${contractFilterOptions.map(option => `<option value="${escHtml(option)}"></option>`).join('')}</datalist>
        </label>
        <label class="flex flex-col gap-1.5 text-xs text-slate-400">
          <span>Получатель / адрес</span>
          <input id="inspectionScheduleFilterRecipient" type="text" list="inspectionScheduleFilterRecipientOptions" value="${escHtml(_inspectionScheduleFilters.recipient)}" placeholder="Получатель или адрес"
            class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
          <datalist id="inspectionScheduleFilterRecipientOptions">${recipientFilterOptions.map(option => `<option value="${escHtml(option)}"></option>`).join('')}</datalist>
        </label>
        <label class="flex flex-col gap-1.5 text-xs text-slate-400">
          <span>Эксперт</span>
          <input id="inspectionScheduleFilterExpert" type="text" list="inspectionScheduleFilterExpertOptions" value="${escHtml(_inspectionScheduleFilters.expert)}" placeholder="ФИО эксперта"
            class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
          <datalist id="inspectionScheduleFilterExpertOptions">${expertFilterOptions.map(option => `<option value="${escHtml(option)}"></option>`).join('')}</datalist>
        </label>
        <label class="flex flex-col gap-1.5 text-xs text-slate-400">
          <span>Статус</span>
          <select id="inspectionScheduleFilterStatus" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
            <option value="">Все статусы</option>
            ${statusOptions.filter(([value]) => value).map(([value, label]) => `<option value="${escHtml(value)}" ${String(_inspectionScheduleFilters.status) === String(value) ? 'selected' : ''}>${escHtml(label)}</option>`).join('')}
          </select>
        </label>
        <label class="flex flex-col gap-1.5 text-xs text-slate-400">
          <span>${tr('receivingSchedule.fieldInspectionType', 'Вид проверки')}</span>
          <select id="inspectionScheduleFilterType" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
            ${inspectionTypeOptions.map(([value, label]) => `<option value="${escHtml(value)}" ${String(_inspectionScheduleFilters.inspectionType || '') === String(value) ? 'selected' : ''}>${escHtml(label)}</option>`).join('')}
          </select>
        </label>
      </div>
      <div class="mt-3 flex items-center justify-between gap-3 text-xs text-slate-500">
        <span>Показано строк: <b class="text-slate-200">${schedules.length}</b> из <b class="text-slate-200">${allSchedules.length}</b></span>
        <button id="inspectionScheduleResetFiltersBtn" type="button" class="rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-200 transition hover:bg-white/10">Сбросить фильтры</button>
      </div>
    </div>
    ${allSchedules.length === 0
      ? `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-6 text-center text-xs text-slate-500">${tr('receivingSchedule.empty', 'Строк графика пока нет.')}</div>`
      : schedules.length === 0
        ? `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-6 text-center text-xs text-slate-500">По текущим фильтрам ничего не найдено.</div>`
        : `
      <div class="tbl-scroll bg-slate-950/40 receiving-table-wrap inspection-schedule-table-wrap" style="max-height: calc(100vh - 300px);">
        <table class="w-full min-w-[2280px] border-collapse text-xs text-slate-200 receiving-schedule-table">
          <thead>
            <tr>
              <th class="px-3 py-2 text-left">${tr('actions.confirm', 'Действия')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldDate', 'Дата')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldTime', 'Время')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldInspectionType', 'Вид проверки')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldContract', 'Контракт')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldContractDate', 'Дата контракта')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldContractNumber', 'Номер контракта')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldContractTitle', 'Наименование контракта')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldSupplier', 'Поставщик')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldRecipient', 'Получатель')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldAddress', 'Адрес')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldRecipientRepresentative', 'Представитель ОО')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldExpert', 'Эксперт')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldNoticeDate', 'Дата уведомления поставщика')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldNoticeNumber', 'Номер уведомления поставщика')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldNote', 'Примечание')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldContractOwner', 'Ответственный за контракт')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldAcceptanceStatus', 'Статус приёмки')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldCorrectionDeadline', 'Срок устранения нарушений')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldShortResult', 'Результаты (коротко)')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.fieldIncorrectTz', 'Некорректное ТЗ')}</th>
              <th class="px-3 py-2 text-left">${tr('receivingSchedule.linkedActLabel', 'Связанный акт')}</th>
            </tr>
          </thead>
          <tbody>
            ${schedules.map(entry => {
              const addresses = entry.recipientId
                ? getRecipientAddresses(recipients.find(item => Number(item.id) === Number(entry.recipientId)))
                : [];
              const linkedAct = entry.linkedActId ? (state.acts || []).find(act => Number(act.id) === Number(entry.linkedActId)) : null;
              const contractValue = entry.contractId
                ? getScheduleContractDisplay(contracts.find(contract => Number(contract.id) === Number(entry.contractId)))
                : (entry.contractNumber || '');
              const contractOptions = contracts.map(getScheduleContractDisplay).filter(Boolean);
              const recipientOptions = recipients.map(recipient => recipient.name).filter(Boolean);
              const expertOptions = experts.map(expert => expert.name || expert.role || '').filter(Boolean);
              const isRepeat = isManualRepeatInspectionEntry(entry);
              const isNew = isNewInspectionScheduleEntry(entry);
              const isEditing = isNew || isEditingInspectionScheduleEntry(entry);
              const readOnlyAttrs = isEditing ? '' : 'disabled';
              const statusTone = getScheduleStatusTone(entry.acceptanceStatus, isRepeat);
              return `
                <tr class="align-top border-b border-white/5 ${isNew ? 'bg-amber-500/[0.09]' : ''}" data-schedule-row-id="${entry.id}">
                  <td class="px-2 py-2 min-w-[120px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">
                    <div class="flex items-center gap-1.5">
                      ${isEditing
                        ? `<button type="button" class="sched-save-btn inline-flex h-8 w-8 items-center justify-center rounded-lg border border-cyan-400/20 bg-cyan-400/10 text-sm text-cyan-300 transition hover:bg-cyan-400/20" data-id="${entry.id}" title="${escHtml(tr('actions.save', 'Сохранить'))}" aria-label="${escHtml(tr('actions.save', 'Сохранить'))}">💾</button>`
                        : `<button type="button" class="sched-edit-btn inline-flex h-8 w-8 items-center justify-center rounded-lg border border-white/15 bg-white/5 text-sm text-slate-200 transition hover:bg-white/10" data-id="${entry.id}" title="${escHtml(tr('actions.edit', 'Редактировать'))}" aria-label="${escHtml(tr('actions.edit', 'Редактировать'))}">✏️</button>`}
                      <button type="button" class="sched-delete-btn inline-flex h-8 w-8 items-center justify-center rounded-lg border border-red-400/20 bg-red-400/10 text-sm text-red-300 transition hover:bg-red-400/20" data-id="${entry.id}" title="${escHtml(tr('actions.delete', 'Удалить'))}" aria-label="${escHtml(tr('actions.delete', 'Удалить'))}">🗑️</button>
                    </div>
                    <div class="mt-2 flex flex-col gap-1.5">
                      ${isNew ? `<span class="inline-flex items-center justify-center rounded-lg bg-amber-500/15 px-2 py-1 text-[10px] font-semibold text-amber-200">Новая</span>` : ''}
                      <label class="inline-flex items-center gap-1.5 text-[10px] font-semibold ${isRepeat ? 'text-sky-300' : 'text-slate-400'}">
                        <input type="checkbox" class="sched-repeat-checkbox h-3.5 w-3.5 accent-sky-400" data-id="${entry.id}" ${entry.repeatInspection ? 'checked' : ''} ${readOnlyAttrs}>
                        <span>${escHtml(tr('receivingSchedule.repeatCheckShort', 'Повторная'))}</span>
                      </label>
                    </div>
                  </td>
                  <td class="px-2 py-2 ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="date" class="sched-field w-[135px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="date" value="${escHtml(entry.date || '')}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 min-w-[120px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><select class="sched-time-select w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" ${readOnlyAttrs}>${buildQuarterHourOptions(entry.time)}</select></td>
                  <td class="px-2 py-2 min-w-[220px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><select id="sched_type_${entry.id}" class="sched-inspection-type w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" ${readOnlyAttrs}>${getInspectionTypeOptions(entry.inspectionType)}</select></td>
                  <td class="px-2 py-2 min-w-[240px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">${renderPredictiveInput({ id: `sched_contract_${entry.id}`, value: contractValue, listId: `sched_contract_list_${entry.id}`, placeholder: tr('receivingSchedule.selectContract', 'Выберите контракт'), options: contractOptions, className: 'sched-contract-input w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70', disabled: !isEditing })}</td>
                  <td class="px-2 py-2 min-w-[135px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><div data-display="contractDate" class="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 break-words whitespace-normal">${escHtml(entry.contractDate || '—')}</div></td>
                  <td class="px-2 py-2 min-w-[155px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><div data-display="contractNumber" class="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 break-words whitespace-normal">${escHtml(entry.contractNumber || '—')}</div></td>
                  <td class="px-2 py-2 min-w-[240px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><div data-display="contractTitle" class="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 break-words whitespace-normal">${escHtml(entry.contractTitle || '—')}</div></td>
                  <td class="px-2 py-2 min-w-[190px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><div data-display="supplierName" class="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 break-words whitespace-normal">${escHtml(entry.supplierName || '—')}</div></td>
                  <td class="px-2 py-2 min-w-[220px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">${renderPredictiveInput({ id: `sched_recipient_${entry.id}`, value: entry.recipientName || '', listId: `sched_recipient_list_${entry.id}`, placeholder: tr('receivingSchedule.selectRecipient', 'Выберите получателя'), options: recipientOptions, className: 'sched-recipient-input w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70', disabled: !isEditing })}</td>
                  <td class="px-2 py-2 min-w-[260px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">${renderAddressInput({ id: `sched_address_${entry.id}`, value: entry.address || '', options: addresses, className: 'sched-address-input w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70', disabled: !isEditing })}</td>
                  <td class="px-2 py-2 min-w-[180px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="text" class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="recipientRepresentative" value="${escHtml(entry.recipientRepresentative || '')}" placeholder="${escHtml(tr('receivingSchedule.recipientRepresentativePlaceholder', 'ФИО представителя'))}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 min-w-[220px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">${isEditing ? renderExpertsMultiSelect(entry, expertOptions) : `<div class="min-h-[38px] rounded-lg border border-white/10 bg-white/[0.03] px-2 py-2 text-xs text-slate-300 break-words whitespace-normal">${escHtml(getScheduleExperts(entry).map(expert => expert.name).filter(Boolean).join(', ') || '—')}</div>`}</td>
                  <td class="px-2 py-2 ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="date" class="sched-field w-[150px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="supplierNoticeDate" value="${escHtml(entry.supplierNoticeDate || '')}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="text" class="sched-field w-[180px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="supplierNoticeNumber" value="${escHtml(entry.supplierNoticeNumber || '')}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 min-w-[210px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><textarea class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white resize-y break-words disabled:cursor-default disabled:opacity-70" rows="2" data-id="${entry.id}" data-field="note" ${readOnlyAttrs}>${escHtml(entry.note || '')}</textarea></td>
                  <td class="px-2 py-2 min-w-[180px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="text" class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="contractOwner" value="${escHtml(entry.contractOwner || '')}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 min-w-[200px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><select class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="acceptanceStatus" ${readOnlyAttrs}>${statusOptions.map(([value, label]) => `<option value="${escHtml(value)}" ${String(entry.acceptanceStatus || '') === String(value) ? 'selected' : ''}>${escHtml(label)}</option>`).join('')}</select></td>
                  <td class="px-2 py-2 ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><input type="date" class="sched-field w-[150px] rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white disabled:cursor-default disabled:opacity-70" data-id="${entry.id}" data-field="correctionDeadline" value="${escHtml(entry.correctionDeadline || '')}" ${readOnlyAttrs}></td>
                  <td class="px-2 py-2 min-w-[220px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><textarea class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white resize-y break-words disabled:cursor-default disabled:opacity-70" rows="2" data-id="${entry.id}" data-field="shortResult" ${readOnlyAttrs}>${escHtml(entry.shortResult || '')}</textarea></td>
                  <td class="px-2 py-2 min-w-[250px] ${isRepeat ? 'bg-sky-500/[0.12]' : ''}"><textarea class="sched-field w-full min-w-0 rounded-lg border border-white/10 bg-white/5 px-2 py-2 text-xs text-white resize-y break-words disabled:cursor-default disabled:opacity-70" rows="3" data-id="${entry.id}" data-field="incorrectTz" ${readOnlyAttrs}>${escHtml(entry.incorrectTz || '')}</textarea></td>
                  <td class="px-2 py-2 min-w-[180px] break-words whitespace-normal ${isRepeat ? 'bg-sky-500/[0.12]' : ''}">
                    ${linkedAct
                      ? `<div class="mb-2 rounded-lg px-2 py-1 text-[11px] font-semibold ${statusTone}">#${linkedAct.id}</div><button type="button" class="sched-open-act-btn inline-flex items-center gap-1 rounded-lg border border-white/15 bg-white/5 px-2 py-1.5 text-[11px] font-semibold text-slate-200 transition hover:bg-white/10" data-id="${entry.linkedActId}">📄 ${tr('receivingSchedule.openAct', 'Открыть акт')}</button>`
                      : `<span class="text-[11px] text-slate-500">${tr('receivingSchedule.noActLinked', 'Акт проверки пока не привязан')}</span>`}
                  </td>
                </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>`}
  `;

  document.getElementById('inspectionScheduleFilterContract')?.addEventListener('input', e => {
    _inspectionScheduleFilters.contract = e.target.value;
    renderInspectionScheduleBlock();
  });
  document.getElementById('inspectionScheduleFilterRecipient')?.addEventListener('input', e => {
    _inspectionScheduleFilters.recipient = e.target.value;
    renderInspectionScheduleBlock();
  });
  document.getElementById('inspectionScheduleFilterExpert')?.addEventListener('input', e => {
    _inspectionScheduleFilters.expert = e.target.value;
    renderInspectionScheduleBlock();
  });
  document.getElementById('inspectionScheduleFilterStatus')?.addEventListener('change', e => {
    _inspectionScheduleFilters.status = e.target.value;
    renderInspectionScheduleBlock();
  });
  document.getElementById('inspectionScheduleFilterType')?.addEventListener('change', e => {
    _inspectionScheduleFilters.inspectionType = e.target.value;
    renderInspectionScheduleBlock();
  });
  document.getElementById('inspectionScheduleResetFiltersBtn')?.addEventListener('click', () => {
    _inspectionScheduleFilters = { contract: '', recipient: '', expert: '', status: '', inspectionType: '' };
    renderInspectionScheduleBlock();
  });

  enhancePredictiveInput(document.getElementById('inspectionScheduleFilterContract'), {
    listId: 'inspectionScheduleFilterContractOptions',
    options: contractFilterOptions,
    icon: '📝',
    minWidth: '180px',
  });
  enhancePredictiveInput(document.getElementById('inspectionScheduleFilterRecipient'), {
    listId: 'inspectionScheduleFilterRecipientOptions',
    options: recipientFilterOptions,
    icon: '👤',
    minWidth: '180px',
  });
  enhancePredictiveInput(document.getElementById('inspectionScheduleFilterExpert'), {
    listId: 'inspectionScheduleFilterExpertOptions',
    options: expertFilterOptions,
    icon: '🧑‍⚖️',
    minWidth: '160px',
  });

  const addBtn = document.getElementById('inspectionScheduleAddBtn');
  if (addBtn) {
    addBtn.onclick = async () => {
      const entry = addInspectionSchedule({
        date: new Date().toISOString().slice(0, 10),
        inspectionType: 'delivery',
        acceptanceStatus: tr('receivingSchedule.statusPlanned', 'Плановые задачи'),
      });
      if (entry?.id != null) {
        _newInspectionScheduleIds.add(String(entry.id));
        _editingInspectionScheduleIds.add(String(entry.id));
      }
      await saveToStorage();
      renderInspectionScheduleBlock();
      updateInspectionScheduleBadge();
      requestAnimationFrame(() => {
        const firstContractInput = wrap.querySelector('.sched-contract-input');
        firstContractInput?.focus();
      });
    };
  }

  const exportBtn = document.getElementById('inspectionScheduleExportBtn');
  if (exportBtn) {
    exportBtn.onclick = async () => {
      try {
        await exportInspectionScheduleToExcel();
      } catch (error) {
        console.error('Inspection schedule export error:', error);
        showToast(error?.message || tr('archive.error', 'Ошибка при создании архива'), 'error');
      }
    };
  }

  const printBtn = document.getElementById('inspectionSchedulePrintBtn');
  if (printBtn) {
    printBtn.onclick = () => openInspectionSchedulePrint();
  }

  wrap.querySelectorAll('.sched-inspection-type').forEach(select => {
    select.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(select.id.replace('sched_type_', '')));
      if (!entry) return;
      entry.inspectionType = normalizeInspectionType(select.value);
    });
  });

  wrap.querySelectorAll('.sched-contract-input').forEach(input => {
    input.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(input.id.replace('sched_contract_', '')));
      if (!entry) return;
      const contract = resolveScheduleContract(input.value);
      if (contract) {
        applyContractToSchedule(entry, contract.id);
        input.value = getScheduleContractDisplay(contract);
        input.scrollLeft = input.scrollWidth;
        updateContractCells(input.closest('tr'), entry);
      }
    });
  });

  wrap.querySelectorAll('.sched-recipient-input').forEach(input => {
    input.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(input.id.replace('sched_recipient_', '')));
      if (!entry) return;
      const recipient = resolveScheduleRecipient(input.value);
      if (recipient) {
        applyRecipientToSchedule(entry, recipient.id);
        input.value = recipient.name || '';
        input.scrollLeft = input.scrollWidth;
        replaceAddressOptions(input.closest('tr'), entry);
      }
    });
  });

  wrap.querySelectorAll('.sched-time-select').forEach(select => {
    select.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(select.dataset.id));
      if (!entry) return;
      entry.time = normalizeScheduleTime(select.value);
    });
  });

  wrap.querySelectorAll('.sched-expert-input').forEach(input => {
    input.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(input.id.replace('sched_expert_', '')));
      if (!entry) return;
      const expert = resolveScheduleExpert(input.value);
      if (!expert) return;
      const current = getScheduleExperts(entry);
      const exists = current.some(item => Number(item.id) === Number(expert.id));
      if (!exists) {
        setScheduleExperts(entry, [...current, { id: expert.id, name: expert.name || expert.role || '' }]);
      }
      rerenderInspectionSchedulePreservingViewport(`#sched_expert_${entry.id}`);
    });
  });

  wrap.querySelectorAll('.sched-expert-add').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(btn.dataset.id));
      if (!entry) return;
      const input = document.getElementById(`sched_expert_${entry.id}`);
      const expert = resolveScheduleExpert(input?.value || '');
      if (!expert) return;
      const current = getScheduleExperts(entry);
      const exists = current.some(item => Number(item.id) === Number(expert.id));
      if (!exists) {
        setScheduleExperts(entry, [...current, { id: expert.id, name: expert.name || expert.role || '' }]);
      }
      rerenderInspectionSchedulePreservingViewport(`#sched_expert_${entry.id}`);
    });
  });

  wrap.querySelectorAll('.sched-expert-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(btn.dataset.id));
      if (!entry) return;
      const current = getScheduleExperts(entry);
      current.splice(Number(btn.dataset.idx) || 0, 1);
      setScheduleExperts(entry, current);
      rerenderInspectionSchedulePreservingViewport(`#sched_expert_${entry.id}`);
    });
  });

  wrap.querySelectorAll('.sched-address-input').forEach(input => {
    input.addEventListener('input', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(input.id.replace('sched_address_', '')));
      if (!entry) return;
      entry.address = input.value;
    });
    input.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(input.id.replace('sched_address_', '')));
      if (!entry) return;
      entry.address = input.value;
    });
  });

  wrap.querySelectorAll('.sched-field').forEach(field => {
    field.addEventListener('input', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(field.dataset.id));
      if (!entry) return;
      const key = field.dataset.field;
      if (!key) return;
      entry[key] = field.value;
    });
    field.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(field.dataset.id));
      if (!entry) return;
      const key = field.dataset.field;
      entry[key] = field.value;
    });
  });

  wrap.querySelectorAll('.sched-repeat-checkbox').forEach(field => {
    field.addEventListener('change', () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(field.dataset.id));
      if (!entry) return;
      entry.repeatInspection = !!field.checked;
      const row = field.closest('tr');
      const checked = !!field.checked;
      const label = field.closest('label');
      label?.classList.toggle('text-sky-300', checked);
      label?.classList.toggle('text-slate-400', !checked);
      row?.querySelectorAll('td').forEach(cell => {
        cell.classList.toggle('bg-sky-500/[0.12]', checked);
      });
    });
  });

  wrap.querySelectorAll('.sched-edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _editingInspectionScheduleIds.add(String(btn.dataset.id));
      rerenderInspectionSchedulePreservingViewport(`#sched_contract_${btn.dataset.id}`);
    });
  });

  wrap.querySelectorAll('.sched-save-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(btn.dataset.id));
      if (!entry) return;
      updateInspectionSchedule(entry.id, { ...entry });
      _newInspectionScheduleIds.delete(String(entry.id));
      _editingInspectionScheduleIds.delete(String(entry.id));
      await saveToStorage();
      showToast(tr('receivingSchedule.saved', 'Строка графика сохранена'), 'success');
      rerenderInspectionSchedulePreservingViewport();
      updateInspectionScheduleBadge();
    });
  });

  wrap.querySelectorAll('.sched-delete-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const entry = (state.inspectionSchedules || []).find(item => String(item.id) === String(btn.dataset.id));
      if (!confirmDeleteWithImpact({
        title: 'Удалить строку графика проверок?',
        subject: getScheduleSummary(entry || {}),
        impacts: [
          'строка будет удалена из графика проверок',
        ],
        risks: [
          'связанный акт проверки, если он уже создан, не удаляется автоматически',
        ],
      })) return;
      _newInspectionScheduleIds.delete(String(btn.dataset.id));
      _editingInspectionScheduleIds.delete(String(btn.dataset.id));
      deleteInspectionSchedule(btn.dataset.id);
      await saveToStorage();
      showToast(tr('receivingSchedule.deleted', 'Строка графика удалена'), 'success');
      rerenderInspectionSchedulePreservingViewport();
      updateInspectionScheduleBadge();
    });
  });

  wrap.querySelectorAll('.sched-open-act-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const actId = Number(btn.dataset.id);
      if (!actId) return;
      const { openActFormForEdit } = await import('./act-form-view.js');
      openActFormForEdit(actId);
    });
  });
}

/** Read current DOM values and update state.commission */
function _saveCommissionFromDOM(wrap) {
  const roleInputs = wrap.querySelectorAll('.comm-role-inp');
  const nameInputs = wrap.querySelectorAll('.comm-name-inp');
  roleInputs.forEach((inp, i) => {
    const id = Number(inp.dataset.id);
    const nameInp = nameInputs[i];
    updateCommissionMember(id, inp.value, nameInp ? nameInp.value : undefined);
  });
}

function _saveInvitedExpertsFromDOM(wrap) {
  const roleInputs = wrap.querySelectorAll('.expert-role-inp');
  const orgInputs = wrap.querySelectorAll('.expert-org-inp');
  const nameInputs = wrap.querySelectorAll('.expert-name-inp');
  roleInputs.forEach((input, i) => {
    const id = Number(input.dataset.id);
    updateInvitedExpert(
      id,
      input.value,
      orgInputs[i] ? orgInputs[i].value : '',
      nameInputs[i] ? nameInputs[i].value : '',
    );
  });
  updateInvitedExpertsBadge();
}

// ─── Helpers ──────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtNum(n) {
  const num = parseFloat(n) || 0;
  return num.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
}
