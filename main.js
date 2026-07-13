/**
 * doc-checker/main.js v13 — ЕДИНЫЙ файл без ES-импортов
 * Режим: анализ через handler.php (Яндекс Cloud AI)
 * PDF.js постранично; сканы → OCR через handler.php (action=ocr)
 * Все модули (core, ui, pdf-processor) встроены в один файл.
 * Экспорт: HTML (скачать), Excel (SheetJS), PDF (window.print)
 */

// ════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 1: PDF-PROCESSOR
// ════════════════════════════════════════════════════════════════════════

const PDFJS_URLS = [
  './libs/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
];
const PDFJS_WORKER_URLS = [
  './libs/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
];

let _pdfjsLoaded = false;

async function loadPDFJS() {
  if (_pdfjsLoaded && window.pdfjsLib) return window.pdfjsLib;
  if (window.pdfjsLib) { _pdfjsLoaded = true; return window.pdfjsLib; }

  for (const url of PDFJS_URLS) {
    try {
      await loadScript(url);
      if (window.pdfjsLib) break;
    } catch { /* try next */ }
  }

  if (!window.pdfjsLib) throw new Error('PDF.js не удалось загрузить');

  for (const wurl of PDFJS_WORKER_URLS) {
    try {
      const resp = await fetch(wurl, { method: 'HEAD', cache: 'no-store' });
      if (resp.ok) { window.pdfjsLib.GlobalWorkerOptions.workerSrc = wurl; break; }
    } catch { /* try next */ }
  }
  if (!window.pdfjsLib.GlobalWorkerOptions.workerSrc) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URLS[1];
  }

  _pdfjsLoaded = true;
  return window.pdfjsLib;
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить: ' + src));
    document.head.appendChild(s);
  });
}

async function extractPdfPages(file) {
  const pdfjsLib = await loadPDFJS();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const result = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();

    // Группируем элементы по строкам (Y-координата ±3px), сортируем по X.
    // Это сохраняет табличную структуру: числа из разных колонок не перемешиваются.
    const rowMap = new Map();
    for (const item of textContent.items) {
      const tx = item.transform;
      if (!tx) continue;
      const y = Math.round(tx[5] / 3) * 3; // квантуем по 3px
      if (!rowMap.has(y)) rowMap.set(y, []);
      rowMap.get(y).push({ x: tx[4], str: item.str });
    }
    // Сортируем строки сверху вниз (убывание Y в PDF-координатах), элементы слева направо
    const sortedRows = [...rowMap.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, cells]) => cells.sort((a, b) => a.x - b.x).map(c => c.str).join('\t'));
    const pageText = sortedRows.join('\n').replace(/\t{3,}/g, '\t\t').trim();

    // Считаем текст реальным только если есть достаточно букв/цифр (не мусор от PDF.js)
    const meaningfulChars = (pageText.match(/[а-яёА-ЯЁa-zA-Z0-9]/g) || []).length;
    const hasText = meaningfulChars > 80;
    if (i === 1) console.log('[PDF.js] стр.' + i + ': значимых символов =', meaningfulChars, '→', hasText ? 'текст' : 'СКАН → OCR');

    let canvasData = null;
    if (!hasText) {
      const viewport = page.getViewport({ scale: 2.0 });
      canvasData = {
        width: viewport.width,
        height: viewport.height,
        render: async (canvas) => {
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          await page.render({ canvasContext: canvas.getContext('2d'), viewport }).promise;
        },
      };
    }
    result.push({ text: pageText, canvasData });
  }
  return result;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      resolve({ base64: dataUrl.split(',')[1], mediaType: file.type || guessMimeType(file.name) });
    };
    reader.onerror = () => reject(new Error('Ошибка чтения: ' + file.name));
    reader.readAsDataURL(file);
  });
}

function guessMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  return ({ pdf:'application/pdf', docx:'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:'application/msword', xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:'application/vnd.ms-excel', txt:'text/plain', csv:'text/csv', md:'text/markdown',
    png:'image/png', jpg:'image/jpeg', jpeg:'image/jpeg' })[ext] || 'application/octet-stream';
}

function getFileType(filename) {
  const realExt = filename.toLowerCase().split('.').pop();
  return ({ pdf:'pdf', docx:'docx', doc:'docx', xlsx:'xlsx', xls:'xlsx',
    txt:'txt', md:'txt', csv:'txt', png:'image', jpg:'image', jpeg:'image' })[realExt] || 'unknown';
}

async function extractExcelAsText(file) {
  if (!window.XLSX) {
    for (const url of [
      'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
      'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
      'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
    ]) {
      try { await loadScript(url); if (window.XLSX) break; } catch { /* */ }
    }
  }
  const data = await file.arrayBuffer();
  const wb   = window.XLSX.read(data, { type: 'array' });
  const lines = [];
  wb.SheetNames.forEach(name => {
    lines.push('\n=== Лист: ' + name + ' ===\n');
    lines.push(window.XLSX.utils.sheet_to_csv(wb.Sheets[name], { blankrows: false }));
  });
  return lines.join('\n');
}

// ════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 2: CORE
// ════════════════════════════════════════════════════════════════════════

function getProxyUrl() {
  const loc = window.location;
  if (loc.protocol === 'file:') return 'https://mto-cto.falcon28.ru/doc-checker/api/handler.php';
  const path = loc.pathname || '/';

  // Надёжно поддерживаем все варианты открытия:
  // /doc-checker
  // /doc-checker/
  // /doc-checker/index.html
  // /some/base/doc-checker/index.html
  const dcMatch = path.match(/^(.*\/doc-checker)(?:\/.*)?$/);
  if (dcMatch) {
    return loc.origin + dcMatch[1] + '/api/handler.php';
  }

  const dir = loc.origin + path.replace(/\/[^/]*$/, '/');
  return dir + 'api/handler.php';
}

function formatFetchError(url, err) {
  const msg = String(err?.message || err || 'NetworkError');
  return 'Сеть / handler недоступен: ' + url + ' · ' + msg;
}

async function testHandlerHealth() {
  const url = getProxyUrl() + '?action=test&_ts=' + Date.now();
  try {
    const controller = new AbortController();
    const timerId = setTimeout(() => controller.abort(), 12000);
    let resp;
    try {
      resp = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timerId);
    }

    const text = await resp.text();
    if (!resp.ok) {
      throw new Error('HTTP ' + resp.status + ': ' + text.slice(0, 160));
    }

    let data = null;
    try { data = JSON.parse(text); } catch {
      throw new Error('handler вернул не JSON: ' + text.slice(0, 160));
    }

    if (!data?.ok) {
      throw new Error(data?.error || 'handler test failed');
    }

    return { ok: true, data, url };
  } catch (err) {
    return { ok: false, url, error: formatFetchError(url, err) };
  }
}

// ── Yandex Object Storage helpers ──────────────────────────────────────────────

let _storageEnabled = null; // null=не проверяли, true=доступен, false=нет

async function checkStorageEnabled() {
  if (_storageEnabled !== null) return _storageEnabled;
  try {
    const resp = await fetch(getProxyUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'storage_status' }),
    });
    if (!resp.ok) { _storageEnabled = false; return false; }
    const data = await resp.json();
    _storageEnabled = !!(data.enabled);
    console.log('[Storage]', _storageEnabled ? '✅ Включён, бакет: ' + data.bucket : '⬜ Отключён (' + (data.reason || '') + ')');
  } catch {
    _storageEnabled = false;
  }
  updateStorageBadge();
  return _storageEnabled;
}

function updateStorageBadge() {
  const el = document.getElementById('storageBadge');
  if (!el) return;
  if (_storageEnabled === true) {
    el.innerHTML = '☁️ <span style="color:#34d399">Object Storage</span> — нативное чтение PDF';
    el.title = 'PDF файлы временно загружаются в Yandex Object Storage и удаляются после анализа';
  } else if (_storageEnabled === false) {
    el.innerHTML = '📄 PDF.js + Yandex Vision OCR';
    el.title = 'Object Storage не настроен. PDF читается через PDF.js. Сканы — через Yandex Vision OCR.';
  } else {
    el.innerHTML = '⏳ Проверка Storage...';
  }
}

/**
 * Загружает PDF-файл в Yandex Object Storage через handler.php.
 * Возвращает { key, url } или null при ошибке.
 */
async function uploadFileToStorage(f, onProgress) {
  try {
    onProgress?.('☁️ Загрузка в Storage: ' + f.name);
    const { base64, mediaType } = await fileToBase64(f.file);
    const resp = await fetch(getProxyUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'upload_to_storage', filename: f.name, base64, mediaType }),
    });
    const data = await resp.json();
    if (!resp.ok || data.error) {
      console.warn('[Storage] Ошибка загрузки', f.name, data.error || resp.status);
      return null;
    }
    console.log('[Storage] Загружен:', f.name, '→', data.key);
    return { key: data.key, url: data.url };
  } catch (err) {
    console.warn('[Storage] Исключение при загрузке', f.name, err);
    return null;
  }
}

/**
 * Удаляет объект из Object Storage (вызывается после анализа).
 */
async function deleteFromStorage(key) {
  if (!key) return;
  try {
    await fetch(getProxyUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'delete_from_storage', key }),
    });
    console.log('[Storage] Удалён:', key);
  } catch (err) {
    console.warn('[Storage] Ошибка удаления', key, err);
  }
}

const DOC_TYPES = {
  upd:               { label: 'УПД',                       icon: '📄', zone: 1 },
  invoice:           { label: 'Счёт',                      icon: '💰', zone: 1 },
  contract:          { label: 'Договор',                   icon: '📋', zone: 2 },
  specification:     { label: 'Спецификация / ТЗ',         icon: '📐', zone: 2 },
  waybill:           { label: 'Накладная (ТОРГ-12)',        icon: '🚚', zone: 3 },
  act_commissioning: { label: 'Акт приёмки / комиссии',    icon: '✅', zone: 3 },
  registry:          { label: 'Сводный реестр',            icon: '📊', zone: 3 },
  advance_invoice:   { label: 'Авансовый счёт',            icon: '💳', zone: 3 },
  inspection_act:    { label: 'Акт проверки',              icon: '🔍', zone: 4 },
  claim:             { label: 'Претензия',                 icon: '⚠️', zone: 4 },
  rename_act:        { label: 'Акт переименования',        icon: '🏷️', zone: 4 },
  certificate:       { label: 'Сертификат',                icon: '🏆', zone: 4 },
  declaration:       { label: 'Декларация соответствия',   icon: '🔖', zone: 4 },
  warranty:          { label: 'Гарантийный талон',         icon: '🛡️', zone: 4 },
  memo:              { label: 'Служебная записка',         icon: '📝', zone: 4 },
  other:             { label: 'Иной документ',             icon: '📎', zone: 4 },
};

function getTypeLabel(type) { return DOC_TYPES[type]?.label || type || 'Документ'; }
function getTypeIcon(type)  { return DOC_TYPES[type]?.icon  || '📎'; }

function detectDocType(filename, text) {
  const cleanName = (filename || '').replace(/(\.\w{2,5})+$/i, '').toLowerCase();
  // Реестр определяется ТОЛЬКО по имени файла или первой строке содержимого (не глубже 200 символов)
  const firstLine = (text || '').slice(0, 200).split('\n')[0];
  const n = (cleanName + ' ' + firstLine).toLowerCase();
  if (/упд|универсальный передаточный/.test(n))                         return 'upd';
  if (/счёт-фактура|счет-фактура/.test(n))                              return 'upd';
  if (/авансов/.test(n))                                                return 'advance_invoice';
  if (/\bсчёт\b|\bсчет\b/.test(n) && !/фактур/.test(n))                return 'invoice';
  if (/договор|контракт/.test(n))                                       return 'contract';
  if (/техническое задание|тех\.?\s*задание|\bтз\b|спецификац/.test(n)) return 'specification';
  if (/торг-?12|накладная|товарная/.test(n))                            return 'waybill';
  if (/акт ввода|ввод в эксплуатацию|акт приёма|акт приема/.test(n))   return 'act_commissioning';
  if (/акт комиссии|комиссионн|приёмочн|приемочн|акт приёмки|акт приемки/.test(n)) return 'act_commissioning';
  if (/реестр/.test(cleanName) || /^реестр/.test(firstLine.toLowerCase()))  return 'registry';
  if (/акт проверк|проверочн/.test(n))                                  return 'inspection_act';
  if (/претензи/.test(n))                                               return 'claim';
  if (/переименован/.test(n))                                           return 'rename_act';
  if (/сертификат/.test(n))                                             return 'certificate';
  if (/деклараци/.test(n))                                              return 'declaration';
  if (/гарантийн|гарантийный талон|гарант\.?\s*талон/.test(n))         return 'warranty';
  if (/служебная записка|служ\.?\s*записк/.test(n))                     return 'memo';
  return 'other';
}

async function callAI({ messages, system, maxTokens, onProgress, timeoutMs }) {
  const MAX_RETRIES = 3;
  const FETCH_TIMEOUT = timeoutMs || 240000; // 240 секунд — больше nginx-таймаута
  const proxyUrl = getProxyUrl();
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = { action: 'analyze', max_tokens: maxTokens || 131072, messages };
      if (system) payload.system = system;

      // AbortController для таймаута fetch
      const controller = new AbortController();
      const timerId = setTimeout(() => controller.abort(), FETCH_TIMEOUT);

      let resp;
      try {
        resp = await fetch(proxyUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timerId);
      }

      const text = await resp.text();
      if (!resp.ok) {
        let data = null;
        try { data = JSON.parse(text); } catch { /* 504/502 от nginx часто приходят HTML-страницей */ }
        const plainSnippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        const errMsg = typeof data?.error === 'string'
          ? data.error
          : data?.error?.message || plainSnippet || ('HTTP ' + resp.status);
        // 504 Gateway Timeout — ждём дольше и повторяем
        if (resp.status === 504 || resp.status === 502 || resp.status === 503) {
          const wait = 15 * attempt;
          onProgress?.('⏳ Сервер не ответил (' + resp.status + '), пауза ' + wait + ' сек, попытка ' + attempt + '/' + MAX_RETRIES + '...');
          console.warn('[callAI] HTTP ' + resp.status + ', ждём ' + wait + 'с...');
          await sleep(wait * 1000);
          lastErr = new Error(errMsg || ('HTTP ' + resp.status));
          continue;
        }
        if (resp.status === 429 || resp.status === 529) {
          const wait = attempt * 20;
          onProgress?.('Лимит API, пауза ' + wait + ' сек...');
          await sleep(wait * 1000);
          lastErr = new Error(errMsg);
          continue;
        }
        throw new Error('API ошибка ' + resp.status + ': ' + errMsg);
      }

      let data;
      try {
        data = JSON.parse(text);
      } catch {
        const snippet = String(text || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        if (/504 Gateway Time-?out|502 Bad Gateway|503 Service Unavailable/i.test(snippet) && attempt < MAX_RETRIES) {
          const wait = 15 * attempt;
          onProgress?.('⏳ Шлюз вернул таймаут, пауза ' + wait + ' сек, попытка ' + attempt + '/' + MAX_RETRIES + '...');
          console.warn('[callAI] gateway HTML response, ждём ' + wait + 'с...');
          await sleep(wait * 1000);
          lastErr = new Error('Gateway timeout HTML response');
          continue;
        }
        throw new Error('Сервер вернул не JSON: ' + snippet);
      }
      // Поддержка форматов ответа:
      // 1. handler.php нормализованный: data.text
      // 2. Claude-формат: data.content[0].text
      // 3. Alice raw: data.result.alternatives[0].message.text
      // 4. OpenAI-совместимый: data.choices[0].message.content
      let content =
        data.text ??
        data.content?.[0]?.text ??
        data.result?.alternatives?.[0]?.message?.text ??
        data.choices?.[0]?.message?.content ??
        null;
      console.log('[callAI] keys:', Object.keys(data).join(','), '| len:', content?.length ?? 'null');
      if (content === null || content === undefined) throw new Error('Пустой ответ. Ключи: ' + Object.keys(data).join(','));
      if (content === '') throw new Error('Модель вернула пустой текст');
      return content;
    } catch (err) {
      const wrappedErr = new Error(formatFetchError(proxyUrl, err));
      wrappedErr.name = err?.name || 'Error';
      lastErr = wrappedErr;
      // AbortError = таймаут fetch
      if (err.name === 'AbortError') {
        const wait = 10 * attempt;
        onProgress?.('⏳ Таймаут запроса (' + Math.round(FETCH_TIMEOUT / 1000) + 'с), пауза ' + wait + 'с, попытка ' + attempt + '/' + MAX_RETRIES + '...');
        console.warn('[callAI] Fetch AbortError (timeout), ждём ' + wait + 'с...');
        if (attempt < MAX_RETRIES) { await sleep(wait * 1000); continue; }
      }
      if (attempt < MAX_RETRIES) {
        onProgress?.('Ошибка, повтор ' + (attempt + 1) + '/' + MAX_RETRIES + ': ' + err.message.slice(0, 80));
        await sleep(5000 * attempt);
      }
    }
  }
  throw lastErr || new Error('Все попытки исчерпаны');
}

function buildContentBlock(fileObj) {
  const { base64, mediaType, textContent, filename, storageUrl } = fileObj;
  // Если есть извлечённый текст (PDF.js / OCR / xlsx / txt) — всегда используем текст.
  // storageUrl используем только если текст недоступен (бинарный PDF без текстового слоя).
  if (textContent !== undefined && textContent !== null) {
    return { type: 'text', text: '=== ' + filename + ' ===\n' + textContent };
  }
  // Нативное чтение через Object Storage (только если текст не извлечён)
  if (storageUrl) {
    return { type: 'storage_url', url: storageUrl, title: filename };
  }
  if (mediaType && mediaType.startsWith('image/')) {
    return { type: 'image_base64', media_type: mediaType, data: base64, title: filename };
  }
  // DOCX и прочие бинарные — base64 для PHP-парсинга
  return { type: 'doc_base64', media_type: mediaType || 'application/octet-stream', data: base64, title: filename };
}

const SYSTEM_PROMPT = [
  'Ты — опытный специалист по проверке первичной бухгалтерской документации и документов в сфере государственных закупок.',
  'Работай как эксперт, который сначала понимает хозяйственный сценарий пакета, а уже потом ищет нарушения.',
  'Твоя главная задача — ответить не только на вопрос «есть ли ошибки», но и на вопрос «что именно этим пакетом пытаются закрыть и можно ли по нему проводить оплату / частичное закрытие / финальное закрытие».',
  'Не работай как формальный OCR-робот. Сначала восстанови смысл пакета, затем роли документов, затем комплектность, и только после этого формируй нарушения и риски.',
  '',
  'Тебе передают пакет документов для проверки перед оплатой поставщику. Документы распределены по зонам:',
  '- ЗОНА 1: документ на оплату (УПД, счёт, счёт-фактура или аналог)',
  '- ЗОНА 2: договор и техническое задание (эталон для сверки реквизитов, наименований, цен)',
  '- ЗОНА 3: первичная документация (товарные накладные, акты ввода в эксплуатацию, ТОРГ-12, ТТН, сводный реестр накладных)',
  '- ЗОНА 4: дополнительные документы (акты проверок, акты комиссии по приёмке, претензии, сертификаты, декларации, гарантийные талоны, служебные записки, акты переименования, авансовый счёт)',
  '',
  'Документ считается тем, чем он является по зоне — вне зависимости от его названия или типа.',
  'Акт комиссии по приёмке — это первичный документ (зона 3 или 4), подтверждающий приёмку товара.',
  'Гарантийный талон — это дополнительный документ (зона 4), подтверждающий гарантийные обязательства.',
  '',
  'ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА: верни ТОЛЬКО валидный JSON без markdown-блоков, без пояснений до и после.',
  'ВСЕ денежные и количественные поля qty, price, amountNoVat, vat, amountWithVat, totalAmount и total.* возвращай СТРОКАМИ, а не JSON-числами. Пример: "238352.31052699367".',
  '',
  'СТРУКТУРА JSON:',
  '{',
  '  "paymentDoc": {',
  '    "docType": "тип документа (УПД / Счёт / Счёт-фактура / Акт КС-2 и т.д.)",',
  '    "name": "наименование и номер документа",',
  '    "date": "дата документа ДД.ММ.ГГГГ",',
  '    "inn_supplier": "ИНН поставщика",',
  '    "name_supplier": "наименование поставщика",',
  '    "inn_buyer": "ИНН покупателя",',
  '    "name_buyer": "наименование покупателя",',
  '    "contract_ref": "ссылка на договор (номер, дата) если указана",',
  '    "items": [{"num":1,"name":"","unit":"","qty":0,"price":0,"amountNoVat":0,"vatRate":"","vat":0,"amountWithVat":0}],',
  '    "total": {"qty":0,"amountNoVat":0,"vat":0,"amountWithVat":0},',
  '    "issues": ["список замечаний по самому документу"]',
  '  },',
  '  "contract": {',
  '    "found": true,"number": "","date": "","inn_supplier": "","inn_buyer": "",',
  '    "totalAmount": null,"advancePct": null,"deliveryDeadline": "",',
  '    "items": [{"name":"","qty":null,"price":null}]',
  '  },',
  '  "primaryDocs": [{',
  '    "docType": "тип (ТОРГ-12 / Акт ввода / ТТН / Реестр и т.д.)",',
  '    "name": "","date": "","recipient": "",',
  '    "items": [{"num":1,"name":"","unit":"","qty":null,"price":null,"amountNoVat":null,"vatRate":"","vat":null,"amountWithVat":null}],',
  '    "total": {"qty":null,"amountNoVat":0,"vat":0,"amountWithVat":0},"issues":[]',
  '  }],',
  '  "aggregate": {',
  '    "items": [{"name":"","unit":"","qty":0,"amountNoVat":0,"vat":0,"amountWithVat":0}],',
  '    "total": {"qty":0,"amountNoVat":0,"vat":0,"amountWithVat":0}',
  '  },',
  '  "comparison": {',
  '    "qtyMatch":true,"amountNoVatMatch":true,"vatMatch":true,"amountWithVatMatch":true,',
  '    "diff_qty":0,"diff_amountNoVat":0,"diff_vat":0,"diff_amountWithVat":0,',
  '    "problematicDocs":[],"recommendation":""',
  '  },',
  '  "extraDocs": [{"docType":"","name":"","date":null,"expiryDate":null,"productName":null,"qty":null,"hasStamp":null,"hasSignature":null,"matchesContract":null,"items":[],"total":{"qty":null},"issues":[]}],',
  '  "chronology": [{"date":"ДД.ММ.ГГГГ","docName":"","event":""}],',
  '  "rekvizity": {"supplierInnConsistent":true,"buyerInnConsistent":true,"supplierNameConsistent":true,"inconsistencies":[]},',
  '  "unreadableData": [{"docName":"","location":"","description":""}],',
  '  "violations": [{"severity":"critical|significant|minor","category":"суммы|реквизиты|хронология|наименования|подписи|сертификаты|претензии|прочее","docName":"","text":""}],',
  '  "conclusion": "итоговое заключение",',
  '  "actionRequired": ["действие 1"]',
  '}',
  '',
  'ПРАВИЛА РАБОТЫ С ЧИСЛАМИ:',
  '- Все числа записывай ТОЧНО как в документе, без округления и без потери НИ ОДНОГО знака',
  '- ЗАПРЕЩЕНО обрезать дробную часть: 62393.02459016393 → 62393.02 (НЕВЕРНО). Правильно: 62393.02459016393',
  '- Цена может быть длинной дробью с 10+ знаками: 238352.3105269930 — записывай именно так, все знаки',
  '- Коды ОКПД2 (формат X.XX.XX.XXX, например 32.99.53.139) — это код товара, НИКОГДА не цена и не часть числа',
  '- PDF-парсер РАЗБИВАЕТ числа на части через пробел или перенос строки:',
  '  «62 393,024» + «59016393» на следующей строке = одно число 62393.02459016393',
  '  «238 352,310» + «52699367» на следующей строке = одно число 238352.31052699367',
  '  Всегда верифицируй: qty × price = amountNoVat (с точностью до копейки)',
  '- Сумма первичных документов должна равняться сумме документа на оплату с допуском не более 0,005 руб. Расхождение 0,01 руб. и более — critical, блокирующее оплату',
  '- Длинные последовательности цифр после запятой (>4 знаков) — продолжение числа, не отдельное значение',
  '- Пробелы в числах (1 000 000) — разделители разрядов',
  '- Запятая в числах — десятичный разделитель (российский формат)',
  '',
  'ПРАВИЛА АНАЛИЗА:',
  'A. СНАЧАЛА ОПРЕДЕЛИ СЦЕНАРИЙ ПАКЕТА: это полное закрытие, частичное закрытие, промежуточный этап, сценарий 70/30, поставка без ввода, пакет на качество/претензию или rename_act.',
  'B. ЗАТЕМ ОПРЕДЕЛИ РОЛЬ КАЖДОГО ДОКУМЕНТА: документ на оплату, договорная база, первичка поставки, контрольный реестр, документы качества, гарантия, ввод, исполнение обязательств, претензия, служебное обоснование.',
  'C. ЗАТЕМ ОПРЕДЕЛИ, КАКИЕ ДОКУМЕНТЫ ОБЯЗАТЕЛЬНЫ ИМЕННО ДЛЯ ЭТОГО СЦЕНАРИЯ: для оплаты, для частичного закрытия, для финального закрытия.',
  'D. ТОЛЬКО ПОСЛЕ ЭТОГО формируй нарушения: отдельно блокеры оплаты, отдельно риски комплектности для финального закрытия, отдельно второстепенные замечания.',
  '0. РЕЕСТРЫ (реестр УПД / реестр накладных / сводный реестр / реестр актов)',
  '   — Реестр НЕ является первичным документом и НЕ подтверждает факт поставки самостоятельно.',
  '   — Реестр — это контрольный документ-сводка: каждая его строка соответствует одному первичному документу.',
  '   — В JSON реестр помещается в primaryDocs с docType="registry"; в aggregate его суммы НЕ включаются НИКОГДА.',
  '   — aggregate заполняй ИСКЛЮЧИТЕЛЬНО из накладных, актов ввода, УПД-первичных (НЕ реестров).',
  '   — КРИТИЧЕСКИ ВАЖНО: для реестра в поле items[] записывай СТРОКИ РЕЕСТРА (каждая строка = один документ-накладная), НЕ товарные позиции: waybillNum (номер, напр. "1/1"), waybillDate (дата), name (получатель), recipientInn (ИНН до /), qty, price, amount.',
  '   — Если строка реестра отсутствует в пакете — critical: «Накладная [номер] не загружена в пакет».',
  '   — Если документ из пакета (зона 3, не являющийся реестром) отсутствует в реестре — significant: «Документ [имя] не отражён в реестре».',
  '   — Если данные в строке реестра расходятся с соответствующим первичным документом — нарушение.',
  '   — Итоговая строка реестра (если есть) должна равняться сумме всех строк реестра.',
  '   — Наличие реестра не является обязательным; если реестр не загружен — эти проверки пропускаются.',
  '1. РЕКВИЗИТЫ — ИНН поставщика и покупателя должны совпадать во всех документах; наименования сторон должны совпадать с договором',
  '2. СУММЫ — арифметика внутри каждого документа: qty × price = amountNoVat; amountNoVat + vat = amountWithVat; сумма всех первичных (кроме реестра) = сумме документа на оплату. Не округляй и не сокращай дробную часть.',
  '3. ХРОНОЛОГИЯ — НОРМАЛЬНАЯ последовательность: Договор → Первичные документы → Документ на оплату. ПЕРВИЧНЫЕ ДОКУМЕНТЫ ДОЛЖНЫ БЫТЬ ДАТИРОВАНЫ РАНЬШЕ ДОКУМЕНТА НА ОПЛАТУ — ЭТО НОРМА, НЕ НАРУШЕНИЕ. НАРУШЕНИЯ: 1) первичный документ датирован ПОЗЖЕ документа на оплату; 2) дата получения товара раньше даты самого документа (опечатка года); 3) акт комиссии датирован после платёжного документа; 4) сертификат просрочен. Пример НОРМАЛЬНОЙ хронологии: Договор 14.10.2025 → УПД 13.01.2026 (поставка) → Счёт-фактура 27.04.2026 (оплата) — ВСЁ ПРАВИЛЬНО.',
  '4. НАИМЕНОВАНИЯ — ОБЯЗАТЕЛЬНО: перечисли ВСЕ варианты наименования товара из ВСЕХ документов; если хотя бы два варианта различаются — это нарушение. Пример: «Набор элементов Unimat с ЧПУ» vs «Конструктор модульных станков» — critical; «UNIMAT» vs «Unimat» — minor.',
  '5. ПОЛЕ 8 (идентификатор госконтракта) — в каждом УПД ОБЯЗАТЕЛЬНО проверь поле 8; если пустое, «--», «0», «б/н» или прочерк — significant нарушение; укажи точное содержимое поля',
  '6. СТРАНА ПРОИСХОЖДЕНИЯ — в каждом первичном документе ОБЯЗАТЕЛЬНО проверь; если в акте комиссии несколько стран для одного товара — critical; если страна в накладной отличается от акта комиссии — critical; если не указана — significant',
  '7. БАНКОВСКИЕ РЕКВИЗИТЫ — ОБЯЗАТЕЛЬНО: извлеки р/с, БИК, к/с из договора и из каждого УПД/счёта; если различаются — critical; укажи конкретные значения',
  '8. ВНУТРЕННЯЯ СОГЛАСОВАННОСТЬ — все даты, номера, суммы и наименования внутри каждого документа должны быть согласованы; несоответствие в разных частях одного документа — нарушение',
  '9. ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ (ЗОНА 4) — ОБЯЗАТЕЛЬНО обрабатывай ВСЕ документы из зоны 4. Каждый документ из зоны 4 ДОЛЖЕН быть включён в extraDocs[]. ЗАПРЕЩЕНО пропускать документы из зоны 4.',
  '9.1. Каждый документ из зоны 4 должен быть осмыслен как доказательство: что он подтверждает, влияет ли он на оплату, влияет ли он на финальное закрытие, объясняет ли он частичный сценарий, снимает ли он претензию по качеству/наименованию или наоборот создаёт риск.',
  'КОЛИЧЕСТВО В НАКЛАДНЫХ (ТОРГ-12 и аналогах): количество товара — это ТОЛЬКО цифра в числовой колонке. Слова прописью («Два», «Три») в тексте — это описание числа страниц/записей, НЕ количество товара.',
  'ВОССТАНОВЛЕНИЕ ТАБЛИЦ ТОРГ-12: PDF.js разрушает табличную структуру. Алгоритм: 1) найди итоговую строку — она даёт контрольные суммы; 2) для каждой строки подбери пару qty × price = amountNoVat; 3) используй amountWithVat = amountNoVat × 1.22 как проверку; 4) если qty=1 — цена = amountNoVat; 5) НИКОГДА не присваивай цену строки N строке M.',
  '10. НДС — ставка 22% является базовой с 2025 года и НЕ является нарушением; ставки 20%, 10%, 0% также допустимы',
  '11. СТЕПЕНИ НАРУШЕНИЙ — critical: блокирует оплату; significant: требует исправления или не позволяет считать пакет полностью закрывающим; minor: рекомендуется исправить',
  '12. АКТ ПЕРЕИМЕНОВАНИЯ — если в пакете есть акт переименования: извлеки ВСЕ варианты наименования товара, коды и цены из каждой строки таблицы. ВАЖНО: акт переименования содержит ВСЕ товары контракта, а в текущем пакете могут быть только НЕКОТОРЫЕ из них — это НОРМА. Каждая строка акта = отдельный товар. Сравнивай наименования ПОСТРОЧНО: для каждой строки акта ищи совпадение в других документах пакета. Если хотя бы одно наименование из акта совпадает с документом — НОРМА. Если ни одно не совпадает — significant. Цена в акте переименования — это цена С НДС (итоговая стоимость единицы). Расхождение с ценой БЕЗ НДС в УПД — НЕ нарушение. Нарушение только если цена в акте не совпадает ни с ценой без НДС, ни с ценой с НДС из УПД.',
  '',
  'Отвечай ТОЛЬКО JSON, никакого текста вокруг.',
].join('\n');

