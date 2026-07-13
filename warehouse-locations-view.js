/**
 * Warehouse Locations — список складов и карточка склада.
 * Главный экран модуля «Склад» теперь показывает список складов.
 */

import { $, el, clearChildren } from './dom.js';
import { state, addWarehouse, updateWarehouse, deleteWarehouse } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── Callbacks ────────────────────────────────────────────────────
let onOpenWarehouse = null; // (warehouseId) => void
let onOpenSummary  = null; // () => void

// ─── Editing state ────────────────────────────────────────────────
let editingWarehouseId = null;

// ─── Helpers ──────────────────────────────────────────────────────

function getSupplierById(id) {
  return (state.suppliers || []).find(s => s.id === id) || null;
}

function getFirstPhone(supplier) {
  if (!supplier) return '';
  if (Array.isArray(supplier.phones) && supplier.phones.length > 0) {
    const p = supplier.phones[0];
    if (typeof p === 'string') return p;
    if (p && typeof p === 'object') return p.number || p.value || p.phone || '';
  }
  if (typeof supplier.phone === 'string') return supplier.phone;
  return '';
}

function getSupplierAddress(supplier) {
  if (!supplier) return '';
  if (typeof supplier.address === 'string') return supplier.address;
  if (typeof supplier.legalAddress === 'string') return supplier.legalAddress;
  if (typeof supplier.factAddress === 'string') return supplier.factAddress;
  return '';
}

function countEntries(warehouseId) {
  return state.warehouseEntries.filter(e => e.warehouseId === warehouseId).length;
}

// ─── Render list ──────────────────────────────────────────────────

