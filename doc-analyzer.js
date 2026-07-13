/**
 * doc-analyzer.js — AI-анализ документов
 * Вызовы через PHP-прокси handler.php → Яндекс Cloud / Anthropic API.
 * Провайдер определяется в config.php (AI_PROVIDER). v45-yandex-fix
 *
 * Этап 1: структурированное извлечение JSON (нативное чтение файла)
 * Этап 2: программная сверка (JS, 100% точность)
 * Этап 3: AI-заключение
 */

const MODEL_ANALYSIS = 'claude-sonnet-4-5-20250929';
const MAX_RETRIES    = 3;
const POLL_INTERVAL  = 3000; // мс между опросами статуса Яндекса

// ─── URL прокси — автоопределение ────────────────────────────────────────────
// Если страница открыта с сервера — используем относительный путь.
// Если открыта как file:// или localhost — используем абсолютный.
function getProxyUrl() {
  const loc = window.location;
  if (loc.protocol === 'file:') return 'http://mto-cto.falcon28.ru/doc-checker/api/handler.php';
  // Строим путь относительно текущей страницы
  const dir = loc.origin + loc.pathname.replace(/\/[^/]*$/, '/');
  return dir + 'api/handler.php';
}
// ─── Типы документов ─────────────────────────────────────────────────────────

export const DOC_TYPES = {
  upd:               { label: 'УПД',                      icon: '📄', zone: 1 },
  invoice:           { label: 'Счёт',                     icon: '💰', zone: 1 },
  contract:          { label: 'Договор',                  icon: '📋', zone: 2 },
  specification:     { label: 'Спецификация / ТЗ',        icon: '📐', zone: 2 },
  waybill:           { label: 'Накладная (ТОРГ-12)',       icon: '🚚', zone: 3 },
  act_commissioning: { label: 'Акт ввода в эксплуатацию', icon: '✅', zone: 3 },
  registry:          { label: 'Сводный реестр',           icon: '📊', zone: 3 },
  advance_invoice:   { label: 'Авансовый счёт',           icon: '💳', zone: 3 },
  inspection_act:    { label: 'Акт проверки',             icon: '🔍', zone: 4 },
  claim:             { label: 'Претензия',                icon: '⚠️', zone: 4 },
  rename_act:        { label: 'Акт переименования',       icon: '🏷️', zone: 4 },
  certificate:       { label: 'Сертификат',               icon: '🏆', zone: 4 },
  declaration:       { label: 'Декларация соответствия',  icon: '🔖', zone: 4 },
  warranty:          { label: 'Гарантийный талон',        icon: '🛡️', zone: 4 },
  memo:              { label: 'Служебная записка',        icon: '📝', zone: 4 },
  other:             { label: 'Иной документ',            icon: '📎', zone: 4 },
};

export function getTypeLabel(type) { return DOC_TYPES[type]?.label || type || 'Документ'; }
export function getTypeIcon(type)  { return DOC_TYPES[type]?.icon  || '📎'; }

// ─── Определение типа по имени файла ─────────────────────────────────────────

export function detectDocType(filename, text) {
  const n = (filename + ' ' + (text || '')).toLowerCase();
  if (/упд|универсальный передаточный/.test(n))                        return 'upd';
  if (/счёт-фактура|счет-фактура/.test(n))                             return 'upd';
  if (/авансов/.test(n))                                               return 'advance_invoice';
  if (/\bсчёт\b|\bсчет\b/.test(n) && !/фактур/.test(n))               return 'invoice';
  if (/договор|контракт/.test(n))                                      return 'contract';
  if (/техническое задание|тех\.?\s*задание|\bтз\b|спецификац/.test(n))return 'specification';
  if (/торг-?12|накладная|товарная/.test(n))                           return 'waybill';
  if (/акт ввода|ввод в эксплуатацию|акт приёма|акт приема/.test(n))  return 'act_commissioning';
  if (/реестр/.test(n))                                                return 'registry';
  if (/акт проверк|проверочн/.test(n))                                 return 'inspection_act';
  if (/претензи/.test(n))                                              return 'claim';
  if (/переименован/.test(n))                                          return 'rename_act';
  if (/сертификат/.test(n))                                            return 'certificate';
  if (/деклараци/.test(n))                                             return 'declaration';
  if (/гарантийн/.test(n))                                             return 'warranty';
  if (/служебная записка|служ\.?\s*записк/.test(n))                    return 'memo';
  return 'other';
}

// ─── Вызов через PHP-прокси ───────────────────────────────────────────────────

async function callAI({ messages, system, model, maxTokens, onProgress }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = {
        action: 'analyze',
        model:      model || MODEL_ANALYSIS,
        max_tokens: maxTokens || 8000,
        messages,
      };
      if (system) payload.system = system;

      const resp = await fetch(getProxyUrl(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const text = await resp.text();
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Сервер вернул не JSON: ' + text.slice(0, 200)); }

      if (!resp.ok) {
        const errMsg = typeof data?.error === 'string' ? data.error
          : data?.error?.message || JSON.stringify(data);
        if (resp.status === 429 || resp.status === 529) {
          const wait = attempt * 20;
          onProgress?.('Лимит API, пауза ' + wait + ' сек (попытка ' + attempt + '/' + MAX_RETRIES + ')...');
          await sleep(wait * 1000);
          lastErr = new Error(errMsg);
          continue;
        }
        throw new Error('API ошибка ' + resp.status + ': ' + errMsg);
      }

      const content = data.content?.[0]?.text;
      if (content === undefined) throw new Error('Пустой ответ от модели');
      if (content === '') throw new Error('Модель вернула пустой текст');
      console.log('[doc-analyzer] Сырой ответ AI (первые 500 символов):', content.slice(0, 500));
      return content;

    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES) {
        onProgress?.('Ошибка, повтор ' + (attempt + 1) + '/' + MAX_RETRIES + ': ' + err.message.slice(0, 80));
        await sleep(5000 * attempt);
      }
    }
  }
  throw lastErr || new Error('Все попытки исчерпаны');
}

// ─── Яндекс: polling на стороне JS ───────────────────────────────────────────
// handler.php сам делает polling внутри (синхронно).
// Эта функция — запасной вариант если нужен клиентский polling.

