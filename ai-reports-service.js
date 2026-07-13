/**
 * ui/ai-reports-service.js
 * ИИ-ассистент отчётов: формирует схему данных, вызывает DeepSeek V4 Flash через
 * api/handler.php (ключи из doc-checker), выполняет filter_fn на state.
 */

import { state } from '../state.js';

// ── Прокси-URL (тот же что в doc-checker) ────────────────────────
function getProxyUrl() {
  const base = window.location.href.split('/').slice(0, -1).join('/');
  return base + '/doc-checker/api/handler.php';
}

// ── Модель DeepSeek через Yandex Cloud (из handler.php) ───────────
// handler.php уже знает модель из config.php; передаём action=ai_query
// Если сервер недоступен — используем miniappsAI SDK (DeepSeek Flash)
const MINIAPPS_MODEL_ID = 'dc2db118-7888-466a-a8d1-bf9d96bab4b6'; // DeepSeek V4 Flash Instant

// ── Схема данных (без PII, без сырых данных) ─────────────────────
export function buildDataSchema() {
  const s = state;

  // Агрегаты для контекста
  const productGroups = [...new Set(s.products.map(p => p.productGroup).filter(Boolean))].sort();
  const categories    = [...new Set(s.products.map(p => p.category).filter(Boolean))].sort();
  const supplierNames = s.suppliers.map(sp => ({ id: sp.id, name: sp.name || sp.title || '' }));
  const programNames  = s.programs.map(p => ({ id: p.id, name: p.name, code: p.code }));
  const recipientNames = s.recipients.map(r => ({ id: r.id, name: r.name, address: r.address || '' }));
  const contractNums  = s.contracts.map(c => ({ id: c.id, number: c.number, supplierId: c.supplierId }));

  // Диапазон дат отгрузок
  const shipDates = s.shipments.map(sh => sh.date).filter(Boolean).sort();
  const whDates   = s.warehouseEntries.map(e => e.date).filter(Boolean).sort();

  return {
    schema: {
      products:         ['id','name','code','category','productGroup','assemblyRequired'],
      recipients:       ['id','name','address','targetProgram','needs:{productId:{qty,delivered,assembled}}'],
      suppliers:        ['id','name'],
      contracts:        ['id','number','date','supplierId','totalPrice','items:[{productId,qty,price,nmcd}]','soApprovalRequired'],
      orders:           ['id','orderNumber','contractId','sent(bool)','deliveryRows:[{productId,productCode,productName,qty,recipients:[{recipientId,recipientName,address,qty}]}]'],
      warehouseEntries: ['id','date','productId','productCode','productName','received','shipped','accepted(bool)','contractId','orderId','supplierId','warehouseId'],
      shipments:        ['id','date','rows:[{productId,productCode,productName,recipients:[{recipientId,recipientName,qty}]}]'],
      assemblyActs:     ['id','date','recipientId','contractId','supplierId','items:[{productId,productCode,assembled}]'],
      acts:             ['id','date','contractId','mode','selectedItems:[{itemCode,shippingAllowed}]'],
      programs:         ['id','name','code','kbk','limit'],
      warehouses:       ['id','name','supplierId'],
    },
    aggregates: {
      productCount:      s.products.length,
      recipientCount:    s.recipients.length,
      contractCount:     s.contracts.length,
      orderCount:        s.orders.length,
      shipmentCount:     s.shipments.length,
      warehouseEntries:  s.warehouseEntries.length,
      assemblyActCount:  (s.assemblyActs || []).length,
      productGroups,
      categories,
      suppliers:         supplierNames.slice(0, 30),
      programs:          programNames,
      recipients:        recipientNames.slice(0, 50),
      contracts:         contractNums.slice(0, 20),
      shipmentDateRange: shipDates.length ? [shipDates[0], shipDates[shipDates.length - 1]] : [],
      warehouseDateRange: whDates.length  ? [whDates[0],   whDates[whDates.length - 1]]   : [],
    },
  };
}

// ── Системный промпт ──────────────────────────────────────────────
const SYSTEM_PROMPT = `Ты — ИИ-ассистент системы управления оснащением образовательных организаций.
У тебя есть доступ к схеме структурированных данных проекта. Данные хранятся в объекте state (JS).

Твоя задача — отвечать на вопросы пользователя на русском языке, используя данные из state.
Для получения данных ты можешь написать JS-функцию (filter_fn), которую система выполнит на реальных данных.

ПРАВИЛА:
1. Отвечай ТОЛЬКО валидным JSON следующей структуры (никакого текста вокруг):
{
  "answer": "краткий текстовый ответ на русском языке (1-3 предложения)",
  "filter_fn": "function(state){ ... return rows; }",
  "columns": [{"key": "fieldName", "label": "Заголовок"}],
  "title": "Заголовок таблицы",
  "chart_type": "bar|pie|line|none",
  "follow_up": ["Уточняющий вопрос 1", "Уточняющий вопрос 2"]
}

2. filter_fn должна:
   - принимать один аргумент: state (объект с массивами products, recipients, contracts, orders, warehouseEntries, shipments, assemblyActs, acts, suppliers, programs, warehouses)
   - возвращать массив объектов (строки таблицы)
   - использовать только безопасный JS (без fetch, eval, DOM, window, document)
   - работать корректно если массивы пустые
   - возвращать [] если данных нет

3. Для дат используй сравнение строк ISO (YYYY-MM-DD) или проверяй вхождение месяца/года
4. Если запрос неоднозначен — спроси уточнение в поле answer, filter_fn верни null
5. Если данных нет — верни filter_fn: null и объясни в answer
6. follow_up — 2-3 логичных уточняющих вопроса

ПРИМЕРЫ filter_fn:

Поставки за август:
function(state){
  return (state.shipments||[]).filter(sh=>{
    return (sh.date||'').startsWith('2025-08') || (sh.date||'').includes('-08-');
  }).flatMap(sh=>(sh.rows||[]).flatMap(row=>(row.recipients||[]).map(r=>({
    date: sh.date, product: row.productName||row.productCode, recipient: r.recipientName, qty: r.qty
  }))));
}

Процент освоения по программе:
function(state){
  const prog = (state.programs||[]).find(p=>p.name&&p.name.includes('3'));
  if(!prog) return [{info:'Программа не найдена'}];
  const limit = prog.limit||0;
  const spent = (state.contracts||[]).filter(c=>(c.programs||[]).includes(prog.id)||
    (c.programs||[]).some(p=>p===prog.name||p===prog.id)).reduce((s,c)=>s+(c.totalPrice||0),0);
  return [{program: prog.name, limit, spent, pct: limit>0?Math.round(spent/limit*100):0}];
}`;

