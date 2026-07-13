import { state, getContractById, saveClaim, updateClaim, deleteClaim, getClaimById } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

const CLAIM_FILE_ACCEPT = '.pdf,.doc,.docx,.rtf,.txt,.xlsx,.xls,.jpg,.jpeg,.png,.webp';
const CLAIM_FILE_MAX_BYTES = 10 * 1024 * 1024;

let currentFilterContractId = null;
let currentEditingClaimId = null;

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(value) {
  if (!value) return '—';
  try {
    const [y, m, d] = String(value).split('-');
    return `${d}.${m}.${y}`;
  } catch {
    return String(value);
  }
}

function fmtMoney(value) {
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Number(value) || 0);
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error(tf('claims.fileReadError', 'Не удалось прочитать файл')));
    reader.readAsDataURL(file);
  });
}

function normalizeClaimFiles(files) {
  return Array.isArray(files) ? files.filter(file => file?.dataUrl) : [];
}

function getFilteredClaims() {
  const claims = Array.isArray(state.claims) ? state.claims : [];
  if (!currentFilterContractId) {
    return [...claims].sort((a, b) => String(b.claimDate || '').localeCompare(String(a.claimDate || '')));
  }
  return claims
    .filter(claim => String(claim.contractId) === String(currentFilterContractId))
    .sort((a, b) => String(b.claimDate || '').localeCompare(String(a.claimDate || '')));
}

function getPaymentStatusOptions(selected) {
  const options = [
    ['unpaid', tf('claims.statusUnpaid', 'Не оплачено')],
    ['paid', tf('claims.statusPaid', 'Оплачено')],
    ['withheld', tf('claims.statusWithheld', 'Удержано')],
    ['court', tf('claims.statusCourt', 'В суде')],
  ];
  return options.map(([value, label]) =>
    `<option value="${value}" ${selected === value ? 'selected' : ''}>${escHtml(label)}</option>`
  ).join('');
}