// ── Нормализация номера накладной ────────────────────────────────────────────
function normalizeWaybillNum(str) {
  if (!str) return '';
  const m = String(str).match(/(\d+)[\/\-](\d+)/);
  if (m) return m[1] + '/' + m[2];
  return String(str).replace(/[^\d\/\-]/g, '').trim();
}

function extractWaybillNumFromName(name) {
  if (!name) return '';
  const m = name.match(/[№#]\s*(\d+[\/\-]\d+)/);
  if (m) return normalizeWaybillNum(m[1]);
  const m2 = name.match(/(\d+)[_\-\/](\d+)/);
  if (m2) return m2[1] + '/' + m2[2];
  return '';
}

// ── JS-пересчёт aggregate (без реестров) ─────────────────────────────────────
function recalcAggregate(primaryDocs) {
  const real = (primaryDocs || []).filter(p => !isRegistryDocType(p.docType, p.name));
  if (!real.length) return null;
  const nameMap = {};
  real.forEach(doc => {
    (doc.items || []).forEach(item => {
      const key = (item.name || '').toLowerCase().slice(0, 40) || '_';
      if (!nameMap[key]) nameMap[key] = { name: item.name, unit: item.unit, qty: '0', amountNoVat: '0', vat: '0', amountWithVat: '0' };
      nameMap[key].qty           = decimalAddStrings(nameMap[key].qty, item.qty);
      nameMap[key].amountNoVat   = decimalAddStrings(nameMap[key].amountNoVat, item.amountNoVat);
      nameMap[key].vat           = decimalAddStrings(nameMap[key].vat, item.vat);
      nameMap[key].amountWithVat = decimalAddStrings(nameMap[key].amountWithVat, item.amountWithVat);
    });
  });
  const items = Object.values(nameMap);
  const total = items.reduce((t, it) => ({
    qty:           decimalAddStrings(t.qty, it.qty),
    amountNoVat:   decimalAddStrings(t.amountNoVat, it.amountNoVat),
    vat:           decimalAddStrings(t.vat, it.vat),
    amountWithVat: decimalAddStrings(t.amountWithVat, it.amountWithVat),
  }), { qty: '0', amountNoVat: '0', vat: '0', amountWithVat: '0' });
  return { items, total, _recalculated: true };
}

const SYSTEM_PROMPT_VIOLATIONS = [
  'Ты анализируешь уже нормализованный пакет документов на оплату.',
  'Твоя роль — не OCR и не табличный парсер, а эксперт по смыслу пакета.',
  'Сначала определи сценарий: полное закрытие, частичный этап, промежуточная поставка, пакет качества, пакет претензии.',
  'Потом определи, что подтверждено документами: поставка, приёмка, качество, ввод, частичный сценарий, финальное закрытие.',
  'Только после этого формируй нарушения.',
  'Не смешивай блокеры оплаты, блокеры финального закрытия и формальные замечания.',
  'Не повторяй механически всё подряд и не дублируй шум из реестра — JS уже делает часть сверок.',
  'Если различие объясняется актом переименования, не делай из этого нарушение без отдельного основания.',
  'Если различие только в полном/сокращённом названии организации при том же ИНН — это не ключевое нарушение.',
  'Если есть акт о неготовности места или явный сценарий 70/30, трактуй пакет как частичный сценарий, а не как финальное закрытие.',
  'Если договор похож на мебель / оснащение / оборудование, оцени комплектность по качеству, паспортам, гарантии, сборке и вводу.',
  'Верни ТОЛЬКО минифицированный JSON без markdown и пояснений.',
  'Формат ответа:',
  '{"rekvizity":{"supplierInnConsistent":true,"buyerInnConsistent":true,"supplierNameConsistent":true,"inconsistencies":[]},"unreadableData":[{"docName":"","location":"","description":""}],"violations":[{"severity":"critical|significant|minor","category":"суммы|реквизиты|хронология|наименования|страна|комплектность|качество|прочее","docName":"","text":""}],"conclusion":"","actionRequired":[]}',
  'Степени:',
  '- critical: блокирует текущую оплату;',
  '- significant: не даёт считать пакет чисто закрывающим или требует исправления;',
  '- minor: формальное или второстепенное замечание.',
].join('\n');

const PROMPT_PAYMENT = [
  'Извлеки данные только из документа на оплату и договора.',
  'Не делай общий вердикт и не додумывай отсутствующие значения.',
  'Документ на оплату — якорный документ пакета. Договор — база для реквизитов, предмета и сценария закрытия.',
  'Все денежные и количественные поля возвращай СТРОКАМИ и в точности как в документе.',
  'Не округляй и не сокращай дробную часть. Если в числе много знаков после запятой, сохрани их все.',
  'Если PDF разбил число на части, восстанови одно число. ОКПД2 и другие коды не считай ценой.',
  'После извлечения проверь для каждой строки: qty × price = amountNoVat. Если не сходится, значит строки или числа перепутаны — исправь.',
  'Верни ТОЛЬКО минифицированный JSON без markdown:',
  '{"paymentDoc":{"docType":"","name":"","date":"","inn_supplier":"","name_supplier":"","inn_buyer":"","name_buyer":"","contract_ref":"","items":[{"num":1,"name":"","unit":"","qty":"","price":"","amountNoVat":"","vatRate":"","vat":"","amountWithVat":""}],"total":{"qty":"","amountNoVat":"","vat":"","amountWithVat":""},"issues":[]},"contract":{"found":false,"number":"","date":"","inn_supplier":"","inn_buyer":"","totalAmount":null,"advancePct":null,"deliveryDeadline":""}}',
].join('\n');

const PROMPT_REGISTRY = [
  'Перед тобой сводный реестр накладных.',
  'Реестр — это контрольный список документов, а не товарная накладная и не свод товарных строк.',
  'Каждая строка реестра = один первичный документ.',
  'Не превращай строки реестра в товарные позиции.',
  'Извлеки все строки в registryItems[].',
  'Все количества и суммы возвращай СТРОКАМИ и без округления.',
  'Нужные поля строки: num, waybillNum, waybillDate, recipientName, recipientInn, qty, price, amount.',
  'Верни ТОЛЬКО минифицированный JSON без markdown:',
  '{"registryItems":[{"num":0,"waybillNum":"","waybillDate":"","recipientName":"","recipientInn":"","qty":"","price":"","amount":""}],"registryTotal":{"qty":"","amount":""}}',
].join('\n');

const PROMPT_PRIMARY = [
  'Извлеки данные из первичных документов поставки.',
  'Сначала определи роль документа: накладная, УПД-первичка, акт комиссии, акт приёмки, акт ввода или иной первичный документ.',
  'Каждая строка таблицы = отдельная позиция. Не смешивай строки между собой.',
  'Все qty, price, amountNoVat, vat, amountWithVat и total.* возвращай СТРОКАМИ и без округления.',
  'После извлечения проверь арифметику каждой строки: qty × price = amountNoVat. Если не сходится, значит числа или строки перепутаны — исправь.',
  'В накладных не бери количество из слов вроде «Два/Три» в тексте. Количество берётся только из числовой колонки.',
  'ОКПД2 и похожие коды не путай с ценой или количеством.',
  'Заполни chronology[] по всем найденным датам документов.',
  'Для накладных отдельно постарайся извлечь waybillNum и recipientInn.',
  'Верни ТОЛЬКО минифицированный JSON без markdown:',
  '{"primaryDocs":[{"docType":"","name":"","date":"","recipient":"","inn_supplier":"","waybillNum":"","recipientInn":"","items":[{"num":1,"name":"","unit":"","qty":"","price":"","amountNoVat":"","vatRate":"","vat":"","amountWithVat":""}],"total":{"qty":"","amountNoVat":"","vat":"","amountWithVat":""},"issues":[]}],"extraDocs":[{"docType":"","name":"","date":"","expiryDate":null,"productName":"","qty":null,"hasStamp":null,"hasSignature":null,"issues":[]}],"chronology":[{"date":"ДД.ММ.ГГГГ","docName":"","event":"","violation":null}]}',
].join('\n');

const PROMPT_EXTRA = [
  'Ты анализируешь только дополнительные документы зоны 4.',
  'Не делай общий вердикт по пакету. Извлекай факты и роль каждого документа.',
  'Каждый документ зоны 4 должен попасть в extraDocs[] отдельной записью.',
  'Не пропускай акты неготовности, акты комиссии, акты ввода, акты исполнения, сертификаты, декларации, паспорта, гарантии, письма, претензии, акты переименования.',
  'Для каждого документа определи:',
  '- что он подтверждает;',
  '- к какому этапу относится;',
  '- влияет ли он на оплату;',
  '- влияет ли он на финальное закрытие;',
  '- требует ли после себя дополнительных документов.',
  'Если документ — акт переименования, извлеки варианты наименований/кодов/цен в items[], если они есть.',
  'Если документ — акт о неготовности места, отрази, что он поддерживает частичный сценарий и блокирует финальное закрытие.',
  'Верни ТОЛЬКО минифицированный JSON без markdown:',
  '{"extraDocs":[{"docType":"inspection_act|claim|rename_act|certificate|declaration|warranty|passport|memo|commissioning|execution_act|readiness_act|approval|letter|other","name":"","date":null,"expiryDate":null,"stage":"payment|delivery|installation|commissioning|closure|quality|renaming|claim|unknown","documentRole":"","productName":null,"qty":null,"hasStamp":null,"hasSignature":null,"referencesContract":null,"referencesInvoice":null,"referencesPrimaryDocs":[],"paymentImpact":"supports|blocks|neutral","finalClosureImpact":"supports|blocks|neutral","supportsPartialClosure":false,"supportsFinalClosure":false,"blocksFinalClosure":false,"requiresFollowUpDocs":[],"keyFacts":[],"items":[],"total":{"qty":null},"issues":[]}],"chronology":[{"date":"ДД.ММ.ГГГГ","docName":"","event":"","violation":null}]}',
].join("\n");

const PROMPT_ISSUES = [
  'Ты получаешь уже нормализованные данные пакета документов.',
  'Не нужно заново извлекать таблицы и не нужно повторять OCR.',
  'Твоя задача — дать короткую, жёсткую экспертную оценку пакета.',
  'Порядок мышления:',
  '1. Определи сценарий пакета.',
  '2. Определи, какие документы в пакете что подтверждают.',
  '3. Оцени комплектность именно для этого сценария.',
  '4. Раздели: блокеры оплаты, блокеры финального закрытия, существенные риски, формальные замечания.',
  '5. Используй extraDocs и packageContext как доказательную базу, а не как декоративные поля.',
  'Не дублируй программные мелочи без пользы для вывода.',
  'Реестр не суммируется как первичный документ.',
  'Если есть акт о неготовности места или ветка 70/30, это ограничение сценария, а не автоматический провал текущей оплаты.',
  'Если договор относится к мебели / оснащению / оборудованию, отдельно оцени комплектность по качеству, паспортам, гарантии, сборке и вводу.',
  'Если различие только между полным и сокращённым названием организации при совпадающем ИНН — не делай из этого сильное нарушение.',
  'Верни ТОЛЬКО минифицированный JSON:',
  '{"rekvizity":{"supplierInnConsistent":true,"buyerInnConsistent":true,"supplierNameConsistent":true,"inconsistencies":[]},"unreadableData":[],"violations":[{"severity":"critical|significant|minor","category":"суммы|реквизиты|хронология|наименования|страна|комплектность|качество|прочее","docName":"","text":""}],"conclusion":"","actionRequired":["..."]}',
].join("\n");

// ── Вспомогательная: собрать текст файлов из списка ─────────────────────────
function buildFilesText(fileList) {
  return fileList.map(f => {
    const block = buildContentBlock(f);
    if (block.type === 'text') return block.text;
    if (block.type === 'storage_url') return '=== ' + block.title + ' ===\n[URL для нативного чтения: ' + block.url + ']';
    if (block.type === 'image_base64') return '=== ' + (block.title || 'Изображение') + ' ===\n[изображение, base64]';
    return '=== ' + (block.title || 'Документ') + ' ===\n[бинарный документ, ' + (block.media_type || '') + ']';
  }).join('\n\n---\n\n');
}

async function analyzePackage(files, onProgress, extraInstructions, userPatternsPrompt) {
  console.log('[main] analyzePackage MODULAR SINGLE');

  const zoneGroups = { 1: [], 2: [], 3: [], 4: [] };
  files.forEach(f => (zoneGroups[f.zone] = zoneGroups[f.zone] || []).push(f));

  const extraNote = extraInstructions ? '\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n' + extraInstructions : '';
  const patternsNote = userPatternsPrompt ? '\nПАТТЕРНЫ ПОЛЬЗОВАТЕЛЯ:\n' + userPatternsPrompt : '';

  const zone3All = zoneGroups[3] || [];
  const registryFiles = zone3All.filter(f => isRegistryDocType(f.type, f.name));
  const primaryFiles = zone3All.filter(f => !isRegistryDocType(f.type, f.name));
  const extraFiles = zoneGroups[4] || [];

  const paymentText = buildFilesText(zoneGroups[1] || []);
  const contractText = buildFilesText(zoneGroups[2] || []);
  const primaryText = buildFilesText(primaryFiles);
  const registryText = buildFilesText(registryFiles);
  const extraText = buildFilesText(extraFiles);
  const contractContext = contractText ? 'КОНТЕКСТ ДОГОВОРА ДЛЯ СВЕРКИ:\n' + contractText.slice(0, 8000) : '';

  onProgress?.('Шаг A: документ на оплату и договор...');
  const rawA = await callAI({
    messages: [{ role: 'user', content:
      'Извлеки данные из документа на оплату и договора. Верни ТОЛЬКО минифицированный JSON.\n\n' +
      PROMPT_PAYMENT + '\n\n' +
      '=== ЗОНА 1 — Документ на оплату ===\n' + (paymentText || '(не загружен)') + '\n\n' +
      '=== ЗОНА 2 — Договор и ТЗ ===\n' + (contractText || '(не загружен)') +
      extraNote + patternsNote
    }],
    maxTokens: 24000,
    onProgress,
  });
  const dataA = extractJSON(rawA) || {};

  let registryItems = [];
  if (registryFiles.length) {
    onProgress?.('Шаг B: строки реестра...');
    const rawB = await callAI({
      messages: [{ role: 'user', content:
        'Извлеки все строки сводного реестра. Верни ТОЛЬКО минифицированный JSON.\n\n' +
        PROMPT_REGISTRY + '\n\n' + registryText
      }],
      maxTokens: 16000,
      onProgress,
    });
    const dataB = extractJSON(rawB) || {};
    registryItems = dataB.registryItems || [];
  }

  onProgress?.('Шаг C: первичные документы...');
  const rawC = await callAI({
    messages: [{ role: 'user', content:
      'Извлеки данные из первичных документов. Верни ТОЛЬКО минифицированный JSON.\n\n' +
      PROMPT_PRIMARY + '\n\n' +
      (contractContext ? contractContext + '\n\n' : '') +
      '=== ПЕРВИЧНЫЕ ДОКУМЕНТЫ ===\n' + (primaryText || '(не загружено)') +
      extraNote
    }],
    maxTokens: 48000,
    onProgress,
  });
  const dataC = extractJSON(rawC) || {};

  let dataE = { extraDocs: [], chronology: [] };
  if (extraFiles.length) {
    onProgress?.('Шаг D: дополнительные документы...');
    const rawE = await callAI({
      messages: [{ role: 'user', content:
        'Извлеки факты из дополнительных документов зоны 4. Верни ТОЛЬКО минифицированный JSON.\n\n' +
        PROMPT_EXTRA + '\n\n' +
        (contractContext ? contractContext + '\n\n' : '') +
        '=== ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ (ЗОНА 4) ===\n' + (extraText || '(не загружено)') +
        extraNote + patternsNote
      }],
      maxTokens: 32000,
      onProgress,
    });
    dataE = extractJSON(rawE) || { extraDocs: [], chronology: [] };
  }

  const normalized = {
    paymentDoc: dataA.paymentDoc || null,
    contract: dataA.contract || null,
    primaryDocs: dataC.primaryDocs || [],
    extraDocs: mergeExtraDocs(dataE.extraDocs || []),
    aggregate: null,
    chronology: [...(dataC.chronology || []), ...(dataE.chronology || [])],
    rekvizity: null,
    violations: [],
    conclusion: '',
    actionRequired: [],
    unreadableData: [],
    registryItems,
  };

  normalized.packageContext = derivePackageContext(normalized, files);
  if (normalized.primaryDocs.length > 0) {
    const recalc = recalcAggregate(normalized.primaryDocs);
    if (recalc) normalized.aggregate = recalc;
  }

  onProgress?.('Шаг E: смысловые нарушения...');
  const reasoningPayload = buildReasoningPayload(normalized, []);
  const rawIssues = await callAI({
    messages: [{ role: 'user', content: JSON.stringify(reasoningPayload) }],
    system: PROMPT_ISSUES,
    maxTokens: 12000,
    onProgress,
  });
  const dataIssues = extractJSON(rawIssues) || {};

  normalized.rekvizity = dataIssues.rekvizity || null;
  normalized.violations = dataIssues.violations || [];
  normalized.conclusion = dataIssues.conclusion || '';
  normalized.actionRequired = dataIssues.actionRequired || [];
  normalized.unreadableData = dataIssues.unreadableData || [];

  const issues = programmaticCheck(normalized, files);
  return { data: normalized, issues, rawText: [rawA, rawC, JSON.stringify(dataE || {}), rawIssues].filter(Boolean).join('\n\n---\n\n') };
}

// ════════════════════════════════════════════════════════════════════════
// ГИБРИДНЫЙ АНАЛИЗ: одиночный вызов или разбивка по размеру пакета
// ════════════════════════════════════════════════════════════════════════

/** Порог входящих токенов — выше него включается режим разбивки.
 *  DeepSeek-V4-Flash через Яндекс Cloud: 1M контекст, 393K output.
 *  Но на реальном nginx слишком большие единые вызовы часто дают 504,
 *  поэтому переключаемся в split-режим заметно раньше. */
const SINGLE_CALL_TOKEN_THRESHOLD = 40000;
const SINGLE_CALL_FILE_THRESHOLD = 12;
const CHARS_PER_TOKEN = 4;
const MONEY_TOLERANCE_STR = '0.005';
const CRITICAL_MONEY_DIFF_STR = '0.01';

function estimatePackageTokens(files) {
  // Считаем только textContent — base64 не передаётся в промпт как текст,
  // это бинарные данные для PHP-парсера. Учёт base64 завышал оценку в 100+ раз.
  return files.reduce((sum, f) => {
    const chars = (f.textContent || '').length;
    return sum + Math.ceil(chars / CHARS_PER_TOKEN);
  }, 0);
}

/**
 * Разбивает зону 3 на батчи ~6 000 токенов.
 * Договор передаётся в каждый батч как контекст для сверки.
 * Вызовы: A (оплата+договор+доп), B (реестр), C×N (батчи первички), D (нарушения).
 */
async function analyzePackageSplit(files, onProgress, extraInstructions, userPatternsPrompt) {
  console.log('[main] analyzePackage SPLIT MODE (modular)');

  const zoneGroups = { 1: [], 2: [], 3: [], 4: [] };
  files.forEach(f => (zoneGroups[f.zone] = zoneGroups[f.zone] || []).push(f));

  const zone3All = zoneGroups[3] || [];
  const registryFiles = zone3All.filter(f => isRegistryDocType(f.type, f.name));
  const primaryFiles = zone3All.filter(f => !isRegistryDocType(f.type, f.name));
  const extraFiles = zoneGroups[4] || [];

  const paymentText = buildFilesText(zoneGroups[1] || []);
  const contractText = buildFilesText(zoneGroups[2] || []);
  const registryText = buildFilesText(registryFiles);
  const extraText = buildFilesText(extraFiles);
  const extraNote = extraInstructions ? '\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n' + extraInstructions : '';
  const patternsNote = userPatternsPrompt ? '\nПАТТЕРНЫ ПОЛЬЗОВАТЕЛЯ:\n' + userPatternsPrompt : '';
  const contractContext = contractText ? 'КОНТЕКСТ ДОГОВОРА ДЛЯ СВЕРКИ:\n' + contractText.slice(0, 8000) : '';

  onProgress?.('Шаг A: документ на оплату и договор...');
  const rawA = await callAI({
    messages: [{ role: 'user', content:
      'Извлеки данные из документа на оплату и договора. Верни ТОЛЬКО минифицированный JSON.\n\n' +
      PROMPT_PAYMENT + '\n\n' +
      '=== ЗОНА 1 — Документ на оплату ===\n' + (paymentText || '(не загружен)') + '\n\n' +
      '=== ЗОНА 2 — Договор и ТЗ ===\n' + (contractText || '(не загружен)') +
      extraNote + patternsNote
    }],
    maxTokens: 24000,
    onProgress,
  });
  const dataA = extractJSON(rawA) || {};

  let registryItems = [];
  if (registryFiles.length > 0) {
    onProgress?.('Шаг B: строки реестра...');
    const rawB = await callAI({
      messages: [{ role: 'user', content:
        'Извлеки ВСЕ строки из сводного реестра накладных. Верни ТОЛЬКО минифицированный JSON.\n\n' +
        PROMPT_REGISTRY + '\n\n' + registryText
      }],
      maxTokens: 16000,
      onProgress,
    });
    const dataB = extractJSON(rawB) || {};
    registryItems = dataB.registryItems || [];
  }

  const BATCH_TOKEN_LIMIT = 6000;
  const batches = [];
  let currentBatch = [], currentTokens = 0;
  for (const f of primaryFiles) {
    const fTokens = Math.ceil((f.textContent || '').length / CHARS_PER_TOKEN);
    if (currentBatch.length > 0 && currentTokens + fTokens > BATCH_TOKEN_LIMIT) {
      batches.push(currentBatch);
      currentBatch = [f];
      currentTokens = fTokens;
    } else {
      currentBatch.push(f);
      currentTokens += fTokens;
    }
  }
  if (currentBatch.length) batches.push(currentBatch);

  const allPrimaryDocs = [];
  const allChronology = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    onProgress?.('Шаг C' + (i + 1) + '/' + batches.length + ': первичные документы...');
    const batchText = buildFilesText(batch);
    const rawC = await callAI({
      messages: [{ role: 'user', content:
        'Извлеки данные из первичных документов. Верни ТОЛЬКО минифицированный JSON.\n\n' +
        PROMPT_PRIMARY + '\n\n' +
        (contractContext ? contractContext + '\n\n' : '') +
        '=== ПЕРВИЧНЫЕ ДОКУМЕНТЫ (батч ' + (i + 1) + '/' + batches.length + ') ===\n' + batchText +
        extraNote
      }],
      maxTokens: 32000,
      onProgress,
    });
    const dataC = extractJSON(rawC) || {};
    allPrimaryDocs.push(...(dataC.primaryDocs || []));
    allChronology.push(...(dataC.chronology || []));
  }

  let extraDocs = [];
  let extraChronology = [];
  if (extraFiles.length) {
    onProgress?.('Шаг D: дополнительные документы...');
    const rawE = await callAI({
      messages: [{ role: 'user', content:
        'Извлеки факты из дополнительных документов зоны 4. Верни ТОЛЬКО минифицированный JSON.\n\n' +
        PROMPT_EXTRA + '\n\n' +
        (contractContext ? contractContext + '\n\n' : '') +
        '=== ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ (ЗОНА 4) ===\n' + (extraText || '(не загружено)') +
        extraNote + patternsNote
      }],
      maxTokens: 32000,
      onProgress,
    });
    const dataE = extractJSON(rawE) || { extraDocs: [], chronology: [] };
    extraDocs = mergeExtraDocs(dataE.extraDocs || []);
    extraChronology = dataE.chronology || [];
  }

  const normalized = {
    paymentDoc: dataA.paymentDoc || null,
    contract: dataA.contract || null,
    primaryDocs: allPrimaryDocs,
    extraDocs,
    aggregate: recalcAggregate(allPrimaryDocs) || null,
    chronology: [...allChronology, ...extraChronology],
    rekvizity: null,
    violations: [],
    conclusion: '',
    actionRequired: [],
    unreadableData: [],
    registryItems,
  };
  normalized.packageContext = derivePackageContext(normalized, files);

  onProgress?.('Шаг E: смысловые нарушения...');
  const reasoningPayload = buildReasoningPayload(normalized, []);
  const rawIssues = await callAI({
    messages: [{ role: 'user', content: JSON.stringify(reasoningPayload) }],
    system: PROMPT_ISSUES,
    maxTokens: 12000,
    onProgress,
  });
  const dataIssues = extractJSON(rawIssues) || {};

  normalized.rekvizity = dataIssues.rekvizity || null;
  normalized.violations = dataIssues.violations || [];
  normalized.conclusion = dataIssues.conclusion || '';
  normalized.actionRequired = dataIssues.actionRequired || [];
  normalized.unreadableData = dataIssues.unreadableData || [];

  const issues = programmaticCheck(normalized, files);
  return { data: normalized, issues, rawText: [rawA, JSON.stringify(extraDocs || []), rawIssues].filter(Boolean).join('\n\n---\n\n') };
}

function programmaticCheck(data, files) {
  const issues = [...(data.violations || [])];
  const push = (category, severity, text) => {
    const dup = issues.some(i => i.text && i.text.includes(text.slice(0, 40)));
    if (!dup) issues.push({ category, severity, text });
  };
  const moneyMismatch = (a, b) => !decimalWithinTolerance(a, b, MONEY_TOLERANCE_STR);
  const qtyMismatch = (a, b) => !decimalWithinTolerance(a, b, '0');
  const checkLineMoney = (docLabel, item, rowIndex) => {
    if (!item || !item.qty || !item.price) return;
    const expectedNoVat = decimalMultiplyStrings(item.qty, item.price);
    if (hasMoneyValue(item.amountNoVat) && moneyMismatch(item.amountNoVat, expectedNoVat)) {
      if (canExplainByHiddenUnitPrecision(item)) {
        console.log('[arith] hidden price precision accepted:', docLabel, item.name || '', item.price, '→', item.amountNoVat, '/', item.qty);
      } else {
        const diff = decimalAbsDiffString(item.amountNoVat, expectedNoVat);
        push('Арифметика', 'critical',
          docLabel + ', строка ' + rowIndex + ' «' + (item.name || '') + '»: ' +
          fmtNum(item.qty) + ' × ' + fmtNum(item.price) + ' = ' + fmtNum(expectedNoVat) +
          ', указано без НДС ' + fmtNum(item.amountNoVat) +
          ' (расхождение ' + fmtNum(diff) + ' руб., допустимо не более ' + MONEY_TOLERANCE_STR + ' руб.)');
      }
    }
    if (hasMoneyValue(item.amountNoVat) && hasMoneyValue(item.vat) && hasMoneyValue(item.amountWithVat)) {
      const expectedWithVat = decimalAddStrings(item.amountNoVat, item.vat);
      if (moneyMismatch(item.amountWithVat, expectedWithVat)) {
        const diff = decimalAbsDiffString(item.amountWithVat, expectedWithVat);
        push('НДС', 'critical',
          docLabel + ', строка ' + rowIndex + ' «' + (item.name || '') + '»: ' +
          'без НДС ' + fmtNum(item.amountNoVat) + ' + НДС ' + fmtNum(item.vat) +
          ' = ' + fmtNum(expectedWithVat) + ', указано с НДС ' + fmtNum(item.amountWithVat) +
          ' (расхождение ' + fmtNum(diff) + ' руб.)');
      }
    }
    const vatFraction = parseVatRateToFraction(item.vatRate);
    if (vatFraction && hasMoneyValue(item.amountNoVat) && hasMoneyValue(item.vat)) {
      const expectedVat = decimalMultiplyStrings(item.amountNoVat, vatFraction);
      if (moneyMismatch(item.vat, expectedVat)) {
        const diff = decimalAbsDiffString(item.vat, expectedVat);
        push('НДС', 'critical',
          docLabel + ', строка ' + rowIndex + ' «' + (item.name || '') + '»: ' +
          'НДС по ставке ' + (item.vatRate || 'не указана') + ' должен быть ' + fmtNum(expectedVat) +
          ', указано ' + fmtNum(item.vat) + ' (расхождение ' + fmtNum(diff) + ' руб.)');
      }
    }
  };

  const pd        = data.paymentDoc;
  const allPrimaries = data.primaryDocs || [];
  // Реестры отделяем: они не суммируются, но проверяются отдельно
  const registries = allPrimaries.filter(p => isRegistryDocType(p.docType, p.name));
  const primaries  = allPrimaries.filter(p => !isRegistryDocType(p.docType, p.name));
  const extras    = data.extraDocs   || [];
  const contract  = data.contract    || {};
  const packageContext = data.packageContext || derivePackageContext(data, files);

  applyPackageContextRules(data, packageContext, push);

  // ── Фильтр ложных Alice-violations про qty (реестр посчитан как первичный) ──
  // Если JS не видит расхождения qty (считая только реальные первичные без реестров) —
  // удаляем Alice-нарушения про «суммарное количество первичных документов».
  if (registries.length > 0) {
    const jsQty = sumFieldExact(primaries.map(p => p.total || {}), 'qty');
    const pdQty = pd?.total?.qty || '0';
    const jsQtyMismatch = hasMoneyValue(pdQty) && hasMoneyValue(jsQty) && qtyMismatch(pdQty, jsQty);
    if (!jsQtyMismatch) {
      for (let i = issues.length - 1; i >= 0; i--) {
        const t = (issues[i].text || '').toLowerCase();
        if (/суммарное|первичн.*кол|кол.*первичн|по\s+\d+\s+документ/.test(t) &&
            /≠|не соответствует|расхожден|не совпад/.test(t)) {
          console.log('[main] Удалено ложное qty-нарушение (реестр):', issues[i].text.slice(0, 80));
          issues.splice(i, 1);
        }
      }
    }
    // Также удаляем Alice-нарушения про «не представлен в пакете» из реестра
    // (это ложные нарушения когда Alice читает строки товаров реестра как имена документов)
    for (let i = issues.length - 1; i >= 0; i--) {
      const t = (issues[i].text || '').toLowerCase();
      if (/реестр.*строка|строка.*реестр/.test(t) && /не представлен|не загружен|отсутствует в пакете/.test(t)) {
        console.log('[main] Удалено ложное Alice-нарушение про строку реестра:', issues[i].text.slice(0, 80));
        issues.splice(i, 1);
      }
    }
  }

  if (pd?.items?.length) {
    pd.items.forEach((item, i) => {
      checkLineMoney('Документ на оплату', item, i + 1);
    });
  }

  // Дополнительная проверка: если в документе на оплату qty×price не сходится ни для одной строки,
  // но сходится при перестановке — фиксируем как critical (AI перепутал строки)
  if (pd?.items?.length >= 2) {
    const badRows = pd.items.filter(it => it.qty && it.price && it.amountNoVat &&
      moneyMismatch(it.amountNoVat, decimalMultiplyStrings(it.qty, it.price)));
    if (badRows.length === pd.items.length) {
      // Все строки не сходятся — скорее всего перепутаны цены
      push('Арифметика', 'critical',
        'В документе на оплату арифметика не сходится НИ В ОДНОЙ строке — возможно, AI перепутал цены между позициями. ' +
        'Проверьте вручную: ' +
        pd.items.map(it => '«' + (it.name || '').slice(0, 30) + '» qty=' + it.qty + ' × price=' + it.price + ' ≠ ' + it.amountNoVat).join('; '));
    }
  }

  primaries.forEach(doc => {
    (doc.items || []).forEach((item, i) => {
      checkLineMoney('«' + (doc.name || '') + '»', item, i + 1);
    });
  });

  if (pd?.total && primaries.length > 0) {
    const primQty = sumFieldExact(primaries.map(p => p.total || {}), 'qty');
    const pdQty   = pd.total.qty || '0';
    const qtyDiff = decimalAbsDiffString(pdQty, primQty);
    if (hasMoneyValue(pdQty) && hasMoneyValue(primQty) && qtyMismatch(pdQty, primQty)) {
      push('Количество', 'critical',
        'Суммарное количество в первичных документах (' + fmtNum(primQty) + ' шт. по ' + primaries.length + ' документам) \u2260 документу на оплату (' +
        fmtNum(pdQty) + ' шт.). Не подтверждено первичными: ' + fmtNum(qtyDiff) + ' шт.');
    }
    if (!qtyMismatch(pdQty, primQty)) {
      const primTotal = sumFieldExact(primaries.map(p => p.total || {}), 'amountWithVat');
      const pdTotal   = pd.total.amountWithVat || '0';
      if (hasMoneyValue(pdTotal) && hasMoneyValue(primTotal)) {
        const diff = decimalAbsDiffString(pdTotal, primTotal);
        if (moneyMismatch(pdTotal, primTotal)) {
          push('Сверка с УПД', 'critical',
            'Итоговая сумма первичных документов с НДС (' + fmtNum(primTotal) + ' руб.) \u2260 документу на оплату (' +
            fmtNum(pdTotal) + ' руб.). Расхождение: ' + fmtNum(diff) + ' руб. Допустимо не более ' + MONEY_TOLERANCE_STR + ' руб.; 0,01 руб. — блокирующая ошибка.');
        }
      }
    }
  }

  if (pd?.inn_supplier && contract?.inn_supplier) {
    const a = normalizeINN(pd.inn_supplier), b = normalizeINN(contract.inn_supplier);
    if (a && b && a !== b) push('Реквизиты', 'critical', 'ИНН поставщика в документе на оплату (' + a + ') ≠ договору (' + b + ')');
  }

  // Хронология: нарушение только если первичный документ датирован ПОЗЖЕ документа на оплату.
  // НОРМАЛЬНО: первичные документы (накладные, УПД-поставки) датированы РАНЬШЕ — так и должно быть.
  if (pd?.date) {
    const pdDate = parseRuDate(pd.date);
    primaries.forEach(p => {
      const pDate = parseRuDate(p.date);
      if (pDate && pdDate && pDate > pdDate) {
        push('хронология', 'critical', 'Дата «' + (p.name || '') + '» (' + p.date + ') позже даты документа на оплату (' + pd.date + ') — нарушение хронологии');
      }
    });
  }

  extras.filter(e => {
    const dt = (e.docType || '').toLowerCase();
    return dt.includes('сертификат') || dt.includes('деклараци');
  }).forEach(cert => {
    const validUntil = parseRuDate(cert.expiryDate || cert.valid_until);
    if (validUntil && validUntil < new Date()) {
      push('сертификаты', 'critical', 'Срок действия «' + (cert.name || '') + '» истёк ' + (cert.expiryDate || cert.valid_until));
    }
  });

  const commissionActs = [...primaries, ...extras].filter(e => {
    const dt = (e.docType || '').toLowerCase();
    const nm = (e.name || '').toLowerCase();
    return dt.includes('commissioning') || /акт комиссии|акт приёмки|акт приемки|комиссионн/.test(nm);
  });
  commissionActs.forEach(act => {
    const actQty = act.total?.qty || act.qty || sumFieldExact(act.items || [], 'qty');
    const pdQty  = pd?.total?.qty || '0';
    if (hasMoneyValue(actQty) && hasMoneyValue(pdQty) && qtyMismatch(actQty, pdQty)) {
      push('Акт комиссии', decimalGt(pdQty, actQty) ? 'significant' : 'minor',
        'Акт комиссии «' + (act.name || '') + '» подтверждает приёмку ' + fmtNum(actQty) +
        ' шт., тогда как документ на оплату — ' + fmtNum(pdQty) + ' шт. Расхождение: ' + fmtNum(decimalAbsDiffString(pdQty, actQty)) + ' шт.');
    }
  });

  const warrantyDocs = extras.filter(e => {
    const dt = (e.docType || '').toLowerCase();
    return dt.includes('warranty') || /гарантийн/.test((e.name || '').toLowerCase());
  });
  warrantyDocs.forEach(w => {
    const wQty  = w.total?.qty || w.qty || sumFieldExact(w.items || [], 'qty');
    const pdQty = pd?.total?.qty || '0';
    if (hasMoneyValue(wQty) && hasMoneyValue(pdQty) && qtyMismatch(wQty, pdQty)) {
      push('Гарантийный талон', 'significant',
        'Гарантийный талон «' + (w.name || '') + '» выписан на ' + fmtNum(wQty) +
        ' шт., тогда как документ на оплату — на ' + fmtNum(pdQty) + ' шт. Расхождение: ' + fmtNum(decimalAbsDiffString(wQty, pdQty)) + ' шт.');
    }
  });

  if (data.unreadableData?.length) {
    data.unreadableData.forEach(u => {
      // Пропускаем пустые записи (без имени документа, локации и описания)
      if (!u.docName && !u.location && !u.description) return;
      const _desc = [u.docName, u.location, u.description].filter(Boolean).join(' ');
      if (_desc.trim().length < 3) return;
      push('прочее', 'minor', 'Нечитаемые данные в «' + (u.docName || '') + '» (' + (u.location || '') + '): ' + (u.description || ''));
    });
  }

  if (data.rekvizity?.inconsistencies?.length) {
    data.rekvizity.inconsistencies.forEach(inc => { push('реквизиты', 'significant', inc); });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // СВЕРКА АКТА ПЕРЕИМЕНОВАНИЯ
  // ══════════════════════════════════════════════════════════════════════════
  const renameActs = extras.filter(e => {
    const dt = (e.docType || '').toLowerCase();
    const nm = (e.name  || '').toLowerCase();
    return dt === 'rename_act' || dt.includes('переименован') ||
           nm.includes('переименован') || nm.includes('перевод наименован');
  });

  if (renameActs.length > 0) {
    // Собираем ВСЕ наименования из всех документов пакета (кроме самого акта)
    const allDocNames = [];

    // Из документа на оплату
    (pd?.items || []).forEach(it => { if (it.name) allDocNames.push({ src: pd?.name || 'УПД', name: it.name }); });

    // Из первичных документов
    primaries.forEach(doc => {
      (doc.items || []).forEach(it => { if (it.name) allDocNames.push({ src: doc.name || '', name: it.name }); });
    });

    // Из договора
    if (contract?.items?.length) {
      contract.items.forEach(it => { if (it.name) allDocNames.push({ src: 'Договор', name: it.name }); });
    }

    // Нормализация для нечёткого сравнения: нижний регистр, убираем знаки препинания
    const normName = s => String(s || '').toLowerCase()
      .replace(/[,\.;:\-\(\)«»"']/g, ' ')
      .replace(/\s+/g, ' ').trim();

    // sigWords используется только в fallback-извлечении (не в namesMatch)
    const sigWords = s => s.split(' ').filter(w => w.length > 4);

    /**
     * Сравниваем два наименования: точное совпадение до символа.
     * Игнорируем только регистр и множественные пробелы.
     *
     * Примеры:
     *   «стол зеленый 212/3476» vs «стол зеленый 212/3476» → true ✅
     *   «стол зеленый 212/3476» vs «стол зеленый»           → false ✅
     *   «стол зеленый с тремя ножками 212/3476» vs «стол зеленый с тремя ножками» → false ✅
     *   «стул зеленый с тремя ножками» vs «стол зеленый с тремя ножками» → false ✅
     */
    const namesMatch = (a, b) => {
      // Точное совпадение до символа.
      // Игнорируем только: регистр букв и множественные пробелы (в т.ч. ведущие/хвостовые).
      // Все остальные символы — скобки, цифры, знаки препинания — учитываются.
      const norm = s => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
      const na = norm(a), nb = norm(b);
      if (!na || !nb) return false;
      return na === nb;
    };

    renameActs.forEach(act => {
      // Извлекаем варианты наименований из акта переименования
      const actNames = [];

      // Из items акта
      (act.items || []).forEach(it => {
        if (it.name)         actNames.push(it.name);
        if (it.nameOld)      actNames.push(it.nameOld);
        if (it.nameNew)      actNames.push(it.nameNew);
        if (it.nameTz)       actNames.push(it.nameTz);
        if (it.nameUpd)      actNames.push(it.nameUpd);
        if (it.nameContract) actNames.push(it.nameContract);
      });

      // Если productName есть на уровне акта
      if (act.productName) actNames.push(act.productName);

      // ── РАСШИРЕННЫЙ FALLBACK: если AI не заполнил items[], ищем наименования
      // в других полях extraDoc (issues, name, textContent XLSX/PDF) ──────────
      if (!actNames.length) {
        // 1. Из поля issues[] — AI часто пишет наименования в замечания
        (act.issues || []).forEach(iss => {
          const m = String(iss).match(/(?:наименование|по\s+тз|по\s+договору|в\s+упд|в\s+торг)[:\s]+([^;,\n]{5,80})/i);
          if (m) actNames.push(m[1].trim());
        });

        // 2. Из поля name акта — «Акт переименования: OldName → NewName»
        const actNameStr = act.name || '';
        const arrowMatch = actNameStr.match(/[:\s]+(.+?)\s*[→\->]+\s*(.+)/);
        if (arrowMatch) {
          actNames.push(arrowMatch[1].trim());
          actNames.push(arrowMatch[2].trim());
        }

        // 3. Из textContent файла (XLSX/PDF) — парсим строки таблицы
        const actFile = (files || []).find(f =>
          (f.name || '').toLowerCase().includes('переименован') ||
          (f.name || '').toLowerCase().includes('перевод') ||
          f.type === 'rename_act'
        );
        if (actFile?.textContent) {
          const lines = actFile.textContent.split(/[\n\r]+/);
          lines.forEach(line => {
            const cols = line.split(/[\t,;|]/).map(c => c.trim()).filter(c => c.length > 15);
            cols.forEach(col => {
              // Только строки с кириллицей, не числа, не заголовки таблицы
              if (/[а-яёА-ЯЁ]{4,}/.test(col) && !/^\d/.test(col) &&
                  !/итого|всего|наименование|кол-во|цена|сумма|ед\.?\s*изм/i.test(col)) {
                actNames.push(col);
              }
            });
          });
        }
      }

      // Дедупликация
      const uniqueActNames = [...new Set(actNames.filter(Boolean))];

      if (!uniqueActNames.length) {
        // Акт есть, но AI не извлёк наименования — предупреждаем
        push('Акт переименования', 'minor',
          'Акт переименования «' + (act.name || '') + '» загружен, но наименования из него не удалось извлечь. ' +
          'Проверьте документ вручную.');
        return;
      }

      // Ищем совпадения с другими документами
      const matchedPairs = []; // { actName, docName, src }
      const unmatchedActNames = [];

      uniqueActNames.forEach(actName => {
        const matched = allDocNames.filter(d => namesMatch(actName, d.name));
        if (matched.length > 0) {
          matched.forEach(m => matchedPairs.push({ actName, docName: m.name, src: m.src }));
        } else {
          unmatchedActNames.push(actName);
        }
      });

      // Сохраняем результат в акте для отображения в таблице
      act._renameCheck = {
        actNames: uniqueActNames,
        matchedPairs,
        unmatchedActNames,
      };

      if (matchedPairs.length > 0) {
        push('Акт переименования', 'minor',
          '✅ Акт переименования «' + (act.name || '') + '»: наименования совпадают с документами пакета');
      } else {
        // Нет ни одного совпадения — значительное нарушение
        push('Акт переименования', 'significant',
          'Акт переименования «' + (act.name || '') + '»: ни одно наименование из акта не найдено в других документах. ' +
          'Варианты в акте: ' + uniqueActNames.map(n => '«' + n + '»').join(', '));
      }

      // Проверяем расхождение цен в акте переименования vs УПД.
      // Цена в акте переименования — это цена С НДС (итоговая стоимость единицы).
      // Сравниваем с amountWithVat ИЛИ с price из УПД — принимаем совпадение с любым.
      // Нарушение только если НЕ совпадает НИ с ценой без НДС, НИ с ценой с НДС.
      (act.items || []).forEach(it => {
        const actPrice = it.price || it.priceWithVat || it.priceContract || '0';
        if (!hasMoneyValue(actPrice)) return;
        const itName = it.name || it.nameNew || it.nameUpd || '';
        // Ищем соответствующий товар в УПД по совпадению имени
        (pd?.items || []).forEach(pdIt => {
          if (!namesMatch(itName, pdIt.name || '')) return;
          const pdPriceWithVat = pdIt.amountWithVat || '0';
          const pdPriceNoVat   = pdIt.price || pdIt.amountNoVat || '0';
          const matchWithVat   = hasMoneyValue(pdPriceWithVat) && decimalWithinTolerance(actPrice, pdPriceWithVat, MONEY_TOLERANCE_STR);
          const matchNoVat     = hasMoneyValue(pdPriceNoVat) && decimalWithinTolerance(actPrice, pdPriceNoVat, MONEY_TOLERANCE_STR);
          if (!matchWithVat && !matchNoVat && hasMoneyValue(pdPriceWithVat)) {
            push('Акт переименования', 'critical',
              'Расхождение цен в акте переименования: «' + itName.slice(0, 50) + '» — ' +
              'цена в акте: ' + fmtNum(actPrice) + ' руб., в УПД без НДС: ' + fmtNum(pdPriceNoVat) + ' руб., с НДС: ' + fmtNum(pdPriceWithVat) + ' руб.');
          }
        });
      });
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // СВЕРКА РЕЕСТРА НАКЛАДНЫХ С ЗАГРУЖЕННЫМИ ДОКУМЕНТАМИ (по номерам накладных)
  // ══════════════════════════════════════════════════════════════════════════
  const registryItems = data.registryItems || [];

  // Fallback: если Alice не вернула data.registryItems отдельно,
  // извлекаем строки из primaryDocs[registry].items[] (каждая строка = накладная)
  let effectiveRegistryItems = registryItems;
  if (!effectiveRegistryItems.length && registries.length > 0) {
    const regItems = [];
    registries.forEach(reg => {
      (reg.items || []).forEach(item => {
        const wn = normalizeWaybillNum(item.waybillNum || item.num_doc || '');
        if (wn) {
          regItems.push({
            num: item.num || regItems.length + 1,
            waybillNum: wn,
            waybillDate: item.waybillDate || item.date || '',
            recipientName: item.name || item.recipientName || '',
            recipientInn: item.recipientInn || '',
            qty: item.qty || 0,
            price: item.price || 0,
            amount: item.amount || item.amountWithVat || item.total || 0,
          });
        }
      });
    });
    if (regItems.length > 0) {
      effectiveRegistryItems = regItems;
      console.log('[main] Fallback: извлечено', regItems.length, 'строк реестра из registry.items[]');
    }
  }

  if (effectiveRegistryItems.length > 0) {
    console.log('[main] Сверка реестра: строк в реестре =', effectiveRegistryItems.length, '| накладных в пакете =', primaries.length);

    // Карта загруженных накладных по нормализованному номеру
    const uploadedByNum = new Map();
    primaries.forEach(doc => {
      let num = normalizeWaybillNum(doc.waybillNum || '');
      if (!num) num = extractWaybillNumFromName(doc.name || '');
      if (num) { uploadedByNum.set(num, doc); console.log('[main] Накладная:', num, '←', doc.name); }
    });

    // Карта строк реестра по номеру накладной
    const registryByNum = new Map();
    effectiveRegistryItems.forEach(ri => {
      const num = normalizeWaybillNum(ri.waybillNum || '');
      if (num) registryByNum.set(num, ri);
    });

    // A. Строки реестра → ищем в пакете
    const missingFromPackage = [];
    effectiveRegistryItems.forEach(ri => {
      const num = normalizeWaybillNum(ri.waybillNum || '');
      if (num && !uploadedByNum.has(num)) missingFromPackage.push({ num, ri });
    });

    // B. Загруженные накладные → ищем в реестре
    const notInRegistry = [];
    uploadedByNum.forEach((doc, num) => { if (!registryByNum.has(num)) notInRegistry.push({ num, doc }); });

    if (missingFromPackage.length > 0) {
      if (missingFromPackage.length <= 5) {
        missingFromPackage.forEach(({ num, ri }) => {
          push('Реестр', 'critical', 'Накладная № ' + num + ' из реестра (' + (ri.recipientName ? ri.recipientName.slice(0, 50) : 'получатель не указан') + ') не загружена в пакет документов');
        });
      } else {
        const nums = missingFromPackage.slice(0, 10).map(x => x.num).join(', ');
        push('Реестр', 'critical', 'В реестре указано ' + registryItems.length + ' накладных, загружено только ' + uploadedByNum.size + '. Не загружены: ' + nums + (missingFromPackage.length > 10 ? ' и ещё ' + (missingFromPackage.length - 10) : ''));
      }
    }

    if (notInRegistry.length > 0 && notInRegistry.length <= 5) {
      notInRegistry.forEach(({ num, doc }) => {
        push('Реестр', 'significant', 'Накладная № ' + num + ' («' + (doc.name || '').slice(0, 60) + '») загружена, но отсутствует в реестре');
      });
    } else if (notInRegistry.length > 5) {
      push('Реестр', 'significant', notInRegistry.length + ' загруженных накладных не найдены в реестре: ' + notInRegistry.slice(0, 5).map(x => x.num).join(', ') + ' и др.');
    }

    // C. Сверяем данные совпадающих пар
    uploadedByNum.forEach((doc, num) => {
      const ri = registryByNum.get(num);
      if (!ri) return;
      const docInn = normalizeINN(doc.recipientInn || '');
      const regInn = normalizeINN(String(ri.recipientInn || '').split('/')[0]);
      if (docInn && regInn && docInn !== regInn)
        push('Реестр', 'significant', 'Накладная № ' + num + ': ИНН получателя в документе (' + docInn + ') ≠ реестру (' + regInn + ', ' + (ri.recipientName || '') + ')');
      const docQty = doc.total?.qty || '0';
      const regQty = ri.qty || '0';
      if (hasMoneyValue(docQty) && hasMoneyValue(regQty) && qtyMismatch(docQty, regQty))
        push('Реестр', 'significant', 'Накладная № ' + num + ' (' + (ri.recipientName || '').slice(0, 40) + '): кол-во в документе (' + fmtNum(docQty) + ' шт.) ≠ реестру (' + fmtNum(regQty) + ' шт.)');
      const docAmount = doc.total?.amountWithVat || doc.total?.amountNoVat || '0';
      const regAmount = ri.amount || '0';
      if (hasMoneyValue(docAmount) && hasMoneyValue(regAmount) && moneyMismatch(docAmount, regAmount))
        push('Реестр', 'significant', 'Накладная № ' + num + ' (' + (ri.recipientName || '').slice(0, 40) + '): сумма в документе (' + fmtNum(docAmount) + ' руб.) ≠ реестру (' + fmtNum(regAmount) + ' руб.)');
    });

    // Итоговое qty реестра vs УПД
    const regTotalQty = effectiveRegistryItems.reduce((s, ri) => decimalAddStrings(s, ri.qty), '0');
    const pdQtyVal = pd?.total?.qty || '0';
    if (hasMoneyValue(regTotalQty) && hasMoneyValue(pdQtyVal) && qtyMismatch(regTotalQty, pdQtyVal))
      push('Реестр', 'significant', 'Итоговое количество в реестре (' + fmtNum(regTotalQty) + ' шт.) ≠ документу на оплату (' + fmtNum(pdQtyVal) + ' шт.). Расхождение: ' + fmtNum(decimalAbsDiffString(regTotalQty, pdQtyVal)) + ' шт.');

    data._registryCheck = { registryCount: effectiveRegistryItems.length, uploadedCount: uploadedByNum.size, missingFromPackage: missingFromPackage.length, notInRegistry: notInRegistry.length, regTotalQty };
  } else if (registries.length > 0 && effectiveRegistryItems.length === 0) {
    // Реестр загружен, но Alice AI не вернула registryItems —
    // не генерируем ложные нарушения по items реестра (items = товарные позиции, не имена документов)
    console.log('[main] Реестр загружен, но registryItems не извлечены Alice AI. Сверка по номерам накладных невозможна.');
  }

  return pruneLowValueIssues(data, issues);
}

function buildConclusionText(data, issues) {
  const crit = issues.filter(i => i.severity === 'critical');
  const sig  = issues.filter(i => i.severity === 'significant');
  const min  = issues.filter(i => i.severity === 'minor');
  const ctx  = data?.packageContext || {};
  const profile = data?._reportProfile || {};
  const expectedDocs = (ctx.expectedDocs || []).map(expectedDocLabel);
  const missingDocs = (ctx.missingDocs || []).map(expectedDocLabel);

  const scenarioLine = ctx.closureScenario === 'partial_readiness'
    ? 'Пакет выглядит как частичный сценарий закрытия: в составе найден акт о неготовности места эксплуатации, поэтому пакет нельзя автоматически трактовать как финальное полное закрытие договора.'
    : ctx.closureScenario === 'full_closure'
      ? 'Пакет выглядит как комплект на полное закрытие договора и должен подтверждать не только поставку, но и завершающие этапы исполнения обязательств.'
      : 'Пакет выглядит как комплект по обычной поставке без явно подтвержденного финального этапа исполнения сверх поставки.';
  const contractProfileLine = ctx.isFurnitureEquipment
    ? 'По признакам договора это поставка мебели / оснащения / оборудования, где для содержательного вывода важны не только накладные, но и документы по сборке, вводу, качеству, паспортам и гарантии.'
    : 'По доступным данным договор не выглядит явно специализированным под поставку мебели/оснащения, поэтому вывод строится по общим правилам сверки и комплектности.';

  let verdict = 'УСЛОВНО ГОТОВ';
  if (crit.length > 0) verdict = 'НЕ ГОТОВ';
  else if (sig.length === 0 && profile.paymentReady === 'likely') verdict = 'ГОТОВ';

  let text = '';
  text += '## Сценарий пакета\n\n';
  text += scenarioLine + '\n\n';
  text += contractProfileLine + '\n\n';

  text += '## Комплектность\n\n';
  text += '- Документ на оплату: ' + (data?.paymentDoc ? 'есть' : 'не найден') + '\n';
  text += '- Первичные документы: ' + ((data?.primaryDocs || []).filter(d => !isRegistryDocType(d.docType, d.name)).length) + '\n';
  text += '- Реестр: ' + (ctx.hasRegistryDoc ? 'есть' : 'не найден') + '\n';
  text += '- Дополнительные документы: ' + ((data?.extraDocs || []).length) + '\n';
  if (expectedDocs.length) text += '- Ожидаемые подтверждающие документы по сценарию: ' + expectedDocs.join(', ') + '\n';
  if (missingDocs.length) text += '- Не хватает по сценарию: ' + missingDocs.join(', ') + '\n';
  if (ctx.hasCommissioningByContract) {
    text += '- По договору прослеживаются этапы после поставки (сборка / расстановка / ввод в эксплуатацию): ' + (ctx.hasCommissioningDoc ? 'подтверждены документально' : 'подтверждение в пакете неполное') + '\n';
  }
  if (ctx.requiresQualityDocs) {
    text += '- Документы качества / безопасности: ' + (ctx.hasQualityDoc ? 'найдены в пакете' : 'не подтверждены комплектом документов') + '\n';
  }
  if (ctx.requiresPassportDocs) {
    text += '- Паспорта / руководства / формуляры: ' + (ctx.hasPassportDoc ? 'найдены' : 'не найдены') + '\n';
  }
  if (ctx.requiresWarrantyDocs) {
    text += '- Гарантийные документы: ' + (ctx.hasWarrantyDoc ? 'найдены' : 'не найдены') + '\n';
  }
  if (ctx.hasExecutionAct) text += '- Итоговый акт исполнения обязательств: найден\n';
  else if (ctx.closureScenario === 'full_closure') text += '- Итоговый акт исполнения обязательств: не найден\n';
  text += '\n';

  text += '## Критические нарушения\n\n';
  if (crit.length) crit.forEach(v => { text += '- ' + v.text + '\n'; });
  else text += '- Критические нарушения по текущим данным не выявлены.\n';
  text += '\n';

  text += '## Существенные риски\n\n';
  if (sig.length) sig.forEach(v => { text += '- ' + v.text + '\n'; });
  else text += '- Существенные риски, требующие обязательной доработки пакета, не выявлены.\n';
  text += '\n';

  text += '## Формальные / второстепенные замечания\n\n';
  if (min.length) min.forEach(v => { text += '- ' + v.text + '\n'; });
  else text += '- Формальные замечания отсутствуют либо не влияют на вывод по оплате.\n';
  text += '\n';

  text += '## Итоговый вердикт\n\n';
  text += verdict + ' — ';
  if (verdict === 'НЕ ГОТОВ') {
    text += 'пакет содержит блокирующие расхождения или не подтверждает безопасное закрытие обязательств.\n\n';
  } else if (verdict === 'ГОТОВ') {
    text += 'существенных препятствий для оплаты по текущим данным не выявлено.\n\n';
  } else {
    text += 'пакет может требовать уточнения сценария закрытия и/или добора подтверждающих документов перед чистым финальным закрытием.\n\n';
  }

  text += '## Что исправить\n\n';
  const actions = [...(data?.actionRequired || [])];
  if (!actions.length) {
    if (crit.length || sig.length) {
      actions.push('Проверить и исправить все критические и существенные замечания из разделов выше.');
    }
    if (ctx.closureScenario === 'partial_readiness') {
      actions.push('Уточнить, что пакет относится к частичному этапу закрытия, и не смешивать его с финальным закрытием по договору.');
    }
    if (missingDocs.length) {
      actions.push('Дособрать недостающие документы по сценарию закрытия: ' + missingDocs.join(', ') + '.');
    }
    if (ctx.hasCommissioningByContract && !ctx.hasCommissioningDoc && !ctx.hasReadinessAct) {
      actions.push('Добавить документы, подтверждающие ввод в эксплуатацию / завершение послепоставочного этапа.');
    }
  }
  if (actions.length) actions.forEach((a, i) => { text += (i + 1) + '. ' + a + '\n'; });
  else text += '1. Дополнительных действий не требуется.\n';

  return text || 'Анализ завершён. Нарушений не выявлено.';
}

async function generateConclusion(data, issues) {
  const compactPayload = buildReasoningPayload(data, issues);

  try {
    const aiText = await callAI({
      messages: [{
        role: 'user',
        content: 'Подготовь содержательное заключение по пакету документов на основе нормализованных фактов ниже. Не переизобретай извлечение; анализируй сценарий, комплектность и риски.\n\n' + JSON.stringify(compactPayload),
      }],
      system: SYSTEM_PROMPT_REPORT,
      maxTokens: 6000,
      timeoutMs: 90000,
    });
    return aiText || buildConclusionText(data, issues);
  } catch (err) {
    console.warn('[generateConclusion] fallback:', err.message);
    return buildConclusionText(data, issues);
  }
}

function buildSummaryTableData(data) {
  if (!data) return [];
  const sections = [];
  // Хелпер: сохраняем оригинальное строковое значение из AI-ответа
  // чтобы fc() в buildReportTableHtml мог восстановить все знаки после запятой
  const origStr = v => { if (v == null) return null; return String(v); };
  if (data.paymentDoc) {
    const pd = data.paymentDoc;
    sections.push({
      kind: 'payment', label: 'Документ на оплату: ' + (pd.name || ''),
      docType: pd.docType, docDate: pd.date,
      seller: { name: pd.name_supplier, inn: pd.inn_supplier },
      buyer:  { name: pd.name_buyer,    inn: pd.inn_buyer },
      contractRef: pd.contract_ref,
      items: (pd.items || []).map(it => ({ name: it.name, unit: it.unit, qty: origStr(it.qty), price: origStr(it.price), amount: origStr(it.amountNoVat), vatRate: it.vatRate, vat_amount: origStr(it.vat), total: origStr(it.amountWithVat) })),
      totals: { amount_no_vat: pd.total?.amountNoVat, vat_amount: pd.total?.vat, amount_with_vat: pd.total?.amountWithVat, qty_total: pd.total?.qty },
      docIssues: pd.issues || [],
    });
  }
  let primaryCounter = 0;
  (data.primaryDocs || []).forEach(p => {
    const isReg = isRegistryDocType(p.docType, p.name);
    if (!isReg) primaryCounter++;
    sections.push({
      kind: isReg ? 'registry' : 'primary',
      label: (isReg ? '📊 Реестр (не суммируется): ' : 'Первичный документ ' + primaryCounter + ': ') + (p.name || ''),
      docType: p.docType, docDate: p.date, recipient: p.recipient,
      seller: {}, buyer: {},
      items: (p.items || []).map(it => ({ name: it.name, unit: it.unit, qty: origStr(it.qty), price: origStr(it.price), amount: origStr(it.amountNoVat), vatRate: it.vatRate, vat_amount: origStr(it.vat), total: origStr(it.amountWithVat) })),
      totals: { amount_no_vat: p.total?.amountNoVat, vat_amount: p.total?.vat, amount_with_vat: p.total?.amountWithVat, qty_total: p.total?.qty },
      docIssues: p.issues || [],
    });
  });
  if (data.aggregate) {
    const agg = data.aggregate;
    sections.push({
      kind: 'aggregate', label: 'По сумме первичных документов',
      items: (agg.items || []).map(it => ({ name: it.name, unit: it.unit, qty: origStr(it.qty), amount: origStr(it.amountNoVat), vat_amount: origStr(it.vat), total: origStr(it.amountWithVat) })),
      totals: { amount_no_vat: agg.total?.amountNoVat, vat_amount: agg.total?.vat, amount_with_vat: agg.total?.amountWithVat, qty_total: agg.total?.qty },
      compareWith: data.paymentDoc?.total ? { amount_no_vat: data.paymentDoc.total.amountNoVat, vat_amount: data.paymentDoc.total.vat, amount_with_vat: data.paymentDoc.total.amountWithVat } : null,
    });
  }
  (data.extraDocs || []).forEach(e => {
    sections.push({
      kind: 'extra', label: (e.name || e.docType || 'Доп. документ'),
      docType: e.docType || 'other', docDate: e.date, validUntil: e.expiryDate,
      productName: e.productName, hasStamp: e.hasStamp, hasSignature: e.hasSignature,
      matchesContract: e.matchesContract, docIssues: e.issues || [], items: e.items || [], totals: e.total || {},
      renameCheck: e._renameCheck || null,
    });
  });
  return sections;
}

// Утилиты
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function xmlEsc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function colLetter(n) {
  let s = '';
  n++;
  while (n > 0) { n--; s = String.fromCharCode(65 + (n % 26)) + s; n = Math.floor(n / 26); }
  return s;
}

function parseNum(v) {
  if (v == null || v === '') return null;
  const n = parseFloat(String(v).replace(/\s/g,'').replace(',','.'));
  return isNaN(n) ? null : n;
}

async function ensureJSZip() {
  if (window.JSZip) return window.JSZip;
  const urls = [
    './libs/jszip.min.js',
    'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
    'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
    'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  ];
  for (const url of urls) {
    try { await loadScript(url); if (window.JSZip) return window.JSZip; } catch { /* */ }
  }
  throw new Error('JSZip не удалось загрузить');
}

function extractJSON(text) {
  if (!text) return null;

  // Нормализуем переносы строк и убираем BOM
  const norm = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/^\uFEFF/, '');

  // 1. Прямой парсинг
  try { const r = JSON.parse(norm.trim()); if (r && typeof r === 'object') return r; } catch { /* */ }

  // 2. Убрать markdown-блок (``` или ```json), с закрывающим или без
  const stripped = norm
    .replace(/^\s*```+(?:json)?\s*/i, '')
    .replace(/\s*```+\s*$/i, '')
    .trim();
  try { const r = JSON.parse(stripped); if (r && typeof r === 'object') return r; } catch { /* */ }

  // 3. Найти первый { и последний }
  const start = norm.indexOf('{');
  if (start === -1) { console.warn('[extractJSON] Нет { в тексте длиной', norm.length); return null; }
  const end = norm.lastIndexOf('}');
  if (end > start) {
    const slice = norm.slice(start, end + 1);
    try { const r = JSON.parse(slice); if (r && typeof r === 'object') return r; } catch { /* */ }
    // 3b. Заменяем управляющие символы вне строк (могут ломать JSON.parse)
    try { const r = JSON.parse(sanitizeJSON(slice)); if (r && typeof r === 'object') return r; } catch { /* */ }
  }

  // 4. JSON обрезан — пытаемся починить
  const raw = (end > start ? norm.slice(start, end + 1) : norm.slice(start));
  console.warn('[extractJSON] Попытка repair, длина raw =', raw.length);
  try { const r = JSON.parse(repairTruncatedJSON(raw)); if (r && typeof r === 'object') return r; } catch { /* */ }
  try { const r = JSON.parse(repairTruncatedJSON(sanitizeJSON(raw))); if (r && typeof r === 'object') return r; } catch { /* */ }

  // 5. Ищем JSON по ключевому полю
  const jsonStart = norm.search(/\{"paymentDoc"/);
  if (jsonStart >= 0) {
    const sub = norm.slice(jsonStart);
    const subEnd = sub.lastIndexOf('}');
    if (subEnd > 0) {
      const subSlice = sub.slice(0, subEnd + 1);
      try { const r = JSON.parse(subSlice); if (r && typeof r === 'object') return r; } catch { /* */ }
      try { const r = JSON.parse(sanitizeJSON(subSlice)); if (r && typeof r === 'object') return r; } catch { /* */ }
      try { const r = JSON.parse(repairTruncatedJSON(subSlice)); if (r && typeof r === 'object') return r; } catch { /* */ }
    }
    try { const r = JSON.parse(repairTruncatedJSON(sub)); if (r && typeof r === 'object') return r; } catch { /* */ }
  }

  // 6. stripped тоже пробуем через sanitize+repair
  if (stripped !== norm) {
    try { const r = JSON.parse(sanitizeJSON(stripped)); if (r && typeof r === 'object') return r; } catch { /* */ }
    try { const r = JSON.parse(repairTruncatedJSON(sanitizeJSON(stripped))); if (r && typeof r === 'object') return r; } catch { /* */ }
  }

  console.warn('[extractJSON] Все стратегии провалились. Preview:', norm.slice(0, 200));
  return null;
}

/**
 * Заменяет управляющие символы (0x00-0x1F кроме \n \r \t) внутри JSON-строк на пробел.
 * Это исправляет "Bad control character in string" от JSON.parse.
 */
function sanitizeJSON(s) {
  let inStr = false, esc = false, result = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i], code = s.charCodeAt(i);
    if (esc) { esc = false; result += c; continue; }
    if (c === '\\' && inStr) { esc = true; result += c; continue; }
    if (c === '"') { inStr = !inStr; result += c; continue; }
    if (inStr && code < 0x20 && c !== '\n' && c !== '\r' && c !== '\t') {
      result += ' '; // заменяем управляющий символ на пробел
    } else {
      result += c;
    }
  }
  return result;
}

function repairTruncatedJSON(raw) {
  let s = raw.trimEnd();

  // Стратегия 1: найти последнюю полностью закрытую структуру
  let depth = 0, inStr = false, escape = false, lastSafe = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') { depth--; if (depth === 0) lastSafe = i + 1; }
  }
  if (lastSafe > 1) { try { JSON.parse(s.slice(0, lastSafe)); return s.slice(0, lastSafe); } catch { /* */ } }

  // Стратегия 2: закрыть незакрытую строку, обрезать по последней запятой, закрыть скобки
  inStr = false; escape = false;
  for (const c of s) {
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') inStr = !inStr;
  }
  if (inStr) s = s + '"'; // закрываем незакрытую строку

  const lastComma = s.lastIndexOf(',');
  if (lastComma > 0) s = s.slice(0, lastComma);

  const stack = [];
  inStr = false; escape = false;
  for (const c of s) {
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') stack.push('}');
    if (c === '[') stack.push(']');
    if (c === '}' || c === ']') stack.pop();
  }
  const closed = s + stack.reverse().join('');
  try { JSON.parse(closed); return closed; } catch { /* */ }

  // Стратегия 3: откатиться до последнего полного поля верхнего объекта
  const topFieldRe = /,\s*"[^"]+"\s*:/g;
  let lastMatch = null, m;
  while ((m = topFieldRe.exec(raw)) !== null) lastMatch = m;
  if (lastMatch) {
    const cut = raw.slice(0, lastMatch.index);
    const stack2 = [];
    let inStr2 = false, esc2 = false;
    for (const c of cut) {
      if (esc2) { esc2 = false; continue; }
      if (c === '\\' && inStr2) { esc2 = true; continue; }
      if (c === '"') { inStr2 = !inStr2; continue; }
      if (inStr2) continue;
      if (c === '{') stack2.push('}');
      if (c === '[') stack2.push(']');
      if (c === '}' || c === ']') stack2.pop();
    }
    const closed2 = cut + stack2.reverse().join('');
    try { JSON.parse(closed2); return closed2; } catch { /* */ }
  }

  return closed;
}

function normalizeINN(inn) {
  if (!inn) return null;
  return String(inn).replace(/[\s\-]/g, '').trim();
}

/** Определяет, является ли документ реестром по docType или имени */
function isRegistryDocType(docType, name) {
  const dt = (docType || '').toLowerCase();
  const nm = (name || '').toLowerCase();
  return dt === 'registry' || dt.includes('реестр') ||
    nm.startsWith('реестр') || nm.includes('сводный реестр') ||
    nm.includes('реестр упд') || nm.includes('реестр накладных') ||
    nm.includes('реестр актов');
}

/**
 * Нормализует ключ для сопоставления документов реестра и первичных.
 * Извлекает номер документа (цифры после №/N/УПД) и дату.
 */
function normalizeDocKey(name, date) {
  if (!name && !date) return null;
  // Пытаемся извлечь номер документа из строки вида "УПД №123 от 01.01.2025"
  const numMatch = String(name || '').match(/(?:№|#|N\s*|УПД\s*|накладная\s*|акт\s*)(\d[\d\-\/]*)/i);
  const num = numMatch ? numMatch[1].trim() : String(name || '').trim().slice(0, 30);
  const d = String(date || '').trim().slice(0, 10);
  if (!num && !d) return null;
  return (num + '|' + d).toLowerCase();
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

const _POW10_CACHE = [1n];

function pow10Big(n) {
  while (_POW10_CACHE.length <= n) {
    _POW10_CACHE.push(_POW10_CACHE[_POW10_CACHE.length - 1] * 10n);
  }
  return _POW10_CACHE[n];
}

function normalizeDecimalString(value) {
  if (value == null) return '0';
  let s = String(value).trim();
  if (!s || s === '—') return '0';
  s = s
    .replace(/\u00a0/g, '')
    .replace(/\s+/g, '')
    .replace(/,/g, '.')
    .replace(/−/g, '-')
    .replace(/[₽%]/g, '');
  if (/безндс/i.test(s)) return '0';
  const match = s.match(/^-?\d+(?:\.\d+)?$/);
  if (match) return match[0];
  const numberMatch = s.match(/-?\d+(?:\.\d+)?/);
  return numberMatch ? numberMatch[0] : '0';
}

function decimalToParts(value) {
  let s = normalizeDecimalString(value);
  let sign = 1n;
  if (s.startsWith('-')) {
    sign = -1n;
    s = s.slice(1);
  }
  const parts = s.split('.');
  const intPart = (parts[0] || '0').replace(/^0+(?=\d)/, '') || '0';
  const fracRaw = parts[1] || '';
  const fracPart = fracRaw.replace(/0+$/, '');
  const scale = fracPart.length;
  const digits = BigInt((intPart + fracPart) || '0') * sign;
  return { int: digits, scale };
}

function decimalFromParts(intValue, scale) {
  const negative = intValue < 0n;
  let digits = (negative ? -intValue : intValue).toString();
  if (scale > 0) {
    if (digits.length <= scale) digits = '0'.repeat(scale - digits.length + 1) + digits;
    const intPart = digits.slice(0, -scale) || '0';
    const fracPart = digits.slice(-scale).replace(/0+$/, '');
    return (negative ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
  }
  return (negative ? '-' : '') + digits;
}

function alignDecimalParts(a, b) {
  const pa = decimalToParts(a);
  const pb = decimalToParts(b);
  const scale = Math.max(pa.scale, pb.scale);
  const ai = pa.int * pow10Big(scale - pa.scale);
  const bi = pb.int * pow10Big(scale - pb.scale);
  return { ai, bi, scale };
}

function decimalAddStrings(a, b) {
  const { ai, bi, scale } = alignDecimalParts(a, b);
  return decimalFromParts(ai + bi, scale);
}

function decimalMultiplyStrings(a, b) {
  const pa = decimalToParts(a);
  const pb = decimalToParts(b);
  return decimalFromParts(pa.int * pb.int, pa.scale + pb.scale);
}

function decimalAbsDiffString(a, b) {
  const { ai, bi, scale } = alignDecimalParts(a, b);
  const diff = ai >= bi ? ai - bi : bi - ai;
  return decimalFromParts(diff, scale);
}

function decimalGt(a, b) {
  const { ai, bi } = alignDecimalParts(a, b);
  return ai > bi;
}

function decimalWithinTolerance(a, b, tolerance) {
  return !decimalGt(decimalAbsDiffString(a, b), tolerance);
}

function bigintAbs(v) {
  return v < 0n ? -v : v;
}

function countDisplayedDecimals(value) {
  const s = normalizeDecimalString(value);
  const idx = s.indexOf('.');
  return idx >= 0 ? s.length - idx - 1 : 0;
}

function decimalRoundString(value, decimals) {
  const safeDecimals = Math.max(0, Number(decimals) || 0);
  const parts = decimalToParts(value);
  if (safeDecimals >= parts.scale) {
    return decimalFromParts(parts.int * pow10Big(safeDecimals - parts.scale), safeDecimals);
  }
  const factor = pow10Big(parts.scale - safeDecimals);
  let q = parts.int / factor;
  const r = bigintAbs(parts.int % factor);
  if (r * 2n >= factor) q += parts.int >= 0n ? 1n : -1n;
  return decimalFromParts(q, safeDecimals);
}

function decimalDivideStrings(a, b, scale = 12) {
  const safeScale = Math.max(0, Number(scale) || 0);
  const pa = decimalToParts(a);
  const pb = decimalToParts(b);
  if (pb.int === 0n) return '0';
  const negative = (pa.int < 0n) !== (pb.int < 0n);
  const aInt = bigintAbs(pa.int);
  const bInt = bigintAbs(pb.int);
  const numerator = aInt * pow10Big(safeScale + pb.scale);
  const denominator = bInt * pow10Big(pa.scale);
  let q = numerator / denominator;
  const r = numerator % denominator;
  if (r * 2n >= denominator) q += 1n;
  return decimalFromParts(negative ? -q : q, safeScale);
}

function canExplainByHiddenUnitPrecision(item) {
  if (!item || !hasMoneyValue(item.qty) || !hasMoneyValue(item.price) || !hasMoneyValue(item.amountNoVat)) {
    return false;
  }
  const shownDecimals = countDisplayedDecimals(item.price);
  if (shownDecimals > 4) return false;
  const inferredPrice = decimalDivideStrings(item.amountNoVat, item.qty, Math.max(8, shownDecimals + 6));
  const roundedInferred = decimalRoundString(inferredPrice, shownDecimals);
  return roundedInferred === normalizeDecimalString(item.price);
}

function parseVatRateToFraction(rate) {
  const raw = String(rate || '').toLowerCase();
  if (!raw) return null;
  if (raw.includes('без')) return '0';
  const num = normalizeDecimalString(raw);
  if (!num || num === '0') return '0';
  const parts = decimalToParts(num);
  return decimalFromParts(parts.int, parts.scale + 2);
}

function sumFieldExact(items, field) {
  return (items || []).reduce((acc, item) => decimalAddStrings(acc, item?.[field]), '0');
}

function hasMoneyValue(value) {
  return normalizeDecimalString(value) !== '0';
}

function parseRuDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return new Date(y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'));
}

function fmtNum(n) {
  if (n == null || n === '') return '0';
  const src = String(n).trim();

  // Если значение пришло как JS number (из recalcAggregate/round2) — у него нет
  // исходной строки с нужной точностью. Определяем это: если src не содержит
  // пробелов-разделителей и запятых (т.е. это чистое JS-число вида "27025.63"),
  // используем фиксированные 2 знака, чтобы избежать "27025.630000000002".
  const isJsNumber = typeof n === 'number' || /^\d+(\.\d+)?$/.test(src);

  if (isJsNumber) {
    const num = Number(src);
    if (!isFinite(num)) return src;
    // round2 перед форматированием убирает float-мусор
    const rounded = Math.round(num * 100) / 100;
    return rounded.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // Строка из документа — сохраняем оригинальную точность
  const noSpaces = src.replace(/\s/g, '');
  const dotIdx   = noSpaces.lastIndexOf('.');
  const commaIdx = noSpaces.lastIndexOf(',');
  const decIdx   = Math.max(dotIdx, commaIdx);
  const srcDecimals = decIdx >= 0 ? noSpaces.length - decIdx - 1 : 0;
  const decimals = Math.max(2, Math.min(srcDecimals, 16));
  const normalized = noSpaces
    .replace(/\u00a0/g, '')
    .replace(/,/g, '.');
  const num = Number(normalized);
  if (!isFinite(num)) return src;
  return num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

/** Форматирует число с точностью из исходной строки (для таблиц сверки) */
function fmtCell(v) {
  if (v == null || v === '') return '—';
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  if (isNaN(n)) return escHtml ? escHtml(String(v)) : String(v);
  return fmtNum(v);
}

function normalizeLooseText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^a-zа-я0-9]+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function uniqueList(arr) {
  return [...new Set((arr || []).filter(Boolean))];
}

function expectedDocLabel(key) {
  return ({
    order: 'заявка / распоряжение на поставку',
    registry: 'сводный реестр накладных / актов',
    readiness: 'акт о неготовности места эксплуатации',
    commissioning: 'акт ввода в эксплуатацию / акт комиссии / акт приёмки',
    execution: 'акт об исполнении обязательств / итоговый закрывающий акт',
    quality_docs: 'документы качества / безопасности (сертификаты, декларации и т.п.)',
    passport_docs: 'паспорта / руководства / формуляры на товар',
    warranty_docs: 'гарантийные документы',
  })[key] || key;
}

function normalizeExtraDocRecord(doc) {
  const base = {
    docType: 'other',
    name: '',
    date: null,
    expiryDate: null,
    stage: 'unknown',
    documentRole: '',
    productName: null,
    qty: null,
    hasStamp: null,
    hasSignature: null,
    referencesContract: null,
    referencesInvoice: null,
    referencesPrimaryDocs: [],
    paymentImpact: 'neutral',
    finalClosureImpact: 'neutral',
    supportsPartialClosure: false,
    supportsFinalClosure: false,
    blocksFinalClosure: false,
    requiresFollowUpDocs: [],
    keyFacts: [],
    items: [],
    total: { qty: null },
    issues: [],
  };
  const merged = { ...base, ...(doc || {}) };
  merged.referencesPrimaryDocs = uniqueList(merged.referencesPrimaryDocs || []);
  merged.requiresFollowUpDocs = uniqueList(merged.requiresFollowUpDocs || []);
  merged.keyFacts = uniqueList(merged.keyFacts || []);
  merged.issues = uniqueList(merged.issues || []);
  merged.items = Array.isArray(merged.items) ? merged.items : [];
  merged.total = merged.total && typeof merged.total === 'object' ? merged.total : { qty: merged.qty ?? null };
  return merged;
}

function mergeExtraDocs(...lists) {
  const map = new Map();
  lists.flat().filter(Boolean).forEach(raw => {
    const doc = normalizeExtraDocRecord(raw);
    const key = [normalizeLooseText(doc.docType), normalizeLooseText(doc.name), doc.date || ''].join('|');
    const prev = map.get(key);
    if (!prev) {
      map.set(key, doc);
      return;
    }
    map.set(key, {
      ...prev,
      ...doc,
      referencesPrimaryDocs: uniqueList([...(prev.referencesPrimaryDocs || []), ...(doc.referencesPrimaryDocs || [])]),
      requiresFollowUpDocs: uniqueList([...(prev.requiresFollowUpDocs || []), ...(doc.requiresFollowUpDocs || [])]),
      keyFacts: uniqueList([...(prev.keyFacts || []), ...(doc.keyFacts || [])]),
      issues: uniqueList([...(prev.issues || []), ...(doc.issues || [])]),
      items: (doc.items && doc.items.length) ? doc.items : (prev.items || []),
      total: doc.total && Object.keys(doc.total).length ? doc.total : prev.total,
      supportsPartialClosure: prev.supportsPartialClosure || doc.supportsPartialClosure,
      supportsFinalClosure: prev.supportsFinalClosure || doc.supportsFinalClosure,
      blocksFinalClosure: prev.blocksFinalClosure || doc.blocksFinalClosure,
    });
  });
  return [...map.values()];
}

function buildExtraDocsDigest(data) {
  const docs = data?.extraDocs || [];
  const counts = {
    readiness: 0,
    commissioning: 0,
    execution: 0,
    inspection: 0,
    rename: 0,
    certificate: 0,
    declaration: 0,
    passport: 0,
    warranty: 0,
    claim: 0,
    memo: 0,
    other: 0,
  };
  const paymentSupports = [];
  const paymentBlocks = [];
  const closureSupports = [];
  const closureBlocks = [];
  const qualityDocs = [];
  const timelineDocs = [];

  docs.forEach(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''));
    if (/readiness_act|неготовност/.test(sig)) counts.readiness++;
    else if (/commissioning|акт комиссии|акт приемк|акт при[её]мк|экспертиз/.test(sig)) counts.commissioning++;
    else if (/execution_act|исполнени[яе] обязательств/.test(sig)) counts.execution++;
    else if (/inspection_act|акт проверк/.test(sig)) counts.inspection++;
    else if (/rename_act|переименован|перевод наименован/.test(sig)) counts.rename++;
    else if (/certificate|сертификат/.test(sig)) counts.certificate++;
    else if (/declaration|деклараци/.test(sig)) counts.declaration++;
    else if (/passport|паспорт|формуляр|руководств/.test(sig)) counts.passport++;
    else if (/warranty|гарантийн/.test(sig)) counts.warranty++;
    else if (/claim|претензи/.test(sig)) counts.claim++;
    else if (/memo|служебн|письмо|letter/.test(sig)) counts.memo++;
    else counts.other++;

    if (doc.paymentImpact === 'supports') paymentSupports.push(doc.name || doc.docType);
    if (doc.paymentImpact === 'blocks') paymentBlocks.push(doc.name || doc.docType);
    if (doc.finalClosureImpact === 'supports' || doc.supportsFinalClosure) closureSupports.push(doc.name || doc.docType);
    if (doc.finalClosureImpact === 'blocks' || doc.blocksFinalClosure) closureBlocks.push(doc.name || doc.docType);
    if (/certificate|сертификат|declaration|деклараци|passport|паспорт|warranty|гарантийн/.test(sig)) {
      qualityDocs.push(doc.name || doc.docType);
    }
    timelineDocs.push({
      name: doc.name || doc.docType,
      date: doc.date || null,
      role: doc.documentRole || '',
      stage: doc.stage || 'unknown',
    });
  });

  return {
    total: docs.length,
    counts,
    paymentSupports: uniqueList(paymentSupports),
    paymentBlocks: uniqueList(paymentBlocks),
    closureSupports: uniqueList(closureSupports),
    closureBlocks: uniqueList(closureBlocks),
    qualityDocs: uniqueList(qualityDocs),
    timelineDocs,
  };
}

function buildReasoningPayload(data, issues) {
  const extraDocs = (data?.extraDocs || []).map(doc => ({
    docType: doc.docType,
    name: doc.name,
    date: doc.date,
    stage: doc.stage,
    documentRole: doc.documentRole,
    referencesContract: doc.referencesContract,
    referencesInvoice: doc.referencesInvoice,
    referencesPrimaryDocs: doc.referencesPrimaryDocs,
    paymentImpact: doc.paymentImpact,
    finalClosureImpact: doc.finalClosureImpact,
    supportsPartialClosure: doc.supportsPartialClosure,
    supportsFinalClosure: doc.supportsFinalClosure,
    blocksFinalClosure: doc.blocksFinalClosure,
    requiresFollowUpDocs: doc.requiresFollowUpDocs,
    keyFacts: doc.keyFacts,
    issues: doc.issues,
  }));
  return {
    packageContext: data?.packageContext || null,
    reportProfile: data?._reportProfile || null,
    paymentDoc: data?.paymentDoc ? {
      name: data.paymentDoc.name,
      date: data.paymentDoc.date,
      contract_ref: data.paymentDoc.contract_ref,
      total: data.paymentDoc.total,
    } : null,
    contract: data?.contract ? {
      found: data.contract.found,
      number: data.contract.number,
      date: data.contract.date,
      deliveryDeadline: data.contract.deliveryDeadline,
    } : null,
    primaryDocs: (data?.primaryDocs || []).filter(d => !isRegistryDocType(d.docType, d.name)).map(d => ({
      docType: d.docType,
      name: d.name,
      date: d.date,
      total: d.total,
      issues: d.issues,
      waybillNum: d.waybillNum,
      recipientInn: d.recipientInn,
    })),
    registryItemsCount: (data?.registryItems || []).length,
    extraDocs,
    extraDocsDigest: buildExtraDocsDigest(data),
    unreadableData: data?.unreadableData || [],
    issues,
    actionRequired: data?.actionRequired || [],
  };
}

function stripOrgForm(name) {
  return normalizeLooseText(name)
    .replace(/\b(общество с ограниченнои ответственностью|общество с ограниченной ответственностью|ооо|акционерное общество|ао|ип|индивидуальныи предприниматель|индивидуальный предприниматель)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasKeyword(text, patterns) {
  return patterns.some(p => p.test(text));
}

function derivePackageContext(data, files) {
  const zone2 = (files || []).filter(f => f.zone === 2);
  const zone3 = (files || []).filter(f => f.zone === 3);
  const zone4 = (files || []).filter(f => f.zone === 4);
  const contractText = zone2.map(f => [f.name || '', (f.textContent || '').slice(0, 12000)].join('\n')).join('\n\n');
  const zone4Text = zone4.map(f => [f.name || '', (f.textContent || '').slice(0, 4000)].join('\n')).join('\n\n');
  const contractNormText = normalizeLooseText(contractText);
  const allText = normalizeLooseText(contractText + '\n' + zone4Text + '\n' + zone3.map(f => f.name || '').join('\n'));

  const hasReadinessAct = hasKeyword(allText, [
    /акт о неготовности места/,
    /неготовност[ьи] места/,
    /мест[ао] эксплуатации не готов/,
  ]) || (data.extraDocs || []).some(doc => (doc.docType || '') === 'readiness_act' || doc.supportsPartialClosure);
  const has7030Branch = hasKeyword(allText, [
    /70\s*%[^\d]{0,20}30\s*%/,
    /30\s*%[^\d]{0,20}70\s*%/,
    /70\/30/,
    /частичн[^\n]{0,80}оплат/,
    /после устранени[^\n]{0,80}остат[а-я]+ 30/,
  ]);
  const hasExecutionAct = hasKeyword(allText, [
    /акт об исполнении обязательств/,
    /исполнени[яе] обязательств/,
  ]) || (data.extraDocs || []).some(doc => (doc.docType || '') === 'execution_act' || doc.supportsFinalClosure);
  const hasOrderDoc = hasKeyword(allText, [
    /заявк/,
    /разнарядк/,
    /заказ[а-я]*/,
  ]);
  const requiresOrderDoc = hasKeyword(normalizeLooseText(contractText), [
    /заявк/,
    /разнарядк/,
    /по заявке/,
  ]);
  const isFurnitureEquipment = hasKeyword(contractNormText, [
    /мебел/,
    /гардероб/,
    /шкаф/,
    /стеллаж/,
    /стол/,
    /стул/,
    /модул/,
    /оборудован/,
    /оснащени/,
    /инвентар/,
  ]);
  const hasCommissioningByContract = hasKeyword(allText, [
    /ввод в эксплуатац/,
    /расстановк/,
    /сборк/,
    /монтаж/,
  ]);
  const requiresQualityDocs = hasKeyword(contractNormText, [
    /сертификат/,
    /деклараци/,
    /паспорт/,
    /руководств/,
    /формуляр/,
    /документ[^\n]{0,40}качеств/,
    /документ[^\n]{0,40}безопасност/,
    /гарантийн/,
  ]);
  const requiresPassportDocs = hasKeyword(contractNormText, [
    /паспорт/,
    /руководств/,
    /формуляр/,
  ]);
  const requiresWarrantyDocs = hasKeyword(contractNormText, [
    /гарантийн/,
    /гарантия/,
  ]);
  const requiresRegistryDoc = hasKeyword(normalizeLooseText(contractText), [
    /реестр/,
    /сводн[^\n]{0,40}реестр/,
  ]);
  const requiresExecutionAct = hasKeyword(normalizeLooseText(contractText), [
    /акт об исполнении обязательств/,
    /исполнени[яе] обязательств/,
    /итогов[^\n]{0,40}акт/,
  ]);
  const hasCommissioningDoc = (data.primaryDocs || []).some(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''));
    return /ввод в эксплуатац|акт комиссии|акт приемки|акт приёмки|commissioning/.test(sig);
  }) || (data.extraDocs || []).some(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || '') + ' ' + (doc.stage || ''));
    return /commissioning|readiness_act|execution_act/.test(sig) || doc.supportsFinalClosure;
  });
  const hasRegistryDoc = (data.primaryDocs || []).some(doc => isRegistryDocType(doc.docType, doc.name)) ||
    zone3.some(f => /реестр/.test(normalizeLooseText(f.name || '')));
  const hasClaimDoc = (data.extraDocs || []).some(doc => /претензи|claim/.test(normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''))));
  const hasRenameAct = (data.extraDocs || []).some(doc => /переименован|перевод наименован|rename_act/.test(normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''))));
  const hasCertificateDoc = (data.extraDocs || []).some(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''));
    return /сертификат|деклараци|certificate|declaration/.test(sig);
  });
  const hasPassportDoc = (data.extraDocs || []).some(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || '') + ' ' + (doc.productName || ''));
    return /паспорт|руководств|формуляр|passport/.test(sig);
  });
  const hasWarrantyDoc = (data.extraDocs || []).some(doc => {
    const sig = normalizeLooseText((doc.docType || '') + ' ' + (doc.name || ''));
    return /гарантийн|warranty/.test(sig);
  });
  const hasQualityDoc = hasCertificateDoc || hasPassportDoc || hasWarrantyDoc;

  let closureScenario = 'supply_only';
  if (hasReadinessAct || has7030Branch) closureScenario = 'partial_readiness';
  else if (hasCommissioningByContract || hasCommissioningDoc || hasExecutionAct) closureScenario = 'full_closure';

  const expectedDocs = [];
  if (requiresOrderDoc) expectedDocs.push('order');
  if (requiresRegistryDoc) expectedDocs.push('registry');
  if (closureScenario === 'partial_readiness') expectedDocs.push('readiness');
  if (hasCommissioningByContract || hasCommissioningDoc || closureScenario === 'full_closure') expectedDocs.push('commissioning');
  if (requiresExecutionAct || closureScenario === 'full_closure') expectedDocs.push('execution');
  if (requiresQualityDocs) expectedDocs.push('quality_docs');
  if (requiresPassportDocs) expectedDocs.push('passport_docs');
  if (requiresWarrantyDocs) expectedDocs.push('warranty_docs');

  const presence = {
    order: hasOrderDoc,
    registry: hasRegistryDoc,
    readiness: hasReadinessAct,
    commissioning: hasCommissioningDoc,
    execution: hasExecutionAct,
    quality_docs: hasQualityDoc,
    passport_docs: hasPassportDoc,
    warranty_docs: hasWarrantyDoc,
  };
  const missingDocs = uniqueList(expectedDocs).filter(key => !presence[key]);

  return {
    closureScenario,
    hasReadinessAct,
    has7030Branch,
    hasExecutionAct,
    hasOrderDoc,
    requiresOrderDoc,
    hasCommissioningByContract,
    hasCommissioningDoc,
    isFurnitureEquipment,
    requiresQualityDocs,
    requiresPassportDocs,
    requiresWarrantyDocs,
    hasCertificateDoc,
    hasPassportDoc,
    hasWarrantyDoc,
    hasQualityDoc,
    hasRegistryDoc,
    requiresRegistryDoc,
    requiresExecutionAct,
    hasClaimDoc,
    hasRenameAct,
    expectedDocs: uniqueList(expectedDocs),
    missingDocs,
    zone3Count: zone3.length,
    zone4Count: zone4.length,
    contractFound: !!(data.contract?.found || zone2.length),
    summary: {
      closureScenario,
      hasReadinessAct,
      has7030Branch,
      hasExecutionAct,
      hasOrderDoc,
      requiresOrderDoc,
      hasCommissioningByContract,
      hasCommissioningDoc,
      isFurnitureEquipment,
      requiresQualityDocs,
      requiresPassportDocs,
      requiresWarrantyDocs,
      hasCertificateDoc,
      hasPassportDoc,
      hasWarrantyDoc,
      hasQualityDoc,
      hasRegistryDoc,
      requiresRegistryDoc,
      requiresExecutionAct,
      hasClaimDoc,
      hasRenameAct,
      expectedDocs: uniqueList(expectedDocs),
      missingDocs,
    },
  };
}

