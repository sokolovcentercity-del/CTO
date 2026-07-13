/**
 * ui/ai-reports-view.js
 * Панель ИИ-ассистента отчётов: чат-интерфейс + таблица результатов.
 */

import { sendMessage } from './ai-reports-service.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';

const $ = id => document.getElementById(id);

// ── State ─────────────────────────────────────────────────────────
const _history = []; // { role: 'user'|'assistant', content: string }
let _lastResult = null;
let _initialized = false;

// ── Escape HTML ───────────────────────────────────────────────────
function esc(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Inject CSS один раз ───────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById('aiDotStyle')) return;
  const style = document.createElement('style');
  style.id = 'aiDotStyle';
  style.textContent = `
    @keyframes ai-dot {
      0%,80%,100%{transform:scale(0.6);opacity:0.4}
      40%{transform:scale(1);opacity:1}
    }
    .ai-followup-btn:hover {
      background:rgba(34,211,238,0.1)!important;
      border-color:rgba(34,211,238,0.3)!important;
      color:rgb(34,211,238)!important;
    }
    #reportsAiPanel {
      display: none;
      flex-direction: column;
      flex: 1 1 0;
      min-height: 0;
      overflow: hidden;
    }
    #reportsAiPanel.ai-panel-open {
      display: flex !important;
    }
  `;
  document.head.appendChild(style);
}

// ── Рендер сообщения в чате ───────────────────────────────────────
function appendMessage(role, html, extra = '') {
  const feed = $('aiReportsFeed');
  if (!feed) return;

  const isUser = role === 'user';
  const bubble = document.createElement('div');
  bubble.style.cssText = `display:flex;flex-direction:column;align-items:${isUser ? 'flex-end' : 'flex-start'};margin-bottom:0.75rem;`;
  bubble.innerHTML = `
    <div style="
      max-width:85%;
      background:${isUser
        ? 'linear-gradient(135deg,rgba(6,182,212,0.18),rgba(34,211,238,0.12))'
        : 'rgba(255,255,255,0.05)'};
      border:1px solid ${isUser ? 'rgba(34,211,238,0.25)' : 'rgba(255,255,255,0.08)'};
      border-radius:${isUser ? '1rem 1rem 0.25rem 1rem' : '1rem 1rem 1rem 0.25rem'};
      padding:0.6rem 0.9rem;
      font-size:0.82rem;
      color:${isUser ? 'rgb(224,242,254)' : 'rgb(226,232,240)'};
      line-height:1.5;
    ">${html}</div>
    ${extra}
  `;
  feed.appendChild(bubble);
  feed.scrollTop = feed.scrollHeight;
}

// ── Рендер таблицы результатов ────────────────────────────────────
function renderResultTable(result) {
  const wrap = $('aiReportsTableWrap');
  if (!wrap) return;

  if (!result || !result.rows || result.rows.length === 0) {
    wrap.innerHTML = '';
    return;
  }

  const { rows, columns, title } = result;
  const cols = columns && columns.length > 0
    ? columns
    : Object.keys(rows[0]).filter(k => !k.startsWith('_')).map(k => ({ key: k, label: k }));

  const minW = Math.max(400, cols.length * 140);

  wrap.innerHTML = `
    <div style="margin-top:0.75rem;border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;overflow:hidden;">
      ${title ? `<div style="padding:0.5rem 0.9rem;background:rgba(6,182,212,0.1);border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.78rem;font-weight:600;color:rgb(34,211,238)">${esc(title)}</div>` : ''}
      <div style="overflow-x:auto;max-height:320px;overflow-y:auto;">
        <table style="border-collapse:collapse;width:100%;min-width:${minW}px;font-size:0.78rem;">
          <thead>
            <tr style="background:rgb(15,23,42);">
              ${cols.map(c => `<th style="padding:0.45rem 0.75rem;text-align:left;font-weight:600;color:rgb(148,163,184);border-bottom:1px solid rgba(255,255,255,0.1);white-space:nowrap;">${esc(c.label)}</th>`).join('')}
            </tr>
          </thead>
          <tbody>
            ${rows.slice(0, 200).map((row, i) => `
              <tr style="background:${i % 2 === 0 ? 'rgb(2,6,23)' : 'rgba(15,23,42,0.5)'};">
                ${cols.map(c => {
                  const v = row[c.key];
                  const isNum = typeof v === 'number';
                  return `<td style="padding:0.4rem 0.75rem;border-bottom:1px solid rgba(255,255,255,0.05);${isNum ? 'text-align:right;font-variant-numeric:tabular-nums;' : ''}">${esc(v ?? '—')}</td>`;
                }).join('')}
              </tr>
            `).join('')}
          </tbody>
          ${rows.length > 200 ? `<tfoot><tr><td colspan="${cols.length}" style="padding:0.4rem 0.75rem;color:rgb(100,116,139);font-size:0.72rem;">Показано 200 из ${rows.length} строк</td></tr></tfoot>` : ''}
        </table>
      </div>
    </div>`;
}