function renderClaimFiles(files = []) {
  const wrap = document.getElementById('claimFilesWrap');
  if (!wrap) return;
  const normalized = normalizeClaimFiles(files);
  wrap.innerHTML = normalized.length
    ? normalized.map(file => `
        <div class="rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2.5">
          <div class="flex items-start justify-between gap-3 flex-wrap">
            <div class="min-w-0 flex-1">
              <p class="text-sm font-medium text-white break-all">${escHtml(file.originalName || 'file')}</p>
              <p class="mt-1 text-xs text-slate-500">${escHtml(file.uploadedAt ? new Date(file.uploadedAt).toLocaleString('ru-RU') : '')}</p>
            </div>
            <div class="flex gap-2">
              <button type="button" data-claim-file-download="${escHtml(file.id)}" class="rounded-xl border border-emerald-400/25 bg-emerald-400/10 px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/15">${escHtml(tf('claims.downloadFile', 'Скачать'))}</button>
              <button type="button" data-claim-file-remove="${escHtml(file.id)}" class="rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-400/15">${escHtml(tf('claims.removeFile', 'Удалить'))}</button>
            </div>
          </div>
        </div>`).join('')
    : `<div class="rounded-xl border border-dashed border-white/10 bg-slate-950/30 px-4 py-4 text-sm text-slate-400">${escHtml(tf('claims.filesEmpty', 'Файлы не загружены'))}</div>`;

  wrap.querySelectorAll('[data-claim-file-download]').forEach(btn => {
    btn.addEventListener('click', () => {
      const file = normalized.find(item => item.id === btn.dataset.claimFileDownload);
      if (!file?.dataUrl) return;
      const a = document.createElement('a');
      a.href = file.dataUrl;
      a.download = file.originalName || 'claim-file';
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  wrap.querySelectorAll('[data-claim-file-remove]').forEach(btn => {
    btn.addEventListener('click', () => {
      const next = normalized.filter(item => item.id !== btn.dataset.claimFileRemove);
      const hidden = document.getElementById('claimFilesState');
      if (hidden) hidden.value = JSON.stringify(next);
      renderClaimFiles(next);
    });
  });
}

function renderConditionalFields(status, claim = {}) {
  const wrap = document.getElementById('claimPaymentExtraWrap');
  if (!wrap) return;
  if (status === 'paid') {
    wrap.innerHTML = `
      <div>
        <label for="claimPaidDate" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldPaidDate', 'Дата оплаты'))}</label>
        <input id="claimPaidDate" type="date" value="${escHtml(claim.paidDate || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
      </div>`;
    return;
  }
  if (status === 'withheld') {
    wrap.innerHTML = `
      <div>
        <label for="claimWithheldFrom" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldWithheldFrom', 'Удержано из оплаты'))}</label>
        <input id="claimWithheldFrom" type="text" value="${escHtml(claim.withheldFrom || '')}" placeholder="${escHtml(tf('claims.withheldFromPlaceholder', 'Например: оплата № 3 от 15.06.2026'))}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
      </div>`;
    return;
  }
  wrap.innerHTML = '';
}

function renderClaimsList() {
  const titleEl = document.getElementById('claimsModalTitle');
  const listEl = document.getElementById('claimsListWrap');
  const addBtn = document.getElementById('claimsAddBtn');
  if (!titleEl || !listEl || !addBtn) return;

  const contract = currentFilterContractId ? getContractById(Number(currentFilterContractId)) : null;
  titleEl.textContent = contract
    ? tf('claims.titleForContract', `Претензии по контракту № ${contract.number || contract.id}`, { number: contract.number || contract.id })
    : tf('claims.title', 'Претензии');
  addBtn.textContent = tf('claims.addBtn', 'Новая претензия');

  const claims = getFilteredClaims();
  if (!claims.length) {
    listEl.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center">
        <span class="text-5xl mb-4" aria-hidden="true">⚖️</span>
        <p class="text-sm font-semibold text-slate-300">${escHtml(tf('claims.empty', 'Претензий пока нет'))}</p>
        <p class="text-xs text-slate-500 mt-1">${escHtml(tf('claims.emptyHint', 'Добавьте первую претензию по этому контракту'))}</p>
      </div>`;
    return;
  }

  listEl.innerHTML = claims.map(claim => {
    const contract = getContractById(Number(claim.contractId));
    const contractNumber = contract?.number || claim.contractNumber || '—';
    const lotNumber = contract?.lotNumber || claim.lotNumber || '—';
    const fileCount = normalizeClaimFiles(claim.files).length;
    const statusLabel = tf(`claims.status_${claim.paymentStatus}`, claim.paymentStatus || tf('claims.statusUnpaid', 'Не оплачено'));
    return `
      <article class="rounded-2xl border border-white/10 bg-white/[0.04] px-4 py-4">
        <div class="flex items-start justify-between gap-3 flex-wrap">
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="rounded-lg bg-white/8 px-2 py-1 text-[10px] font-semibold text-slate-300">${escHtml(tf('claims.cardContract', 'Контракт № {number}', { number: contractNumber }))}</span>
              <span class="rounded-lg bg-violet-400/15 px-2 py-1 text-[10px] font-semibold text-violet-300">${escHtml(tf('claims.cardLot', 'Лот {lot}', { lot: lotNumber }))}</span>
            </div>
            <p class="mt-2 text-sm font-semibold text-white">${escHtml(claim.claimNumber || tf('claims.noNumber', 'Без номера'))}</p>
            <p class="mt-1 text-xs text-slate-400">${escHtml(fmtDate(claim.claimDate))} · ${escHtml(claim.claimType === 'penalty' ? tf('claims.typePenalty', 'Пеня') : tf('claims.typeFine', 'Штраф'))}</p>
          </div>
          <div class="text-right">
            <div class="text-[10px] uppercase tracking-wide text-slate-500">${escHtml(tf('claims.fieldAmount', 'Сумма'))}</div>
            <div class="text-sm font-semibold text-emerald-400 tabular-nums">${escHtml(fmtMoney(claim.amount))} ₽</div>
          </div>
        </div>
        <div class="mt-3 flex flex-wrap gap-2 text-xs text-slate-400">
          <span class="rounded-lg bg-white/[0.04] px-2.5 py-1">${escHtml(tf('claims.fieldAccrualDateShort', 'Дата начисления: {date}', { date: fmtDate(claim.accrualDate) }))}</span>
          <span class="rounded-lg bg-white/[0.04] px-2.5 py-1">${escHtml(tf('claims.fieldPaymentStatusShort', 'Статус: {status}', { status: statusLabel }))}</span>
          <span class="rounded-lg bg-white/[0.04] px-2.5 py-1">${escHtml(tf('claims.filesCount', 'Файлов: {count}', { count: fileCount }))}</span>
        </div>
        <div class="mt-3 flex flex-wrap gap-2">
          <button type="button" data-claim-open="${claim.id}" class="rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/15">${escHtml(tf('claims.openBtn', 'Открыть'))}</button>
          <button type="button" data-claim-delete="${claim.id}" class="rounded-xl border border-red-400/25 bg-red-400/10 px-3 py-2 text-xs font-semibold text-red-300 transition hover:bg-red-400/15">${escHtml(tf('claims.deleteBtn', 'Удалить'))}</button>
        </div>
      </article>`;
  }).join('');

  listEl.querySelectorAll('[data-claim-open]').forEach(btn => {
    btn.addEventListener('click', () => openClaimEditor(Number(btn.dataset.claimOpen)));
  });
  listEl.querySelectorAll('[data-claim-delete]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!window.confirm(tf('claims.confirmDelete', 'Удалить претензию?'))) return;
      deleteClaim(Number(btn.dataset.claimDelete));
      await saveToStorage();
      window.dispatchEvent(new CustomEvent('claims-changed'));
      renderClaimsList();
      showToast(tf('claims.deleted', 'Претензия удалена'), 'success');
    });
  });
}

function openClaimEditor(claimId = null) {
  currentEditingClaimId = claimId;
  const claim = claimId ? getClaimById(claimId) : null;
  const contract = claim?.contractId
    ? getContractById(Number(claim.contractId))
    : (currentFilterContractId ? getContractById(Number(currentFilterContractId)) : null);

  document.getElementById('claimsListPanel')?.classList.add('hidden');
  document.getElementById('claimsEditPanel')?.classList.remove('hidden');
  document.getElementById('claimEditTitle').textContent = claimId
    ? tf('claims.editTitle', 'Карточка претензии')
    : tf('claims.newTitle', 'Новая претензия');

  const body = document.getElementById('claimEditBody');
  if (!body) return;

  body.innerHTML = `
    <div class="space-y-6">
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldContractNumber', 'Номер контракта'))}</label>
          <input id="claimContractNumber" type="text" readonly value="${escHtml(contract?.number || claim?.contractNumber || '')}" class="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-slate-300">
        </div>
        <div>
          <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldLotNumber', 'Номер лота'))}</label>
          <input id="claimLotNumber" type="text" readonly value="${escHtml(contract?.lotNumber || claim?.lotNumber || '')}" class="w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm text-slate-300">
        </div>
        <div>
          <label for="claimNumber" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldClaimNumber', 'Номер претензии'))}</label>
          <input id="claimNumber" type="text" value="${escHtml(claim?.claimNumber || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
        </div>
        <div>
          <label for="claimDate" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldClaimDate', 'Дата претензии'))}</label>
          <input id="claimDate" type="date" value="${escHtml(claim?.claimDate || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
        </div>
        <div>
          <label for="claimType" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldType', 'Вид претензии'))}</label>
          <select id="claimType" class="w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-2.5 text-sm text-white">
            <option value="fine" ${claim?.claimType !== 'penalty' ? 'selected' : ''}>${escHtml(tf('claims.typeFine', 'Штраф'))}</option>
            <option value="penalty" ${claim?.claimType === 'penalty' ? 'selected' : ''}>${escHtml(tf('claims.typePenalty', 'Пеня'))}</option>
          </select>
        </div>
        <div>
          <label for="claimAccrualDate" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldAccrualDate', 'Дата начисления'))}</label>
          <input id="claimAccrualDate" type="date" value="${escHtml(claim?.accrualDate || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
        </div>
        <div class="sm:col-span-2">
          <label for="claimAmount" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldAmount', 'Сумма'))}</label>
          <input id="claimAmount" type="number" min="0" step="0.01" value="${escHtml(claim?.amount || '')}" class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white">
        </div>
      </section>
      <section class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <label for="claimPaymentStatus" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.fieldPaymentStatus', 'Отметка об оплате'))}</label>
          <select id="claimPaymentStatus" class="w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-2.5 text-sm text-white">${getPaymentStatusOptions(claim?.paymentStatus || 'unpaid')}</select>
        </div>
        <div id="claimPaymentExtraWrap"></div>
      </section>
      <section>
        <div class="flex items-center justify-between gap-3 mb-3">
          <h3 class="text-xs font-semibold uppercase tracking-wider text-slate-400">${escHtml(tf('claims.sectionFiles', 'Файлы'))}</h3>
          <button id="claimFilesPickBtn" type="button" class="rounded-xl border border-cyan-400/25 bg-cyan-400/10 px-3 py-2 text-xs font-semibold text-cyan-300 transition hover:bg-cyan-400/15">${escHtml(tf('claims.chooseFiles', 'Выбрать файлы'))}</button>
          <input id="claimFilesInput" type="file" multiple accept="${CLAIM_FILE_ACCEPT}" hidden>
          <input id="claimFilesState" type="hidden" value='${escHtml(JSON.stringify(normalizeClaimFiles(claim?.files)))}'>
        </div>
        <div id="claimFilesWrap"></div>
      </section>
    </div>`;

  renderConditionalFields(claim?.paymentStatus || 'unpaid', claim || {});
  renderClaimFiles(normalizeClaimFiles(claim?.files));

  document.getElementById('claimPaymentStatus')?.addEventListener('change', (event) => {
    renderConditionalFields(event.target.value, claim || {});
  });

  document.getElementById('claimFilesPickBtn')?.addEventListener('click', () => {
    document.getElementById('claimFilesInput')?.click();
  });

  document.getElementById('claimFilesInput')?.addEventListener('change', async (event) => {
    const incoming = Array.from(event.target.files || []);
    event.target.value = '';
    if (!incoming.length) return;
    const tooLarge = incoming.find(file => file.size > CLAIM_FILE_MAX_BYTES);
    if (tooLarge) {
      showToast(tf('claims.fileTooLarge', 'Файл слишком большой'), 'error');
      return;
    }
    const currentFiles = JSON.parse(document.getElementById('claimFilesState')?.value || '[]');
    const uploaded = await Promise.all(incoming.map(async file => ({
      id: `claim_file_${Math.random().toString(36).slice(2, 10)}_${Date.now()}`,
      originalName: file.name,
      mimeType: file.type || 'application/octet-stream',
      sizeBytes: file.size || 0,
      uploadedAt: new Date().toISOString(),
      dataUrl: await readFileAsDataUrl(file),
    })));
    const next = [...currentFiles, ...uploaded];
    document.getElementById('claimFilesState').value = JSON.stringify(next);
    renderClaimFiles(next);
  });
}

async function saveCurrentClaim() {
  const contract = currentFilterContractId ? getContractById(Number(currentFilterContractId)) : null;
  const claimNumber = document.getElementById('claimNumber')?.value.trim() || '';
  const claimDate = document.getElementById('claimDate')?.value || '';
  const claimType = document.getElementById('claimType')?.value || 'fine';
  const accrualDate = document.getElementById('claimAccrualDate')?.value || '';
  const amount = parseFloat(document.getElementById('claimAmount')?.value || '0') || 0;
  const paymentStatus = document.getElementById('claimPaymentStatus')?.value || 'unpaid';
  const paidDate = document.getElementById('claimPaidDate')?.value || '';
  const withheldFrom = document.getElementById('claimWithheldFrom')?.value.trim() || '';
  const files = JSON.parse(document.getElementById('claimFilesState')?.value || '[]');

  if (!contract) {
    showToast(tf('claims.contractRequired', 'Контракт не найден'), 'error');
    return;
  }
  if (!claimNumber) {
    showToast(tf('claims.numberRequired', 'Укажите номер претензии'), 'error');
    return;
  }
  if (!claimDate) {
    showToast(tf('claims.dateRequired', 'Укажите дату претензии'), 'error');
    return;
  }

  const payload = {
    contractId: contract.id,
    contractNumber: contract.number || '',
    lotNumber: contract.lotNumber || '',
    claimNumber,
    claimDate,
    claimType,
    accrualDate,
    amount,
    paymentStatus,
    paidDate: paymentStatus === 'paid' ? paidDate : '',
    withheldFrom: paymentStatus === 'withheld' ? withheldFrom : '',
    files: normalizeClaimFiles(files),
  };

  if (currentEditingClaimId) updateClaim(currentEditingClaimId, payload);
  else saveClaim(payload);
  await saveToStorage();
  window.dispatchEvent(new CustomEvent('claims-changed'));
  showToast(tf('claims.saved', 'Претензия сохранена'), 'success');
  backToClaimsList();
  renderClaimsList();
}

function backToClaimsList() {
  document.getElementById('claimsEditPanel')?.classList.add('hidden');
  document.getElementById('claimsListPanel')?.classList.remove('hidden');
  currentEditingClaimId = null;
}

function ensureClaimsModal() {
  if (document.getElementById('claimsModal')) return;
  const root = document.createElement('div');
  root.innerHTML = `
    <div id="claimsModal" class="modal-overlay" role="dialog" aria-modal="true" aria-labelledby="claimsModalTitle">
      <div id="claimsListPanel" class="modal-panel module-hub-modal w-full max-w-lg rounded-2xl border border-white/10 bg-slate-900 p-6 shadow-2xl mx-4 flex flex-col overflow-hidden" style="width:min(97vw,1380px);max-width:none;max-height:94vh;">
        <div class="flex items-center justify-between gap-3 mb-4 shrink-0">
          <div>
            <h2 id="claimsModalTitle" class="text-xl font-bold text-white"></h2>
            <p class="text-xs text-slate-500 mt-1">${escHtml(tf('claims.subtitle', 'Реестр претензий по контракту'))}</p>
          </div>
          <button id="claimsCloseBtn" type="button" class="rounded-xl border border-white/15 px-4 py-2.5 text-sm font-medium text-slate-300 transition hover:bg-white/10">${escHtml(tf('actions.close', 'Закрыть'))}</button>
        </div>
        <div class="mb-4 shrink-0"><button id="claimsAddBtn" type="button" class="w-full rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300"></button></div>
        <div id="claimsListWrap" class="flex-1 overflow-y-auto -mx-1 px-1 space-y-3"></div>
      </div>
      <div id="claimsEditPanel" class="hidden catalog-panel w-full h-full flex flex-col bg-slate-950 overflow-hidden">
        <div class="flex items-center justify-between px-4 sm:px-6 py-4 border-b border-white/10 bg-slate-950/80 backdrop-blur-sm shrink-0">
          <div class="flex items-center gap-3">
            <button id="claimEditBackBtn" type="button" class="rounded-xl p-2 text-slate-400 hover:bg-white/10 hover:text-white transition" aria-label="Назад">←</button>
            <h2 id="claimEditTitle" class="text-lg font-bold text-white"></h2>
          </div>
          <button id="claimSaveBtn" type="button" class="rounded-xl bg-cyan-400 px-4 py-2.5 text-sm font-semibold text-slate-950 transition hover:bg-cyan-300">${escHtml(tf('actions.save', 'Сохранить'))}</button>
        </div>
        <div id="claimEditBody" class="flex-1 overflow-auto px-4 sm:px-6 py-5"></div>
      </div>
    </div>`;
  document.body.appendChild(root.firstElementChild);
}

export function openClaimsModal(contractId = null) {
  ensureClaimsModal();
  currentFilterContractId = contractId != null ? Number(contractId) : null;
  currentEditingClaimId = null;
  document.getElementById('claimsEditPanel')?.classList.add('hidden');
  document.getElementById('claimsListPanel')?.classList.remove('hidden');
  renderClaimsList();
  document.getElementById('claimsModal')?.classList.add('open');
}

export function closeClaimsModal() {
  document.getElementById('claimsModal')?.classList.remove('open');
  backToClaimsList();
}

export function initClaimsView() {
  ensureClaimsModal();
  document.getElementById('claimsCloseBtn')?.addEventListener('click', closeClaimsModal);
  document.getElementById('claimsAddBtn')?.addEventListener('click', () => openClaimEditor());
  document.getElementById('claimEditBackBtn')?.addEventListener('click', backToClaimsList);
  document.getElementById('claimSaveBtn')?.addEventListener('click', saveCurrentClaim);
  const modal = document.getElementById('claimsModal');
  modal?.addEventListener('click', (event) => {
    if (event.target === modal) closeClaimsModal();
  });
  document.addEventListener('keydown', (event) => {
    const modalOpen = modal?.classList.contains('open');
    if (event.key === 'Escape' && modalOpen) {
      if (!document.getElementById('claimsEditPanel')?.classList.contains('hidden')) backToClaimsList();
      else closeClaimsModal();
    }
  });
}