// ── Вызов AI через handler.php (DeepSeek) ────────────────────────
async function callViaProxy(messages, timeoutMs = 60000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const resp = await fetch(getProxyUrl(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      body: JSON.stringify({
        action: 'analyze',
        messages,
        maxTokens: 4000,
      }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch {
      throw new Error('Сервер вернул не JSON: ' + text.slice(0, 200));
    }
    if (data.error) throw new Error(data.error);
    // Поддержка разных форматов ответа (Claude, Alice, DeepSeek)
    return data.text
      || data.result?.alternatives?.[0]?.message?.text
      || data.content?.[0]?.text
      || data.choices?.[0]?.message?.content
      || '';
  } finally {
    clearTimeout(timer);
  }
}

// ── Вызов AI через miniappsAI SDK (fallback) ──────────────────────
async function callViaMiniapps(messages) {
  if (!window.miniappsAI?.callModel) throw new Error('miniappsAI недоступен');
  const result = await miniappsAI.callModel({
    modelId: MINIAPPS_MODEL_ID,
    messages,
    timeoutMs: 60000,
  });
  return miniappsAI.extractText(result);
}

// ── Определяем доступный режим ────────────────────────────────────
// В miniapps.ai превью — всегда miniappsAI SDK (сервер недоступен)
// На сервере (mto-cto.falcon28.ru) — handler.php, fallback на miniappsAI
function isInMiniappsPreview() {
  try {
    const host = window.location.hostname;
    // miniapps.ai preview: miniapps.ai, *.miniapps.ai, localhost в iframe
    return host.includes('miniapps.ai') || host === 'localhost' || host === '127.0.0.1';
  } catch { return false; }
}

let _serverAvailable = null; // null=unknown, true, false

async function checkServer() {
  if (_serverAvailable !== null) return _serverAvailable;
  if (isInMiniappsPreview()) { _serverAvailable = false; return false; }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const r = await fetch(getProxyUrl() + '?test=1', { method: 'GET', signal: ctrl.signal });
    clearTimeout(timer);
    const t = await r.text();
    _serverAvailable = t.includes('ok') || t.includes('OK') || r.ok;
  } catch {
    _serverAvailable = false;
  }
  return _serverAvailable;
}

// ── Основной вызов AI ─────────────────────────────────────────────
export async function callAI(messages) {
  // В превью — сразу miniappsAI, без проверки сервера
  if (isInMiniappsPreview()) {
    return callViaMiniapps(messages);
  }
  const serverOk = await checkServer();
  if (serverOk) {
    try {
      return await callViaProxy(messages);
    } catch (err) {
      console.warn('[ai-reports] proxy failed, fallback to miniapps:', err.message);
    }
  }
  return callViaMiniapps(messages);
}

// ── Парсинг JSON из ответа AI ─────────────────────────────────────
function extractJSON(text) {
  if (!text) return null;
  // 1. Прямой парсинг
  try { return JSON.parse(text.trim()); } catch { /* */ }
  // 2. Убрать markdown-блок
  const stripped = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(stripped); } catch { /* */ }
  // 3. Найти первый { и последний }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
  }
  return null;
}

// ── Безопасное выполнение filter_fn ──────────────────────────────
export function runFilterFn(fnStr) {
  if (!fnStr) return [];
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function('state', `"use strict"; const fn = ${fnStr}; return fn(state);`);
    const result = fn(state);
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.error('[ai-reports] filter_fn error:', err);
    return [{ _error: 'Ошибка выполнения: ' + err.message }];
  }
}

// ── Главная функция: отправить сообщение ─────────────────────────
export async function sendMessage(userText, history) {
  const schema = buildDataSchema();

  const systemContent = SYSTEM_PROMPT + '\n\nСХЕМА ДАННЫХ:\n' + JSON.stringify(schema, null, 2);

  // Формируем messages: system + история + новый вопрос
  const messages = [
    { role: 'system', content: systemContent },
    ...history.slice(-6), // последние 6 сообщений для контекста
    { role: 'user', content: userText },
  ];

  const rawText = await callAI(messages);
  const parsed  = extractJSON(rawText);

  if (!parsed) {
    return {
      answer: rawText || 'Не удалось получить ответ от ИИ.',
      filter_fn: null,
      columns: [],
      title: '',
      chart_type: 'none',
      follow_up: [],
      rows: [],
    };
  }

  // Выполняем filter_fn если есть
  const rows = parsed.filter_fn ? runFilterFn(parsed.filter_fn) : [];

  return {
    answer:     parsed.answer     || '',
    filter_fn:  parsed.filter_fn  || null,
    columns:    parsed.columns    || [],
    title:      parsed.title      || '',
    chart_type: parsed.chart_type || 'none',
    follow_up:  parsed.follow_up  || [],
    rows,
  };
}
