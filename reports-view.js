/**
 * Reports View — меню отчётов + отчёт ДОНМ (движение по товарным группам).
 *
 * Структура:
 *   reportsPanel     — экран меню (список кнопок отчётов)
 *   reportsDonmPanel — экран отчёта ДОНМ
 *
 * Макет таблицы:
 *   - Заголовок (thead) — sticky top:0, не скроллится вертикально
 *   - Тело (tbody) — скроллится вертикально
 *   - Горизонтальная прокрутка — фиксирована снизу контейнера
 */

import { state } from '../state.js';
import { loadXLSX } from './lib-loader.js';
import { showToast } from './toast.js';
import { initAiReportsView, openAiReportsPanel, closeAiReportsPanel } from './ai-reports-view.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── Helpers ──────────────────────────────────────────────────────────────────

function ov(id) { return document.getElementById(id); }

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function resolveGroup(productId, productCode, productName) {
  let prod = null;
  if (productId) prod = state.products.find(p => p.id === productId);
  if (!prod && productCode) {
    const c = (productCode || '').trim().toLowerCase();
    prod = state.products.find(p => (p.code || '').trim().toLowerCase() === c);
  }
  if (!prod && productName) {
    const n = (productName || '').trim().toLowerCase();
    prod = state.products.find(p => (p.name || '').trim().toLowerCase() === n);
  }
  return (prod?.productGroup) || '— Без группы —';
}

/** Проверяет, требует ли товар сборки */
function productNeedsAssembly(productId, productCode, productName) {
  let prod = null;
  if (productId) prod = state.products.find(p => p.id === productId);
  if (!prod && productCode) {
    const c = (productCode || '').trim().toLowerCase();
    prod = state.products.find(p => (p.code || '').trim().toLowerCase() === c);
  }
  if (!prod && productName) {
    const n = (productName || '').trim().toLowerCase();
    prod = state.products.find(p => (p.name || '').trim().toLowerCase() === n);
  }
  return prod?.assemblyRequired === 'required' || prod?.assembly === 'required';
}

// ─── Data aggregation ─────────────────────────────────────────────────────────

function buildReportData() {
  const groups = new Map();

  function ensure(g) {
    if (!groups.has(g)) {
      groups.set(g, {
        need: 0,
        contracted: 0,
        ordered: 0,
        toWarehouse: 0,
        toRecipient: 0,
        needsAssembly: 0,   // доставлено в ОО, требующих сборки
        assembled: 0,
      });
    }
    return groups.get(g);
  }

  // Потребность
  for (const recipient of (state.recipients || [])) {
    for (const [pidStr, entry] of Object.entries(recipient.needs || {})) {
      const qty = typeof entry === 'object' ? (entry.qty || 0) : (Number(entry) || 0);
      if (qty <= 0) continue;
      const group = resolveGroup(Number(pidStr), null, null);
      ensure(group).need += qty;
    }
  }

  // Законтрактовано
  const contractedByProduct = new Map();
  for (const contract of (state.contracts || [])) {
    for (const item of (contract.items || [])) {
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      const pid = item.productRef ?? item.productId ?? null;
      if (pid) {
        contractedByProduct.set(pid, (contractedByProduct.get(pid) || 0) + qty);
      } else {
        const nameLow = (item.name || '').trim().toLowerCase();
        if (nameLow) {
          const prod = state.products.find(p => (p.name || '').trim().toLowerCase() === nameLow);
          if (prod) contractedByProduct.set(prod.id, (contractedByProduct.get(prod.id) || 0) + qty);
        }
      }
    }
  }
  for (const [pid, qty] of contractedByProduct.entries()) {
    ensure(resolveGroup(pid, null, null)).contracted += qty;
  }

  // Заказано (только отправленные заявки)
  for (const order of (state.orders || []).filter(o => o.sent === true)) {
    const rows = Array.isArray(order.deliveryRows) && order.deliveryRows.length > 0
      ? order.deliveryRows : (order.items || []);
    for (const item of rows) {
      const qty = Number(item.qty) || 0;
      if (qty <= 0) continue;
      const group = resolveGroup(
        item.productId ?? null,
        item.productCode ?? item.contractItemCode ?? null,
        item.productName ?? item.contractItemName ?? null,
      );
      ensure(group).ordered += qty;
    }
  }

  // Доставлено на склад
  for (const entry of (state.warehouseEntries || [])) {
    const items = Array.isArray(entry.items) && entry.items.length > 0 ? entry.items : null;
    if (items) {
      for (const item of items) {
        const qty = Number(item.qty) || 0;
        if (qty <= 0) continue;
        ensure(resolveGroup(item.productId, item.productCode, item.productName)).toWarehouse += qty;
      }
    } else {
      const qty = Number(entry.received) || 0;
      if (qty > 0) ensure(resolveGroup(entry.productId, entry.productCode, entry.productName)).toWarehouse += qty;
    }
  }

  // Доставлено в ОО + в т.ч. требуется сборка
  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      const rowTotal = (row.recipients || []).reduce((s, r) => s + (Number(r.qty) || 0), 0);
      if (rowTotal > 0) {
        const g = resolveGroup(row.productId, row.productCode, row.productName);
        ensure(g).toRecipient += rowTotal;
        // Проверяем признак сборки
        if (productNeedsAssembly(row.productId, row.productCode, row.productName)) {
          ensure(g).needsAssembly += rowTotal;
        }
      }
    }
  }

  // Собрано
  for (const act of (state.assemblyActs || [])) {
    for (const item of (act.items || [])) {
      const qty = Number(item.assembled) || 0;
      if (qty > 0) ensure(resolveGroup(item.productId, item.productCode, item.productName)).assembled += qty;
    }
  }

  // Все товарные группы из справочника (даже пустые)
  for (const g of (state.productGroups || [])) ensure(g);

  return groups;
}

