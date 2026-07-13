/**
 * frozen-table.js
 * Управление закреплёнными столбцами таблицы.
 *
 * API:
 *   attachFrozenManager(table, key)  — подключить к таблице
 *   refreshFrozenTable(table, key)   — пересчитать после изменения DOM
 *   applyFrozenTable(table, key)     — применить сохранённое состояние
 *
 * Управление: кнопка 📌 появляется в каждом <th> при наведении.
 * Закреплённые столбцы: position:sticky; left:Npx с непрозрачным фоном.
 * Настройки хранятся в sessionStorage.
 */

// Цвета фона для sticky-ячеек
const BG_HEAD = 'rgb(15,23,42)';
const BG_ROW  = 'rgb(2,6,23)';

// ─── Состояние ────────────────────────────────────────────────────

/** @type {Map<string, {frozenCols: number[]}>} */
const _states = new Map();

function getState(key) {
  if (!_states.has(key)) {
    try {
      const raw = sessionStorage.getItem('ft_' + key);
      if (raw) { _states.set(key, JSON.parse(raw)); return _states.get(key); }
    } catch { /* */ }
    _states.set(key, { frozenCols: [] });
  }
  return _states.get(key);
}

function saveState(key, st) {
  _states.set(key, st);
  try { sessionStorage.setItem('ft_' + key, JSON.stringify(st)); } catch { /* */ }
}

// ─── Применение sticky ────────────────────────────────────────────

/**
 * Пересчитывает и применяет sticky-стили ко всем ячейкам таблицы.
 * @param {HTMLTableElement} table
 * @param {string} key
 */
export function applyFrozenTable(table, key) {
  if (!table) return;
  const st = getState(key);
  const frozenCols = new Set(st.frozenCols);

  const allRows = Array.from(table.rows);
  const colLeftMap = buildColLeftMap(table, frozenCols);

  allRows.forEach(tr => {
    const isThead = tr.parentElement?.tagName === 'THEAD';
    const isTfoot = tr.parentElement?.tagName === 'TFOOT';

    Array.from(tr.cells).forEach((cell, colIdx) => {
      const isColFrozen = frozenCols.has(colIdx);

      if (isThead) {
        cell.style.position = 'sticky';
        cell.style.top = '0';
        cell.style.zIndex = isColFrozen ? '30' : '20';
        cell.style.background = BG_HEAD;
        if (isColFrozen) {
          cell.style.left = (colLeftMap.get(colIdx) ?? 0) + 'px';
        } else {
          cell.style.removeProperty('left');
        }
      } else if (isTfoot) {
        cell.style.position = 'sticky';
        cell.style.bottom = '0';
        cell.style.zIndex = isColFrozen ? '25' : '15';
        cell.style.background = BG_HEAD;
        if (isColFrozen) {
          cell.style.left = (colLeftMap.get(colIdx) ?? 0) + 'px';
        } else {
          cell.style.removeProperty('left');
        }
      } else {
        if (isColFrozen) {
          cell.style.position = 'sticky';
          cell.style.left = (colLeftMap.get(colIdx) ?? 0) + 'px';
          cell.style.zIndex = '12';
          cell.style.background = BG_ROW;
          cell.style.removeProperty('top');
        } else {
          cell.style.removeProperty('position');
          cell.style.removeProperty('left');
          cell.style.removeProperty('top');
          cell.style.removeProperty('z-index');
          cell.style.removeProperty('background');
        }
      }
    });
  });

  markFrozenHeaders(table, frozenCols);
}

function buildColLeftMap(table, frozenCols) {
  const map = new Map();
  if (frozenCols.size === 0) return map;

  const refRow = table.tHead?.rows[0] ?? table.tBodies[0]?.rows[0];
  if (!refRow) return map;

  const cells = Array.from(refRow.cells);
  let accumulated = 0;
  for (let i = 0; i < cells.length; i++) {
    if (frozenCols.has(i)) {
      map.set(i, accumulated);
      accumulated += cells[i].offsetWidth || parseInt(cells[i].style.width) || 80;
    }
  }
  return map;
}