async function pollYandexOperation(operationId, onProgress) {
  const maxWait = 180000; // 3 минуты
  const start   = Date.now();
  let attempt   = 0;

  while (Date.now() - start < maxWait) {
    await sleep(POLL_INTERVAL);
    attempt++;
    onProgress?.('Яндекс обрабатывает... (' + Math.round((Date.now() - start) / 1000) + 'с)');

    const resp = await fetch(getProxyUrl(), {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ action: 'yandex_poll', operation_id: operationId }),
    });

    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); }
    catch { continue; }

    if (data.error) throw new Error('Яндекс: ' + data.error);
    if (!data.done) continue;

    const content = data.content?.[0]?.text;
    if (content === undefined) throw new Error('Пустой ответ от Яндекса');
    return content;
  }
  throw new Error('Яндекс: таймаут ожидания результата (180с)');
}

// Алиас для обратной совместимости
async function callAnthropic(opts) { return callAI(opts); }

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─── Извлечение JSON из ответа ────────────────────────────────────────────────

function extractJSON(text) {
  if (!text) return null;
  const fenced = text.match(/```json\s*([\s\S]+?)\s*```/);
  if (fenced) {
    try { return JSON.parse(fenced[1]); } catch { /* */ }
  }
  const start = text.indexOf('{');
  const end   = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
  }
  return null;
}

// ─── Определение провайдера (кэш из handler.php?test=1) ──────────────────────
let _cachedProvider = null;
export async function getProvider() {
  if (_cachedProvider) return _cachedProvider;
  try {
    const resp = await fetch(getProxyUrl() + '?test=1');
    const data = await resp.json();
    _cachedProvider = data.provider || 'yandex';
  } catch { _cachedProvider = 'yandex'; }
  return _cachedProvider;
}

// ─── Промпт для Яндекса: встроен в user-сообщение, без system ────────────────
// YandexGPT плохо следует инструкциям в system-промпте.
// Поэтому для Яндекса: инструкция + документ + схема — всё в одном user-сообщении.

function buildYandexExtractionMessage(docType, filename, textContent) {
  const schema = `{
  "doc_type": "${docType}",
  "doc_name": "название и номер документа",
  "doc_date": "ДД.ММ.ГГГГ или null",
  "doc_number": "номер или null",
  "contract_ref": "ссылка на договор или null",
  "seller": { "name": "...", "inn": "...", "kpp": null, "address": null },
  "buyer":  { "name": "...", "inn": "...", "kpp": null, "address": null },
  "items": [
    { "name": "...", "code": null, "unit": "шт", "qty": 0, "price": 0, "amount": 0, "vat_rate": "20%", "vat_amount": 0, "total": 0 }
  ],
  "totals": { "qty_total": null, "amount_no_vat": 0, "vat_amount": 0, "amount_with_vat": 0 },
  "payment_info": { "advance_pct": null, "advance_amount": null, "paid_amount": null, "payment_dates": [] },
  "delivery_info": { "delivery_date": null, "delivery_address": null, "deadline": null },
  "signatures": { "seller_signed": null, "buyer_signed": null, "seller_stamp": null, "buyer_stamp": null },
  "unreadable_fields": [],
  "notes": "важные замечания или null"
}`;

  return `Ты — эксперт по российскому документообороту. Извлеки данные из документа и верни ТОЛЬКО JSON без пояснений.

ПРАВИЛА ЧИСЕЛ:
- Суммы — числа без пробелов: «36 558,95» → 36558.95
- НЕ округлять: «238 352,31052699367» → 238352.31052699367
- Проверяй: qty × price = amount_no_vat (допуск ±0.02)

ДОКУМЕНТ («${filename}»):
===
${textContent}
===

Верни ТОЛЬКО валидный JSON в блоке \`\`\`json ... \`\`\` по схеме:
\`\`\`json
${schema}
\`\`\``;
}

// ─── Системный промпт ─────────────────────────────────────────────────────────

const EXTRACTION_SYSTEM = `Ты — эксперт по финансово-хозяйственным документам российского документооборота.
Твоя задача: извлечь из документа все структурированные данные в формате JSON.
ОБЯЗАТЕЛЬНО: отвечай ТОЛЬКО валидным JSON-объектом в блоке \`\`\`json ... \`\`\`.
Никаких пояснений, никакого текста вне блока JSON.
Если поле отсутствует в документе — ставь null.

ЧИСЛА И СУММЫ:
- Суммы — ЧИСЛА (не строки), без пробелов и символов валюты.
- КАТЕГОРИЧЕСКИ ЗАПРЕЩЕНО округлять или обрезать знаки после запятой!
  Примеры: 36 558,95 → 36558.95 (НЕ 36559), 4 592 833,75 → 4592833.75 (НЕ 4592834)
- Запятая — десятичный разделитель: «36558,95» = 36558.95
- Пробелы между разрядами убираем: «36 558» = 36558, «4 592 833» = 4592833
- ЧИСЛА С ПЕРЕНОСОМ СТРОК: в PDF числа часто разбиваются переносом строки или пробелом.
  Если видишь число, разбитое на части — ВСЕГДА склей все части в одно число.
  Примеры: «36 558» + «,95» = 36558.95; «238 352» + «,310 52699367» = 238352.31052699367
  НИКОГДА не обрезай и не отбрасывай цифры после запятой — они могут быть значимыми!
- ПРОВЕРЯЙ АРИФМЕТИКУ: qty × price = amount_no_vat. Если не сходится — пересмотри числа.
- НЕ ОКРУГЛЯЙ итоговые суммы: если в документе написано 4 592 833,75 — пиши 4592833.75 точно.

КРИТИЧЕСКИ ВАЖНО — ЧИСЛА С БОЛЬШИМ КОЛИЧЕСТВОМ ЗНАКОВ ПОСЛЕ ЗАПЯТОЙ:
В российских УПД/накладных (формат ФНС) цена за единицу может содержать много знаков после запятой.
PDF-парсер разбивает такие числа пробелами и переносами строк — ВСЕ части принадлежат ОДНОМУ числу.

РЕАЛЬНЫЕ ПРИМЕРЫ из документов (оба из одного контракта, разные УПД):

ПРИМЕР 1 — УПД на 1 штуку:
  PDF разбил цену так (разные ячейки/строки):
    колонка «Цена»:   «238 352,31 05269930»  (или «238352,31» + «05269930» в разных строках)
    колонка «Сумма»:  «238 352, 3105269 930»
    колонка «НДС»:    «52 437,508 3159385»
    колонка «Итого»:  «290 789, 8188429 310»
  Правильная расшифровка:
    qty   = 1
    price = 238352.3105269930
    amount_no_vat = 238352.3105269930
    vat_amount    = 52437.5083159385
    amount_with_vat = 290789.8188429315
  Проверка: 1 × 238352.3105269930 = 238352.3105269930 ✓
  Проверка: 238352.3105269930 × 0.22 = 52437.5083159385 ✓

ПРИМЕР 2 — УПД на 72 штуки:
  PDF показывает: «238352,31 05269930» → ЦЕНА = 238352.31052699367
  Проверка: 72 × 238352.31052699367 = 17 161 366.36 ✓

ПРАВИЛО СКЛЕЙКИ ЦЕНЫ:
  1. Берём ВСЕ цифры до и после запятой — это ОДНО число, разбитое PDF-парсером
  2. Пробелы между цифрами — разрядные разделители, убираем их
  3. Запятая — десятичный разделитель: всё что после запятой — дробная часть
  4. НЕ ОТБРАСЫВАЙ цифры после 2-го знака — 238352,3105269930 это НЕ округление до 238352.31
  5. КОЛИЧЕСТВО — небольшое целое (1–9999), стоит ПЕРЕД ценой в своей колонке, не путай с ценой
  6. Если видишь в ячейке «238 352,31 05269930» — это цена 238352.3105269930, а НЕ «цена 238352.31 и код 05269930»

ОБЯЗАТЕЛЬНАЯ ПРОВЕРКА: qty × price = amount_no_vat (допуск ±0.02 руб.)
Если не сходится — значит ты неправильно склеил число, попробуй ещё раз с БОЛЬШИМ числом знаков.
Пример: если qty=1, amount=238352.31 — НЕ сходится с amount_no_vat=238352.3105269930 → нужно взять полное число.

Даты — строки формата ДД.ММ.ГГГГ.`;

