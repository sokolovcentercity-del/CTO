const PREVIEW_MODEL_ID = 'a077725a-e4eb-4bb1-8092-8eaa4f209c2c'; // Claude 4.5 Haiku
const HANDLER_URL = 'https://mto-cto.falcon28.ru/doc-checker/api/handler.php';
const CONTRACT_NAME_RE = /(договор|контракт|contract)/i;

const SYSTEM_PROMPT = `Ты анализируешь договор поставки / контракт / приложение со спецификацией и должен вернуть данные для карточки контракта.

Верни ТОЛЬКО валидный JSON без markdown и пояснений.

Формат ответа:
{
  "confidence": "high|medium|low",
  "summary": "короткое резюме 1-2 предложения",
  "contractPatch": {
    "number": "строка или null",
    "title": "строка или null",
    "date": "YYYY-MM-DD или null",
    "totalPrice": number | null,
    "advancePercent": number | null,
    "supplierName": "строка или null",
    "customerName": "строка или null",
    "customerSignerRole": "строка или null",
    "customerSignerName": "строка или null",
    "customerSignerBasis": "строка или null",
    "supplierSignerRole": "строка или null",
    "supplierSignerName": "строка или null",
    "supplierSignerBasis": "строка или null"
  },
  "executionPolicy": {
    "usesReadiness": true | false | null,
    "routeWhenReady": "direct" | "warehouse" | "manual" | null,
    "routeWhenNotReady": "direct" | "warehouse" | "manual" | null,
    "scenarioWhenReady": "full" | "split" | null,
    "scenarioWhenNotReady": "full" | "split" | null,
    "stage1Percent": number | null,
    "stage2Percent": number | null,
    "requireNotReadyAct": true | false | null,
    "requireReadyAct": true | false | null,
    "hasAdvance": true | false | null,
    "advancePercent": number | null,
    "advanceOffsetMode": "sequential" | "proportional" | "manual" | null
  },
  "products": [
    {
      "name": "строка",
      "specificationName": "строка или null",
      "code": "строка или null",
      "unit": "строка или null",
      "qty": number | null,
      "price": number | null,
      "assembly": "required|not_required",
      "specs": [
        { "param": "строка", "unit": "строка", "value": "строка" }
      ]
    }
  ],
  "evidence": ["короткие цитаты/выводы из договора"],
  "warnings": ["что осталось неоднозначным"]
}

Правила интерпретации схемы исполнения и оплаты:
- direct = поставка сразу получателю / на объект / в образовательную организацию.
- warehouse = поставка на склад / на адрес склада заказчика.
- manual = маршрут не зафиксирован однозначно или договор допускает разные варианты без приоритета.
- full = один полный платёж / 100% по сценарию.
- split = этапная схема с двумя этапами оплаты.
- usesReadiness = true только если готовность места эксплуатации реально влияет на маршрут, этап оплаты или пакет документов.
- requireNotReadyAct = true, если для сценария неготовности нужен отдельный акт/подтверждение неготовности.
- requireReadyAct = true, если финальный этап оплаты или поставка завязаны на акт/подтверждение готовности места эксплуатации.
- advanceOffsetMode указывай только если это можно определить из текста. Если неясно — null.
- Если поле нельзя определить надёжно, ставь null, не выдумывай.
- Если в договоре указаны проценты этапов, верни их числами без знака %.
- Если аванс указан в процентах или его можно надёжно вычислить из текста договора, верни advancePercent числом.
- customerName / customerSignerRole / customerSignerName / customerSignerBasis и supplierSignerRole / supplierSignerName / supplierSignerBasis бери из преамбулы договора и блока подписей, если они явно указаны.
- supplierName — это юридическое наименование подрядчика/поставщика. customerName — юридическое наименование заказчика.

Правила извлечения товаров:
- products — это товары/позиции из договора, спецификации, приложения 1/2, перечня объектов закупки.
- КАЖДАЯ самостоятельная позиция товара должна быть отдельным объектом массива.
- Не добавляй category и productGroup — их пользователь определяет вручную.
- name — официальное наименование позиции.
- specificationName — наименование позиции так, как оно записано в спецификации/приложении. Если отдельного варианта нет, можно повторить name.
- code — код позиции/товара/артикул только если он реально указан в документе. Иначе null.
- unit — единица измерения, если указана (шт, комплект, набор и т.д.). Иначе null.
- qty — количество по позиции, если указано. Иначе null.
- price — цена за единицу по позиции, если указана. Иначе null.
- assembly = "required", если есть монтаж/установка/пусконаладка/сборка; иначе "not_required".
- specs — извлеки характеристики товара в формате param/unit/value.
- Если характеристик нет, верни пустой массив.
- Не дублируй одинаковый товар по нескольким страницам, если это одна и та же позиция.
- Если есть несколько разных позиций с похожими именами, верни каждую отдельно.
- Если список товаров в документе не найден, верни products: [].`;