function applyPackageContextRules(data, context, push) {
  const scenarioLabel = {
    partial_readiness: 'частичный сценарий (ветка с неготовностью места / 70-30)',
    full_closure: 'полное закрытие договора',
    supply_only: 'обычная поставка',
  }[context.closureScenario] || 'неопределённый сценарий';

  data._reportProfile = {
    scenarioLabel,
    paymentReady: 'unknown',
    expectedDocs: context.expectedDocs || [],
    missingDocs: context.missingDocs || [],
  };

  if (context.hasReadinessAct || context.has7030Branch) {
    push(
      'Сценарий закрытия',
      'significant',
      'Пакет указывает на ветку частичного закрытия (70/30 / неготовность места эксплуатации). Такой комплект нельзя автоматически трактовать как окончательное полное исполнение договора: для финального закрытия потребуется отдельное подтверждение ввода в эксплуатацию и/или итогового исполнения обязательств.'
    );
  }

  if (context.has7030Branch && !context.hasReadinessAct) {
    push(
      'Сценарий закрытия',
      'significant',
      'В договорной логике прослеживается ветка 70/30 или частичное закрытие, но в пакете не найден акт о неготовности места эксплуатации как ключевое основание для такого сценария.'
    );
  }

  if (context.requiresOrderDoc && !context.hasOrderDoc) {
    push(
      'Комплектность пакета',
      'significant',
      'По договору/сценарию ожидается заявка или распоряжение на поставку, но такой документ в пакете не найден.'
    );
  }

  if (context.requiresRegistryDoc && !context.hasRegistryDoc) {
    push(
      'Комплектность пакета',
      'significant',
      'По договору прослеживается использование сводного реестра, но сам реестр в пакете не найден.'
    );
  }

  if (context.requiresQualityDocs && !context.hasQualityDoc) {
    push(
      'Комплектность пакета',
      context.closureScenario === 'full_closure' ? 'critical' : 'significant',
      'По договору / ТЗ ожидаются документы качества и безопасности товара, но в пакете не найдено подтверждающих сертификатов, деклараций, паспортов или эквивалентных документов.'
    );
  }

  if (context.requiresPassportDocs && !context.hasPassportDoc) {
    push(
      'Комплектность пакета',
      'significant',
      'По договору / ТЗ ожидаются паспорта, руководства или формуляры на поставляемый товар, но такие документы в пакете не найдены.'
    );
  }

  if (context.requiresWarrantyDocs && !context.hasWarrantyDoc) {
    push(
      'Комплектность пакета',
      'significant',
      'По договору / ТЗ ожидаются гарантийные документы, но гарантийный талон или эквивалентное подтверждение в пакете не найдено.'
    );
  }

  if (context.hasCommissioningByContract && !context.hasCommissioningDoc && !context.hasReadinessAct) {
    push(
      'Комплектность пакета',
      'significant',
      'По договору предусмотрены действия после поставки (сборка / расстановка / ввод в эксплуатацию), но в пакете не найден акт ввода в эксплуатацию или эквивалентный документ, подтверждающий завершение этого этапа.'
    );
  }

  if (context.closureScenario === 'full_closure' && !context.hasExecutionAct) {
    push(
      'Комплектность пакета',
      'significant',
      'Пакет похож на комплект для полного закрытия договора, но не найден акт об исполнении обязательств или явный итоговый документ, подтверждающий завершение всех договорных обязательств.'
    );
  }

  if (context.isFurnitureEquipment && context.closureScenario === 'full_closure' && !context.hasCommissioningDoc && !context.hasReadinessAct) {
    push(
      'Комплектность пакета',
      'critical',
      'Для договора на оснащение / мебель финальное закрытие обычно должно подтверждаться не только поставкой, но и документом о вводе, приёмке комиссии или эквивалентным актом. В текущем пакете такого подтверждения нет.'
    );
  }

  if (context.hasCommissioningByContract && !context.hasRegistryDoc) {
    push(
      'Комплектность пакета',
      'minor',
      'В пакете не найден сводный реестр накладных/актов. Если договором предусмотрен сводный реестр как контрольный документ, комплект следует дополнить.'
    );
  }

  if (context.missingDocs?.length) {
    push(
      'Комплектность пакета',
      context.closureScenario === 'full_closure' ? 'critical' : 'significant',
      'Для выбранного сценария закрытия не хватает обязательных подтверждающих документов: ' + context.missingDocs.map(expectedDocLabel).join(', ') + '.'
    );
  }

  const criticalCount = (data.violations || []).filter(v => v.severity === 'critical').length;
  if (
    criticalCount > 0 ||
    (context.closureScenario === 'full_closure' && (context.missingDocs || []).length > 0) ||
    (context.requiresQualityDocs && !context.hasQualityDoc && context.closureScenario !== 'partial_readiness')
  ) {
    data._reportProfile.paymentReady = 'blocked';
  } else if (context.hasReadinessAct || context.has7030Branch || context.hasCommissioningByContract || (context.missingDocs || []).length > 0) {
    data._reportProfile.paymentReady = 'conditional';
  } else {
    data._reportProfile.paymentReady = 'likely';
  }
}