function markFrozenHeaders(table, frozenCols) {
  const headRow = table.tHead?.rows[0];
  if (!headRow) return;
  Array.from(headRow.cells).forEach((th, i) => {
    if (frozenCols.has(i)) {
      th.style.borderRight = '2px solid rgba(34,211,238,0.4)';
      th.style.boxShadow = '2px 0 8px rgba(0,0,0,0.25)';
    } else {
      th.style.removeProperty('border-right');
      th.style.removeProperty('box-shadow');
    }
  });
}

/** Вызывается после изменения DOM */
export function refreshFrozenTable(table, key) {
  if (!table || !key) return;
  applyFrozenTable(table, key);
}

// ─── Кнопка закрепления в заголовке ──────────────────────────────

/**
 * Создаёт кнопку 📌 для th.
 * @param {HTMLTableCellElement} th
 * @param {number} colIdx
 * @param {string} key
 * @param {HTMLTableElement} table
 */
function createPinButton(th, colIdx, key, table) {
  // Убираем старую кнопку если есть
  th.querySelector('.ft-pin-btn')?.remove();

  const st = getState(key);
  const isFrozen = st.frozenCols.includes(colIdx);

  const btn = document.createElement('button');
  btn.className = 'ft-pin-btn';
  btn.type = 'button';
  btn.title = isFrozen ? 'Открепить столбец' : 'Закрепить столбец';
  btn.setAttribute('aria-label', isFrozen ? 'Открепить столбец' : 'Закрепить столбец');
  btn.style.cssText = [
    'position:absolute',
    'top:2px',
    'right:2px',
    'width:18px',
    'height:18px',
    'border-radius:4px',
    'border:none',
    'cursor:pointer',
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'font-size:10px',
    'line-height:1',
    'transition:opacity 0.15s, background 0.15s',
    'z-index:40',
    isFrozen
      ? 'opacity:0.9;background:rgba(34,211,238,0.25);color:rgb(34,211,238)'
      : 'opacity:0;background:rgba(255,255,255,0.08);color:rgb(148,163,184)',
  ].join(';');
  btn.textContent = '📌';

  // Показываем кнопку при наведении на th
  th.addEventListener('mouseenter', () => {
    if (!btn.closest('th')?.contains(btn)) return;
    btn.style.opacity = '1';
  });
  th.addEventListener('mouseleave', () => {
    const s = getState(key);
    if (!s.frozenCols.includes(colIdx)) btn.style.opacity = '0';
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    e.preventDefault();
    const s = getState(key);
    if (s.frozenCols.includes(colIdx)) {
      s.frozenCols = s.frozenCols.filter(c => c !== colIdx);
    } else {
      s.frozenCols = [...new Set([...s.frozenCols, colIdx])].sort((a, b) => a - b);
    }
    saveState(key, s);
    applyFrozenTable(table, key);
    // Обновляем все кнопки в этой таблице
    rebuildPinButtons(table, key);
  });

  // th должен быть position:relative для абсолютного позиционирования кнопки
  if (getComputedStyle(th).position === 'static') {
    th.style.position = 'relative';
  }

  th.appendChild(btn);
}

function rebuildPinButtons(table, key) {
  const headRow = table.tHead?.rows[0];
  if (!headRow) return;
  Array.from(headRow.cells).forEach((th, colIdx) => {
    createPinButton(th, colIdx, key, table);
  });
  applyFrozenTable(table, key);
}

// ─── Публичный API ────────────────────────────────────────────────

/**
 * Подключает управление заморозкой к таблице.
 * @param {HTMLTableElement} table
 * @param {string} key  — уникальный ключ для хранения настроек
 */
export function attachFrozenManager(table, key) {
  if (!table || !key) return;

  // Применяем сохранённое состояние
  applyFrozenTable(table, key);

  // Добавляем кнопки 📌 в заголовки
  const headRow = table.tHead?.rows[0];
  if (headRow) {
    Array.from(headRow.cells).forEach((th, colIdx) => {
      createPinButton(th, colIdx, key, table);
    });
  }
}
