/**
 * Act Form View — карточка формирования акта проверки.
 * Открывается из модуля «Приёмка» → «Сформировать акт».
 * Генерирует .docx: два вида — проверка СО и проверка поставленного товара.
 */

import { state, saveAct, updateAct, getRecipientAddresses, updateInspectionSchedule } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadJSZip } from './lib-loader.js';
import { uploadActMedia, deleteActMedia, getActMediaPreviewUrl, getActMediaDownloadUrl } from './act-media-service.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = window.miniappI18n?.t(key, vals);
  return !value || value === key ? fallback : value;
};

// ─── Module state ─────────────────────────────────────────────────

let _contractId = null;   // pre-selected from receiving view (may be null)
// mode: 'so'       = проверка сигнальных образцов (без кол-ва)
//       'delivery' = проверка поставленного товара (с кол-вом + отгрузка)
let _mode = 'so';
let _data = newData();
let _editActId = null;    // null = новый акт, number = редактирование существующего
let _baselineMediaIds = new Set();
let _pendingUploadedMediaIds = new Set();
let _pendingDeletedMediaIds = new Set();

function newData() {
  return {
    contractId: null,
    scheduleEntryId: null,
    orderId: null,
    orderNumber: '',
    recipientId: null,
    location: '',
    date: new Date().toISOString().slice(0, 10),
    recipientRepresentatives: [{ role: '', organization: '', name: '' }],
    commission: [{ role: '', name: '' }],
    expertRepresentatives: [],
    supplierReps: [{ role: '', name: '' }],
    invitedExperts: [],
    supplierNoticeNumber: '',
    supplierNoticeDate: '',
    supplierPowerOfAttorney: '',
    attachments: [],
    photos: [],
    videos: [],
    // selectedItems: [{ itemIdx, name, selected, qty, siSoNotRequired, specs:[{param,unit,value,checkResult,nonConform}] }]
    selectedItems: [],
    result: '',
    prescription: '',
    deadline: '',
  };
}

function getResultPrescriptionText(data) {
  const result = String(data?.result || '').trim();
  const prescription = String(data?.prescription || '').trim();
  if (result && prescription) return `${result}\n\nПредписания: ${prescription}`;
  return result || prescription || '';
}

function getAllActMediaIds(data = _data) {
  return [
    ...((data?.attachments || []).map(item => item?.id).filter(Boolean)),
    ...((data?.photos || []).map(item => item?.id).filter(Boolean)),
    ...((data?.videos || []).map(item => item?.id).filter(Boolean)),
  ];
}

function resetActMediaTracking() {
  _baselineMediaIds = new Set(getAllActMediaIds(_data));
  _pendingUploadedMediaIds = new Set();
  _pendingDeletedMediaIds = new Set();
}

async function cleanupUncommittedActMedia() {
  const ids = Array.from(_pendingUploadedMediaIds);
  await Promise.all(ids.map(async (id) => {
    try {
      await deleteActMedia(id);
    } catch (err) {
      console.warn('cleanup uploaded act media error:', err);
    }
  }));
  _pendingUploadedMediaIds.clear();
  _pendingDeletedMediaIds.clear();
  _baselineMediaIds = new Set();
}

async function commitPendingActMediaDeletes() {
  const ids = Array.from(_pendingDeletedMediaIds);
  await Promise.all(ids.map(async (id) => {
    try {
      await deleteActMedia(id);
    } catch (err) {
      console.warn('commit deleted act media error:', err);
    }
  }));
  resetActMediaTracking();
}

function getContractOrders(contractId) {
  return [...(state.orders || [])]
    .filter(order => Number(order.contractId) === Number(contractId))
    .sort((a, b) => String(a.orderNumber || '').localeCompare(String(b.orderNumber || ''), 'ru'));
}

function getOrderDisplayLabel(order) {
  if (!order) return '';
  const parts = [];
  if (order.orderNumber) parts.push(order.orderNumber);
  if (order.sent) parts.push(tf('orders.sentBadge', '✉ Отправлена'));
  return parts.join(' · ');
}

function resolveActOrder(orderId, contractId = _data.contractId) {
  if (!orderId) return null;
  return getContractOrders(contractId).find(order => Number(order.id) === Number(orderId)) || null;
}

function isWarehouseAcceptanceContext() {
  if (_mode !== 'delivery') return false;
  if (_data.recipientId) return false;
  if (_data.scheduleEntryId) {
    const entry = (state.inspectionSchedules || []).find(item => Number(item.id) === Number(_data.scheduleEntryId));
    if (entry?.recipientId) return false;
  }
  return true;
}

function buildAcceptanceStatusFromAct(selectedItems) {
  const items = Array.isArray(selectedItems) ? selectedItems.filter(item => item.selected !== false) : [];
  if (!items.length) return tf('receivingSchedule.statusPlanned', 'Плановые задачи');
  if (items.every(item => item.notDelivered)) return tf('receivingSchedule.statusRejectedNoDelivery', 'Не принято (непоставка)');
  const positiveItems = items.filter(item => getItemOverallConforms(item));
  if (positiveItems.length === items.length) return tf('receivingSchedule.statusAccepted', 'Принято');
  if (positiveItems.length > 0) return tf('receivingSchedule.statusAcceptedWithNotes', 'Принято с замечаниями');
  return tf('receivingSchedule.statusRejectedNotes', 'Не принято (замечания)');
}

function isItemAcceptedForExpertConclusion(item) {
  if (item?.notDelivered) return false;
  const qtyOk = Number(item?.qty || 0) > 0;
  const specsOk = !Array.isArray(item?.specs) || item.specs.length === 0 || item.specs.every(getFieldConforms);
  const normDocOk = !item?.normDocEnabled || item.normDocConforms !== false;
  return qtyOk && specsOk && normDocOk;
}

function getItemOverallConforms(item) {
  if (!item) return false;
  if (_mode === 'so') {
    if (item.siSoNotRequired) return true;
    const specsOk = !Array.isArray(item.specs) || item.specs.length === 0 || item.specs.every(getFieldConforms);
    const normDocOk = !item?.normDocEnabled || item.normDocConforms !== false;
    return specsOk && normDocOk && item.soConforms !== false;
  }
  if (item.notDelivered) return false;
  return isItemAcceptedForExpertConclusion(item);
}

function getItemCardBorderClass(item, checked = item?.selected !== false) {
  if (!checked) return 'border-white/10';
  if (item?.notDelivered) return 'border-red-500/30';
  if (_mode === 'so') {
    if (item?.siSoNotRequired) return 'border-emerald-500/30';
    return getItemOverallConforms(item) ? 'border-green-500/30' : 'border-red-500/20';
  }
  return getItemOverallConforms(item) ? 'border-green-500/30' : 'border-red-500/20';
}

function getItemStatusBadgeHtml(item, checked = item?.selected !== false) {
  if (!checked) return '';
  if (item?.notDelivered) {
    return `<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-red-500/15 text-red-300 whitespace-nowrap">${tf('act.notDeliveredBadge', 'Товар не поставлен')}</span>`;
  }

  const overallConforms = getItemOverallConforms(item);
  if (_mode === 'so') {
    if (item?.siSoNotRequired) {
      return '<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-emerald-500/15 text-emerald-400 whitespace-nowrap">Проверка не предусмотрена</span>';
    }
    return overallConforms
      ? '<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-green-500/15 text-green-400 whitespace-nowrap">✓ Соответствует</span>'
      : '<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-red-500/15 text-red-400 whitespace-nowrap">⚠ Не соответствует</span>';
  }

  return overallConforms
    ? '<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-green-500/15 text-green-400 whitespace-nowrap">✓ Соответствует</span>'
    : '<span class="act-item-status-badge text-xs font-semibold px-2 py-0.5 rounded-lg bg-red-500/15 text-red-400 whitespace-nowrap">⚠ Не соответствует</span>';
}

function updateItemCardVisualState(wrap, i) {
  const item = _data.selectedItems[i];
  const card = wrap.querySelector(`.act-item-card[data-i="${i}"]`);
  if (!item || !card) return;

  card.classList.remove('border-white/10', 'border-green-500/30', 'border-red-500/20', 'border-red-500/30', 'border-emerald-500/30');
  card.classList.add(getItemCardBorderClass(item, item.selected !== false));

  const badgeHost = card.querySelector('.act-item-status-host');
  if (badgeHost) badgeHost.innerHTML = getItemStatusBadgeHtml(item, item.selected !== false);
}

function getFieldConforms(spec) {
  return spec?.nonConform === true;
}

function getRecipientRepresentativesList(source = _data) {
  const list = Array.isArray(source?.recipientRepresentatives)
    ? source.recipientRepresentatives
    : [];
  if (list.length) {
    return list.map(item => ({
      role: String(item?.role || ''),
      organization: String(item?.organization || ''),
      name: String(item?.name || ''),
    }));
  }
  const legacy = source?.recipientRepresentative;
  if (legacy && (legacy.role || legacy.name)) {
    return [{
      role: String(legacy.role || ''),
      organization: '',
      name: String(legacy.name || ''),
    }];
  }
  return [{ role: '', organization: '', name: '' }];
}

/**
 * Resolve item code for a contract item.
 * Priority:
 *   1) item.code — already computed and persisted by contracts-view
 *   2) Recompute from productRef + contract.number (handles cases where
 *      the contract card was never opened after last save)
 */
function resolveItemCode(item, contract) {
  // 1) Already stored
  if (item.code && item.code.trim()) return item.code.trim();

  // 2) Recompute from productRef
  if (item.productRef == null) return '';
  const prod = state.products.find(p => p.id === item.productRef);
  if (!prod) return '';
  const prodNum = String(prod.number).padStart(4, '0');
  const contractNumber = contract?.number ?? '';
  const contractDigits = String(contractNumber).replace(/\D/g, '');
  const contractSuffix = contractDigits.length >= 4
    ? contractDigits.slice(-4)
    : contractDigits.padStart(4, '0');
  const computed = `${prodNum}/${contractSuffix}`;
  // Persist it back so subsequent calls are fast
  item.code = computed;
  return computed;
}

// ─── Open / Close ─────────────────────────────────────────────────

export function openActForm(contractId, mode) {
  _editActId = null;
  _data = newData();
  _data.contractId = contractId || null;
  _contractId = contractId || null;
  _mode = mode || 'so';

  const overlay = document.getElementById('actFormModal');
  if (!overlay) return;

  // Update header title based on mode
  const titleEl = document.getElementById('actFormTitle');
  if (titleEl) {
    titleEl.textContent = _mode === 'delivery'
      ? 'Акт проверки поставленного товара'
      : 'Акт проверки сигнальных образцов';
  }

  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');
  overlay.classList.add('open');
  resetActMediaTracking();
  renderAll();
}

/**
 * Open act form pre-filled with saved act data for editing.
 * @param {number} actId — id of the act in state.acts
 */
export function openActFormForEdit(actId) {
  const act = (state.acts || []).find(a => a.id === actId);
  if (!act) return;

  _editActId = Number(actId);
  _mode = act.mode || 'so';
  _contractId = act.contractId || null;

  // Deep-clone act data into _data
  _data = {
    contractId: act.contractId || null,
    scheduleEntryId: act.scheduleEntryId || null,
    orderId: act.orderId || null,
    orderNumber: act.orderNumber || '',
    recipientId: act.recipientId || null,
    location:   act.location   || '',
    date:       act.date       || new Date().toISOString().slice(0, 10),
    recipientRepresentatives: getRecipientRepresentativesList(act),
    commission:   (act.commission   || []).map(p => ({ ...p })),
    expertRepresentatives: (act.expertRepresentatives || []).map(p => ({ ...p })),
    supplierReps: (act.supplierReps || []).map(p => ({ ...p })),
    invitedExperts: (act.invitedExperts || []).map(p => ({ ...p })),
    supplierNoticeNumber: act.supplierNoticeNumber || '',
    supplierNoticeDate: act.supplierNoticeDate || '',
    supplierPowerOfAttorney: act.supplierPowerOfAttorney || '',
    attachments: (act.attachments || []).map(item => ({ ...item })),
    photos: (act.photos || []).map(item => ({ ...item })),
    videos: (act.videos || []).map(item => ({ ...item })),
    selectedItems: (act.selectedItems || []).map(si => ({
      ...si,
      description: si.description || '',
      notDelivered: !!si.notDelivered,
      specs: (si.specs || []).map(sp => ({ ...sp })),
    })),
    result:       getResultPrescriptionText(act),
    prescription: '',
    deadline:     act.deadline     || '',
    mode:         _mode,
  };

  const overlay = document.getElementById('actFormModal');
  if (!overlay) return;

  const titleEl = document.getElementById('actFormTitle');
  if (titleEl) {
    titleEl.textContent = _mode === 'delivery'
      ? 'Редактирование акта проверки поставки'
      : 'Редактирование акта проверки сигнальных образцов';
  }

  // Switch save button label to «Сохранить изменения»
  const saveBtn = document.getElementById('actFormSaveBtn');
  if (saveBtn) saveBtn.textContent = 'Сохранить изменения';

  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');
  overlay.classList.add('open');
  resetActMediaTracking();
  renderAll();
}

export function closeActForm() {
  void cleanupUncommittedActMedia();
  _editActId = null;
  // Reset save button label
  const saveBtn = document.getElementById('actFormSaveBtn');
  if (saveBtn) saveBtn.textContent = t('actsRegistry.saveBtn');
  const overlay = document.getElementById('actFormModal');
  if (overlay) {
    overlay.classList.remove('open');
    overlay.querySelector('.catalog-panel')?.classList.add('hidden');
  }
}

export function initActFormView() {
  const overlay = document.getElementById('actFormModal');
  if (!overlay) return;

  ensureActPrintButton();

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeActForm();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeActForm();
  });
  document.getElementById('actFormCloseBtn')?.addEventListener('click', closeActForm);
  document.getElementById('actFormGenerateBtn')?.addEventListener('click', onGenerate);
  document.getElementById('actFormPrintBtn')?.addEventListener('click', onPrintAct);
  document.getElementById('actFormExpertConclusionBtn')?.addEventListener('click', onGenerateExpertConclusion);
  document.getElementById('actFormSaveBtn')?.addEventListener('click', onSave);
}

function ensureActPrintButton() {
  if (document.getElementById('actFormPrintBtn')) return;
  const generateBtn = document.getElementById('actFormGenerateBtn');
  if (!generateBtn || !generateBtn.parentElement) return;
  const btn = document.createElement('button');
  btn.id = 'actFormPrintBtn';
  btn.type = 'button';
  btn.className = 'inline-flex items-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10 hover:border-cyan-400/30 hover:text-white active:scale-[0.97]';
  btn.innerHTML = '<span aria-hidden="true">🖨️</span><span>Печать</span>';
  generateBtn.parentElement.insertBefore(btn, generateBtn);
}

function onPrintAct() {
  _data.location     = document.getElementById('actLocation')?.value               ?? _data.location;
  _data.date         = document.getElementById('actDate')?.value                   ?? _data.date;
  _data.result       = document.getElementById('actResultPrescription')?.value     ?? _data.result;
  _data.prescription = '';
  _data.deadline     = document.getElementById('actDeadline')?.value               ?? _data.deadline;
  _data.supplierNoticeNumber = document.getElementById('actSupplierNoticeNumber')?.value ?? _data.supplierNoticeNumber;
  _data.supplierNoticeDate   = document.getElementById('actSupplierNoticeDate')?.value   ?? _data.supplierNoticeDate;
  _data.supplierPowerOfAttorney = document.getElementById('actSupplierPowerOfAttorney')?.value ?? _data.supplierPowerOfAttorney;

  const contract = _data.contractId ? state.contracts.find(c => c.id === _data.contractId) : null;
  const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;
  const selected = (_data.selectedItems || []).filter(si => si.selected !== false);
  const recipientRepresentatives = getRecipientRepresentativesList(_data).filter(item => item.role || item.organization || item.name);
  const supplierRepresentatives = (_data.supplierReps || []).filter(item => item.role || item.name);
  const commission = (_data.commission || []).filter(item => item.role || item.name);

  const html = `<!doctype html>
  <html lang="ru">
  <head>
    <meta charset="utf-8">
    <title>Печать акта</title>
    <style>
      @page { size: A4 portrait; margin: 16mm 14mm 18mm; }
      body { font-family: Arial, sans-serif; margin: 0; color: #111827; font-size: 12px; line-height: 1.45; }
      h1 { margin: 0 0 6px; font-size: 18px; text-align: center; font-weight: 500; }
      h2 { margin: 18px 0 8px; font-size: 13px; font-weight: 500; }
      p { margin: 4px 0; }
      table { width: 100%; border-collapse: collapse; margin: 10px 0; }
      th, td { border: 1px solid #9ca3af; padding: 6px 8px; vertical-align: top; font-weight: 400; }
      th { background: #f3f4f6; }
      .meta td:first-child { width: 32%; background: #f9fafb; }
      .sign td { height: 34px; }
      .page-break { page-break-after: always; }
      .muted { color: #4b5563; }
      .counter::after { content: counter(page); }
      .pages::after { content: counter(pages); }
      .footer { position: fixed; bottom: 0; left: 0; right: 0; font-size: 10px; color: #6b7280; text-align: right; }
    </style>
  </head>
  <body>
    <h1>${isSOType(_data) ? 'Акт проверки сигнальных образцов' : 'Акт проверки поставленного товара'}</h1>
    <table class="meta">
      <tr><td>Контракт</td><td>${esc(contract?.number || '—')} ${esc(contract?.title || '')}</td></tr>
      <tr><td>Дата акта</td><td>${esc(fmtDate(_data.date) || '—')}</td></tr>
      <tr><td>Место проверки</td><td>${esc(_data.location || '—')}</td></tr>
      <tr><td>Поставщик</td><td>${esc(supplier?.name || '—')}</td></tr>
      <tr><td>Письмо-вызов поставщика</td><td>${esc(_data.supplierNoticeNumber || '—')}${_data.supplierNoticeDate ? ' от ' + esc(fmtDate(_data.supplierNoticeDate)) : ''}</td></tr>
      <tr><td>Доверенность поставщика</td><td>${esc(_data.supplierPowerOfAttorney || '—')}</td></tr>
    </table>

    <h2>Состав комиссии</h2>
    <table>${commission.map(item => `<tr><td>${esc(item.role || '—')}</td><td>${esc(item.name || '—')}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'}</table>

    <h2>Представители получателя</h2>
    <table>${recipientRepresentatives.map(item => `<tr><td>${esc(item.role || '—')}</td><td>${esc(item.organization || '—')}</td><td>${esc(item.name || '—')}</td></tr>`).join('') || '<tr><td colspan="3">—</td></tr>'}</table>

    <h2>Представители поставщика</h2>
    <table>${supplierRepresentatives.map(item => `<tr><td>${esc(item.role || '—')}</td><td>${esc(item.name || '—')}</td></tr>`).join('') || '<tr><td colspan="2">—</td></tr>'}</table>

    <h2>Проверяемые товары</h2>
    <table>
      <thead>
        <tr>
          <th>№</th>
          <th>Код</th>
          <th>Наименование</th>
          <th>Ед. изм.</th>
          <th>Количество</th>
          <th>Иные замечания</th>
        </tr>
      </thead>
      <tbody>
        ${selected.map((item, index) => `<tr>
          <td>${index + 1}</td>
          <td>${esc(item.itemCode || '—')}</td>
          <td>${esc(item.name || '—')}</td>
          <td>${esc(item.unit || '—')}</td>
          <td>${esc(String(item.qty || item.contractQty || '—'))}</td>
          <td>${esc(item.normDocComment || item.description || '—')}</td>
        </tr>`).join('') || '<tr><td colspan="6">—</td></tr>'}
      </tbody>
    </table>

    <h2>Результаты и предписания</h2>
    <p>${esc(getResultPrescriptionText(_data) || '—').replace(/\n/g, '<br>')}</p>
    <p><strong style="font-weight:500;">Срок устранения:</strong> ${esc(_data.deadline ? fmtDate(_data.deadline) : '—')}</p>

    <h2>Подписи</h2>
    <table class="sign">
      <thead><tr><th>Сторона</th><th>Должность</th><th>ФИО</th><th>Подпись</th></tr></thead>
      <tbody>
        ${commission.map(item => `<tr><td>Комиссия</td><td>${esc(item.role || '—')}</td><td>${esc(item.name || '—')}</td><td></td></tr>`).join('')}
        ${recipientRepresentatives.map(item => `<tr><td>Получатель</td><td>${esc(item.role || '—')}</td><td>${esc(item.name || '—')}</td><td></td></tr>`).join('')}
        ${supplierRepresentatives.map(item => `<tr><td>Поставщик</td><td>${esc(item.role || '—')}</td><td>${esc(item.name || '—')}</td><td></td></tr>`).join('')}
      </tbody>
    </table>

    <p class="muted">Акт составлен на <span class="pages"></span> страницах.</p>
    <div class="footer">Страница <span class="counter"></span></div>
    <script>window.onload = () => window.print();</script>
  </body>
  </html>`;

  const printWindow = window.open('', '_blank', 'width=1200,height=900');
  if (!printWindow) {
    showToast('Не удалось открыть окно печати', 'error');
    return;
  }
  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
}

// ─── Render: full form ────────────────────────────────────────────

function renderAll() {
  renderContractField();
  renderBasicFields();
  renderRecipientRepresentatives();
  renderCommission();
  renderSupplierReps();
  renderInvitedExperts();
  renderSupplierNotice();
  renderItems();
  renderMediaSection();
  renderResultFields();
}

function ensureMediaSectionWrap() {
  let wrap = document.getElementById('actMediaWrap');
  if (wrap) return wrap;

  const resultSection = document.getElementById('actResultSectionWrap')?.closest('section');
  if (!resultSection || !resultSection.parentElement) return null;

  const section = document.createElement('section');
  section.innerHTML = `
    <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3">${tf('act.sectionMedia', 'Файлы, фото и видео')}</h3>
    <div id="actMediaWrap"></div>`;
  resultSection.parentElement.insertBefore(section, resultSection);
  return section.querySelector('#actMediaWrap');
}

function formatMediaSize(sizeBytes) {
  const size = Number(sizeBytes || 0);
  if (!size) return '';
  if (size < 1024) return `${size} Б`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} КБ`;
  return `${(size / 1024 / 1024).toFixed(2)} МБ`;
}