export function renderWarehouseList() {
  const wrap = $('whLocationsListWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const warehouses = state.warehouses || [];

  if (warehouses.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-16 text-center' });
    empty.appendChild(el('span', { className: 'text-4xl mb-3' }, '🏭'));
    empty.appendChild(el('p', { className: 'text-sm font-semibold text-slate-300' }, 'Нет складов'));
    empty.appendChild(el('p', { className: 'text-xs text-slate-500 mt-1' }, 'Нажмите «Добавить склад»'));
    wrap.appendChild(empty);
    return;
  }

  warehouses.forEach(wh => {
    const supplier = getSupplierById(wh.supplierId);
    const entriesCount = countEntries(wh.id);

    const card = el('div', {
      className: 'group relative rounded-2xl border border-white/10 bg-white/[0.04] p-4 hover:bg-white/[0.07] hover:border-cyan-400/20 transition cursor-pointer',
    });

    // Top row: name + badge
    const topRow = el('div', { className: 'flex items-start justify-between gap-3 mb-2' });
    const nameWrap = el('div', { className: 'flex items-center gap-2 min-w-0' });
    const icon = el('span', { className: 'text-xl shrink-0' }, '🏭');
    const nameEl = el('span', { className: 'text-sm font-semibold text-white truncate' });
    nameEl.textContent = wh.name;
    nameWrap.append(icon, nameEl);
    if (wh.isDefault) {
      const badge = el('span', { className: 'ml-1 shrink-0 rounded-md bg-cyan-400/15 px-1.5 py-0.5 text-[10px] font-semibold text-cyan-400' }, 'Основной');
      nameWrap.appendChild(badge);
    }
    topRow.appendChild(nameWrap);

    if (entriesCount > 0) {
      const cnt = el('span', { className: 'shrink-0 rounded-lg bg-slate-700/60 px-2 py-0.5 text-xs font-bold text-slate-300 tabular-nums' });
      cnt.textContent = entriesCount + ' пост.';
      topRow.appendChild(cnt);
    }
    card.appendChild(topRow);

    // Details
    const details = el('div', { className: 'flex flex-col gap-0.5 text-xs text-slate-400' });
    if (supplier) {
      const line = el('div', { className: 'flex items-center gap-1.5' });
      line.appendChild(el('span', {}, '🏢'));
      line.appendChild(el('span', { className: 'truncate' }, supplier.name));
      details.appendChild(line);
    }
    if (wh.address) {
      const line = el('div', { className: 'flex items-center gap-1.5' });
      line.appendChild(el('span', {}, '📍'));
      line.appendChild(el('span', { className: 'truncate' }, wh.address));
      details.appendChild(line);
    }
    const phone = wh.phone || getFirstPhone(supplier);
    if (phone) {
      const line = el('div', { className: 'flex items-center gap-1.5' });
      line.appendChild(el('span', {}, '📞'));
      line.appendChild(el('span', { className: 'truncate' }, phone));
      details.appendChild(line);
    }
    if (details.children.length > 0) card.appendChild(details);

    // Open warehouse on click
    card.addEventListener('click', () => onOpenWarehouse?.(wh.id));

    // Action buttons (hover)
    const actions = el('div', { className: 'absolute top-3 right-3 hidden group-hover:flex items-center gap-1' });

    const editBtn = el('button', {
      type: 'button',
      className: 'flex items-center justify-center w-7 h-7 rounded-lg bg-white/10 text-slate-400 hover:bg-white/20 hover:text-white transition text-xs',
      'aria-label': 'Редактировать склад',
      title: 'Редактировать',
    }, '✎');
    editBtn.addEventListener('click', e => { e.stopPropagation(); openWarehouseCard(wh.id); });

    const delBtn = el('button', {
      type: 'button',
      className: 'flex items-center justify-center w-7 h-7 rounded-lg bg-red-500/10 text-red-400 hover:bg-red-500/20 transition text-xs',
      'aria-label': 'Удалить склад',
      title: 'Удалить',
    }, '✕');
    delBtn.addEventListener('click', e => { e.stopPropagation(); handleDeleteWarehouse(wh.id); });

    // Don't show delete for default warehouse
    if (!wh.isDefault) actions.append(editBtn, delBtn);
    else actions.appendChild(editBtn);

    card.appendChild(actions);
    wrap.appendChild(card);
  });
}

// ─── Card (Add / Edit) ───────────────────────────────────────────

export function openWarehouseCard(warehouseId) {
  editingWarehouseId = warehouseId !== undefined ? warehouseId : null;
  renderWarehouseCard();
  showCardPanel();
}

function showCardPanel() {
  $('whLocationsListPanel')?.classList.add('hidden');
  $('whLocationCardPanel')?.classList.remove('hidden');
}

function showListPanel() {
  $('whLocationCardPanel')?.classList.add('hidden');
  $('whLocationsListPanel')?.classList.remove('hidden');
  renderWarehouseList();
}

function renderWarehouseCard() {
  const wrap = $('whLocationCardWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const wh = editingWarehouseId != null
    ? state.warehouses.find(w => w.id === editingWarehouseId) || null
    : null;

  const title = $('whLocationCardTitle');
  if (title) title.textContent = wh ? 'Редактировать склад' : 'Новый склад';

  const form = el('div', { className: 'space-y-5 max-w-lg' });

  // Name
  const nameWrap = el('div', {});
  nameWrap.appendChild(el('label', {
    for: 'whLocName',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, 'Название склада'));
  const nameInp = el('input', {
    id: 'whLocName',
    type: 'text',
    required: 'true',
    value: wh ? wh.name : '',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    placeholder: 'Например: Склад №2, Региональный склад…',
  });
  nameWrap.appendChild(nameInp);
  form.appendChild(nameWrap);

  // Supplier
  const supplierWrap = el('div', {});
  supplierWrap.appendChild(el('label', {
    for: 'whLocSupplier',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, 'Контрагент (поставщик)'));
  const supplierSel = el('select', {
    id: 'whLocSupplier',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  supplierSel.appendChild(el('option', { value: '' }, '— Выберите поставщика —'));
  (state.suppliers || []).forEach(s => {
    const opt = el('option', { value: String(s.id) }, s.name);
    if (wh && wh.supplierId === s.id) opt.selected = true;
    supplierSel.appendChild(opt);
  });
  supplierWrap.appendChild(supplierSel);
  form.appendChild(supplierWrap);

  // Address
  const addrWrap = el('div', {});
  addrWrap.appendChild(el('label', {
    for: 'whLocAddress',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, 'Адрес склада'));
  const addrInp = el('input', {
    id: 'whLocAddress',
    type: 'text',
    value: wh ? wh.address : '',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    placeholder: 'г. Москва, ул. Примерная, д. 1',
  });
  addrWrap.appendChild(addrInp);
  form.appendChild(addrWrap);

  // Phone (auto-filled from supplier, editable)
  const phoneWrap = el('div', {});
  phoneWrap.appendChild(el('label', {
    for: 'whLocPhone',
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, 'Телефон'));
  const phoneInp = el('input', {
    id: 'whLocPhone',
    type: 'tel',
    value: wh ? wh.phone : '',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    placeholder: '+7 (000) 000-00-00',
  });
  phoneWrap.appendChild(phoneInp);
  phoneWrap.appendChild(el('p', { className: 'mt-1 text-[11px] text-slate-500' }, 'Заполняется автоматически из карточки поставщика или вручную'));
  form.appendChild(phoneWrap);

  // Track whether user has manually edited the phone/address fields
  let phoneEditedByUser = false;
  let addrEditedByUser  = false;
  phoneInp.addEventListener('input', () => { phoneEditedByUser = true; });
  addrInp.addEventListener('input',  () => { addrEditedByUser  = true; });

  // Helpers: fill phone / address from supplier
  function fillFromSupplier(supplierId, force) {
    const supp = supplierId ? getSupplierById(supplierId) : null;
    const phone = getFirstPhone(supp);
    const addr  = getSupplierAddress(supp);
    if (force || !phoneEditedByUser) {
      phoneInp.value = phone || '';
      phoneInp.placeholder = phone ? '' : '+7 (000) 000-00-00';
    }
    if ((force || !addrEditedByUser) && addr) {
      addrInp.value = addr;
    }
  }

  // Auto-fill phone when supplier changes — always overwrite (user explicitly chose new supplier)
  supplierSel.addEventListener('change', () => {
    const sid = supplierSel.value ? Number(supplierSel.value) : null;
    phoneEditedByUser = false;
    addrEditedByUser  = false;
    fillFromSupplier(sid, true);
  });

  // On open: auto-fill from current supplier if phone not already saved
  if (wh && wh.supplierId) {
    if (!wh.phone) {
      // No saved phone — pull from supplier
      fillFromSupplier(wh.supplierId, true);
    }
    // If phone was saved, it's already in phoneInp.value — mark as user-edited so we don't overwrite
    else {
      phoneEditedByUser = true;
    }
    // Address: if not saved — pull from supplier
    if (!wh.address) {
      const supp = getSupplierById(wh.supplierId);
      const addr = getSupplierAddress(supp);
      if (addr) addrInp.value = addr;
    } else {
      addrEditedByUser = true;
    }
  } else if (!wh && supplierSel.value) {
    // New card with pre-selected supplier (unlikely but safe)
    fillFromSupplier(Number(supplierSel.value), true);
  }

  wrap.appendChild(form);

  // Wire save button — always use onclick to avoid stale listener accumulation
  const saveBtn = document.getElementById('whLocationCardSaveBtn');
  if (saveBtn) {
    saveBtn.onclick = () => saveWarehouseCard(nameInp, supplierSel, addrInp, phoneInp);
  }
}

async function saveWarehouseCard(nameInp, supplierSel, addrInp, phoneInp) {
  const name = nameInp.value.trim();
  if (!name) {
    showToast('Укажите название склада', 'error');
    nameInp.focus();
    return;
  }
  const supplierId = supplierSel.value ? Number(supplierSel.value) : null;
  const address = addrInp.value.trim();
  const supp = supplierId ? getSupplierById(supplierId) : null;
  const phone = phoneInp.value.trim() || getFirstPhone(supp);

  if (editingWarehouseId != null) {
    updateWarehouse(editingWarehouseId, { name, supplierId, address, phone });
    showToast('Склад обновлён', 'success');
  } else {
    addWarehouse({ name, supplierId, address, phone });
    showToast('Склад добавлен', 'success');
  }
  await saveToStorage();
  showListPanel();
}

async function handleDeleteWarehouse(id) {
  const wh = state.warehouses.find(w => w.id === id);
  if (!wh) return;
  const count = countEntries(id);
  const msg = count > 0
    ? `Удалить склад «${wh.name}»? ${count} записей будут перенесены на другой склад. Это действие нельзя отменить.`
    : `Удалить склад «${wh.name}»? Это действие нельзя отменить.`;
  if (!confirm(msg)) return;
  const ok = deleteWarehouse(id);
  if (!ok) {
    showToast('Нельзя удалить основной склад', 'error');
    return;
  }
  await saveToStorage();
  showToast('Склад удалён', 'success');
  renderWarehouseList();
}

// ─── Init ─────────────────────────────────────────────────────────

export function initWarehouseLocationsView(opts) {
  onOpenWarehouse = opts?.onOpenWarehouse ?? null;
  onOpenSummary   = opts?.onOpenSummary   ?? null;

  // Add warehouse button
  $('whLocAddBtn')?.addEventListener('click', () => openWarehouseCard(null));

  // Summary button
  $('whLocSummaryBtn')?.addEventListener('click', () => onOpenSummary?.());

  // Back arrow on locations list — closes the whole warehouse modal
  $('whLocBackBtn')?.addEventListener('click', () => {
    $('warehouseModal')?.classList.remove('open');
  });

  // Card back button
  $('whLocationCardBackBtn')?.addEventListener('click', showListPanel);
}