// ─── Промпт для финансовых/первичных документов ───────────────────────────────

function buildExtractionPrompt(docType, filename) {
  const base = `Документ: "${filename}" (тип: ${getTypeLabel(docType)})

Извлеки данные в следующем JSON-формате:

\`\`\`json
{
  "doc_type": "${docType}",
  "doc_name": "полное название и номер документа",
  "doc_date": "ДД.ММ.ГГГГ или null",
  "doc_number": "номер документа или null",
  "contract_ref": "ссылка на договор (номер и/или дата) или null",

  "seller": {
    "name": "наименование поставщика/продавца",
    "inn":  "ИНН (10 или 12 цифр) или null",
    "kpp":  "КПП (9 цифр) или null",
    "address": "адрес или null"
  },
  "buyer": {
    "name": "наименование покупателя/заказчика",
    "inn":  "ИНН или null",
    "kpp":  "КПП или null",
    "address": "адрес или null"
  },
  "consignee": "грузополучатель если отличается от покупателя или null",

  "items": [
    {
      "name":       "наименование товара/услуги",
      "code":       "артикул/код или null",
      "unit":       "ед. изм.",
      "qty":        0,
      "price":      0,
      "amount":     0,
      "vat_rate":   "20%, 10%, 0% или без НДС",
      "vat_amount": 0,
      "total":      0
    }
  ],

  "totals": {
    "qty_total":       null,
    "amount_no_vat":   0,
    "vat_amount":      0,
    "amount_with_vat": 0
  },

  "payment_info": {
    "advance_pct":    null,
    "advance_amount": null,
    "paid_amount":    null,
    "payment_dates":  []
  },

  "delivery_info": {
    "delivery_date":    null,
    "delivery_address": null,
    "deadline":         null
  },

  "signatures": {
    "seller_signed": null,
    "buyer_signed":  null,
    "seller_stamp":  null,
    "buyer_stamp":   null
  },

  "unreadable_fields": [],
  "notes": "важные замечания"
}
\`\`\``;

  const extras = {
    upd:               '\nДля УПД: статус документа, дата подписания продавцом и покупателем. Все позиции товаров.',
    invoice:           '\nДля счёта: все позиции, итоговые суммы, реквизиты для оплаты.',
    waybill:           '\nДля ТОРГ-12: все позиции товаров, итоговые суммы, дата, номер, грузополучатель.',
    act_commissioning: '\nДля акта ввода в эксплуатацию: дата акта, адрес объекта, перечень оборудования с количеством, подписи комиссии.',
    registry:          '\nДля сводного реестра: список накладных/актов с номерами, датами, суммами, адресами.',
    contract:          '\nДля договора: номер, дата, срок действия, срок поставки, сумма договора, условия аванса (%), обе стороны с ИНН/КПП.',
    specification:     '\nДля ТЗ/спецификации: перечень товаров с характеристиками, количеством, единицами измерения.',
    certificate:       '\nДля сертификата: орган сертификации, регистрационный номер, срок действия (от/до), наименование товара, ГОСТ/ТР ТС.',
    declaration:       '\nДля декларации соответствия: регистрационный номер, срок действия, технические регламенты, изготовитель.',
    warranty:          '\nДля гарантийного талона: срок гарантии (в месяцах), наименование товара, серийный номер, дата продажи.',
    claim:             '\nДля претензии: предмет претензии, сумма требования, основание, срок ответа, ссылка на договор.',
    inspection_act:    '\nДля акта проверки: дата, место проверки, проверенные позиции, выявленные замечания, подписи, выводы.',
    advance_invoice:   '\nДля авансового счёта: сумма аванса, процент аванса от суммы договора, основание.',
  };

  return base + (extras[docType] || '');
}

// ─── Промпт для дополнительных документов (зона 4) ────────────────────────────