function getActMediaList(kind) {
  if (kind === 'photo') return _data.photos || [];
  if (kind === 'video') return _data.videos || [];
  return _data.attachments || [];
}

async function removeActMediaItem(kind, mediaId) {
  if (_baselineMediaIds.has(mediaId)) {
    _pendingDeletedMediaIds.add(mediaId);
  } else {
    try {
      await deleteActMedia(mediaId);
    } catch (err) {
      console.warn('delete act media error:', err);
    }
    _pendingUploadedMediaIds.delete(mediaId);
  }

  if (kind === 'photo') {
    _data.photos = (_data.photos || []).filter(item => item.id !== mediaId);
  } else if (kind === 'video') {
    _data.videos = (_data.videos || []).filter(item => item.id !== mediaId);
  } else {
    _data.attachments = (_data.attachments || []).filter(item => item.id !== mediaId);
  }

  renderMediaSection();
  showToast(tf('act.mediaRemoved', 'Файл удалён'), 'success');
}

async function handleActMediaSelection(fileList, kind) {
  const files = Array.from(fileList || []);
  if (!files.length) return;

  const statusEl = document.getElementById('actMediaStatus');
  const existing = getActMediaList(kind);

  try {
    if (statusEl) {
      statusEl.textContent = kind === 'photo'
        ? tf('act.uploadingPhotos', 'Загружаем фото…')
        : kind === 'video'
          ? tf('act.uploadingVideos', 'Загружаем видео…')
          : tf('act.uploadingFiles', 'Загружаем файлы…');
    }

    for (const file of files) {
      const uploaded = await uploadActMedia(file, kind);
      existing.push(uploaded);
      if (uploaded?.id) _pendingUploadedMediaIds.add(uploaded.id);
    }

    if (kind === 'photo') _data.photos = existing;
    else if (kind === 'video') _data.videos = existing;
    else _data.attachments = existing;

    renderMediaSection();
    showToast(
      kind === 'photo'
        ? tf('act.photosUploaded', 'Фото добавлены')
        : kind === 'video'
          ? tf('act.videosUploaded', 'Видео добавлены')
          : tf('act.filesUploaded', 'Файлы добавлены'),
      'success'
    );
  } catch (err) {
    console.error('act media upload error:', err);
    if (statusEl) statusEl.textContent = err?.message || tf('act.mediaUploadError', 'Ошибка загрузки файла');
    showToast(tf('act.mediaUploadError', 'Ошибка загрузки файла'), 'error');
  }
}

function renderMediaSection() {
  const wrap = ensureMediaSectionWrap();
  if (!wrap) return;

  const attachments = _data.attachments || [];
  const photos = _data.photos || [];
  const videos = _data.videos || [];

  wrap.innerHTML = `
    <div class="space-y-5">
      <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-sm font-semibold text-white">${tf('act.attachmentsTitle', 'Вложения к акту')}</p>
            <p class="text-xs text-slate-500">${tf('act.attachmentsHint', 'Загрузите сопроводительные файлы, акты, письма и другие документы.')}</p>
          </div>
          <label class="inline-flex items-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/20 cursor-pointer">
            <span aria-hidden="true">📎</span>
            <span>${tf('act.uploadFilesBtn', 'Добавить файлы')}</span>
            <input id="actAttachmentsInput" type="file" multiple class="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.txt,.csv,.png,.jpg,.jpeg,.webp">
          </label>
        </div>
        <div class="space-y-2">
          ${attachments.length ? attachments.map(file => `
            <div class="flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2.5">
              <span class="text-base" aria-hidden="true">📄</span>
              <div class="min-w-0 flex-1">
                <p class="truncate text-sm text-white">${esc(file.originalName || 'file')}</p>
                <p class="text-xs text-slate-500">${esc(formatMediaSize(file.sizeBytes) || '—')}</p>
              </div>
              <a href="${esc(getActMediaDownloadUrl(file))}" target="_blank" rel="noopener" download="${esc(file.originalName || 'file')}"
                class="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-semibold text-slate-300 transition hover:bg-white/10">${t('contracts.downloadFile')}</a>
              <button type="button" class="act-media-remove rounded-lg border border-red-500/20 px-3 py-1.5 text-xs font-semibold text-red-300 transition hover:bg-red-500/10" data-kind="attachment" data-id="${esc(file.id)}">${t('contracts.removeFile')}</button>
            </div>`).join('') : `<p class="text-xs text-slate-500">${tf('act.noAttachments', 'Файлы пока не добавлены')}</p>`}
        </div>
      </div>

      <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-sm font-semibold text-white">${tf('act.photosTitle', 'Фотографии')}</p>
            <p class="text-xs text-slate-500">${tf('act.photosHint', 'Можно сделать фото с камеры или добавить изображения из галереи.')}</p>
          </div>
          <label class="inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/20 cursor-pointer">
            <span aria-hidden="true">📷</span>
            <span>${tf('act.addPhotoBtn', 'Добавить фото')}</span>
            <input id="actPhotosInput" type="file" multiple class="hidden" accept="image/*" capture="environment">
          </label>
        </div>
        <div class="act-media-photo-grid grid grid-cols-2 sm:grid-cols-3 gap-3">
          ${photos.length ? photos.map(photo => `
            <div class="rounded-2xl border border-white/10 bg-slate-950/40 overflow-hidden">
              <a href="${esc(getActMediaPreviewUrl(photo))}" target="_blank" rel="noopener" class="block aspect-square bg-slate-900/70">
                <img src="${esc(getActMediaPreviewUrl(photo))}" alt="${esc(photo.originalName || 'photo')}" class="h-full w-full object-cover">
              </a>
              <div class="space-y-2 px-3 py-2.5">
                <p class="truncate text-xs text-slate-300">${esc(photo.originalName || 'photo')}</p>
                <div class="flex items-center gap-2">
                  <a href="${esc(getActMediaDownloadUrl(photo))}" target="_blank" rel="noopener" download="${esc(photo.originalName || 'photo.jpg')}" class="flex-1 rounded-lg border border-white/10 px-2 py-1.5 text-center text-[11px] font-semibold text-slate-300 transition hover:bg-white/10">${t('contracts.downloadFile')}</a>
                  <button type="button" class="act-media-remove rounded-lg border border-red-500/20 px-2 py-1.5 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/10" data-kind="photo" data-id="${esc(photo.id)}">${t('contracts.removeFile')}</button>
                </div>
              </div>
            </div>`).join('') : `<p class="col-span-full text-xs text-slate-500">${tf('act.noPhotos', 'Фото пока не добавлены')}</p>`}
        </div>
      </div>

      <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4 space-y-3">
        <div class="flex items-center justify-between gap-3 flex-wrap">
          <div>
            <p class="text-sm font-semibold text-white">${tf('act.videosTitle', 'Видео')}</p>
            <p class="text-xs text-slate-500">${tf('act.videosHint', 'Можно добавить ролики с камеры или из галереи. Видео по возможности будет сжато перед загрузкой.')}</p>
          </div>
          <label class="inline-flex items-center gap-2 rounded-xl border border-fuchsia-400/30 bg-fuchsia-400/10 px-3 py-2 text-xs font-semibold text-fuchsia-300 transition hover:bg-fuchsia-400/20 cursor-pointer">
            <span aria-hidden="true">🎥</span>
            <span>${tf('act.addVideoBtn', 'Добавить видео')}</span>
            <input id="actVideosInput" type="file" multiple class="hidden" accept="video/*" capture="environment">
          </label>
        </div>
        <div class="act-media-video-grid grid grid-cols-1 sm:grid-cols-2 gap-3">
          ${videos.length ? videos.map(video => `
            <div class="rounded-2xl border border-white/10 bg-slate-950/40 overflow-hidden">
              <div class="aspect-video bg-slate-900/70">
                <video src="${esc(getActMediaPreviewUrl(video))}" class="h-full w-full object-cover" preload="metadata" controls playsinline></video>
              </div>
              <div class="space-y-2 px-3 py-2.5">
                <p class="truncate text-xs text-slate-300">${esc(video.originalName || 'video')}</p>
                <p class="text-[11px] text-slate-500">${esc(formatMediaSize(video.sizeBytes) || '—')}</p>
                <div class="flex items-center gap-2">
                  <a href="${esc(getActMediaDownloadUrl(video))}" target="_blank" rel="noopener" download="${esc(video.originalName || 'video.webm')}" class="flex-1 rounded-lg border border-white/10 px-2 py-1.5 text-center text-[11px] font-semibold text-slate-300 transition hover:bg-white/10">${t('contracts.downloadFile')}</a>
                  <button type="button" class="act-media-remove rounded-lg border border-red-500/20 px-2 py-1.5 text-[11px] font-semibold text-red-300 transition hover:bg-red-500/10" data-kind="video" data-id="${esc(video.id)}">${t('contracts.removeFile')}</button>
                </div>
              </div>
            </div>`).join('') : `<p class="col-span-full text-xs text-slate-500">${tf('act.noVideos', 'Видео пока не добавлены')}</p>`}
        </div>
      </div>

      <p id="actMediaStatus" class="min-h-[1rem] text-xs text-slate-500"></p>
    </div>`;

  wrap.querySelector('#actAttachmentsInput')?.addEventListener('change', async (e) => {
    await handleActMediaSelection(e.target.files, 'attachment');
    e.target.value = '';
  });
  wrap.querySelector('#actPhotosInput')?.addEventListener('change', async (e) => {
    await handleActMediaSelection(e.target.files, 'photo');
    e.target.value = '';
  });
  wrap.querySelector('#actVideosInput')?.addEventListener('change', async (e) => {
    await handleActMediaSelection(e.target.files, 'video');
    e.target.value = '';
  });
  wrap.querySelectorAll('.act-media-remove').forEach(btn => {
    btn.addEventListener('click', () => removeActMediaItem(btn.dataset.kind, btn.dataset.id));
  });
}

function updateExpertConclusionButton() {
  const btn = document.getElementById('actFormExpertConclusionBtn');
  if (!btn) return;
  const { isPositive } = getPositiveExpertConclusionState();
  const hasResponsible = (_data.expertRepresentatives || []).length > 0;
  btn.classList.toggle('hidden', _mode !== 'delivery' || !isPositive);
  btn.disabled = !hasResponsible;
  btn.title = hasResponsible ? '' : tf('act.expertConclusionSelectResponsible', 'Выберите ответственных за экспертизу');
}

function normalizePersonValue(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function getPersonKey(person) {
  return `${normalizePersonValue(person?.role).toLowerCase()}|||${normalizePersonValue(person?.name).toLowerCase()}`;
}

function clonePerson(person) {
  return {
    role: normalizePersonValue(person?.role),
    name: normalizePersonValue(person?.name),
  };
}

function getCommissionCandidates() {
  return (state.commission || [])
    .map(clonePerson)
    .filter(person => person.role || person.name);
}

function getSelectedActItems() {
  return (_data.selectedItems || []).filter(si => si.selected !== false);
}

function getPositiveExpertConclusionState() {
  const selectedItems = getSelectedActItems();
  const expertItems = selectedItems.filter(isItemAcceptedForExpertConclusion);
  const isPositive = _mode === 'delivery' && expertItems.length > 0;
  return { isPositive, selectedItems, expertItems };
}

function syncExpertRepresentativesWithCommission() {
  const candidates = getCommissionCandidates();
  const candidateMap = new Map(candidates.map(person => [getPersonKey(person), person]));
  _data.expertRepresentatives = (_data.expertRepresentatives || [])
    .map(clonePerson)
    .filter(person => candidateMap.has(getPersonKey(person)));
}

function refreshExpertConclusionUi() {
  syncExpertRepresentativesWithCommission();
  renderExpertConclusionPanel();
  updateExpertConclusionButton();
}

function renderExpertConclusionPanel() {
  const wrap = document.getElementById('actExpertConclusionWrap');
  if (!wrap) return;

  const { isPositive, selectedItems, expertItems } = getPositiveExpertConclusionState();
  if (_mode !== 'delivery' || !isPositive) {
    wrap.innerHTML = '';
    return;
  }

  const candidates = getCommissionCandidates();
  const selectedKeys = new Set((_data.expertRepresentatives || []).map(getPersonKey));

  if (!candidates.length) {
    wrap.innerHTML = `
      <div class="rounded-2xl border border-amber-500/25 bg-amber-500/10 px-4 py-4">
        <p class="text-sm font-semibold text-amber-300">${tf('act.expertPositiveHint', 'Проверка положительная, сформируйте заключение экспертизы.')}</p>
        <p class="mt-1 text-xs text-slate-300">${tf('act.expertResponsibleEmpty', 'Сначала заполните общий состав комиссии в модуле «Приёмка», затем выберите ответственных за экспертизу.')}</p>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div class="rounded-2xl border border-emerald-500/25 bg-emerald-500/10 px-4 py-4 space-y-3">
      <div>
        <p class="text-sm font-semibold text-emerald-300">${tf('act.expertPositiveHint', 'Проверка положительная, сформируйте заключение экспертизы.')}</p>
        <p class="mt-1 text-xs text-slate-200">${expertItems.length === selectedItems.length
          ? tf('act.expertResponsibleHint', 'Выберите ответственных за экспертизу из общего состава комиссии.')
          : `В акте есть товары с разным результатом. В заключение экспертизы будут включены только принятые позиции: ${expertItems.length} из ${selectedItems.length}.`}</p>
      </div>
      <div>
        <p class="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-300">${tf('act.expertResponsibleTitle', 'Ответственные за экспертизу')}</p>
        <div class="grid gap-2">
          ${candidates.map((person, idx) => {
            const checked = selectedKeys.has(getPersonKey(person));
            return `
              <label class="flex items-start gap-3 rounded-xl border ${checked ? 'border-emerald-400/35 bg-emerald-400/[0.08]' : 'border-white/10 bg-white/[0.03]'} px-3 py-2.5 cursor-pointer transition hover:border-emerald-400/30 hover:bg-white/[0.05]">
                <input type="checkbox" class="act-expert-responsible-cb mt-0.5 h-4 w-4 accent-emerald-400" data-idx="${idx}" ${checked ? 'checked' : ''}>
                <div class="min-w-0">
                  <p class="text-sm font-semibold text-white">${esc(person.name || tf('act.nameLabel', 'ФИО'))}</p>
                  <p class="mt-0.5 text-xs text-slate-300">${esc(person.role || '—')}</p>
                </div>
              </label>`;
          }).join('')}
        </div>
      </div>
    </div>`;

  wrap.querySelectorAll('.act-expert-responsible-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const person = candidates[Number(cb.dataset.idx)];
      if (!person) return;
      const key = getPersonKey(person);
      const map = new Map((_data.expertRepresentatives || []).map(item => [getPersonKey(item), clonePerson(item)]));
      if (cb.checked) map.set(key, clonePerson(person));
      else map.delete(key);
      _data.expertRepresentatives = Array.from(map.values());
      refreshExpertConclusionUi();
    });
  });
}