function pruneLowValueIssues(data, issues) {
  const supplierA = stripOrgForm(data?.paymentDoc?.name_supplier || '');
  const supplierB = stripOrgForm(data?.contract?.name_supplier || '');
  const filtered = [];

  for (const issue of issues) {
    const text = String(issue?.text || '');
    const lower = text.toLowerCase();

    const isSupplierShortNameOnly =
      /наименование поставщика/.test(lower) &&
      supplierA && supplierB && supplierA === supplierB;
    if (isSupplierShortNameOnly) continue;

    const isAggregateShortNameNoise =
      /aggregate/.test(lower) &&
      /отличается от полного наименования/.test(lower);
    if (isAggregateShortNameNoise) continue;

    filtered.push(issue);
  }

  return filtered;
}

const SYSTEM_PROMPT_REPORT = [
  'Ты готовишь итоговый отчёт по уже нормализованному пакету документов.',
  'Не повторяй JSON и не пересказывай механически все поля.',
  'Сделай именно экспертный вывод: что это за сценарий пакета, что им подтверждено, чего не хватает и что это значит для оплаты и для финального закрытия.',
  'Пиши как сильный аналитик для руководителя: коротко, по существу, без ритуальных фраз.',
  'Разводи между собой три уровня:',
  '- можно ли платить сейчас;',
  '- можно ли считать пакет достаточным только для частичного этапа;',
  '- можно ли считать договор чисто закрытым окончательно.',
  'Если есть акт о неготовности места или ветка 70/30 — прямо объясни, что это частичный сценарий, а не полное закрытие.',
  'Если договор относится к мебели / оснащению / оборудованию — отдельно оцени качество, паспорта, гарантию, сборку, ввод и итоговое исполнение.',
  'Используй extraDocs и extraDocsDigest как доказательную базу: не перечисляй документы, а объясняй их роль.',
  'Не делай сильных выводов из различий полного/сокращённого названия при совпадающем ИНН.',
  'Верни markdown строго с разделами:',
  '## Сценарий пакета',
  '## Комплектность',
  '## Критические нарушения',
  '## Существенные риски',
  '## Формальные / второстепенные замечания',
  '## Итоговый вердикт',
  '## Что исправить',
].join('\n');

