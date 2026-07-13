/**
 * Finance View
 * Panel 1: list of target programs (modal-panel)
 * Panel 2: full-screen program card editor
 *
 * Program names are the single source of truth for use in
 * Contracts (program name dropdown) and Recipients (target program dropdown).
 */

import { state, addProgram, updateProgram, deleteProgram, getProgramNames } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

const fmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtNum = v => fmt.format(Number(v) || 0);

let _editingId = null; // program id being edited, null = new

// ─── Overlay helpers ───────────────────────────────────────────────

function ov(id) { return document.getElementById(id); }

export function openFinanceModal() {
  renderProgramsList();
  ov('financeModal')?.classList.add('open');
}

export function closeFinanceModal() {
  ov('financeModal')?.classList.remove('open');
  updateFinanceBadge();
}

function openProgramCard(id) {
  _editingId = id;
  renderProgramCard(id);
  setProgramCardReadonly(false);
  ov('financeProgramListPanel')?.classList.add('hidden');
  ov('financeProgramEditPanel')?.classList.remove('hidden');
}

function openProgramView(id) {
  _editingId = id;
  renderProgramCard(id);
  setProgramCardReadonly(true);
  ov('financeProgramListPanel')?.classList.add('hidden');
  ov('financeProgramEditPanel')?.classList.remove('hidden');
}

function closeProgramCard() {
  ov('financeProgramEditPanel')?.classList.add('hidden');
  ov('financeProgramListPanel')?.classList.remove('hidden');
  renderProgramsList();
}

function setProgramCardReadonly(readonly) {
  const editPanel = ov('financeProgramEditPanel');
  if (!editPanel) return;
  editPanel.querySelectorAll('input, select, textarea').forEach(el => {
    el.disabled = readonly;
    el.style.opacity = readonly ? '0.7' : '';
    el.style.cursor = readonly ? 'default' : '';
  });
  const saveBtn = document.getElementById('financeCardSaveBtn');
  const editBtn = document.getElementById('financeCardEditBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', readonly);
  if (editBtn) editBtn.classList.toggle('hidden', !readonly);
}

// ─── Badge ─────────────────────────────────────────────────────────