// ─── Column config ────────────────────────────────────────────────────────────

const COLS = [
  { key: 'contracted',   label: 'Законтрактовано' },
  { key: 'ordered',      label: 'Заказано' },
  { key: 'toWarehouse',  label: 'Доставлено на склад' },
  { key: 'toRecipient',  label: 'Доставлено в ОО' },
  { key: 'needsAssembly',label: 'в т.ч. треб. сборку', subLabel: 'из доставленных в ОО' },
  { key: 'assembled',    label: 'Собрано' },
];

const SS_KEY = 'reports_config_v3';

function loadConfig() {
  try {
    const raw = sessionStorage.getItem(SS_KEY);
    if (raw) return JSON.parse(raw);
  } catch { /* */ }
  return { hiddenCols: [], hiddenRows: [], showZeroRows: true };
}

function saveConfig(cfg) {
  try { sessionStorage.setItem(SS_KEY, JSON.stringify(cfg)); } catch { /* */ }
}

let _cfg = loadConfig();

// ─── Rendering ────────────────────────────────────────────────────────────────

let _reportData = new Map();

function renderReport() {
  _reportData = buildReportData();
  renderSettings();
  renderTable();
}

function renderSettings() {
  const wrap = ov('reportsSettingsWrap');
  if (!wrap) return;

  const allGroups = [..._reportData.keys()].sort((a, b) => a.localeCompare(b));

  wrap.innerHTML = `
    <div class="flex flex-wrap gap-4 items-start">
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Столбцы</p>
        <div class="flex flex-wrap gap-2">
          <label class="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" disabled checked class="accent-cyan-400 w-3.5 h-3.5 opacity-50">
            <span class="text-xs text-slate-400">Потребность</span>
          </label>
          ${COLS.map(c => `
            <label class="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" class="col-toggle accent-cyan-400 w-3.5 h-3.5"
                data-col="${escHtml(c.key)}"
                ${_cfg.hiddenCols.includes(c.key) ? '' : 'checked'}>
              <span class="text-xs text-slate-300">${escHtml(c.label)}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div>
        <p class="text-[10px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Строки</p>
        <div class="flex flex-wrap gap-2">
          <label class="flex items-center gap-1.5 cursor-pointer select-none">
            <input type="checkbox" id="showZeroRowsToggle" class="accent-cyan-400 w-3.5 h-3.5"
              ${_cfg.showZeroRows ? 'checked' : ''}>
            <span class="text-xs text-slate-300">Показывать пустые группы</span>
          </label>
        </div>
        ${allGroups.length > 0 ? `
        <div class="flex flex-wrap gap-2 mt-2 max-h-24 overflow-y-auto pr-1">
          ${allGroups.map(g => `
            <label class="flex items-center gap-1.5 cursor-pointer select-none">
              <input type="checkbox" class="row-toggle accent-cyan-400 w-3.5 h-3.5"
                data-row="${escHtml(g)}"
                ${_cfg.hiddenRows.includes(g) ? '' : 'checked'}>
              <span class="text-xs text-slate-300 truncate max-w-[140px]"
                title="${escHtml(g)}">${escHtml(g)}</span>
            </label>
          `).join('')}
        </div>` : ''}
      </div>
    </div>`;

  wrap.querySelectorAll('.col-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const col = cb.dataset.col;
      if (cb.checked) _cfg.hiddenCols = _cfg.hiddenCols.filter(c => c !== col);
      else if (!_cfg.hiddenCols.includes(col)) _cfg.hiddenCols.push(col);
      saveConfig(_cfg); renderTable();
    });
  });

  wrap.querySelectorAll('.row-toggle').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = cb.dataset.row;
      if (cb.checked) _cfg.hiddenRows = _cfg.hiddenRows.filter(r => r !== row);
      else if (!_cfg.hiddenRows.includes(row)) _cfg.hiddenRows.push(row);
      saveConfig(_cfg); renderTable();
    });
  });

  const showZeroToggle = ov('showZeroRowsToggle');
  if (showZeroToggle) {
    showZeroToggle.addEventListener('change', () => {
      _cfg.showZeroRows = showZeroToggle.checked;
      saveConfig(_cfg); renderTable();
    });
  }
}

// ─── Cell formatters ──────────────────────────────────────────────────────────

function fmtCell(val, need) {
  if (val <= 0) return `<span class="tabular-nums text-slate-600">—</span>`;
  let pctHtml = need > 0
    ? `<span class="block text-[10px] tabular-nums text-slate-400">${Math.round(val / need * 100)}%</span>`
    : '';
  return `<span class="tabular-nums font-medium text-white">${val.toLocaleString('ru-RU')}</span>${pctHtml}`;
}

function fmtNeed(val) {
  return val > 0
    ? `<span class="tabular-nums font-semibold text-violet-300">${val.toLocaleString('ru-RU')}</span>`
    : `<span class="tabular-nums text-slate-600">—</span>`;
}

function fmtContracted(val, need) {
  if (val <= 0) return `<span class="tabular-nums text-slate-600">—</span>`;
  let pctHtml = need > 0
    ? `<span class="block text-[10px] tabular-nums text-slate-400">${Math.round(val / need * 100)}%</span>`
    : '';
  return `<span class="tabular-nums font-medium text-sky-300">${val.toLocaleString('ru-RU')}</span>${pctHtml}`;
}

/** needsAssembly: показываем кол-во и % от доставленного в ОО */
function fmtNeedsAssembly(val, toRecipient) {
  if (val <= 0) return `<span class="tabular-nums text-slate-600">—</span>`;
  let pctHtml = toRecipient > 0
    ? `<span class="block text-[10px] tabular-nums text-slate-400">${Math.round(val / toRecipient * 100)}% от дост.</span>`
    : '';
  return `<span class="tabular-nums font-medium text-amber-300">${val.toLocaleString('ru-RU')}</span>${pctHtml}`;
}

/** assembled: показываем кол-во и % от needsAssembly (требует сборки) */
function fmtAssembled(val, needsAssembly) {
  if (val <= 0) return `<span class="tabular-nums text-slate-600">—</span>`;
  if (needsAssembly > 0) {
    const pct = Math.round(val / needsAssembly * 100);
    const color = pct >= 100 ? 'text-emerald-400' : pct >= 50 ? 'text-amber-400' : 'text-red-400';
    return `<span class="tabular-nums font-medium text-white">${val.toLocaleString('ru-RU')}</span>
      <span class="block text-[10px] tabular-nums ${color}">${pct}% от треб.сб.</span>`;
  }
  return `<span class="tabular-nums font-medium text-white">${val.toLocaleString('ru-RU')}</span>`;
}

function renderTable() {
  const wrap = ov('reportsTableWrap');
  if (!wrap) return;

  const visibleCols = COLS.filter(c => !_cfg.hiddenCols.includes(c.key));
  const allGroups = [..._reportData.keys()].sort((a, b) => a.localeCompare(b));

  const rows = allGroups.filter(g => {
    if (_cfg.hiddenRows.includes(g)) return false;
    if (!_cfg.showZeroRows) {
      const d = _reportData.get(g);
      return d.need > 0 || visibleCols.some(c => (d[c.key] || 0) > 0);
    }
    return true;
  });

  if (rows.length === 0) {
    wrap.innerHTML = `
      <div class="flex flex-col items-center justify-center py-16 text-center">
        <span class="text-5xl mb-4" aria-hidden="true">📊</span>
        <p class="text-sm font-semibold text-slate-300">Нет данных для отображения</p>
        <p class="text-xs text-slate-500 mt-1">Добавьте товарные группы в каталоге и заполните данные в модулях</p>
      </div>`;
    return;
  }

  const totals = { need: 0 };
  visibleCols.forEach(c => { totals[c.key] = 0; });
  rows.forEach(g => {
    const d = _reportData.get(g);
    totals.need += (d.need || 0);
    visibleCols.forEach(c => { totals[c.key] += (d[c.key] || 0); });
  });

  const minW = 180 + 110 + visibleCols.length * 140;

  // ── Рендерим thead отдельно (фиксированный) и tbody в скролл-контейнере ──
  // Это позволяет горизонтальному скроллбару быть всегда снизу,
  // а заголовку — не скроллиться вертикально.

  function buildTheadHTML() {
    return `
      <thead>
        <tr style="background:rgb(15,23,42);">
          <th style="background:rgb(15,23,42);text-align:left;padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgb(148,163,184);border-bottom:1px solid rgba(255,255,255,0.1);white-space:nowrap;min-width:180px;">Товарная группа</th>
          <th style="background:rgb(15,23,42);text-align:right;padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgb(167,139,250);border-bottom:1px solid rgba(255,255,255,0.1);white-space:nowrap;min-width:110px;">Потребность</th>
          ${visibleCols.map(c => `
            <th style="background:rgb(15,23,42);text-align:right;padding:10px 16px;font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:${c.key === 'contracted' ? 'rgb(125,211,252)' : c.key === 'needsAssembly' ? 'rgb(252,211,77)' : 'rgb(148,163,184)'};border-bottom:1px solid rgba(255,255,255,0.1);white-space:nowrap;min-width:140px;">
              <span style="display:block;">${escHtml(c.label)}</span>
              <span style="display:block;font-size:9px;font-weight:400;color:rgb(71,85,105);text-transform:none;letter-spacing:0;">${c.key === 'assembled' ? '% от треб. сборку' : c.key === 'needsAssembly' ? '% от дост. в ОО' : 'кол-во / % от потр.'}</span>
            </th>
          `).join('')}
        </tr>
        <tr style="background:rgb(28,37,54);">
          <td style="background:rgb(28,37,54);padding:8px 16px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:rgb(34,211,238);border-bottom:2px solid rgba(255,255,255,0.2);white-space:nowrap;">Итого</td>
          <td style="background:rgb(28,37,54);padding:8px 16px;text-align:right;border-bottom:2px solid rgba(255,255,255,0.2);">
            <span style="font-family:monospace;font-weight:700;color:rgb(167,139,250);">${totals.need > 0 ? totals.need.toLocaleString('ru-RU') : '—'}</span>
          </td>
          ${visibleCols.map(c => {
            const val = totals[c.key] || 0;
            const need = totals.need;
            let html = '';
            if (c.key === 'contracted') {
              if (val <= 0) html = '<span style="color:rgb(71,85,105);">—</span>';
              else {
                const pct = need > 0 ? Math.round(val / need * 100) : 0;
                html = `<span style="font-family:monospace;font-weight:700;color:rgb(125,211,252);">${val.toLocaleString('ru-RU')}</span>${need > 0 ? `<span style="display:block;font-size:10px;color:rgb(100,116,139);">${pct}%</span>` : ''}`;
              }
            } else if (c.key === 'needsAssembly') {
              if (val <= 0) html = '<span style="color:rgb(71,85,105);">—</span>';
              else {
                const toR = totals.toRecipient || 0;
                const pct = toR > 0 ? Math.round(val / toR * 100) : 0;
                html = `<span style="font-family:monospace;font-weight:700;color:rgb(252,211,77);">${val.toLocaleString('ru-RU')}</span>${toR > 0 ? `<span style="display:block;font-size:10px;color:rgb(100,116,139);">${pct}% от дост.</span>` : ''}`;
              }
            } else if (c.key === 'assembled') {
              if (val <= 0) html = '<span style="color:rgb(71,85,105);">—</span>';
              else {
                const na = totals.needsAssembly || 0;
                if (na > 0) {
                  const pct = Math.round(val / na * 100);
                  const clr = pct >= 100 ? 'rgb(52,211,153)' : pct >= 50 ? 'rgb(251,191,36)' : 'rgb(248,113,113)';
                  html = `<span style="font-family:monospace;font-weight:700;color:rgb(226,232,240);">${val.toLocaleString('ru-RU')}</span><span style="display:block;font-size:10px;color:${clr};">${pct}% от треб.сб.</span>`;
                } else {
                  html = `<span style="font-family:monospace;font-weight:700;color:rgb(226,232,240);">${val.toLocaleString('ru-RU')}</span>`;
                }
              }
            } else {
              if (val <= 0) html = '<span style="color:rgb(71,85,105);">—</span>';
              else {
                const pct = need > 0 ? Math.round(val / need * 100) : 0;
                html = `<span style="font-family:monospace;font-weight:700;color:rgb(226,232,240);">${val.toLocaleString('ru-RU')}</span>${need > 0 ? `<span style="display:block;font-size:10px;color:rgb(100,116,139);">${pct}%</span>` : ''}`;
              }
            }
            return `<td style="background:rgb(28,37,54);padding:8px 16px;text-align:right;border-bottom:2px solid rgba(255,255,255,0.2);">${html}</td>`;
          }).join('')}
        </tr>
      </thead>`;
  }

  function buildTbodyHTML() {
    return `
      <tbody>
        ${rows.map((g, idx) => {
          const d = _reportData.get(g);
          const bg = idx % 2 === 0 ? 'rgb(2,6,23)' : 'rgba(15,23,42,0.5)';
          return `
            <tr style="background:${bg};">
              <td style="padding:10px 16px;font-size:13px;color:rgb(226,232,240);border-bottom:1px solid rgba(255,255,255,0.05);">${escHtml(g)}</td>
              <td style="padding:10px 16px;text-align:right;border-bottom:1px solid rgba(255,255,255,0.05);">${fmtNeed(d.need || 0)}</td>
              ${visibleCols.map(c => {
                let cellHtml = '';
                if (c.key === 'contracted') cellHtml = fmtContracted(d[c.key] || 0, d.need || 0);
                else if (c.key === 'needsAssembly') cellHtml = fmtNeedsAssembly(d[c.key] || 0, d.toRecipient || 0);
                else if (c.key === 'assembled') cellHtml = fmtAssembled(d[c.key] || 0, d.needsAssembly || 0);
                else cellHtml = fmtCell(d[c.key] || 0, d.need || 0);
                return `<td style="padding:10px 16px;text-align:right;border-bottom:1px solid rgba(255,255,255,0.05);">${cellHtml}</td>`;
              }).join('')}
            </tr>`;
        }).join('')}
      </tbody>`;
  }

  // Единый контейнер с overflow:auto — горизонтальный скролл один.
  // thead получает position:sticky + top:0 через inline-style на каждой строке,
  // поэтому заголовок не уходит при вертикальной прокрутке,
  // а горизонтальный скролл работает для всей таблицы целиком.

  wrap.innerHTML = `
    <div id="rptScrollBox" style="overflow-x:auto;overflow-y:auto;height:100%;border-radius:0.75rem;border:1px solid rgba(255,255,255,0.1);scrollbar-gutter:stable;">
      <table id="rptTable" style="border-collapse:collapse;min-width:${minW}px;border-spacing:0;width:max-content;min-width:100%;">
        ${buildTheadHTML()}
        ${buildTbodyHTML()}
      </table>
    </div>`;

  // Делаем ячейки thead sticky после вставки в DOM
  const rptTable = ov('rptTable');
  if (rptTable) {
    rptTable.querySelectorAll('thead tr:nth-child(1) th, thead tr:nth-child(1) td').forEach(cell => {
      cell.style.position = 'sticky';
      cell.style.top = '0';
      cell.style.zIndex = '20';
    });
    rptTable.querySelectorAll('thead tr:nth-child(2) th, thead tr:nth-child(2) td').forEach(cell => {
      cell.style.position = 'sticky';
      cell.style.top = cell.closest('tr').previousElementSibling
        ? (cell.closest('tr').previousElementSibling.offsetHeight || 41) + 'px'
        : '41px';
      cell.style.zIndex = '19';
    });
  }
}

// ─── Export to Excel ──────────────────────────────────────────────────────────

async function exportToExcel() {
  const btn = ov('reportsExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Загрузка…'; }

  try {
    const XLSX = await loadXLSX();
    const visibleCols = COLS.filter(c => !_cfg.hiddenCols.includes(c.key));
    const allGroups = [..._reportData.keys()].sort((a, b) => a.localeCompare(b));
    const rows = allGroups.filter(g => {
      if (_cfg.hiddenRows.includes(g)) return false;
      if (!_cfg.showZeroRows) {
        const d = _reportData.get(g);
        return d.need > 0 || visibleCols.some(c => (d[c.key] || 0) > 0);
      }
      return true;
    });

    const headerRow1 = ['Товарная группа', 'Потребность'];
    const headerRow2 = ['', ''];
    visibleCols.forEach(c => {
      if (c.key === 'assembled') {
        headerRow1.push(c.label, '');
        headerRow2.push('Количество', '% от треб. сборку');
      } else if (c.key === 'needsAssembly') {
        headerRow1.push(c.label, '');
        headerRow2.push('Количество', '% от дост. в ОО');
      } else {
        headerRow1.push(c.label, '');
        headerRow2.push('Количество', '% от потребности');
      }
    });

    const data = [headerRow1, headerRow2];
    rows.forEach(g => {
      const d = _reportData.get(g);
      const row = [g, d.need || 0];
      visibleCols.forEach(c => {
        const val = d[c.key] || 0;
        if (c.key === 'assembled') {
          const na = d.needsAssembly || 0;
          row.push(val, na > 0 ? +(val / na * 100).toFixed(1) : '');
        } else if (c.key === 'needsAssembly') {
          const toR = d.toRecipient || 0;
          row.push(val, toR > 0 ? +(val / toR * 100).toFixed(1) : '');
        } else {
          row.push(val, d.need > 0 ? +(val / d.need * 100).toFixed(1) : '');
        }
      });
      data.push(row);
    });

    const totalNeed = rows.reduce((s, g) => s + (_reportData.get(g).need || 0), 0);
    const totalsRow = ['Итого', totalNeed];
    visibleCols.forEach(c => {
      const val = rows.reduce((s, g) => s + (_reportData.get(g)[c.key] || 0), 0);
      if (c.key === 'assembled') {
        const na = rows.reduce((s, g) => s + (_reportData.get(g).needsAssembly || 0), 0);
        totalsRow.push(val, na > 0 ? +(val / na * 100).toFixed(1) : '');
      } else if (c.key === 'needsAssembly') {
        const toR = rows.reduce((s, g) => s + (_reportData.get(g).toRecipient || 0), 0);
        totalsRow.push(val, toR > 0 ? +(val / toR * 100).toFixed(1) : '');
      } else {
        totalsRow.push(val, totalNeed > 0 ? +(val / totalNeed * 100).toFixed(1) : '');
      }
    });
    data.push(totalsRow);

    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!merges'] = [];
    let col = 2;
    visibleCols.forEach(() => { ws['!merges'].push({ s: { r: 0, c: col }, e: { r: 0, c: col + 1 } }); col += 2; });
    ws['!cols'] = [{ wch: 35 }, { wch: 14 }];
    visibleCols.forEach(() => { ws['!cols'].push({ wch: 14 }, { wch: 18 }); });

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Движение товаров');
    XLSX.writeFile(wb, `report-donm-${new Date().toISOString().slice(0, 10)}.xlsx`);
    showToast('Отчёт выгружен в Excel', 'success');
  } catch (err) {
    showToast('Ошибка экспорта: ' + (err.message || err), 'error');
    console.error('[reports] export error', err);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Excel'; }
  }
}

// ─── Panel navigation ─────────────────────────────────────────────────────────

/** Показать экран меню отчётов */
function showReportsMenu() {
  ov('reportsMenuPanel')?.classList.remove('hidden');
  ov('reportsDonmPanel')?.classList.add('hidden');
  // Закрываем AI-панель через её публичный метод (убирает ai-panel-open)
  closeAiReportsPanel();
}

/** Открыть отчёт ДОНМ */
function openDonmReport() {
  ov('reportsMenuPanel')?.classList.add('hidden');
  closeAiReportsPanel();
  const panel = ov('reportsDonmPanel');
  if (panel) panel.classList.remove('hidden');
  _cfg = loadConfig();
  renderReport();
}

/** Открыть ИИ-ассистент */
function openAiPanel() {
  ov('reportsMenuPanel')?.classList.add('hidden');
  ov('reportsDonmPanel')?.classList.add('hidden');
  openAiReportsPanel();
}

// ─── Modal open/close ─────────────────────────────────────────────────────────

export function openReportsModal() {
  const overlay = ov('reportsModal');
  if (!overlay) return;
  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');
  overlay.classList.add('open');
  showReportsMenu();
}

export function closeReportsModal() {
  const overlay = ov('reportsModal');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.querySelector('.catalog-panel')?.classList.add('hidden');
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initReportsView() {
  ov('reportsCloseBtn')?.addEventListener('click', closeReportsModal);
  ov('reportsBackBtn')?.addEventListener('click', closeReportsModal);

  // Кнопка «Назад» в отчёте ДОНМ → меню
  ov('reportsDonmBackBtn')?.addEventListener('click', showReportsMenu);

  // Кнопка «Отчёт ДОНМ» в меню
  ov('reportsDonmMenuBtn')?.addEventListener('click', openDonmReport);

  // Кнопка «ИИ-ассистент» в меню
  ov('reportsAiMenuBtn')?.addEventListener('click', openAiPanel);

  // Кнопка «Назад» в панели ИИ → меню
  ov('reportsAiBackBtn')?.addEventListener('click', showReportsMenu);

  // Инициализация вью ИИ-ассистента
  initAiReportsView();

  ov('reportsExportBtn')?.addEventListener('click', exportToExcel);
  ov('reportsRefreshBtn')?.addEventListener('click', () => { renderReport(); showToast('Данные обновлены', 'success'); });

  const modal = ov('reportsModal');
  if (modal) {
    modal.addEventListener('click', e => { if (e.target === modal) closeReportsModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeReportsModal();
    });
  }
}