// ════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 3: UI
// ════════════════════════════════════════════════════════════════════════

function escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function markdownToHtml(md) {
  if (!md) return '';
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm,'<h3 class="text-sm font-bold text-cyan-300 mt-5 mb-2 uppercase tracking-wide">$1</h3>')
    .replace(/^## (.+)$/gm,'<h2 class="text-base font-bold text-white mt-6 mb-3 border-b border-white/10 pb-2">$1</h2>')
    .replace(/^# (.+)$/gm,'<h1 class="text-lg font-bold text-cyan-400 mb-4">$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong class="text-white font-semibold">$1</strong>')
    .replace(/^(\|.+\|)$/gm, line => {
      const cells = line.split('|').slice(1,-1).map(c=>c.trim());
      if (cells.every(c=>/^[-: ]+$/.test(c))) return '';
      return '<tr>' + cells.map(c=>'<td class="px-3 py-1.5 text-xs border-b border-white/10 text-slate-200">' + c + '</td>').join('') + '</tr>';
    })
    .replace(/((<tr>.*?<\/tr>\n?)+)/gs,'<div class="overflow-x-auto my-3"><table class="w-full border-collapse"><tbody>$1</tbody></table></div>')
    .replace(/^- (.+)$/gm,'<li class="ml-4 text-sm text-slate-300 mb-1">• $1</li>')
    .replace(/^(\d+)\. (.+)$/gm,'<li class="ml-4 text-sm text-slate-300 mb-1">$1. $2</li>')
    .replace(/\n\n/g,'</p><p class="text-sm text-slate-300 mb-2">')
    .replace(/\n/g,'<br>');
}

function showToastMsg(msg, type) {
  type = type || 'info';
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.cssText = 'pointer-events:auto;background:rgba(30,42,58,0.97);border:1px solid ' +
    (type === 'error' ? 'rgba(248,113,113,0.3)' : type === 'success' ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.1)') +
    ';border-radius:0.75rem;padding:0.6rem 1rem;font-size:0.8rem;color:#e2e8f0;max-width:320px;';
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
}

function setProgress(pct, stage, detail) {
  const bar = document.getElementById('progressBar');
  const stageEl = document.getElementById('progressStageLabel');
  const detailEl = document.getElementById('progressText');
  if (bar && pct !== null) {
    bar.style.width = pct + '%';
    bar.setAttribute('aria-valuenow', pct);
  }
  if (stageEl && stage) stageEl.textContent = stage;
  if (detailEl && detail !== undefined) detailEl.textContent = detail;
}

function renderDocCards(documents) {
  const wrap = document.getElementById('docCardsWrap');
  if (!wrap) return;
  wrap.innerHTML = documents.map(doc => {
    const icon = getTypeIcon(doc.type);
    const label = getTypeLabel(doc.type);
    const zoneLabel = { 1:'Зона 1', 2:'Зона 2', 3:'Зона 3', 4:'Зона 4' }[doc.zone] || '';
    return '<div class="rounded-xl border border-white/10 bg-white/[0.03] p-3">' +
      '<div class="flex items-center gap-2 mb-1">' +
      '<span class="text-base">' + icon + '</span>' +
      '<span class="text-xs font-semibold text-white truncate">' + escHtml(doc.filename) + '</span>' +
      '<span class="ml-auto shrink-0 text-[10px] px-2 py-0.5 rounded-full bg-cyan-400/10 text-cyan-300">' + label + '</span>' +
      '</div>' +
      '<p class="text-[10px] text-slate-500">' + zoneLabel + '</p>' +
      '</div>';
  }).join('');
}

function renderSummaryTable(summaryData) {
  const wrap = document.getElementById('summaryTableWrap');
  if (!wrap || !summaryData) return;

  const COL_HEADERS = ['Наименование', 'Ед.', 'Кол-во', 'Цена', 'Без НДС', 'НДС', 'С НДС'];

  function itemRows(items) {
    return (items || []).map(it => '<tr class="border-b border-white/5">' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 min-w-[160px]">' + escHtml(it.name || '') + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-400 text-center">' + escHtml(it.unit || '') + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right">' + fmtCell(it.qty) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right">' + fmtCell(it.price) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right">' + fmtCell(it.amount) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-400 text-right">' + fmtCell(it.vat_amount) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right">' + fmtCell(it.total) + '</td>' +
      '</tr>').join('');
  }

  function totalRow(totals, highlight) {
    if (!totals) return '';
    const cls = highlight ? 'bg-white/[0.06] font-semibold' : 'bg-white/[0.03]';
    return '<tr class="' + cls + '">' +
      '<td class="px-2 py-1.5 text-xs text-slate-300 font-semibold" colspan="2">Итого</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right font-semibold">' + fmtCell(totals.qty_total) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-400"></td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right font-semibold">' + fmtCell(totals.amount_no_vat) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-400 text-right">' + fmtCell(totals.vat_amount) + '</td>' +
      '<td class="px-2 py-1.5 text-xs text-slate-200 text-right font-semibold">' + fmtCell(totals.amount_with_vat) + '</td>' +
      '</tr>';
  }

  const SECTION_COLORS = {
    payment:   'rgba(59,130,246,0.18)',
    primary:   'rgba(139,92,246,0.12)',
    registry:  'rgba(99,102,241,0.18)',
    aggregate: 'rgba(16,185,129,0.15)',
    extra:     'rgba(245,158,11,0.1)',
  };

  let html = '<div class="overflow-x-auto rounded-xl border border-white/10"><table class="w-full border-collapse text-xs" style="min-width:700px">';
  html += '<thead><tr class="bg-slate-900">' + COL_HEADERS.map(h => '<th class="px-2 py-2 text-left text-[10px] font-semibold uppercase tracking-wide text-slate-500">' + h + '</th>').join('') + '</tr></thead><tbody>';

  summaryData.forEach(section => {
    const bg = SECTION_COLORS[section.kind] || 'rgba(255,255,255,0.03)';
    const label = escHtml(section.label || '');
    const meta = [section.docDate, section.seller?.inn ? 'ИНН пост.: ' + section.seller.inn : '',
      section.buyer?.inn ? 'ИНН пок.: ' + section.buyer.inn : ''].filter(Boolean).join(' · ');

    html += '<tr style="background:' + bg + '"><td colspan="7" class="px-2 py-2 text-xs font-bold text-white border-t border-white/10">' +
      label + (meta ? '<span class="font-normal text-slate-500 ml-2 text-[10px]">' + escHtml(meta) + '</span>' : '') + '</td></tr>';

    if (section.items?.length) {
      html += itemRows(section.items);
      html += totalRow(section.totals, section.kind === 'aggregate');
    }

    if (section.kind === 'extra') {
      const extraInfo = [
        section.productName ? '📦 ' + section.productName : '',
        section.validUntil ? '⏳ До: ' + section.validUntil : '',
        section.hasStamp === false ? '⚠ Нет печати' : '',
        section.hasSignature === false ? '⚠ Нет подписи' : '',
      ].filter(Boolean).join(' · ');
      if (extraInfo) {
        html += '<tr><td colspan="7" class="px-2 py-1 text-[10px] text-slate-500">' + escHtml(extraInfo) + '</td></tr>';
      }

      // Блок акта переименования
      const rc = section.renameCheck;
      if (rc) {
        if (rc.matchedPairs.length > 0) {
          html += '<tr><td colspan="7" class="px-2 py-1.5 text-xs text-green-400 bg-green-500/[0.07]">' +
            '✅ Наименования из акта переименования совпадают с документами пакета' +
            '</td></tr>';
        }
        if (rc.unmatchedActNames.length > 0) {
          html += '<tr><td colspan="7" class="px-2 py-1.5 text-xs text-amber-400 bg-amber-500/[0.07]">' +
            '⚠ Не найдено совпадений для: ' +
            rc.unmatchedActNames.map(n => '«' + escHtml(n.slice(0, 60)) + '»').join(', ') +
            '</td></tr>';
        }
        if (rc.actNames.length > 0) {
          html += '<tr><td colspan="7" class="px-2 py-1 text-[10px] text-slate-500">' +
            '🏷 Варианты наименований в акте: ' +
            rc.actNames.map(n => escHtml(n.slice(0, 60))).join(' | ') +
            '</td></tr>';
        }
      }
    }

    if (section.compareWith && section.kind === 'aggregate') {
      const pdTotal = section.compareWith.amount_with_vat;
      const aggTotal = section.totals?.amount_with_vat;
      const diff = pdTotal && aggTotal ? decimalAbsDiffString(pdTotal, aggTotal) : null;
      const match = diff !== null && decimalWithinTolerance(pdTotal, aggTotal, MONEY_TOLERANCE_STR);
      html += '<tr style="background:' + (match ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)') + '">' +
        '<td colspan="7" class="px-2 py-1.5 text-xs ' + (match ? 'text-green-400' : 'text-red-400') + '">' +
        (match ? '✅ Суммы совпадают с документом на оплату' :
          '❌ Расхождение с документом на оплату: ' + fmtCell(diff) + ' руб.') +
        '</td></tr>';
    }

    if (section.docIssues?.length) {
      section.docIssues.forEach(issue => {
        html += '<tr><td colspan="7" class="px-2 py-1 text-[10px] text-amber-400 bg-amber-500/5">⚠ ' + escHtml(issue) + '</td></tr>';
      });
    }
    // Убрано: не показываем "нет замечаний" когда список пуст
  });

  html += '</tbody></table></div>';
  wrap.innerHTML = html;
}

function renderIssues(issues, onFeedback) {
  const listEl = document.getElementById('issuesList');
  const badgesEl = document.getElementById('issueCountBadges');
  if (!listEl) return;

  const critical    = issues.filter(i => i.severity === 'critical');
  const significant = issues.filter(i => i.severity === 'significant');
  const minor       = issues.filter(i => i.severity === 'minor');

  if (badgesEl) {
    badgesEl.innerHTML = [
      critical.length    ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">' + critical.length + ' крит.</span>' : '',
      significant.length ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">' + significant.length + ' сущ.</span>' : '',
      minor.length       ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-400">' + minor.length + ' мин.</span>' : '',
      !issues.length     ? '<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ Нарушений нет</span>' : '',
    ].join('');
  }

  if (!issues.length) {
    listEl.innerHTML = '<p class="text-xs text-green-400 py-2">✅ Программных нарушений не выявлено</p>';
    return;
  }

  function issueBlock(list, borderColor, icon, bgColor) {
    return list.map(issue => '<div class="flex gap-2 rounded-lg border ' + borderColor + ' ' + bgColor + ' px-3 py-2 mb-2 text-xs">' +
      '<span class="shrink-0 mt-0.5">' + icon + '</span>' +
      '<div class="min-w-0 flex-1"><p class="text-slate-200 break-words">' + escHtml(issue.text || '') + '</p>' +
      (issue.docName ? '<p class="text-slate-500 text-[10px] mt-0.5">' + escHtml(issue.docName) + (issue.category ? ' · ' + escHtml(issue.category) : '') + '</p>' : '') +
      (onFeedback ? '<button class="issue-feedback-btn mt-1.5 text-[10px] px-2 py-0.5 rounded border border-white/10 bg-white/5 text-slate-400 hover:text-white hover:border-white/20 hover:bg-white/10 transition" data-msg="' + escHtml(issue.text || '') + '">🐛 Сообщить об ошибке</button>' : '') +
      '</div></div>').join('');
  }

  listEl.innerHTML =
    issueBlock(critical,    'border-red-500/20',   '🔴', 'bg-red-500/[0.05]') +
    issueBlock(significant, 'border-amber-500/20', '🟠', 'bg-amber-500/[0.05]') +
    issueBlock(minor,       'border-slate-500/20', '🟡', 'bg-slate-500/[0.05]');

  if (onFeedback) {
    listEl.querySelectorAll('.issue-feedback-btn').forEach(btn => {
      btn.addEventListener('click', () => onFeedback(btn.dataset.msg || ''));
    });
  }
}

function renderChronology(chronology) {
  const wrap = $el('chronologyWrap');
  if (!wrap) return;
  const items = (chronology || []).filter(c => c.date || c.docName);
  if (!items.length) {
    wrap.innerHTML = '<div style="color:#64748b;font-size:0.8rem;padding:0.5rem 0;">Хронология не извлечена AI</div>';
    return;
  }
  let html = '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">' +
    '<thead><tr>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;width:110px;">Дата</th>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;width:200px;">Документ</th>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;">Событие / Нарушение</th>' +
    '</tr></thead><tbody>';
  items.forEach(c => {
    const hasViolation = c.violation && c.violation !== 'null' && c.violation !== null;
    const rowBg = hasViolation ? 'background:rgba(239,68,68,0.07);' : '';
    const violationHtml = hasViolation
      ? '<div style="color:#f87171;font-size:0.75rem;margin-top:0.2rem;">⚠️ ' + escHtml(c.violation) + '</div>'
      : '';
    html += '<tr style="' + rowBg + 'border-bottom:1px solid rgba(255,255,255,0.05);">' +
      '<td style="padding:0.4rem 0.6rem;white-space:nowrap;color:#e2e8f0;font-weight:' + (hasViolation ? '600' : '400') + ';">' + escHtml(c.date || '—') + '</td>' +
      '<td style="padding:0.4rem 0.6rem;color:#94a3b8;font-size:0.77rem;">' + escHtml((c.docName || '').slice(0, 60)) + '</td>' +
      '<td style="padding:0.4rem 0.6rem;">' +
        '<div style="color:#cbd5e1;">' + escHtml(c.event || '') + '</div>' + violationHtml +
      '</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ════════════════════════════════════════════════════════════════════════
// ЭКСПОРТ ОТЧЁТОВ
// ════════════════════════════════════════════════════════════════════════

// ── Строит светлую HTML-таблицу из summaryData ───────────────────
function buildReportTableHtml(summaryData) {
  if (!summaryData || !summaryData.length) return '';
  const COL_HEADERS = ['Наименование','Ед.','Кол-во','Цена','Без НДС','НДС','С НДС'];
  // fc — форматирует число с ПОЛНОЙ точностью (все знаки после запятой из источника)
  const fc = v => {
    if (v == null || v === '' || v === '—') return '';
    const s = String(v).trim();
    // Если это строка с исходной точностью — сохраняем все знаки
    const noSp = s.replace(/\s/g,'').replace(',','.');
    const n = parseFloat(noSp);
    if (isNaN(n)) return xmlEsc(s);
    // Определяем количество знаков после запятой из исходной строки
    const dotIdx = noSp.indexOf('.');
    const srcDecimals = dotIdx >= 0 ? noSp.length - dotIdx - 1 : 0;
    const decimals = Math.max(2, Math.min(srcDecimals, 16));
    return xmlEsc(n.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }));
  };
  const SBGC = { payment:'#DBEAFE', primary:'#EDE9FE', registry:'#E0E7FF', aggregate:'#D1FAE5', extra:'#FEF3C7' };
  let h = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;margin:0.75rem 0">';
  h += '<thead><tr style="background:#f1f5f9">'+COL_HEADERS.map(c=>'<th style="border:1px solid #e2e8f0;padding:0.35rem 0.5rem;text-align:left;font-weight:600">'+c+'</th>').join('')+'</tr></thead><tbody>';
  summaryData.forEach(section => {
    const bg = SBGC[section.kind]||'#f8fafc';
    const meta = [section.docDate, section.seller?.inn?'ИНН пост.: '+section.seller.inn:'', section.buyer?.inn?'ИНН пок.: '+section.buyer.inn:''].filter(Boolean).join(' · ');
    h += '<tr style="background:'+bg+'"><td colspan="7" style="border:1px solid #e2e8f0;padding:0.4rem 0.5rem;font-weight:700">'+xmlEsc(section.label||'')+(meta?' <span style="font-weight:400;color:#64748b;font-size:0.72rem">'+xmlEsc(meta)+'</span>':'')+'</td></tr>';
    (section.items||[]).forEach(it => {
      h += '<tr><td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem">'+xmlEsc(it.name||'')+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:center">'+xmlEsc(it.unit||'')+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(it.qty)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(it.price)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(it.amount)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(it.vat_amount)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(it.total)+'</td></tr>';
    });
    const t = section.totals;
    if (t && (t.qty_total != null || t.amount_no_vat != null)) {
      h += '<tr style="background:#f1f5f9;font-weight:600">'+
        '<td colspan="2" style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem">Итого</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(t.qty_total)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem"></td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(t.amount_no_vat)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(t.vat_amount)+'</td>'+
        '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:right">'+fc(t.amount_with_vat)+'</td></tr>';
    }
    if (section.kind === 'aggregate' && section.compareWith) {
      const diff = section.compareWith.amount_with_vat && section.totals?.amount_with_vat
        ? decimalAbsDiffString(section.compareWith.amount_with_vat, section.totals.amount_with_vat) : null;
      const match = diff !== null && decimalWithinTolerance(section.compareWith.amount_with_vat, section.totals.amount_with_vat, MONEY_TOLERANCE_STR);
      h += '<tr style="background:'+(match?'#D1FAE5':'#FEE2E2')+'"><td colspan="7" style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;color:'+(match?'#065F46':'#B91C1C')+'">'+
        (match?'✅ Суммы совпадают с документом на оплату':'❌ Расхождение с документом на оплату: '+fc(diff)+' руб. (допуск '+MONEY_TOLERANCE_STR+' руб.)')+'</td></tr>';
    }
    if (section.kind === 'extra') {
      const info = [section.productName?'Товар: '+section.productName:'', section.validUntil?'Действует до: '+section.validUntil:''].filter(Boolean).join(' · ');
      if (info) h += '<tr><td colspan="7" style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;color:#64748b;font-size:0.72rem">'+xmlEsc(info)+'</td></tr>';

      // Блок акта переименования в HTML-отчёте
      const rc = section.renameCheck;
      if (rc) {
        if (rc.matchedPairs.length > 0) {
          h += '<tr><td colspan="7" style="border:1px solid #e2e8f0;padding:0.35rem 0.5rem;background:#DCFCE7;font-size:0.72rem;color:#166534">' +
            '✅ Наименования из акта переименования совпадают с документами пакета' +
            '</td></tr>';
        }
        if (rc.unmatchedActNames.length > 0) {
          h += '<tr><td colspan="7" style="border:1px solid #e2e8f0;padding:0.35rem 0.5rem;background:#FEF9C3;font-size:0.72rem;color:#854D0E">' +
            '⚠ Следующие наименования из акта переименования НЕ найдены в других документах: ' +
            rc.unmatchedActNames.map(n => '«' + xmlEsc(n.slice(0, 80)) + '»').join(', ') +
            '</td></tr>';
        }
      }
    }
    (section.docIssues||[]).forEach(issue => {
      h += '<tr><td colspan="7" style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;color:#92400E;background:#FEF3C7;font-size:0.72rem">⚠ '+xmlEsc(issue)+'</td></tr>';
    });
  });
  h += '</tbody></table>';
  return h;
}

function buildIssuesHtml(issues) {
  if (!issues || !issues.length) return '<p style="color:#16a34a">✅ Программных нарушений не выявлено</p>';
  const groups = { critical:[], significant:[], minor:[] };
  issues.forEach(v => (groups[v.severity]||groups.minor).push(v));
  return [
    { key:'critical',    label:'🔴 Критические нарушения',    bg:'#FEE2E2', border:'#FCA5A5', color:'#B91C1C' },
    { key:'significant', label:'🟠 Существенные замечания',    bg:'#FEF3C7', border:'#FCD34D', color:'#92400E' },
    { key:'minor',       label:'🟡 Незначительные замечания',  bg:'#F9FAFB', border:'#E5E7EB', color:'#374151' },
  ].filter(s => groups[s.key].length).map(s =>
    '<div style="margin-bottom:1rem;background:'+s.bg+';border:1px solid '+s.border+';border-radius:6px;padding:0.75rem 1rem">'+
    '<div style="font-weight:700;margin-bottom:0.4rem;color:'+s.color+'">'+s.label+'</div>'+
    '<ul style="margin:0;padding-left:1.25rem">'+
    groups[s.key].map(v=>'<li style="margin-bottom:0.2rem;color:'+s.color+'">'+xmlEsc(v.text||'')+'</li>').join('')+
    '</ul></div>'
  ).join('');
}

function buildConclusionHtml(conclusion) {
  if (!conclusion) return '';
  // Разбиваем на секции по ## заголовкам и рендерим каждую отдельно
  const SECTION_COLORS = {
    'Заключение':                { bg:'#EDE9FE', border:'#C4B5FD', color:'#1e293b' },
    'Критические нарушения':     { bg:'#FEE2E2', border:'#FCA5A5', color:'#B91C1C' },
    'Существенные замечания':    { bg:'#FEF3C7', border:'#FCD34D', color:'#92400E' },
    'Незначительные замечания':  { bg:'#F9FAFB', border:'#E5E7EB', color:'#374151' },
    'Необходимые действия':      { bg:'#EFF6FF', border:'#BFDBFE', color:'#1e3a5f' },
  };
  const esc = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  // Разбиваем по ## заголовкам
  const parts = conclusion.split(/^## /m).filter(Boolean);
  if (!parts.length) return '<div style="background:#EDE9FE;border:1px solid #C4B5FD;border-radius:6px;padding:0.75rem 1rem">' + esc(conclusion) + '</div>';
  return parts.map(part => {
    const nlIdx = part.indexOf('\n');
    const heading = nlIdx >= 0 ? part.slice(0, nlIdx).trim() : part.trim();
    const body    = nlIdx >= 0 ? part.slice(nlIdx + 1).trim() : '';
    // Ищем подходящий стиль по ключевому слову заголовка
    const styleKey = Object.keys(SECTION_COLORS).find(k => heading.startsWith(k));
    const style = SECTION_COLORS[styleKey] || { bg:'#F8FAFC', border:'#E2E8F0', color:'#1e293b' };
    const isActions = heading.startsWith('Необходимые действия');
    const bodyHtml = body
      .replace(/^- (.+)$/gm, (_, t) => '<li style="margin-bottom:0.2rem;color:'+style.color+'">'+t+'</li>')
      .replace(/^\d+\. (.+)$/gm, (_, t) => '<li style="margin-bottom:0.2rem;color:'+style.color+'">'+t+'</li>')
      .replace(/(<li[^>]*>[\s\S]*?<\/li>\n?)+/g, m => {
        const tag = isActions ? 'ol' : 'ul';
        return '<'+tag+' style="margin:0.3rem 0 0 1.2rem;padding:0">'+m+'</'+tag+'>';
      })
      .replace(/\n\n/g, '</p><p style="margin:0.25rem 0;color:'+style.color+'">')
      .replace(/\n/g, '<br>');
    return '<div style="margin-bottom:0.75rem;background:'+style.bg+';border:1px solid '+style.border+';border-radius:6px;padding:0.6rem 0.9rem">' +
      '<div style="font-weight:700;font-size:0.88rem;margin-bottom:0.35rem;color:'+style.color+'">'+esc(heading)+'</div>' +
      (bodyHtml ? '<div style="font-size:0.82rem;color:'+style.color+'">'+bodyHtml+'</div>' : '') +
      '</div>';
  }).join('');
}

function buildChronologyHtml(chronology) {
  const items = (chronology || []).filter(c => c.date || c.docName);
  if (!items.length) return '';
  const esc = xmlEsc;
  let h = '<table style="width:100%;border-collapse:collapse;font-size:0.78rem;margin:0.5rem 0 1.5rem">';
  h += '<thead><tr style="background:#f1f5f9">' +
    '<th style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;width:110px;text-align:left;font-weight:600">Дата</th>' +
    '<th style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;width:220px;text-align:left;font-weight:600">Документ</th>' +
    '<th style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;text-align:left;font-weight:600">Событие / Нарушение</th>' +
    '</tr></thead><tbody>';
  items.forEach(c => {
    const hasV = c.violation && c.violation !== 'null' && c.violation !== null;
    const rowBg = hasV ? 'background:#FEE2E2;' : '';
    const violHtml = hasV ? '<div style="color:#B91C1C;font-size:0.72rem;margin-top:0.2rem;">⚠️ ' + esc(c.violation) + '</div>' : '';
    h += '<tr style="' + rowBg + 'border-bottom:1px solid #e2e8f0">' +
      '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;white-space:nowrap;font-weight:' + (hasV ? '700' : '400') + '">' + esc(c.date || '—') + '</td>' +
      '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem;color:#475569;font-size:0.73rem">' + esc((c.docName || '').slice(0, 70)) + '</td>' +
      '<td style="border:1px solid #e2e8f0;padding:0.3rem 0.5rem"><div style="color:#1e293b">' + esc(c.event || '') + '</div>' + violHtml + '</td></tr>';
  });
  h += '</tbody></table>';
  return h;
}

function buildReportHtml(dateStr, summaryData, issues, conclusion, modelName) {
  const modelLine = modelName ? '<p style="color:#64748b;font-size:0.8rem;margin:0 0 1.5rem">🤖 Модель: <strong>' + modelName + '</strong></p>' : '';
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8">'+
    '<title>Отчёт проверки — '+dateStr+'</title>'+
    '<style>body{font-family:Arial,sans-serif;max-width:1300px;margin:0 auto;padding:2rem;color:#1e293b;font-size:13px;background:#fff}'+
    'h1{font-size:1.2rem;font-weight:700;border-bottom:2px solid #e2e8f0;padding-bottom:0.5rem;margin-bottom:1.5rem;color:#0f172a}'+
    'h2{font-size:1rem;font-weight:700;margin:1.5rem 0 0.5rem;color:#0f172a}'+
    'p{margin:0.4rem 0;line-height:1.6}ul,ol{margin:0.3rem 0 0.3rem 1.5rem}'+
    '.btn-print{background:#0f172a;color:#fff;border:none;border-radius:6px;padding:0.5rem 1.5rem;font-size:0.85rem;cursor:pointer;margin-bottom:1rem}'+
    '@media print{.btn-print{display:none}body{padding:0.5rem}}</style></head><body>'+
    '<button class="btn-print" onclick="window.print()">🖨 Печать / Сохранить как PDF</button>'+
    '<h1>Отчёт проверки документов на оплату — '+new Date().toLocaleString('ru-RU')+'</h1>'+
    modelLine+
    '<h2>Сводная таблица сверки</h2>'+buildReportTableHtml(summaryData)+
    ((results?.rawData?.chronology?.length) ? '<h2>Хронология документов</h2>' + buildChronologyHtml(results.rawData.chronology) : '')+
    '<h2>Программные проверки</h2>'+buildIssuesHtml(issues)+
    '<h2>Заключение AI</h2>'+buildConclusionHtml(conclusion)+
    '<hr style="margin-top:2rem;border:none;border-top:1px solid #e2e8f0">'+
    '<p style="color:#94a3b8;font-size:0.72rem">Сформировано: '+new Date().toLocaleString('ru-RU')+(modelName?' · '+modelName:'')+' · mto-cto.falcon28.ru</p>'+
    '</body></html>';
}

// Скачать HTML-отчёт
async function downloadHtmlReport() {
  const btn     = document.getElementById('downloadArchiveBtn');
  const labelEl = document.getElementById('downloadArchiveBtnLabel');
  if (btn) btn.disabled = true;
  if (labelEl) labelEl.textContent = 'Подготовка...';
  try {
    const dateStr = new Date().toISOString().slice(0, 10);
    const html = buildReportHtml(dateStr, results?.summaryData||[], results?.issues||[], results?.conclusion||'', results?.modelName||'');
    const blob  = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url   = URL.createObjectURL(blob);
    const a     = document.createElement('a');
    a.href = url;
    a.download = 'Отчёт проверки — ' + dateStr + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    if (labelEl) labelEl.textContent = '✅ Скачано!';
    setTimeout(() => { if (labelEl) labelEl.textContent = '📄 HTML'; }, 2000);
  } catch (err) {
    showToastMsg('Ошибка: ' + err.message, 'error');
    if (labelEl) labelEl.textContent = '📄 HTML';
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Открыть в новом окне → Ctrl+P → PDF (берём из results, не из DOM — кнопки не попадают)
function openPdfPrint() {
  const dateStr = new Date().toISOString().slice(0, 10);
  const html = buildReportHtml(dateStr, results?.summaryData||[], results?.issues||[], results?.conclusion||'', results?.modelName||'');
  const win  = window.open('', '_blank');
  if (win) {
    win.document.write(html);
    win.document.close();
    setTimeout(() => { try { win.print(); } catch(e) { /* ignore */ } }, 800);
    showToastMsg('Нажмите Ctrl+P (или кнопку в новом окне) для сохранения в PDF', 'info');
  } else {
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = 'Отчёт — ' + dateStr + '.html';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToastMsg('Откройте скачанный файл и нажмите Ctrl+P для PDF', 'info');
  }
}

// Скачать Excel — нативный XML+JSZip (без SheetJS, как в экспертной проверке)
async function downloadExcel(res) {
  const btn = document.getElementById('downloadExcelBtn');
  if (btn) btn.disabled = true;
  try {
    const JSZip = await ensureJSZip();
    const summaryData = res?.summaryData || [];
    const issues      = res?.issues      || [];
    const reportDate  = new Date().toLocaleString('ru-RU');

    const _sst = [], _sstMap = new Map();
    function si(str) {
      const s = str == null ? '' : String(str);
      if (_sstMap.has(s)) return _sstMap.get(s);
      const idx = _sst.length; _sst.push(s); _sstMap.set(s, idx); return idx;
    }
    function sc(v, styleId) { return { v: String(v??''), t:'s', s:styleId, _si:si(String(v??'')) }; }
    function nc(v, styleId) { const n = parseNum(v); return n != null ? { v:n, t:'n', s:styleId } : sc(v, styleId); }

    const STYLES_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
      '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<fonts count="7"><font><sz val="11"/><name val="Calibri"/></font>' +
      '<font><sz val="13"/><b/><name val="Calibri"/><color rgb="FF0F172A"/></font>' +
      '<font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF1E293B"/></font>' +
      '<font><sz val="10"/><name val="Calibri"/><color rgb="FF1E293B"/></font>' +
      '<font><sz val="10"/><b/><name val="Calibri"/><color rgb="FFB91C1C"/></font>' +
      '<font><sz val="10"/><name val="Calibri"/><color rgb="FF92400E"/></font>' +
      '<font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF065F46"/></font></fonts>' +
      '<fills count="11"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFEDE9FE"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFFFF7ED"/></patternFill></fill>' +
      '<fill><patternFill patternType="solid"><fgColor rgb="FFE8F4F8"/></patternFill></fill></fills>' +
      '<borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border>' +
      '<border><left style="thin"><color rgb="FFE2E8F0"/></left><right style="thin"><color rgb="FFE2E8F0"/></right>' +
      '<top style="thin"><color rgb="FFE2E8F0"/></top><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border></borders>' +
      '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
      '<cellXfs count="15">' +
      '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
      '<xf numFmtId="0" fontId="1" fillId="10" borderId="1" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="6" borderId="1" xfId="0"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="0" borderId="1" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="4" fontId="3" fillId="0" borderId="1" xfId="0"><alignment horizontal="right" vertical="center"/></xf>' +
      '<xf numFmtId="4" fontId="2" fillId="6" borderId="1" xfId="0"><alignment horizontal="right" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="4" fillId="4" borderId="1" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="5" fillId="5" borderId="1" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="7" borderId="1" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="2" borderId="1" xfId="0"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="6" fillId="3" borderId="1" xfId="0"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="7" borderId="1" xfId="0"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="2" fillId="9" borderId="1" xfId="0"><alignment horizontal="left" vertical="center"/></xf>' +
      '<xf numFmtId="0" fontId="3" fillId="6" borderId="1" xfId="0"><alignment horizontal="center" vertical="center"/></xf>' +
      '</cellXfs></styleSheet>';

    const NUM_COLS = 7;
    const COL_NAMES = ['Наименование','Ед.','Кол-во','Цена','Без НДС','НДС','С НДС'];
    const rows1 = [], merges1 = [];
    let r1 = 0;
    function addRow1(cells) { rows1.push({ r:r1, cells:cells.map((c,i)=>({...c,c:i})) }); r1++; }
    function emptyRow1() { rows1.push({ r:r1, cells:[] }); r1++; }
    function merge1(r,c1,c2) { merges1.push([r,c1,r,c2]); }

    const titleR = r1;
    addRow1([sc('Сводная таблица сверки документов  ·  ' + reportDate + (res?.modelName ? '  ·  ' + res.modelName : ''), 1)]);
    merge1(titleR, 0, NUM_COLS-1);
    emptyRow1();

    const SSTYLE = { payment:10, aggregate:11, primary:12, registry:12, extra:13 };
    summaryData.forEach(section => {
      const sStyle = SSTYLE[section.kind] || 2;
      const meta = [section.docDate, section.seller?.inn?'ИНН пост.: '+section.seller.inn:''].filter(Boolean).join(' · ');
      const hR = r1;
      addRow1([sc((section.label||'')+(meta?'  '+meta:''), sStyle)]);
      merge1(hR, 0, NUM_COLS-1);
      if (section.items?.length) {
        addRow1(COL_NAMES.map(h=>sc(h,2)));
        section.items.forEach(it => {
          addRow1([sc(it.name||'',3), sc(it.unit||'',14), nc(it.qty,4), nc(it.price,4), nc(it.amount,4), nc(it.vat_amount,4), nc(it.total,4)]);
        });
        const t = section.totals;
        if (t && (t.qty_total != null || t.amount_no_vat != null)) {
          addRow1([sc('Итого',5), sc('',5), nc(t.qty_total,5), sc('',5), nc(t.amount_no_vat,5), nc(t.vat_amount,5), nc(t.amount_with_vat,5)]);
        }
      }
      if (section.kind === 'aggregate' && section.compareWith) {
        const diff = section.compareWith.amount_with_vat && section.totals?.amount_with_vat
          ? Math.abs(Number(section.compareWith.amount_with_vat)-Number(section.totals.amount_with_vat)) : null;
        const match = diff !== null && diff < 0.001;
        const cR = r1;
        addRow1([sc(match ? '✅ Суммы совпадают' : '❌ Расхождение: '+(diff?diff.toLocaleString('ru-RU',{minimumFractionDigits:2}):'')+' руб.', match?11:6)]);
        merge1(cR, 0, NUM_COLS-1);
      }
      (section.docIssues||[]).forEach(issue => { const iR=r1; addRow1([sc('⚠ '+issue,7)]); merge1(iR,0,NUM_COLS-1); });
      emptyRow1();
    });

    if (issues.length) {
      const vTR = r1; addRow1([sc('Нарушения и замечания',2)]); merge1(vTR,0,NUM_COLS-1);
      issues.forEach(v => {
        const sev = v.severity==='critical'?6:v.severity==='significant'?7:8;
        const prefix = v.severity==='critical'?'🔴 ':v.severity==='significant'?'🟠 ':'🟡 ';
        const vR = r1; addRow1([sc(prefix+v.text,sev)]); merge1(vR,0,NUM_COLS-1);
      });
      emptyRow1();
    }

    const rawConclusion = res?.conclusion || '';
    if (rawConclusion) {
      const cR = r1; addRow1([sc('Заключение AI',11)]); merge1(cR,0,NUM_COLS-1);
      const clean = rawConclusion.replace(/^##? .+$/gm,m=>m.replace(/^#+\s*/,'')).replace(/[🔴🟠🟡]\s*/g,'');
      const ctR = r1; addRow1([sc(clean,9)]); merge1(ctR,0,NUM_COLS-1);
    }

    const sstXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="'+_sst.length+'" uniqueCount="'+_sst.length+'">'+
      _sst.map(s=>'<si><t xml:space="preserve">'+xmlEsc(s)+'</t></si>').join('')+'</sst>';

    function sheetXml(sheetRows, sheetMerges, colWidths) {
      const colsXml = colWidths.length?'<cols>'+colWidths.map((w,i)=>'<col min="'+(i+1)+'" max="'+(i+1)+'" width="'+w+'" customWidth="1"/>').join('')+'</cols>':'';
      const mergesXml = sheetMerges.length?'<mergeCells count="'+sheetMerges.length+'">'+sheetMerges.map(([r1,c1,r2,c2])=>'<mergeCell ref="'+colLetter(c1)+(r1+1)+':'+colLetter(c2)+(r2+1)+'"/>').join('')+'</mergeCells>':'';
      const rowsXml = sheetRows.map(row => {
        if (!row.cells.length) return '<row r="'+(row.r+1)+'"></row>';
        return '<row r="'+(row.r+1)+'">'+row.cells.map(cell=>{
          const addr = colLetter(cell.c)+(row.r+1);
          if (cell.t==='n') return '<c r="'+addr+'" s="'+cell.s+'"><v>'+cell.v+'</v></c>';
          return '<c r="'+addr+'" s="'+cell.s+'" t="s"><v>'+cell._si+'</v></c>';
        }).join('')+'</row>';
      }).join('');
      return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'+colsXml+'<sheetData>'+rowsXml+'</sheetData>'+mergesXml+'</worksheet>';
    }

    const wbXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Сводная таблица" sheetId="1" r:id="rId1"/></sheets></workbook>';
    const wbRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>';
    const rootRels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>';
    const contentTypes = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>';

    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rootRels);
    zip.file('xl/workbook.xml', wbXml);
    zip.file('xl/_rels/workbook.xml.rels', wbRels);
    zip.file('xl/styles.xml', STYLES_XML);
    zip.file('xl/sharedStrings.xml', sstXml);
    zip.file('xl/worksheets/sheet1.xml', sheetXml(rows1, merges1, [42,8,12,20,20,14,20]));
    const blob = await zip.generateAsync({ type:'blob', compression:'DEFLATE', compressionOptions:{ level:6 } });
    const dateStr = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = 'Проверка — ' + dateStr + '.xlsx';
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToastMsg('✅ Excel скачан', 'success');
  } catch (err) {
    showToastMsg('Ошибка Excel: ' + err.message, 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Паттерны — хранятся на сервере в api/data/patterns.json
const PATTERNS_LS_KEY = 'dc_user_patterns_v2'; // fallback localStorage
let _userPatterns = [];

async function loadUserPatterns() {
  // Сначала пробуем загрузить с сервера
  try {
    const resp = await fetch(getProxyUrl() + '?action=get_patterns', { cache: 'no-store' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok && Array.isArray(data.patterns)) {
        _userPatterns = data.patterns;
        updatePatternsBadge();
        return;
      }
    }
  } catch { /* сервер недоступен — fallback */ }
  // Fallback: localStorage
  try {
    const raw = localStorage.getItem(PATTERNS_LS_KEY);
    if (raw) _userPatterns = JSON.parse(raw);
  } catch { _userPatterns = []; }
  updatePatternsBadge();
}

async function saveUserPatternsToServer() {
  try {
    const resp = await fetch(getProxyUrl(), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'save_patterns', patterns: _userPatterns }),
    });
    if (resp.ok) return true;
  } catch { /* fallback */ }
  // Fallback: localStorage
  try { localStorage.setItem(PATTERNS_LS_KEY, JSON.stringify(_userPatterns)); } catch { /* */ }
  return false;
}

function getUserPatternsPrompt() {
  if (!_userPatterns.length) return '';
  return _userPatterns.map((p, i) =>
    (i + 1) + '. Поле: ' + p.field + '. Было: «' + p.wrong + '». Должно быть: «' + p.correct + '».' +
    (p.context ? ' Контекст: ' + p.context : '')
  ).join('\n');
}

function updatePatternsBadge() {
  const el = document.getElementById('patternsBadge');
  if (el) el.textContent = _userPatterns.length > 0 ? String(_userPatterns.length) : '';
}

function openFeedback(issueMsg, docFiles) {
  const overlay = document.getElementById('feedbackOverlay');
  const docFileEl = document.getElementById('fbDocFile');
  if (docFileEl) docFileEl.value = docFiles || '';
  const wrongEl = document.getElementById('fbWrong');
  if (wrongEl) wrongEl.value = issueMsg.slice(0, 80);
  if (overlay) overlay.classList.remove('hidden');
}

function closeFeedback() {
  const overlay = document.getElementById('feedbackOverlay');
  if (overlay) overlay.classList.add('hidden');
}

function updatePatternPreview() {
  const wrong = document.getElementById('fbWrong')?.value.trim();
  const correct = document.getElementById('fbCorrect')?.value.trim();
  const field = document.getElementById('fbField')?.value;
  const preview = document.getElementById('fbPatternPreview');
  const jsonEl = document.getElementById('fbPatternJson');
  if (!wrong || !correct) { preview?.classList.add('hidden'); return; }
  const pattern = { field, wrong, correct, context: document.getElementById('fbContext')?.value.trim() || undefined };
  if (jsonEl) jsonEl.textContent = JSON.stringify(pattern, null, 2);
  preview?.classList.remove('hidden');
}

async function saveFeedbackPattern() {
  const wrong = document.getElementById('fbWrong')?.value.trim();
  const correct = document.getElementById('fbCorrect')?.value.trim();
  const field = document.getElementById('fbField')?.value;
  const context = document.getElementById('fbContext')?.value.trim();
  if (!wrong || !correct) { showToastMsg('Заполните поля «Было» и «Должно быть»', 'error'); return; }
  const pattern = { field, wrong, correct, context: context || undefined, ts: Date.now() };
  _userPatterns.push(pattern);
  closeFeedback();
  updatePatternsBadge();
  const saved = await saveUserPatternsToServer();
  showToastMsg(saved ? '✅ Паттерн сохранён на сервере.' : '✅ Паттерн сохранён локально (сервер недоступен).', 'success');
}

function openPatternsModal() {
  const overlay = document.getElementById('patternsOverlay');
  const wrap = document.getElementById('patternsListWrap');
  if (wrap) {
    if (!_userPatterns.length) {
      wrap.innerHTML = '<p class="text-xs text-slate-500 text-center py-4">Паттернов пока нет. Нажмите «🐛 Сообщить об ошибке» под любым нарушением.</p>';
    } else {
      wrap.innerHTML = _userPatterns.map((p, i) =>
        '<div class="flex gap-2 items-start border border-white/10 rounded-lg px-3 py-2 mb-2 text-xs">' +
        '<div class="flex-1"><span class="text-slate-500">' + p.field + '</span> · ' +
        '<span class="text-red-400">«' + escHtml(p.wrong) + '»</span> → ' +
        '<span class="text-green-400">«' + escHtml(p.correct) + '»</span>' +
        (p.context ? '<p class="text-slate-600 mt-0.5">' + escHtml(p.context) + '</p>' : '') +
        '</div>' +
        '<button class="pattern-del-btn text-slate-600 hover:text-red-400 text-sm" data-idx="' + i + '">✕</button>' +
        '</div>'
      ).join('');
      wrap.querySelectorAll('.pattern-del-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const idx = parseInt(btn.dataset.idx);
          // Пробуем удалить на сервере
          try {
            const resp = await fetch(getProxyUrl(), {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ action: 'delete_pattern', idx }),
            });
            if (resp.ok) {
              const data = await resp.json();
              if (data.ok) {
                _userPatterns = await loadPatternsFromServer();
                updatePatternsBadge();
                openPatternsModal();
                return;
              }
            }
          } catch { /* fallback */ }
          // Fallback: удаляем локально
          _userPatterns.splice(idx, 1);
          try { localStorage.setItem(PATTERNS_LS_KEY, JSON.stringify(_userPatterns)); } catch { /* */ }
          updatePatternsBadge();
          openPatternsModal();
        });
      });
    }
  }
  if (overlay) overlay.classList.remove('hidden');
}

