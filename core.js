/**
 * doc-checker/core.js — AI-анализ пакета документов
 * v8 — сверка реестра накладных с первичными документами по номерам
 *
 * Реестр накладных содержит строки вида: номер, получатель, дата, кол-во, цена, сумма.
 * Каждая строка = отдельная накладная (1/1, 1/2, ... 1/72).
 * JS сверяет: загружен ли документ с таким номером, и совпадают ли данные.
 */

const MAX_RETRIES = 2;

export function getProxyUrl() {
  const loc = window.location;
  if (loc.protocol === 'file:') return 'http://mto-cto.falcon28.ru/doc-checker/api/handler.php';
  const dir = loc.origin + loc.pathname.replace(/\/[^/]*$/, '/');
  return dir + 'api/handler.php';
}

// ─── Типы документов ──────────────────────────────────────────────────────────

export const DOC_TYPES = {
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

export function getTypeLabel(type) { return DOC_TYPES[type]?.label || type || 'Документ'; }
export function getTypeIcon(type)  { return DOC_TYPES[type]?.icon  || '📎'; }

export function detectDocType(filename, text) {
  const cleanName = (filename || '').replace(/(\.\w{2,5})+$/i, '').toLowerCase();
  const n = (cleanName + ' ' + (text || '')).toLowerCase();
  if (/упд|универсальный передаточный/.test(n))                         return 'upd';
  if (/счёт-фактура|счет-фактура/.test(n))                              return 'upd';
  if (/авансов/.test(n))                                                return 'advance_invoice';
  if (/\bсчёт\b|\bсчет\b/.test(n) && !/фактур/.test(n))                return 'invoice';
  if (/договор|контракт/.test(n))                                       return 'contract';
  if (/техническое задание|тех\.?\s*задание|\bтз\b|спецификац/.test(n)) return 'specification';
  if (/торг-?12|накладная|товарная/.test(n))                            return 'waybill';
  if (/акт ввода|ввод в эксплуатацию|акт приёма|акт приема/.test(n))   return 'act_commissioning';
  if (/акт комиссии|комиссионн|приёмочн|приемочн|акт приёмки|акт приемки/.test(n)) return 'act_commissioning';
  if (/реестр/.test(n))                                                 return 'registry';
  if (/акт проверк|проверочн/.test(n))                                  return 'inspection_act';
  if (/претензи/.test(n))                                               return 'claim';
  if (/переименован/.test(n))                                           return 'rename_act';
  if (/сертификат/.test(n))                                             return 'certificate';
  if (/деклараци/.test(n))                                              return 'declaration';
  if (/гарантийн|гарантийный талон|гарант\.?\s*талон/.test(n))         return 'warranty';
  if (/служебная записка|служ\.?\s*записк/.test(n))                     return 'memo';
  return 'other';
}

// ─── Нормализация номера накладной ────────────────────────────────────────────
// «Счёт-фактура № 1/3 от 13.01.2026» → «1/3»
// «СФ-1/3» → «1/3»

function normalizeWaybillNum(str) {
  if (!str) return '';
  // Ищем паттерн вида «цифры/цифры» или «цифры-цифры»
  const m = String(str).match(/(\d+)[\/\-](\d+)/);
  if (m) return m[1] + '/' + m[2];
  // Fallback: убираем лишнее
  return String(str).replace(/[^\d\/\-]/g, '').trim();
}

// Извлечь номер накладной из имени файла или строки
function extractWaybillNumFromName(name) {
  if (!name) return '';
  // «Счёт-фактура № 1/3 от ...» → «1/3»
  const m = name.match(/[№#]\s*(\d+[\/\-]\d+)/);
  if (m) return normalizeWaybillNum(m[1]);
  // «сф_1_3» или «накладная-1-3» → «1/3»
  const m2 = name.match(/(\d+)[_\-\/](\d+)/);
  if (m2) return m2[1] + '/' + m2[2];
  return '';
}

// ─── Системные промпты ────────────────────────────────────────────────────────

const SYSTEM_PROMPT_VIOLATIONS =
`Ты — специалист по проверке документов на оплату в госзакупках.
Тебе переданы данные пакета (JSON) и тексты документов.
Найди нарушения и верни ТОЛЬКО минифицированный JSON (без markdown, без ```):
{"rekvizity":{"supplierInnConsistent":true,"buyerInnConsistent":true,"supplierNameConsistent":true,"inconsistencies":[]},"unreadableData":[{"docName":"","location":"","description":""}],"violations":[{"severity":"critical|significant|minor","category":"суммы|реквизиты|хронология|наименования|подписи|сертификаты|прочее","docName":"","text":""}],"conclusion":"","actionRequired":[]}

ПРАВИЛА:
1. РЕКВИЗИТЫ: ИНН поставщика/покупателя во всех документах. Банковские реквизиты (р/с, БИК, к/с) во всех УПД. Поле 8 «Идентификатор госконтракта» в УПД — если пусто («--»,«0») → significant.
2. СУММЫ: сравнивай aggregate (уже пересчитан без реестров) с paymentDoc. Реестры — НЕ первичные документы, их qty и суммы НЕ суммируй и НЕ сравнивай с paymentDoc. Реестр — только справочник о составе пакета.
3. ХРОНОЛОГИЯ: первичные не позже УПД. Даты внутри одного документа не противоречат.
4. НАИМЕНОВАНИЯ: все варианты наименования товара. Страна происхождения — одна.
5. БАНКОВСКИЕ РЕКВИЗИТЫ: р/с, БИК, к/с поставщика совпадают во всех документах.
6. ДОП.ДОКУМЕНТЫ: акт комиссии (все позиции, страна происхождения), гарантийный талон (кол-во, срок), сертификаты (срок действия).
7. ХРОНОЛОГИЯ ОБЯЗАТЕЛЬНА: добавь в JSON поле chronology[] — массив всех дат из всех документов в хронологическом порядке. Каждая запись: {date:"ДД.ММ.ГГГГ", docName:"название документа", event:"краткое описание события", violation:"описание нарушения или null"}. Если дата нарушает логику (первичный позже УПД, акт раньше поставки, дата в будущем) — violation не null.
НЕ генерируй нарушения про «не отражён в реестре» или «не представлен в пакете» — это делает JS-сверка.
СТЕПЕНИ: critical=блокирует оплату, significant=требует исправления, minor=рекомендуется исправить.`;

// ─── Вызов AI ─────────────────────────────────────────────────────────────────

export async function callAI({ messages, system, maxTokens, onProgress }) {
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const payload = { action: 'analyze', max_tokens: maxTokens || 8000, messages };
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
        const errMsg = typeof data?.error === 'string' ? data.error : data?.error?.message || JSON.stringify(data);
        if (resp.status === 429 || resp.status === 529) {
          const wait = attempt * 20;
          onProgress?.('Лимит API, пауза ' + wait + ' сек...');
          await sleep(wait * 1000);
          lastErr = new Error(errMsg);
          continue;
        }
        throw new Error('API ошибка ' + resp.status + ': ' + errMsg);
      }

      const content = data.content?.[0]?.text;
      if (content === undefined) throw new Error('Пустой ответ от модели');
      if (content === '') throw new Error('Модель вернула пустой текст');
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

export function buildContentBlock(fileObj) {
  const { base64, mediaType, textContent, filename } = fileObj;
  if (textContent !== undefined && textContent !== null)
    return { type: 'document', source: { type: 'text', data: textContent }, title: filename };
  if (mediaType && mediaType.startsWith('image/'))
    return { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
  return { type: 'document', source: { type: 'base64', media_type: mediaType || 'application/octet-stream', data: base64 }, title: filename };
}

// ─── JS-пересчёт aggregate (без реестров) ────────────────────────────────────

function recalcAggregate(primaryDocs) {
  const real = (primaryDocs || []).filter(p => !isRegistryDocType(p.docType, p.name));
  if (!real.length) return null;
  const nameMap = {};
  real.forEach(doc => {
    (doc.items || []).forEach(item => {
      const key = (item.name || '').toLowerCase().slice(0, 40) || '_';
      if (!nameMap[key]) nameMap[key] = { name: item.name, unit: item.unit, qty: 0, amountNoVat: 0, vat: 0, amountWithVat: 0 };
      nameMap[key].qty           += Number(item.qty)           || 0;
      nameMap[key].amountNoVat   += Number(item.amountNoVat)   || 0;
      nameMap[key].vat           += Number(item.vat)           || 0;
      nameMap[key].amountWithVat += Number(item.amountWithVat) || 0;
    });
  });
  const items = Object.values(nameMap);
  const total = items.reduce((t, it) => ({
    qty: t.qty + it.qty, amountNoVat: t.amountNoVat + it.amountNoVat,
    vat: t.vat + it.vat, amountWithVat: t.amountWithVat + it.amountWithVat,
  }), { qty: 0, amountNoVat: 0, vat: 0, amountWithVat: 0 });
  return { items, total, _recalculated: true };
}

// ─── Главная функция ──────────────────────────────────────────────────────────

export async function analyzePackage(files, onProgress, extraInstructions, userPatternsPrompt) {
  console.log('[core] VERSION v8');
  onProgress?.('Alice AI LLM: Шаг 1/3 — документ на оплату...');

  const ZONE_LABELS = {
    1: 'ЗОНА 1 — Документ на оплату (УПД, счёт-фактура)',
    2: 'ЗОНА 2 — Договор и техническое задание',
    3: 'ЗОНА 3 — Первичные документы (накладные, акты, реестр)',
    4: 'ЗОНА 4 — Дополнительные документы (сертификаты, акты комиссии, гарантии)',
  };

  const zoneGroups = { 1: [], 2: [], 3: [], 4: [] };
  files.forEach(f => (zoneGroups[f.zone] = zoneGroups[f.zone] || []).push(f));

  // ── Шаг 1a: извлечение paymentDoc + contract ──────────────────────────────
  const PROMPT_PAYMENT = `Ты — специалист по бухгалтерской документации. Извлеки данные из документа на оплату и договора.
ЧИСЛА: точно как в документе, без округления.
ОКПД2 (32.99.53.139 и подобные) — код товара, не цена и не количество.
Верни ТОЛЬКО минифицированный JSON без markdown:
{"paymentDoc":{"docType":"","name":"","date":"","inn_supplier":"","name_supplier":"","inn_buyer":"","name_buyer":"","contract_ref":"","items":[{"num":1,"name":"","unit":"","qty":0,"price":0,"amountNoVat":0,"vatRate":"","vat":0,"amountWithVat":0}],"total":{"qty":0,"amountNoVat":0,"vat":0,"amountWithVat":0},"issues":[]},"contract":{"found":false,"number":"","date":"","inn_supplier":"","inn_buyer":"","totalAmount":null,"advancePct":null,"deliveryDeadline":""}}`;

  const content1a = [{ type: 'text', text: 'Состав: документ на оплату (зона 1) и договор (зона 2).\nВерни ТОЛЬКО JSON.' }];
  for (const f of [...(zoneGroups[1] || []), ...(zoneGroups[2] || [])]) content1a.push(buildContentBlock(f));

  const raw1a = await callAI({ messages: [{ role: 'user', content: content1a }], system: PROMPT_PAYMENT, maxTokens: 8000, onProgress });
  console.log('[core] Шаг 1a raw:', raw1a.slice(0, 200));
  const data1a = extractJSON(raw1a) || {};

  // ── Шаг 2a: реестр накладных отдельным вызовом (компактный JSON ~72 строки) ─
  // Alice AI лимит ~8192 токена вывода — реестр + накладные не влезают в один вызов
  const PROMPT_REGISTRY = `Ты — специалист по бухгалтерской документации. Перед тобой СВОДНЫЙ РЕЕСТР НАКЛАДНЫХ.
ЧИСЛА: точно как в документе, без округления.
Извлеки ВСЕ строки таблицы реестра в массив registryItems[]:
  * num: порядковый номер строки (1, 2, 3...)
  * waybillNum: номер накладной (например "1/1", "1/2", "1/72")
  * waybillDate: дата накладной
  * recipientName: наименование получателя
  * recipientInn: ИНН получателя (только цифры до символа /, например "7736212529")
  * qty: количество товара
  * price: цена за единицу
  * amount: стоимость
Верни ТОЛЬКО минифицированный JSON без markdown:
{"registryItems":[{"num":0,"waybillNum":"","waybillDate":"","recipientName":"","recipientInn":"","qty":0,"price":0,"amount":0}],"registryTotal":{"qty":0,"amount":0}}`;

  // ── Шаг 2b: накладные + доп. документы (без реестра) ──────────────────────
  const PROMPT_PRIMARY = `Ты — специалист по бухгалтерской документации. Извлеки данные из накладных и дополнительных документов.
ЧИСЛА: точно как в документе, без округления.
ОКПД2 — код товара, не цена и не количество.
Для каждой накладной заполни:
- waybillNum: номер накладной из названия файла или текста (например "1/1")
- recipientInn: ИНН получателя из документа
Верни ТОЛЬКО минифицированный JSON без markdown:
{"primaryDocs":[{"docType":"","name":"","date":"","recipient":"","inn_supplier":"","waybillNum":"","recipientInn":"","total":{"qty":0,"amountNoVat":0,"vat":0,"amountWithVat":0},"issues":[]}],"extraDocs":[{"docType":"","name":"","date":"","expiryDate":null,"productName":"","qty":null,"hasStamp":null,"hasSignature":null,"issues":[]}],"chronology":[{"date":"","docName":"","event":""}]}`;

  onProgress?.('Alice AI LLM: Шаг 2a/3 — реестр накладных...');
  let registryItems = [];

  // Отдельный вызов только для реестра
  const registryFiles = (zoneGroups[3] || []).filter(f =>
    isRegistryDocType(f.type || detectDocType(f.name || f.filename || '', f.textContent || ''), f.name || f.filename || ''));
  if (registryFiles.length > 0) {
    const contentReg = [{ type: 'text', text: 'Это сводный реестр накладных. Извлеки ВСЕ строки.\nВерни ТОЛЬКО JSON.' }];
    for (const f of registryFiles) contentReg.push(buildContentBlock(f));
    try {
      const rawReg = await callAI({ messages: [{ role: 'user', content: contentReg }], system: PROMPT_REGISTRY, maxTokens: 8000, onProgress });
      console.log('[core] Шаг 2a (реестр) raw:', rawReg.slice(0, 200));
      const parsedReg = extractJSON(rawReg);
      if (parsedReg?.registryItems?.length) {
        registryItems = parsedReg.registryItems;
        console.log('[core] registryItems извлечено:', registryItems.length);
      }
    } catch (err) { console.warn('[core] Шаг 2a ошибка:', err.message); }
  }

  onProgress?.('Alice AI LLM: Шаг 2b/3 — накладные и доп. документы...');
  let data1b = { primaryDocs: [], extraDocs: [], chronology: [] };

  // Накладные + зона 4 — без реестра
  const nonRegistryZ3 = (zoneGroups[3] || []).filter(f =>
    !isRegistryDocType(f.type || detectDocType(f.name || f.filename || '', f.textContent || ''), f.name || f.filename || ''));
  const nonRegistryFiles = [...nonRegistryZ3, ...(zoneGroups[4] || [])];
  if (nonRegistryFiles.length > 0) {
    const content1b = [{ type: 'text', text: 'Состав: накладные (зона 3) и дополнительные документы (зона 4).\nВерни ТОЛЬКО JSON.' }];
    for (const f of nonRegistryFiles) content1b.push(buildContentBlock(f));
    try {
      const raw1b = await callAI({ messages: [{ role: 'user', content: content1b }], system: PROMPT_PRIMARY, maxTokens: 8000, onProgress });
      console.log('[core] Шаг 2b raw:', raw1b.slice(0, 200));
      const parsed1b = extractJSON(raw1b);
      console.log('[core] Шаг 2b parsed:', parsed1b ? 'OK' : 'FAIL', '| primaryDocs:', parsed1b?.primaryDocs?.length);
      data1b = parsed1b || data1b;
    } catch (err) { console.warn('[core] Шаг 2b ошибка:', err.message); }
  }

  // Добавляем реестр как запись в primaryDocs (для сводной таблицы)
  if (registryFiles.length > 0) {
    const regEntry = { docType: 'registry', name: registryFiles[0].name || registryFiles[0].filename || 'Реестр накладных', date: '', total: { qty: 0, amountNoVat: 0, vat: 0, amountWithVat: 0 }, issues: [] };
    if (registryItems.length) {
      regEntry.total.qty = registryItems.reduce((s, r) => s + (Number(r.qty) || 0), 0);
      regEntry.total.amountWithVat = registryItems.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    }
    data1b.primaryDocs = [...(data1b.primaryDocs || []), regEntry];
  }

  let data = {
    paymentDoc:    data1a.paymentDoc    || null,
    contract:      data1a.contract      || {},
    primaryDocs:   data1b.primaryDocs   || [],
    registryItems: registryItems,
    extraDocs:     data1b.extraDocs     || [],
    chronology:    data1b.chronology    || [],
    aggregate:     null,
  };
  console.log('[core] primaryDocs:', data.primaryDocs.length, '| registryItems:', data.registryItems.length);

  // ── JS пересчитывает aggregate ДО шага 3 ─────────────────────────────────
  if (data.primaryDocs) {
    const recalc = recalcAggregate(data.primaryDocs);
    if (recalc) {
      data.aggregate = recalc;
      const regs = data.primaryDocs.filter(p => isRegistryDocType(p.docType, p.name));
      console.log('[core] aggregate qty=' + recalc.total.qty + ' | исключены реестры:', regs.map(p => p.name));
    }
  }

  // ── Шаг 3: анализ нарушений ───────────────────────────────────────────────
  onProgress?.('Alice AI LLM: Шаг 3/3 — анализ нарушений...');

  let step2 = '=== ДАННЫЕ ПАКЕТА ===\n' +
    JSON.stringify(data, null, 0).slice(0, 6000) +
    '\n\n=== ТЕКСТЫ ДОКУМЕНТОВ ===\n';
  for (const z of [1, 2, 3, 4]) {
    for (const f of (zoneGroups[z] || [])) {
      if (f.textContent) step2 += '\n--- ' + f.name + ' ---\n' + f.textContent.slice(0, 1500) + '\n';
    }
  }
  if (extraInstructions) step2 += '\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n' + extraInstructions;
  step2 += '\n\nВерни ТОЛЬКО JSON: rekvizity, unreadableData, violations, conclusion, actionRequired.';

  let raw2 = '';
  try {
    raw2 = await callAI({
      messages:  [{ role: 'user', content: step2 }],
      system:    SYSTEM_PROMPT_VIOLATIONS,
      maxTokens: 6000,
      onProgress,
    });
  } catch (err) {
    console.warn('[core] Шаг 3 ошибка:', err.message);
  }

  const v2 = raw2 ? extractJSON(raw2) : null;
  if (v2) {
    if (v2.violations)     data.violations     = v2.violations;
    if (v2.rekvizity)      data.rekvizity      = v2.rekvizity;
    if (v2.unreadableData) data.unreadableData = v2.unreadableData;
    if (v2.conclusion)     data.conclusion     = v2.conclusion;
    if (v2.actionRequired) data.actionRequired = v2.actionRequired;
    // Хронология из шага 3 перезаписывает хронологию из шага 2b (более полная)
    if (v2.chronology?.length) data.chronology = v2.chronology;
  } else if (raw2) {
    console.warn('[core] Шаг 3: не-JSON:', raw2.slice(0, 300));
  }

  const issues = programmaticCheck(data, files);
  return { data, issues, rawText: raw1a };
}

// ─── Программная сверка ───────────────────────────────────────────────────────

export function programmaticCheck(data, files) {
  const issues = [...(data.violations || [])];

  // ── Фильтр ложных Alice-violations ───────────────────────────────────────
  const realPrimaries = (data.primaryDocs || []).filter(p => !isRegistryDocType(p.docType, p.name));
  const jsQty = round2(realPrimaries.reduce((s, p) => s + (Number(p.total?.qty) || 0), 0));
  const pdQty = round2(Number(data.paymentDoc?.total?.qty) || 0);
  const hasRegistries = (data.primaryDocs || []).some(p => isRegistryDocType(p.docType, p.name));
  const jsQtyMismatch = pdQty > 0 && jsQty > 0 && Math.abs(pdQty - jsQty) > 0.01;

  console.log('[core] pdQty:', pdQty, '| jsQty (без реестров):', jsQty, '| расхождение:', jsQtyMismatch);

  for (let i = issues.length - 1; i >= 0; i--) {
    const t = (issues[i].text || '').toLowerCase();
    // Удаляем ложные qty-нарушения когда реестр посчитан как первичный
    if (hasRegistries && !jsQtyMismatch &&
        /суммарное|первичн.*кол|кол.*первичн|по\s+\d+\s+документ/.test(t) &&
        /≠|не соответствует|расхожден|не совпад/.test(t)) {
      console.log('[core] Удалено ложное qty-нарушение:', issues[i].text.slice(0, 80));
      issues.splice(i, 1);
      continue;
    }
    // Удаляем Alice-нарушения про реестр — JS сам делает точную сверку
    if (/не отражён в реестре|не представлен в пакете/.test(t) && /реестр/.test(t)) {
      console.log('[core] Удалено Alice реестр-нарушение:', issues[i].text.slice(0, 80));
      issues.splice(i, 1);
    }
  }

  // ── Арифметика ────────────────────────────────────────────────────────────
  data._cellErrors = data._cellErrors || {};

  function addCellError(docKey, idx, field, actual, expected, label) {
    if (!data._cellErrors[docKey]) data._cellErrors[docKey] = {};
    if (!data._cellErrors[docKey][idx]) data._cellErrors[docKey][idx] = {};
    data._cellErrors[docKey][idx][field] = { actual, expected, label };
  }

  function checkArith(item, i, docKey) {
    const qty = parseFloat(item.qty) || 0, price = parseFloat(item.price) || 0;
    const noVat = parseFloat(item.amountNoVat) || 0;
    const vat   = parseFloat(item.vat) || 0;
    const withVat = parseFloat(item.amountWithVat) || 0;
    if (qty > 0 && price > 0 && noVat > 0) {
      const exp = round2(qty * price);
      if (Math.abs(exp - round2(noVat)) > 0.02)
        addCellError(docKey, i, 'amountNoVat', noVat, exp, `${fmtNum(qty)} × ${fmtNum(price)} = ${fmtNum(exp)}`);
    }
    const vatPct = parseFloat(String(item.vatRate || '').replace('%', ''));
    if (noVat > 0 && vat > 0 && !isNaN(vatPct) && vatPct > 0) {
      const expVat = round2(noVat * vatPct / 100);
      if (Math.abs(expVat - round2(vat)) > 0.02)
        addCellError(docKey, i, 'vat', vat, expVat, `${fmtNum(noVat)} × ${vatPct}% = ${fmtNum(expVat)}`);
    }
    if (noVat > 0 && withVat > 0) {
      const expTotal = round2(noVat + vat);
      if (Math.abs(expTotal - round2(withVat)) > 0.02)
        addCellError(docKey, i, 'amountWithVat', withVat, expTotal, `${fmtNum(noVat)} + ${fmtNum(vat)} = ${fmtNum(expTotal)}`);
    }
  }

  const pd = data.paymentDoc;
  (pd?.items || []).forEach((item, i) => checkArith(item, i, 'paymentDoc'));
  (data.primaryDocs || []).forEach((doc, di) => {
    (doc.items || []).forEach((item, i) => checkArith(item, i, `primary_${di}`));
  });

  // ── Сравнение aggregate vs документ на оплату ─────────────────────────────
  if (pd?.total && realPrimaries.length > 0) {
    const aggQty   = round2(realPrimaries.reduce((s, p) => s + (Number(p.total?.qty) || 0), 0));
    const aggNoVat = round2(realPrimaries.reduce((s, p) => s + (Number(p.total?.amountNoVat) || 0), 0));
    const aggVat   = round2(realPrimaries.reduce((s, p) => s + (Number(p.total?.vat) || 0), 0));
    const aggTotal = round2(realPrimaries.reduce((s, p) => s + (Number(p.total?.amountWithVat) || 0), 0));
    data._aggregateComparison = {
      qty:           { agg: aggQty,   pay: round2(pd.total.qty || 0),           match: Math.abs(aggQty   - round2(pd.total.qty || 0))          < 0.01 },
      amountNoVat:   { agg: aggNoVat, pay: round2(pd.total.amountNoVat || 0),   match: Math.abs(aggNoVat - round2(pd.total.amountNoVat || 0))  < 0.02 },
      vat:           { agg: aggVat,   pay: round2(pd.total.vat || 0),           match: Math.abs(aggVat   - round2(pd.total.vat || 0))          < 0.02 },
      amountWithVat: { agg: aggTotal, pay: round2(pd.total.amountWithVat || 0), match: Math.abs(aggTotal - round2(pd.total.amountWithVat || 0)) < 0.02 },
    };
  }

  const push = (category, severity, text) => {
    if (!issues.some(i => i.text && i.text.includes(text.slice(0, 40))))
      issues.push({ category, severity, text });
  };

  const primaries = data.primaryDocs || [];
  const extras    = data.extraDocs   || [];
  const contract  = data.contract    || {};
  const primNoReg = primaries.filter(p => !isRegistryDocType(p.docType, p.name));

  // ══════════════════════════════════════════════════════════════════════════
  // 1. СВЕРКА РЕЕСТРА НАКЛАДНЫХ С ЗАГРУЖЕННЫМИ ДОКУМЕНТАМИ
  // ══════════════════════════════════════════════════════════════════════════
  // Реестр содержит строки: каждая строка = отдельная накладная (1/1, 1/2...)
  // с ИНН получателя, кол-вом, ценой, суммой.
  // Сверяем:
  //   A. Строка реестра → ищем накладную в пакете → если нет → ошибка
  //   B. Накладная в пакете → ищем в реестре → если нет → ошибка
  //   C. Нашли пару → сверяем qty, сумму, ИНН получателя

  const registryItems = data.registryItems || [];
  if (registryItems.length > 0) {
    console.log('[core] Сверка реестра: строк в реестре =', registryItems.length, '| накладных в пакете =', primNoReg.length);

    // Строим карту загруженных накладных по номеру
    // Ключ: нормализованный номер накладной (например "1/3")
    const uploadedByNum = new Map();
    primNoReg.forEach(doc => {
      // Пробуем извлечь номер из поля waybillNum (заполнено AI)
      let num = normalizeWaybillNum(doc.waybillNum || '');
      // Fallback: из имени документа
      if (!num) num = extractWaybillNumFromName(doc.name || '');
      if (num) {
        uploadedByNum.set(num, doc);
        console.log('[core] Накладная в пакете:', num, '←', doc.name);
      }
    });

    // Строим карту строк реестра по номеру накладной
    const registryByNum = new Map();
    registryItems.forEach(ri => {
      const num = normalizeWaybillNum(ri.waybillNum || '');
      if (num) registryByNum.set(num, ri);
    });

    // A. Строки реестра → ищем в пакете
    const missingFromPackage = [];
    registryItems.forEach(ri => {
      const num = normalizeWaybillNum(ri.waybillNum || '');
      if (!num) return;
      if (!uploadedByNum.has(num)) {
        missingFromPackage.push({ num, ri });
      }
    });

    // B. Загруженные накладные → ищем в реестре
    const notInRegistry = [];
    uploadedByNum.forEach((doc, num) => {
      if (!registryByNum.has(num)) {
        notInRegistry.push({ num, doc });
      }
    });

    // Сообщаем о пропущенных документах (группируем если много)
    if (missingFromPackage.length > 0) {
      if (missingFromPackage.length <= 5) {
        missingFromPackage.forEach(({ num, ri }) => {
          push('Реестр', 'critical',
            'Накладная № ' + num + ' из реестра (' +
            (ri.recipientName ? ri.recipientName.slice(0, 50) : 'получатель не указан') +
            ') не загружена в пакет документов');
        });
      } else {
        // Много пропущенных — выводим сводку
        const nums = missingFromPackage.slice(0, 10).map(x => x.num).join(', ');
        push('Реестр', 'critical',
          'В реестре указано ' + registryItems.length + ' накладных, загружено только ' +
          uploadedByNum.size + '. Не загружены: ' + nums +
          (missingFromPackage.length > 10 ? ' и ещё ' + (missingFromPackage.length - 10) + ' накладных' : ''));
      }
    }

    if (notInRegistry.length > 0) {
      if (notInRegistry.length <= 5) {
        notInRegistry.forEach(({ num, doc }) => {
          push('Реестр', 'significant',
            'Накладная № ' + num + ' («' + (doc.name || '').slice(0, 60) + '») загружена, но отсутствует в реестре');
        });
      } else {
        const nums = notInRegistry.slice(0, 5).map(x => x.num).join(', ');
        push('Реестр', 'significant',
          notInRegistry.length + ' загруженных накладных не найдены в реестре: ' + nums +
          (notInRegistry.length > 5 ? ' и др.' : ''));
      }
    }

    // C. Сверяем данные совпадающих пар
    uploadedByNum.forEach((doc, num) => {
      const ri = registryByNum.get(num);
      if (!ri) return; // уже отмечено как «не в реестре»

      // Сверяем ИНН получателя
      const docInn = normalizeINN(doc.recipientInn || '');
      const regInn = normalizeINN(String(ri.recipientInn || '').split('/')[0]);
      if (docInn && regInn && docInn !== regInn) {
        push('Реестр', 'significant',
          'Накладная № ' + num + ': ИНН получателя в документе (' + docInn +
          ') ≠ реестру (' + regInn + ', ' + (ri.recipientName || '') + ')');
      }

      // Сверяем количество
      const docQty = round2(Number(doc.total?.qty) || 0);
      const regQty = round2(Number(ri.qty) || 0);
      if (docQty > 0 && regQty > 0 && Math.abs(docQty - regQty) > 0.01) {
        push('Реестр', 'significant',
          'Накладная № ' + num + ' (' + (ri.recipientName || '').slice(0, 40) + '): ' +
          'кол-во в документе (' + fmtNum(docQty) + ' шт.) ≠ реестру (' + fmtNum(regQty) + ' шт.)');
      }

      // Сверяем сумму (без НДС или с НДС)
      const docAmount = round2(Number(doc.total?.amountWithVat) || Number(doc.total?.amountNoVat) || 0);
      const regAmount = round2(Number(ri.amount) || 0);
      if (docAmount > 0 && regAmount > 0 && Math.abs(docAmount - regAmount) > 1) {
        push('Реестр', 'significant',
          'Накладная № ' + num + ' (' + (ri.recipientName || '').slice(0, 40) + '): ' +
          'сумма в документе (' + fmtNum(docAmount) + ' руб.) ≠ реестру (' + fmtNum(regAmount) + ' руб.)');
      }
    });

    // Итоговое qty реестра vs УПД
    const regTotalQty = round2(registryItems.reduce((s, ri) => s + (Number(ri.qty) || 0), 0));
    const pdQtyVal = round2(Number(pd?.total?.qty) || 0);
    if (regTotalQty > 0 && pdQtyVal > 0 && Math.abs(regTotalQty - pdQtyVal) > 0.01) {
      push('Реестр', 'significant',
        'Итоговое количество в реестре (' + fmtNum(regTotalQty) + ' шт.) ≠ документу на оплату (' +
        fmtNum(pdQtyVal) + ' шт.). Расхождение: ' + fmtNum(Math.abs(regTotalQty - pdQtyVal)) + ' шт.');
    }

    // Сохраняем результаты сверки для отображения
    data._registryCheck = {
      registryCount:       registryItems.length,
      uploadedCount:       uploadedByNum.size,
      missingFromPackage:  missingFromPackage.length,
      notInRegistry:       notInRegistry.length,
      regTotalQty,
    };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Сверка qty и суммы первичных с документом на оплату
  // ══════════════════════════════════════════════════════════════════════════
  if (pd?.total && primNoReg.length > 0) {
    const primQty  = round2(primNoReg.reduce((s, p) => s + (Number(p.total?.qty) || 0), 0));
    const pdQtyVal = round2(pd.total.qty || 0);
    if (pdQtyVal > 0 && primQty > 0 && Math.abs(pdQtyVal - primQty) > 0.01) {
      push('Количество', 'critical',
        'Суммарное количество в первичных документах (' + fmtNum(primQty) + ' шт.) ' +
        '≠ документу на оплату (' + fmtNum(pdQtyVal) + ' шт.). ' +
        'По ' + primNoReg.length + ' документам не подтверждено: ' + fmtNum(Math.abs(pdQtyVal - primQty)) + ' шт.');
    } else {
      const primTotal = round2(primNoReg.reduce((s, p) => s + (Number(p.total?.amountWithVat) || 0), 0));
      const pdTotal   = round2(pd.total.amountWithVat || 0);
      if (pdTotal > 0 && primTotal > 0) {
        const diff = round2(Math.abs(pdTotal - primTotal));
        if (diff > 0.02)
          push('Сверка с УПД', 'critical',
            'Сумма первичных документов (' + fmtNum(primTotal) + ' руб.) ≠ документу на оплату (' +
            fmtNum(pdTotal) + ' руб.). Расхождение: ' + fmtNum(diff) + ' руб.');
      }
    }
  }

  // 3. ИНН: УПД vs договор
  if (pd?.inn_supplier && contract?.inn_supplier) {
    const a = normalizeINN(pd.inn_supplier), b = normalizeINN(contract.inn_supplier);
    if (a && b && a !== b)
      push('Реквизиты', 'critical', 'ИНН поставщика в документе на оплату (' + a + ') ≠ договору (' + b + ')');
  }

  // 4. ИНН: первичные vs УПД
  if (pd?.inn_supplier) {
    const refINN = normalizeINN(pd.inn_supplier);
    primaries.forEach(p => {
      const pINN = normalizeINN(p.inn_supplier);
      if (pINN && refINN && pINN !== refINN)
        push('Реквизиты', 'critical',
          'ИНН поставщика в «' + (p.name || '') + '» (' + pINN + ') ≠ документу на оплату (' + refINN + ')');
    });
  }

  // 5. Хронология
  if (pd?.date) {
    const updDate = parseRuDate(pd.date);
    const cDate   = contract?.date ? parseRuDate(contract.date) : null;
    primaries.forEach(p => {
      const pDate = parseRuDate(p.date);
      if (pDate && updDate && pDate > updDate)
        push('хронология', 'critical',
          'Дата «' + (p.name || '') + '» (' + p.date + ') позже даты документа на оплату (' + pd.date + ')');
      if (pDate && cDate && cDate > pDate) {
        const days = Math.round((cDate - pDate) / 86400000);
        if (days > 365)
          push('хронология', 'significant',
            'Дата «' + (p.name || '') + '» (' + p.date + ') на ' + days + ' дней раньше договора (' + contract.date + ') — возможная ошибка года');
      }
    });
  }

  // 6. Сертификаты — срок действия
  extras.filter(e => {
    const dt = (e.docType || '').toLowerCase();
    return dt.includes('сертификат') || dt.includes('certificate') ||
           dt.includes('деклараци')  || dt.includes('declaration');
  }).forEach(cert => {
    const expiryStr = cert.expiryDate || cert.valid_until;
    if (!expiryStr) return;
    const validUntil = parseRuDate(expiryStr);
    const today = new Date();
    if (validUntil && validUntil < today)
      push('сертификаты', 'critical', 'Срок действия «' + (cert.name || '') + '» истёк ' + expiryStr);
    else if (validUntil) {
      const daysLeft = Math.ceil((validUntil - today) / 86400000);
      if (daysLeft < 30)
        push('сертификаты', 'minor', 'Сертификат/декларация «' + (cert.name || '') + '» истекает через ' + daysLeft + ' дн. (' + expiryStr + ')');
    }
  });

  // 7. Акт комиссии — qty vs УПД
  [...primaries, ...extras].filter(e => {
    const dt = (e.docType || '').toLowerCase();
    const nm = (e.name || '').toLowerCase();
    return dt.includes('act_commissioning') || dt.includes('commissioning') ||
           /акт комиссии|акт приёмки|акт приемки|комиссионн/.test(nm);
  }).forEach(act => {
    const actQty   = Number(act.total?.qty || act.qty || (act.items?.reduce((s, it) => s + (Number(it.qty) || 0), 0)) || 0);
    const pdQtyVal = Number(pd?.total?.qty || 0);
    if (actQty > 0 && pdQtyVal > 0 && Math.abs(actQty - pdQtyVal) > 0.01) {
      const already = issues.some(i => /акт комиссии|акт приёмки/.test((i.text || '').toLowerCase()) && /количество|шт/.test((i.text || '').toLowerCase()));
      if (!already)
        push('Акт комиссии', actQty < pdQtyVal ? 'significant' : 'minor',
          'Акт комиссии «' + (act.name || '') + '» подтверждает приёмку ' + fmtNum(actQty) +
          ' шт., тогда как документ на оплату — ' + fmtNum(pdQtyVal) +
          ' шт. Расхождение: ' + fmtNum(Math.abs(pdQtyVal - actQty)) + ' шт.');
    }
  });

  // 8. Гарантийный талон — qty vs УПД
  extras.filter(e => {
    const dt = (e.docType || '').toLowerCase();
    return dt.includes('warranty') || /гарантийн/.test((e.name || '').toLowerCase());
  }).forEach(w => {
    const wQty     = Number(w.total?.qty || w.qty || (w.items?.reduce((s, it) => s + (Number(it.qty) || 0), 0)) || 0);
    const pdQtyVal = Number(pd?.total?.qty || 0);
    if (wQty > 0 && pdQtyVal > 0 && Math.abs(wQty - pdQtyVal) > 0.01) {
      const already = issues.some(i => /гарантийн/.test((i.text || '').toLowerCase()) && /количество|шт/.test((i.text || '').toLowerCase()));
      if (!already)
        push('Гарантийный талон', 'significant',
          'Гарантийный талон «' + (w.name || '') + '» выписан на ' + fmtNum(wQty) +
          ' шт., тогда как документ на оплату — на ' + fmtNum(pdQtyVal) +
          ' шт. Расхождение: ' + fmtNum(Math.abs(wQty - pdQtyVal)) + ' шт.');
    }
    if (w.expiryDate) {
      const expiry = parseRuDate(w.expiryDate);
      if (expiry && expiry < new Date())
        push('Гарантийный талон', 'critical', 'Срок гарантии по талону «' + (w.name || '') + '» истёк ' + w.expiryDate);
    }
  });

  // 9. Нечитаемые данные
  (data.unreadableData || []).forEach(u => {
    push('прочее', 'minor',
      'Нечитаемые данные в «' + (u.docName || '') + '» (' + (u.location || '') + '): ' + (u.description || ''));
  });

  // 10. Реквизиты от Alice
  (data.rekvizity?.inconsistencies || []).forEach(inc => push('реквизиты', 'significant', inc));

  // 11. Разные наименования
  if (pd?.items?.length) {
    const refNames = pd.items.map(it => normalizeProductName(it.name)).filter(Boolean);
    [...primaries, ...extras].forEach(doc => {
      (doc.items || []).forEach(item => {
        if (!item.name) return;
        const norm = normalizeProductName(item.name);
        if (!refNames.some(ref => namesAreSimilar(ref, norm)) && norm.length > 5)
          push('наименования', 'minor',
            'Наименование товара в «' + (doc.name || '') + '» («' + item.name.slice(0, 80) + '») ' +
            'отличается от документа на оплату («' + (pd.items[0]?.name || '').slice(0, 80) + '»). Проверьте, что речь об одном товаре.');
      });
    });
  }

  // 12. Даты из doc.issues
  [...primaries, ...extras].forEach(doc => {
    (doc.issues || []).forEach(issue => {
      if (/дат.*договор|договор.*дат/i.test(issue))
        push('хронология', 'significant', '«' + (doc.name || '') + '»: ' + issue);
    });
  });

  // 13. Арифметические ошибки → violations
  const cellErrors = data._cellErrors || {};
  function cellErrToViolation(docKey, docName) {
    Object.entries(cellErrors[docKey] || {}).forEach(([idx, fields]) => {
      const itemName = (docKey === 'paymentDoc'
        ? pd?.items?.[idx]?.name
        : data.primaryDocs?.[parseInt(docKey.replace('primary_', ''))]?.items?.[idx]?.name) || '';
      Object.entries(fields).forEach(([field, err]) => {
        const lbl = { amountNoVat: 'Стоимость без НДС', vat: 'НДС', amountWithVat: 'Стоимость с НДС' }[field] || field;
        push('Арифметика', 'significant',
          `«${docName}», строка ${parseInt(idx) + 1} «${itemName.slice(0, 60)}»: ` +
          `${lbl} = ${fmtNum(err.actual)}, должно быть ${fmtNum(err.expected)} (${err.label})`);
      });
    });
  }
  cellErrToViolation('paymentDoc', pd?.name || 'Документ на оплату');
  (data.primaryDocs || []).forEach((doc, di) => cellErrToViolation(`primary_${di}`, doc.name || `Первичный документ ${di + 1}`));

  return issues;
}

// ─── Заключение ───────────────────────────────────────────────────────────────

export async function generateConclusion(data, issues) { return buildConclusionText(data, issues); }

function buildConclusionText(data, issues) {
  const crit = issues.filter(i => i.severity === 'critical').length;
  const sig  = issues.filter(i => i.severity === 'significant').length;
  let text = '';
  if (data?.conclusion) text += '## Заключение\n\n' + data.conclusion + '\n\n';
  if (crit > 0) {
    text += '## Критические нарушения (' + crit + ')\n\n';
    issues.filter(i => i.severity === 'critical').forEach(v => { text += '- 🔴 ' + v.text + '\n'; });
  }
  if (sig > 0) {
    text += '\n## Существенные замечания (' + sig + ')\n\n';
    issues.filter(i => i.severity === 'significant').forEach(v => { text += '- 🟠 ' + v.text + '\n'; });
  }
  if (data?.actionRequired?.length) {
    text += '\n## Необходимые действия\n\n';
    data.actionRequired.forEach((a, i) => { text += (i + 1) + '. ' + a + '\n'; });
  }
  return text || 'Анализ завершён. Нарушений не выявлено.';
}

// ─── Утилиты ──────────────────────────────────────────────────────────────────

export function isRegistryDocType(docType, name) {
  const dt = (docType || '').toLowerCase().trim();
  const nm = (name   || '').toLowerCase().trim();
  if (dt === 'registry' || dt.includes('registry') || dt.includes('реестр')) return true;
  if (nm.includes('реестр')) return true;
  return false;
}

export function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

export function extractJSON(text) {
  if (!text) return null;
  try { const t = text.trim(); if (t.startsWith('{')) return JSON.parse(t); } catch { /* */ }
  const fenceStart = text.indexOf('```');
  if (fenceStart !== -1) {
    let inner = text.slice(fenceStart + 3);
    if (inner.startsWith('json')) inner = inner.slice(4);
    const fenceEnd = inner.lastIndexOf('```');
    if (fenceEnd !== -1) inner = inner.slice(0, fenceEnd);
    inner = inner.trim();
    try { if (inner.startsWith('{')) return JSON.parse(inner); } catch { /* */ }
    try { return JSON.parse(repairTruncatedJSON(inner)); } catch { /* */ }
  }
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end > start) { try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ } }
  try { return JSON.parse(repairTruncatedJSON(text.slice(start))); } catch { /* */ }
  return null;
}

