/**
 * Assembly view — Акты сборки и монтажа.
 * Форма акта + реестр актов сборки.
 *
 * Логика подбора товаров:
 *  1. Берём поставщика из выбранного контракта.
 *  2. Смотрим в state.shipments — ищем строки, доставленные выбранному получателю.
 *  3. Из этих строк оставляем только те, что поставлены по заявкам выбранного контракта.
 *  4. Из каталога проверяем флаг assembly === 'required'.
 *  5. Итог: таблица с наименованием, кодом, доставлено, собрано ранее, доступно, поле ввода.
 *  6. Заявки не отображаются — подтягиваются автоматически по FIFO при сохранении.
 */

import { $, el, clearChildren } from './dom.js';
import { state, recalcAllAssembled, calcPreviouslyAssembled, calcAssembledBySupplier, getRecipientAddresses } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── State ────────────────────────────────────────────────────────

if (!state.assemblyActs) state.assemblyActs = [];
if (!state.nextAssemblyActId) state.nextAssemblyActId = 1;

// ─── Form state ───────────────────────────────────────────────────
let formContractId  = null;
let formRecipientId = null;
let formDate        = '';
let formLocation    = '';
let _editingActId   = null;
/** @type {Array<{productId,productName,productCode,deliveredQty,assembled}>} */
let formItems = [];

// ─── Helpers ──────────────────────────────────────────────────────

function getContractById(id) {
  return (state.contracts || []).find(c => c.id === id) || null;
}
function getRecipientById(id) {
  return (state.recipients || []).find(r => r.id === id) || null;
}
function getProductById(id) {
  return (state.products || []).find(p => p.id === id) || null;
}
function getSupplierName(id) {
  return (state.suppliers || []).find(x => x.id === id)?.name || '';
}

function renderRecipientAddressField() {
  const wrap = $('assemblyRecipientAddressWrap');
  if (!wrap) return;
  clearChildren(wrap);

  const recipient = formRecipientId ? getRecipientById(formRecipientId) : null;
  const options = getRecipientAddresses(recipient);
  if (!recipient || options.length === 0) return;

  if (!formLocation || !options.includes(formLocation)) {
    formLocation = options[0] || '';
    const locationInput = $('assemblyLocationInput');
    if (locationInput) locationInput.value = formLocation;
  }

  const label = el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  }, 'Адрес получателя');

  const select = el('select', {
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    'aria-label': 'Адрес получателя',
  });

  options.forEach(address => {
    const option = el('option', { value: address }, address);
    if (address === formLocation) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => {
    formLocation = select.value;
    const locationInput = $('assemblyLocationInput');
    if (locationInput) locationInput.value = formLocation;
  });

  wrap.append(label, select);
}

/**
 * Собирает товары для акта сборки — только по productId (без заявок).
 * Только товары поставщика выбранного контракта, доставленные выбранному получателю.
 */
function buildFormItemsFromShipments() {
  if (!formContractId || !formRecipientId) return [];

  // Индекс заявок контракта
  const contractOrderIds = new Set(
    (state.orders || [])
      .filter(o => o.contractId === formContractId)
      .map(o => o.id)
  );

  // Индексы товаров
  const productById   = new Map((state.products || []).map(p => [p.id, p]));
  const productByCode = new Map(
    (state.products || []).filter(p => p.code).map(p => [(p.code || '').trim().toLowerCase(), p])
  );
  const productByName = new Map(
    (state.products || []).filter(p => p.name).map(p => [(p.name || '').trim().toLowerCase(), p])
  );

  const itemMap = new Map(); // productId → { productName, productCode, deliveredQty }

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      const orderId = row.orderId ?? null;
      if (!orderId || !contractOrderIds.has(orderId)) continue;

      const recEntry = (row.recipients || []).find(r => r.recipientId === formRecipientId);
      if (!recEntry || !recEntry.qty || recEntry.qty <= 0) continue;

      let prod = row.productId ? productById.get(row.productId) : null;
      if (!prod && row.productCode) prod = productByCode.get((row.productCode || '').trim().toLowerCase());
      if (!prod && row.productName) prod = productByName.get((row.productName || '').trim().toLowerCase());
      if (!prod && row.codeKey)     prod = productByCode.get((row.codeKey || '').trim().toLowerCase());
      if (!prod) continue;
      if (prod.assembly !== 'required') continue;

      const resolvedCode = (row.productCode || '').trim()
        || (prod.code || '').trim()
        || (row.codeKey || '').trim();

      // Группируем по коду товара: одинаковый код = один и тот же товар
      const mapKey = resolvedCode.toLowerCase() || String(prod.id);

      if (itemMap.has(mapKey)) {
        itemMap.get(mapKey).deliveredQty += Number(recEntry.qty);
      } else {
        itemMap.set(mapKey, {
          productId:    prod.id,
          productName:  prod.name || row.productName || '',
          productCode:  resolvedCode,
          deliveredQty: Number(recEntry.qty),
          assembled:    0,
        });
      }
    }
  }

  return [...itemMap.values()];
}

// ─── Form rendering (EDIT mode) ───────────────────────────────────