async function loadPatternsFromServer() {
  try {
    const resp = await fetch(getProxyUrl() + '?action=get_patterns', { cache: 'no-store' });
    if (resp.ok) {
      const data = await resp.json();
      if (data.ok && Array.isArray(data.patterns)) return data.patterns;
    }
  } catch { /* */ }
  return _userPatterns;
}

async function clearUserPatterns() {
  _userPatterns = [];
  // Сохраняем пустой массив на сервере
  await saveUserPatternsToServer();
  try { localStorage.removeItem(PATTERNS_LS_KEY); } catch { /* */ }
  updatePatternsBadge();
  showToastMsg('Паттерны очищены', 'success');
  openPatternsModal();
}

// ════════════════════════════════════════════════════════════════════════
// ЧАСТЬ 4: ГЛАВНАЯ ЛОГИКА
// ════════════════════════════════════════════════════════════════════════

const zones = {
  1: { files: [], multiple: false },
  2: { files: [], multiple: true  },
  3: { files: [], multiple: true  },
  4: { files: [], multiple: true  },
};

let analyzing     = false;
let results       = null;
let fileIdCounter = 0;
let _audioCtx     = null; // создаётся при user gesture, используется позже

const MAX_MB       = 50;
const ALLOWED_EXTS = ['pdf', 'docx', 'doc', 'xlsx', 'xls', 'txt', 'csv', 'md', 'png', 'jpg', 'jpeg'];

