/**
 * Needs Import View — импорт потребностей из Excel.
 *
 * Поддерживает два формата файла:
 *
 * Формат А — «матрица»:
 *   Строка 1 (заголовок): [«Товар» / «Наименование» / «№» / пусто] | Получатель1 | Получатель2 | …
 *   Строки 2…N: [название или № товара] | qty1 | qty2 | …
 *
 * Формат Б — «список»:
 *   Столбцы: Получатель, № товара, Наименование, Количество (в любом порядке)
 *
 * Автоматически определяет формат по заголовкам.
 * При импорте полностью заменяет потребности затронутых получателей.
 */

import { $, el, clearChildren } from './dom.js';
import { state, getRecipientById, updateRecipientNeeds } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// { recipientId, recipientName, productId, productName, productNumber, qty }
let parsedMatches = [];
let onImportDone = null;

// ─── Helpers ─────────────────────────────────────────────────────

/** Нормализует строку для нечёткого сравнения */
function norm(s) {
  return String(s ?? '').toLowerCase().trim();
}

/** Ключевые слова, которые указывают на «служебный» первый столбец (не получатель) */
const PRODUCT_COL_KEYS = new Set([
  '№', 'no', 'номер', 'number', 'наименование', 'название', 'товар',
  'name', 'item', 'product', 'позиция', 'поз.', '',
]);

/** Является ли заголовок служебным (не получателем) */
function isProductCol(header) {
  return PRODUCT_COL_KEYS.has(norm(header));
}

/** Ключевые слова столбцов для формата «список» */
const LIST_COL_MAP = {
  'получатель': 'recipient', 'организация': 'recipient', 'recipient': 'recipient',
  '№': 'number', 'номер': 'number', 'number': 'number', 'no': 'number', '№ товара': 'number',
  'наименование': 'name', 'название': 'name', 'товар': 'name', 'name': 'name',
  'количество': 'qty', 'кол-во': 'qty', 'кол.': 'qty', 'qty': 'qty', 'quantity': 'qty',
};

/** Определяет, является ли файл форматом «список» (есть столбец «Получатель») */
function detectListFormat(headers) {
  return headers.some(h => LIST_COL_MAP[norm(h)] === 'recipient');
}

// ─── Сопоставление товара ────────────────────────────────────────

/** Ищет товар по номеру или названию */
function matchProduct(numRaw, nameRaw) {
  const numVal = parseInt(numRaw, 10);
  const nameLow = norm(nameRaw);

  if (!isNaN(numVal) && numVal > 0) {
    const byNum = state.products.find(p => p.number === numVal);
    if (byNum) return byNum;
  }
  if (nameLow) {
    const byName = state.products.find(p => norm(p.name) === nameLow);
    if (byName) return byName;
    // Частичное совпадение (имя файла содержит имя товара или наоборот)
    const byPartial = state.products.find(p =>
      norm(p.name).includes(nameLow) || nameLow.includes(norm(p.name))
    );
    if (byPartial) return byPartial;
  }
  return null;
}

/** Ищет получателя по имени */
function matchRecipient(namRaw) {
  const namLow = norm(namRaw);
  if (!namLow) return null;
  const exact = state.recipients.find(r => norm(r.name) === namLow);
  if (exact) return exact;
  // Частичное совпадение
  const partial = state.recipients.find(r =>
    norm(r.name).includes(namLow) || namLow.includes(norm(r.name))
  );
  return partial || null;
}

// ─── Парсинг формата «матрица» ───────────────────────────────────

/**
 * Формат А: первый столбец — товар, остальные столбцы — получатели.
 * Строки могут содержать: номер, название, или "№ название".
 */
