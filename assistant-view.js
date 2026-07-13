/**
 * ui/assistant-view.js
 * ИИ-помощник по работе с приложением.
 * Плавающая кнопка ❓ рядом с 🏠, открывает чат-панель.
 * Отвечает на вопросы о функциях, форматах, ограничениях, правах.
 * Режим: handler.php (сервер) → miniappsAI SDK (превью/fallback).
 * Логирование: каждый Q&A сохраняется в miniappsAI.storage → assistant_logs.
 */

import { state } from '../state.js';
import { getCurrentUser } from '../auth.js';

// ── Модель (DeepSeek V4 Flash Instant через miniappsAI SDK) ───────
const MINIAPPS_MODEL_ID = 'dc2db118-7888-466a-a8d1-bf9d96bab4b6';

// ── Логирование Q&A ───────────────────────────────────────────────
const LOG_KEY = 'assistant_logs';
const LOG_MAX = 500; // fallback: максимум записей в miniappsAI.storage

/** URL сервера для логов */
function getApiUrl() {
  try {
    // Ищем корень сайта: убираем всё после последнего /
    // Работает и для /index.html, и для / (Beget)
    const href = window.location.href.split('?')[0].split('#')[0];
    const parts = href.split('/');
    // Убираем последний сегмент если это файл (содержит точку) или пустой
    const last = parts[parts.length - 1];
    if (!last || last.includes('.')) parts.pop();
    return parts.join('/') + '/api/index.php';
  } catch { return '/api/index.php'; }
}

/** Сохранить запись Q&A — сначала на сервер, fallback → miniappsAI.storage */
async function logQA(question, answer, mode, durationMs) {
  const entry = {
    ts:   new Date().toISOString(),
    user: getCurrentUser() || 'admin',
    q:    question,
    a:    answer,
    mode,
    ms:   durationMs,
  };

  // Пробуем сервер (работает только не в preview-sandbox)
  if (!isInMiniappsPreview()) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(getApiUrl() + '?action=append_log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: ctrl.signal,
        body: JSON.stringify({ entry }),
      });
      clearTimeout(timer);
      if (resp.ok) {
        console.log('[assistant] logQA → server OK');
        return; // сохранено на сервере, выходим
      }
    } catch (e) {
      console.warn('[assistant] logQA server failed, fallback to storage:', e?.message);
    }
  }

  // Fallback: miniappsAI.storage (preview / сервер недоступен)
  try {
    const raw  = await window.miniappsAI?.storage?.getItem(LOG_KEY);
    const logs = raw ? JSON.parse(raw) : [];
    logs.push(entry);
    if (logs.length > LOG_MAX) logs.splice(0, logs.length - LOG_MAX);
    await window.miniappsAI?.storage?.setItem(LOG_KEY, JSON.stringify(logs));
  } catch (e) {
    console.warn('[assistant] logQA storage fallback failed:', e?.message);
  }
}

/** Загрузить все логи — с сервера или из miniappsAI.storage */
async function loadLogs() {
  if (!isInMiniappsPreview()) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(getApiUrl() + '?action=get_logs', { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok && Array.isArray(data.logs)) return data.logs;
      }
    } catch (e) {
      console.warn('[assistant] loadLogs server failed:', e?.message);
    }
  }
  // Fallback: miniappsAI.storage
  try {
    const raw = await window.miniappsAI?.storage?.getItem(LOG_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch { return []; }
}

/** Очистить все логи — на сервере и в miniappsAI.storage */
async function clearLogs() {
  if (!isInMiniappsPreview()) {
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 5000);
      await fetch(getApiUrl() + '?action=clear_logs', { method: 'POST', signal: ctrl.signal });
      clearTimeout(timer);
    } catch (e) {
      console.warn('[assistant] clearLogs server failed:', e?.message);
    }
  }
  try { await window.miniappsAI?.storage?.removeItem(LOG_KEY); } catch {}
}

/** Экспортировать логи как JSON-файл */
function exportLogsJson(logs) {
  _downloadBlob(
    JSON.stringify(logs, null, 2),
    'application/json',
    'assistant-logs-' + _today() + '.json'
  );
}