// ── Рендер кнопок follow-up ───────────────────────────────────────
function renderFollowUp(followUp) {
  if (!followUp || !followUp.length) return '';
  const btns = followUp.map(q =>
    `<button class="ai-followup-btn" data-q="${esc(q)}" style="
      background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.1);
      border-radius:1rem;padding:0.3rem 0.75rem;font-size:0.75rem;color:rgb(148,163,184);
      cursor:pointer;white-space:nowrap;transition:all 0.15s;
    ">${esc(q)}</button>`
  ).join('');
  return `<div style="display:flex;flex-wrap:wrap;gap:0.4rem;margin-top:0.5rem;">${btns}</div>`;
}

// ── Отправить вопрос ──────────────────────────────────────────────
async function submitQuestion(text) {
  const input = $('aiReportsInput');
  const sendBtn = $('aiReportsSendBtn');
  if (!text || !text.trim()) return;

  appendMessage('user', esc(text));
  _history.push({ role: 'user', content: text });

  if (input)   { input.value = ''; input.disabled = true; }
  if (sendBtn) sendBtn.disabled = true;
  $('aiReportsExportBtn')?.classList.add('hidden');

  // Индикатор загрузки
  const loadingId = 'aiLoading_' + Date.now();
  const feed = $('aiReportsFeed');
  if (feed) {
    const loader = document.createElement('div');
    loader.id = loadingId;
    loader.style.cssText = 'display:flex;align-items:center;gap:0.5rem;padding:0.5rem 0;font-size:0.78rem;color:rgb(100,116,139);';
    loader.innerHTML = `
      <span style="display:inline-flex;gap:3px;">
        ${[0,1,2].map(i => `<span style="width:5px;height:5px;border-radius:50%;background:rgb(34,211,238);animation:ai-dot 1.2s ${i*0.2}s ease-in-out infinite;"></span>`).join('')}
      </span>
      <span>DeepSeek анализирует данные…</span>`;
    feed.appendChild(loader);
    feed.scrollTop = feed.scrollHeight;
  }

  try {
    const result = await sendMessage(text, _history.slice(0, -1));
    _lastResult = result;

    document.getElementById(loadingId)?.remove();

    const followUpHtml = renderFollowUp(result.follow_up);
    const answerHtml = `<div>${esc(result.answer)}</div>
      ${result.rows?.length ? `<div style="font-size:0.72rem;color:rgb(100,116,139);margin-top:0.3rem;">📊 ${result.rows.length} строк в таблице ниже</div>` : ''}`;
    appendMessage('assistant', answerHtml, followUpHtml);

    _history.push({ role: 'assistant', content: result.answer });
    renderResultTable(result);

    if (result.rows?.length) {
      $('aiReportsExportBtn')?.classList.remove('hidden');
    }

  } catch (err) {
    document.getElementById(loadingId)?.remove();
    const msg = err?.message || String(err);
    let friendly = 'Ошибка: ' + msg.slice(0, 200);
    if (msg.includes('504') || msg.includes('timeout')) friendly = '⏱ Превышено время ожидания. Попробуйте более простой запрос.';
    if (msg.includes('sign') || msg.includes('auth'))   friendly = '🔐 Требуется вход в miniapps.ai для использования ИИ.';
    if (msg.includes('credit') || msg.includes('balance')) friendly = '💳 Недостаточно кредитов.';
    appendMessage('assistant', `<span style="color:rgb(248,113,113)">${esc(friendly)}</span>`);
    showToast(friendly, 'error');
  } finally {
    if (input)   { input.disabled = false; input.focus(); }
    if (sendBtn) sendBtn.disabled = false;
  }
}