export function updateFinanceBadge() {
  const badge = document.getElementById('financeBadge');
  if (!badge) return;
  const n = state.programs.length;
  if (n > 0) {
    badge.textContent = n;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── List panel ────────────────────────────────────────────────────

function renderProgramsList() {
  const wrap = document.getElementById('financeProgramsList');
  if (!wrap) {
    return;
  }

  if (state.programs.length === 0) {
    wrap.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center">
        <span class="text-5xl mb-4" aria-hidden="true">💰</span>
        <p class="text-sm font-semibold text-slate-300">${t('finance.empty')}</p>
        <p class="text-xs text-slate-500 mt-1">${t('finance.emptyHint')}</p>
      </div>`;
    return;
  }

  wrap.innerHTML = state.programs.map(p => {
    const programLabel = formatProgramLabel(p);
    const limit = p.limit ? fmtNum(p.limit) + ' ₽' : '—';
    const reserved = getReservedForProgram(p.name);
    const reservedStr = reserved > 0 ? fmtNum(reserved) + ' ₽' : '—';
    const remaining = p.limit - reserved;
    const remainingStr = p.limit > 0 ? fmtNum(remaining) + ' ₽' : '—';
    const contractsCount = getContractsForProgram(p.name).length;
    
    return `
      <div class="group flex items-center gap-3 rounded-xl border border-white/8 bg-white/[0.04] px-4 py-3 transition hover:bg-white/[0.07] hover:border-cyan-400/20 cursor-pointer finance-card" data-id="${p.id}">
        <div class="flex-1 min-w-0 pointer-events-none">
          <p class="text-sm font-semibold text-white truncate" title="${escHtml(programLabel || p.name || t('finance.noName'))}">${escHtml(programLabel || p.name || t('finance.noName'))}</p>
          <p class="text-xs text-slate-400 mt-0.5 truncate">
            ${p.code ? `<span class="mr-2">🔑 ${escHtml(p.code)}</span>` : ''}
            ${p.kbk ? `<span class="mr-2">КБК: ${escHtml(p.kbk)}</span>` : ''}
          </p>
          <div class="flex gap-4 mt-1.5 text-xs tabular-nums flex-wrap">
            <span class="text-cyan-400">${t('finance.limit')}: ${limit}</span>
            ${reserved > 0 ? `
              <button class="show-contracts-btn pointer-events-auto text-amber-400 hover:text-amber-300 transition underline decoration-dotted" 
                data-program-name="${escHtml(p.name)}" 
                aria-label="Показать контракты">
                ${t('finance.reserved')}: ${reservedStr} (${contractsCount})
              </button>
            ` : `<span class="text-slate-500">${t('finance.reserved')}: ${reservedStr}</span>`}
            ${p.limit > 0 ? `<span class="text-slate-400">${t('finance.remaining')}: ${remainingStr}</span>` : ''}
          </div>
        </div>
        <div class="flex gap-1 shrink-0">
          <button class="edit-prog-btn rounded-xl p-2 text-slate-500 hover:bg-cyan-400/10 hover:text-cyan-400 transition" data-id="${p.id}" aria-label="${t('actions.edit')}" title="${t('actions.edit')}">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4l5 5-9 9H2v-5L11 4z"/></svg>
          </button>
          <button class="del-prog-btn rounded-xl p-2 text-slate-500 hover:bg-red-500/10 hover:text-red-400 transition" data-id="${p.id}" aria-label="${t('actions.delete')}" title="${t('actions.delete')}">
            <svg width="14" height="14" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h14M8 6V4h4v2M5 6l1 12h8l1-12"/></svg>
          </button>
        </div>
      </div>`;
  }).join('');

  wrap.querySelectorAll('.finance-card').forEach(card => {
    card.addEventListener('click', e => {
      if (!e.target.closest('button')) openProgramView(Number(card.dataset.id));
    });
  });
  wrap.querySelectorAll('.edit-prog-btn').forEach(btn => {
    btn.addEventListener('click', () => openProgramCard(Number(btn.dataset.id)));
  });
  wrap.querySelectorAll('.del-prog-btn').forEach(btn => {
    btn.addEventListener('click', () => handleDeleteProgram(Number(btn.dataset.id)));
  });
  wrap.querySelectorAll('.show-contracts-btn').forEach(btn => {
    btn.addEventListener('click', (e) => { e.stopPropagation(); openContractsListForProgram(btn.dataset.programName); });
  });
}

async function handleDeleteProgram(id) {
  if (!confirm(t('finance.confirmDelete'))) return;
  deleteProgram(id);
  await saveToStorage();
  renderProgramsList();
  updateFinanceBadge();
  showToast(t('finance.deleted'), 'success');
}

// ─── Reserved funds calculation ────────────────────────────────────

/**
 * Calculate total reserved funds for a program name.
 * Sum of prices from contract.programs[] where name matches (field is `price`, not `amount`).
 */
function getReservedForProgram(programName) {
  if (!programName) return 0;
  return state.contracts.reduce((sum, c) => {
    const programs = c.programs || [];
    const prog = programs.find(p => p.name === programName);
    return sum + (parseFloat(prog?.price) || 0);
  }, 0);
}

/**
 * Get all contracts that have financing for a program.
 */
function getContractsForProgram(programName) {
  if (!programName) return [];
  return state.contracts.filter(c => {
    const programs = c.programs || [];
    return programs.some(p => p.name === programName && (parseFloat(p.price) || 0) > 0);
  });
}

// ─── Contracts list for program ────────────────────────────────────

let _currentProgramName = null;

function openContractsListForProgram(programName) {
  _currentProgramName = programName;
  renderContractsList(programName);
  ov('financeProgramListPanel')?.classList.add('hidden');
  ov('financeContractsListPanel')?.classList.remove('hidden');
}

function closeContractsList() {
  _currentProgramName = null;
  ov('financeContractsListPanel')?.classList.add('hidden');
  ov('financeProgramListPanel')?.classList.remove('hidden');
}

function renderContractsList(programName) {
  const titleEl = document.getElementById('financeContractsTitle');
  if (titleEl) titleEl.textContent = formatProgramLabel(getProgramByIdentity(programName) || programName);

  const wrap = document.getElementById('financeContractsList');
  if (!wrap) return;

  const contracts = getContractsForProgram(programName);
  
  if (contracts.length === 0) {
    wrap.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center">
        <span class="text-4xl mb-3" aria-hidden="true">📋</span>
        <p class="text-sm font-semibold text-slate-300">${t('finance.noContracts')}</p>
      </div>`;
    return;
  }

  wrap.innerHTML = contracts.map(c => {
    const supplier = c.supplierId ? state.suppliers.find(s => s.id === c.supplierId) : null;
    const prog = c.programs.find(p => p.name === programName);
    const amount = parseFloat(prog?.price) || 0;
    const contractLabel = [c.number ? `№ ${c.number}` : '', c.title].filter(Boolean).join(' — ') || t('contracts.noNumber');
    const totalPrice = parseFloat(c.totalPrice) || 0;
    const sharePct = totalPrice > 0 ? Math.min(Math.round(amount / totalPrice * 100), 100) : 0;

    return `
      <div class="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
        <div class="flex items-start justify-between gap-3">
          <div class="min-w-0 flex-1">
            <p class="text-sm font-semibold text-white truncate">${escHtml(contractLabel)}</p>
            ${supplier ? `<p class="text-xs text-slate-400 mt-0.5 truncate">🏢 ${escHtml(supplier.name)}</p>` : ''}
            ${c.date ? `<p class="text-xs text-slate-500 mt-0.5">📅 ${escHtml(fmtDate(c.date))}</p>` : ''}
          </div>
          <div class="text-right shrink-0">
            <p class="text-base font-bold text-amber-400 tabular-nums">${fmtNum(amount)} ₽</p>
            <p class="text-[10px] text-slate-500 mt-0.5">зарезервировано</p>
          </div>
        </div>
        ${totalPrice > 0 ? `
        <div>
          <div class="flex items-center justify-between text-[10px] text-slate-500 mb-1">
            <span>Доля в контракте (${fmtNum(totalPrice)} ₽)</span>
            <span class="tabular-nums font-semibold text-amber-400/80">${sharePct}%</span>
          </div>
          <div class="h-1.5 rounded-full bg-white/10 overflow-hidden">
            <div class="h-full rounded-full bg-amber-400/60 transition-all" style="width:${sharePct}%"></div>
          </div>
        </div>` : ''}
      </div>`;
  }).join('');
}

function fmtDate(iso) {
  if (!iso) return '';
  try {
    const [y, m, d] = iso.split('-');
    return `${d}.${m}.${y}`;
  } catch {
    return iso;
  }
}

// ─── Program card ──────────────────────────────────────────────────

function renderProgramCard(id) {
  let prog = id != null ? state.programs.find(p => p.id === id) : null;
  const isNew = !prog;
  if (isNew) {
    prog = addProgram({ name: '', code: '', kbk: '', limit: 0 });
    _editingId = prog.id;
    saveToStorage();
  }

  const titleEl = document.getElementById('financeCardTitle');
  if (titleEl) titleEl.textContent = prog.name
    ? formatProgramLabel(prog)
    : t('finance.newCard');

  const wrap = document.getElementById('financeCardFields');
  if (!wrap) return;

  wrap.innerHTML = `
    <div class="space-y-5">
      <div>
        <label for="fFieldName" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('finance.fieldName')}</label>
        <input id="fFieldName" type="text" value="${escHtml(prog.name)}"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${t('finance.namePlaceholder')}">
      </div>
      <div>
        <label for="fFieldCode" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('finance.fieldCode')}</label>
        <input id="fFieldCode" type="text" value="${escHtml(prog.code)}"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${t('finance.codePlaceholder')}">
        <p class="mt-1 text-xs text-slate-500">${t('finance.codeHint')}</p>
      </div>
      <div>
        <label for="fFieldKbk" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('finance.fieldKbk')}</label>
        <input id="fFieldKbk" type="text" value="${escHtml(prog.kbk)}"
          class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
          placeholder="${t('finance.kbkPlaceholder')}">
      </div>
      <div>
        <label for="fFieldLimit" class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${t('finance.fieldLimit')}</label>
        <div class="relative">
          <input id="fFieldLimit" type="number" min="0" step="0.01" value="${prog.limit || ''}"
            class="w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 pr-10 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]"
            placeholder="0.00">
          <span class="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-500">₽</span>
        </div>
      </div>
    </div>`;

  // Live update title
  document.getElementById('fFieldName')?.addEventListener('input', e => {
    if (titleEl) titleEl.textContent = e.target.value.trim()
      ? formatProgramLabel({ name: e.target.value.trim(), code: document.getElementById('fFieldCode')?.value.trim() || '', kbk: document.getElementById('fFieldKbk')?.value.trim() || '' })
      : t('finance.newCard');
  });

  const syncProgramCardTitle = () => {
    if (!titleEl) return;
    const name = document.getElementById('fFieldName')?.value.trim() || '';
    const code = document.getElementById('fFieldCode')?.value.trim() || '';
    const kbk = document.getElementById('fFieldKbk')?.value.trim() || '';
    titleEl.textContent = name ? formatProgramLabel({ name, code, kbk }) : t('finance.newCard');
  };
  document.getElementById('fFieldCode')?.addEventListener('input', syncProgramCardTitle);
  document.getElementById('fFieldKbk')?.addEventListener('input', syncProgramCardTitle);
}

async function saveProgramCard() {
  const prog = state.programs.find(p => p.id === _editingId);
  if (!prog) return;

  const name = document.getElementById('fFieldName')?.value.trim() || '';
  if (!name) {
    showToast(t('finance.nameRequired'), 'error');
    document.getElementById('fFieldName')?.focus();
    return;
  }

  updateProgram(prog.id, {
    name,
    code: document.getElementById('fFieldCode')?.value.trim() || '',
    kbk:  document.getElementById('fFieldKbk')?.value.trim() || '',
    limit: parseFloat(document.getElementById('fFieldLimit')?.value) || 0,
  });

  await saveToStorage();
  showToast(t('finance.saved'), 'success');
  updateFinanceBadge();

  const titleEl = document.getElementById('financeCardTitle');
  if (titleEl) titleEl.textContent = name;
}

// ─── Init ───────────────────────────────────────────────────────────

export function initFinanceView() {
  document.getElementById('addProgramBtn')?.addEventListener('click', () => openProgramCard(null));
  document.getElementById('financeCloseBtn')?.addEventListener('click', closeFinanceModal);
  document.getElementById('financeCardBackBtn')?.addEventListener('click', closeProgramCard);
  document.getElementById('financeCardSaveBtn')?.addEventListener('click', saveProgramCard);
  document.getElementById('financeCardEditBtn')?.addEventListener('click', () => {
    setProgramCardReadonly(false);
  });
  document.getElementById('financeContractsBackBtn')?.addEventListener('click', closeContractsList);
  document.getElementById('financeContractsCloseBtn')?.addEventListener('click', closeFinanceModal);

  const modal = document.getElementById('financeModal');
  if (modal) {
    modal.addEventListener('click', e => {
      if (e.target === modal) closeFinanceModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) {
        const editPanel = document.getElementById('financeProgramEditPanel');
        const contractsPanel = document.getElementById('financeContractsListPanel');
        if (editPanel && !editPanel.classList.contains('hidden')) {
          closeProgramCard();
        } else if (contractsPanel && !contractsPanel.classList.contains('hidden')) {
          closeContractsList();
        } else {
          closeFinanceModal();
        }
      }
    });
  }
}

// ─── Utility ────────────────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Build a datalist or a combo-select for program name fields in other modules.
 * Returns an HTML string for a <datalist id="programNamesDatalist"> element.
 * Use with <input list="programNamesDatalist"> in contracts and recipients.
 */
export function buildProgramNamesDatalist() {
  const names = getProgramNames();
  if (names.length === 0) return '';
  return `<datalist id="programNamesDatalist">${
    names.map(n => `<option value="${escHtml(n)}">`).join('')
  }</datalist>`;
}