/** Скачать blob */
function _downloadBlob(content, mime, filename) {
  const blob = new Blob([typeof content === 'string' ? content : new Uint8Array(content)], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function _today() { return new Date().toISOString().slice(0, 10); }

/** Экспортировать логи как HTML-файл (читаемый отчёт) */
function exportLogsHtml(logs) {
  const rows = [...logs].reverse().map((l, i) => `
    <tr>
      <td>${i + 1}</td>
      <td style="white-space:nowrap">${fmtDate(l.ts)}</td>
      <td>${_esc(l.user || '')}</td>
      <td>${_esc(l.q || '')}</td>
      <td>${_esc(l.a || '')}</td>
      <td style="text-align:center">${l.mode || ''}</td>
      <td style="text-align:right">${l.ms ? (l.ms < 1000 ? l.ms + ' мс' : (l.ms/1000).toFixed(1) + ' с') : ''}</td>
    </tr>`).join('');
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="UTF-8">
<title>Журнал ИИ-помощника · ${_today()}</title>
<style>
  body{font-family:Arial,sans-serif;font-size:13px;margin:24px;color:#1e293b}
  h1{font-size:18px;margin-bottom:4px}
  p.meta{color:#64748b;font-size:12px;margin:0 0 16px}
  table{border-collapse:collapse;width:100%}
  th{background:#0e7490;color:#fff;padding:8px 10px;text-align:left;font-size:12px}
  td{padding:7px 10px;border-bottom:1px solid #e2e8f0;vertical-align:top;font-size:12px}
  tr:nth-child(even) td{background:#f8fafc}
  td:nth-child(3){color:#6366f1;font-size:11px}
  td:nth-child(4){font-weight:600;color:#0e7490;max-width:300px}
  td:nth-child(5){max-width:500px;white-space:pre-wrap;word-break:break-word}
</style></head><body>
<h1>📋 Журнал Q&amp;A · ИИ-помощник</h1>
<p class="meta">Всего записей: ${logs.length} · Экспорт: ${fmtDate(new Date().toISOString())}</p>
<table>
  <thead><tr><th>#</th><th>Дата</th><th>Пользователь</th><th>Вопрос</th><th>Ответ</th><th>Режим</th><th>Время</th></tr></thead>
  <tbody>${rows}</tbody>
</table></body></html>`;
  _downloadBlob(html, 'text/html;charset=utf-8', 'assistant-logs-' + _today() + '.html');
}

function _esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/** Экспортировать логи как Excel (.xlsx) через нативный XML */
function exportLogsExcel(logs) {
  const esc = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const cell = (v, t='String') => `<Cell><Data ss:Type="${t}">${esc(v)}</Data></Cell>`;
  const hdr = ['#','Дата','Пользователь','Вопрос','Ответ','Режим','Время (мс)'].map(h => `<Cell><Data ss:Type="String">${h}</Data></Cell>`).join('');
  const rowsXml = [...logs].reverse().map((l, i) => `<Row>
    ${cell(i+1,'Number')}
    ${cell(fmtDate(l.ts))}
    ${cell(l.user || '')}
    ${cell(l.q || '')}
    ${cell(l.a || '')}
    ${cell(l.mode || '')}
    ${cell(l.ms || 0,'Number')}
  </Row>`).join('');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<?mso-application progid="Excel.Sheet"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
  xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet">
  <Worksheet ss:Name="Журнал ИИ">
    <Table>
      <Row>${hdr}</Row>
      ${rowsXml}
    </Table>
  </Worksheet>
</Workbook>`;
  _downloadBlob(xml, 'application/vnd.ms-excel;charset=utf-8', 'assistant-logs-' + _today() + '.xls');
}

/** Экспортировать логи как RTF (открывается в Word) — unicode-escape для кириллицы */
function exportLogsWord(logs) {
  // RTF unicode-escape: каждый символ >127 → \uN? (N = UTF-16 codepoint, ? = fallback char)
  const rtfStr = s => String(s ?? '').split('').map(ch => {
    const code = ch.charCodeAt(0);
    if (code < 128) {
      if (ch === '\\') return '\\\\';
      if (ch === '{')  return '\\{';
      if (ch === '}')  return '\\}';
      if (ch === '\n') return '\\line ';
      return ch;
    }
    // Знаковое 16-битное число для RTF \uN
    const signed = code > 32767 ? code - 65536 : code;
    return '\\u' + signed + '?';
  }).join('');

  const bold   = (s) => `{\\b ${rtfStr(s)}}`;
  const italic = (s) => `{\\i ${rtfStr(s)}}`;
  const cyan   = (s) => `{\\b\\cf1 ${rtfStr(s)}}`;

  let body = '{\\rtf1\\ansi\\ansicpg1251\\uc1\\deff0\n';
  body += '{\\fonttbl{\\f0\\fswiss\\fcharset204 Arial;}}\n';
  body += '{\\colortbl;\\red14\\green116\\blue144;\\red30\\green41\\blue59;\\red99\\green102\\blue241;}\n';
  body += '\\f0\\fs22\n';
  body += cyan('Журнал Q&A · ИИ-помощник') + '\\par\n';
  body += italic(`Всего: ${logs.length} записей · ${fmtDate(new Date().toISOString())}`) + '\\par\\par\n';

  [...logs].reverse().forEach((l, i) => {
    const user = l.user || 'admin';
    const timeStr = l.ms ? (l.ms < 1000 ? l.ms + ' мс' : (l.ms/1000).toFixed(1) + ' с') : '';
    body += cyan(`${i+1}. ${fmtDate(l.ts)}`) + '\\par\n';
    body += bold('Пользователь: ') + `{\\cf3 ${rtfStr(user)}}` + '\\par\n';
    body += bold('Режим: ') + rtfStr(l.mode || 'sdk') + (timeStr ? '  ' + italic(`(${timeStr})`) : '') + '\\par\n';
    body += bold('Вопрос: ') + rtfStr(l.q || '') + '\\par\n';
    body += bold('Ответ: ') + rtfStr((l.a || '').slice(0, 3000)) + '\\par\n';
    body += '\\par\n';
  });
  body += '}';
  _downloadBlob(body, 'application/rtf', 'assistant-logs-' + _today() + '.rtf');
}

/** Форматировать ISO-дату для отображения */
function fmtDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('ru-RU') + ' ' + d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

/** Показать/создать модал с журналом Q&A */
async function showLogsModal() {
  const logsBtn = document.getElementById('assistantLogsBtn');
  if (logsBtn) { logsBtn.textContent = '⏳'; logsBtn.disabled = true; }
  const logs = await loadLogs();
  if (logsBtn) { logsBtn.textContent = '📋'; logsBtn.disabled = false; }

  // Удаляем старый модал если есть
  document.getElementById('astLogsModal')?.remove();

  const modal = document.createElement('div');
  modal.id = 'astLogsModal';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Журнал Q&A ИИ-помощника');
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9000',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(0,0,0,0.7)', 'backdrop-filter:blur(6px)',
    'padding:1rem',
  ].join(';');

  const totalCount = logs.length;
  const avgMs = totalCount
    ? Math.round(logs.reduce((s, l) => s + (l.ms || 0), 0) / totalCount)
    : 0;

  // Топ-вопросы (простая частота по первым 60 символам)
  const qFreq = {};
  logs.forEach(l => {
    const key = (l.q || '').slice(0, 60).trim();
    if (key) qFreq[key] = (qFreq[key] || 0) + 1;
  });
  const topQ = Object.entries(qFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  const logsHtml = logs.length === 0
    ? '<p style="color:rgb(100,116,139);font-size:0.8rem;text-align:center;padding:2rem 0;">Журнал пуст — задайте первый вопрос</p>'
    : [...logs].reverse().map((l, _i) => `
        <div style="border:1px solid rgba(255,255,255,0.07);border-radius:0.75rem;padding:0.75rem 0.9rem;background:rgba(255,255,255,0.03);margin-bottom:0.5rem;">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:0.5rem;margin-bottom:0.4rem;flex-wrap:wrap;">
            <span style="font-size:0.65rem;color:rgb(100,116,139);">${fmtDate(l.ts)}</span>
            <div style="display:flex;gap:0.4rem;">
              <span style="font-size:0.62rem;padding:0.1rem 0.4rem;border-radius:0.3rem;background:rgba(99,102,241,0.15);color:rgb(165,180,252);">👤 ${_escHtml(l.user || 'admin')}</span>
              <span style="font-size:0.62rem;padding:0.1rem 0.4rem;border-radius:0.3rem;background:rgba(6,182,212,0.12);color:rgb(34,211,238);">${l.mode || 'sdk'}</span>
              ${l.ms ? `<span style="font-size:0.62rem;padding:0.1rem 0.4rem;border-radius:0.3rem;background:rgba(255,255,255,0.06);color:rgb(148,163,184);">${l.ms < 1000 ? l.ms + 'мс' : (l.ms/1000).toFixed(1) + 'с'}</span>` : ''}
            </div>
          </div>
          <div style="font-size:0.78rem;color:rgb(34,211,238);margin-bottom:0.35rem;line-height:1.4;">
            <span style="opacity:0.6;margin-right:0.3rem;">❓</span>${_escHtml(l.q || '')}
          </div>
          <div style="font-size:0.75rem;color:rgb(203,213,225);line-height:1.45;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow-y:auto;">
            <span style="opacity:0.6;margin-right:0.3rem;">🤖</span>${_escHtml((l.a || '').slice(0, 600))}${(l.a || '').length > 600 ? '…' : ''}
          </div>
        </div>`).join('');

  const topQHtml = topQ.length === 0 ? '' : `
    <div style="margin-bottom:1rem;padding:0.75rem;background:rgba(6,182,212,0.06);border:1px solid rgba(6,182,212,0.15);border-radius:0.75rem;">
      <p style="font-size:0.7rem;font-weight:700;color:rgb(34,211,238);margin:0 0 0.5rem;text-transform:uppercase;letter-spacing:0.05em;">🔥 Популярные вопросы (FAQ-кандидаты)</p>
      ${topQ.map(([q, cnt]) => `
        <div style="display:flex;align-items:baseline;gap:0.5rem;margin-bottom:0.3rem;">
          <span style="font-size:0.68rem;background:rgba(6,182,212,0.2);color:rgb(34,211,238);border-radius:0.3rem;padding:0.1rem 0.4rem;min-width:1.8rem;text-align:center;flex-shrink:0;">${cnt}×</span>
          <span style="font-size:0.75rem;color:#e2e8f0;">${_escHtml(q)}${q.length >= 60 ? '…' : ''}</span>
        </div>`).join('')}
    </div>`;

  modal.innerHTML = `
    <div style="width:min(680px,100%);max-height:90vh;display:flex;flex-direction:column;background:rgba(2,8,30,0.98);border:1px solid rgba(6,182,212,0.25);border-radius:1.25rem;box-shadow:0 24px 80px rgba(0,0,0,0.7);overflow:hidden;">
      <!-- Шапка -->
      <div style="display:flex;align-items:center;justify-content:space-between;padding:0.85rem 1.1rem;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;background:rgba(6,182,212,0.05);">
        <div style="display:flex;align-items:center;gap:0.6rem;">
          <span style="font-size:1.1rem;">📋</span>
          <div>
            <p style="font-size:0.85rem;font-weight:700;color:#fff;margin:0;">Журнал Q&amp;A · ИИ-помощник</p>
            <p style="font-size:0.65rem;color:rgb(100,116,139);margin:0;">${totalCount} записей${avgMs ? ' · ср. ответ ' + (avgMs < 1000 ? avgMs + 'мс' : (avgMs/1000).toFixed(1) + 'с') : ''} · <span style="color:${isInMiniappsPreview() ? 'rgb(234,179,8)' : 'rgb(34,197,94)'};">${isInMiniappsPreview() ? '☁ storage' : '🖥 сервер'}</span></p>
          </div>
        </div>
        <div style="display:flex;gap:0.4rem;align-items:center;">
          <button id="astLogsExportHtmlBtn" type="button"
            style="background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.3);border-radius:0.5rem;padding:0.3rem 0.6rem;color:rgb(34,211,238);font-size:0.72rem;cursor:pointer;"
            aria-label="Скачать HTML">🌐 HTML</button>
          <button id="astLogsExportXlsBtn" type="button"
            style="background:rgba(34,197,94,0.12);border:1px solid rgba(34,197,94,0.3);border-radius:0.5rem;padding:0.3rem 0.6rem;color:rgb(134,239,172);font-size:0.72rem;cursor:pointer;"
            aria-label="Скачать Excel">📊 Excel</button>
          <button id="astLogsExportWordBtn" type="button"
            style="background:rgba(99,102,241,0.12);border:1px solid rgba(99,102,241,0.3);border-radius:0.5rem;padding:0.3rem 0.6rem;color:rgb(165,180,252);font-size:0.72rem;cursor:pointer;"
            aria-label="Скачать Word">📄 Word</button>
          <button id="astLogsClearBtn" type="button"
            style="background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:0.5rem;padding:0.3rem 0.7rem;color:rgb(252,165,165);font-size:0.72rem;cursor:pointer;"
            aria-label="Очистить журнал">🗑 Очистить</button>
          <button id="astLogsCloseBtn" type="button"
            style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;padding:0.3rem 0.6rem;color:rgb(148,163,184);font-size:0.85rem;cursor:pointer;line-height:1;"
            aria-label="Закрыть журнал">✕</button>
        </div>
      </div>
      <!-- Тело -->
      <div style="flex:1 1 0;min-height:0;overflow-y:auto;padding:1rem 1.1rem;">
        ${topQHtml}
        <p style="font-size:0.68rem;text-transform:uppercase;letter-spacing:0.05em;color:rgb(100,116,139);margin:0 0 0.6rem;font-weight:600;">История (последние первыми)</p>
        ${logsHtml}
      </div>
    </div>`;

  document.body.appendChild(modal);

  // Закрытие
  const closeModal = () => modal.remove();
  modal.querySelector('#astLogsCloseBtn').addEventListener('click', closeModal);
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', function onEsc(e) {
    if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onEsc); }
  });

  // Экспорт
  modal.querySelector('#astLogsExportHtmlBtn').addEventListener('click', () => exportLogsHtml(logs));
  modal.querySelector('#astLogsExportXlsBtn').addEventListener('click', () => exportLogsExcel(logs));
  modal.querySelector('#astLogsExportWordBtn').addEventListener('click', () => exportLogsWord(logs));

  // Очистить
  modal.querySelector('#astLogsClearBtn').addEventListener('click', async () => {
    if (!confirm('Очистить весь журнал Q&A? Это действие необратимо.')) return;
    await clearLogs();
    closeModal();
  });
}

function _escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Прокси-URL (тот же что в doc-checker) ────────────────────────
function getProxyUrl() {
  const base = window.location.href.split('/').slice(0, -1).join('/');
  return base + '/doc-checker/api/handler.php';
}

/**
 * Режим работы:
 * - miniapps.ai / localhost → SDK
 * - любой другой хост (сервер) → handler.php напрямую, без проверки
 */
function isInMiniappsPreview() {
  try {
    const host = window.location.hostname;
    return host.includes('miniapps.ai') || host === 'localhost' || host === '127.0.0.1';
  } catch { return false; }
}

// Нет checkServer() — на сервере всегда используем handler.php без предварительного ping
let _serverAvailable = null;

async function checkServer() {
  if (_serverAvailable !== null) return _serverAvailable;
  if (isInMiniappsPreview()) { _serverAvailable = false; return false; }
  _serverAvailable = true;
  return true;
}

let _lastCallMode = 'sdk';

async function callViaProxy(messages) {
  _lastCallMode = 'proxy';
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(getProxyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctrl.signal,
      body: JSON.stringify({ action: 'chat', messages, maxTokens: 3000 }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch { throw new Error('Сервер вернул не JSON: ' + text.slice(0, 200)); }
    if (data.error) throw new Error(data.error);
    return data.text
      || data.result?.alternatives?.[0]?.message?.text
      || data.content?.[0]?.text
      || data.choices?.[0]?.message?.content
      || '';
  } finally { clearTimeout(timer); }
}

async function callViaMiniapps(messages) {
  _lastCallMode = 'sdk';
  if (!window.miniappsAI?.callModel) throw new Error('miniappsAI недоступен');
  const result = await window.miniappsAI.callModel({
    modelId: MINIAPPS_MODEL_ID,
    messages,
    timeoutMs: 60000,
  });
  return window.miniappsAI.extractText(result);
}

async function callAI(messages) {
  if (isInMiniappsPreview()) return callViaMiniapps(messages);
  const serverOk = await checkServer();
  if (serverOk) {
    try { return await callViaProxy(messages); } catch (e) {
      console.warn('[assistant] proxy failed, fallback:', e.message);
    }
  }
  return callViaMiniapps(messages);
}

// ── Живая сводка состояния проекта ───────────────────────────────
function buildProjectSummary() {
  const s = state;
  const totalNeed = (s.recipients || []).reduce((sum, r) => {
    return sum + Object.values(r.needs || {}).reduce((s2, n) => s2 + (n.qty || 0), 0);
  }, 0);
  const totalContracted = (s.contracts || []).reduce((sum, c) =>
    sum + (c.items || []).reduce((s2, i) => s2 + (i.qty || 0), 0), 0);
  const totalDelivered = (s.warehouseEntries || []).reduce((sum, e) => sum + (e.received || 0), 0);
  const totalShipped = (s.shipments || []).reduce((sum, sh) =>
    sum + (sh.rows || []).reduce((s2, r) =>
      s2 + (r.recipients || []).reduce((s3, rc) => s3 + (rc.qty || 0), 0), 0), 0);
  const totalAssembled = (s.assemblyActs || []).reduce((sum, a) =>
    sum + (a.items || []).reduce((s2, i) => s2 + (i.assembled || 0), 0), 0);

  return {
    products: s.products?.length || 0,
    categories: s.categories?.length || 0,
    productGroups: [...new Set((s.products || []).map(p => p.productGroup).filter(Boolean))].length,
    recipients: s.recipients?.length || 0,
    contracts: s.contracts?.length || 0,
    orders: s.orders?.length || 0,
    sentOrders: (s.orders || []).filter(o => o.sent).length,
    suppliers: s.suppliers?.length || 0,
    programs: s.programs?.length || 0,
    warehouseEntries: s.warehouseEntries?.length || 0,
    shipments: s.shipments?.length || 0,
    assemblyActs: s.assemblyActs?.length || 0,
    acts: s.acts?.length || 0,
    warehouses: s.warehouses?.length || 0,
    totalNeed,
    totalContracted,
    totalDelivered,
    totalShipped,
    totalAssembled,
  };
}

// ── Системный промпт ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — встроенный ИИ-помощник системы «Оснащение образовательных организаций».
Отвечай на русском языке. Будь конкретным, кратким и дружелюбным.
Используй маркированные списки и короткие абзацы. Не повторяй вопрос.

ОПИСАНИЕ СИСТЕМЫ:
Веб-приложение для управления оснащением школ и других образовательных организаций.
Данные хранятся в браузере (localStorage) и синхронизируются с сервером каждые 15 секунд.
Авторизация: логин admin / пароль admin.

МОДУЛИ СИСТЕМЫ:

1. КАТАЛОГ (📋)
   - Список товаров с полями: наименование, код, категория, товарная группа, цвет, характеристики, требуется ли сборка
   - Добавление: кнопка «Добавить» → форма
   - Импорт из Excel: столбцы «№», «Наименование», «Категория», «Цвет», «Характеристики»
   - Импорт характеристик: из Excel/Word/PDF через ИИ (miniappsAI SDK)
   - Категории и товарные группы управляются отдельно
   - Фильтры: поиск по названию, фильтр по категории

2. ПОЛУЧАТЕЛИ (👥)
   - Карточка: наименование, адрес, целевая программа, статус готовности
   - Потребность: таблица товаров с полями «Нужно», «Доставлено», «Собрано»
   - Импорт потребностей из Excel: Формат А (матрица: строка 1 — получатели, строки — товары) или Формат Б (столбцы: Получатель, № товара, Наименование, Количество)
   - История поставок: фильтры по поставщику, заявке, дате, статусу
   - Ограничение: получатель должен иметь программу для участия в отгрузке

3. ПОТРЕБНОСТЬ (📊) — матрица потребностей
   - Строки — товары, столбцы — получатели
   - Режимы: «Все получатели» или «По программам»
   - Фильтры: поиск, категория, группа, фильтр по получателям
   - Экспорт в Excel
   - Импорт потребностей прямо из матрицы

4. КОНТРАКТЫ (📝)
   - Поля карточки: номер, дата, поставщик, целевые программы, товары (с ценой, НМЦД, количеством), сумма
   - Ограничение: сумма по товару не может превышать суммарную потребность
   - Согласование СО: если предусмотрено — требует акт проверки перед отгрузкой
   - Поиск: по номеру, названию, поставщику (с автодополнением)
   - Заявки и проверки доступны из карточки контракта

5. ЗАЯВКИ (📋)
   - Заявка привязывается к контракту и поставщику
   - Адреса доставки: несколько получателей, для каждого — количество по товарам
   - Статус «Отправлена»: только отправленные заявки учитываются в отчёте
   - Ограничение: получатель и заявка должны иметь одинаковую программу

6. ПОСТАВЩИКИ (🏢)
   - Карточка: наименование, ИНН, адрес, email, телефоны, контактные лица
   - ИНН: 10 или 12 цифр
   - Связанные контракты отображаются в карточке

7. ФИНАНСЫ (💰)
   - Целевые программы: название, код, КБК, лимит финансирования
   - Программы используются в контрактах, заявках, получателях
   - Без программы — отгрузка невозможна

8. ПРИЁМКА (✅)
   - Список контрактов для приёмки товаров
   - Акт проверки: дата, состав комиссии, представители поставщика, результат по каждому товару
   - Реестр актов: все сохранённые акты с фильтрацией

9. СКЛАД (🏭)
   - Подразделы: Наличие, Новая отгрузка, Реестр отгрузок, Реестр поступлений
   - Поступления: код товара, наименование, поставщик, контракт, заявка, дата, кол-во поступило/отгружено, приёмка
   - Импорт поступлений из Excel: столбцы — Код товара, Наименование, Поставщик, Контракт, Заявка, Дата, Кол-во поступило, Кол-во отгружено, Приёмка
   - Отгрузка: таблица остатков × получатели, ввод количества, авто-распределение FIFO по поставщикам
   - Наличие: сгруппировано по коду товара, итоговые строки, детализация по заявкам
   - Несколько складов (виртуальных) можно создать в разделе «Склад → Добавить склад»

10. СБОРКА И МОНТАЖ (🔧)
    - Акт сборки: дата, получатель, поставщик, товары (доставлено, ранее собрано, доступно, кол-во)
    - Учёт сборки ведётся по поставщику
    - Реестр актов сборки
    - Товары с флагом «Требуется сборка» попадают в этот модуль

11. ОТЧЁТЫ (📈)
    - Отчёт ДОНМ: движение товара по товарным группам (потребность, законтрактовано, заказано, доставлено на склад, доставлено в ОО, требует сборки, собрано)
    - ИИ-ассистент отчётов: задайте вопрос — ИИ построит таблицу по данным проекта

12. ПРОВЕРКА ДОКУМЕНТОВ (🔎)
    - Яндекс Облако: загрузка пакета документов на оплату (4 зоны), анализ через DeepSeek/Alice AI
    - Иностранные ИИ: экспертная проверка через Claude/GPT/Gemini/Grok/DeepSeek (требует miniappsAI)
    - Зона 1: документ на оплату (УПД, накладная), Зона 2: договор+ТЗ, Зона 3: первичные документы, Зона 4: сертификаты, претензии

ФОРМАТЫ ИМПОРТА:
- Каталог: .xlsx, столбцы: №, Наименование, Категория, Цвет, Характеристики
- Потребности (матрица): .xlsx, строка 1 — названия получателей, столбец 1 — коды/названия товаров
- Потребности (список): .xlsx, столбцы: Получатель, № товара, Наименование, Количество
- Склад (поступления): .xlsx, столбцы: Код товара, Наименование, Поставщик, Контракт, Заявка, Дата, Кол-во поступило, Кол-во отгружено, Приёмка

ОГРАНИЧЕНИЯ:
- Права: один пользователь (admin), все данные доступны без разграничения
- Размер хранилища: до 100 ключей, до 1MB на ключ
- Файлы для ИИ-анализа: до 50MB, форматы PDF/DOCX/XLSX/TXT
- Получатель без программы не может получить отгрузку
- Заявка без программы не может быть привязана к отгрузке
- Количество по товару в контракте не может превышать суммарную потребность

ЭКСПОРТ И СКАЧИВАНИЕ:
- Экспорт данных: кнопка «Экспорт данных» в тулбаре → JSON
- Импорт данных: кнопка «Импорт данных» → загрузить ранее сохранённый JSON (ЗАМЕНЯЕТ все данные)
- Скачать код: ZIP-архив с исходным кодом приложения
- Скачать doc-checker: ZIP-архив модуля проверки документов
- ⬇ index + main: быстрое скачивание index.html и main.js (для обновления сервера)

СИНХРОНИЗАЦИЯ:
- Данные автоматически синхронизируются с сервером каждые 15 секунд
- Индикатор в левом нижнем углу: зелёный = сервер подключён, красный = офлайн (localStorage)
- При офлайн-режиме данные сохраняются локально и синхронизируются при восстановлении соединения`;

// ── Состояние чата ────────────────────────────────────────────────
let _history  = []; // { role: 'user'|'assistant', content: string }[]
let _isOpen   = false;
let _isLoading = false;
let _panelEl  = null;
let _feedEl   = null;
let _inputEl  = null;
let _sendBtn  = null;

// ── Инициализация ─────────────────────────────────────────────────
export function initAssistantView() {
  _createButton();
  _createPanel();
}

function _createButton() {
  const existing = document.getElementById('assistantBtn');
  if (existing) {
    existing.onclick = null;
    existing.addEventListener('click', togglePanel);
    return;
  }
  const btn = document.createElement('button');
  btn.id = 'assistantBtn';
  btn.type = 'button';
  btn.setAttribute('aria-label', 'ИИ-помощник');
  btn.title = 'ИИ-помощник по работе с приложением';
  btn.innerHTML = `<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="10"/><path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`;

  btn.style.cssText = [
    'position:fixed', 'bottom:1.25rem', 'right:4.5rem', 'z-index:300',
    'width:2.75rem', 'height:2.75rem',
    'display:flex', 'align-items:center', 'justify-content:center',
    'background:rgba(6,182,212,0.15)', 'border:1px solid rgba(6,182,212,0.35)',
    'border-radius:50%', 'color:rgb(34,211,238)', 'cursor:pointer',
    'backdrop-filter:blur(10px)', 'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'transition:background 0.15s,color 0.15s,border-color 0.15s,transform 0.15s,box-shadow 0.15s',
  ].join(';');

  btn.addEventListener('mouseenter', () => {
    btn.style.background = 'rgba(6,182,212,0.28)';
    btn.style.transform = 'scale(1.08)';
    btn.style.boxShadow = '0 0 20px rgba(34,211,238,0.25),0 4px 16px rgba(0,0,0,0.4)';
  });
  btn.addEventListener('mouseleave', () => {
    if (!_isOpen) btn.style.background = 'rgba(6,182,212,0.15)';
    btn.style.transform = 'scale(1)';
    btn.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
  });
  btn.addEventListener('click', togglePanel);
  document.body.appendChild(btn);
}

function _createPanel() {
  const existingPanel = document.getElementById('assistantPanel');
  if (existingPanel) {
    _panelEl = existingPanel;
    _feedEl  = document.getElementById('assistantFeed');
    _inputEl = document.getElementById('assistantInput');
    _sendBtn = document.getElementById('assistantSendBtn');
    _updateModeLabel();
    _wireHandlers();
    return;
  }

  const panel = document.createElement('div');
  panel.id = 'assistantPanel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'true');
  panel.setAttribute('aria-label', 'ИИ-помощник');
  panel.style.cssText = [
    'position:fixed', 'bottom:5rem', 'right:1.25rem', 'z-index:400',
    'width:min(420px,calc(100vw - 2.5rem))',
    'height:min(560px,calc(100vh - 7rem))',
    'display:none', 'flex-direction:column',
    'background:rgba(2,8,30,0.97)',
    'border:1px solid rgba(6,182,212,0.3)',
    'border-radius:1.25rem',
    'box-shadow:0 20px 60px rgba(0,0,0,0.6),0 0 0 1px rgba(6,182,212,0.1)',
    'backdrop-filter:blur(20px)', 'overflow:hidden',
    'transition:opacity 0.2s,transform 0.2s',
    'transform:translateY(8px)', 'opacity:0',
  ].join(';');

  panel.innerHTML = `
    <!-- Header -->
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0.75rem 1rem;border-bottom:1px solid rgba(255,255,255,0.08);flex-shrink:0;background:rgba(6,182,212,0.06);">
      <div style="display:flex;align-items:center;gap:0.6rem;">
        <span style="font-size:1.1rem;" aria-hidden="true">🤖</span>
        <div>
          <p style="font-size:0.82rem;font-weight:700;color:#fff;margin:0;line-height:1.2;">ИИ-помощник</p>
          <p id="assistantModeLabel" style="font-size:0.65rem;color:rgb(100,116,139);margin:0;">Загрузка...</p>
        </div>
      </div>
      <div style="display:flex;align-items:center;gap:0.4rem;">
        <button id="assistantLogsBtn" type="button" title="Журнал Q&A"
          style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:0.5rem;padding:0.25rem 0.5rem;color:rgb(100,116,139);font-size:0.72rem;cursor:pointer;transition:background 0.15s;"
          aria-label="Открыть журнал вопросов и ответов">📋</button>
        <button id="assistantClearBtn" type="button" title="Очистить историю"
          style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:0.5rem;padding:0.25rem 0.5rem;color:rgb(100,116,139);font-size:0.72rem;cursor:pointer;transition:background 0.15s;"
          aria-label="Очистить историю чата">🗑</button>
        <button id="assistantCloseBtn" type="button" title="Закрыть"
          style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.08);border-radius:0.5rem;padding:0.25rem 0.5rem;color:rgb(148,163,184);font-size:0.85rem;cursor:pointer;transition:background 0.15s;line-height:1;"
          aria-label="Закрыть помощника">✕</button>
      </div>
    </div>

    <!-- Feed -->
    <div id="assistantFeed" style="flex:1 1 0;min-height:0;overflow-y:auto;padding:0.75rem 1rem;display:flex;flex-direction:column;gap:0.6rem;scroll-behavior:smooth;">
      <!-- Welcome message -->
      <div class="ast-msg ast-msg-bot" style="display:flex;gap:0.5rem;align-items:flex-start;">
        <span style="font-size:1rem;flex-shrink:0;margin-top:0.1rem;" aria-hidden="true">🤖</span>
        <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem 0.75rem 0.75rem 0.2rem;padding:0.6rem 0.8rem;font-size:0.8rem;color:#e2e8f0;line-height:1.55;max-width:90%;">
          Привет! Я помогу разобраться с работой приложения.<br><br>
          Спрашивайте о любом разделе: как добавить данные, какой формат файла, где найти нужную функцию, какие ограничения.
          <div style="margin-top:0.6rem;display:flex;flex-wrap:wrap;gap:0.35rem;">
            <button class="ast-quick" data-q="Как импортировать товары из Excel?" style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:0.5rem;padding:0.25rem 0.5rem;font-size:0.7rem;color:rgb(34,211,238);cursor:pointer;transition:background 0.15s;">Импорт товаров</button>
            <button class="ast-quick" data-q="Как внести потребности организаций?" style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:0.5rem;padding:0.25rem 0.5rem;font-size:0.7rem;color:rgb(34,211,238);cursor:pointer;transition:background 0.15s;">Потребности</button>
            <button class="ast-quick" data-q="Как оформить отгрузку товаров?" style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:0.5rem;padding:0.25rem 0.5rem;font-size:0.7rem;color:rgb(34,211,238);cursor:pointer;transition:background 0.15s;">Отгрузка</button>
            <button class="ast-quick" data-q="Как скачать данные и резервную копию?" style="background:rgba(6,182,212,0.1);border:1px solid rgba(6,182,212,0.25);border-radius:0.5rem;padding:0.25rem 0.5rem;font-size:0.7rem;color:rgb(34,211,238);cursor:pointer;transition:background 0.15s;">Резервная копия</button>
          </div>
        </div>
      </div>
    </div>

    <!-- Input -->
    <div style="padding:0.6rem 0.75rem;border-top:1px solid rgba(255,255,255,0.08);flex-shrink:0;display:flex;gap:0.5rem;align-items:flex-end;background:rgba(2,6,23,0.6);">
      <textarea id="assistantInput" rows="2"
        style="flex:1;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.55rem 0.8rem;color:#e2e8f0;font-size:0.8rem;resize:none;outline:none;font-family:inherit;line-height:1.45;transition:border-color 0.15s;"
        placeholder="Задайте вопрос о работе с приложением…"
        aria-label="Вопрос к ИИ-помощнику"></textarea>
      <button id="assistantSendBtn" type="button"
        style="flex-shrink:0;background:linear-gradient(135deg,rgb(6,182,212),rgb(34,211,238));border:none;border-radius:0.65rem;padding:0.55rem 0.85rem;color:#000;font-size:0.8rem;font-weight:700;cursor:pointer;min-width:64px;transition:opacity 0.15s;"
        aria-label="Отправить вопрос">
        ➤
      </button>
    </div>`;

  document.body.appendChild(panel);
  _panelEl = panel;
  _feedEl  = document.getElementById('assistantFeed');
  _inputEl = document.getElementById('assistantInput');
  _sendBtn = document.getElementById('assistantSendBtn');

  _updateModeLabel();
  _wireHandlers();
}

// ── Привязка обработчиков ─────────────────────────────────────────
function _wireHandlers() {
  document.getElementById('assistantCloseBtn')?.addEventListener('click', closePanel);
  document.getElementById('assistantClearBtn')?.addEventListener('click', clearHistory);
  document.getElementById('assistantLogsBtn')?.addEventListener('click', showLogsModal);
  _sendBtn?.addEventListener('click', sendMessage);
  _inputEl?.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });
  _panelEl?.addEventListener('click', e => {
    const btn = e.target.closest('.ast-quick');
    if (btn) { _inputEl.value = btn.dataset.q; sendMessage(); }
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && _isOpen) closePanel();
  });
}

function _updateModeLabel() {
  const label = document.getElementById('assistantModeLabel');
  if (!label) return;
  label.textContent = isInMiniappsPreview() ? 'DeepSeek · miniappsAI' : 'DeepSeek · сервер';
}

// ── Открыть / закрыть ─────────────────────────────────────────────
export function openAssistantPanel() {
  if (!_panelEl) return;
  _isOpen = true;
  _panelEl.style.display = 'flex';
  requestAnimationFrame(() => {
    _panelEl.style.opacity = '1';
    _panelEl.style.transform = 'translateY(0)';
  });
  const btn = document.getElementById('assistantBtn');
  if (btn) btn.style.background = 'rgba(6,182,212,0.28)';
  setTimeout(() => _inputEl?.focus(), 200);
}

export function closePanel() {
  if (!_panelEl) return;
  _isOpen = false;
  _panelEl.style.opacity = '0';
  _panelEl.style.transform = 'translateY(8px)';
  setTimeout(() => { if (_panelEl) _panelEl.style.display = 'none'; }, 200);
  const btn = document.getElementById('assistantBtn');
  if (btn) btn.style.background = 'rgba(6,182,212,0.15)';
}

function togglePanel() {
  if (_isOpen) closePanel(); else openAssistantPanel();
}

function clearHistory() {
  _history = [];
  if (!_feedEl) return;
  const msgs = _feedEl.querySelectorAll('.ast-msg');
  msgs.forEach((m, i) => { if (i > 0) m.remove(); });
}

// ── Отправить сообщение ───────────────────────────────────────────
async function sendMessage() {
  if (_isLoading || !_inputEl) return;
  const text = _inputEl.value.trim();
  if (!text) return;

  _inputEl.value = '';
  _appendMessage('user', text);
  _history.push({ role: 'user', content: text });

  _setLoading(true);
  const typingEl = _appendTyping();
  const t0 = Date.now();

  try {
    const summary = buildProjectSummary();
    const contextNote = '\n\nТЕКУЩЕЕ СОСТОЯНИЕ ПРОЕКТА:\n' + JSON.stringify(summary, null, 2);

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT + contextNote },
      ..._history.slice(-8),
    ];

    const reply = await callAI(messages);
    const durationMs = Date.now() - t0;

    typingEl.remove();
    _appendMessage('bot', reply);
    _history.push({ role: 'assistant', content: reply });

    // ── Логирование Q&A ──────────────────────────────────────────
    // fire-and-forget, не блокируем UI
    logQA(text, reply, _lastCallMode, durationMs).catch(() => {});

    // Обновляем счётчик в кнопке журнала
    _updateLogsBadge();

  } catch (err) {
    typingEl.remove();
    _appendMessage('bot', '⚠ Не удалось получить ответ: ' + err.message, true);
  } finally {
    _setLoading(false);
  }
}

/** Показать количество записей на кнопке 📋 */
async function _updateLogsBadge() {
  const btn = document.getElementById('assistantLogsBtn');
  if (!btn) return;
  try {
    if (!isInMiniappsPreview()) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 4000);
      const resp = await fetch(getApiUrl() + '?action=get_logs', { signal: ctrl.signal });
      clearTimeout(timer);
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok) { btn.title = 'Журнал Q&A · ' + data.count + ' записей'; return; }
      }
    }
    // fallback: miniappsAI.storage
    const raw = await window.miniappsAI?.storage?.getItem(LOG_KEY);
    const count = raw ? JSON.parse(raw).length : 0;
    btn.title = 'Журнал Q&A · ' + count + ' записей';
  } catch {}
}

// ── Рендер сообщений ──────────────────────────────────────────────
function _appendMessage(role, text, isError = false) {
  if (!_feedEl) return;
  const isBot = role === 'bot';

  const wrap = document.createElement('div');
  wrap.className = 'ast-msg ast-msg-' + role;
  wrap.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;' + (isBot ? '' : 'flex-direction:row-reverse;');

  const avatar = document.createElement('span');
  avatar.style.cssText = 'font-size:1rem;flex-shrink:0;margin-top:0.1rem;';
  avatar.setAttribute('aria-hidden', 'true');
  avatar.textContent = isBot ? '🤖' : '👤';

  const bubble = document.createElement('div');
  const bubbleStyle = isBot
    ? 'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem 0.75rem 0.75rem 0.2rem;'
    : 'background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.2);border-radius:0.75rem 0.75rem 0.2rem 0.75rem;';
  bubble.style.cssText = bubbleStyle + 'padding:0.6rem 0.8rem;font-size:0.8rem;line-height:1.55;max-width:88%;' + (isError ? 'color:rgb(252,165,165);' : 'color:#e2e8f0;');
  bubble.innerHTML = _renderMarkdown(text);

  wrap.appendChild(avatar);
  wrap.appendChild(bubble);
  _feedEl.appendChild(wrap);
  _scrollToBottom();
  return wrap;
}

function _appendTyping() {
  if (!_feedEl) return document.createElement('div');
  const wrap = document.createElement('div');
  wrap.className = 'ast-msg ast-msg-bot';
  wrap.style.cssText = 'display:flex;gap:0.5rem;align-items:flex-start;';
  wrap.innerHTML = `
    <span style="font-size:1rem;flex-shrink:0;margin-top:0.1rem;" aria-hidden="true">🤖</span>
    <div style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem 0.75rem 0.75rem 0.2rem;padding:0.6rem 0.9rem;">
      <span style="display:inline-flex;gap:0.3rem;align-items:center;">
        <span style="width:6px;height:6px;border-radius:50%;background:rgb(100,116,139);animation:ast-dot 1.2s ease-in-out 0s infinite;display:inline-block;"></span>
        <span style="width:6px;height:6px;border-radius:50%;background:rgb(100,116,139);animation:ast-dot 1.2s ease-in-out 0.2s infinite;display:inline-block;"></span>
        <span style="width:6px;height:6px;border-radius:50%;background:rgb(100,116,139);animation:ast-dot 1.2s ease-in-out 0.4s infinite;display:inline-block;"></span>
      </span>
    </div>`;
  _feedEl.appendChild(wrap);
  _scrollToBottom();
  return wrap;
}

function _scrollToBottom() {
  if (_feedEl) requestAnimationFrame(() => { _feedEl.scrollTop = _feedEl.scrollHeight; });
}

function _setLoading(v) {
  _isLoading = v;
  if (_sendBtn) { _sendBtn.style.opacity = v ? '0.5' : '1'; _sendBtn.disabled = v; }
  if (_inputEl) _inputEl.disabled = v;
}

function _renderMarkdown(text) {
  let s = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  s = s.replace(/```[\s\S]*?```/g, m => `<pre style="background:rgba(255,255,255,0.05);border-radius:0.4rem;padding:0.4rem 0.6rem;font-size:0.75rem;overflow-x:auto;margin:0.3rem 0;white-space:pre-wrap;">${m.replace(/```\w*\n?/g, '').replace(/```/g, '')}</pre>`);
  s = s.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);border-radius:0.25rem;padding:0.1rem 0.3rem;font-size:0.78rem;">$1</code>');
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong style="color:#fff;font-weight:600;">$1</strong>');
  s = s.replace(/^### (.+)$/gm, '<p style="font-weight:700;color:#fff;margin:0.6rem 0 0.2rem;font-size:0.82rem;">$1</p>');
  s = s.replace(/^## (.+)$/gm,  '<p style="font-weight:700;color:#fff;margin:0.7rem 0 0.25rem;font-size:0.85rem;">$1</p>');
  s = s.replace(/^# (.+)$/gm,   '<p style="font-weight:700;color:#fff;margin:0.8rem 0 0.3rem;font-size:0.88rem;">$1</p>');
  s = s.replace(/^[-•*] (.+)$/gm, '<li style="margin:0.15rem 0;padding-left:0.25rem;">$1</li>');
  s = s.replace(/(<li[^>]*>.*<\/li>\n?)+/g, m => `<ul style="margin:0.3rem 0;padding-left:1.2rem;">${m}</ul>`);
  s = s.replace(/^\d+\. (.+)$/gm, '<li style="margin:0.15rem 0;padding-left:0.25rem;">$1</li>');
  s = s.replace(/\n\n/g, '<br><br>');
  s = s.replace(/\n/g, '<br>');
  return s;
}

// ── CSS анимация для typing dots ──────────────────────────────────
(function injectCSS() {
  if (document.getElementById('ast-style')) return;
  const style = document.createElement('style');
  style.id = 'ast-style';
  style.textContent = `
    @keyframes ast-dot {
      0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
      40% { opacity: 1; transform: scale(1); }
    }
    #assistantFeed::-webkit-scrollbar { width: 4px; }
    #assistantFeed::-webkit-scrollbar-track { background: transparent; }
    #assistantFeed::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.1); border-radius: 2px; }
    #assistantInput:focus { border-color: rgba(6,182,212,0.5) !important; }
  `;
  document.head.appendChild(style);
})();