// ─── Contract selector ────────────────────────────────────────────

function renderContractField() {
  const wrap = document.getElementById('actContractWrap');
  if (!wrap) return;

  const contracts = state.contracts || [];

  wrap.innerHTML = `
    <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400"
      for="actContractInput">${t('act.fieldContract')}</label>
    <div class="relative">
      <input id="actContractInput" type="text" autocomplete="off"
        class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
        placeholder="${t('act.contractSearchPlaceholder')}"
        value="${esc(contractLabel(_data.contractId))}">
      <div id="actContractDrop"
        class="hidden absolute z-50 left-0 right-0 mt-1 rounded-xl border border-white/15 bg-slate-800 shadow-2xl overflow-y-auto max-h-52">
      </div>
    </div>`;

  const input = document.getElementById('actContractInput');
  const drop  = document.getElementById('actContractDrop');

  function buildDrop(q) {
    const filtered = q
      ? contracts.filter(c => contractLabel(c.id).toLowerCase().includes(q.toLowerCase()))
      : contracts;
    drop.innerHTML = filtered.length === 0
      ? `<p class="px-4 py-3 text-xs text-slate-500">Ничего не найдено</p>`
      : filtered.map(c => `
          <div class="contract-opt px-4 py-2.5 text-sm text-white cursor-pointer hover:bg-cyan-400/10 transition"
            data-id="${c.id}">${esc(contractLabel(c.id))}</div>`).join('');

    drop.querySelectorAll('.contract-opt').forEach(div => {
      div.addEventListener('mousedown', e => {
        e.preventDefault();
        const id = Number(div.dataset.id);
        _data.contractId = id;
        _data.orderId = null;
        _data.orderNumber = '';
        input.value = contractLabel(id);
        drop.classList.add('hidden');
        updateSOWarning(id);
        renderBasicFields();
        renderRecipientRepresentatives();
        renderItems();
        renderSupplierReps();
      });
    });
  }

  input.addEventListener('focus', () => { buildDrop(''); drop.classList.remove('hidden'); });
  input.addEventListener('input', () => { buildDrop(input.value); drop.classList.remove('hidden'); });
  input.addEventListener('blur',  () => { setTimeout(() => drop.classList.add('hidden'), 200); });

  // ── Предупреждение если СО не предусмотрен контрактом ──────────
  drop.addEventListener('mousedown', () => {}); // keep focus
  buildDrop('');

  // Show/hide SO warning banner after contract selection
  function updateSOWarning(contractId) {
    let banner = wrap.querySelector('#actSONotRequiredBanner');
    const contract = contractId ? state.contracts.find(c => c.id === contractId) : null;
    const soNotRequired = _mode === 'so' && contract && contract.soApprovalRequired === false;
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'actSONotRequiredBanner';
      banner.className = 'mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3 flex items-start gap-2';
      banner.innerHTML = '<span class="text-amber-400 text-base shrink-0 mt-0.5">⚠</span>' +
        '<div><p class="text-sm font-semibold text-amber-400">Контрактом не предусмотрена проверка сигнальных образцов</p>' +
        '<p class="text-xs text-slate-400 mt-0.5">Результаты проверки не будут переданы в модуль «Контракты» и не повлияют на возможность направления заявок. Формирование и сохранение акта допускается.</p></div>';
      wrap.appendChild(banner);
    }
    banner.classList.toggle('hidden', !soNotRequired);
  }

  if (_data.contractId) updateSOWarning(_data.contractId);
}

function contractLabel(id) {
  if (!id) return '';
  const c = state.contracts.find(ct => ct.id === id);
  if (!c) return '';
  const num = c.number ? `№ ${c.number}` : t('contracts.noNumber');
  return c.title ? `${num} — ${c.title}` : num;
}

function matchActItemToContractItem(si, item, contract) {
  const contractCode = resolveItemCode(item, contract).trim();
  const actCode = String(si?.itemCode || '').trim();
  if (contractCode && actCode) return contractCode === actCode;

  const contractName = String(item?.name || '').trim().toLowerCase();
  const actName = String(si?.name || '').trim().toLowerCase();
  return !!contractName && !!actName && contractName === actName;
}

function buildActHistoryEntry(act, si) {
  const isDelivery = (act.mode || 'so') === 'delivery';
  const positive = isDelivery
    ? getItemOverallConforms(si)
    : si?.soConforms === true;
  const negative = isDelivery
    ? !getItemOverallConforms(si)
    : si?.soConforms === false;

  let resultLabel = '';
  if (isDelivery) {
    if (si?.notDelivered) {
      resultLabel = tf('act.notDeliveredBadge', 'Товар не поставлен');
    } else {
      resultLabel = positive
        ? tf('act.deliveryHistoryPositive', 'Положительная проверка поставки')
        : tf('act.deliveryHistoryNegative', 'Проверка поставки с замечаниями');
    }
  } else {
    if (si?.siSoNotRequired) {
      resultLabel = tf('act.soHistorySkipped', 'Проверка СО не требовалась');
    } else {
      resultLabel = positive
        ? tf('act.soHistoryPositive', 'Положительная проверка')
        : tf('act.soHistoryNegative', 'Отрицательная проверка');
    }
  }

  return {
    actId: act.id,
    date: act.date || '',
    dateLabel: act.date ? fmtDate(act.date) : 'без даты',
    location: act.location || '',
    mode: isDelivery ? 'delivery' : 'so',
    modeLabel: isDelivery
      ? tf('act.deliveryHistoryMode', 'Поставка')
      : tf('act.soHistoryMode', 'СО'),
    resultLabel,
    positive,
    negative,
  };
}

function getActHistoryForContractItem(contract, item) {
  const history = [];
  for (const act of (state.acts || [])) {
    if (_editActId != null && Number(act.id) === Number(_editActId)) continue;
    if (Number(act.contractId) !== Number(contract?.id)) continue;

    for (const si of (act.selectedItems || [])) {
      if (si?.selected === false) continue;
      if (!matchActItemToContractItem(si, item, contract)) continue;
      history.push(buildActHistoryEntry(act, si));
    }
  }

  history.sort((a, b) => {
    const byDate = String(b.date || '').localeCompare(String(a.date || ''));
    if (byDate !== 0) return byDate;
    return Number(b.actId || 0) - Number(a.actId || 0);
  });

  const soEntries = history.filter(entry => entry.mode === 'so');
  const deliveryEntries = history.filter(entry => entry.mode === 'delivery');
  const positiveEntries = soEntries.filter(entry => entry.positive);
  const negativeEntries = soEntries.filter(entry => entry.negative);

  return {
    all: history,
    soEntries,
    deliveryEntries,
    positiveEntries,
    negativeEntries,
    hasPositive: positiveEntries.length > 0,
  };
}

function validateSODuplicatePositive(items = _data.selectedItems || [], { silent = false } = {}) {
  if (_mode !== 'so' || !_data.contractId) return true;

  const contract = state.contracts.find(c => Number(c.id) === Number(_data.contractId));
  if (!contract) return true;

  const blocked = [];
  items.forEach((si) => {
    if (!si || si.selected === false) return;
    const item = (contract.items || [])[Number(si.itemIdx)];
    if (!item) return;

    // Разрешаем редактировать и пересохранять старые отрицательные акты,
    // даже если по товару уже существует другой положительный акт СО.
    // Блокировать нужно только попытку сделать ТЕКУЩИЙ сохраняемый результат положительным.
    const currentWouldBePositive = getItemOverallConforms(si);
    if (!currentWouldBePositive) return;

    const history = getActHistoryForContractItem(contract, item);
    const positiveEntries = (history.positiveEntries || []).filter(entry => {
      return _editActId == null || Number(entry.actId) !== Number(_editActId);
    });
    if (positiveEntries.length > 0) {
      blocked.push({
        name: String(si.name || item.name || 'Товар').trim() || 'Товар',
        positiveEntries,
      });
    }
  });

  if (!blocked.length) return true;

  if (!silent) {
    const first = blocked[0];
    const firstAct = first.positiveEntries[0];
    const moreText = blocked.length > 1
      ? ` Также ограничение сработало ещё для ${blocked.length - 1} ${blocked.length - 1 === 1 ? 'товара' : 'товаров'}.`
      : '';
    const existingActText = firstAct
      ? `Уже есть положительный акт СО от ${firstAct.dateLabel || 'без даты'}${firstAct.location ? ` (${firstAct.location})` : ''}.`
      : 'Уже есть другой положительный акт СО по этому товару.';
    showToast(
      `Нельзя сохранить положительный результат СО по товару «${first.name}». ${existingActText} Редактировать уже существующий положительный акт можно, но нельзя создавать второй положительный акт и нельзя переводить другой отрицательный акт в положительный.${moreText}`,
      'error'
    );
  }

  return false;
}

function normalizeInspectionScheduleType(value) {
  return String(value || '').trim().toLowerCase() === 'so' ? 'so' : 'delivery';
}

function getInspectionScheduleTypeLabel(value) {
  return normalizeInspectionScheduleType(value) === 'so'
    ? tf('receivingSchedule.inspectionTypeSo', 'Проверка сигнального образца')
    : tf('receivingSchedule.inspectionTypeDelivery', 'Проверка поставленного товара');
}

function getInspectionScheduleOptions() {
  return [...(state.inspectionSchedules || [])]
    .map(entry => {
      if (!entry.inspectionType) entry.inspectionType = 'delivery';
      return entry;
    })
    .filter(entry => normalizeInspectionScheduleType(entry.inspectionType) === (_mode === 'delivery' ? 'delivery' : 'so'))
    .sort((a, b) => `${a.date || ''} ${a.time || ''}`.localeCompare(`${b.date || ''} ${b.time || ''}`));
}

function inspectionScheduleLabel(entry) {
  const date = entry?.date ? fmtDate(entry.date) : '—';
  const time = entry?.time || '—';
  const contract = entry?.contractNumber ? `№ ${entry.contractNumber}` : t('contracts.noNumber');
  const recipient = entry?.recipientName || '—';
  const type = getInspectionScheduleTypeLabel(entry?.inspectionType);
  return `${date} · ${time} · ${type} · ${contract} · ${recipient}`;
}

function applyInspectionScheduleToAct(entryId) {
  const entry = (state.inspectionSchedules || []).find(item => Number(item.id) === Number(entryId));
  if (!entry) {
    _data.scheduleEntryId = null;
    return;
  }

  _data.scheduleEntryId = entry.id;
  if (entry.contractId) _data.contractId = entry.contractId;
  _data.recipientId = entry.recipientId || null;
  _data.location = entry.address || '';
  _data.supplierNoticeNumber = entry.supplierNoticeNumber || '';
  _data.supplierNoticeDate = entry.supplierNoticeDate || '';

  if (entry.recipientRepresentative) {
    const firstRecipientRepresentative = _data.recipientRepresentatives?.[0] || { role: '', organization: '', name: '' };
    if (!firstRecipientRepresentative.name) {
      firstRecipientRepresentative.name = entry.recipientRepresentative;
    }
    _data.recipientRepresentatives = [
      firstRecipientRepresentative,
      ...((_data.recipientRepresentatives || []).slice(1)),
    ];
  }

  const expertIds = Array.isArray(entry.expertIds) && entry.expertIds.length
    ? entry.expertIds
    : (entry.expertId ? [entry.expertId] : []);

  expertIds.forEach((expertId) => {
    const expert = (state.commission || []).find(item => Number(item.id) === Number(expertId));
    if (!expert) return;
    const normalizedRole = normalizePersonValue(expert.role);
    const normalizedName = normalizePersonValue(expert.name);
    const hasSame = (_data.commission || []).some(item =>
      normalizePersonValue(item.role) === normalizedRole && normalizePersonValue(item.name) === normalizedName
    );
    if (!hasSame) {
      const filled = (_data.commission || []).filter(item => normalizePersonValue(item.role) || normalizePersonValue(item.name));
      _data.commission = filled.length
        ? [...filled, { role: expert.role || '', name: expert.name || '' }]
        : [{ role: expert.role || '', name: expert.name || '' }];
    }
  });
}

function buildScheduleShortResult(selectedItems, resultText) {
  const text = String(resultText || '').trim();
  if (text) return text.split(/\n+/).map(line => line.trim()).filter(Boolean)[0]?.slice(0, 220) || '';
  if (!selectedItems.length) return '';
  return isPositiveDeliveryResult(selectedItems)
    ? tf('receivingSchedule.shortPositive', 'Нарушений не выявлено')
    : tf('receivingSchedule.shortIssues', 'Выявлены замечания по результатам проверки');
}

function buildScheduleIncorrectTz(selectedItems) {
  const issues = [];
  selectedItems.forEach(item => {
    if (item?.notDelivered) return;
    (item.specs || []).forEach(spec => {
      if (spec.nonConform !== false) return;
      const unit = spec.unit ? ` ${spec.unit}` : '';
      const contractValue = spec.value ? `по ТЗ: ${spec.value}${unit}` : 'по ТЗ: не указано';
      const factValue = spec.checkResult ? `факт: ${spec.checkResult}${unit}` : 'факт: не указан';
      issues.push(`${item.name || 'Товар'} — ${spec.param || 'характеристика'} (${contractValue}; ${factValue})`);
    });
  });
  return issues.join('; ').slice(0, 1000);
}

function syncInspectionScheduleFromAct(savedAct) {
  if (!_data.scheduleEntryId) return;
  const entry = (state.inspectionSchedules || []).find(item => Number(item.id) === Number(_data.scheduleEntryId));
  if (!entry) return;

  const contract = _data.contractId ? state.contracts.find(item => item.id === _data.contractId) : null;
  const supplier = contract?.supplierId ? state.suppliers.find(item => item.id === contract.supplierId) : null;
  const recipient = _data.recipientId ? state.recipients.find(item => item.id === _data.recipientId) : null;
  const selectedItems = (_data.selectedItems || []).filter(item => item.selected !== false);
  const filledExperts = (_data.commission || []).filter(item => item.role || item.name);
  const firstExpert = filledExperts[0] || null;

  updateInspectionSchedule(entry.id, {
    inspectionType: _mode === 'delivery' ? 'delivery' : 'so',
    contractId: _data.contractId || null,
    contractDate: contract?.date || entry.contractDate || '',
    contractNumber: contract?.number || entry.contractNumber || '',
    contractTitle: contract?.title || entry.contractTitle || '',
    supplierId: supplier?.id ?? contract?.supplierId ?? null,
    supplierName: supplier?.name || entry.supplierName || '',
    recipientId: _data.recipientId || null,
    recipientName: recipient?.name || entry.recipientName || '',
    address: _data.location || '',
    recipientRepresentative: getRecipientRepresentativesList(_data).find(item => item.name)?.name || entry.recipientRepresentative || '',
    expertId: firstExpert?.id ?? entry.expertId ?? null,
    expertName: firstExpert?.name || entry.expertName || '',
    expertIds: filledExperts.map(item => item.id).filter(Boolean),
    expertNames: filledExperts.map(item => item.name).filter(Boolean),
    supplierNoticeDate: _data.supplierNoticeDate || '',
    supplierNoticeNumber: _data.supplierNoticeNumber || '',
    linkedActId: savedAct?.id || entry.linkedActId || null,
    acceptanceStatus: selectedItems.length
      ? buildAcceptanceStatusFromAct(selectedItems)
      : entry.acceptanceStatus || tf('receivingSchedule.statusPlanned', 'Плановые задачи'),
    correctionDeadline: _data.deadline || '',
    shortResult: buildScheduleShortResult(selectedItems, _data.result),
    incorrectTz: buildScheduleIncorrectTz(selectedItems),
  });
}