function isPreviewAIAvailable() {
  return typeof window !== 'undefined'
    && !!window.miniappsAI
    && typeof window.miniappsAI.callModel === 'function'
    && typeof window.miniappsAI.uploadFile === 'function';
}

function extractResponseText(response) {
  return response?.text
    || response?.choices?.[0]?.message?.content
    || response?.result?.alternatives?.[0]?.message?.text
    || response?.content?.[0]?.text
    || '';
}

function normalizePercent(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  return Math.max(0, Math.min(100, parsed));
}

function normalizeMoney(value) {
  if (value == null || value === '') return null;
  const parsed = Number(String(value).replace(/\s+/g, '').replace(',', '.'));
  if (!Number.isFinite(parsed)) return null;
  return Math.round(parsed * 100) / 100;
}

function normalizeEnum(value, allowed = []) {
  return allowed.includes(value) ? value : null;
}

function normalizeDate(value) {
  const str = String(value || '').trim();
  if (!str) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return null;
}

function normalizeSpecs(specs) {
  if (!Array.isArray(specs)) return [];
  return specs
    .map((spec) => ({
      param: String(spec?.param || '').trim(),
      unit: String(spec?.unit || '').trim(),
      value: String(spec?.value || '').trim(),
    }))
    .filter((spec) => spec.param || spec.value)
    .slice(0, 80);
}