function parseMatrix(headers, rows) {
  // Определяем столбцы получателей (пропускаем служебные первые столбцы)
  // Иногда первые 1–2 столбца служебные (№ + Наименование), остальные — получатели
  const recipientCols = []; // { index, recipient }
  let productNameColIdx = -1;
  let productNumColIdx = -1;

  for (let i = 0; i < headers.length; i++) {
    const h = headers[i];
    const nH = norm(h);
    if (nH === '№' || nH === 'no' || nH === 'номер' || nH === 'number') {
      if (productNumColIdx === -1) productNumColIdx = i;
      continue;
    }
    if (nH === 'наименование' || nH === 'название' || nH === 'товар' || nH === 'name' || nH === 'item' || nH === 'product') {
      if (productNameColIdx === -1) productNameColIdx = i;
      continue;
    }
    if (nH === '' || nH === 'позиция' || nH === 'поз.') {
      // Пустой/служебный заголовок — проверим, можно ли это быть первым товарным столбцом
      if (productNameColIdx === -1 && i === 0) {
        productNameColIdx = 0;
      }
      continue;
    }
    // Всё остальное — потенциальный получатель
    const rec = matchRecipient(h);
    recipientCols.push({ index: i, header: h, recipient: rec });
  }

  // Если не нашли явных служебных столбцов, первый столбец = товар
  if (productNameColIdx === -1 && productNumColIdx === -1) {
    productNameColIdx = 0;
  }

  const matches = [];
  const skippedRecipients = new Set();

  rows.forEach(row => {
    // Извлекаем идентификатор товара
    const numRaw = productNumColIdx !== -1 ? row[productNumColIdx] : null;
    const nameRaw = productNameColIdx !== -1 ? row[productNameColIdx] : null;

    // Если оба пустые — пропускаем
    if (!numRaw && !nameRaw) return;

    // Попытка разобрать "123 Название товара" из одной ячейки
    let resolvedNum = numRaw;
    let resolvedName = nameRaw;
    if (productNumColIdx === -1 && nameRaw) {
      const m = String(nameRaw).match(/^(\d+)\s+(.+)$/);
      if (m) {
        resolvedNum = m[1];
        resolvedName = m[2];
      }
    }

    const product = matchProduct(resolvedNum, resolvedName);
    if (!product) return;

    recipientCols.forEach(({ index, header, recipient }) => {
      const cellVal = row[index];
      const qty = parseInt(cellVal, 10);
      if (isNaN(qty) || qty <= 0) return;

      if (!recipient) {
        skippedRecipients.add(header);
        return;
      }

      matches.push({
        recipientId: recipient.id,
        recipientName: recipient.name,
        productId: product.id,
        productName: product.name,
        productNumber: product.number,
        qty,
      });
    });
  });

  return { matches, skippedRecipients: [...skippedRecipients], format: 'matrix' };
}

// ─── Парсинг формата «список» ────────────────────────────────────

function parseList(headers, rows) {
  const colMap = {};
  headers.forEach((h, i) => {
    const key = LIST_COL_MAP[norm(h)];
    if (key && !(key in colMap)) colMap[key] = i;
  });

  const matches = [];
  const skippedRecipients = new Set();

  rows.forEach(row => {
    const recName = String(row[colMap.recipient] ?? '').trim();
    const numRaw  = colMap.number !== undefined ? row[colMap.number] : null;
    const nameRaw = colMap.name !== undefined ? String(row[colMap.name] ?? '').trim() : '';
    const qty     = colMap.qty !== undefined ? (parseInt(row[colMap.qty], 10) || 0) : 0;

    if (!recName || qty <= 0) return;

    const recipient = matchRecipient(recName);
    if (!recipient) {
      skippedRecipients.add(recName);
      return;
    }

    const product = matchProduct(numRaw, nameRaw);
    if (!product) return;

    matches.push({
      recipientId: recipient.id,
      recipientName: recipient.name,
      productId: product.id,
      productName: product.name,
      productNumber: product.number,
      qty,
    });
  });

  return { matches, skippedRecipients: [...skippedRecipients], format: 'list' };
}

// ─── Preview ─────────────────────────────────────────────────────