const $el = id => document.getElementById(id);

document.addEventListener('DOMContentLoaded', () => {
  showModeIndicator();
  // Проверяем Storage при загрузке страницы (асинхронно, не блокирует UI)
  checkStorageEnabled().then(updateStorageBadge);
  [1, 2, 3, 4].forEach(z => initZone(z));
  $el('analyzeBtn').addEventListener('click', showConfirmDialog);
  loadUserPatterns();
  [1, 2, 3, 4].forEach(z => $el('fileChips' + z).addEventListener('click', onChipRemoveClick));
  $el('clearBtn').addEventListener('click', clearAll);

  // Кнопки экспорта
  $el('downloadArchiveBtn')?.addEventListener('click', () => downloadHtmlReport());
  $el('downloadPdfBtn')?.addEventListener('click', () => openPdfPrint());
  $el('downloadExcelBtn')?.addEventListener('click', () => downloadExcel(results));

  $el('reanalyzeBtn')?.addEventListener('click', () => {
    $el('resultsBlock').classList.add('hidden');
    [1, 2, 3, 4].forEach(z => {
      zones[z].files.forEach(f => { f.status = 'pending'; f.error = null; });
      renderZoneChips(z);
    });
    results = null;
    updateAnalyzeBtn();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  $el('confirmStartBtn').addEventListener('click', () => {
    $el('confirmOverlay').classList.add('hidden');
    // Создаём AudioContext прямо в обработчике клика (user gesture) — браузер разрешает
    try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { /* */ }
    runAnalysis();
  });
  $el('confirmCancelBtn').addEventListener('click', () => $el('confirmOverlay').classList.add('hidden'));
  $el('confirmOverlay').addEventListener('click', e => { if (e.target === $el('confirmOverlay')) $el('confirmOverlay').classList.add('hidden'); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      $el('confirmOverlay').classList.add('hidden');
      $el('feedbackOverlay')?.classList.add('hidden');
      $el('patternsOverlay')?.classList.add('hidden');
    }
  });
  $el('feedbackCloseBtn').addEventListener('click', closeFeedback);
  $el('feedbackCancelBtn').addEventListener('click', closeFeedback);
  $el('feedbackOverlay').addEventListener('click', e => { if (e.target === $el('feedbackOverlay')) closeFeedback(); });
  $el('feedbackSaveBtn').addEventListener('click', saveFeedbackPattern);
  [$el('fbWrong'), $el('fbCorrect'), $el('fbContext'), $el('fbField')].forEach(el => el?.addEventListener('input', updatePatternPreview));
  $el('patternsCloseBtn').addEventListener('click', () => $el('patternsOverlay').classList.add('hidden'));
  $el('patternsCloseBtnBottom').addEventListener('click', () => $el('patternsOverlay').classList.add('hidden'));
  $el('patternsOverlay').addEventListener('click', e => { if (e.target === $el('patternsOverlay')) $el('patternsOverlay').classList.add('hidden'); });
  $el('patternsClearBtn').addEventListener('click', clearUserPatterns);
  $el('showPatternsBtn')?.addEventListener('click', openPatternsModal);
});

function showModeIndicator() {
  const el = $el('modeIndicator');
  if (!el) return;
  el.innerHTML =
    '<span style="color:#34d399">🤖 Яндекс Cloud AI</span> · ' +
    '<span style="color:#fbbf24">гибридный анализ · авто-режим</span>';
  el.style.display = 'flex';
}

function initZone(z) {
  const dropArea  = $el('dropZone' + z);
  const fileInput = $el('fileInput' + z);
  dropArea.addEventListener('click', () => fileInput.click());
  dropArea.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
  dropArea.addEventListener('dragover', e => { e.preventDefault(); dropArea.classList.add('drag-over'); });
  dropArea.addEventListener('dragleave', () => dropArea.classList.remove('drag-over'));
  dropArea.addEventListener('drop', e => { e.preventDefault(); dropArea.classList.remove('drag-over'); addFiles(z, Array.from(e.dataTransfer.files)); });
  fileInput.addEventListener('change', () => { addFiles(z, Array.from(fileInput.files)); fileInput.value = ''; });
}

function addFiles(zone, files) {
  const zoneData = zones[zone];
  for (const file of files) {
    const realExt = file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(realExt)) { showToastMsg('Формат не поддерживается: ' + file.name, 'error'); continue; }
    if (file.size > MAX_MB * 1024 * 1024) { showToastMsg('Файл слишком большой (>' + MAX_MB + 'МБ): ' + file.name, 'error'); continue; }
    if (realExt === 'doc') {
      showToastMsg(
        'Файл ' + file.name + ' имеет старый формат .doc. Он может не читаться. Сохраните его как .docx или PDF.',
        'error'
      );
    }
    if (zone === 1 && zoneData.files.length >= 1) zoneData.files = [];
    const type = detectDocType(file.name, '');
    const id   = ++fileIdCounter;
    zoneData.files.push({ id, file, name: file.name, size: file.size, type, textContent: null, base64: null, mediaType: null, status: 'pending', error: null, zone, ocrApplied: false });
  }
  renderZoneChips(zone);
  updateAnalyzeBtn();
}

