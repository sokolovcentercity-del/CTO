/*
 * Разбор ТХ — разбор таблицы из Word DOCX.
 * Не читает и не изменяет state/storage проекта.
 *
 * Ожидаемые колонки в Word:
 *   Раздел, Наименование, № пом. в ГЧ, Кол-во пом, Кол-во.
 *
 * Правило:
 *   сначала восстанавливается полный шаблон оснащения для каждого типа помещения,
 *   затем он раскладывается по всем помещениям группы;
 *   в отчёт попадают только строки раздела «Мебель».
 */

import { loadJSZip } from './lib-loader.js';

const state = { rows: [], sourceName: '', activeReport: 'rooms' };
const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const $ = (id) => document.getElementById(id);
const t = (key, values) => window.miniappI18n?.t(key, values) ?? key;
const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;',
}[ch]));

function normalize(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[\t\r\n]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function lower(value) {
  return normalize(value).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

function sameRoomType(leftValue, rightValue) {
  const left = lower(leftValue);
  const right = lower(rightValue);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorterLength = Math.min(left.length, right.length);
  return shorterLength >= 24 && (left.includes(right) || right.includes(left));
}

function sameRoomGroup(candidate, row) {
  if (!sameRoomType(candidate.roomType, row.roomType)) return false;

  // Значение «1» в «Кол-во пом.» не означает, что в строке указан один
  // номер. В исходных ТХ это также используется для одного объединённого
  // помещения, состоящего из нескольких номеров (например, 115, 116, 117).
  // Поэтому такие строки должны оставаться в общей группе с остальными
  // строками этого типа помещения.
  const candidateIsComposite = candidate.expectedRoomCount === 1 && candidate.roomCountHint > 1;
  const rowIsComposite = row.qtyRoom === 1 && row.rooms.length > 1;
  if (candidateIsComposite || rowIsComposite) return true;

  // Для обычных групп одинаковое количество помещений защищает от смешения
  // одноимённых вариантов, если они встречаются в разных разделах ТХ.
  if (candidate.expectedRoomCount > 1 && row.qtyRoom > 1) {
    return candidate.expectedRoomCount === row.qtyRoom;
  }
  return true;
}

function headerText(value) {
  return lower(value)
    .replace(/[‑–—−]/g, '-')
    .replace(/[.,:;()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseNumber(value) {
  const source = normalize(value)
    .replace(/(?<=\d)[\s\u00a0]+(?=\d)/g, '')
    .replace(',', '.');
  const match = source.match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : 0;
}

function formatQty(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return '0';
  if (Math.abs(number - Math.round(number)) < 1e-9) return String(Math.round(number));
  return number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '').replace('.', ',');
}

function isFurniture(value) {
  const text = lower(value).replace(/[^а-яё]/g, '');
  return text.includes('мебел') || text.includes('мебельн') || text.includes('меблир');
}

function isHeader(value, type) {
  const text = headerText(value);
  const compact = text.replace(/[^a-zа-яё0-9№]/gi, '');
  if (type === 'section') return text === 'раздел' || text.includes('раздел');
  if (type === 'name') return text.includes('наимен') || text === 'товар' || text.includes('наим товара');
  if (type === 'rooms') return (
    /пом.*гч/.test(compact)
    || compact.includes('номерпом')
    || compact.includes('помвг')
  ) && !text.includes('кол');
  if (type === 'roomName') return (
    text === 'помещение'
    || text.includes('название помещения')
    || text.includes('наименование помещения')
  );
  if (type === 'unit') return (
    text.includes('ед изм')
    || text.includes('единица измерения')
    || text === 'ед.'
  );
  if (type === 'qtyRoom') return (
    /кол/.test(text) && /пом|помещ|комнат/.test(text)
  );
  if (type === 'qty') return (
    text.includes('кол')
    && !text.includes('пом')
    && !text.includes('отлич')
    && (text.includes('во') || text.includes('количество') || text === 'кол')
  );
  return false;
}

function directChildren(node, localName) {
  return Array.from(node?.childNodes || []).filter((child) => {
    return child.nodeType === 1 && (!localName || child.localName === localName);
  });
}

function wordText(node) {
  if (!node) return '';
  const texts = Array.from(node.getElementsByTagNameNS(W_NS, 't'))
    .map((textNode) => textNode.textContent || '');
  if (texts.length) return normalize(texts.join(' '));
  return normalize(node.textContent || '');
}

function readTable(table) {
  return directChildren(table, 'tr').map((tr) => ({
    node: tr,
    cells: directChildren(tr, 'tc').map((tc) => wordText(tc)),
  })).filter((row) => row.cells.some(Boolean));
}

function combinedLabels(rows, start, span) {
  const maxCells = Math.max(...rows.slice(start, start + span).map((row) => row.cells.length), 0);
  return Array.from({ length: maxCells }, (_, column) => normalize(
    rows.slice(start, start + span).map((row) => row.cells[column] || '').filter(Boolean).join(' '),
  ));
}

function detectStrictHeader(cells) {
  const labels = cells.map((cell) => headerText(cell));
  const indexes = {
    section: labels.findIndex((text) => text === 'раздел' || text.includes('раздел')),
    roomName: labels.findIndex((text) => text === 'помещение' || text.includes('наименование помещения') || text.includes('название помещения')),
    qtyRoom: labels.findIndex((text) => /кол/.test(text) && /пом|помещ|комнат/.test(text)),
    name: labels.findIndex((text) => text.includes('наименование')),
    unit: labels.findIndex((text) => text.includes('ед изм') || text.includes('единица измерения') || text === 'ед.'),
    qty: labels.findIndex((text) => /^(кол-во|количество|кол во|кол)$/.test(text) && !text.includes('пом') && !text.includes('отлич')),
    rooms: labels.findIndex((text) => {
      const compact = text.replace(/\s+/g, '');
      return (
        compact.includes('№помвгч')
        || compact.includes('номерпомвгч')
        || compact.includes('помвгч')
        || compact.includes('№пом')
      ) && !text.includes('кол');
    }),
  };

  const hasCore = indexes.name >= 0
    && indexes.qty >= 0
    && indexes.qtyRoom >= 0
    && indexes.rooms >= 0;

  return hasCore ? indexes : null;
}

function isDataNumberCell(value) {
  return /^\d+$/.test(normalize(value));
}

function findHeader(rows) {
  const types = ['section', 'name', 'rooms', 'roomName', 'qtyRoom', 'qty', 'unit'];
  // В некоторых DOCX перед настоящей шапкой находятся строки заголовка,
  // объединённые ячейки и служебные подписи. Поэтому нельзя ограничивать
  // поиск первыми 12 строками.
  for (let start = 0; start < rows.length; start += 1) {
    for (let span = 1; span <= 4 && start + span <= rows.length; span += 1) {
      const labels = combinedLabels(rows, start, span);
      const indexes = {};
      for (const type of types) {
        indexes[type] = labels.findIndex((label) => isHeader(label, type));
      }
      // В исходной таблице одновременно есть «Помещение» и
      // «№ пом. в ГЧ». Для отчёта нужны именно номера помещений из ГЧ.
      // Название «Помещение» оставляем только как запасной вариант.
      if (indexes.rooms < 0) indexes.rooms = indexes.roomName;
      // «Мебель» может быть отдельной строкой над таблицей, поэтому
      // колонка «Раздел» не является обязательной.
      const hasNameAndQty = indexes.name >= 0 && indexes.qty >= 0;
      const hasRoomInfo = indexes.rooms >= 0 || (indexes.roomName >= 0 && indexes.qtyRoom >= 0);
      if (hasNameAndQty && hasRoomInfo) return { indexes, end: start + span };
    }
  }
  return null;
}

function splitRooms(value) {
  const source = String(value ?? '')
    .replace(/№/gi, '')
    .replace(/[;|]+/g, ',');
  return source
    .split(/[,\n]+/)
    .flatMap((part) => part.match(/\d+(?:\s*[-–—]\s*\d+)?/g) || [])
    .map((room) => room.replace(/\s+/g, '').trim())
    .filter(Boolean);
}

function isServiceRow(value) {
  const text = lower(value);
  return !text || text === 'всего' || text === 'итого' || text.includes('наименование');
}

function isFurnitureMarkerRow(row) {
  return row.cells.some((cell) => isFurniture(cell));
}

function cellAt(row, index) {
  return index >= 0 ? normalize(row.cells[index] || '') : '';
}

async function extractDocxRows(file) {
  const JSZip = await loadJSZip();
  const zip = await JSZip.loadAsync(await file.arrayBuffer());
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) throw new Error('DOCX_NO_DOCUMENT');

  const xml = await documentFile.async('text');
  const document = new DOMParser().parseFromString(xml, 'application/xml');
  if (document.querySelector('parsererror')) throw new Error('DOCX_BAD_XML');

  const tables = Array.from(document.getElementsByTagNameNS(W_NS, 'tbl'));
  if (!tables.length) throw new Error('DOCX_NO_TABLE');
  const result = [];
  let activeHeader = null;
  let foundHeader = false;
  let currentSection = '';
  let currentRooms = '';
  let currentRoomType = '';

  // Word разбивает одну длинную таблицу на множество последовательных
  // элементов w:tbl. Заголовок есть только в первой части, поэтому карту
  // колонок нужно сохранять и применять к следующим частям.
  for (const table of tables) {
    const rows = readTable(table);
    const tableHeader = findHeader(rows);
    let start = 0;

    if (tableHeader) {
      activeHeader = tableHeader;
      foundHeader = true;
      start = tableHeader.end;
    }
    if (!activeHeader) continue;

    const { indexes } = activeHeader;
    for (const row of rows.slice(start)) {
      const rowNumber = normalize(row.cells[0] || '');
      // Изображения и пустые строки в документе не являются позициями.
      if (!isDataNumberCell(rowNumber)) continue;

      const section = cellAt(row, indexes.section);
      const roomType = cellAt(row, indexes.roomName);
      const name = cellAt(row, indexes.name);
      const unit = cellAt(row, indexes.unit) || 'шт.';
      const roomsCell = cellAt(row, indexes.rooms);
      const qty = parseNumber(cellAt(row, indexes.qty));
      const qtyRoom = parseNumber(cellAt(row, indexes.qtyRoom));

      // Пустая объединённая ячейка продолжает раздел/помещение сверху.
      if (section) currentSection = section;
      if (roomsCell) currentRooms = roomsCell;
      if (roomType) currentRoomType = roomType;

      if (!isFurniture(currentSection)) continue;
      if (isServiceRow(name) || !name || !qty) continue;

      const rooms = splitRooms(roomsCell || currentRooms);
      if (!rooms.length) continue;

      result.push({
        name,
        rooms,
        roomType: roomType || currentRoomType,
        unit,
        qty,
        qtyRoom,
        section: 'Мебель',
      });
    }
  }

  if (!foundHeader) throw new Error('DOCX_NO_HEADER');
  if (!result.length) throw new Error('DOCX_NO_FURNITURE');
  return reconstructRoomGroups(result);
}

/**
 * DOCX может обрезать содержимое ячейки «№ пом. в ГЧ» из-за малой высоты строки.
 * Поэтому одна строка не считается источником полного списка помещений.
 * Для каждой группы типа помещения собираем объединённый список номеров и
 * полный набор товаров, а затем отмечаем позиции, добавленные по аналогии.
 */
function reconstructRoomGroups(rawRows) {
  const groups = [];

  for (const row of rawRows) {
    let group = groups.find((candidate) => sameRoomGroup(candidate, row));
    if (!group) {
      group = {
        roomType: normalize(row.roomType),
        rows: [],
        rooms: new Set(),
        expectedRoomCount: 0,
        roomCountHint: 0,
      };
      groups.push(group);
    }

    if (normalize(row.roomType).length > normalize(group.roomType).length) {
      group.roomType = normalize(row.roomType);
    }
    group.rows.push(row);
    row.rooms.forEach((room) => group.rooms.add(room));
    if (row.qtyRoom > 0) group.expectedRoomCount = Math.max(group.expectedRoomCount, row.qtyRoom);
    group.roomCountHint = Math.max(group.roomCountHint, row.rooms.length);
  }

  const result = [];
  for (const group of groups) {
    const roomList = [...group.rooms];
    const roomCount = Math.max(roomList.length, group.expectedRoomCount, 1);
    const groupIncomplete = group.expectedRoomCount > group.rooms.size;
    const compositeMode = group.expectedRoomCount === 1 && roomList.length > 1;
    const compositeRoom = roomList.join(', ');
    const itemMap = new Map();

    for (const row of group.rows) {
      const key = `${lower(row.name)}|${lower(row.unit)}`;
      const item = itemMap.get(key) || {
        name: row.name,
        unit: row.unit,
        totalQty: 0,
        explicitRooms: new Set(),
      };
      item.totalQty += row.qty;
      row.rooms.forEach((room) => item.explicitRooms.add(room));
      itemMap.set(key, item);
    }

    for (const item of itemMap.values()) {
      const missingRooms = new Set(roomList.filter((room) => !item.explicitRooms.has(room)));
      const totalQty = Number(item.totalQty);
      if (!Number.isFinite(totalQty) || totalQty <= 0) continue;

      // Для объединённого помещения количество относится ко всей группе,
      // поэтому его нельзя делить между номерами.
      if (compositeMode) {
        result.push({
          name: item.name,
          room: compositeRoom,
          roomType: group.roomType,
          unit: item.unit,
          qty: totalQty,
          section: 'Мебель',
          recovered: groupIncomplete || missingRooms.size > 0,
        });
        continue;
      }

      // Дробное количество физического товара недопустимо. Если позицию
      // нельзя равномерно разложить по помещениям, сохраняем её как одну
      // позицию на объединённую группу, не создавая ложных дробей.
      if (!Number.isInteger(totalQty) || totalQty % roomCount !== 0) {
        result.push({
          name: item.name,
          room: roomList.join(', '),
          roomType: group.roomType,
          unit: item.unit,
          qty: totalQty,
          section: 'Мебель',
          recovered: true,
        });
        continue;
      }

      const perRoomQty = totalQty / roomCount;
      for (const room of roomList) {
        result.push({
          name: item.name,
          room,
          roomType: group.roomType,
          unit: item.unit,
          qty: perRoomQty,
          section: 'Мебель',
          recovered: groupIncomplete || missingRooms.has(room),
        });
      }
    }
  }

  return result;
}

function aggregateRows(rows) {
  const roomMap = new Map();
  const productMap = new Map();
  for (const row of rows) {
    const roomType = normalize(row.roomType);
    const roomKey = `${lower(row.room)}|${lower(roomType)}`;
    const productKey = lower(row.name);
    if (!roomMap.has(roomKey)) roomMap.set(roomKey, { room: row.room, roomType, items: new Map(), total: 0, recovered: false });
    const room = roomMap.get(roomKey);
    const roomItemKey = `${productKey}|${lower(row.unit)}`;
    const roomItem = room.items.get(roomItemKey) || { name: row.name, unit: row.unit, qty: 0, recovered: false };
    roomItem.qty += row.qty;
    roomItem.recovered = roomItem.recovered || Boolean(row.recovered);
    room.items.set(roomItemKey, roomItem);
    room.recovered = room.recovered || Boolean(row.recovered);

    if (!productMap.has(productKey)) productMap.set(productKey, { name: row.name, unit: row.unit, rooms: new Map(), total: 0, recovered: false });
    const product = productMap.get(productKey);
    const productRoom = product.rooms.get(roomKey) || { room: row.room, roomType, qty: 0, recovered: false };
    productRoom.qty += row.qty;
    productRoom.recovered = productRoom.recovered || Boolean(row.recovered);
    product.rooms.set(roomKey, productRoom);
    product.recovered = product.recovered || Boolean(row.recovered);
  }

  const rooms = [...roomMap.values()].map((room) => {
    room.items = [...room.items.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));
    room.total = room.items.reduce((sum, item) => sum + item.qty, 0);
    return room;
  }).sort((a, b) => a.room.localeCompare(b.room, 'ru-RU', { numeric: true }));

  const products = [...productMap.values()].map((product) => {
    product.rooms = [...product.rooms.values()].sort((a, b) => a.room.localeCompare(b.room, 'ru-RU', { numeric: true }));
    product.total = product.rooms.reduce((sum, item) => sum + item.qty, 0);
    return product;
  }).sort((a, b) => a.name.localeCompare(b.name, 'ru-RU'));

  return { rooms, products };
}

function setStatus(text, tone = '') {
  const status = $('thStatus');
  if (!status) return;
  status.textContent = text;
  status.className = `th-status ${tone}`;
}

function renderSummary(data) {
  const summary = $('thSummary');
  if (!summary) return;
  const total = state.rows.reduce((sum, row) => sum + row.qty, 0);
  summary.innerHTML = `<div class="th-summary-card"><span class="th-summary-icon" aria-hidden="true">🪑</span><div><strong>${esc(formatQty(total))} ${esc(t('thAnalysis.units'))}</strong><span>${esc(t('thAnalysis.summary', { products: data.products.length, rooms: data.rooms.length }))} · ${esc(state.sourceName)}</span></div></div>`;
}

function emptyReport() {
  return `<div class="th-empty-state"><span aria-hidden="true">🗂️</span><strong>${esc(t('thAnalysis.emptyTitle'))}</strong><p>${esc(t('thAnalysis.emptyHint'))}</p></div>`;
}

function renderRoomsReport(data) {
  if (!data.rooms.length) return emptyReport();
  return `<div class="th-report-list th-rooms-report">${data.rooms.map((room) => `<section class="th-report-section${room.recovered ? ' th-recovered-room' : ''}"><div class="th-section-heading"><div><span class="th-section-kicker">${esc(room.room)}</span><h3>${esc(room.roomType || t('thAnalysis.roomTypeUnknown'))}</h3>${room.recovered ? `<div class="th-recovery-note" role="note">⚠ ${esc(t('thAnalysis.recoveredByAnalogy'))}</div>` : ''}</div><span class="th-total-badge">${esc(formatQty(room.total))} ${esc(t('thAnalysis.units'))}</span></div><div class="th-table-wrap"><table><thead><tr><th>№</th><th>${esc(t('thAnalysis.productColumn'))}</th><th>${esc(t('thAnalysis.unitColumn'))}</th><th>${esc(t('thAnalysis.quantityColumn'))}</tr></thead><tbody>${room.items.map((item, index) => `<tr class="${item.recovered ? 'th-recovered-row' : ''}"${item.recovered ? ` title="${esc(t('thAnalysis.recoveredByAnalogy'))}"` : ''}><td>${index + 1}</td><td>${esc(item.name)}</td><td>${esc(item.unit)}</td><td class="th-number">${esc(formatQty(item.qty))}</td></tr>`).join('')}</tbody></table></div></section>`).join('')}</div>`;
}

function renderProductsReport(data) {
  if (!data.products.length) return emptyReport();
  return `<div class="th-report-list th-products-report"><section class="th-report-section th-products-section"><div class="th-section-heading"><div><span class="th-section-kicker">${esc(t('thAnalysis.productsKicker'))}</span><h3>${esc(t('thAnalysis.productsTitle'))}</h3></div><span class="th-total-badge">${data.products.length} ${esc(t('thAnalysis.itemsLabel'))}</span></div><div class="th-table-wrap"><table><thead><tr><th>№</th><th>${esc(t('thAnalysis.productColumn'))}</th><th>${esc(t('thAnalysis.unitColumn'))}</th><th>${esc(t('thAnalysis.quantityColumn'))}</th><th>${esc(t('thAnalysis.roomsColumn'))}</th></tr></thead><tbody>${data.products.map((product, index) => `<tr class="${product.recovered ? 'th-recovered-row' : ''}"${product.recovered ? ` title="${esc(t('thAnalysis.recoveredByAnalogy'))}"` : ''}><td>${index + 1}</td><td>${esc(product.name)}</td><td>${esc(product.unit)}</td><td class="th-number">${esc(formatQty(product.total))}</td><td>${product.rooms.map((room) => `<div class="th-room-line${room.recovered ? ' th-recovered-line' : ''}"${room.recovered ? ` title="${esc(t('thAnalysis.recoveredByAnalogy'))}"` : ''}><span>${esc(room.room)}; ${esc(room.roomType || t('thAnalysis.roomTypeUnknown'))};</span><strong>${esc(formatQty(room.qty))}</strong></div>`).join('')}</td></tr>`).join('')}</tbody></table></div></section></div>`;
}

function renderReport() {
  const data = aggregateRows(state.rows);
  renderSummary(data);
  const wrap = $('thReportWrap');
  if (!wrap) return;
  wrap.style.display = 'block';
  wrap.style.flex = '1 1 0';
  wrap.style.minHeight = '0';
  wrap.style.overflowY = 'auto';
  wrap.style.overflowX = 'auto';
  wrap.style.scrollbarGutter = 'stable';
  wrap.innerHTML = state.activeReport === 'rooms' ? renderRoomsReport(data) : renderProductsReport(data);
  const title = $('thPrintTitle');
  if (title) title.textContent = state.activeReport === 'rooms' ? t('thAnalysis.roomsPrintTitle') : t('thAnalysis.productsPrintTitle');
}

function scrollToReportTable(behavior = 'smooth') {
  const wrap = $('thReportWrap');
  if (!wrap) return;
  requestAnimationFrame(() => {
    const table = wrap.querySelector('table');
    if (!table) return;
    wrap.scrollTo({ top: Math.max(0, table.offsetTop - 8), behavior });
  });
}

function makeThButton(id, labelKey, className, handler) {
  let button = $(id);
  if (!button) {
    button = document.createElement('button');
    button.id = id;
    button.type = 'button';
    button.className = className;
    button.style.cssText = 'min-height:40px;padding:0.5rem 0.75rem;border:1px solid rgba(255,255,255,0.15);border-radius:0.75rem;background:rgba(255,255,255,0.05);color:rgb(203,213,225);font-size:0.75rem;font-weight:600;cursor:pointer;';
    document.querySelector('.th-analysis-actions')?.appendChild(button);
  }
  button.textContent = t(labelKey);
  button.onclick = handler;
  return button;
}

function ensureThControls() {
  const toolbar = $('thReportToolbar');
  if (!toolbar) return;

  let actions = toolbar.querySelector('.th-analysis-actions');
  if (!actions) {
    actions = document.createElement('div');
    actions.className = 'th-analysis-actions';
    actions.style.cssText = 'display:flex;flex-wrap:wrap;align-items:center;gap:0.5rem;';
    toolbar.appendChild(actions);
  }

  const normal = 'min-h-[40px] rounded-xl border border-white/15 bg-white/5 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-white/10';
  const primary = 'min-h-[40px] rounded-xl bg-amber-400 px-3 py-2 text-xs font-semibold text-slate-950 hover:bg-amber-300';
  makeThButton('thScrollTableBtn', 'thAnalysis.scrollToTable', normal, () => scrollToReportTable());
  makeThButton('thPrintRoomsBtn', 'thAnalysis.wordRooms', primary, () => exportWord('rooms'));
  makeThButton('thPrintProductsBtn', 'thAnalysis.wordProducts', primary, () => exportWord('products'));
  makeThButton('thResetBtn', 'thAnalysis.resetTask', normal, clearReport);
}

function xmlEscape(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
  }[ch]));
}