function normalizeProducts(products) {
  if (!Array.isArray(products)) return [];
  const seen = new Set();
  return products
    .map((product) => ({
      name: String(product?.name || '').trim(),
      specificationName: String(product?.specificationName || '').trim() || null,
      code: String(product?.code || '').trim() || null,
      unit: String(product?.unit || '').trim() || null,
      qty: product?.qty == null || product?.qty === '' ? null : Math.max(0, Number(product.qty) || 0),
      price: normalizeMoney(product?.price),
      assembly: product?.assembly === 'required' ? 'required' : 'not_required',
      specs: normalizeSpecs(product?.specs),
    }))
    .filter((product) => product.name)
    .filter((product) => {
      const key = [
        product.name.toLowerCase(),
        String(product.specificationName || '').toLowerCase(),
        String(product.code || '').toLowerCase(),
        String(product.qty ?? ''),
        String(product.price ?? ''),
      ].join('||');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 200);
}

function normalizeResult(payload, fileName, extraWarnings = []) {
  const policy = payload?.executionPolicy || {};
  const patch = payload?.contractPatch || {};
  return {
    fileName,
    confidence: normalizeEnum(payload?.confidence, ['high', 'medium', 'low']) || 'medium',
    summary: String(payload?.summary || '').trim(),
    contractPatch: {
      number: String(patch?.number || '').trim() || null,
      title: String(patch?.title || '').trim() || null,
      date: normalizeDate(patch?.date),
      totalPrice: normalizeMoney(patch?.totalPrice),
      advancePercent: normalizePercent(patch?.advancePercent),
      supplierName: String(patch?.supplierName || '').trim() || null,
      customerName: String(patch?.customerName || '').trim() || null,
      customerSignerRole: String(patch?.customerSignerRole || '').trim() || null,
      customerSignerName: String(patch?.customerSignerName || '').trim() || null,
      customerSignerBasis: String(patch?.customerSignerBasis || '').trim() || null,
      supplierSignerRole: String(patch?.supplierSignerRole || '').trim() || null,
      supplierSignerName: String(patch?.supplierSignerName || '').trim() || null,
      supplierSignerBasis: String(patch?.supplierSignerBasis || '').trim() || null,
    },
    executionPolicy: {
      usesReadiness: typeof policy.usesReadiness === 'boolean' ? policy.usesReadiness : null,
      routeWhenReady: normalizeEnum(policy.routeWhenReady, ['direct', 'warehouse', 'manual']),
      routeWhenNotReady: normalizeEnum(policy.routeWhenNotReady, ['direct', 'warehouse', 'manual']),
      scenarioWhenReady: normalizeEnum(policy.scenarioWhenReady, ['full', 'split']),
      scenarioWhenNotReady: normalizeEnum(policy.scenarioWhenNotReady, ['full', 'split']),
      stage1Percent: normalizePercent(policy.stage1Percent),
      stage2Percent: normalizePercent(policy.stage2Percent),
      requireNotReadyAct: typeof policy.requireNotReadyAct === 'boolean' ? policy.requireNotReadyAct : null,
      requireReadyAct: typeof policy.requireReadyAct === 'boolean' ? policy.requireReadyAct : null,
      hasAdvance: typeof policy.hasAdvance === 'boolean' ? policy.hasAdvance : null,
      advancePercent: normalizePercent(policy.advancePercent),
      advanceOffsetMode: normalizeEnum(policy.advanceOffsetMode, ['sequential', 'proportional', 'manual']),
    },
    products: normalizeProducts(payload?.products),
    evidence: Array.isArray(payload?.evidence)
      ? payload.evidence.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
      : [],
    warnings: [
      ...extraWarnings,
      ...(Array.isArray(payload?.warnings)
        ? payload.warnings.map(item => String(item || '').trim()).filter(Boolean).slice(0, 8)
        : []),
    ],
  };
}

function parseJsonLoose(raw) {
  if (!raw) return null;
  const text = String(raw).trim();
  const attempts = [
    text,
    text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim(),
  ];

  for (const candidate of attempts) {
    try {
      return JSON.parse(candidate);
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }
  return null;
}

function pickContractDocument(files) {
  const validFiles = (Array.isArray(files) ? files : []).filter(file => file?.dataUrl);
  if (!validFiles.length) return { file: null, warnings: [] };

  const byName = validFiles.find(file => CONTRACT_NAME_RE.test(String(file.originalName || '')));
  if (byName) {
    const warnings = validFiles.length > 1
      ? ['Для автозаполнения выбран файл, наиболее похожий на договор: ' + (byName.originalName || 'без имени')]
      : [];
    return { file: byName, warnings };
  }

  return {
    file: validFiles[0],
    warnings: validFiles.length > 1
      ? ['Файл договора не удалось определить по имени. Для анализа взят первый загруженный файл.']
      : [],
  };
}

function dataUrlToParts(dataUrl) {
  const [header, base64] = String(dataUrl || '').split(',', 2);
  const mimeType = header?.match(/^data:([^;]+);base64$/i)?.[1] || 'application/octet-stream';
  return { mimeType, base64: base64 || '' };
}

function base64ToUint8Array(base64) {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function dataUrlToFile(record) {
  const { mimeType, base64 } = dataUrlToParts(record?.dataUrl || '');
  const bytes = base64ToUint8Array(base64);
  return new File([bytes], record?.originalName || 'contract-document', {
    type: record?.mimeType || mimeType || 'application/octet-stream',
    lastModified: Date.now(),
  });
}

function buildUserPrompt(context = {}) {
  const contractNumber = String(context.contractNumber || '').trim();
  const contractTitle = String(context.contractTitle || '').trim();
  const totalPrice = Number(context.totalPrice) || 0;
  const lines = [
    'Определи реквизиты договора, схему исполнения/оплаты и товары из загруженного документа.',
    'Нужен только JSON указанного формата.',
    'Если документ содержит перечень товаров, верни их в products.',
    'Если товаров в документе нет или это не договор/спецификация, верни products: [].',
  ];
  if (contractNumber) lines.push('Номер контракта в карточке: ' + contractNumber);
  if (contractTitle) lines.push('Наименование контракта в карточке: ' + contractTitle);
  if (totalPrice > 0) lines.push('Цена контракта в карточке: ' + totalPrice);
  lines.push('Если проценты, дата, сумма, поставщик или логика указаны неоднозначно, ставь null и перечисли сомнения в warnings.');
  return lines.join('\n');
}

async function callPreviewModel(record, context) {
  const file = dataUrlToFile(record);
  const uploaded = await window.miniappsAI.uploadFile(file, { persistence: 'temporary' });
  const result = await window.miniappsAI.callModel({
    modelId: PREVIEW_MODEL_ID,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      {
        role: 'user',
        content: [
          { type: 'file_id', fileId: uploaded.fileId },
          { type: 'text', text: buildUserPrompt(context) },
        ],
      },
    ],
    timeoutMs: 120000,
  });
  return window.miniappsAI.extractText(result).trim();
}

async function callServerModel(record, context) {
  const { mimeType, base64 } = dataUrlToParts(record?.dataUrl || '');
  const response = await fetch(HANDLER_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'extract_and_analyze',
      base64,
      mediaType: record?.mimeType || mimeType,
      filename: record?.originalName || 'contract-document',
      system: SYSTEM_PROMPT,
      userPrefix: buildUserPrompt(context),
      max_tokens: 9000,
    }),
  });

  const text = await response.text();
  let payload = null;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error('Сервер вернул не JSON при анализе договора.');
  }
  if (!response.ok || payload?.error) {
    throw new Error(payload?.error || ('HTTP ' + response.status));
  }
  return extractResponseText(payload).trim();
}

export async function autofillContractExecutionPolicyFromDocument(files, context = {}) {
  const { file, warnings } = pickContractDocument(files);
  if (!file) {
    throw new Error('Сначала загрузите файл договора в карточку контракта.');
  }

  const fileName = String(file.originalName || '').trim() || 'contract-document';
  const lowerName = fileName.toLowerCase();
  if (lowerName.endsWith('.doc')) {
    warnings.push('Старый формат .doc может читаться неточно. По возможности используйте .docx или PDF.');
  }

  const raw = isPreviewAIAvailable()
    ? await callPreviewModel(file, context)
    : await callServerModel(file, context);

  const parsed = parseJsonLoose(raw);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Не удалось распознать договор: модель не вернула ожидаемый JSON.');
  }

  return normalizeResult(parsed, fileName, warnings);
}