function renderInfoSection() {
  const wrap = $('assemblyActInfoWrap');
  if (!wrap) return;
  clearChildren(wrap);

  // Contract select
  const contractLabel = el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  });
  contractLabel.textContent = t('assembly.fieldContract');
  const contractSel = el('select', {
    id: 'assemblyContractSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  const optNone = el('option', { value: '' });
  optNone.textContent = '— Выберите контракт —';
  contractSel.appendChild(optNone);
  (state.contracts || []).forEach(c => {
    const opt = el('option', { value: String(c.id) });
    opt.textContent = [c.number, c.title].filter(Boolean).join(' — ') || `Контракт #${c.id}`;
    if (c.id === formContractId) opt.selected = true;
    contractSel.appendChild(opt);
  });
  contractSel.addEventListener('change', () => {
    formContractId = Number(contractSel.value) || null;
    rebuildAndRenderItems();
  });
  const contractWrap = el('div', {});
  contractWrap.append(contractLabel, contractSel);
  wrap.appendChild(contractWrap);

  // Recipient select
  const recLabel = el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  });
  recLabel.textContent = t('assembly.fieldRecipient');
  const recSel = el('select', {
    id: 'assemblyRecipientSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  const recOptNone = el('option', { value: '' });
  recOptNone.textContent = '— Выберите получателя —';
  recSel.appendChild(recOptNone);
  (state.recipients || []).forEach(r => {
    const opt = el('option', { value: String(r.id) });
    opt.textContent = r.name;
    if (r.id === formRecipientId) opt.selected = true;
    recSel.appendChild(opt);
  });
  recSel.addEventListener('change', () => {
    formRecipientId = Number(recSel.value) || null;
    if (formRecipientId) {
      const addresses = getRecipientAddresses(getRecipientById(formRecipientId));
      formLocation = addresses[0] || '';
      const locInput = $('assemblyLocationInput');
      if (locInput) locInput.value = formLocation;
    } else {
      formLocation = '';
      const locInput = $('assemblyLocationInput');
      if (locInput) locInput.value = '';
    }
    renderRecipientAddressField();
    rebuildAndRenderItems();
  });
  const recWrap = el('div', {});
  recWrap.append(recLabel, recSel);
  wrap.appendChild(recWrap);

  const recAddrWrap = el('div', { id: 'assemblyRecipientAddressWrap' });
  wrap.appendChild(recAddrWrap);

  // Date
  const dateLabel = el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  });
  dateLabel.textContent = t('assembly.fieldDate');
  const dateInput = el('input', {
    type: 'date',
    id: 'assemblyDateInput',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    value: formDate,
  });
  dateInput.addEventListener('change', () => { formDate = dateInput.value; });
  const dateWrap = el('div', {});
  dateWrap.append(dateLabel, dateInput);
  wrap.appendChild(dateWrap);

  // Location
  const locLabel = el('label', {
    className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400',
  });
  locLabel.textContent = t('assembly.fieldLocation');
  const locInput = el('input', {
    type: 'text',
    id: 'assemblyLocationInput',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
    placeholder: t('assembly.locationPlaceholder'),
    value: formLocation,
  });
  locInput.addEventListener('input', () => { formLocation = locInput.value; });
  const locWrap = el('div', {});
  locWrap.append(locLabel, locInput);
  wrap.appendChild(locWrap);

  renderRecipientAddressField();
}

function rebuildAndRenderItems() {
  const prevAssembled = new Map(formItems.map(i => [(i.productCode || '').toLowerCase() || String(i.productId), i.assembled]));
  formItems = buildFormItemsFromShipments();
  formItems.forEach(item => {
    const key = (item.productCode || '').toLowerCase() || String(item.productId);
    if (prevAssembled.has(key)) item.assembled = prevAssembled.get(key);
  });
  renderItemsSection();
}