function buildExtrasExtractionPrompt(docType, filename) {
  return `Документ: "${filename}" (тип: ${getTypeLabel(docType)})

Это дополнительный/сопроводительный документ в пакете на оплату.
Извлеки все структурированные данные в формате JSON:

\`\`\`json
{
  "doc_type": "${docType}",
  "doc_name": "полное название и номер документа",
  "doc_date": "ДД.ММ.ГГГГ или null",
  "doc_number": "номер документа или null",
  "contract_ref": "ссылка на договор/контракт или null",

  "issuer": "орган или организация, выдавшая документ, или null",
  "issuer_inn": "ИНН выдавшего органа или null",

  "seller": {
    "name": "наименование поставщика/изготовителя или null",
    "inn": "ИНН или null"
  },

  "product_name": "наименование товара/оборудования или null",
  "product_code": "артикул, модель, серийный номер или null",
  "product_qty": "количество единиц или null",

  "valid_from": "дата начала действия ДД.ММ.ГГГГ или null",
  "valid_until": "дата окончания действия ДД.ММ.ГГГГ или null",
  "is_expired": null,

  "warranty_months": null,

  "technical_regs": [],

  "claim_amount": null,
  "claim_subject": null,
  "claim_deadline": null,

  "signatures": {
    "signed": null,
    "stamp":  null
  },

  "unreadable_fields": [],
  "notes": "важные замечания"
}
\`\`\`

${docType === 'certificate'    ? 'Сертификат: обязательно орган сертификации, номер, срок действия, наименование товара, ТР ТС/ГОСТ.' : ''}
${docType === 'declaration'    ? 'Декларация соответствия: регистрационный номер, срок действия, ТР ТС, изготовитель.' : ''}
${docType === 'warranty'       ? 'Гарантийный талон: срок гарантии в месяцах, наименование товара, серийный номер, дата продажи/передачи.' : ''}
${docType === 'claim'          ? 'Претензия: предмет претензии, сумма требования, срок ответа, ссылка на договор.' : ''}
${docType === 'inspection_act' ? 'Акт проверки: дата, место, проверенные позиции, выявленные замечания, подписи, выводы.' : ''}
${docType === 'memo'           ? 'Служебная записка: адресат, автор, тема, ссылка на договор/контракт, суть обращения.' : ''}`;
}

// ─── Формирование content-блока для Anthropic ────────────────────────────────
// Claude нативно читает PDF и DOCX через document-блок,
// изображения — через image-блок.
// Excel (.xlsx) — передаём как текст.
// Яндекс — только текст (PDF.js уже извлёк текст на клиенте).

function buildContentBlock(fileObj) {
  const { base64, mediaType, textContent, filename } = fileObj;

  // Изображения — image блок (только Claude)
  if (mediaType && mediaType.startsWith('image/')) {
    return {
      type: 'image',
      source: { type: 'base64', media_type: mediaType, data: base64 },
    };
  }

  // PDF и DOCX — document блок (нативное чтение Claude; для Яндекса текст уже в textContent)
  if (mediaType === 'application/pdf' ||
      mediaType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
      mediaType === 'application/msword') {
    if (base64) {
      return {
        type: 'document',
        source: { type: 'base64', media_type: mediaType, data: base64 },
        title: filename,
      };
    }
  }

  // Текстовые файлы — document блок с text source
  if (textContent !== undefined) {
    return {
      type: 'document',
      source: { type: 'text', data: textContent },
      title: filename,
    };
  }

  // Фоллбэк для base64
  // Фоллбэк — document через base64
  return {
    type: 'document',
    source: { type: 'base64', media_type: mediaType || 'text/plain', data: base64 },
    title: filename,
  };
}

// ─── Этап 1: Извлечение ───────────────────────────────────────────────────────

export async function extractDocumentData(fileObj, docType, filename, onProgress, zone, userPatternsPrompt) {
  const effectiveZone = zone || DOC_TYPES[docType]?.zone || 4;

  // Определяем провайдера
  const provider = await getProvider();
  console.log('[doc-analyzer] Провайдер для извлечения:', provider, 'файл:', filename);

  if (provider === 'yandex') {
    // ── Яндекс: всё в одном текстовом сообщении ──────────────────────────────
    let textContent = fileObj.textContent || '';

    // Если текста нет (скан) — запрашиваем OCR через Яндекс Vision
    if ((!textContent || textContent.length < 20) && fileObj.base64 && fileObj.mediaType) {
      onProgress?.('Скан обнаружен — запрашиваю OCR (Яндекс Vision)...');
      try {
        const ocrResp = await fetch(getProxyUrl(), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'ocr',
            base64: fileObj.base64,
            media_type: fileObj.mediaType,
          }),
        });
        const ocrText = await ocrResp.text();
        let ocrData;
        try { ocrData = JSON.parse(ocrText); } catch { throw new Error('OCR: сервер вернул не JSON: ' + ocrText.slice(0, 200)); }
        if (ocrData.error) throw new Error('OCR ошибка: ' + ocrData.error);
        textContent = ocrData.text || '';
        console.log('[doc-analyzer] OCR результат для', filename, ':', textContent.length, 'символов');
        if (!textContent || textContent.length < 10) {
          throw new Error('OCR не распознал текст в скане. Возможно, изображение плохого качества.');
        }
        onProgress?.('OCR завершён (' + textContent.length + ' симв.), анализирую...');
      } catch (ocrErr) {
        throw new Error('Не удалось распознать скан через OCR: ' + ocrErr.message);
      }
    }

    if (!textContent || textContent.length < 20) {
      throw new Error('Нет текстового содержимого для Яндекс. Проверьте что PDF имеет текстовый слой или скан читаем.');
    }
    onProgress?.('YandexGPT читает документ...');
    const userMessage = buildYandexExtractionMessage(docType, filename, textContent);

    const raw = await callAI({
      messages: [{ role: 'user', content: userMessage }],
      // НЕ передаём system — Яндекс плохо следует system-промпту
      model: undefined,
      maxTokens: 8000,
      onProgress,
    });

    const parsed = extractJSON(raw);
    if (!parsed) {
      console.warn('[doc-analyzer] Яндекс вернул не-JSON:', raw.slice(0, 300));
      // Попытка 2: более жёсткий промпт
      onProgress?.('Повторная попытка с упрощённым промптом...');
      const retryMsg = `Извлеки данные из документа и верни ТОЛЬКО JSON-объект, без текста до и после.\n\nДОКУМЕНТ:\n${textContent.slice(0, 30000)}\n\nJSON:`;
      const raw2 = await callAI({
        messages: [{ role: 'user', content: retryMsg }],
        maxTokens: 4000,
        onProgress,
      });
      const parsed2 = extractJSON(raw2);
      if (!parsed2) {
        return { doc_type: docType, doc_name: filename, _raw: raw2, _parseError: true, _errorMsg: 'YandexGPT не вернул JSON', items: [], totals: {}, seller: {}, buyer: {}, signatures: {} };
      }
      return parsed2;
    }
    return parsed;
  }

  // ── Claude: нативное чтение документа ────────────────────────────────────
  onProgress?.('Claude читает документ...');
  const prompt = effectiveZone === 4
    ? buildExtrasExtractionPrompt(docType, filename)
    : buildExtractionPrompt(docType, filename);

  const systemPrompt = EXTRACTION_SYSTEM + (userPatternsPrompt || '');
  const contentBlock = buildContentBlock(fileObj);
  const content = [contentBlock, { type: 'text', text: prompt }];

  const raw = await callAnthropic({
    messages: [{ role: 'user', content }],
    system: systemPrompt,
    model: MODEL_ANALYSIS,
    maxTokens: 8000,
    onProgress,
  });

  const parsed = extractJSON(raw);
  if (!parsed) {
    return {
      doc_type: docType,
      doc_name: filename,
      _raw: raw,
      _parseError: true,
      _errorMsg: 'AI вернул невалидный JSON',
      items: [], totals: {}, seller: {}, buyer: {}, signatures: {},
    };
  }
  return parsed;
}