function renderActRecipientAddressField() {
  const wrap = document.getElementById('actRecipientAddressWrap');
  if (!wrap) return;

  const recipient = _data.recipientId ? (state.recipients || []).find(r => r.id === _data.recipientId) : null;
  const options = getRecipientAddresses(recipient);
  if (!recipient || options.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  if (!_data.location || !options.includes(_data.location)) {
    _data.location = options[0] || '';
    const locationInput = document.getElementById('actLocation');
    if (locationInput) locationInput.value = _data.location;
  }

  wrap.innerHTML = `
    <div>
      <label for="actRecipientAddressSel"
        class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">Адрес получателя</label>
      <select id="actRecipientAddressSel"
        class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">
        ${options.map(address => `<option value="${esc(address)}" ${address === _data.location ? 'selected' : ''}>${esc(address)}</option>`).join('')}
      </select>
    </div>`;

  document.getElementById('actRecipientAddressSel')?.addEventListener('change', e => {
    _data.location = e.target.value || '';
    const locationInput = document.getElementById('actLocation');
    if (locationInput) locationInput.value = _data.location;
  });
}

// ─── Basic fields ─────────────────────────────────────────────────

function renderBasicFields() {
  const wrap = document.getElementById('actBasicFieldsWrap');
  if (!wrap) return;

  const recipients = state.recipients || [];
  const contractOrders = _data.contractId ? getContractOrders(_data.contractId) : [];
  const scheduleEntries = getInspectionScheduleOptions();
  const scheduleFieldHtml = `
      <div class="sm:col-span-2">
        <label for="actScheduleSel"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('receivingSchedule.actField', 'Строка графика проверок')}</label>
        <select id="actScheduleSel"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">
          <option value="">${tf('receivingSchedule.actSelect', '— Выберите строку графика (необязательно) —')}</option>
          ${scheduleEntries.map(entry => `<option value="${entry.id}" ${Number(_data.scheduleEntryId) === Number(entry.id) ? 'selected' : ''}>${esc(inspectionScheduleLabel(entry))}</option>`).join('')}
        </select>
        <p class="mt-1 text-xs text-slate-500">${tf('receivingSchedule.actHint', 'Из выбранной строки будут подставлены контракт, адрес и реквизиты письма поставщику.')}</p>
      </div>`;
  const recipientFieldHtml = _mode === 'delivery'
    ? `
      <div>
        <label for="actRecipientSel"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('receiving.recipient')}</label>
        <select id="actRecipientSel"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]">
          <option value="">${t('receiving.recipientPlaceholder')}</option>
          ${recipients.map(rec => `<option value="${rec.id}" ${Number(_data.recipientId) === Number(rec.id) ? 'selected' : ''}>${esc(rec.name)}</option>`).join('')}
        </select>
      </div>
      <div id="actRecipientAddressWrap"></div>`
    : '';
  const orderFieldHtml = `
      <div>
        <label for="actOrderSel"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.fieldOrder', 'Заявка')}</label>
        <select id="actOrderSel"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          ${_data.contractId ? '' : 'disabled'}>
          <option value="">${_data.contractId ? tf('act.selectOrder', '— Выберите заявку (необязательно) —') : tf('orders.selectContractFirstOption', '— Сначала выберите контракт —')}</option>
          ${contractOrders.map(order => `<option value="${order.id}" ${Number(_data.orderId) === Number(order.id) ? 'selected' : ''}>${esc(getOrderDisplayLabel(order))}</option>`).join('')}
        </select>
      </div>`;

  wrap.innerHTML = `
    <div class="act-basic-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
      ${scheduleFieldHtml}
      <div class="sm:col-span-2">
        <label for="actLocation"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('act.fieldLocation')}</label>
        <input id="actLocation" type="text"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${t('act.locationPlaceholder')}"
          value="${esc(_data.location)}">
      </div>
      <div>
        <label for="actDate"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('act.fieldDate')}</label>
        <input id="actDate" type="date"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          value="${esc(_data.date)}">
      </div>
      ${orderFieldHtml}
      ${recipientFieldHtml}
    </div>
    <div id="actRecipientRepresentativesWrap" class="mt-4"></div>`;

  document.getElementById('actLocation')?.addEventListener('input', e => { _data.location = e.target.value; });
  document.getElementById('actDate')?.addEventListener('input', e => { _data.date = e.target.value; });
  document.getElementById('actOrderSel')?.addEventListener('change', e => {
    const order = resolveActOrder(Number(e.target.value) || null);
    _data.orderId = order?.id || null;
    _data.orderNumber = order?.orderNumber || '';
  });

  document.getElementById('actScheduleSel')?.addEventListener('change', e => {
    if (!e.target.value) {
      _data.scheduleEntryId = null;
      return;
    }
    applyInspectionScheduleToAct(Number(e.target.value));
    renderAll();
  });

  // Wire recipient selector — when changed, re-render items to update _deliveredToRecipient
  document.getElementById('actRecipientSel')?.addEventListener('change', e => {
    _data.recipientId = Number(e.target.value) || null;
    if (_data.recipientId) {
      const addresses = getRecipientAddresses((state.recipients || []).find(r => r.id === _data.recipientId));
      _data.location = addresses[0] || '';
      const locationInput = document.getElementById('actLocation');
      if (locationInput) locationInput.value = _data.location;
    } else {
      _data.location = '';
      const locationInput = document.getElementById('actLocation');
      if (locationInput) locationInput.value = '';
    }
    renderActRecipientAddressField();
    renderItems(); // Refresh items with new delivered counts
  });

  renderActRecipientAddressField();
}

function renderRecipientRepresentatives() {
  const wrap = document.getElementById('actRecipientRepresentativesWrap');
  if (!wrap) return;

  const list = Array.isArray(_data.recipientRepresentatives)
    ? _data.recipientRepresentatives
    : (_data.recipientRepresentatives = [{ role: '', organization: '', name: '' }]);
  const inputCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

  wrap.innerHTML = `
    <div class="rounded-2xl border border-white/10 bg-white/[0.03] p-4">
      <p class="mb-3 text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.recipientRepresentativesTitle', 'Представители получателя')}</p>
      <div class="overflow-hidden rounded-xl border border-white/10">
        <table class="w-full text-sm">
          <thead>
            <tr class="bg-white/[0.04] border-b border-white/10">
              <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[32%]">${t('act.roleLabel')}</th>
              <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[32%]">${tf('experts.fieldOrganization', 'Организация')}</th>
              <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-[32%]">${t('act.nameLabel')}</th>
              <th class="w-10"></th>
            </tr>
          </thead>
          <tbody class="divide-y divide-white/5">
            ${list.map((p, i) => `
              <tr>
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} act-recipient-rep-role" data-idx="${i}" value="${esc(p.role || '')}" placeholder="${t('act.roleLabel')}"></td>
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} act-recipient-rep-org" data-idx="${i}" value="${esc(p.organization || '')}" placeholder="${tf('experts.fieldOrganization', 'Организация')}"></td>
                <td class="px-2 py-1.5"><input type="text" class="${inputCls} act-recipient-rep-name" data-idx="${i}" value="${esc(p.name || '')}" placeholder="${t('act.nameLabel')}"></td>
                <td class="px-2 py-1.5 text-center">
                  <button class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition act-recipient-rep-del mx-auto" data-idx="${i}" aria-label="${t('actions.delete')}">✕</button>
                </td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <button class="act-recipient-rep-add mt-2 inline-flex items-center gap-1.5 rounded-xl border border-dashed border-white/20 bg-white/[0.03] px-3 py-2 text-xs font-medium text-slate-400 transition hover:border-cyan-400/30 hover:text-cyan-400 hover:bg-cyan-400/5 w-full justify-center">
        <span aria-hidden="true">＋</span>
        ${tf('receivingSchedule.addRow', 'Добавить строку')}
      </button>
    </div>`;

  wrap.querySelectorAll('.act-recipient-rep-role').forEach(inp => inp.addEventListener('input', () => {
    list[+inp.dataset.idx].role = inp.value;
  }));
  wrap.querySelectorAll('.act-recipient-rep-org').forEach(inp => inp.addEventListener('input', () => {
    list[+inp.dataset.idx].organization = inp.value;
  }));
  wrap.querySelectorAll('.act-recipient-rep-name').forEach(inp => inp.addEventListener('input', () => {
    list[+inp.dataset.idx].name = inp.value;
  }));
  wrap.querySelectorAll('.act-recipient-rep-del').forEach(btn => btn.addEventListener('click', () => {
    list.splice(+btn.dataset.idx, 1);
    if (!list.length) list.push({ role: '', organization: '', name: '' });
    renderRecipientRepresentatives();
  }));
  wrap.querySelector('.act-recipient-rep-add')?.addEventListener('click', () => {
    list.push({ role: '', organization: '', name: '' });
    renderRecipientRepresentatives();
  });
}

// ─── Person list (commission / supplier reps) — table layout ──────

function renderCommission() {
  const wrap = document.getElementById('actCommissionWrap');
  if (wrap) renderPersonList(wrap, _data.commission, 'comm', renderCommission);
}

function renderSupplierReps() {
  const wrap = document.getElementById('actSupplierRepsWrap');
  if (!wrap) return;

  const contract = _data.contractId ? state.contracts.find(c => c.id === _data.contractId) : null;
  const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;

  renderPersonList(wrap, _data.supplierReps, 'srep', renderSupplierReps, supplier?.name);
}

function renderInvitedExperts() {
  const wrap = document.getElementById('actInvitedExpertsWrap');
  if (!wrap) return;

  const experts = state.invitedExperts || [];
  const selectedIds = new Set((_data.invitedExperts || []).map(item => Number(item.id)));

  if (experts.length === 0) {
    wrap.innerHTML = `<p class="text-xs text-slate-500 py-2">${t('experts.emptyForAct')}</p>`;
    return;
  }

  wrap.innerHTML = `
    <div class="grid gap-3">
      ${experts.map(expert => {
        const checked = selectedIds.has(Number(expert.id));
        return `
          <label class="flex items-start gap-3 rounded-2xl border ${checked ? 'border-cyan-400/35 bg-cyan-400/[0.06]' : 'border-white/10 bg-white/[0.03]'} px-4 py-3 cursor-pointer transition hover:border-cyan-400/25 hover:bg-white/[0.05]">
            <input type="checkbox" class="act-invited-expert-cb mt-0.5 h-4 w-4 accent-cyan-400" data-id="${expert.id}" ${checked ? 'checked' : ''}>
            <div class="min-w-0">
              <p class="text-sm font-semibold text-white">${esc(expert.name || t('act.nameLabel'))}</p>
              <p class="text-xs text-slate-400 mt-0.5">${esc(expert.role || '—')}</p>
              <p class="text-xs text-slate-500 mt-0.5">${esc(expert.organization || '—')}</p>
            </div>
          </label>`;
      }).join('')}
    </div>`;

  wrap.querySelectorAll('.act-invited-expert-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = Number(cb.dataset.id);
      const source = experts.find(item => Number(item.id) === id);
      if (!source) return;
      if (cb.checked) {
        if (!_data.invitedExperts.some(item => Number(item.id) === id)) {
          _data.invitedExperts.push({
            id: source.id,
            role: source.role || '',
            organization: source.organization || '',
            name: source.name || '',
          });
        }
      } else {
        _data.invitedExperts = _data.invitedExperts.filter(item => Number(item.id) !== id);
      }
      renderInvitedExperts();
    });
  });
}

function renderSupplierNotice() {
  const wrap = document.getElementById('actSupplierNoticeWrap');
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="act-supplier-notice-grid grid grid-cols-1 sm:grid-cols-2 gap-4">
      <div>
        <label for="actSupplierNoticeNumber" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.fieldSupplierNoticeNumber', 'Номер письма')}</label>
        <input id="actSupplierNoticeNumber" type="text"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${tf('act.supplierNoticeNumberPlaceholder', 'Например: 15/П')}"
          value="${esc(_data.supplierNoticeNumber || '')}">
      </div>
      <div>
        <label for="actSupplierNoticeDate" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.fieldSupplierNoticeDate', 'Дата письма')}</label>
        <input id="actSupplierNoticeDate" type="date"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          value="${esc(_data.supplierNoticeDate || '')}">
      </div>
      <div class="sm:col-span-2">
        <label for="actSupplierPowerOfAttorney" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.fieldSupplierPowerOfAttorney', 'Доверенность представителя поставщика')}</label>
        <input id="actSupplierPowerOfAttorney" type="text"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${tf('act.supplierPowerOfAttorneyPlaceholder', 'Номер, дата или иные реквизиты доверенности')}"
          value="${esc(_data.supplierPowerOfAttorney || '')}">
      </div>
    </div>
    <p class="mt-2 text-xs text-slate-500">${tf('act.supplierNoticeHint', 'В акт будет добавлен текст «извещён письмом» с указанными номером и датой')}</p>`;

  document.getElementById('actSupplierNoticeNumber')?.addEventListener('input', e => {
    _data.supplierNoticeNumber = e.target.value;
  });
  document.getElementById('actSupplierNoticeDate')?.addEventListener('input', e => {
    _data.supplierNoticeDate = e.target.value;
  });
  document.getElementById('actSupplierPowerOfAttorney')?.addEventListener('input', e => {
    _data.supplierPowerOfAttorney = e.target.value;
  });
}