function renderPreview(result) {
  const container = $('needsImportPreview');
  if (!container) return;
  clearChildren(container);

  const confirmBtn = $('needsImportConfirm');
  const { matches, skippedRecipients, format } = result;

  // Сводка по формату
  const formatLabel = format === 'matrix' ? '📊 Формат: матрица' : '📋 Формат: список';
  container.appendChild(
    el('p', { className: 'text-xs text-slate-500 mb-3' }, formatLabel)
  );

  // Предупреждение о пропущенных получателях
  if (skippedRecipients.length > 0) {
    const warn = el('div', { className: 'mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3' });
    warn.appendChild(el('p', { className: 'text-xs font-semibold text-amber-400 mb-1' }, `⚠ Не найдено получателей: ${skippedRecipients.length}`));
    warn.appendChild(el('p', { className: 'text-xs text-amber-300/70' }, skippedRecipients.slice(0, 5).join(', ') + (skippedRecipients.length > 5 ? ` и ещё ${skippedRecipients.length - 5}…` : '')));
    container.appendChild(warn);
  }

  if (matches.length === 0) {
    container.appendChild(
      el('p', { className: 'text-sm text-slate-500 py-4 text-center' }, 'Совпадений не найдено')
    );
    if (confirmBtn) confirmBtn.classList.add('hidden');
    return;
  }

  // Группируем для сводки: сколько получателей и товаров затронуто
  const affectedRecipients = new Set(matches.map(m => m.recipientId));
  const affectedProducts   = new Set(matches.map(m => m.productId));

  const summary = el('div', { className: 'mb-3 flex flex-wrap gap-3' });
  summary.appendChild(badgePill(`✓ Совпадений: ${matches.length}`, 'cyan'));
  summary.appendChild(badgePill(`👥 Получателей: ${affectedRecipients.size}`, 'slate'));
  summary.appendChild(badgePill(`📦 Товаров: ${affectedProducts.size}`, 'slate'));
  container.appendChild(summary);

  // Предупреждение о замене
  container.appendChild(
    el('p', { className: 'text-xs text-amber-400/80 mb-3' },
      '⚠ При импорте значения затронутых получателей будут заменены на новые.')
  );

  // Таблица предпросмотра
  const wrap = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
  const table = el('table', { className: 'w-full text-sm' });

  const thead = el('thead', { className: 'bg-white/5' });
  const hrow = el('tr', {});
  ['Получатель', '№', 'Наименование', 'Кол-во'].forEach(text => {
    hrow.appendChild(el('th', {
      className: 'px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider whitespace-nowrap',
    }, text));
  });
  thead.appendChild(hrow);
  table.appendChild(thead);

  const tbody = el('tbody', { className: 'divide-y divide-white/5' });
  const preview = matches.slice(0, 120);
  preview.forEach(m => {
    const row = el('tr', { className: 'hover:bg-white/5' });
    row.appendChild(el('td', { className: 'px-3 py-2 text-slate-200 max-w-[160px] truncate' }, m.recipientName));
    row.appendChild(el('td', { className: 'px-3 py-2 text-cyan-400 tabular-nums font-mono' }, String(m.productNumber)));
    row.appendChild(el('td', { className: 'px-3 py-2 text-slate-300 max-w-[200px] truncate' }, m.productName));
    row.appendChild(el('td', { className: 'px-3 py-2 text-white tabular-nums font-semibold' }, String(m.qty)));
    tbody.appendChild(row);
  });
  if (matches.length > 120) {
    const more = el('tr', {});
    const td = el('td', { className: 'px-3 py-2 text-center text-xs text-slate-500' });
    td.setAttribute('colspan', '4');
    td.textContent = `… и ещё ${matches.length - 120} записей`;
    more.appendChild(td);
    tbody.appendChild(more);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  container.appendChild(wrap);

  if (confirmBtn) {
    confirmBtn.textContent = `Импортировать ${matches.length} записей`;
    confirmBtn.classList.remove('hidden');
  }
}

function badgePill(text, color) {
  const colors = {
    cyan: 'bg-cyan-400/15 text-cyan-400',
    slate: 'bg-white/10 text-slate-300',
  };
  return el('span', {
    className: `inline-block rounded-lg px-2.5 py-1 text-xs font-semibold ${colors[color] || colors.slate}`,
  }, text);
}

// ─── File handling ───────────────────────────────────────────────

async function handleFile(file) {
  const container = $('needsImportPreview');
  if (container) {
    clearChildren(container);
    container.appendChild(
      el('p', { className: 'text-sm text-slate-400 py-4 text-center animate-pulse' }, '⏳ Читаю файл…')
    );
  }

  try {
    const XLSX = await loadXLSX();
    const data = await file.arrayBuffer();
    const wb = XLSX.read(data, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

    if (json.length < 2) {
      showToast('Файл пустой', 'warning');
      if (container) clearChildren(container);
      return;
    }

    // Первая непустая строка — заголовок
    const headers = (json[0] || []).map(h => String(h ?? ''));
    const rows = json.slice(1).filter(r => Array.isArray(r) && r.some(c => c != null && String(c).trim() !== ''));

    let result;
    if (detectListFormat(headers)) {
      result = parseList(headers, rows);
    } else {
      result = parseMatrix(headers, rows);
    }

    parsedMatches = result.matches;
    renderPreview(result);
  } catch (err) {
    console.error('Needs import parse error:', err);
    showToast('Ошибка чтения файла', 'error');
    if (container) clearChildren(container);
  }
}

// ─── Confirm import ──────────────────────────────────────────────

async function handleConfirm() {
  if (parsedMatches.length === 0) return;

  // Группируем все записи по получателю — собираем новые значения qty
  const byRecipient = {};
  parsedMatches.forEach(m => {
    if (!byRecipient[m.recipientId]) {
      byRecipient[m.recipientId] = {};
    }
    // Если несколько строк для одного получателя+товара — берём последнюю (файл главнее)
    byRecipient[m.recipientId][m.productId] = m.qty;
  });

  // Для каждого затронутого получателя:
  // берём его ТЕКУЩИЕ потребности, затем перезаписываем только те товары, что есть в импорте.
  // Товары, которых нет в импорте, остаются без изменений.
  Object.entries(byRecipient).forEach(([rid, newEntries]) => {
    const rec = getRecipientById(parseInt(rid, 10));
    if (!rec) return;

    const merged = { ...(rec.needs || {}) };
    Object.entries(newEntries).forEach(([pid, qty]) => {
      if (qty <= 0) {
        delete merged[pid];
      } else {
        // Сохраняем delivered/assembled если были, qty заменяем
        const existing = merged[pid];
        merged[pid] = {
          qty,
          delivered: (typeof existing === 'object' ? existing.delivered : 0) || 0,
          assembled: (typeof existing === 'object' ? existing.assembled : 0) || 0,
        };
      }
    });

    updateRecipientNeeds(parseInt(rid, 10), merged);
  });

  await saveToStorage();
  showToast(`Импортировано: ${parsedMatches.length} записей`, 'success');
  closeNeedsImportModal();
  parsedMatches = [];
  if (typeof onImportDone === 'function') onImportDone();
}

// ─── Open / Close ────────────────────────────────────────────────

export function openNeedsImportModal(callback) {
  parsedMatches = [];
  if (callback) onImportDone = callback;
  const overlay = $('needsImportModal');
  if (!overlay) return;

  const preview = $('needsImportPreview');
  if (preview) clearChildren(preview);

  const confirmBtn = $('needsImportConfirm');
  if (confirmBtn) confirmBtn.classList.add('hidden');

  const fileInput = $('needsFileInput');
  if (fileInput) fileInput.value = '';

  overlay.classList.add('open');
}

export function closeNeedsImportModal() {
  const overlay = $('needsImportModal');
  if (overlay) overlay.classList.remove('open');
}

// ─── Init ────────────────────────────────────────────────────────

export function initNeedsImportView() {
  const overlay = $('needsImportModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeNeedsImportModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeNeedsImportModal();
  });

  const cancelBtn = $('needsImportCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeNeedsImportModal);

  const confirmBtn = $('needsImportConfirm');
  if (confirmBtn) confirmBtn.addEventListener('click', handleConfirm);

  const fileInput = $('needsFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    });
  }

  const dropZone = $('needsDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
        handleFile(file);
      } else {
        showToast('Нужен файл .xlsx или .xls', 'error');
      }
    });
  }
}