// ── Экспорт в Excel ───────────────────────────────────────────────
async function exportToExcel() {
  if (!_lastResult?.rows?.length) { showToast('Нет данных для экспорта', 'error'); return; }
  const btn = $('aiReportsExportBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳'; }
  try {
    const XLSX = await loadXLSX();
    const { rows, columns, title } = _lastResult;
    const cols = columns?.length ? columns : Object.keys(rows[0]).filter(k => !k.startsWith('_')).map(k => ({ key: k, label: k }));
    const header = cols.map(c => c.label);
    const data = [header, ...rows.map(r => cols.map(c => r[c.key] ?? ''))];
    const ws = XLSX.utils.aoa_to_sheet(data);
    ws['!cols'] = cols.map(() => ({ wch: 22 }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ИИ-отчёт');
    XLSX.writeFile(wb, `ai-report-${new Date().toISOString().slice(0,10)}.xlsx`);
    showToast('Excel сохранён', 'success');
  } catch (err) {
    showToast('Ошибка Excel: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Excel'; }
  }
}

// ── Приветственное сообщение ──────────────────────────────────────
function showWelcome() {
  const feed = $('aiReportsFeed');
  if (!feed) return;
  feed.innerHTML = '';
  appendMessage('assistant', `
    <div>👋 Привет! Я ИИ-ассистент системы оснащения.</div>
    <div style="margin-top:0.4rem;font-size:0.76rem;color:rgb(100,116,139);">Задайте вопрос о данных проекта, например:</div>
    <ul style="margin:0.4rem 0 0;padding-left:1.1rem;font-size:0.76rem;color:rgb(148,163,184);">
      <li>Куда поставлялись парты в августе?</li>
      <li>Какой процент освоения по программе №3?</li>
      <li>Какие товары не прошли приёмку?</li>
      <li>Сколько товаров не собрано в школе №123?</li>
    </ul>`
  );
}

// ── Очистить историю ──────────────────────────────────────────────
function clearChat() {
  _history.length = 0;
  _lastResult = null;
  showWelcome();
  const wrap = $('aiReportsTableWrap');
  if (wrap) wrap.innerHTML = '';
  $('aiReportsExportBtn')?.classList.add('hidden');
}

// ── Инициализация (один раз) ──────────────────────────────────────
function initOnce() {
  if (_initialized) return;
  _initialized = true;

  ensureStyles();

  const input    = $('aiReportsInput');
  const sendBtn  = $('aiReportsSendBtn');
  const clearBtn = $('aiReportsClearBtn');
  const exportBtn = $('aiReportsExportBtn');

  sendBtn?.addEventListener('click', () => submitQuestion(input?.value?.trim()));
  input?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submitQuestion(input.value.trim()); }
  });
  clearBtn?.addEventListener('click', clearChat);
  exportBtn?.addEventListener('click', exportToExcel);

  // Делегирование для кнопок follow-up
  $('aiReportsFeed')?.addEventListener('click', e => {
    const btn = e.target.closest('.ai-followup-btn');
    if (btn) submitQuestion(btn.dataset.q);
  });

  showWelcome();
}

// ── Публичное API ─────────────────────────────────────────────────
export function initAiReportsView() {
  ensureStyles();
  // Не инициализируем полностью до открытия — feed может быть скрыт
}

export function openAiReportsPanel() {
  const panel = $('reportsAiPanel');
  if (!panel) {
    console.error('[ai-reports] #reportsAiPanel not found in DOM');
    return;
  }

  // Показываем панель через inline style (надёжнее Tailwind-классов)
  panel.style.display = 'flex';
  panel.style.flexDirection = 'column';
  panel.style.flex = '1 1 0';
  panel.style.minHeight = '0';
  panel.style.overflow = 'hidden';

  // Инициализируем обработчики только сейчас — когда элементы видимы
  ensureStyles();
  initOnce();

  // Обновляем индикатор режима
  const modeEl = $('aiReportsModeIndicator');
  if (modeEl) {
    const host = window.location.hostname;
    const isPreview = host.includes('miniapps.ai') || host === 'localhost' || host === '127.0.0.1';
    modeEl.textContent = isPreview ? '🟣 miniapps.ai · DeepSeek V4 Flash' : '🟢 Сервер · DeepSeek V4 Flash';
    modeEl.style.display = 'inline';
  }

  // Фокус на поле ввода
  setTimeout(() => $('aiReportsInput')?.focus(), 100);
}

export function closeAiReportsPanel() {
  const panel = $('reportsAiPanel');
  if (!panel) return;
  panel.style.display = 'none';
}