function renderPersonList(wrap, list, prefix, rerender, sectionLabel) {
  const inputCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

  // For commission rows — build datalist from state.commission
  const isComm = prefix === 'comm';
  const commMembers = isComm ? (state.commission || []) : [];
  const datalistId = isComm ? 'actCommRoleDatalist' : '';
  const datalistHtml = isComm && commMembers.length > 0
    ? `<datalist id="${datalistId}">${commMembers.map(m => `<option value="${esc(m.role)}" data-name="${esc(m.name)}">`).join('')}</datalist>`
    : '';

  // Explicit selection from saved commission composition + quick-fill buttons
  const quickFillHtml = isComm && commMembers.length > 0
    ? `<div class="mb-3 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] p-3">
        <p class="text-xs font-semibold uppercase tracking-wider text-cyan-400 mb-2">Выбрать из состава комиссии</p>
        <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
          <select class="comm-quick-select flex-1 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white">
            <option value="">Выберите члена комиссии…</option>
            ${commMembers.map((m, idx) => `<option value="${idx}">${esc(m.name || m.role)}${m.role ? ` — ${esc(m.role)}` : ''}</option>`).join('')}
          </select>
          <button type="button" class="comm-add-from-list-btn inline-flex items-center justify-center gap-1.5 rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-400 transition hover:bg-cyan-400/20">
            ＋ Добавить в акт
          </button>
        </div>
      </div>
      <div class="mb-2 flex flex-wrap gap-1.5">
        <span class="text-xs text-slate-500 self-center">${t('commission.quickAdd')}:</span>
        ${commMembers.map(m => `
          <button type="button" class="comm-quick-btn inline-flex items-center gap-1 rounded-lg
            border border-cyan-400/20 bg-cyan-400/5 px-2.5 py-1 text-xs text-cyan-400
            hover:bg-cyan-400/15 transition" data-role="${esc(m.role)}" data-name="${esc(m.name)}">
            ${esc(m.name ? m.name : m.role)}
          </button>`).join('')}
      </div>`
    : '';

  wrap.innerHTML = `
    ${datalistHtml}
    ${sectionLabel ? `<p class="text-xs text-slate-500 mb-2">${esc(sectionLabel)}</p>` : ''}
    ${quickFillHtml}
    <div class="overflow-hidden rounded-xl border border-white/10">
      <table class="w-full text-sm">
        <thead>
          <tr class="bg-white/[0.04] border-b border-white/10">
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-1/2">${t('act.roleLabel')}</th>
            <th class="px-3 py-2 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 w-1/2">${t('act.nameLabel')}</th>
            <th class="w-10"></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-white/5">
          ${list.map((p, i) => `
            <tr>
              <td class="px-2 py-1.5">
                <input type="text" class="${inputCls} ${prefix}-role"
                  placeholder="${t('act.roleLabel')}" value="${esc(p.role)}" data-idx="${i}">
              </td>
              <td class="px-2 py-1.5">
                <input type="text" class="${inputCls} ${prefix}-name"
                  placeholder="${t('act.nameLabel')}" value="${esc(p.name)}" data-idx="${i}">
              </td>
              <td class="px-2 py-1.5 text-center">
                <button class="w-7 h-7 flex items-center justify-center rounded-lg text-slate-500
                  hover:text-red-400 hover:bg-red-400/10 transition del-person mx-auto"
                  data-idx="${i}" aria-label="${t('actions.delete')}">✕</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <button class="add-person mt-2 inline-flex items-center gap-1.5 rounded-xl border border-dashed
      border-white/20 bg-white/[0.03] px-3 py-2 text-xs font-medium text-slate-400 transition
      hover:border-cyan-400/30 hover:text-cyan-400 hover:bg-cyan-400/5 w-full justify-center">
      <span aria-hidden="true">＋</span>
      ${isComm ? t('act.addCommission') : t('act.addSupplierRep')}
    </button>`;

  wrap.querySelectorAll(`.${prefix}-role`).forEach(inp =>
    inp.addEventListener('input', () => {
      list[+inp.dataset.idx].role = inp.value;
      if (isComm) refreshExpertConclusionUi();
    }));
  wrap.querySelectorAll(`.${prefix}-name`).forEach(inp =>
    inp.addEventListener('input', () => {
      list[+inp.dataset.idx].name = inp.value;
      if (isComm) refreshExpertConclusionUi();
    }));
  wrap.querySelectorAll('.del-person').forEach(btn =>
    btn.addEventListener('click', () => {
      list.splice(+btn.dataset.idx, 1);
      if (!list.length) list.push({ role: '', name: '' });
      rerender();
      if (isComm) refreshExpertConclusionUi();
    }));
  wrap.querySelector('.add-person')?.addEventListener('click', () => {
    list.push({ role: '', name: '' });
    rerender();
    if (isComm) refreshExpertConclusionUi();
  });

  // Quick-fill: add commission member from saved list
  wrap.querySelectorAll('.comm-quick-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const role = btn.dataset.role || '';
      const name = btn.dataset.name || '';
      // Avoid duplicate entries
      const alreadyExists = list.some(p => p.role === role && p.name === name);
      if (!alreadyExists) {
        list.push({ role, name });
        rerender();
        refreshExpertConclusionUi();
      }
    });
  });

  wrap.querySelector('.comm-add-from-list-btn')?.addEventListener('click', () => {
    const select = wrap.querySelector('.comm-quick-select');
    if (!select || !select.value) return;
    const member = commMembers[Number(select.value)];
    if (!member) return;
    const alreadyExists = list.some(p => p.role === member.role && p.name === member.name);
    if (!alreadyExists) {
      list.push({ role: member.role || '', name: member.name || '' });
      rerender();
      refreshExpertConclusionUi();
    }
  });
}

/**
 * Calculates total qty delivered to a specific recipient for a product.
 * Source: state.shipments — same logic as recipients-view delivery history.
 * @param {number|null} recipientId
 * @param {number} productId
 * @returns {number|undefined} — undefined if no recipient selected
 */
function calcDeliveredToRecipient(recipientId, productId) {
  if (!recipientId || !productId) return undefined;
  const prod = state.products.find(p => p.id === productId);
  if (!prod) return undefined;
  const codeNorm = (prod.code || '').trim().toLowerCase();
  const nameNorm = (prod.name || '').trim().toLowerCase();
  let total = 0;
  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      // Match product by productId, code or name
      const rowProd = row.productId === productId
        || (codeNorm && (row.productCode || '').trim().toLowerCase() === codeNorm)
        || (nameNorm && (row.productName || '').trim().toLowerCase() === nameNorm);
      if (!rowProd) continue;
      const recEntry = (row.recipients || []).find(r => r.recipientId === recipientId);
      if (recEntry && recEntry.qty > 0) total += Number(recEntry.qty);
    }
  }
  return total;
}

// ─── Items section ────────────────────────────────────────────────

function renderItems() {
  const wrap = document.getElementById('actItemsWrap');
  if (!wrap) return;

  const contract = _data.contractId ? state.contracts.find(c => c.id === _data.contractId) : null;

  if (!contract) {
    wrap.innerHTML = `<p class="text-xs text-slate-500 py-2">${tf('act.selectContractFirst', 'Выберите контракт, чтобы увидеть товары')}</p>`;
    return;
  }

  const rawItems = (contract.items || []).filter(i => i.name && String(i.name).trim());

  if (!rawItems.length) {
    wrap.innerHTML = `<p class="text-xs text-slate-500 py-2">${t('receiving.noItems')}</p>`;
    return;
  }

  // Sync _data.selectedItems with contract items (preserve existing checkResults/nonConform/siSoNotRequired)
  const existingMap = new Map(_data.selectedItems.map(si => [si.itemIdx, si]));
  const recipientId = _data.recipientId || null; // optional — may be set externally
  _data.selectedItems = rawItems.map((item, idx) => {
    const actHistory = getActHistoryForContractItem(contract, item);
    const product = item.productRef != null
      ? state.products.find(p => p.id === item.productRef)
      : null;
    const rawSpecs = product && Array.isArray(product.specs) ? product.specs : [];
    // Resolve item code: prefer item.code (persisted by contracts-view),
    // but also recompute from productRef + contract.number as fallback
    const resolvedCode = resolveItemCode(item, contract);

    if (existingMap.has(idx)) {
      // Update itemCode in case contract was re-saved
      const existing = existingMap.get(idx);
      existing.itemCode = resolvedCode;
      existing.unit = item.unit || existing.unit || product?.unit || (Array.isArray(product?.specs) ? product.specs[0]?.unit : '') || 'шт.';
      existing._actHistory = actHistory;
      if (actHistory.hasPositive && _mode === 'so') existing.selected = false;
      existing.notDelivered = !!existing.notDelivered;
      // Refresh delivered-to-recipient count
      if (item.productRef != null) {
        existing._deliveredToRecipient = calcDeliveredToRecipient(recipientId, item.productRef);
      }
      return existing;
    }
    return {
      itemIdx: idx,
      itemCode: resolvedCode,   // code for cross-module matching
      name: product ? product.name : (item.name || ''),
      description: existingMap.get(idx)?.description || '',
      unit: item.unit || product?.unit || rawSpecs?.[0]?.unit || 'шт.',
      selected: false,
      contractQty: item.qty || '',   // кол-во по контракту
      qty: '',                        // фактическое кол-во (для mode=delivery)
      notDelivered: false,
      _deliveredToRecipient: item.productRef != null
        ? calcDeliveredToRecipient(recipientId, item.productRef)
        : undefined,
      _actHistory: actHistory,
      siSoNotRequired: false,         // устанавливается пользователем в акте СО
      normDocEnabled: false,
      normDocConforms: true,
      normDocComment: '',
      specs: rawSpecs.map(s => ({
        param: s.param || '',
        unit: s.unit || '',
        value: s.value || '',
        checkResult: '',
        nonConform: false,
      })),
    };
  });

  // Строим карточки всех товаров
  const cardPairs = _data.selectedItems.map((si, i) => buildItemCard(si, i));

  wrap.innerHTML = `<div class="space-y-3">
    ${cardPairs.join('')}
  </div>`;

  // Wire item checkboxes (select/deselect item)
  wrap.querySelectorAll('.act-item-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      _data.selectedItems[i].selected = cb.checked;
      const body = wrap.querySelector(`.act-item-body[data-i="${i}"]`);
      if (body) body.classList.toggle('hidden', !cb.checked);
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });

  wrap.querySelectorAll('.act-not-delivered-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.i;
      setItemNotDelivered(i, !_data.selectedItems[i].notDelivered);
      rerenderItemCard(wrap, i);
      refreshExpertConclusionUi();
    });
  });

  // Wire «СО не предусмотрен» checkboxes (SO mode only)
  wrap.querySelectorAll('.act-si-so-not-required-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      _data.selectedItems[i].siSoNotRequired = cb.checked;
      // Redraw just this card
      const cardEl = wrap.querySelector(`.act-item-card[data-i="${i}"]`);
      if (cardEl) {
        const newHtml = buildItemCard(_data.selectedItems[i], i);
        const tmp = document.createElement('div');
        tmp.innerHTML = newHtml;
        cardEl.replaceWith(tmp.firstElementChild);
        // Re-wire events for the replaced card
        rewireItemCard(wrap, i);
      }
    });
  });

  // Wire check result inputs
  wrap.querySelectorAll('.act-check-inp').forEach(inp => {
    inp.addEventListener('input', () => {
      _data.selectedItems[+inp.dataset.i].specs[+inp.dataset.s].checkResult = inp.value;
      updateItemCardVisualState(wrap, +inp.dataset.i);
    });
  });

  wrap.querySelectorAll('.act-item-description').forEach(inp => {
    inp.addEventListener('input', () => {
      _data.selectedItems[+inp.dataset.i].description = inp.value;
    });
  });

  // Wire non-conform toggles (red/green slider per spec row)
  wrap.querySelectorAll('.act-nonconform-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      const s = +cb.dataset.s;
      _data.selectedItems[i].specs[s].nonConform = cb.checked;
      // Update visual slider
      const row = cb.closest('tr');
      if (!row) return;
      const track = row.querySelector('.nc-track');
      const dot   = row.querySelector('.nc-dot');
      const lbl   = row.querySelector('.nc-label');
      if (track) {
        track.classList.toggle('bg-green-500/70', cb.checked);
        track.classList.toggle('bg-red-500/60',  !cb.checked);
      }
      if (dot) {
        dot.classList.toggle('translate-x-5', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (lbl) {
        lbl.textContent = cb.checked ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание');
        lbl.classList.toggle('text-green-400', cb.checked);
        lbl.classList.toggle('text-red-400',  !cb.checked);
      }
      row.classList.toggle('bg-green-500/5', cb.checked);
      row.classList.toggle('bg-red-500/5',  !cb.checked);
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });

  // Wire normDoc toggle (enable/disable the section)
  wrap.querySelectorAll('.act-normdoc-toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.i;
      _data.selectedItems[i].normDocEnabled = !_data.selectedItems[i].normDocEnabled;
      const section = wrap.querySelector(`.act-normdoc-section[data-i="${i}"]`);
      const icon = btn.querySelector('.nd-icon');
      if (section) section.classList.toggle('hidden', !_data.selectedItems[i].normDocEnabled);
      if (icon) icon.textContent = _data.selectedItems[i].normDocEnabled ? '▲' : '▼';
      btn.setAttribute('aria-expanded', String(_data.selectedItems[i].normDocEnabled));
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });

  // Wire normDoc conforms checkbox
  wrap.querySelectorAll('.act-normdoc-conforms-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      _data.selectedItems[i].normDocConforms = cb.checked;
      const track = cb.closest('label')?.querySelector('div > div');
      const dot   = cb.closest('label')?.querySelector('div > div > div');
      const lbl   = wrap.querySelector(`.act-normdoc-conforms-lbl[data-i="${i}"]`);
      if (track) {
        track.classList.toggle('bg-green-500/70', cb.checked);
        track.classList.toggle('bg-red-500/60',  !cb.checked);
      }
      if (dot) {
        dot.classList.toggle('translate-x-5', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (lbl) {
        lbl.textContent = cb.checked ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание');
        lbl.className = `act-normdoc-conforms-lbl text-sm font-semibold ${cb.checked ? 'text-green-400' : 'text-red-400'}`;
      }
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });

  // Wire normDoc comment textarea
  wrap.querySelectorAll('.act-normdoc-comment').forEach(ta => {
    ta.addEventListener('input', () => {
      _data.selectedItems[+ta.dataset.i].normDocComment = ta.value;
    });
  });

  // Wire qty inputs (delivery mode)
  wrap.querySelectorAll('.act-qty-inp').forEach(inp => {
    inp.addEventListener('input', () => {
      _data.selectedItems[+inp.dataset.i].qty = inp.value;
      updateItemCardVisualState(wrap, +inp.dataset.i);
      refreshExpertConclusionUi();
    });
  });

  // Wire shipping-allowed toggles (delivery mode only)
  wrap.querySelectorAll('.act-shipping-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      _data.selectedItems[i].shippingAllowed = cb.checked;
      const card = wrap.querySelector(`.act-item-body[data-i="${i}"]`)?.closest('.act-item-card');
      if (!card) return;
      const visual = card.querySelector('.act-shipping-visual');
      const dot    = visual?.querySelector('div');
      const label  = card.querySelector('.act-shipping-label');
      if (visual) {
        visual.classList.toggle('bg-green-500/80', cb.checked);
        visual.classList.toggle('bg-red-500/60',   !cb.checked);
      }
      if (dot) {
        dot.classList.toggle('translate-x-4', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (label) {
        label.textContent = cb.checked ? 'Разрешена' : 'Запрещена';
        label.classList.toggle('text-green-400', cb.checked);
        label.classList.toggle('text-red-400',   !cb.checked);
      }
    });
  });

  wrap.querySelectorAll('.act-so-conforms-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const i = +cb.dataset.i;
      _data.selectedItems[i].soConforms = cb.checked;
      // Update visual toggle
      const card = wrap.querySelector(`.act-item-body[data-i="${i}"]`)?.closest('.act-item-card');
      if (!card) return;
      const visual = card.querySelector('.act-so-visual');
      const dot = visual?.querySelector('div');
      const label = card.querySelector('.act-so-label');
      if (visual) {
        if (cb.checked) {
          visual.classList.remove('bg-red-500/60');
          visual.classList.add('bg-green-500/80');
        } else {
          visual.classList.remove('bg-green-500/80');
          visual.classList.add('bg-red-500/60');
        }
      }
      if (dot) {
        dot.classList.toggle('translate-x-4', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (label) {
        label.textContent = cb.checked ? '✓ Соответствует' : '✗ Не соответствует';
        label.classList.toggle('text-green-400', cb.checked);
        label.classList.toggle('text-red-400', !cb.checked);
      }
      // Update card border color
      card.classList.toggle('border-green-500/30', cb.checked);
      card.classList.toggle('border-red-500/20', !cb.checked && _data.selectedItems[i].selected !== false);
      card.classList.toggle('border-white/10', !cb.checked);
      updateItemCardVisualState(wrap, i);
    });
  });
}

function setItemNotDelivered(index, value) {
  const item = _data.selectedItems[index];
  if (!item) return;
  item.notDelivered = !!value;
  if (!item.notDelivered) return;

  item.qty = '';
  item.shippingAllowed = false;
  item.normDocEnabled = false;
  item.normDocConforms = false;
  item.normDocComment = '';
  (item.specs || []).forEach(spec => {
    spec.checkResult = '';
    spec.nonConform = false;
  });
}

function rerenderItemCard(wrap, i) {
  const cardEl = wrap.querySelector(`.act-item-card[data-i="${i}"]`);
  if (!cardEl) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = buildItemCard(_data.selectedItems[i], i);
  cardEl.replaceWith(tmp.firstElementChild);
  rewireItemCard(wrap, i);
}

/**
 * Re-wire events for a single replaced card (after siSoNotRequired toggle).
 * Only wires events specific to that card index.
 */
function rewireItemCard(wrap, i) {
  // siSoNotRequired checkbox
  wrap.querySelectorAll(`.act-si-so-not-required-cb[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      _data.selectedItems[i].siSoNotRequired = cb.checked;
      const cardEl = wrap.querySelector(`.act-item-card[data-i="${i}"]`);
      if (cardEl) {
        const tmp = document.createElement('div');
        tmp.innerHTML = buildItemCard(_data.selectedItems[i], i);
        cardEl.replaceWith(tmp.firstElementChild);
        rewireItemCard(wrap, i);
      }
    });
  });
  // item select checkbox
  wrap.querySelectorAll(`.act-item-cb[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      _data.selectedItems[i].selected = cb.checked;
      const body = wrap.querySelector(`.act-item-body[data-i="${i}"]`);
      if (body) body.classList.toggle('hidden', !cb.checked);
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  wrap.querySelectorAll(`.act-not-delivered-btn[data-i="${i}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      setItemNotDelivered(i, !_data.selectedItems[i].notDelivered);
      rerenderItemCard(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  // SO conforms toggle
  wrap.querySelectorAll(`.act-so-conforms-cb[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      _data.selectedItems[i].soConforms = cb.checked;
      const card = wrap.querySelector(`.act-item-card[data-i="${i}"]`);
      if (!card) return;
      const visual = card.querySelector('.act-so-visual');
      const dot = visual?.querySelector('div');
      const label = card.querySelector('.act-so-label');
      if (visual) {
        visual.classList.toggle('bg-green-500/80', cb.checked);
        visual.classList.toggle('bg-red-500/60', !cb.checked);
      }
      if (dot) {
        dot.classList.toggle('translate-x-4', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (label) {
        label.textContent = cb.checked ? '✓ Соответствует' : '✗ Не соответствует';
        label.classList.toggle('text-green-400', cb.checked);
        label.classList.toggle('text-red-400', !cb.checked);
      }
      updateItemCardVisualState(wrap, i);
    });
  });
  // check result inputs
  wrap.querySelectorAll(`.act-check-inp[data-i="${i}"]`).forEach(inp => {
    inp.addEventListener('input', () => {
      if (_data.selectedItems[i].notDelivered) return;
      _data.selectedItems[i].specs[+inp.dataset.s].checkResult = inp.value;
      updateItemCardVisualState(wrap, i);
    });
  });
  wrap.querySelectorAll(`.act-item-description[data-i="${i}"]`).forEach(inp => {
    inp.addEventListener('input', () => {
      _data.selectedItems[i].description = inp.value;
    });
  });
  wrap.querySelectorAll(`.act-qty-inp[data-i="${i}"]`).forEach(inp => {
    inp.addEventListener('input', () => {
      if (_data.selectedItems[i].notDelivered) return;
      _data.selectedItems[i].qty = inp.value;
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  wrap.querySelectorAll(`.act-shipping-cb[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      if (_data.selectedItems[i].notDelivered) {
        cb.checked = false;
        return;
      }
      _data.selectedItems[i].shippingAllowed = cb.checked;
      const card = wrap.querySelector(`.act-item-body[data-i="${i}"]`)?.closest('.act-item-card');
      if (!card) return;
      const visual = card.querySelector('.act-shipping-visual');
      const dot    = visual?.querySelector('div');
      const label  = card.querySelector('.act-shipping-label');
      if (visual) {
        visual.classList.toggle('bg-green-500/80', cb.checked);
        visual.classList.toggle('bg-red-500/60', !cb.checked);
      }
      if (dot) {
        dot.classList.toggle('translate-x-4', cb.checked);
        dot.classList.toggle('translate-x-0', !cb.checked);
      }
      if (label) {
        label.textContent = cb.checked ? 'Разрешена' : 'Запрещена';
        label.classList.toggle('text-green-400', cb.checked);
        label.classList.toggle('text-red-400', !cb.checked);
      }
    });
  });
  // nonconform toggles
  wrap.querySelectorAll(`.act-nonconform-toggle[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      if (_data.selectedItems[i].notDelivered) {
        cb.checked = false;
        return;
      }
      const s = +cb.dataset.s;
      _data.selectedItems[i].specs[s].nonConform = cb.checked;
      const row = cb.closest('tr');
      if (!row) return;
      const track = row.querySelector('.nc-track');
      const dot   = row.querySelector('.nc-dot');
      const lbl   = row.querySelector('.nc-label');
      if (track) { track.classList.toggle('bg-green-500/70', cb.checked); track.classList.toggle('bg-red-500/60', !cb.checked); }
      if (dot)   { dot.classList.toggle('translate-x-5', cb.checked); dot.classList.toggle('translate-x-0', !cb.checked); }
      if (lbl)   { lbl.textContent = cb.checked ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание'); lbl.classList.toggle('text-green-400', cb.checked); lbl.classList.toggle('text-red-400', !cb.checked); }
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  // normDoc toggle
  wrap.querySelectorAll(`.act-normdoc-toggle-btn[data-i="${i}"]`).forEach(btn => {
    btn.addEventListener('click', () => {
      if (_data.selectedItems[i].notDelivered) return;
      _data.selectedItems[i].normDocEnabled = !_data.selectedItems[i].normDocEnabled;
      const section = wrap.querySelector(`.act-normdoc-section[data-i="${i}"]`);
      const icon = btn.querySelector('.nd-icon');
      if (section) section.classList.toggle('hidden', !_data.selectedItems[i].normDocEnabled);
      if (icon) icon.textContent = _data.selectedItems[i].normDocEnabled ? '▲' : '▼';
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  // normDoc conforms
  wrap.querySelectorAll(`.act-normdoc-conforms-cb[data-i="${i}"]`).forEach(cb => {
    cb.addEventListener('change', () => {
      if (_data.selectedItems[i].notDelivered) {
        cb.checked = false;
        return;
      }
      _data.selectedItems[i].normDocConforms = cb.checked;
      const lbl = wrap.querySelector(`.act-normdoc-conforms-lbl[data-i="${i}"]`);
      if (lbl) { lbl.textContent = cb.checked ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание'); lbl.className = `act-normdoc-conforms-lbl text-sm font-semibold ${cb.checked ? 'text-green-400' : 'text-red-400'}`; }
      updateItemCardVisualState(wrap, i);
      refreshExpertConclusionUi();
    });
  });
  // normDoc comment
  wrap.querySelectorAll(`.act-normdoc-comment[data-i="${i}"]`).forEach(ta => {
    ta.addEventListener('input', () => {
      if (_data.selectedItems[i].notDelivered) return;
      _data.selectedItems[i].normDocComment = ta.value;
    });
  });
}

function buildItemCard(si, i) {
  const checked = si.selected !== false;
  const isDelivery = _mode === 'delivery';
  const isSOMode = _mode === 'so';
  const actHistory = si._actHistory || { all: [], soEntries: [], deliveryEntries: [], positiveEntries: [], negativeEntries: [], hasPositive: false };
  const soHistory = actHistory;
  const soPositiveEntry = soHistory.positiveEntries?.[0] || null;
  const soBlocked = isSOMode && !!soHistory.hasPositive;
  const hasAnyHistory = (actHistory.all?.length || 0) > 0;
  const siSoNotRequired = !!si.siSoNotRequired;
  const notDelivered = !!si.notDelivered;
  const inputCls = 'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

  // Quantity row (only for delivery mode)
  const qtyRowHtml = isDelivery ? `
    <div class="flex flex-wrap items-center gap-3 mt-2 mb-3 rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5">
      <div class="flex items-center gap-3 text-xs text-slate-400">
        <span>По контракту:</span>
        <span class="font-semibold text-slate-200">${esc(String(si.contractQty || '—'))}</span>
      </div>
      ${si._deliveredToRecipient !== undefined ? `
      <div class="flex items-center gap-3 text-xs text-slate-400">
        <span>🚚 Доставлено:</span>
        <span class="font-semibold text-emerald-400">${si._deliveredToRecipient}</span>
      </div>` : ''}
      <div class="flex items-center gap-2 ml-auto flex-wrap justify-end">
        <label for="actQty_${i}" class="text-xs text-slate-400 whitespace-nowrap">Фактическое количество${si.unit ? `, ${esc(si.unit)}` : ''}:</label>
        <input id="actQty_${i}" type="number" min="0" step="1"
          ${si._deliveredToRecipient !== undefined ? `max="${si._deliveredToRecipient}"` : ''}
          ${notDelivered ? 'disabled' : ''}
          class="act-qty-inp w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-sm text-white text-right
            transition focus:border-cyan-400/50 focus:bg-white/[0.07] ${notDelivered ? 'opacity-50 cursor-not-allowed' : ''}"
          placeholder="0" value="${esc(String(notDelivered ? 0 : (si.qty || '')))}" data-i="${i}">
        <button type="button" class="act-not-delivered-btn rounded-lg border px-3 py-1.5 text-xs font-semibold transition ${notDelivered ? 'border-red-400/35 bg-red-500/15 text-red-300' : 'border-white/10 bg-white/5 text-slate-300 hover:bg-white/10'}" data-i="${i}">
          ${tf('act.notDeliveredBtn', 'Товар не поставлен')}
        </button>
      </div>
      ${notDelivered ? `<span class="w-full text-xs font-semibold text-red-300">${tf('act.notDeliveredHint', 'Поставка по товару не состоялась: количество обнулено, проверки отключены.')}</span>` : ''}
      ${!notDelivered && si._deliveredToRecipient !== undefined && Number(si.qty || 0) > si._deliveredToRecipient ? `
      <span class="text-amber-400 text-xs">⚠ Превышает доставленное (${si._deliveredToRecipient})</span>` : ''}
    </div>` : '';

  // Чекбокс «СО не предусмотрен контрактом» убран — управляется ползунком в карточке контракта
  const soNotRequiredCheckboxHtml = '';

  // Если siSoNotRequired — показываем только зелёную пометку, без спецификаций и SO-тоггла
  const soNotRequiredBannerHtml = isSOMode && siSoNotRequired ? `
    <div class="mt-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 flex items-center gap-2">
      <span class="text-emerald-400 text-base">✓</span>
      <div>
        <p class="text-sm font-semibold text-emerald-400">Не предусмотрен</p>
        <p class="text-xs text-slate-400 mt-0.5">Проверка сигнальных образцов по данному товару не проводится. Статус «Соответствует» будет установлен автоматически.</p>
      </div>
    </div>` : '';
  const descriptionHtml = `
    <div class="mt-3">
      <label for="actItemDescription_${i}" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${tf('act.itemDescription', 'Описание товара')}</label>
      <textarea id="actItemDescription_${i}" rows="2" class="act-item-description w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07] resize-none" data-i="${i}" placeholder="${tf('act.itemDescriptionPlaceholder', 'Укажите описание товара при необходимости')}">${esc(si.description || '')}</textarea>
    </div>`;

  const specsHtml = notDelivered
    ? `<div class="mt-3 rounded-xl border border-red-500/25 bg-red-500/10 px-4 py-3 text-sm text-red-200">${tf('act.notDeliveredTableText', 'Товар не поставлен. Фактические значения характеристик не заполняются.')}</div>`
    : ((!isSOMode || !siSoNotRequired)
      ? (si.specs.length === 0
        ? `<p class="text-xs text-slate-500 italic py-1">${t('act.noSpecs')}</p>`
        : `<div class="overflow-x-auto rounded-xl border border-white/10 mt-2">
            <table class="w-full text-xs">
              <thead class="bg-white/[0.04]">
                <tr>
                  <th class="px-3 py-2 text-left text-slate-400 font-semibold w-1/5">${t('act.colParam')}</th>
                  <th class="px-3 py-2 text-left text-slate-400 font-semibold w-14">${t('act.colUnit')}</th>
                  <th class="px-3 py-2 text-left text-slate-400 font-semibold w-1/5">${t('act.colContractValue')}</th>
                  <th class="px-3 py-2 text-left text-slate-400 font-semibold">${t('act.colCheckResult')}</th>
                  <th class="px-3 py-2 text-left text-slate-400 font-semibold w-36">${tf('act.colRemark', 'Замечание')}</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-white/5">
                ${si.specs.map((spec, s) => `
                  <tr class="${getFieldConforms(spec) ? 'bg-green-500/5' : 'bg-red-500/5'}">
                    <td class="px-3 py-2 text-slate-300">${esc(spec.param || '—')}</td>
                    <td class="px-3 py-2 text-slate-400">${esc(spec.unit || '—')}</td>
                    <td class="px-3 py-2 text-cyan-400/80">${esc(spec.value || '—')}</td>
                    <td class="px-2 py-1.5">
                      <input type="text" class="act-check-inp ${inputCls}"
                        placeholder="${t('act.checkResultPlaceholder')}"
                        value="${esc(spec.checkResult || '')}"
                        data-i="${i}" data-s="${s}">
                    </td>
                    <td class="px-2 py-1.5">
                      <label class="flex items-center gap-2 cursor-pointer select-none whitespace-nowrap">
                        <div class="relative inline-flex items-center">
                          <input type="checkbox" class="act-nonconform-toggle sr-only"
                            data-i="${i}" data-s="${s}" ${getFieldConforms(spec) ? 'checked' : ''}>
                          <div class="nc-track w-11 h-6 rounded-full transition-all duration-200 flex items-center px-0.5 ${getFieldConforms(spec) ? 'bg-green-500/70' : 'bg-red-500/60'}">
                            <div class="nc-dot w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200 ${getFieldConforms(spec) ? 'translate-x-5' : 'translate-x-0'}"></div>
                          </div>
                        </div>
                        <span class="nc-label text-xs font-medium ${getFieldConforms(spec) ? 'text-green-400' : 'text-red-400'}">${getFieldConforms(spec) ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание')}</span>
                      </label>
                    </td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>`)
      : ''); // скрываем спецификации если siSoNotRequired

  // SO conformance toggle (only in SO mode, only if siSoNotRequired = false)
  const soConforms = si.soConforms === true;
  const soToggleHtml = (isSOMode && !siSoNotRequired) ? `
    <div class="mt-3 pt-3 border-t border-white/8 flex items-center gap-3">
      <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Сигнальный образец:</span>
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <div class="relative inline-flex items-center">
          <input type="checkbox" class="act-so-conforms-cb sr-only" data-i="${i}" ${soConforms ? 'checked' : ''}>
          <div class="act-so-visual w-11 h-6 rounded-full transition-all duration-200 flex items-center px-0.5 ${soConforms ? 'bg-green-500/80' : 'bg-red-500/60'}">
            <div class="w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200 ${soConforms ? 'translate-x-5' : 'translate-x-0'}"></div>
          </div>
        </div>
        <span class="act-so-label text-sm font-semibold ${soConforms ? 'text-green-400' : 'text-red-400'}">${soConforms ? '✓ Соответствует' : '✗ Не соответствует'}</span>
      </label>
    </div>` : '';

  const historyToneClass = soBlocked
    ? 'border-red-500/25 bg-red-500/10'
    : 'border-amber-500/25 bg-amber-500/10';
  const historyTitleClass = soBlocked ? 'text-red-300' : 'text-amber-300';
  const historyBodyClass = soBlocked ? 'text-red-100' : 'text-amber-100';
  const actHistoryHtml = hasAnyHistory ? `
    <div class="mt-3 rounded-xl border ${historyToneClass} px-4 py-3">
      ${soBlocked ? `
        <p class="text-sm font-semibold text-red-300">${tf('act.soDuplicatePositiveTitle', 'Повторная положительная проверка СО запрещена')}</p>
        <p class="mt-1 text-xs text-slate-300">${tf('act.soDuplicatePositiveHint', 'По этому товару уже есть положительный акт проверки сигнального образца.')}</p>
        ${soPositiveEntry ? `<p class="mt-2 text-xs text-red-200">• ${esc(soPositiveEntry.resultLabel)} · ${esc(soPositiveEntry.dateLabel)}${soPositiveEntry.location ? ` · ${esc(soPositiveEntry.location)}` : ''}</p>` : ''}
      ` : ''}
      <div class="${soBlocked ? 'mt-3 pt-3 border-t border-red-400/15' : ''}">
        <p class="text-sm font-semibold ${historyTitleClass}">${tf('act.previousChecksTitle', 'Предыдущие проверки по товару')}</p>
        <div class="mt-2 space-y-1.5 max-h-56 overflow-y-auto pr-1">
          ${actHistory.all.map(entry => `<p class="text-xs ${historyBodyClass}">• ${esc(entry.modeLabel)} · ${esc(entry.resultLabel)} · ${esc(entry.dateLabel)}${entry.location ? ` · ${esc(entry.location)}` : ''}</p>`).join('')}
        </div>
      </div>
    </div>` : '';

  // Shipping-allowed toggle (only in delivery mode)
  const shippingAllowed = si.shippingAllowed === true;
  const shippingToggleHtml = (isDelivery && isWarehouseAcceptanceContext() && !notDelivered) ? `
    <div class="mt-3 pt-3 border-t border-white/8 flex items-center gap-3">
      <span class="text-xs font-semibold uppercase tracking-wider text-slate-400">Отгрузка:</span>
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <div class="relative inline-flex items-center">
          <input type="checkbox" class="act-shipping-cb sr-only" data-i="${i}" ${shippingAllowed ? 'checked' : ''}>
          <div class="act-shipping-visual w-11 h-6 rounded-full transition-all duration-200 flex items-center px-0.5 ${shippingAllowed ? 'bg-green-500/80' : 'bg-red-500/60'}">
            <div class="w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200 ${shippingAllowed ? 'translate-x-4' : 'translate-x-0'}"></div>
          </div>
        </div>
        <span class="act-shipping-label text-sm font-semibold ${shippingAllowed ? 'text-green-400' : 'text-red-400'}">${shippingAllowed ? 'Разрешена' : 'Запрещена'}</span>
      </label>
    </div>` : '';

  // ── Нормативные документы (опциональная строка) ──
  const normDocEnabled  = !!si.normDocEnabled;
  const normDocConforms = si.normDocConforms !== false; // default true
  const normDocComment  = si.normDocComment || '';
  const normDocHtml = (!notDelivered && (!isSOMode || !siSoNotRequired)) ? `
    <div class="mt-3 pt-3 border-t border-white/8">
      <button type="button" class="act-normdoc-toggle-btn inline-flex items-center gap-2
        rounded-xl border border-dashed border-cyan-400/25 bg-cyan-400/5
        px-3 py-1.5 text-xs font-medium text-cyan-400
        hover:bg-cyan-400/10 hover:border-cyan-400/50 transition w-full justify-between"
        data-i="${i}" aria-expanded="${normDocEnabled}">
        <span class="flex items-center gap-1.5">
          <span aria-hidden="true">📋</span>
          Иные замечания
        </span>
        <span class="nd-icon text-slate-400">${normDocEnabled ? '▲' : '▼'}</span>
      </button>
      <div class="act-normdoc-section mt-2 space-y-2 ${normDocEnabled ? '' : 'hidden'}" data-i="${i}">
        <label class="flex items-center gap-2.5 cursor-pointer select-none">
          <div class="relative inline-flex items-center">
            <input type="checkbox" class="act-normdoc-conforms-cb sr-only"
              data-i="${i}" ${normDocConforms ? 'checked' : ''}>
            <div class="w-11 h-6 rounded-full transition-all duration-200 flex items-center px-0.5
              ${normDocConforms ? 'bg-green-500/70' : 'bg-red-500/60'}">
              <div class="w-5 h-5 rounded-full bg-white shadow-sm transition-all duration-200
                ${normDocConforms ? 'translate-x-5' : 'translate-x-0'}"></div>
            </div>
          </div>
          <span class="act-normdoc-conforms-lbl text-sm font-semibold
            ${normDocConforms ? 'text-green-400' : 'text-red-400'}"
            data-i="${i}">${normDocConforms ? tf('act.remarkNone', 'Без замечаний') : tf('act.remarkHas', 'Есть замечание')}</span>
        </label>
        <textarea class="act-normdoc-comment w-full rounded-xl border border-white/10 bg-white/5
          px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]
          resize-none" rows="2"
          placeholder="Комментарий по нормативным документам…"
          data-i="${i}">${esc(normDocComment)}</textarea>
      </div>
    </div>` : '';

  const borderCls = getItemCardBorderClass(si, checked);
  const headerBadge = getItemStatusBadgeHtml(si, checked);

  return `
    <div class="act-item-card rounded-2xl border ${borderCls} bg-white/5 p-4 transition-colors" data-i="${i}">
      <label class="flex items-center gap-3 cursor-pointer select-none">
        <input type="checkbox" class="act-item-cb w-4 h-4 rounded accent-cyan-400"
          data-i="${i}" ${checked ? 'checked' : ''} ${soBlocked ? 'disabled' : ''}>
        <span class="inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded-full bg-white/10 px-2 text-[11px] font-bold text-slate-200">${i + 1}</span>
        <div class="flex-1 min-w-0">
          ${si.itemCode ? `<span class="font-mono text-xs text-cyan-400/80 bg-cyan-400/10 rounded px-1.5 py-0.5 mr-1">${esc(si.itemCode)}</span>` : ''}
          <span class="text-sm font-semibold text-white">${esc(si.name)}</span>
        </div>
        <span class="act-item-status-host">${headerBadge}</span>
      </label>
      ${actHistoryHtml}
      ${soNotRequiredCheckboxHtml}
      <div class="act-item-body mt-2 ${checked ? '' : 'hidden'}" data-i="${i}">
        ${soNotRequiredBannerHtml}
        ${qtyRowHtml}
        ${descriptionHtml}
        ${specsHtml}
        ${soToggleHtml}
        ${shippingToggleHtml}
        ${normDocHtml}
      </div>
    </div>`;
}

// ─── Result fields ────────────────────────────────────────────────

function renderResultFields() {
  const wrap = document.getElementById('actResultSectionWrap');
  if (!wrap) return;

  const areaCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07] resize-none';
  const dateCls = 'w-full max-w-[220px] rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

  wrap.innerHTML = `
    <div class="space-y-4">
      <div>
        <textarea id="actResultPrescription" rows="5" class="${areaCls}"
          placeholder="${tf('act.resultPrescriptionPlaceholder', 'Опишите результаты проверки и предписания пользователю/поставщику…')}">${esc(getResultPrescriptionText(_data))}</textarea>
      </div>
      <div class="max-w-[240px]">
        <label for="actDeadline"
          class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('act.fieldDeadline')}</label>
        <input id="actDeadline" type="date"
          class="${dateCls}"
          value="${esc(_data.deadline)}">
      </div>
      <div id="actExpertConclusionWrap"></div>
    </div>`;

  document.getElementById('actResultPrescription')?.addEventListener('input', e => {
    _data.result = e.target.value;
    _data.prescription = '';
  });
  document.getElementById('actDeadline')?.addEventListener('input', e => { _data.deadline = e.target.value; });
  renderExpertConclusionPanel();
  updateExpertConclusionButton();
}