function wordParagraph(value, options = {}) {
  const text = xmlEscape(value);
  const align = options.align ? `<w:jc w:val="${options.align}"/>` : '';
  const bold = options.bold ? '<w:b/>' : '';
  const size = options.size ? `<w:sz w:val="${options.size}"/><w:szCs w:val="${options.size}"/>` : '';
  return `<w:p><w:pPr>${align}<w:spacing w:after="${options.after ?? 80}"/></w:pPr><w:r><w:rPr>${bold}${size}<w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/></w:rPr><w:t xml:space="preserve">${text}</w:t></w:r></w:p>`;
}

function wordCell(value, options = {}) {
  const width = options.width ? `<w:tcW w:w="${options.width}" w:type="dxa"/>` : '';
  const shading = options.header
    ? '<w:shd w:fill="D9EAF7"/>'
    : (options.recovered ? '<w:shd w:fill="FFF3CD"/>' : '');
  const fontSize = options.fontSize ?? 36;
  const values = Array.isArray(value) ? value : String(value ?? '').split('\n');
  const paragraphs = values
    // OOXML хранит размер шрифта в половинах пунктов: 36 = 18 pt.
    .map((item) => wordParagraph(item, { bold: options.header, size: fontSize }))
    .join('');
  return `<w:tc><w:tcPr>${width}${shading}<w:vAlign w:val="top"/></w:tcPr>${paragraphs}</w:tc>`;
}