function repairTruncatedJSON(raw) {
  let s = raw.trimEnd();
  let depth = 0, inStr = false, escape = false, lastSafePos = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inStr) { escape = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{' || c === '[') depth++;
    if (c === '}' || c === ']') { depth--; if (depth === 0) lastSafePos = i + 1; }
  }
  if (lastSafePos > 1) { try { return JSON.parse(s.slice(0, lastSafePos)); } catch { /* */ } }
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
  return s + stack.reverse().join('');
}

export function normalizeINN(inn) {
  if (!inn) return null;
  return String(inn).replace(/[\s\-]/g, '').split('/')[0].trim();
}

export function round2(v) { return Math.round((Number(v) || 0) * 100) / 100; }

export function parseRuDate(str) {
  if (!str) return null;
  const m = String(str).match(/(\d{1,2})[.\-\/](\d{1,2})[.\-\/](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  return new Date(y + '-' + m[2].padStart(2, '0') + '-' + m[1].padStart(2, '0'));
}

export function fmtNum(n) {
  const num = Number(n);
  if (!isFinite(num)) return '0';
  const str = String(n);
  const dotIdx = str.indexOf('.');
  const srcDecimals = dotIdx >= 0 ? str.length - dotIdx - 1 : 0;
  const decimals = Math.max(2, Math.min(srcDecimals, 10));
  return num.toLocaleString('ru-RU', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtExact(n) { return fmtNum(n); }
export function isMiniappsMode() { return false; }

export function normalizeProductName(name) {
  if (!name) return '';
  return name.toLowerCase().replace(/[«»""'']/g, '').replace(/\s+/g, ' ').trim();
}

export function namesAreSimilar(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length < b.length ? a : b;
  const longer  = a.length < b.length ? b : a;
  if (longer.includes(shorter.slice(0, Math.min(shorter.length, 20)))) return true;
  if (a.slice(0, 15) === b.slice(0, 15)) return true;
  const wordsA = a.split(/\s+/).filter(w => w.length > 4);
  const wordsB = new Set(b.split(/\s+/).filter(w => w.length > 4));
  if (wordsA.length === 0) return false;
  return wordsA.filter(w => wordsB.has(w)).length / wordsA.length >= 0.6;
}

export function crossCheck() { return []; }

export async function extractDocumentData(fileObj, docType, filename, onProgress) {
  onProgress?.('Файл будет обработан в составе пакета');
  return { doc_type: docType, doc_name: filename, items: [], totals: {}, seller: {}, buyer: {}, signatures: {} };
}

export async function ocrPdfViaCanvas(fileObj, onProgress) {
  onProgress?.('OCR недоступен в этом режиме');
  return '';
}

export function buildSummaryTableData(data) {
  if (!data) return [];
  const sections = [];

  if (data.paymentDoc) {
    const pd = data.paymentDoc;
    sections.push({
      kind: 'payment', label: 'Документ на оплату: ' + (pd.name || ''),
      docType: pd.docType, docDate: pd.date,
      seller: { name: pd.name_supplier, inn: pd.inn_supplier },
      buyer:  { name: pd.name_buyer,    inn: pd.inn_buyer },
      contractRef: pd.contract_ref,
      items: (pd.items || []).map(it => ({ name: it.name, unit: it.unit, qty: it.qty, price: it.price, amount: it.amountNoVat, vatRate: it.vatRate, vat_amount: it.vat, total: it.amountWithVat })),
      totals: { amount_no_vat: pd.total?.amountNoVat, vat_amount: pd.total?.vat, amount_with_vat: pd.total?.amountWithVat, qty_total: pd.total?.qty },
      docIssues: pd.issues || [],
    });
  }

  (data.primaryDocs || []).forEach((p, i) => {
    const isReg = isRegistryDocType(p.docType, p.name);
    sections.push({
      kind: isReg ? 'registry' : 'primary',
      label: (isReg ? 'Реестр: ' : 'Первичный документ ' + (i + 1) + ': ') + (p.name || ''),
      docType: p.docType, docDate: p.date, recipient: p.recipient,
      seller: { name: null, inn: p.inn_supplier }, buyer: {},
      items: (p.items || []).map(it => ({ name: it.name, unit: it.unit, qty: it.qty, price: it.price, amount: it.amountNoVat, vatRate: it.vatRate, vat_amount: it.vat, total: it.amountWithVat })),
      totals: { amount_no_vat: p.total?.amountNoVat, vat_amount: p.total?.vat, amount_with_vat: p.total?.amountWithVat, qty_total: p.total?.qty },
      docIssues: p.issues || [],
      // Для реестра добавляем данные сверки
      registryCheck: isReg ? data._registryCheck : undefined,
    });
  });

  if (data.aggregate) {
    const agg = data.aggregate;
    sections.push({
      kind: 'aggregate', label: 'По сумме первичных документов',
      items: (agg.items || []).map(it => ({ name: it.name, unit: it.unit, qty: it.qty, amount: it.amountNoVat, vat_amount: it.vat, total: it.amountWithVat })),
      totals: { amount_no_vat: agg.total?.amountNoVat, vat_amount: agg.total?.vat, amount_with_vat: agg.total?.amountWithVat, qty_total: agg.total?.qty },
      compareWith: data.paymentDoc?.total ? { amount_no_vat: data.paymentDoc.total.amountNoVat, vat_amount: data.paymentDoc.total.vat, amount_with_vat: data.paymentDoc.total.amountWithVat } : null,
    });
  }

  (data.extraDocs || []).forEach(e => {
    sections.push({
      kind: 'extra', label: (e.name || e.docType || 'Доп. документ'),
      docType: e.docType || 'other', docDate: e.date, validUntil: e.expiryDate,
      productName: e.productName, hasStamp: e.hasStamp, hasSignature: e.hasSignature,
      matchesContract: e.matchesContract, docIssues: e.issues || [], items: [], totals: {},
    });
  });

  return sections;
}