// ─── Save act to registry ─────────────────────────────────────────

async function onSave() {
  const btn = document.getElementById('actFormSaveBtn');

  // Collect latest DOM values
  _data.location     = document.getElementById('actLocation')?.value               ?? _data.location;
  _data.date         = document.getElementById('actDate')?.value                   ?? _data.date;
  _data.result       = document.getElementById('actResultPrescription')?.value     ?? _data.result;
  _data.prescription = '';
  _data.deadline     = document.getElementById('actDeadline')?.value               ?? _data.deadline;
  _data.supplierNoticeNumber = document.getElementById('actSupplierNoticeNumber')?.value ?? _data.supplierNoticeNumber;
  _data.supplierNoticeDate   = document.getElementById('actSupplierNoticeDate')?.value   ?? _data.supplierNoticeDate;
  _data.supplierPowerOfAttorney = document.getElementById('actSupplierPowerOfAttorney')?.value ?? _data.supplierPowerOfAttorney;

  if (!_data.contractId) {
    showToast(t('actsRegistry.selectContractToSave'), 'error');
    return;
  }

  if (!validateSODuplicatePositive()) {
    return;
  }

  try {
    if (btn) { btn.disabled = true; btn.textContent = '…'; }

    _data.mode = _mode;

    // ── Если контракт не предусматривает проверку СО —
    //    сохраняем акт, но НЕ транслируем результаты в контракт
    const actContract = _data.contractId
      ? state.contracts.find(c => c.id === _data.contractId)
      : null;
    const soNotRequiredByContract = actContract && actContract.soApprovalRequired === false;

    const savedAct = _editActId != null
      ? updateAct(_editActId, { ..._data })
      : saveAct({ ..._data });

    if (_mode === 'delivery' && savedAct) {
      syncInspectionScheduleFromAct(savedAct);
    }

    // ── Синхронизация shippingAllowed в контракт (режим «поставка») ──
    if (_mode === 'delivery' && _data.contractId) {
      const contract = state.contracts.find(c => c.id === _data.contractId);
      if (contract) {
        let contractChanged = false;
        (_data.selectedItems || []).forEach(si => {
          if (si.selected === false) return;
          const contractItem = contract.items.find((ci, idx) => {
            if (si.itemCode && ci.code && ci.code === si.itemCode) return true;
            if (si.itemIdx !== undefined && idx === si.itemIdx) return true;
            return false;
          });
          if (contractItem) {
            const prev = contractItem.receiving?.shippingAllowed;
            const next = si.shippingAllowed === true;
            if (prev !== next) {
              contractItem.receiving = { ...(contractItem.receiving || {}), shippingAllowed: next };
              contractChanged = true;
            }
          }
        });
        if (contractChanged) {
          const { updateContract } = await import('../state.js');
          updateContract(contract.id, { items: contract.items });
        }
      }
    }

    await saveToStorage();
    await commitPendingActMediaDeletes();
    if (_mode === 'delivery' && _data.scheduleEntryId) {
      try {
        const { renderInspectionScheduleBlock } = await import('./receiving-view.js');
        renderInspectionScheduleBlock?.();
      } catch {
        // ignore optional live refresh issues
      }
    }
    showToast(_editActId != null ? 'Акт обновлён' : t('actsRegistry.saved'), 'success');

    // Update badge and refresh registry if open
    const { updateActsBadge, refreshRegistryIfOpen } = await import('./acts-registry-view.js');
    updateActsBadge();
    if (refreshRegistryIfOpen) refreshRegistryIfOpen();

  } catch (err) {
    console.error('Save act error:', err);
    showToast(t('toast.error'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = _editActId != null ? 'Сохранить изменения' : t('actsRegistry.saveBtn');
    }
  }
}

// ─── Generate Word ────────────────────────────────────────────────

async function onGenerate() {
  const btn = document.getElementById('actFormGenerateBtn');
  if (btn) { btn.disabled = true; btn.textContent = t('act.generating'); }

  try {
    await ensureDocxDeps();

    _data.location     = document.getElementById('actLocation')?.value               ?? _data.location;
    _data.date         = document.getElementById('actDate')?.value                   ?? _data.date;
    _data.result       = document.getElementById('actResultPrescription')?.value     ?? _data.result;
    _data.prescription = '';
    _data.deadline     = document.getElementById('actDeadline')?.value               ?? _data.deadline;
    _data.supplierNoticeNumber = document.getElementById('actSupplierNoticeNumber')?.value ?? _data.supplierNoticeNumber;
    _data.supplierNoticeDate   = document.getElementById('actSupplierNoticeDate')?.value   ?? _data.supplierNoticeDate;
    _data.supplierPowerOfAttorney = document.getElementById('actSupplierPowerOfAttorney')?.value ?? _data.supplierPowerOfAttorney;

    const contract = _data.contractId ? state.contracts.find(c => c.id === _data.contractId) : null;
    const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;
    // В режиме СО: товары с siSoNotRequired попадают в акт со статусом «не предусмотрен»
    const selected = _data.selectedItems.filter(si => si.selected !== false);

    _data.mode = _mode;
    const blob = await buildActDocx(_data, contract, supplier, selected);
    const typeLabel = _mode === 'so' ? 'сигнальных_образцов' : 'поставки';
    const fname = `Акт_проверки_${typeLabel}_${contract?.number || 'б_н'}.docx`;
    downloadBlob(blob, fname);
    showToast(t('act.generated'), 'success');
  } catch (err) {
    console.error('Act generation error:', err);
    showToast(t('act.generateError'), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = t('act.generateBtn'); }
  }
}

async function onGenerateExpertConclusion() {
  const btn = document.getElementById('actFormExpertConclusionBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = tf('act.expertConclusionGenerating', 'Формирование…');
  }

  try {
    await ensureDocxDeps();

    _data.location     = document.getElementById('actLocation')?.value               ?? _data.location;
    _data.date         = document.getElementById('actDate')?.value                   ?? _data.date;
    _data.result       = document.getElementById('actResultPrescription')?.value     ?? _data.result;
    _data.prescription = '';
    _data.deadline     = document.getElementById('actDeadline')?.value               ?? _data.deadline;
    _data.supplierNoticeNumber = document.getElementById('actSupplierNoticeNumber')?.value ?? _data.supplierNoticeNumber;
    _data.supplierNoticeDate   = document.getElementById('actSupplierNoticeDate')?.value   ?? _data.supplierNoticeDate;
    _data.supplierPowerOfAttorney = document.getElementById('actSupplierPowerOfAttorney')?.value ?? _data.supplierPowerOfAttorney;

    const contract = _data.contractId ? state.contracts.find(c => c.id === _data.contractId) : null;
    const supplier = contract?.supplierId ? state.suppliers.find(s => s.id === contract.supplierId) : null;
    const selected = _data.selectedItems.filter(si => si.selected !== false);
    const expertItems = selected.filter(isItemAcceptedForExpertConclusion);

    if (_mode !== 'delivery') {
      throw new Error(tf('act.expertConclusionOnlyDelivery', 'Заключение экспертизы формируется только для приёмки поставленного товара.'));
    }

    if (!selected.length) {
      throw new Error(tf('act.expertConclusionNoItems', 'Выберите хотя бы один товар для заключения экспертизы.'));
    }

    if (!expertItems.length) {
      throw new Error(tf('act.expertConclusionPositiveRequired', 'Заключение экспертизы формируется только при положительном результате приёмки.'));
    }

    if (!(_data.expertRepresentatives || []).length) {
      throw new Error(tf('act.expertConclusionResponsibleRequired', 'Выберите ответственных за экспертизу из общего состава комиссии.'));
    }

    const blob = await buildExpertConclusionDocx(_data, contract, supplier, expertItems);
    const fname = `Заключение_экспертизы_${contract?.number || 'б_н'}.docx`;
    downloadBlob(blob, fname);
    showToast(tf('act.expertConclusionGenerated', 'Заключение экспертизы сформировано'), 'success');
  } catch (err) {
    console.error('Expert conclusion generation error:', err);
    showToast(err?.message || tf('act.expertConclusionError', 'Ошибка формирования заключения экспертизы'), 'error');
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = tf('act.expertConclusionBtn', 'Заключение экспертизы');
    }
  }
}