function wordTable(headers, rows, widths, options = {}) {
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join('');
  const border = '<w:tblBorders><w:top w:val="single" w:sz="4" w:color="9AA9B8"/><w:left w:val="single" w:sz="4" w:color="9AA9B8"/><w:bottom w:val="single" w:sz="4" w:color="9AA9B8"/><w:right w:val="single" w:sz="4" w:color="9AA9B8"/><w:insideH w:val="single" w:sz="4" w:color="C7D2DE"/><w:insideV w:val="single" w:sz="4" w:color="C7D2DE"/></w:tblBorders>';
  const tableWidth = options.tableWidth ? `<w:tblW w:w="${options.tableWidth}" w:type="dxa"/>` : '<w:tblW w:w="0" w:type="auto"/>';
  const fontSize = options.fontSize ?? 36;
  const header = `<w:tr>${headers.map((value, index) => wordCell(value, { header: true, width: widths[index], fontSize })).join('')}</w:tr>`;
  const body = rows.map((row) => {
    const values = Array.isArray(row) ? row : row.cells;
    const recovered = !Array.isArray(row) && row.recovered;
    return `<w:tr>${values.map((value, index) => wordCell(value, { width: widths[index], recovered, fontSize })).join('')}</w:tr>`;
  }).join('');
  return `<w:tbl><w:tblPr>${tableWidth}<w:tblLayout w:type="fixed"/>${border}</w:tblPr><w:tblGrid>${grid}</w:tblGrid>${header}${body}</w:tbl>`;
}