// ─── Утилиты сверки ──────────────────────────────────────────────────────────

function normalizeINN(inn) {
  if (!inn) return null;
  return String(inn).replace(/[\s\-]/g, '').trim();
}

function normalizeOrgName(name) {
  if (!name) return '';
  return name.toLowerCase()
    .replace(/[«»"]/g, '')
    .replace(/\b(ооо|ао|зао|пао|ип|гбоу|мбоу|мдоу|гку|фгуп)\b/g, '')
    .replace(/\s+/g, ' ').trim();
}

function nameSimilar(a, b) {
  if (!a || !b) return false;
  const na = normalizeOrgName(a);
  const nb = normalizeOrgName(b);
  if (na === nb) return true;
  if (na.includes(nb) || nb.includes(na)) return true;
  const wa = new Set(na.split(' ').filter(Boolean));
  const wb = new Set(nb.split(' ').filter(Boolean));
  const inter = [...wa].filter(w => wb.has(w)).length;
  const union = new Set([...wa, ...wb]).size;
  return union > 0 && inter / union >= 0.5;
}

function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

function parseRuDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return new Date(y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'));
}

function fmtExact(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0,00';
  const str = String(n);
  const dotIdx = str.indexOf('.');
  const srcDecimals = dotIdx >= 0 ? str.length - dotIdx - 1 : 0;
  const decimals = Math.max(2, Math.min(srcDecimals, 10));
  return num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmt(n) { return fmtExact(n); }

// ─── Этап 2: Программная сверка ──────────────────────────────────────────────

export function crossCheck(documents) {
  const issues = [];
  const push = (category, severity, message, detail) =>
    issues.push({ category, severity, message, detail: detail || '' });

  const byZone = { 1: [], 2: [], 3: [], 4: [] };
  documents.forEach(d => {
    const zone = d.zone || DOC_TYPES[d.type]?.zone || 4;
    byZone[zone].push(d);
  });

  const mainDoc   = byZone[1][0];
  const contracts = byZone[2];
  const primaries = byZone[3];
  const extras    = byZone[4];
  const contract  = contracts.find(d => d.type === 'contract' || d.type === 'specification');
  const contractProductName = contract?.data?.items?.[0]?.name || null;

  // 1. Реквизиты
  if (mainDoc && contract) {
    const mSeller = mainDoc.data?.seller || {};
    const cSeller = contract.data?.seller || {};
    const mBuyer  = mainDoc.data?.buyer  || {};

    const mINN = normalizeINN(mSeller.inn);
    const cINN = normalizeINN(cSeller.inn);
    if (mINN && cINN && mINN !== cINN) {
      push('Реквизиты', 'critical',
        `ИНН поставщика в УПД (${mINN}) ≠ договору (${cINN})`,
        `УПД: ${mainDoc.filename}, Договор: ${contract.filename}`);
    }
    if (mSeller.name && cSeller.name && !nameSimilar(mSeller.name, cSeller.name)) {
      push('Реквизиты', 'significant', 'Наименование поставщика расходится',
        `УПД: "${mSeller.name}" / Договор: "${cSeller.name}"`);
    }
    const mBINN = normalizeINN(mBuyer.inn);
    const cBINN = normalizeINN(contract.data?.buyer?.inn);
    if (mBINN && cBINN && mBINN !== cBINN) {
      push('Реквизиты', 'critical',
        `ИНН заказчика в УПД (${mBINN}) ≠ договору (${cBINN})`,
        `УПД: ${mainDoc.filename}, Договор: ${contract.filename}`);
    }
  }

  if (mainDoc) {
    const refINN = normalizeINN(mainDoc.data?.seller?.inn);
    primaries.forEach(p => {
      const pINN = normalizeINN(p.data?.seller?.inn);
      if (refINN && pINN && refINN !== pINN) {
        push('Реквизиты', 'critical',
          `ИНН поставщика в "${p.filename}" (${pINN}) ≠ УПД (${refINN})`);
      }
    });
  }

  // 2. Ссылки на договор
  if (contract && mainDoc) {
    const contractNum = contract.data?.doc_number;
    const updRef = mainDoc.data?.contract_ref;
    if (contractNum && updRef && !updRef.includes(contractNum) && !contractNum.includes(updRef)) {
      push('Ссылки на договор', 'significant',
        `УПД ссылается на договор "${updRef}", загружен договор "${contractNum}"`,
        `УПД: ${mainDoc.filename}`);
    }
    primaries.forEach(p => {
      const ref = p.data?.contract_ref;
      if (contractNum && ref && !ref.includes(contractNum) && !contractNum.includes(ref)) {
        push('Ссылки на договор', 'warning',
          `"${p.filename}" ссылается на договор "${ref}", ожидается "${contractNum}"`);
      }
    });
    extras.forEach(e => {
      const ref = e.data?.contract_ref;
      if (contractNum && ref && !ref.includes(contractNum) && !contractNum.includes(ref)) {
        push('Ссылки на договор', 'warning',
          `"${e.filename}" ссылается на договор "${ref}", ожидается "${contractNum}"`);
      }
    });
  }

  // 3. Хронология
  const updDate = mainDoc ? parseRuDate(mainDoc.data?.doc_date) : null;

  primaries.forEach(p => {
    const pDate = parseRuDate(p.data?.doc_date);
    if (pDate && updDate && pDate > updDate) {
      push('Хронология', 'critical',
        `Дата накладной "${p.filename}" (${p.data.doc_date}) позже даты УПД (${mainDoc.data?.doc_date})`,
        'Накладная не может быть оформлена позже УПД');
    }
  });

  const latestPrimary = primaries.reduce((latest, p) => {
    const d = parseRuDate(p.data?.doc_date);
    return (!latest || (d && d > latest)) ? d : latest;
  }, null);

  extras.filter(e => e.type === 'inspection_act').forEach(act => {
    const actDate = parseRuDate(act.data?.doc_date);
    if (actDate && latestPrimary && actDate < latestPrimary) {
      push('Хронология', 'warning',
        `Акт проверки "${act.filename}" (${act.data?.doc_date}) составлен раньше последней накладной`,
        'Проверка не может предшествовать поставке');
    }
  });

  if (contract && mainDoc) {
    const deadline = parseRuDate(contract.data?.delivery_info?.deadline);
    if (deadline && updDate && updDate > deadline) {
      push('Хронология', 'critical',
        `Дата УПД (${mainDoc.data?.doc_date}) превышает срок поставки по договору (${contract.data.delivery_info.deadline})`,
        'Поставка с нарушением договорных сроков');
    }
  }

  // 4. Арифметика
  [...byZone[1], ...byZone[3]].forEach(d => {
    const items = d.data?.items;
    if (!items?.length) return;
    let calcNoVat = 0, calcVat = 0, calcTotal = 0;
    const arithErrors = [];

    items.forEach((item, i) => {
      const expected = round2((item.qty || 0) * (item.price || 0));
      const actual   = round2(item.amount || 0);
      if (expected > 0 && actual > 0 && Math.abs(expected - actual) > 0.02) {
        arithErrors.push(`Строка ${i + 1} "${item.name}": кол×цену=${fmt(expected)}, указано ${fmt(actual)}`);
      }
      calcNoVat += item.amount      || 0;
      calcVat   += item.vat_amount  || 0;
      calcTotal += item.total       || 0;
    });

    if (arithErrors.length) {
      push('Арифметика', 'critical',
        `Ошибки в расчётах позиций "${d.filename}"`,
        arithErrors.slice(0, 5).join('; ') + (arithErrors.length > 5 ? ` и ещё ${arithErrors.length - 5}` : ''));
    }

    const t = d.data?.totals || {};
    [
      [round2(t.amount_no_vat),   round2(calcNoVat),  'сумма без НДС'],
      [round2(t.vat_amount),      round2(calcVat),    'НДС'],
      [round2(t.amount_with_vat), round2(calcTotal),  'сумма с НДС'],
    ].forEach(([docVal, calcVal, label]) => {
      if (docVal && calcVal && Math.abs(docVal - calcVal) > 0.02) {
        push('Арифметика', 'critical',
          `"${d.filename}": ${label} по строкам (${fmt(calcVal)}) ≠ итогу (${fmt(docVal)})`,
          `Расхождение: ${fmt(Math.abs(docVal - calcVal))} руб.`);
      }
    });
  });

  // 5. Сверка первичек с УПД
  if (mainDoc && primaries.length > 0) {
    const updT = mainDoc.data?.totals || {};
    const primTotal = round2(primaries.reduce((s, p) => s + (p.data?.totals?.amount_with_vat || 0), 0));
    const primNoVat = round2(primaries.reduce((s, p) => s + (p.data?.totals?.amount_no_vat   || 0), 0));
    const primVat   = round2(primaries.reduce((s, p) => s + (p.data?.totals?.vat_amount       || 0), 0));
    const updTotal  = round2(updT.amount_with_vat);
    const updNoVat  = round2(updT.amount_no_vat);
    const updVat    = round2(updT.vat_amount);

    if (updTotal && primTotal) {
      const diff = round2(Math.abs(updTotal - primTotal));
      if (diff <= 0.02) {
        push('Сверка с УПД', 'info', `✅ Сумма первичных документов совпадает с УПД: ${fmt(updTotal)} руб.`);
      } else {
        push('Сверка с УПД', 'critical',
          `Сумма первичных документов (${fmt(primTotal)} руб.) ≠ сумме УПД (${fmt(updTotal)} руб.)`,
          `Расхождение: ${fmt(diff)} руб.`);
      }
    }

    if (updNoVat && primNoVat && Math.abs(updNoVat - primNoVat) > 0.02) {
      push('Сверка с УПД', 'critical',
        `Сумма без НДС по первичкам (${fmt(primNoVat)}) ≠ УПД (${fmt(updNoVat)})`,
        `Расхождение: ${fmt(Math.abs(updNoVat - primNoVat))} руб.`);
    }
    if (updVat && primVat && Math.abs(updVat - primVat) > 0.02) {
      push('Сверка с УПД', 'critical',
        `НДС по первичкам (${fmt(primVat)}) ≠ НДС в УПД (${fmt(updVat)})`,
        `Расхождение: ${fmt(Math.abs(updVat - primVat))} руб.`);
    }

    const updQty  = round2(mainDoc.data?.items?.reduce((s, i) => s + (i.qty || 0), 0) || 0);
    const primQty = round2(primaries.reduce((s, p) =>
      s + (p.data?.items?.reduce((ss, i) => ss + (i.qty || 0), 0) || 0), 0));
    if (updQty > 0 && primQty > 0 && Math.abs(updQty - primQty) > 0.001) {
      push('Сверка с УПД', 'critical',
        `Количество товара по первичкам (${primQty}) ≠ количеству в УПД (${updQty})`,
        'Возможно, не все накладные загружены или есть дублирование');
    }
  }

  // 6. Аванс
  const advanceDoc = byZone[3].find(d => d.type === 'advance_invoice');
  if (contract && advanceDoc) {
    const contractSum = round2(contract.data?.totals?.amount_with_vat);
    const advPct = Number(contract.data?.payment_info?.advance_pct || advanceDoc.data?.payment_info?.advance_pct);
    const advAmt = round2(advanceDoc.data?.totals?.amount_with_vat || advanceDoc.data?.payment_info?.advance_amount);
    if (contractSum && advPct && advAmt) {
      const expected = round2(contractSum * advPct / 100);
      if (Math.abs(expected - advAmt) > 0.02) {
        push('Аванс', 'significant',
          `Сумма аванса (${fmt(advAmt)} руб.) ≠ ${advPct}% от суммы договора (${fmt(expected)} руб.)`,
          `Сумма договора: ${fmt(contractSum)} руб.`);
      } else {
        push('Аванс', 'info', `✅ Аванс ${fmt(advAmt)} руб. = ${advPct}% от суммы договора`);
      }
    }
  }

  // 7. Подписи
  [...byZone[1], ...byZone[3]].forEach(d => {
    const sig = d.data?.signatures;
    if (!sig) return;
    if (sig.seller_signed === false)
      push('Подписи', 'significant', `Отсутствует подпись поставщика в "${d.filename}"`);
    if (sig.buyer_signed === false)
      push('Подписи', 'significant', `Отсутствует подпись покупателя в "${d.filename}"`);
    if (sig.seller_stamp === false)
      push('Подписи', 'warning', `Отсутствует печать поставщика в "${d.filename}"`);
  });

  extras.forEach(e => {
    const sig = e.data?.signatures;
    if (!sig) return;
    if (sig.signed === false)
      push('Подписи', 'warning', `Отсутствует подпись в документе "${e.filename}" (${getTypeLabel(e.type)})`);
    if (sig.stamp === false)
      push('Подписи', 'warning', `Отсутствует печать/штамп в документе "${e.filename}" (${getTypeLabel(e.type)})`);
  });

  // 8. Сертификаты и декларации
  extras.filter(e => e.type === 'certificate' || e.type === 'declaration').forEach(cert => {
    const d = cert.data || {};
    const validUntil = parseRuDate(d.valid_until);
    const today = new Date();
    if (validUntil && validUntil < today) {
      push('Сертификаты', 'critical',
        `Срок действия "${cert.filename}" истёк ${d.valid_until}`,
        'Просроченный сертификат/декларация не может подтверждать соответствие');
    } else if (d.is_expired === true) {
      push('Сертификаты', 'critical', `Сертификат/декларация "${cert.filename}" помечен как просроченный`, d.notes || '');
    } else if (validUntil) {
      const daysLeft = Math.ceil((validUntil - today) / 86400000);
      if (daysLeft < 30) {
        push('Сертификаты', 'warning', `Сертификат/декларация "${cert.filename}" истекает через ${daysLeft} дн. (${d.valid_until})`);
      }
    }
    const certProduct = d.product_name || d.items?.[0]?.name;
    if (certProduct && contractProductName && !nameSimilar(certProduct, contractProductName)) {
      push('Сертификаты', 'significant',
        `Наименование товара в "${cert.filename}" не совпадает с договором`,
        `Документ: "${certProduct}" / Договор: "${contractProductName}"`);
    }
    if (cert.type === 'declaration' && (!d.technical_regs || d.technical_regs.length === 0)) {
      push('Сертификаты', 'warning', `В декларации "${cert.filename}" не указаны технические регламенты (ТР ТС)`);
    }
  });

  // 9. Гарантийные талоны
  extras.filter(e => e.type === 'warranty').forEach(w => {
    const d = w.data || {};
    if (!d.warranty_months) push('Гарантия', 'warning', `В гарантийном талоне "${w.filename}" не указан срок гарантии`);
    const wProduct = d.product_name;
    if (wProduct && contractProductName && !nameSimilar(wProduct, contractProductName)) {
      push('Гарантия', 'significant',
        `Наименование товара в гарантийном талоне "${w.filename}" не совпадает с договором`,
        `Талон: "${wProduct}" / Договор: "${contractProductName}"`);
    }
    const sig = d.signatures;
    if (sig && sig.signed === false) push('Гарантия', 'warning', `Гарантийный талон "${w.filename}" не подписан`);
  });

  // 10. Претензии
  extras.filter(e => e.type === 'claim').forEach(claim => {
    const d = claim.data || {};
    const amount = round2(d.claim_amount || d.totals?.amount_with_vat || 0);
    push('Претензии', 'significant',
      `В пакете присутствует претензия "${claim.filename}"`,
      [
        amount ? `Сумма: ${fmt(amount)} руб.` : '',
        d.claim_subject ? `Предмет: ${d.claim_subject}` : '',
        d.claim_deadline ? `Срок ответа: ${d.claim_deadline}` : '',
        d.notes || '',
      ].filter(Boolean).join(' | '));
  });

  // 11. Акты проверки
  extras.filter(e => e.type === 'inspection_act').forEach(act => {
    const notes = (act.data?.notes || '').toLowerCase();
    if (/замечани|нарушени|несоответств|недостат/.test(notes)) {
      push('Акт проверки', 'significant', `Акт проверки "${act.filename}" содержит замечания`, act.data.notes);
    } else if (act.data?.notes) {
      push('Акт проверки', 'info', `Акт проверки "${act.filename}" — ${act.data.notes}`);
    }
  });

  // 12. Служебные записки
  extras.filter(e => e.type === 'memo').forEach(memo => {
    if (!memo.data?.contract_ref && contract) {
      push('Служебная записка', 'warning', `Служебная записка "${memo.filename}" не содержит ссылки на договор`);
    }
  });

  // 13. Нечитаемые поля
  documents.forEach(d => {
    const u = d.data?.unreadable_fields;
    if (u?.length) push('Читаемость', 'warning', `Нечитаемые данные в "${d.filename}"`, u.join(', '));
  });

  return issues;
}

// ─── Сводная таблица ──────────────────────────────────────────────────────────

export function buildSummaryTableData(documents) {
  const byZone = { 1: [], 2: [], 3: [], 4: [] };
  documents.forEach(d => {
    const zone = d.zone || DOC_TYPES[d.type]?.zone || 4;
    byZone[zone].push(d);
  });

  const mainDoc   = byZone[1][0];
  const primaries = byZone[3];
  const extras    = byZone[4];
  const sections  = [];

  if (mainDoc) {
    sections.push({
      kind: 'payment',
      label: 'Документ на оплату: ' + (mainDoc.data?.doc_name || mainDoc.filename),
      filename: mainDoc.filename,
      docDate: mainDoc.data?.doc_date || null,
      seller: mainDoc.data?.seller || {},
      buyer:  mainDoc.data?.buyer  || {},
      items: mainDoc.data?.items || [],
      totals: mainDoc.data?.totals || {},
    });
  }

  primaries.forEach((p, i) => {
    sections.push({
      kind: 'primary',
      label: `Первичный документ ${i + 1}: ${p.data?.doc_name || p.filename}`,
      filename: p.filename,
      docDate: p.data?.doc_date || null,
      seller: p.data?.seller || {},
      buyer:  p.data?.buyer  || {},
      items: p.data?.items || [],
      totals: p.data?.totals || {},
    });
  });

  if (primaries.length > 0) {
    const itemMap = new Map();
    primaries.forEach(p => {
      (p.data?.items || []).forEach(item => {
        const key = (item.name || '').toLowerCase().trim();
        if (itemMap.has(key)) {
          const e = itemMap.get(key);
          e.qty        = round2((e.qty || 0)        + (item.qty || 0));
          e.amount     = round2((e.amount || 0)     + (item.amount || 0));
          e.vat_amount = round2((e.vat_amount || 0) + (item.vat_amount || 0));
          e.total      = round2((e.total || 0)      + (item.total || 0));
        } else {
          itemMap.set(key, { ...item });
        }
      });
    });

    const aggTotals = {
      amount_no_vat:   round2(primaries.reduce((s, p) => s + (p.data?.totals?.amount_no_vat   || 0), 0)),
      vat_amount:      round2(primaries.reduce((s, p) => s + (p.data?.totals?.vat_amount       || 0), 0)),
      amount_with_vat: round2(primaries.reduce((s, p) => s + (p.data?.totals?.amount_with_vat  || 0), 0)),
    };

    sections.push({
      kind: 'aggregate',
      label: `По сумме первичных документов (${primaries.length} шт.)`,
      items: [...itemMap.values()],
      totals: aggTotals,
      compareWith: mainDoc?.data?.totals,
    });
  }

  if (extras.length > 0) {
    extras.forEach(e => {
      const d = e.data || {};
      sections.push({
        kind: 'extra',
        label: `${getTypeIcon(e.type)} ${getTypeLabel(e.type)}: ${d.doc_name || e.filename}`,
        filename: e.filename,
        docType: e.type,
        docDate: d.doc_date || null,
        validUntil: d.valid_until || null,
        issuer: d.issuer || d.seller?.name || null,
        productName: d.product_name || null,
        warrantyMonths: d.warranty_months || null,
        claimAmount: d.claim_amount || null,
        claimSubject: d.claim_subject || null,
        technicalRegs: d.technical_regs || [],
        signatures: d.signatures || null,
        notes: d.notes || null,
        items: [],
        totals: {},
      });
    });
  }

  return sections;
}

// ─── Этап 3: AI-заключение ────────────────────────────────────────────────────

export async function generateConclusion(documents, issues, onProgress, extraInstructions) {
  onProgress?.('Формирование AI-заключения...');

  const critCount = issues.filter(i => i.severity === 'critical').length;
  const sigCount  = issues.filter(i => i.severity === 'significant').length;

  const byZone = { 1: [], 2: [], 3: [], 4: [] };
  documents.forEach(d => {
    const zone = d.zone || DOC_TYPES[d.type]?.zone || 4;
    byZone[zone].push(d);
  });

  const docSummary = documents.map(d => ({
    файл:         d.filename,
    зона:         d.zone || DOC_TYPES[d.type]?.zone || 4,
    роль:         d.zone === 1 ? 'Документ на оплату' : d.zone === 2 ? 'Договор/ТЗ' : d.zone === 3 ? 'Первичный документ' : 'Дополнительный документ',
    тип:          getTypeLabel(d.type),
    документ:     d.data?.doc_name    || null,
    дата:         d.data?.doc_date    || null,
    поставщик:    d.data?.seller?.name || null,
    ИНН:          d.data?.seller?.inn  || null,
    заказчик:     d.data?.buyer?.name  || null,
    сумма_с_НДС:  d.data?.totals?.amount_with_vat || null,
    позиций:      d.data?.items?.length || 0,
    договор_ref:  d.data?.contract_ref || null,
    срок_до:      d.data?.valid_until   || null,
    товар:        d.data?.product_name  || null,
    гарантия_мес: d.data?.warranty_months || null,
    замечания:    d.data?.notes        || null,
  }));

  const issuesSummary = issues
    .filter(i => i.severity !== 'info')
    .map(i => `[${i.severity.toUpperCase()}] ${i.category}: ${i.message}${i.detail ? ' — ' + i.detail : ''}`)
    .join('\n');

  const extrasCount = byZone[4].length;
  const extrasTypes = [...new Set(byZone[4].map(d => getTypeLabel(d.type)))].join(', ');

  const prompt = `Ты — опытный специалист финансово-экономического контроля.
Тебе поручена проверка пакета документов для оплаты по государственному/муниципальному контракту.

## Документы в пакете
${JSON.stringify(docSummary, null, 2)}

## Результаты программной сверки
Критических нарушений: ${critCount}
Существенных нарушений: ${sigCount}
${issuesSummary || 'Нарушений не выявлено.'}

${extraInstructions ? `## Дополнительные инструкции проверяющего\n${extraInstructions}\n` : ''}

## Задание

Напиши профессиональное заключение о готовности пакета документов к оплате.

### 1. ОБЩИЙ ВЫВОД
Одно предложение: готовы / не готовы / требуют доработки. Укажи сумму к оплате.

### 2. КРИТИЧЕСКИЕ НАРУШЕНИЯ (препятствующие оплате)
Только из программной сверки. Не придумывай новых.

### 3. СУЩЕСТВЕННЫЕ ЗАМЕЧАНИЯ
С указанием конкретного документа и места.

### 4. ХРОНОЛОГИЯ ПОСТАВОК
Анализ логики дат: договор → накладные → УПД.

### 5. СООТВЕТСТВИЕ НАИМЕНОВАНИЙ
Одинаково ли описан товар во всех документах?

### 6. ФИНАНСОВАЯ СВОДКА
Таблица: документ | сумма без НДС | НДС | сумма с НДС. Итого по первичкам vs УПД.

${extrasCount > 0 ? `### 7. ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ (${extrasCount} шт.: ${extrasTypes})
Оцени каждый: соответствие товара, срок действия, подписи/печати, ссылка на договор.

` : ''}### ${extrasCount > 0 ? '8' : '7'}. РЕКОМЕНДАЦИИ
Конкретные действия для устранения нарушений.

ВАЖНО: Опирайся ТОЛЬКО на данные из программной сверки. Не пересчитывай суммы самостоятельно.`;

  return await callAnthropic({
    messages: [{ role: 'user', content: prompt }],
    model: MODEL_ANALYSIS,
    maxTokens: 10000,
    onProgress,
  });
}