function removeFile(zone, id) {
  zones[zone].files = zones[zone].files.filter(f => f.id !== id);
  renderZoneChips(zone);
  updateAnalyzeBtn();
}

function clearAll() {
  [1, 2, 3, 4].forEach(z => { zones[z].files = []; renderZoneChips(z); });
  results = null;
  $el('resultsBlock').classList.add('hidden');
  $el('progressBlock').classList.add('hidden');
  updateAnalyzeBtn();
}

const STATUS_LABELS = {
  pending:   { label: 'Ожидает',   cls: 'pending'    },
  reading:   { label: 'Чтение...', cls: 'extracting' },
  ocr:       { label: '🔍 OCR...', cls: 'analyzing'  },
  analyzing: { label: 'Анализ...',  cls: 'analyzing'  },
  done:      { label: '✓ Готово',  cls: 'done'       },
  error:     { label: '✕ Ошибка', cls: 'error'      },
};

function renderZoneChips(zone) {
  const container = $el('fileChips' + zone);
  const badge     = $el('zone' + zone + 'Badge');
  const files     = zones[zone].files;
  if (!files.length) { container.innerHTML = ''; if (badge) badge.innerHTML = ''; return; }
  if (badge) badge.innerHTML = '<span class="zone-count-badge">' + files.length + ' ' + pluralFiles(files.length) + '</span>';
  container.innerHTML = files.map(f => {
    const st = STATUS_LABELS[f.status] || STATUS_LABELS.pending;
    const icon = getTypeIcon(f.type);
    const ocrBadge = f.ocrApplied ? ' <span style="font-size:0.65rem;color:#a78bfa;margin-left:4px;">OCR</span>' : '';
    return '<div class="file-chip">' +
      '<span>' + icon + '</span>' +
      '<span class="file-chip-name" title="' + escHtml(f.name) + '">' + escHtml(f.name) + ocrBadge + '</span>' +
      '<span class="file-chip-status ' + st.cls + '">' + st.label + '</span>' +
      '<button class="file-chip-remove" data-file-id="' + f.id + '" data-file-zone="' + zone +
        '" aria-label="Удалить"' + (analyzing ? ' disabled' : '') + '>✕</button>' +
      '</div>';
  }).join('');
}

function onChipRemoveClick(e) {
  const btn = e.target.closest('.file-chip-remove');
  if (!btn) return;
  removeFile(+btn.dataset.fileZone, +btn.dataset.fileId);
}

function updateAnalyzeBtn() {
  const total = allFiles().length;
  const btn = $el('analyzeBtn');
  btn.disabled = total === 0 || analyzing;
  $el('clearBtn').disabled = analyzing;
  // Кнопки экспорта: активны только если есть results
  const hasResults = !!results;
  if ($el('downloadArchiveBtn')) $el('downloadArchiveBtn').disabled = !hasResults;
  if ($el('downloadPdfBtn'))     $el('downloadPdfBtn').disabled     = !hasResults;
  if ($el('downloadExcelBtn'))   $el('downloadExcelBtn').disabled   = !hasResults;
}

function allFiles() { return [1, 2, 3, 4].flatMap(z => zones[z].files); }

function pluralFiles(n) {
  if (n % 10 === 1 && n % 100 !== 11) return 'файл';
  if ([2, 3, 4].includes(n % 10) && ![12, 13, 14].includes(n % 100)) return 'файла';
  return 'файлов';
}

function showConfirmDialog() {
  if (analyzing) return;
  const zoneLabels = { 1:'Окно 1: Документ на оплату', 2:'Окно 2: Договор/ТЗ', 3:'Окно 3: Первичка', 4:'Окно 4: Доп. документы' };
  const summaryEl = $el('confirmFilesSummary');
  summaryEl.innerHTML = [1, 2, 3, 4].map(z => {
    const files = zones[z].files;
    if (!files.length) return '';
    return '<div style="margin-bottom:0.5rem;"><span style="font-size:0.75rem;font-weight:700;color:#94a3b8;">' + zoneLabels[z] + '</span>' +
      files.map(f => '<div class="confirm-file-row"><span>' + getTypeIcon(f.type) + '</span><span>' + escHtml(f.name) + '</span></div>').join('') + '</div>';
  }).join('');
  const missing = [];
  if (!zones[1].files.length) missing.push('📄 Документ на оплату (Окно 1) — обязателен');
  if (!zones[2].files.length) missing.push('📋 Договор/ТЗ (Окно 2) — без него реквизиты не проверить');
  const warnEl = $el('confirmWarning');
  const warnings = [...missing];

  // Проверяем количество реестров
  const registryFiles = zones[3].files.filter(f => f.type === 'registry');
  if (registryFiles.length > 1) {
    warnings.push('📊 Загружено ' + registryFiles.length + ' реестра(ов) — должен быть не более одного. Лишние реестры: ' +
      registryFiles.slice(1).map(f => f.name).join(', '));
  }

  if (warnings.length) { warnEl.innerHTML = '⚠️ Внимание:<br>' + warnings.join('<br>'); warnEl.classList.remove('hidden'); }
  else { warnEl.classList.add('hidden'); }
  $el('confirmOverlay').classList.remove('hidden');
}

// OCR страницы: DeepSeek (через Object Storage URL) → fallback Yandex Vision
// handler.php при AI_PROVIDER=deepseek: PNG → Storage upload → public URL → DeepSeek image_url → delete
async function ocrPageViaServer(pngBase64) {
  console.log('[OCR] Отправляю страницу → handler.php (DeepSeek via Storage)...');
  const resp = await fetch(getProxyUrl(), {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'ocr', base64: pngBase64, mediaType: 'image/png' }),
  });
  const json = await resp.json();
  if (!resp.ok) throw new Error(json.error || 'OCR ошибка ' + resp.status);
  if (json.error) {
    console.warn('[OCR] Ошибка:', json.error);
    throw new Error('OCR: ' + json.error);
  }
  const text = json.text || '';
  const method = json.method || 'unknown';
  console.log('[OCR] Метод:', method, '| символов:', text.length);
  return text;
}

// Чтение файла: текст или OCR
async function readFileContent(f, onProgress) {
  const ft = getFileType(f.name);

  if (ft === 'xlsx') {
    const text = await extractExcelAsText(f.file);
    return { textContent: text, ocrApplied: false };
  }

  if (ft === 'txt') {
    const text = await f.file.text();
    return { textContent: text, ocrApplied: false };
  }

  if (ft === 'image') {
    const { base64 } = await fileToBase64(f.file);
    onProgress?.('OCR изображения: ' + f.name);
    const text = await ocrPageViaServer(base64);
    return { textContent: text, ocrApplied: true };
  }

  if (ft === 'pdf') {
    try {
      const pages = await extractPdfPages(f.file);
      const textParts = [];
      let ocrApplied = false;

      for (let i = 0; i < pages.length; i++) {
        const page = pages[i];
        // canvasData присутствует только если extractPdfPages определил страницу как скан
        // (менее 80 значимых букв/цифр). Используем именно этот флаг, а не повторную проверку.
        const isScanned = !!page.canvasData;

        if (!isScanned) {
          textParts.push(page.text);
        } else {
          ocrApplied = true;
          onProgress?.('OCR стр.' + (i + 1) + '/' + pages.length + ': ' + f.name);
          try {
            const canvas = document.createElement('canvas');
            await page.canvasData.render(canvas);
            const dataUrl = canvas.toDataURL('image/png');
            const pngBase64 = dataUrl.replace(/^data:image\/png;base64,/, '');
            const ocrText = await ocrPageViaServer(pngBase64);
            if (ocrText) textParts.push('[Страница ' + (i + 1) + ' (OCR)]\n' + ocrText);
          } catch (ocrErr) {
            console.warn('[OCR] Страница', i + 1, ocrErr);
            textParts.push('[Страница ' + (i + 1) + ': не удалось распознать]');
          }
        }
      }

      const combined = textParts.join('\n\n');
      if (combined.replace(/\s/g, '').length > 10) {
        return { textContent: combined, ocrApplied };
      }
    } catch (e) {
      console.warn('[PDF.js] Ошибка:', f.name, e);
    }

    // Fallback: base64 → PHP-парсер
    const { base64, mediaType } = await fileToBase64(f.file);
    return { base64, mediaType, ocrApplied: false };
  }

  // DOCX и всё остальное → base64
  const { base64, mediaType } = await fileToBase64(f.file);
  return { base64, mediaType, ocrApplied: false };
}

// Основной анализ
async function runAnalysis() {
  if (analyzing) return;
  analyzing = true;
  results   = null;
  $el('resultsBlock').classList.add('hidden');
  $el('progressBlock').classList.remove('hidden');
  updateAnalyzeBtn();
  allFiles().forEach(f => { f.status = 'pending'; f.error = null; f.ocrApplied = false; });
  [1, 2, 3, 4].forEach(z => renderZoneChips(z));

  try {
    setProgress(2, 'Проверка handler.php...', getProxyUrl());
    const handlerHealth = await testHandlerHealth();
    if (!handlerHealth.ok) {
      throw new Error(handlerHealth.error + ' · Откройте этот URL в браузере и проверьте, что он возвращает JSON.');
    }

    const files = allFiles();
    const total = files.length;

    setProgress(0, 'Шаг 1: Читаю файлы...', '0/' + total);
    let readDone = 0;

    for (const f of files) {
      f.status = 'reading';
      renderZoneChips(f.zone);
      try {
        const result = await readFileContent(f, msg => {
          f.status = 'ocr';
          renderZoneChips(f.zone);
          setProgress(null, 'Шаг 1: ' + msg, '');
        });
        f.textContent = result.textContent ?? null;
        f.base64      = result.base64      ?? null;
        f.mediaType   = result.mediaType   ?? null;
        f.ocrApplied  = result.ocrApplied  ?? false;
        f.type        = detectDocType(f.name, f.textContent || '');
        f.status      = 'analyzing';
      } catch (err) {
        f.status = 'error';
        f.error  = err.message;
        console.error('[doc-checker] Ошибка чтения:', f.name, err);
      }
      readDone++;
      setProgress(Math.round(readDone / total * 30), 'Шаг 1: Читаю файлы...', 'Прочитано ' + readDone + '/' + total + (f.ocrApplied ? ' (с OCR)' : ''));
      renderZoneChips(f.zone);
    }

    const toAnalyze = files.filter(f => f.status !== 'error');
    if (!toAnalyze.length) throw new Error('Все файлы не удалось подготовить');

    // ── Шаг 1.5: Загрузка PDF в Object Storage (если включён) ────────────────
    const storageKeys = []; // для удаления после анализа
    const storageAvailable = await checkStorageEnabled();
    if (storageAvailable) {
      const pdfFiles = toAnalyze.filter(f => getFileType(f.name) === 'pdf' && !f.textContent);
      if (pdfFiles.length > 0) {
        setProgress(32, 'Шаг 1.5: Загрузка в Object Storage...', '0/' + pdfFiles.length);
        let uploadDone = 0;
        for (const f of pdfFiles) {
          const stored = await uploadFileToStorage(f, msg => setProgress(null, 'Storage...', msg));
          if (stored) {
            f.storageUrl = stored.url;
            f.storageKey = stored.key;
            storageKeys.push(stored.key);
          }
          uploadDone++;
          setProgress(32 + Math.round(uploadDone / pdfFiles.length * 3),
            'Шаг 1.5: Object Storage...', 'Загружено ' + uploadDone + '/' + pdfFiles.length);
        }
      }
    }

    const ocrCount = toAnalyze.filter(f => f.ocrApplied).length;
    const storageCount = toAnalyze.filter(f => f.storageUrl).length;
    const ocrNote = [
      ocrCount > 0 ? ocrCount + ' через OCR' : '',
      storageCount > 0 ? storageCount + ' нативно через Storage' : '',
    ].filter(Boolean).join(', ');

    // ── Оценка размера пакета и выбор режима ─────────────────────────────
    const estimatedTokens = estimatePackageTokens(toAnalyze);
    const useSplitMode =
      estimatedTokens > SINGLE_CALL_TOKEN_THRESHOLD ||
      toAnalyze.length > SINGLE_CALL_FILE_THRESHOLD;
    const strategyLabel = useSplitMode
      ? '⚡ Режим разбивки (' + Math.round(estimatedTokens / 1000) + 'K токенов входа, ' + toAnalyze.length + ' файлов)'
      : '🔹 Единый вызов (' + Math.round(estimatedTokens / 1000) + 'K токенов входа, ' + toAnalyze.length + ' файлов)';
    console.log('[main] Оценка токенов:', estimatedTokens, '| режим:', useSplitMode ? 'SPLIT' : 'SINGLE');

    // Показываем стратегию в индикаторе
    const modeEl = $el('modeIndicator');
    if (modeEl) {
      modeEl.innerHTML =
        '<span style="color:#34d399">🤖 Яндекс Cloud AI</span> · ' +
        '<span style="color:#fbbf24">' + strategyLabel + '</span>';
    }
    // Показываем стратегию в прогресс-баре
    setProgress(35, 'Шаг 2: AI анализирует...', 'Передаю ' + toAnalyze.length + ' файл(ов)' + (ocrNote ? ' (' + ocrNote + ')' : '') + ' · ' + strategyLabel);

    const extraInstructions = $el('customPrompt')?.value?.trim() || '';

    const mappedFiles = toAnalyze.map(f => ({
      name: f.name, base64: f.base64, mediaType: f.mediaType,
      textContent: f.textContent, storageUrl: f.storageUrl || null,
      filename: f.name, zone: f.zone, type: f.type,
    }));
    const analyzeFunc = useSplitMode ? analyzePackageSplit : analyzePackage;
    const packageResult = await analyzeFunc(
      mappedFiles,
      msg => setProgress(null, 'Шаг 2: Анализ AI...', msg),
      extraInstructions,
      getUserPatternsPrompt(),
    );

    toAnalyze.forEach(f => { f.status = 'done'; });
    [1, 2, 3, 4].forEach(z => renderZoneChips(z));

    setProgress(92, 'Шаг 3: Формирую заключение...', '');
    let conclusion = '';
    try {
      conclusion = await generateConclusion(packageResult.data, packageResult.issues);
    } catch (err) {
      conclusion = packageResult.rawText || 'Не удалось получить заключение.';
    }

    setProgress(100, 'Готово!', 'Анализ завершён');

    const summaryData = buildSummaryTableData(packageResult.data);

    results = {
      issues: packageResult.issues,
      conclusion,
      rawData: packageResult.data,
      rawText: packageResult.rawText,
      summaryData,
      documents: toAnalyze.map(f => ({ filename: f.name, type: f.type, zone: f.zone, data: null })),
      modelName: 'DeepSeek-V4-Flash (Яндекс Cloud)' + (useSplitMode ? ' · режим разбивки' : ' · единый вызов'),
      reportDate: new Date().toLocaleString('ru-RU'),
    };

    // ── Звук и уведомления — СРАЗУ, пока жив user gesture chain ──────────
    // (до setTimeout — иначе браузер блокирует AudioContext и Notification)
    try {
      const ctx = _audioCtx || (() => {
        try { return new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; }
      })();
      if (ctx) {
        const playNotes = () => {
          // Rammstein-style: тяжёлое вступление — две низкие ноты + высокий акцент
          const riff = [
            { freq: 82,  start: 0,    dur: 0.18, vol: 0.35, type: 'sawtooth' },  // E2 — тяжёлый удар
            { freq: 82,  start: 0.22, dur: 0.12, vol: 0.30, type: 'sawtooth' },  // E2 — повтор
            { freq: 110, start: 0.38, dur: 0.18, vol: 0.30, type: 'sawtooth' },  // A2
            { freq: 164, start: 0.58, dur: 0.25, vol: 0.28, type: 'sawtooth' },  // E3 — подъём
            { freq: 220, start: 0.86, dur: 0.35, vol: 0.25, type: 'square'   },  // A3 — финальный акцент
          ];
          riff.forEach(({ freq, start, dur, vol, type }) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            // Дисторшн через WaveShaper
            const distortion = ctx.createWaveShaper();
            const curve = new Float32Array(256);
            for (let i = 0; i < 256; i++) {
              const x = (i * 2) / 256 - 1;
              curve[i] = (Math.PI + 200) * x / (Math.PI + 200 * Math.abs(x));
            }
            distortion.curve = curve;
            osc.connect(distortion);
            distortion.connect(gain);
            gain.connect(ctx.destination);
            osc.type = type;
            osc.frequency.value = freq;
            const t = ctx.currentTime + start;
            gain.gain.setValueAtTime(0, t);
            gain.gain.linearRampToValueAtTime(vol, t + 0.01);
            gain.gain.linearRampToValueAtTime(vol * 0.7, t + dur * 0.5);
            gain.gain.linearRampToValueAtTime(0, t + dur);
            osc.start(t);
            osc.stop(t + dur + 0.05);
          });
        };
        if (ctx.state === 'suspended') {
          ctx.resume().then(playNotes).catch(e => console.warn('[Audio] resume failed:', e));
        } else {
          playNotes();
        }
      }
    } catch (e) { console.warn('[Audio] Ошибка:', e); }

    // Браузерное уведомление — тоже до setTimeout (нужен user gesture для permission)
    const critCount = (results?.issues || []).filter(i => i.severity === 'critical').length;
    const sigCount  = (results?.issues || []).filter(i => i.severity === 'significant').length;
    const summary = critCount
      ? '🔴 ' + critCount + ' крит. · ' + sigCount + ' сущ. нарушений'
      : sigCount
        ? '🟠 ' + sigCount + ' существенных замечаний'
        : '✅ Нарушений не выявлено';
    if ('Notification' in window) {
      if (Notification.permission === 'granted') {
        new Notification('Проверка завершена', { body: summary, icon: '' });
      } else if (Notification.permission === 'default') {
        Notification.requestPermission().then(perm => {
          if (perm === 'granted') new Notification('Проверка завершена', { body: summary, icon: '' });
        });
      }
    }

    // ── Рендеринг UI — через setTimeout чтобы не блокировать поток ────────
    setTimeout(() => {
      $el('progressBlock').classList.add('hidden');
      renderResults();
      $el('resultsBlock').classList.remove('hidden');
      $el('resultsBlock').scrollIntoView({ behavior: 'smooth' });
      updateAnalyzeBtn(); // разблокировать кнопки экспорта
      // Toast-уведомление — здесь, т.к. нужен DOM
      showToastMsg('✅ Анализ завершён · ' + summary, 'success');
    }, 500);

  } catch (err) {
    setProgress(null, 'Ошибка: ' + err.message, err.message);
    console.error('[doc-checker] Критическая ошибка:', err);
    showToastMsg('Ошибка анализа: ' + err.message, 'error');
  } finally {
    analyzing = false;
    updateAnalyzeBtn();
    [1, 2, 3, 4].forEach(z => renderZoneChips(z));
    // Удаляем временные файлы из Object Storage
    if (typeof storageKeys !== 'undefined' && storageKeys.length > 0) {
      console.log('[Storage] Удаляем', storageKeys.length, 'временных файлов...');
      Promise.all(storageKeys.map(key => deleteFromStorage(key)))
        .then(() => console.log('[Storage] Все временные файлы удалены'))
        .catch(e => console.warn('[Storage] Ошибка при удалении', e));
    }
  }
}

function renderResults() {
  const { issues, conclusion, documents, summaryData, modelName, reportDate } = results;
  // Показываем мета-строку с моделью и датой
  const metaEl = $el('resultsMeta');
  if (metaEl) {
    metaEl.innerHTML = [
      reportDate ? '📅 ' + reportDate : '',
      modelName  ? '🤖 <span style="color:#a78bfa;font-weight:600">' + escHtml(modelName) + '</span>' : '',
      documents.length ? '📁 ' + documents.length + ' файл(ов)' : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');
    metaEl.style.display = 'flex';
  }
  renderDocCards(documents);
  renderSummaryTable(summaryData);
  renderIssues(issues, issueMsg => openFeedback(issueMsg, allFiles().map(f => f.name).join(', ')));
  renderChronology(results.rawData?.chronology || []);
  $el('conclusionText').innerHTML = markdownToHtml(conclusion);
}