function isPositiveDeliveryResult(selectedItems) {
  return selectedItems.every(si => {
    const qtyOk = Number(si.qty || 0) > 0;
    const specsOk = !Array.isArray(si.specs) || si.specs.length === 0 || si.specs.every(getFieldConforms);
    const normDocOk = !si.normDocEnabled || si.normDocConforms !== false;
    return qtyOk && specsOk && normDocOk;
  });
}

function buildExpertItemDescription(si) {
  const lines = [];
  if (si?.description) lines.push(String(si.description).trim());
  lines.push(...(si.specs || [])
    .filter(spec => spec?.param || spec?.checkResult || spec?.value)
    .map(spec => {
      const label = String(spec.param || '').trim();
      const unit = String(spec.unit || '').trim();
      const actual = String(spec.checkResult || spec.value || '').trim();
      const suffix = unit ? ` ${unit}` : '';
      if (!label && !actual) return '';
      return label ? `${label}: ${actual || '—'}${suffix}` : `${actual || '—'}${suffix}`;
    })
    .filter(Boolean));

  return lines.length ? lines.join('; ') : 'Согласно техническому описанию товара по договору';
}

function buildPositiveConclusionText(selectedItems) {
  return selectedItems.length > 1
    ? 'Товары соответствуют условиям договора и могут быть приняты.'
    : 'Товар соответствует условиям договора и может быть принят.';
}

async function ensureDocxDeps() {
  if (window.JSZip) return;
  try {
    await loadJSZip();
  } catch (err) {
    console.error('JSZip load error:', err);
    throw new Error('Не удалось загрузить библиотеку для формирования Word');
  }
  if (!window.JSZip) {
    throw new Error('Библиотека JSZip недоступна');
  }
}

function estimateRenderedLineCount(text, charsPerLine = 90) {
  const normalized = String(text || '').replace(/\r/g, '');
  if (!normalized.trim()) return 1;
  return normalized
    .split('\n')
    .map(line => Math.max(1, Math.ceil(line.length / charsPerLine)))
    .reduce((sum, value) => sum + value, 0);
}

function estimateActDocxPages(actData, selectedItems) {
  const usablePageHeight = 14570;
  let total = 0;

  total += 1300;
  total += 420 * (6 + (actData?.orderNumber ? 1 : 0));
  total += 500;

  const commissionRows = Math.max(1, (actData?.commission || []).filter(p => p.role || p.name).length);
  total += 320 + (commissionRows * 340);

  const supplierRows = Math.max(1, (actData?.supplierReps || []).filter(p => p.role || p.name).length);
  total += 320 + (supplierRows * 340);

  const participantRows = [
    ...getRecipientRepresentativesList(actData).filter(p => p.role || p.organization || p.name),
    ...((actData?.invitedExperts || []).filter(p => p.role || p.organization || p.name)),
  ].length;
  if (participantRows > 0) {
    total += 320 + 420 + (participantRows * 340);
  }

  total += 700;
  total += 460;

  const isDelivery = !isSOType(actData);
  for (const item of (selectedItems || [])) {
    if (!isDelivery && item?.siSoNotRequired) {
      total += 380;
      continue;
    }
    if (isDelivery && item?.notDelivered) {
      total += 420;
      continue;
    }

    if (item?.description) {
      total += 260 + estimateRenderedLineCount(item.description, 70) * 120;
    }

    const specs = Array.isArray(item?.specs) && item.specs.length
      ? item.specs
      : [{ param: '', unit: '', value: '', checkResult: '' }];

    specs.forEach((spec) => {
      const longestCell = Math.max(
        String(item?.name || '').length,
        String(spec?.param || '').length,
        String(spec?.value || '').length,
        String(spec?.checkResult || '').length,
      );
      total += longestCell > 90 ? 480 : longestCell > 55 ? 400 : 330;
    });

    if (item?.normDocEnabled) {
      total += 300 + estimateRenderedLineCount(item?.normDocComment || '', 75) * 110;
    }
  }

  total += 360;
  total += estimateRenderedLineCount(getResultPrescriptionText(actData), 95) * 170;
  total += 260;
  total += 360;

  const signaturePeople = [
    ...(actData?.commission || []).filter(p => p.role || p.name),
    ...getRecipientRepresentativesList(actData).filter(p => p.role || p.organization || p.name),
    ...((actData?.invitedExperts || []).filter(p => p.role || p.organization || p.name)),
    ...((actData?.supplierReps || []).filter(p => p.role || p.name)),
  ].length;
  total += 460;
  total += Math.max(1, signaturePeople) * 620;

  total += 420;

  return Math.max(1, Math.ceil(total / usablePageHeight));
}

// ─── DOCX builder ─────────────────────────────────────────────────

/**
 * Exported so acts-registry-view can re-generate Word from saved act data.
 */