function renderItemsSection() {
  const wrap = $('assemblyActItemsWrap');
  if (!wrap) return;
  clearChildren(wrap);

  if (!formContractId || !formRecipientId) {
    wrap.appendChild(el('p', { className: 'text-sm text-slate-500 py-4' }, 'Выберите контракт и получателя'));
    return;
  }

  const contract = getContractById(formContractId);
  const supplierName = contract?.supplierId ? getSupplierName(contract.supplierId) : '';
  if (supplierName) {
    const b = el('div', { className: 'mb-3 flex items-center gap-2 rounded-xl border border-blue-400/15 bg-blue-400/[0.04] px-3 py-2' });
    b.append(el('span', { className: 'text-blue-400 text-sm' }, '🏭'), el('span', { className: 'text-xs text-slate-300' }, 'Поставщик: ' + supplierName));
    wrap.appendChild(b);
  }

  if (formItems.length === 0) {
    const empty = el('div', { className: 'flex flex-col gap-2 rounded-xl border border-white/10 bg-white/[0.03] p-5' });
    empty.appendChild(el('p', { className: 'text-sm font-medium text-slate-400' }, '📭 Нет товаров для сборки'));
    ['Убедитесь, что по выбранному контракту есть сохранённые отгрузки для этого получателя',
     'В карточках товаров должен быть установлен флаг «Требуется сборка/монтаж»'].forEach(h => {
      empty.appendChild(el('p', { className: 'text-xs text-slate-600' }, '• ' + h));
    });
    wrap.appendChild(empty);
    return;
  }

  const banner = el('div', { className: 'flex items-start gap-2 rounded-xl border border-cyan-400/15 bg-cyan-400/[0.04] px-3 py-2 mb-3' });
  banner.append(
    el('span', { className: 'text-cyan-400 text-sm mt-0.5', 'aria-hidden': 'true' }, 'ℹ'),
    el('span', { className: 'text-xs text-slate-400' }, `Найдено ${formItems.length} товаров. Доступное кол-во = Доставлено − Собрано ранее.`)
  );
  wrap.appendChild(banner);

  const tableWrap = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
  const table = el('table', { className: 'w-full text-sm' });

  const thead = el('thead', { className: 'bg-slate-900' });
  const hr = el('tr', {});
  [
    { label: 'Наименование',  cls: '' },
    { label: 'Код',           cls: 'w-28' },
    { label: 'Доставлено',    cls: 'w-28 text-right' },
    { label: 'Собрано ранее', cls: 'w-32 text-right' },
    { label: 'Доступно',      cls: 'w-28 text-right' },
    { label: 'Собрано (акт)', cls: 'w-36' },
  ].forEach(h => {
    const th = el('th', { className: `px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wider text-slate-400 ${h.cls}` });
    th.textContent = h.label;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody', { className: 'divide-y divide-white/5' });

  formItems.forEach((item, idx) => {
    // «Собрано ранее» — только по актам ТЕКУЩЕГО поставщика (из выбранного контракта)
    const contract    = formContractId ? getContractById(formContractId) : null;
    const supplierId  = contract?.supplierId ?? null;
    const prevAsmQty  = formRecipientId && item.productId
      ? calcPreviouslyAssembled(formRecipientId, item.productId, _editingActId, supplierId)
      : 0;
    const available = Math.max(0, item.deliveredQty - prevAsmQty);

    const tr = el('tr', { className: 'hover:bg-white/[0.03] transition' });

    tr.appendChild(el('td', { className: 'px-3 py-2.5 text-sm font-medium text-white' }, item.productName || '—'));
    tr.appendChild(el('td', { className: 'px-3 py-2.5 text-xs font-mono text-cyan-400 tabular-nums' }, item.productCode || '—'));

    const delivTd = el('td', { className: 'px-3 py-2.5 text-right' });
    const delivBadge = el('span', {
      className: item.deliveredQty > 0
        ? 'inline-block rounded-lg bg-emerald-400/15 px-2 py-0.5 text-xs font-bold text-emerald-400 tabular-nums'
        : 'inline-block rounded-lg bg-slate-700/50 px-2 py-0.5 text-xs text-slate-500 tabular-nums',
    }, String(item.deliveredQty));
    delivTd.appendChild(delivBadge);
    tr.appendChild(delivTd);

    const prevTd = el('td', { className: 'px-3 py-2.5 text-right' });
    const prevBadge = el('span', {
      className: prevAsmQty > 0
        ? 'inline-block rounded-lg bg-amber-400/15 px-2 py-0.5 text-xs font-semibold text-amber-400 tabular-nums'
        : 'inline-block rounded-lg bg-slate-800/60 px-2 py-0.5 text-xs text-slate-600 tabular-nums',
      title: prevAsmQty > 0 ? `Собрано по другим актам: ${prevAsmQty} шт.` : 'Ранее не собиралось',
    }, String(prevAsmQty));
    prevTd.appendChild(prevBadge);
    tr.appendChild(prevTd);

    const availTd = el('td', { className: 'px-3 py-2.5 text-right' });
    const availBadge = el('span', {
      className: available > 0
        ? 'inline-block rounded-lg bg-cyan-400/15 px-2 py-0.5 text-xs font-bold text-cyan-400 tabular-nums'
        : 'inline-block rounded-lg bg-red-400/15 px-2 py-0.5 text-xs font-semibold text-red-400 tabular-nums',
      title: available <= 0 ? 'Весь доставленный товар уже собран' : `Доступно для сборки: ${available} шт.`,
    }, String(available));
    availTd.appendChild(availBadge);
    tr.appendChild(availTd);

    const asmTd = el('td', { className: 'px-3 py-2.5' });
    const asmWrap = el('div', { className: 'flex flex-col gap-1' });
    if ((item.assembled || 0) > available) item.assembled = available;

    const asmInput = el('input', {
      type: 'number',
      min: '0',
      max: String(available),
      className: available <= 0
        ? 'w-20 rounded-lg border border-red-400/30 bg-red-400/5 px-2 py-1.5 text-sm text-slate-500 text-center cursor-not-allowed'
        : 'w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white text-center transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      value: String(item.assembled || 0),
      'aria-label': 'Собрано: ' + item.productName,
    });
    if (available <= 0) asmInput.disabled = true;

    const warnSpan = el('span', { className: 'text-amber-400 text-[10px] hidden', title: 'Превышает доступное' });
    warnSpan.textContent = `⚠ макс ${available}`;

    asmInput.addEventListener('input', () => {
      let val = Math.max(0, Number(asmInput.value) || 0);
      if (val > available) {
        val = available;
        asmInput.value = String(val);
        warnSpan.classList.remove('hidden');
        setTimeout(() => warnSpan.classList.add('hidden'), 2500);
      } else {
        warnSpan.classList.add('hidden');
      }
      formItems[idx].assembled = val;
    });

    asmWrap.append(asmInput, warnSpan);
    if (available <= 0 && item.deliveredQty > 0) {
      asmWrap.appendChild(el('span', { className: 'text-[10px] text-red-400/80' }, '✓ Полностью собрано'));
    }
    asmTd.appendChild(asmWrap);
    tr.appendChild(asmTd);

    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);
}

function resetForm() {
  formContractId  = null;
  formRecipientId = null;
  formDate        = new Date().toISOString().slice(0, 10);
  formLocation    = '';
  formItems       = [];
  _editingActId   = null;
}

function renderFullForm() {
  renderInfoSection();
  renderItemsSection();
}

// ─── VIEW mode (read-only static HTML, no selects) ────────────────

/**
 * Рендерит форму акта в режиме просмотра — без select, без rebuildAndRenderItems.
 * Статичный HTML из сохранённых данных акта.
 */
function renderActView(act) {
  const infoWrap = $('assemblyActInfoWrap');
  if (infoWrap) {
    clearChildren(infoWrap);
    const contract  = act.contractId  ? getContractById(act.contractId)   : null;
    const recipient = act.recipientId ? getRecipientById(act.recipientId) : null;
    const supplier  = contract?.supplierId ? getSupplierName(contract.supplierId) : '';

    const fields = [
      { label: 'Контракт',    value: contract  ? ([contract.number, contract.title].filter(Boolean).join(' — ') || `#${contract.id}`) : '—' },
      { label: 'Получатель',  value: recipient ? recipient.name : '—' },
      { label: 'Поставщик',   value: supplier  || '—' },
      { label: 'Дата',        value: act.date  || '—' },
      { label: 'Адрес',       value: act.location || '—' },
    ];

    fields.forEach(f => {
      const row = el('div', { className: 'flex flex-col gap-0.5' });
      row.appendChild(el('span', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-500' }, f.label));
      row.appendChild(el('span', { className: 'text-sm text-white' }, f.value));
      infoWrap.appendChild(row);
    });
  }

  const itemsWrap = $('assemblyActItemsWrap');
  if (!itemsWrap) return;
  clearChildren(itemsWrap);

  const items = act.items || [];
  if (items.length === 0) {
    itemsWrap.appendChild(el('p', { className: 'text-sm text-slate-500 py-4' }, 'Товары не указаны'));
    return;
  }

  const tableWrap = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
  const table = el('table', { className: 'w-full text-sm' });

  const thead = el('thead', {});
  thead.style.cssText = 'background:rgba(15,23,42,0.95);position:sticky;top:0;z-index:1;';
  const hr = el('tr', {});
  [
    { label: '#',             w: '36px',  align: 'center' },
    { label: 'Наименование',  w: 'auto',  align: 'left'   },
    { label: 'Код',           w: '120px', align: 'left'   },
    { label: 'Доставлено',    w: '90px',  align: 'right'  },
    { label: 'Собр. ранее',   w: '90px',  align: 'right'  },
    { label: 'Доступно',      w: '90px',  align: 'right'  },
    { label: 'Собрано',       w: '90px',  align: 'right'  },
  ].forEach(h => {
    const th = el('th', {});
    th.style.cssText = [
      `padding:8px 12px`, `text-align:${h.align}`, `font-size:0.68rem`,
      `font-weight:700`, `text-transform:uppercase`, `letter-spacing:0.06em`,
      `color:rgb(100,116,139)`, `white-space:nowrap`, `width:${h.w}`,
      `border-bottom:1px solid rgba(255,255,255,0.07)`,
      `background:rgba(15,23,42,0.95)`,
    ].join(';');
    th.textContent = h.label;
    hr.appendChild(th);
  });
  thead.appendChild(hr);
  table.appendChild(thead);

  const tbody = el('tbody', { className: 'divide-y divide-white/5' });
  items.forEach(item => {
    const prevQty   = act.recipientId && item.productId
      ? calcPreviouslyAssembled(act.recipientId, item.productId, act.id)
      : 0;
    const available = Math.max(0, (item.deliveredQty || 0) - prevQty);
    const tr = el('tr', { className: 'hover:bg-white/[0.03] transition' });

    // № строки
    const numTd = el('td', {});
    numTd.style.cssText = 'padding:10px 8px;text-align:center;color:rgb(71,85,105);font-size:0.75rem;white-space:nowrap;';
    numTd.textContent = String(items.indexOf(item) + 1);
    tr.appendChild(numTd);

    // Наименование — с nowrap и ellipsis чтобы не расползалось
    const nameTd = el('td', {});
    nameTd.style.cssText = 'padding:10px 12px;color:#fff;font-size:0.82rem;font-weight:500;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    nameTd.title = item.productName || '';
    nameTd.textContent = item.productName || '—';
    tr.appendChild(nameTd);

    // Код
    const codeTd = el('td', {});
    codeTd.style.cssText = 'padding:10px 12px;font-family:monospace;font-size:0.78rem;color:rgb(34,211,238);white-space:nowrap;';
    codeTd.textContent = item.productCode || '—';
    tr.appendChild(codeTd);

    // Числовые колонки с inline-цветами (без динамических Tailwind-классов)
    const numColors = {
      emerald: { bg: 'rgba(52,211,153,0.15)', text: 'rgb(52,211,153)' },
      amber:   { bg: 'rgba(251,191,36,0.15)',  text: 'rgb(251,191,36)' },
      cyan:    { bg: 'rgba(34,211,238,0.15)',  text: 'rgb(34,211,238)' },
      red:     { bg: 'rgba(248,113,113,0.15)', text: 'rgb(248,113,113)' },
    };
    [[item.deliveredQty || 0, 'emerald'], [prevQty, 'amber'], [available, available > 0 ? 'cyan' : 'red']].forEach(([val, color]) => {
      const td = el('td', {});
      td.style.cssText = 'padding:10px 12px;text-align:right;white-space:nowrap;';
      const c = numColors[color];
      const badge = el('span', {});
      badge.style.cssText = `display:inline-block;border-radius:6px;background:${c.bg};padding:1px 8px;font-size:0.75rem;font-weight:700;color:${c.text};`;
      badge.textContent = String(val);
      td.appendChild(badge);
      tr.appendChild(td);
    });

    // Собрано — зелёный или серый
    const asmTd = el('td', {});
    asmTd.style.cssText = 'padding:10px 12px;text-align:right;white-space:nowrap;';
    const asmVal = item.assembled || 0;
    const asmBadge = el('span', {});
    asmBadge.style.cssText = asmVal > 0
      ? 'display:inline-block;border-radius:6px;background:rgba(52,211,153,0.18);padding:1px 10px;font-size:0.78rem;font-weight:700;color:rgb(52,211,153);'
      : 'display:inline-block;border-radius:6px;background:rgba(30,41,59,0.6);padding:1px 10px;font-size:0.78rem;color:rgb(71,85,105);';
    asmBadge.textContent = String(asmVal);
    asmTd.appendChild(asmBadge);
    tr.appendChild(asmTd);

    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  tableWrap.appendChild(table);
  itemsWrap.appendChild(tableWrap);
}

// ─── Open from registry ───────────────────────────────────────────

/**
 * Открывает акт в режиме ПРОСМОТРА (статичный HTML, без тяжёлого рендера формы).
 * Кнопка «Редактировать» переключает в режим редактирования.
 */
function openActView(act) {
  const modal = $('assemblyActFormModal');
  if (!modal) return;

  // Заполняем модульные переменные (нужны для generateDocx и saveAssemblyAct)
  formContractId  = act.contractId;
  formRecipientId = act.recipientId;
  formDate        = act.date || '';
  formLocation    = act.location || '';
  formItems       = JSON.parse(JSON.stringify(act.items || []));
  _editingActId   = act.id;

  // Рендерим статичный вид — без select, без rebuildAndRenderItems
  renderActView(act);

  // Скрываем кнопки сохранения, показываем «Редактировать»
  _setActFormButtons('view', act);

  modal.querySelector('.catalog-panel')?.classList.remove('hidden');
  modal.classList.add('open');
}

/**
 * Открывает акт в режиме РЕДАКТИРОВАНИЯ (полная форма с select).
 */
function openActEdit(act) {
  const modal = $('assemblyActFormModal');
  if (!modal) return;

  formContractId  = act.contractId;
  formRecipientId = act.recipientId;
  formDate        = act.date || '';
  formLocation    = act.location || '';
  formItems       = JSON.parse(JSON.stringify(act.items || []));
  _editingActId   = act.id;

  // Полный рендер формы с select
  renderFullForm();

  _setActFormButtons('edit', act);

  modal.querySelector('.catalog-panel')?.classList.remove('hidden');
  modal.classList.add('open');
}

/**
 * Управляет видимостью кнопок формы акта.
 * mode: 'new' | 'view' | 'edit'
 */
function _setActFormButtons(mode, act = null) {
  const modal = $('assemblyActFormModal');
  if (!modal) return;

  const saveBtn     = $('assemblyActSaveBtn');
  const generateBtn = $('assemblyActGenerateBtn');

  // Кнопка «Редактировать» — создаём один раз
  let editBtn = modal.querySelector('#assemblyActEditBtn');
  if (!editBtn) {
    editBtn = document.createElement('button');
    editBtn.id = 'assemblyActEditBtn';
    editBtn.type = 'button';
    editBtn.className = 'inline-flex items-center gap-2 rounded-xl border border-cyan-400/40 bg-cyan-400/10 px-4 py-2.5 text-sm font-semibold text-cyan-400 transition hover:bg-cyan-400/20 active:scale-[0.97]';
    editBtn.innerHTML = '✏️ <span>Редактировать</span>';
    // Вставляем перед кнопкой «Скачать»
    if (generateBtn) generateBtn.parentNode?.insertBefore(editBtn, generateBtn);
  }

  if (mode === 'view') {
    editBtn.classList.remove('hidden');
    if (saveBtn)     saveBtn.classList.add('hidden');
    if (generateBtn) generateBtn.classList.remove('hidden'); // скачать доступно и в просмотре
    editBtn.onclick = () => {
      if (act) openActEdit(act);
    };
  } else if (mode === 'edit') {
    editBtn.classList.add('hidden');
    if (saveBtn)     saveBtn.classList.remove('hidden');
    if (generateBtn) generateBtn.classList.remove('hidden');
  } else { // 'new'
    editBtn.classList.add('hidden');
    if (saveBtn)     saveBtn.classList.remove('hidden');
    if (generateBtn) generateBtn.classList.remove('hidden');
  }
}

// ─── Act generation (.doc / RTF) ─────────────────────────────────

/** Кодирует строку в RTF: Cyrillic → \uNNNN?, Latin/ASCII as-is */
function _rtfStr(str) {
  if (!str) return '';
  let out = '';
  for (const ch of String(str)) {
    const code = ch.codePointAt(0);
    if (code > 127) {
      // RTF Unicode: \uN? где N — signed int16
      const signed = code > 32767 ? code - 65536 : code;
      out += `\\u${signed}?`;
    } else if (ch === '\\') out += '\\\\';
    else if (ch === '{')    out += '\\{';
    else if (ch === '}')    out += '\\}';
    else                    out += ch;
  }
  return out;
}

/** Параграф RTF с заданными стилями */
function _rtfPara(text, opts = {}) {
  const {
    bold = false, italic = false, fontSize = 22, // half-points: 22 = 11pt
    align = 'l', // l/c/r/j
    spaceAfter = 0, spaceBefore = 0,
    color = 0,    // index in color table
    indent = 0,   // twips left indent
  } = opts;
  const alignCmd = { l: '\\ql', c: '\\qc', r: '\\qr', j: '\\qj' }[align] || '\\ql';
  const parts = [
    `\\pard${alignCmd}`,
    indent ? `\\li${indent}` : '',
    spaceBefore ? `\\sb${spaceBefore}` : '',
    spaceAfter  ? `\\sa${spaceAfter}`  : '',
    `\\fs${fontSize}`,
    color ? `\\cf${color}` : '',
    bold   ? '\\b'  : '',
    italic ? '\\i'  : '',
    ' ',
    _rtfStr(text),
    bold   ? '\\b0'  : '',
    italic ? '\\i0'  : '',
    '\\par',
  ];
  return parts.join('');
}

/** Ячейка таблицы RTF */
function _rtfCell(text, opts = {}) {
  const {
    bold = false, fontSize = 20, align = 'l',
    color = 0, shade = null, // shade: hex like 'D0EAD0'
  } = opts;
  const alignCmd = { l: '\\ql', c: '\\qc', r: '\\qr' }[align] || '\\ql';
  const shadeCmd = shade ? `\\clcbpat${shade}` : '';
  // cell definition is added separately; here just content
  const b = bold ? '\\b ' : '';
  const b0 = bold ? '\\b0 ' : '';
  return `\\pard${alignCmd}\\fs${fontSize}\\cf${color} ${b}${_rtfStr(text)}${b0}\\cell`;
}

function generateDocx() {
  const contract  = formContractId  ? getContractById(formContractId)   : null;
  const recipient = formRecipientId ? getRecipientById(formRecipientId) : null;
  const supplier  = contract?.supplierId ? getSupplierName(contract.supplierId) : '';
  const dateStr   = formDate || new Date().toISOString().slice(0, 10);
  const contractLabel = contract
    ? [contract.number, contract.title].filter(Boolean).join(' — ') || `#${contract.id}`
    : '—';

  // Вычисляем итоги
  const contract2 = formContractId ? getContractById(formContractId) : null;
  const supplierId2 = contract2?.supplierId ?? null;
  const itemsWithCalc = formItems.map(item => {
    const prev  = formRecipientId && item.productId
      ? calcPreviouslyAssembled(formRecipientId, item.productId, _editingActId, supplierId2)
      : 0;
    const avail = Math.max(0, (item.deliveredQty || 0) - prev);
    return { ...item, prev, avail };
  });
  const totalDelivered = itemsWithCalc.reduce((s, i) => s + (i.deliveredQty || 0), 0);
  const totalAssembled = itemsWithCalc.reduce((s, i) => s + (i.assembled || 0), 0);

  // ── Ширины колонок (twips, 1cm ≈ 567) ──
  // Итого ширина: ~14800 twips ≈ 26.1 cm (A4 без полей)
  const COL_W = [400, 5200, 2000, 1300, 1300, 1300, 1300, 2000]; // #, name, code, deliv, prev, avail, asm, (spare)
  // Используем 7 колонок: #, Наименование, Код, Доставлено, Собр.ранее, Доступно, Собрано
  const COLS = [400, 5200, 2000, 1300, 1300, 1300, 1300];
  const pageWidth = COLS.reduce((s, w) => s + w, 0); // 13800 twips

  // Накапливаем правые границы для \cellxN
  function cellxDefs(cols) {
    let acc = 0;
    return cols.map(w => { acc += w; return `\\cellx${acc}`; }).join('');
  }
  const cx = cellxDefs(COLS);

  // Заголовок строки таблицы
  function tableRowOpen(shade = null) {
    const shadeCmd = shade ? `\\clcbpat${shade}` : '';
    const cellDefs = COLS.map((w, i) => {
      let acc = COLS.slice(0, i + 1).reduce((s, v) => s + v, 0);
      const s = shade ? `\\clcbpat${shade}` : '';
      return `\\clbrdrt\\brdrs\\brdrw10\\brdrcf5\\clbrdrl\\brdrs\\brdrw10\\brdrcf5\\clbrdrb\\brdrs\\brdrw10\\brdrcf5\\clbrdrr\\brdrs\\brdrw10\\brdrcf5${s}\\cellx${acc}`;
    }).join('');
    return `\\trowd\\trgaph80\\trleft0${cellDefs}`;
  }

  function tableRow(cells, shade = null) {
    const rowOpen = tableRowOpen(shade);
    const content = cells.join('');
    return `${rowOpen}\\intbl ${content}\\row`;
  }

  function tc(text, opts = {}) {
    return _rtfCell(text, opts);
  }

  // Шапка таблицы
  const thead = tableRow([
    tc('№',          { bold: true, align: 'c', fontSize: 18, color: 3 }),
    tc('Наименование товара', { bold: true, align: 'l', fontSize: 18, color: 3 }),
    tc('Код',        { bold: true, align: 'c', fontSize: 18, color: 3 }),
    tc('Доставлено', { bold: true, align: 'c', fontSize: 18, color: 3 }),
    tc('Собр. ранее',{ bold: true, align: 'c', fontSize: 18, color: 3 }),
    tc('Доступно',   { bold: true, align: 'c', fontSize: 18, color: 3 }),
    tc('Собрано',    { bold: true, align: 'c', fontSize: 18, color: 3 }),
  ], 'E8EDF2');

  // Строки товаров
  const trows = itemsWithCalc.map((item, i) => {
    const shade = i % 2 === 0 ? null : 'F5F7FA';
    return tableRow([
      tc(String(i + 1), { align: 'c', fontSize: 18, color: 0 }),
      tc(item.productName || '—', { fontSize: 18, color: 0 }),
      tc(item.productCode || '—', { fontSize: 17, color: 2 }),
      tc(String(item.deliveredQty || 0), { align: 'c', bold: true, fontSize: 18, color: 4 }),
      tc(String(item.prev || 0),  { align: 'c', fontSize: 18, color: 5 }),
      tc(String(item.avail || 0), { align: 'c', bold: true, fontSize: 18, color: 2 }),
      tc(String(item.assembled || 0), { align: 'c', bold: true, fontSize: 20, color: item.assembled > 0 ? 4 : 0 }),
    ], shade);
  });

  // Итоговая строка
  const tfooter = tableRow([
    tc('', { align: 'c' }),
    tc('ИТОГО:', { bold: true, align: 'r', fontSize: 18, color: 3 }),
    tc('', {}),
    tc(String(totalDelivered), { align: 'c', bold: true, fontSize: 18, color: 4 }),
    tc('', {}),
    tc('', {}),
    tc(String(totalAssembled), { align: 'c', bold: true, fontSize: 20, color: 4 }),
  ], 'E8EDF2');

  // ── Строка подписи ──
  function signRow(label, name = '') {
    const SIGN_COLS = [4000, 3000, 6800];
    let acc = 0;
    const scx = SIGN_COLS.map(w => { acc += w; return `\\cellx${acc}`; }).join('');
    const cdef = SIGN_COLS.map((w, i) => {
      let a = SIGN_COLS.slice(0, i + 1).reduce((s, v) => s + v, 0);
      // только нижняя граница для строки подписи
      return `\\clbrdrb\\brdrs\\brdrw15\\brdrcf5\\cellx${a}`;
    }).join('');
    return `\\trowd\\trgaph80\\trleft0${cdef}\\intbl ` +
      `\\pard\\ql\\fs20\\b ${_rtfStr(label)}\\b0\\cell` +
      `\\pard\\qc\\fs20 ${_rtfStr(name)}\\cell` +
      `\\pard\\ql\\fs18\\cf3 (подпись, ФИО, дата)\\cf0\\cell\\row`;
  }

  // ── Сборка RTF ──
  const rtf = [
    '{\\rtf1\\ansi\\ansicpg1251\\deff0',
    // Font table
    '{\\fonttbl{\\f0\\froman\\fcharset204 Times New Roman;}{\\f1\\fswiss\\fcharset204 Arial;}}',
    // Color table: 0=black, 1=white, 2=darkBlue, 3=gray, 4=darkGreen, 5=brown, 6=darkRed
    '{\\colortbl ;\\red0\\green0\\blue0;\\red255\\green255\\blue255;\\red31\\green119\\blue180;\\red80\\green80\\blue80;\\red34\\green139\\blue34;\\red139\\green90\\blue43;\\red180\\green30\\blue30;}',
    '\\deflang1049\\widowctrl\\hyphauto',
    // Поля страницы: A4 портрет, поля 2cm
    '\\paperw11906\\paperh16838\\margl1134\\margr1134\\margt1134\\margb1134',
    '\\f1\\fs22',

    // ── Заголовок ──
    _rtfPara('АКТ СБОРКИ И МОНТАЖА', { bold: true, fontSize: 32, align: 'c', color: 2, spaceAfter: 80 }),
    _rtfPara('оборудования', { bold: false, fontSize: 22, align: 'c', color: 3, spaceAfter: 200 }),

    // ── Реквизиты ──
    _rtfPara(`Дата: ${dateStr}`, { fontSize: 22, bold: false, spaceAfter: 40 }),
    formLocation ? _rtfPara(`Место проведения: ${formLocation}`, { fontSize: 22, spaceAfter: 40 }) : '',
    _rtfPara(`Контракт: ${contractLabel}`, { fontSize: 22, spaceAfter: 40 }),
    supplier   ? _rtfPara(`Поставщик: ${supplier}`, { fontSize: 22, spaceAfter: 40 }) : '',
    recipient  ? _rtfPara(`Получатель: ${recipient.name}`, { fontSize: 22, bold: true, spaceAfter: 40 }) : '',
    recipient?.address ? _rtfPara(`Адрес: ${recipient.address}`, { fontSize: 22, spaceAfter: 160 }) : '',

    // ── Преамбула ──
    _rtfPara(
      'Настоящий акт составлен о том, что нижеподписавшиеся стороны произвели сборку и монтаж оборудования в соответствии с условиями контракта.',
      { fontSize: 20, align: 'j', spaceAfter: 200 }
    ),

    // ── Таблица товаров ──
    itemsWithCalc.length > 0 ? [thead, ...trows, tfooter].join('\n') : '',

    // Пустая строка после таблицы
    '\\pard\\ql\\sb200\\par',

    // ── Итоговая строка ──
    _rtfPara(
      `Итого позиций: ${itemsWithCalc.length}. Итого собрано: ${totalAssembled} шт.`,
      { bold: true, fontSize: 22, spaceAfter: 280 }
    ),

    // ── Подписи ──
    _rtfPara('Подписи сторон:', { bold: true, fontSize: 22, spaceBefore: 200, spaceAfter: 120 }),
    signRow('Представитель поставщика:'),
    '\\pard\\ql\\sb120\\par',
    signRow('Представитель получателя:'),
    '\\pard\\ql\\sb120\\par',
    signRow('Представитель организации:'),

    '}',
  ].flat().join('\n');

  // Кодируем в Windows-1251 через TextEncoder если доступен, иначе прямо
  let blob;
  try {
    // RTF с \ansicpg1251 — браузер сохраняет как UTF-8, но Word понимает \uN? escape
    blob = new Blob([rtf], { type: 'application/rtf' });
  } catch {
    blob = new Blob([rtf], { type: 'application/msword' });
  }

  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = `act_assembly_${dateStr}.rtf`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ─── Save act ─────────────────────────────────────────────────────

async function saveAssemblyAct() {
  if (!formContractId) { showToast('Выберите контракт', 'error'); return; }
  if (!formRecipientId) { showToast('Выберите получателя', 'error'); return; }
  const contract   = formContractId ? getContractById(formContractId) : null;
  const supplierId = contract?.supplierId ?? null;

  let hasExcess = false;
  formItems.forEach(item => {
    const prev = calcPreviouslyAssembled(formRecipientId, item.productId, _editingActId, supplierId);
    const available = Math.max(0, item.deliveredQty - prev);
    if ((item.assembled || 0) > available) { item.assembled = available; hasExcess = true; }
  });
  if (hasExcess) showToast('⚠ Некоторые значения скорректированы до доступного количества', 'warning');

  if (_editingActId) {
    // Обновляем существующий акт
    const idx = state.assemblyActs.findIndex(a => a.id === _editingActId);
    if (idx !== -1) {
      state.assemblyActs[idx] = {
        ...state.assemblyActs[idx],
        contractId:  formContractId,
        supplierId,
        recipientId: formRecipientId,
        date:        formDate,
        location:    formLocation,
        items:       JSON.parse(JSON.stringify(formItems)),
        savedAt:     new Date().toISOString(),
      };
    }
  } else {
    state.assemblyActs.push({
      id:          state.nextAssemblyActId++,
      contractId:  formContractId,
      supplierId,
      recipientId: formRecipientId,
      date:        formDate,
      location:    formLocation,
      items:       JSON.parse(JSON.stringify(formItems)),
      savedAt:     new Date().toISOString(),
    });
  }

  const { warnings } = recalcAllAssembled();
  await saveToStorage();

  if (warnings.length > 0) {
    warnings.slice(0, 3).forEach(w => {
      showToast(`⚠ «${w.productName}» у «${w.recipientName}»: собрано ${w.assembled} > доставлено ${w.delivered}.`, 'warning', 6000);
    });
    if (warnings.length > 3) showToast(`⚠ Ещё ${warnings.length - 3} товаров скорректированы`, 'warning', 5000);
  }

  showToast(t('assembly.saved'), 'success');
  updateAssemblyBadge();

  // Закрываем форму и обновляем реестр
  const modal = $('assemblyActFormModal');
  if (modal) {
    modal.classList.remove('open');
    modal.querySelector('.catalog-panel')?.classList.add('hidden');
  }
  renderRegistry();
}

// ─── Registry rendering ───────────────────────────────────────────

function renderRegistry() {
  const wrap = $('assemblyRegistryList');
  if (!wrap) return;
  clearChildren(wrap);

  const acts = state.assemblyActs || [];
  if (acts.length === 0) {
    const empty = el('div', { className: 'flex flex-col items-center justify-center py-20 text-center' });
    empty.appendChild(el('span', { className: 'text-5xl mb-4' }, '📋'));
    empty.appendChild(el('h3', { className: 'text-lg font-semibold text-slate-300 mb-2' }, t('assembly.registryEmpty')));
    empty.appendChild(el('p', { className: 'text-sm text-slate-500 max-w-xs' }, t('assembly.registryEmptyHint')));
    wrap.appendChild(empty);
    return;
  }

  [...acts].reverse().forEach(act => {
    const contract       = act.contractId  ? getContractById(act.contractId)   : null;
    const recipient      = act.recipientId ? getRecipientById(act.recipientId) : null;
    const contractLabel  = contract  ? [contract.number, contract.title].filter(Boolean).join(' — ') : t('assembly.noContract');
    const recipientLabel = recipient ? recipient.name : t('assembly.noRecipient');
    const dateStr        = act.date || act.savedAt?.slice(0, 10) || '—';
    const totalAssembled = (act.items || []).reduce((s, i) => s + (i.assembled || 0), 0);

    const card = el('div', {
      className: 'rounded-2xl border border-white/10 bg-white/5 p-4 flex items-start justify-between gap-3 transition hover:bg-white/[0.04] hover:border-cyan-400/10',
    });

    const info = el('div', { className: 'flex-1 min-w-0' });
    const top  = el('div', { className: 'flex items-center gap-2 flex-wrap mb-1' });
    const dateBadge = el('span', { className: 'text-xs font-bold text-cyan-400 tabular-nums' }, dateStr);
    const recBadge  = el('span', { className: 'text-xs text-slate-400 truncate' }, recipientLabel);
    top.append(dateBadge, recBadge);

    const contractSpan = el('p', { className: 'text-sm font-medium text-white truncate' }, contractLabel);
    const meta = el('p', { className: 'text-xs text-slate-500 mt-0.5' }, `${(act.items || []).length} поз. · собрано: ${totalAssembled} шт.`);
    info.append(top, contractSpan, meta);

    const actions = el('div', { className: 'flex gap-1 shrink-0' });

    // Кнопка «Редактировать» — открывает форму сразу в режиме редактирования
    const editBtn = el('button', {
      type: 'button',
      className: 'rounded-xl px-3 py-2 text-xs font-semibold text-cyan-400 border border-cyan-400/30 hover:bg-cyan-400/10 transition',
      title: 'Редактировать акт',
      'aria-label': 'Редактировать акт',
    }, '✏️ Редактировать');
    editBtn.addEventListener('click', e => {
      e.stopPropagation();
      openActEdit(act);
    });

    const downloadBtn = el('button', {
      type: 'button',
      className: 'rounded-xl p-2 text-slate-400 hover:bg-white/10 hover:text-cyan-400 transition',
      title: 'Скачать .doc',
      'aria-label': 'Скачать',
    }, '📄');
    downloadBtn.addEventListener('click', e => {
      e.stopPropagation();
      downloadActFromRegistry(act);
    });

    const delBtn = el('button', {
      type: 'button',
      className: 'rounded-xl p-2 text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
      title: t('actions.delete'),
      'aria-label': t('actions.delete'),
    }, '✕');
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirm(t('assembly.confirmDelete'))) return;
      const idx = state.assemblyActs.findIndex(a => a.id === act.id);
      if (idx !== -1) state.assemblyActs.splice(idx, 1);
      recalcAllAssembled();
      saveToStorage();
      showToast(t('assembly.deleted'), 'success');
      updateAssemblyBadge();
      renderRegistry();
    });

    actions.append(editBtn, downloadBtn, delBtn);
    card.append(info, actions);
    wrap.appendChild(card);
  });
}

function downloadActFromRegistry(act) {
  const saved = { formContractId, formRecipientId, formDate, formLocation, formItems: [...formItems], _editingActId };
  formContractId  = act.contractId;
  formRecipientId = act.recipientId;
  formDate        = act.date;
  formLocation    = act.location;
  formItems       = act.items || [];
  _editingActId   = act.id;
  generateDocx();
  formContractId  = saved.formContractId;
  formRecipientId = saved.formRecipientId;
  formDate        = saved.formDate;
  formLocation    = saved.formLocation;
  formItems       = saved.formItems;
  _editingActId   = saved._editingActId;
}

// ─── Badge ────────────────────────────────────────────────────────

export function updateAssemblyBadge() {
  const count = (state.assemblyActs || []).length;
  [$('assemblyBadge'), $('assemblyActsBadgeHub')].forEach(b => {
    if (!b) return;
    b.textContent = count;
    b.classList.toggle('hidden', count === 0);
  });
}

// ─── Init ─────────────────────────────────────────────────────────

let _initDone = false;

export function initAssemblyView() {
  if (_initDone) return;
  _initDone = true;

  // Hub → открыть форму нового акта
  const goActFormBtn = $('assemblyGoActFormBtn');
  if (goActFormBtn) {
    goActFormBtn.addEventListener('click', () => {
      resetForm();
      renderFullForm();
      _setActFormButtons('new');
      const afm = $('assemblyActFormModal');
      if (afm) { afm.querySelector('.catalog-panel')?.classList.remove('hidden'); afm.classList.add('open'); }
    });
  }

  // Hub → открыть реестр
  const goRegistryBtn = $('assemblyGoRegistryBtn');
  if (goRegistryBtn) {
    goRegistryBtn.addEventListener('click', () => {
      renderRegistry();
      const arm = $('assemblyRegistryModal');
      if (arm) { arm.querySelector('.catalog-panel')?.classList.remove('hidden'); arm.classList.add('open'); }
    });
  }

  // Act form modal — кнопки закрытия
  const actFormModal = $('assemblyActFormModal');
  if (actFormModal) {
    function closeActForm() {
      actFormModal.classList.remove('open');
      actFormModal.querySelector('.catalog-panel')?.classList.add('hidden');
    }
    $('assemblyActFormBackBtn')?.addEventListener('click', closeActForm);
    actFormModal.addEventListener('click', e => { if (e.target === actFormModal) closeActForm(); });

    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && actFormModal.classList.contains('open')) {
        e.stopImmediatePropagation();
        closeActForm();
      }
    });

    $('assemblyActGenerateBtn')?.addEventListener('click', () => {
      try { generateDocx(); showToast(t('assembly.generated'), 'success'); }
      catch { showToast(t('assembly.generateError'), 'error'); }
    });

    $('assemblyActSaveBtn')?.addEventListener('click', () => saveAssemblyAct());
  }

  // Registry modal
  const registryModal = $('assemblyRegistryModal');
  if (registryModal) {
    const closeRegistry = () => {
      registryModal.classList.remove('open');
      registryModal.querySelector('.catalog-panel')?.classList.add('hidden');
    };
    $('assemblyRegistryBackBtn')?.addEventListener('click',  closeRegistry);
    $('assemblyRegistryCloseBtn')?.addEventListener('click', closeRegistry);
    registryModal.addEventListener('click', e => { if (e.target === registryModal) closeRegistry(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && registryModal.classList.contains('open')) closeRegistry();
    });
  }
}