function buildWordDocument(data, reportType) {
  const title = reportType === 'rooms' ? t('thAnalysis.roomsPrintTitle') : t('thAnalysis.productsPrintTitle');
  const parts = [
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>',
    `<w:document xmlns:w="${W_NS}"><w:body>`,
    wordParagraph(title, { bold: true, align: 'center', size: 28, after: 180 }),
    wordParagraph(`${t('thAnalysis.sourceLabel')}: ${state.sourceName}`, { align: 'center', size: 36, after: 220 }),
  ];

  if (reportType === 'rooms') {
    data.rooms.forEach((room, roomIndex) => {
      // Word хранит размер шрифта в половинах пунктов: 80 = 40 pt.
      parts.push(wordParagraph(`${room.room}`, { bold: true, size: 80, after: 40 }));
      parts.push(wordParagraph(`${room.roomType || t('thAnalysis.roomTypeUnknown')} · ${formatQty(room.total)} ${t('thAnalysis.units')}`, { size: 36, after: 100 }));
      if (room.recovered) {
        parts.push(wordParagraph(`⚠ ${t('thAnalysis.recoveredByAnalogy')}`, { bold: true, size: 36, after: 100 }));
      }
      parts.push(wordTable(
        ['№', t('thAnalysis.productColumn'), t('thAnalysis.unitColumn'), t('thAnalysis.quantityColumn')],
        room.items.map((item, index) => ({
          cells: [String(index + 1), item.name, item.unit, formatQty(item.qty)],
          recovered: item.recovered,
        })),
        [650, 6900, 1200, 1500],
      ));
      if (roomIndex < data.rooms.length - 1) parts.push('<w:p><w:r><w:br w:type="page"/></w:r></w:p>');
    });
  } else {
    parts.push(wordTable(
      ['№', t('thAnalysis.productColumn'), t('thAnalysis.unitColumn'), t('thAnalysis.quantityColumn'), t('thAnalysis.roomsColumn')],
      data.products.map((product, index) => ({
        cells: [
          String(index + 1),
          product.name,
          product.unit,
          formatQty(product.total),
          product.rooms.map((room) => `${room.room}; ${room.roomType || t('thAnalysis.roomTypeUnknown')}; ${formatQty(room.qty)}`).join('\n'),
        ],
        recovered: product.recovered,
      })),
      [650, 4700, 1100, 1300, 7648],
      // 28 = 14 pt. Таблица заполняет рабочую ширину альбомной страницы;
      // правый столбец получает всё оставшееся место до правого поля.
      { fontSize: 28, tableWidth: 15398 },
    ));
  }

  parts.push('<w:sectPr><w:pgSz w:w="16838" w:h="11906" w:orient="landscape"/><w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/></w:sectPr></w:body></w:document>');
  return parts.join('');
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

async function exportWord(type) {
  state.activeReport = type;
  updateTabs();
  renderReport();
  if (!state.rows.length) {
    setStatus(t('thAnalysis.nothingToExport'), 'error');
    return;
  }
  setStatus(t('thAnalysis.wordPreparing'));
  try {
    const JSZip = await loadJSZip();
    const data = aggregateRows(state.rows);
    const zip = new JSZip();
    zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`);
    zip.folder('_rels').file('.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
    const word = zip.folder('word');
    word.file('document.xml', buildWordDocument(data, type));
    word.file('styles.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="${W_NS}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/><w:lang w:val="ru-RU"/></w:rPr></w:rPrDefault></w:docDefaults></w:styles>`);
    word.folder('_rels').file('document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    const suffix = type === 'rooms' ? 'po-pomeshcheniyam' : 'po-tovaram';
    downloadBlob(blob, `razbor-th-${suffix}.docx`);
    setStatus(t('thAnalysis.wordReady'), 'success');
  } catch (error) {
    setStatus(`${t('thAnalysis.wordError')}: ${error?.message || error}`, 'error');
  }
}

function docxErrorMessage(error) {
  const messages = {
    DOCX_NO_DOCUMENT: t('thAnalysis.docxNoDocument'),
    DOCX_BAD_XML: t('thAnalysis.docxBadXml'),
    DOCX_NO_TABLE: t('thAnalysis.docxNoTable'),
    DOCX_NO_HEADER: t('thAnalysis.docxNoHeader'),
    DOCX_NO_FURNITURE: t('thAnalysis.noFurniture'),
  };
  return messages[error?.message] || error?.message || String(error);
}

async function analyzeDocx(file) {
  if (!file || !/\.docx$/i.test(file.name)) {
    setStatus(t('thAnalysis.docxOnly'), 'error');
    return;
  }
  setStatus(t('thAnalysis.readingDocx'));
  const input = $('thFileInput');
  if (input) input.disabled = true;
  try {
    const rows = await extractDocxRows(file);
    state.rows = rows;
    state.sourceName = file.name;
    setStatus(t('thAnalysis.ready', { count: rows.length }), 'success');
    showReportView();
  } catch (error) {
    state.rows = [];
    setStatus(`${t('thAnalysis.readError')}: ${docxErrorMessage(error)}`, 'error');
  } finally {
    if (input) input.disabled = false;
  }
}

function showReportView() {
  $('thInputPanel')?.classList.add('hidden');
  const panel = $('thReportPanel');
  panel?.classList.remove('hidden');
  if (panel) {
    panel.style.display = 'flex';
    panel.style.flexDirection = 'column';
    panel.style.minHeight = '0';
    panel.style.overflow = 'hidden';
  }
  ensureThControls();
  renderReport();
  scrollToReportTable('auto');
}

function showInputView() {
  const panel = $('thReportPanel');
  panel?.classList.add('hidden');
  if (panel) panel.style.display = 'none';
  $('thInputPanel')?.classList.remove('hidden');
}

function updateTabs() {
  const active = ['bg-amber-400/20', 'text-amber-200', 'border-amber-400'];
  const inactive = ['text-slate-400', 'border-transparent'];
  [$('thRoomsTab'), $('thProductsTab')].forEach((tab) => tab?.classList.remove(...active, ...inactive));
  const current = state.activeReport === 'rooms' ? $('thRoomsTab') : $('thProductsTab');
  current?.classList.add(...active);
  [$('thRoomsTab'), $('thProductsTab')].filter((tab) => tab && tab !== current).forEach((tab) => tab.classList.add(...inactive));
}

function printReport(type) {
  state.activeReport = type;
  updateTabs();
  renderReport();
  if (!state.rows.length) {
    setStatus(t('thAnalysis.nothingToPrint'), 'error');
    return;
  }
  const previousTitle = document.title;
  document.title = state.activeReport === 'rooms' ? t('thAnalysis.roomsPrintTitle') : t('thAnalysis.productsPrintTitle');
  document.body.classList.add('th-print-mode');
  const cleanup = () => {
    document.body.classList.remove('th-print-mode');
    document.title = previousTitle;
  };
  window.addEventListener('afterprint', cleanup, { once: true });
  window.print();
  setTimeout(cleanup, 1500);
}

function clearReport() {
  state.rows = [];
  state.sourceName = '';
  state.activeReport = 'rooms';
  const input = $('thFileInput');
  if (input) input.value = '';
  showInputView();
  setStatus('');
  updateTabs();
}

function bind() {
  ensureThControls();
  $('thFileInput')?.addEventListener('change', (event) => analyzeDocx(event.target.files?.[0]));
  $('thDropZone')?.addEventListener('dragover', (event) => { event.preventDefault(); event.currentTarget.classList.add('drag-over'); });
  $('thDropZone')?.addEventListener('dragleave', (event) => event.currentTarget.classList.remove('drag-over'));
  $('thDropZone')?.addEventListener('drop', (event) => {
    event.preventDefault();
    event.currentTarget.classList.remove('drag-over');
    analyzeDocx(event.dataTransfer.files?.[0]);
  });
  $('thBackBtn')?.addEventListener('click', showInputView);
  $('thClearBtn')?.addEventListener('click', clearReport);
  $('thRoomsTab')?.addEventListener('click', () => { state.activeReport = 'rooms'; updateTabs(); renderReport(); });
  $('thProductsTab')?.addEventListener('click', () => { state.activeReport = 'products'; updateTabs(); renderReport(); });
  $('thCloseBtn')?.addEventListener('click', closeThAnalysis);
}

export function openThAnalysis() {
  const modal = $('thAnalysisModal');
  if (!modal) return;
  modal.querySelector('.catalog-panel')?.classList.remove('hidden');
  modal.classList.add('open');
  ensureThControls();
  if (state.rows.length) {
    $('thInputPanel')?.classList.add('hidden');
    const panel = $('thReportPanel');
    panel?.classList.remove('hidden');
    if (panel) panel.style.display = 'flex';
    renderReport();
  } else {
    showInputView();
  }
}

export function closeThAnalysis() {
  const modal = $('thAnalysisModal');
  if (!modal) return;
  modal.classList.remove('open');
  modal.querySelector('.catalog-panel')?.classList.add('hidden');
}

export function initThAnalysisView() {
  if (window.__thAnalysisInit) return;
  window.__thAnalysisInit = true;
  bind();
  updateTabs();
}