export async function buildActDocx(actData, contract, supplier, selectedItems) {
  const actDate       = fmtDate(actData.date || _data.date);
  const contractDate  = contract?.date ? fmtDate(contract.date) : '';
  const contractNum   = contract?.number || '';
  const contractTitle = contract?.title || '';
  const supplierName  = supplier?.name || (contract ? t('contracts.noSupplier') : '');

  // Use actData fields (supports both _data and saved act objects)
  const location = actData.location ?? '';
  const resultPrescription = getResultPrescriptionText(actData);
  const deadline = actData.deadline ?? '';
  const supplierNoticeNumber = actData.supplierNoticeNumber || '';
  const supplierNoticeDate = actData.supplierNoticeDate || '';
  const orderLabel = actData.orderNumber || resolveActOrder(actData.orderId, actData.contractId)?.orderNumber || '';
  const totalPages = estimateActDocxPages(actData, selectedItems);

  // ── Mode-dependent text ──
  const isSO = isSOType(actData);
  const actTypeTitle = isSO
    ? 'АКТ ПРОВЕРКИ СИГНАЛЬНЫХ ОБРАЗЦОВ'
    : 'АКТ ПРОВЕРКИ ПОСТАВЛЕННОГО ТОВАРА';
  const subtitleLine = `по договору от ${contractDate} г. № ${contractNum}`;
  const bodyLine = isSO
    ? 'Комиссия провела проверку представленных поставщиком сигнальных образцов. По результатам проверки установлено:'
    : 'Комиссия провела проверку поставленного товара и исполнения условий договора. По результатам проверки установлено:';

  // ── Commission table ──
  const commFiltered = (actData.commission || []).filter(p => p.role || p.name);
  const commTable = xmlPersonTable(commFiltered);

  // ── Supplier rep table ──
  const supplierRepFiltered = (actData.supplierReps || []).filter(p => p.role || p.name);
  const supplierRepTable = supplierRepFiltered.length > 0
    ? xmlPersonTable(supplierRepFiltered)
    : null;
  const recipientRepFiltered = getRecipientRepresentativesList(actData)
    .filter(person => person.role || person.organization || person.name);

  const invitedExpertsFiltered = (actData.invitedExperts || [])
    .filter(expert => expert.role || expert.organization || expert.name);
  const participantsTable = [...recipientRepFiltered, ...invitedExpertsFiltered].length > 0
    ? xmlExpertsTable([...recipientRepFiltered, ...invitedExpertsFiltered])
    : null;

  // ── Table rows — nonConform specs are bold ──
  const isDelivery = !isSO;
  let tableRows = '';
  let rowNum = 1;
  for (const si of selectedItems) {
    const overallConforms = getItemOverallConforms(si);
    const overallText = overallConforms ? 'Да' : 'Нет';
    const displayRowNumber = String(rowNum);
    const itemUnit = String(si.unit || '').trim() || 'шт.';
    if (isSO && si.siSoNotRequired) {
      const cells = [displayRowNumber, si.itemCode || '', si.name, itemUnit];
      cells.push('—', '—', '—', 'Не предусмотрен контрактом', 'Да');
      tableRows += xmlTableRow(cells, false, false, isDelivery);
      rowNum++;
      continue;
    }

    if (isDelivery && si.notDelivered) {
      const cells = [displayRowNumber, si.itemCode || '', si.name, itemUnit, String(si.contractQty || ''), '0'];
      cells.push(tf('act.deliveryStatusLabel', 'Статус поставки'), '', '', tf('act.notDeliveredTableTextShort', 'Товар не поставлен'), 'Нет');
      tableRows += xmlTableRow(cells, false, false, true, cells.map(() => true));
      rowNum++;
      continue;
    }

    if (si.description) {
      const descriptionCells = [displayRowNumber, si.itemCode || '', si.name, itemUnit];
      if (isDelivery) {
        descriptionCells.push(String(si.contractQty || ''), String(si.qty || ''));
      }
      descriptionCells.push(tf('act.itemDescription', 'Описание товара'), '', '', si.description, overallText);
      tableRows += xmlTableRow(descriptionCells, false, false, isDelivery, !overallConforms ? descriptionCells.map(() => true) : null);
    }

    const specs = si.specs.length > 0
      ? si.specs
      : [{ param: '', unit: '', value: '', checkResult: '', nonConform: false }];
    specs.forEach((spec, sIdx) => {
      const isFirstItemRow = !si.description && sIdx === 0;
      const cells = [
        sIdx === 0 && !si.description ? displayRowNumber : '',
        sIdx === 0 && !si.description ? (si.itemCode || '') : '',
        sIdx === 0 && !si.description ? si.name : '',
        sIdx === 0 && !si.description ? itemUnit : '',
      ];
      if (isDelivery) {
        cells.push(sIdx === 0 ? String(si.contractQty || '') : '');
        cells.push(sIdx === 0 ? String(si.qty || '') : '');
      }
      cells.push(spec.param || '', spec.unit || '', spec.value || '', spec.checkResult || '', isFirstItemRow ? overallText : '');
      tableRows += xmlTableRow(cells, false, false, isDelivery, !getFieldConforms(spec) ? cells.map(() => true) : null);
    });

    if (si.normDocEnabled) {
      const ndConforms = si.normDocConforms !== false;
      const ndComment  = si.normDocComment || '';
      const ndStatus   = ndConforms ? 'Соответствует' : 'Не соответствует';
      const ndText     = ndComment ? `${ndStatus}: ${ndComment}` : ndStatus;
      const cells = ['', '', '', ''];
      if (isDelivery) { cells.push(''); cells.push(''); }
      cells.push('Иные замечания', '', '', ndText, '');
      tableRows += xmlTableRow(cells, false, false, isDelivery, !ndConforms ? cells.map(() => true) : null);
    }
    rowNum++;
  }

  const commSigTable = xmlSignatureTable(
    commFiltered.map(p => ({ org: '', role: p.role || '', name: toInitials(p.name) }))
  );
  const supplierSigTable = supplierRepFiltered.length > 0
    ? xmlSignatureTable(
        supplierRepFiltered.map(p => ({
          org: supplierName,
          role: p.role || '',
          name: toInitials(p.name),
        }))
      )
    : '';
  const participantSigTable = [...recipientRepFiltered, ...invitedExpertsFiltered].length > 0
    ? xmlSignatureTable(
        [...recipientRepFiltered, ...invitedExpertsFiltered].map(p => ({
          org: p.organization || '',
          role: p.role || '',
          name: toInitials(p.name),
        }))
      )
    : '';

  const metaTable = xmlMetaTable([
    ['Место составления', location || '______________________________'],
    ['Дата составления', actDate || '______________________________'],
    ['Основание', contractNum
      ? `Договор от ${contractDate} г. № ${contractNum}${contractTitle ? `, ${contractTitle}` : ''}`
      : '______________________________'],
    ...(orderLabel ? [['Заявка', orderLabel]] : []),
    ['Поставщик', supplierName || '______________________________'],
    ['Доверенность поставщика', actData.supplierPowerOfAttorney || '______________________________'],
  ]);

  const supplierNoticeText = supplierNoticeNumber || supplierNoticeDate
    ? `Поставщик извещен письмом № ${supplierNoticeNumber || '___'} от ${supplierNoticeDate ? fmtDate(supplierNoticeDate) : '___'}.`
    : 'Поставщик извещен письмом: сведения не указаны.';

  const body = [
    xmlPara(actTypeTitle, true, '0', '28', 'center'),
    xmlPara(subtitleLine, false, '0', '22', 'center'),
    xmlPara(''),
    metaTable,
    xmlPara(''),
    xmlPara('1. Состав комиссии', true, '0', '22'),
    commTable,
    xmlPara(''),
    xmlPara('2. Представители поставщика', true, '0', '22'),
    supplierRepTable
      ? supplierRepTable
      : xmlPara('Представители поставщика к проверке не представлены / не явились, при наличии извещения.', false, '0', '22'),
    xmlPara(supplierNoticeText, false, '0', '22'),
    ...(participantsTable
      ? [
          xmlPara(tf('act.participantsTitle', 'При участии представителей:'), true, '0', '22'),
          participantsTable,
        ]
      : []),
    xmlPara(''),
    xmlPara('3. Предмет проверки', true, '0', '22'),
    xmlPara(bodyLine, false, '0', '22'),
    xmlPara(''),
    xmlPara('4. Результаты проверки', true, '0', '22'),
    xmlTable(tableRows, isDelivery),
    xmlPara(''),
    xmlPara('5. Результаты и предписания', true, '0', '22'),
    xmlPara(resultPrescription || '—', false, '0', '22'),
    xmlPara(''),
    xmlPara(`Срок устранения предписаний: ${deadline ? fmtDate(deadline) : 'не установлен'}`, true, '0', '22'),
    xmlPara(''),
    xmlPara('6. Подписи сторон', true, '0', '22'),
    xmlPara('Комиссия:', true, '0', '22'),
    commSigTable,
    xmlPara(''),
    ...(recipientRepFiltered.length > 0 || invitedExpertsFiltered.length > 0 ? [xmlPara('Представители получателя и приглашённые эксперты:', true, '0', '22')] : []),
    participantSigTable,
    xmlPara(''),
    ...(supplierRepFiltered.length > 0 ? [xmlPara('Представители поставщика:', true, '0', '22')] : []),
    supplierSigTable,
    xmlPara(''),
    xmlPagesSummaryPara(totalPages),
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    <w:sectPr>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"
               w:header="709" w:footer="709" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return buildZip(xml, totalPages);
}

export async function buildExpertConclusionDocx(actData, contract, supplier, selectedItems) {
  const actDate = fmtDate(actData.date || _data.date);
  const contractDate = contract?.date ? fmtDate(contract.date) : '';
  const contractNum = contract?.number || '';
  const contractTitle = contract?.title || '';
  const supplierName = supplier?.name || t('contracts.noSupplier');
  const location = actData.location || '______________________________';
  const orderLabel = actData.orderNumber || resolveActOrder(actData.orderId, actData.contractId)?.orderNumber || '';
  const expertRepresentatives = ((actData.expertRepresentatives || []).length
    ? actData.expertRepresentatives
    : actData.commission || [])
    .filter(p => p.role || p.name);
  const conclusionText = buildPositiveConclusionText(selectedItems);
  const totalPages = estimateActDocxPages(actData, selectedItems);

  const itemRows = selectedItems.map((si, idx) => {
    const cells = [
      String(idx + 1),
      si.name || '',
      si.unit || 'шт.',
      String(si.contractQty || ''),
      String(si.qty || ''),
      buildExpertItemDescription(si),
      'Соответствует',
    ];
    return xmlConclusionTableRow(cells, false);
  }).join('');

  const representativesTitle = expertRepresentatives.length > 1
    ? 'Представители заказчика:'
    : 'Представитель заказчика:';

  const body = [
    xmlPara('Заключение', true, '0', '28', 'center'),
    xmlPara('результатов проведенной экспертизы, предусмотренной Гражданско-правовым договором', true, '0', '22', 'center'),
    xmlPara(''),
    xmlPara(`от ${contractDate || '________________'} № ${contractNum || '________________'}, заключенного с ${supplierName} на поставку товаров${contractTitle ? ` (${contractTitle})` : ''}.`, false, '0', '22'),
    xmlPara(''),
    xmlMetaTable([
      ['Место составления', location],
      ...(orderLabel ? [['Заявка', orderLabel]] : []),
      ['Дата составления', actDate || '______________________________'],
    ]),
    xmlPara(''),
    xmlPara(representativesTitle, true, '0', '22'),
    expertRepresentatives.length ? xmlPersonTable(expertRepresentatives) : xmlPara('______________________________', false, '0', '22'),
    xmlPara(''),
    xmlPara('1. Объект поставки:', true, '0', '22'),
    xmlPara(location, false, '420', '22'),
    xmlPara('2. Основание проведения экспертизы:', true, '0', '22'),
    xmlPara('п. 43.2 Положения о закупках товаров, работ, услуг Государственного автономного учреждения города Москвы «Центр технического оснащения и модернизации образования».', false, '420', '22'),
    xmlPara('3. Цель экспертизы:', true, '0', '22'),
    xmlPara(`проверка соответствия предоставленных результатов условиям Гражданско-правового договора от ${contractDate || '________________'} № ${contractNum || '________________'}, заключенного с ${supplierName}${contractTitle ? ` на ${contractTitle}` : ''}.`, false, '420', '22'),
    xmlPara('4. Информация о товаре (работе, услуге):', true, '0', '22'),
    xmlConclusionTable(itemRows),
    xmlPara(''),
    xmlPara(`Заключение: ${conclusionText}`, true, '0', '22'),
    xmlPara(''),
    xmlPara(representativesTitle, true, '0', '22'),
    xmlSignatureTable(
      expertRepresentatives.map(p => ({ org: '', role: p.role || '', name: toInitials(p.name) }))
    ),
  ].join('');

  const xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document
  xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    <w:sectPr>
      <w:footerReference w:type="default" r:id="rIdFooter1"/>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"
               w:header="709" w:footer="709" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

  return buildZip(xml, totalPages);
}

// ─── XML helpers ──────────────────────────────────────────────────

function xmlPara(text, bold = false, indent = '0', size = '22', align = '') {
  const alignXml  = align  ? `<w:jc w:val="${align}"/>` : '';
  const indentXml = indent && indent !== '0' ? `<w:ind w:left="${indent}"/>` : '';
  const boldXml   = '';
  const sizeXml   = size !== '22' ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : '';
  const textXml = xe(text).replace(/\n/g, '</w:t><w:br/><w:t xml:space="preserve">');
  return `<w:p>
    <w:pPr><w:spacing w:after="120"/>${alignXml}${indentXml}</w:pPr>
    <w:r><w:rPr>${boldXml}${sizeXml}</w:rPr>
      <w:t xml:space="preserve">${textXml}</w:t>
    </w:r>
  </w:p>`;
}

function xmlFieldComplex(instr, fallback = '1', fontSize = '22') {
  return [
    '<w:r>',
    `<w:rPr><w:sz w:val="${fontSize}"/><w:szCs w:val="${fontSize}"/></w:rPr>`,
    '<w:fldChar w:fldCharType="begin"/>',
    '</w:r>',
    '<w:r>',
    `<w:rPr><w:sz w:val="${fontSize}"/><w:szCs w:val="${fontSize}"/></w:rPr>`,
    `<w:instrText xml:space="preserve"> ${xe(instr)} </w:instrText>`,
    '</w:r>',
    '<w:r>',
    `<w:rPr><w:sz w:val="${fontSize}"/><w:szCs w:val="${fontSize}"/></w:rPr>`,
    '<w:fldChar w:fldCharType="separate"/>',
    '</w:r>',
    '<w:r>',
    `<w:rPr><w:sz w:val="${fontSize}"/><w:szCs w:val="${fontSize}"/></w:rPr>`,
    `<w:t>${xe(fallback)}</w:t>`,
    '</w:r>',
    '<w:r>',
    `<w:rPr><w:sz w:val="${fontSize}"/><w:szCs w:val="${fontSize}"/></w:rPr>`,
    '<w:fldChar w:fldCharType="end"/>',
    '</w:r>',
  ].join('');
}

function xmlPagesSummaryPara(totalPages = 1) {
  return `<w:p>
    <w:pPr><w:spacing w:after="120"/></w:pPr>
    <w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve">Акт составлен на </w:t></w:r>
    <w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t>${xe(String(totalPages || 1))}</w:t></w:r>
    <w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr><w:t xml:space="preserve"> страницах.</w:t></w:r>
  </w:p>`;
}

function xmlFooterPagePara(totalPages = 1) {
  return `<w:p>
    <w:pPr><w:jc w:val="right"/></w:pPr>
    <w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve">Страница </w:t></w:r>
    ${xmlFieldComplex('PAGE \\* Arabic', '1', '18')}
    <w:r><w:rPr><w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr><w:t xml:space="preserve"> из ${xe(String(totalPages || 1))}</w:t></w:r>
  </w:p>`;
}

// Invisible-border two-column table for commission / supplier reps
function xmlPersonTable(persons) {
  if (!persons.length) return '';
  const noBorder = `
    <w:top    w:val="none" w:sz="0" w:space="0" w:color="auto"/>
    <w:left   w:val="none" w:sz="0" w:space="0" w:color="auto"/>
    <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>
    <w:right  w:val="none" w:sz="0" w:space="0" w:color="auto"/>
    <w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>
    <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>`;

  const rows = persons.map(p => `<w:tr>
    <w:tc>
      <w:tcPr>
        <w:tcW w:w="4500" w:type="dxa"/>
        <w:tcBorders>${noBorder}</w:tcBorders>
      </w:tcPr>
      <w:p><w:pPr><w:spacing w:after="80"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
          <w:t xml:space="preserve">${xe(p.role || '')}</w:t></w:r></w:p>
    </w:tc>
    <w:tc>
      <w:tcPr>
        <w:tcW w:w="4860" w:type="dxa"/>
        <w:tcBorders>${noBorder}</w:tcBorders>
      </w:tcPr>
      <w:p><w:pPr><w:spacing w:after="80"/></w:pPr>
        <w:r><w:rPr><w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr>
          <w:t xml:space="preserve">${xe(p.name || '')}</w:t></w:r></w:p>
    </w:tc>
  </w:tr>`).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>${noBorder}</w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="4500"/>
      <w:gridCol w:w="4860"/>
    </w:tblGrid>
    ${rows}
  </w:tbl>`;
}

function xmlExpertsTable(experts) {
  if (!experts.length) return '';
  const border = `
    <w:top    w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:left   w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:right  w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>`;

  const rows = experts.map(expert => `<w:tr>
    <w:tc><w:tcPr><w:tcW w:w="2800" w:type="dxa"/></w:tcPr>${xmlCellPara(expert.role || '—', false, 'left')}</w:tc>
    <w:tc><w:tcPr><w:tcW w:w="3200" w:type="dxa"/></w:tcPr>${xmlCellPara(expert.organization || '—', false, 'left')}</w:tc>
    <w:tc><w:tcPr><w:tcW w:w="3360" w:type="dxa"/></w:tcPr>${xmlCellPara(expert.name || '—', false, 'left')}</w:tc>
  </w:tr>`).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>${border}</w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="2800"/>
      <w:gridCol w:w="3200"/>
      <w:gridCol w:w="3360"/>
    </w:tblGrid>
    <w:tr>
      <w:tc><w:tcPr><w:tcW w:w="2800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Должность', true, 'center')}</w:tc>
      <w:tc><w:tcPr><w:tcW w:w="3200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Организация', true, 'center')}</w:tc>
      <w:tc><w:tcPr><w:tcW w:w="3360" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('ФИО', true, 'center')}</w:tc>
    </w:tr>
    ${rows}
  </w:tbl>`;
}

function xmlMetaTable(rows) {
  const border = `
    <w:top    w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:left   w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:right  w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>`;

  const bodyRows = rows.map(([label, value]) => `<w:tr>
    <w:tc>
      <w:tcPr>
        <w:tcW w:w="2400" w:type="dxa"/>
        <w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/>
      </w:tcPr>
      ${xmlCellPara(label, true, 'left')}
    </w:tc>
    <w:tc>
      <w:tcPr><w:tcW w:w="6960" w:type="dxa"/></w:tcPr>
      ${xmlCellPara(value, false, 'left')}
    </w:tc>
  </w:tr>`).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>${border}</w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>
      <w:gridCol w:w="2400"/>
      <w:gridCol w:w="6960"/>
    </w:tblGrid>
    ${bodyRows}
  </w:tbl>`;
}

function xmlCellPara(text, bold = false, align = 'left') {
  return `<w:p>
    <w:pPr><w:jc w:val="${align}"/><w:spacing w:after="60"/></w:pPr>
    <w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr>
      <w:t xml:space="preserve">${xe(text || '')}</w:t>
    </w:r>
  </w:p>`;
}

function xmlSignatureLineCell(width, align = 'center') {
  return `<w:tc>
    <w:tcPr>
      <w:tcW w:w="${width}" w:type="dxa"/>
      <w:vAlign w:val="bottom"/>
      <w:tcBorders>
        <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
        <w:bottom w:val="single" w:sz="8" w:space="0" w:color="7A7A7A"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
      </w:tcBorders>
      <w:tcMar>
        <w:top w:w="240" w:type="dxa"/>
        <w:left w:w="80" w:type="dxa"/>
        <w:bottom w:w="40" w:type="dxa"/>
        <w:right w:w="80" w:type="dxa"/>
      </w:tcMar>
    </w:tcPr>
    <w:p>
      <w:pPr><w:jc w:val="${align}"/><w:spacing w:before="0" w:after="0"/></w:pPr>
      <w:r><w:rPr><w:sz w:val="20"/><w:szCs w:val="20"/></w:rPr><w:t xml:space="preserve"></w:t></w:r>
    </w:p>
  </w:tc>`;
}

// Signature table
function xmlSignatureTable(persons) {
  if (!persons.length) return '';
  const border = `
    <w:top    w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:left   w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:bottom w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:right  w:val="single" w:sz="4" w:space="0" w:color="A6A6A6"/>
    <w:insideH w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>
    <w:insideV w:val="single" w:sz="4" w:space="0" w:color="D9D9D9"/>`;

  const hasOrg = persons.some(p => p.org);
  const header = hasOrg
    ? `<w:tr>
        <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Организация', true, 'center')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Должность', true, 'center')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2000" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Подпись', true, 'center')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Расшифровка подписи', true, 'center')}</w:tc>
      </w:tr>`
    : `<w:tr>
        <w:tc><w:tcPr><w:tcW w:w="3200" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Должность', true, 'center')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2800" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Подпись', true, 'center')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="3360" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr>${xmlCellPara('Расшифровка подписи', true, 'center')}</w:tc>
      </w:tr>`;

  const rows = persons.map(p => {
    if (hasOrg) {
      return `<w:tr>
        <w:trPr><w:trHeight w:val="580" w:hRule="atLeast"/></w:trPr>
        <w:tc><w:tcPr><w:tcW w:w="3000" w:type="dxa"/></w:tcPr>${xmlCellPara(p.org, false, 'left')}</w:tc>
        <w:tc><w:tcPr><w:tcW w:w="2200" w:type="dxa"/></w:tcPr>${xmlCellPara(p.role, false, 'left')}</w:tc>
        ${xmlSignatureLineCell(2000, 'center')}
        <w:tc><w:tcPr><w:tcW w:w="2160" w:type="dxa"/></w:tcPr>${xmlCellPara(p.name, false, 'left')}</w:tc>
      </w:tr>`;
    }
    return `<w:tr>
      <w:trPr><w:trHeight w:val="580" w:hRule="atLeast"/></w:trPr>
      <w:tc><w:tcPr><w:tcW w:w="3200" w:type="dxa"/></w:tcPr>${xmlCellPara(p.role, false, 'left')}</w:tc>
      ${xmlSignatureLineCell(2800, 'center')}
      <w:tc><w:tcPr><w:tcW w:w="3360" w:type="dxa"/></w:tcPr>${xmlCellPara(p.name, false, 'left')}</w:tc>
    </w:tr>`;
  }).join('');

  const gridCols = hasOrg
    ? `<w:gridCol w:w="3000"/><w:gridCol w:w="2200"/><w:gridCol w:w="2000"/><w:gridCol w:w="2160"/>`
    : `<w:gridCol w:w="3200"/><w:gridCol w:w="2800"/><w:gridCol w:w="3360"/>`;

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>${border}</w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${gridCols}</w:tblGrid>
    ${header}
    ${rows}
  </w:tbl>`;
}

function xmlTable(rows, isDelivery = false) {
  const headers = isDelivery
    ? ['№ п/п', 'Код товара', 'Наименование товара', tf('act.colItemUnit', 'Ед. изм. товара'), 'Количество по договору', 'Фактическое количество', 'Параметр', tf('act.colParamUnit', 'Ед. изм. параметра'), 'Значение по договору', 'Фактическое значение', 'Соответствует']
    : ['№ п/п', 'Код товара', 'Наименование товара', tf('act.colItemUnit', 'Ед. изм. товара'), 'Параметр', tf('act.colParamUnit', 'Ед. изм. параметра'), 'Значение по договору', 'Фактическое значение', 'Соответствует'];
  const header = xmlTableRow(headers, true, false, isDelivery);
  const widths = isDelivery
    ? [360, 760, 1180, 620, 650, 650, 920, 520, 1260, 1260, 580]
    : [360, 760, 1500, 700, 1120, 560, 1700, 1700, 960];
  const gridCols = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>
        <w:top    w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:left   w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:right  w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      </w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${gridCols}</w:tblGrid>
    ${header}${rows}
  </w:tbl>`;
}

function xmlTableRow(cells, header = false, boldRow = false, isDelivery = false, boldCells = null) {
  const widths = isDelivery
    ? [360, 760, 1180, 620, 650, 650, 920, 520, 1260, 1260, 580]
    : [360, 760, 1500, 700, 1120, 560, 1700, 1700, 960];
  const cellsXml = cells.map((text, i) => {
    const isBold = header || boldRow || (boldCells ? !!boldCells[i] : false);
    const boldXml    = '';
    const shadingXml = header ? '<w:shd w:val="clear" w:color="auto" w:fill="D9EAF7"/>' : '';
    return `<w:tc>
      <w:tcPr>${shadingXml}<w:tcW w:w="${widths[i] ?? 1000}" w:type="dxa"/></w:tcPr>
      <w:p><w:pPr><w:jc w:val="${header ? 'center' : 'left'}"/>
        <w:spacing w:after="60"/>
      </w:pPr>
        <w:r><w:rPr>${boldXml}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
          <w:t xml:space="preserve">${xe(String(text ?? ''))}</w:t>
        </w:r>
      </w:p>
    </w:tc>`;
  }).join('');
  return `<w:tr>${cellsXml}</w:tr>`;
}

function xmlConclusionTable(rows) {
  const headers = ['№ п.п.', 'Наименование товара', 'Ед. изм.', 'Кол-во по заявке', 'факт', 'Техническое описание фактически поставленного товара', 'Соответствие / не соответствие'];
  const widths = [500, 1800, 700, 950, 700, 3000, 1710];
  const gridCols = widths.map(w => `<w:gridCol w:w="${w}"/>`).join('');
  const header = xmlConclusionTableRow(headers, true);

  return `<w:tbl>
    <w:tblPr>
      <w:tblW w:w="9360" w:type="dxa"/>
      <w:tblBorders>
        <w:top    w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:left   w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:right  w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="auto"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="auto"/>
      </w:tblBorders>
      <w:tblLayout w:type="fixed"/>
    </w:tblPr>
    <w:tblGrid>${gridCols}</w:tblGrid>
    ${header}${rows}
  </w:tbl>`;
}

function xmlConclusionTableRow(cells, header = false) {
  const widths = [500, 1800, 700, 950, 700, 3000, 1710];
  const cellsXml = cells.map((text, i) => {
    const boldXml = '';
    const shadingXml = header ? '<w:shd w:val="clear" w:color="auto" w:fill="D9EAF7"/>' : '';
    return `<w:tc>
      <w:tcPr>${shadingXml}<w:tcW w:w="${widths[i] ?? 1000}" w:type="dxa"/></w:tcPr>
      <w:p>
        <w:pPr><w:jc w:val="${header ? 'center' : 'left'}"/><w:spacing w:after="60"/></w:pPr>
        <w:r><w:rPr>${boldXml}<w:sz w:val="18"/><w:szCs w:val="18"/></w:rPr>
          <w:t xml:space="preserve">${xe(String(text ?? ''))}</w:t>
        </w:r>
      </w:p>
    </w:tc>`;
  }).join('');
  return `<w:tr>${cellsXml}</w:tr>`;
}

function xe(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ─── ZIP builder ──────────────────────────────────────────────────

async function buildZip(documentXml, totalPages = 1) {
  const JSZip = window.JSZip;
  if (!JSZip) throw new Error('JSZip not loaded');

  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml"  ContentType="application/xml"/>
  <Override PartName="/docProps/app.xml"
    ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/footer1.xml"
    ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>
</Types>`);

  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdApp"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties"
    Target="docProps/app.xml"/>
  <Relationship Id="rId1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument"
    Target="word/document.xml"/>
</Relationships>`);

  zip.file('docProps/app.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>MiniApps</Application>
  <Pages>0</Pages>
  <Words>0</Words>
  <Characters>0</Characters>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>1.0</AppVersion>
</Properties>`);

  zip.file('word/document.xml', documentXml);

  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rIdFooter1"
    Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer"
    Target="footer1.xml"/>
</Relationships>`);

  zip.file('word/footer1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  ${xmlFooterPagePara(totalPages)}
</w:ftr>`);

  return zip.generateAsync({
    type: 'blob',
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Helpers ──────────────────────────────────────────────────────

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  } catch { return iso; }
}

/** Convert full name "Иванов Иван Иванович" → "Иванов И.И." */
function toInitials(fullName) {
  if (!fullName) return '';
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return parts[0];
  const last = parts[0];
  const initials = parts.slice(1).map(p => p[0] ? p[0].toUpperCase() + '.' : '').join('');
  return `${last} ${initials}`;
}

function isSOType(actData) {
  return (actData.mode || _mode) !== 'delivery';
}
