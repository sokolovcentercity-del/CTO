/**
 * ui/simple-check-view.js
 * Экспертная AI-проверка пакета документов.
 * Pipeline: оценка пакета → один запрос или чанкование (Фаза1 извлечение + Фаза2 анализ).
 */

const MODELS = [
  // ── Claude ────────────────────────────────────────────────────────
  { id: 'dff00172-6a1a-484f-bf21-7877b8701192', title: '🥇 Claude 4.8 Opus Thinking — Максимальное качество',  cost: 53, group: 'Claude' },
  { id: '57ad8916-300b-4d76-ba9d-a949225527de', title: '🏆 Claude 4.8 Opus — Высокое качество',               cost: 33, group: 'Claude' },
  { id: 'c27a2c4a-9a24-4a51-868b-86879d10ecea', title: '🥇 Claude 4.7 Opus Thinking',                          cost: 53, group: 'Claude' },
  { id: '3bc7531c-9e64-4361-9fa2-d12641beb2f5', title: '🏆 Claude 4.7 Opus',                                   cost: 33, group: 'Claude' },
  { id: '71d87f73-d001-4081-b19a-52eb97db826b', title: '⚡ Claude 4.6 Sonnet Thinking',                        cost: 33, group: 'Claude' },
  { id: '717c456f-023a-4fca-b956-dd8404e87028', title: '⚡ Claude 4.6 Sonnet — Баланс цены/качества',          cost: 21, group: 'Claude' },
  { id: '493f4ca3-9243-4c25-b553-a6bd73f67f1e', title: '⚡ Claude 4.5 Sonnet Thinking',                        cost: 30, group: 'Claude' },
  { id: '90fda230-de04-4133-8b34-b989d564925e', title: '⚡ Claude 4.5 Sonnet',                                  cost: 20, group: 'Claude' },
  { id: '1ac1417f-3532-4f76-8584-be1ce02149d1', title: '🐇 Claude 4.5 Haiku Thinking',                         cost: 15, group: 'Claude' },
  { id: 'a077725a-e4eb-4bb1-8092-8eaa4f209c2c', title: '🐇 Claude 4.5 Haiku — Быстро и дёшево',               cost: 11, group: 'Claude' },
  // ── GPT / OpenAI ──────────────────────────────────────────────────
  { id: 'e2a8979e-89a0-42d3-9b4f-52d80659862b', title: '🥇 GPT 5.5 Extra High — Максимум',                    cost: 61, group: 'GPT' },
  { id: 'c5ccec97-5c84-4512-8f2a-5b5cf29c871e', title: '🏆 GPT 5.5 High',                                     cost: 49, group: 'GPT' },
  { id: 'a469b0b8-ae6a-46d2-90ed-04340e82f1ca', title: '⚡ GPT 5.5',                                           cost: 37, group: 'GPT' },
  { id: '82a2d3dd-caaa-4de3-9786-63020f5463dd', title: '⚡ GPT 5.4',                                           cost: 26, group: 'GPT' },
  { id: '3f751d0c-8950-400d-be77-0947675a5aad', title: '⚡ GPT 5.1',                                           cost: 15, group: 'GPT' },
  { id: '550d44cb-692a-4dbb-9e35-bd23b949882c', title: '⚡ GPT 5',                                             cost: 15, group: 'GPT' },
  { id: '5518fc36-32e0-4d40-ba29-e0f8e5df0773', title: '🐇 GPT 5 Mini',                                       cost:  5, group: 'GPT' },
  { id: '46a1cd9e-4bf6-4b67-94e7-65cb878adbad', title: '⚡ GPT 4.1',                                           cost: 12, group: 'GPT' },
  { id: 'd158fc36-32e0-4d40-ba29-e0f8e5df0773', title: '🐇 GPT 4.1 Mini',                                     cost:  5, group: 'GPT' },
  // ── Gemini ────────────────────────────────────────────────────────
  { id: 'c7a13677-668e-4192-b460-72af359d9694', title: '🏆 Gemini 3.1 Pro Preview — Лучший контекст',          cost: 20, group: 'Gemini' },
  { id: 'ab52be19-0888-4937-8295-6d622fb2bf31', title: '⚡ Gemini 3.1 Flash Lite',                             cost:  3, group: 'Gemini' },
  { id: '8f6f2617-d66c-4266-8c2a-80cb8eaf6d43', title: '⚡ Gemini 3.5 Flash',                                  cost: 15, group: 'Gemini' },
  { id: '98b5fa95-6d47-4324-a337-71ada95c7d46', title: '🏆 Gemini 2.5 Pro',                                    cost: 20, group: 'Gemini' },
  { id: '58c5cf60-bab0-44aa-b8d7-4a8913655263', title: '⚡ Gemini 2.5 Flash Thinking',                         cost:  9, group: 'Gemini' },
  { id: '83980b26-79ba-4962-831f-8c1dc91a531a', title: '⚡ Gemini 2.5 Flash',                                   cost:  5, group: 'Gemini' },
  { id: '216c7791-6f34-4473-81f3-5bb54c22db95', title: '🐇 Gemini 2.5 Flash-Lite Thinking',                   cost:  2, group: 'Gemini' },
  { id: '7d2c89e7-5ee2-4360-8f63-b784c1d2150e', title: '🐇 Gemini 2.5 Flash-Lite',                            cost:  1, group: 'Gemini' },
  // ── Grok ──────────────────────────────────────────────────────────
  { id: '69a85cce-33bf-4e28-8a43-7be9929e3a61', title: '🏆 Grok 4 — Высокое качество',                        cost: 30, group: 'Grok' },
  { id: '4d59f2b4-be68-470c-9811-46f9058b7318', title: '⚡ Grok 4.3',                                          cost:  9, group: 'Grok' },
  { id: '5888b60f-6115-4051-a698-f8354374ec50', title: '⚡ Grok 3',                                            cost: 20, group: 'Grok' },
  // ── DeepSeek / MiniMax / Kimi ─────────────────────────────────────
  { id: '0645fc28-c494-445f-9017-bced65fc3ea2', title: '⚡ DeepSeek V4 Pro',                                   cost:  4, group: 'DeepSeek' },
  { id: 'f07abe4e-aa96-4e38-947f-426adc3dbf4e', title: '🐇 DeepSeek V4 Flash',                                cost:  1, group: 'DeepSeek' },
  { id: 'dc2db118-7888-466a-a8d1-bf9d96bab4b6', title: '🐇 DeepSeek V4 Flash Instant — Экономично',           cost:  1, group: 'DeepSeek' },
  { id: '4f4b11fc-e2af-4024-92a2-9dd7e7b08cb4', title: '⚡ MiniMax M3',                                       cost:  4, group: 'MiniMax' },
  { id: 'c651e4f7-0461-4281-b1d9-aa12d49fc390', title: '🐇 MiniMax M2',                                       cost:  1, group: 'MiniMax' },
  { id: '3bdae49d-a688-463a-b1b0-57d095854998', title: '⚡ Kimi K2.5',                                         cost:  8, group: 'Kimi' },
  { id: '9df75fb4-e616-4996-bbda-50e24a64fe8d', title: '⚡ Kimi K2.6',                                         cost: 10, group: 'Kimi' },
];

const ZONES = [
  { id: 1, role: 'ДОКУМЕНТ НА ОПЛАТУ (основание для оплаты поставщику)' },
  { id: 2, role: 'ДОГОВОР И ТЕХНИЧЕСКОЕ ЗАДАНИЕ (эталон для сверки)' },
  { id: 3, role: 'ПЕРВИЧНЫЙ ДОКУМЕНТ (подтверждает фактическую поставку получателю)' },
  { id: 4, role: 'ДОПОЛНИТЕЛЬНЫЙ ДОКУМЕНТ (акт проверки, сертификат, претензия, гарантия)' },
];

// ── Лимиты контекста моделей (в токенах) ────────────────────────
// Используется для выбора стратегии: один запрос или чанки
const MODEL_CONTEXT_LIMITS = {
  // Claude
  'dff00172-6a1a-484f-bf21-7877b8701192': 200000, // Opus Thinking
  '57ad8916-300b-4d76-ba9d-a949225527de': 200000, // Opus
  'c27a2c4a-9a24-4a51-868b-86879d10ecea': 200000,
  '3bc7531c-9e64-4361-9fa2-d12641beb2f5': 200000,
  '71d87f73-d001-4081-b19a-52eb97db826b': 200000,
  '717c456f-023a-4fca-b956-dd8404e87028': 200000,
  '493f4ca3-9243-4c25-b553-a6bd73f67f1e': 200000,
  '90fda230-de04-4133-8b34-b989d564925e': 200000,
  '1ac1417f-3532-4f76-8592-8eaa4f209c2c': 200000,
  'a077725a-e4eb-4bb1-8092-8eaa4f209c2c': 200000,
  // GPT
  'e2a8979e-89a0-42d3-9b4f-52d80659862b': 128000,
  'c5ccec97-5c84-4512-8f2a-5b5cf29c871e': 128000,
  'a469b0b8-ae6a-46d2-90ed-04340e82f1ca': 128000,
  '82a2d3dd-caaa-4de3-9786-63020f5463dd': 128000,
  '3f751d0c-8950-400d-be77-0947675a5aad': 128000,
  '550d44cb-692a-4dbb-9e35-bd23b949882c': 128000,
  '5518fc36-32e0-4d40-ba29-e0f8e5df0773': 128000,
  '46a1cd9e-4bf6-4b67-94e7-65cb878adbad': 128000,
  'd158fc36-32e0-4d40-ba29-e0f8e5df0773': 128000,
  // Gemini
  'c7a13677-668e-4192-b460-72af359d9694': 1000000, // 2.0 Pro
  'ab52be19-0888-4937-8295-6d622fb2bf31': 1000000,
  '8f6f2617-d66c-4266-8c2a-80cb8eaf6d43': 1000000,
  '98b5fa95-6d47-4324-a337-71ada95c7d46': 1000000,
  '58c5cf60-bab0-44aa-b8d7-4a8913655263': 1000000,
  '83980b26-79ba-4962-831f-8c1dc91a531a': 1000000,
  '216c7791-6f34-4473-81f3-5bb54c22db95': 1000000,
  '7d2c89e7-5ee2-4360-8f63-b784c1d2150e': 1000000,
  // Grok
  '69a85cce-33bf-4e28-8a43-7be9929e3a61': 128000,
  '4d59f2b4-be68-470c-9811-46f9058b7318': 128000,
  '5888b60f-6115-4051-a698-f8354374ec50': 128000,
  // DeepSeek / MiniMax / Kimi
  '0645fc28-c494-445f-9017-bced65fc3ea2': 128000,
  'f07abe4e-aa96-4e38-947f-426adc3dbf4e': 128000,
  'dc2db118-7888-466a-a8d1-bf9d96bab4b6': 128000,
  '4f4b11fc-e2af-4024-92a2-9dd7e7b08cb4': 128000,
  'c651e4f7-0461-4281-b1d9-aa12d49fc390': 128000,
  '3bdae49d-a688-463a-b1b0-57d095854998': 128000,
  '9df75fb4-e616-4996-bbda-50e24a64fe8d': 128000,
};

// Промпт для Фазы 1: извлечение структурированных данных из одного файла
const EXTRACTION_PROMPT = `Ты — специалист по первичной бухгалтерской документации.
Тебе передан ОДИН документ. Извлеки из него структурированные данные в JSON.

ПРАВИЛА ДЛЯ ЧИСЕЛ:
- Записывай ВСЕ числа ТОЧНО как в документе, все знаки после запятой, без округления
- НЕ вычисляй одно поле из другого — переписывай значения из соответствующих колонок
- ОКПД2 коды (32.99.53.139) — код товара, НИКОГДА не цена/количество
- Пробелы в числах — разделители разрядов; запятая — десятичный разделитель
- PDF-парсер разбивает числа: «238 352,310» + «52699367» = 238352.31052699367

Верни ТОЛЬКО валидный JSON:
{
  "docType": "тип документа: upd|invoice|waybill|act|contract|certificate|warranty|registry|claim|other",
  "name": "наименование и номер",
  "date": "ДД.ММ.ГГГГ",
  "inn_supplier": "ИНН поставщика",
  "inn_buyer": "ИНН покупателя",
  "name_supplier": "наименование поставщика",
  "name_buyer": "наименование покупателя",
  "contract_ref": "ссылка на договор",
  "bank_account": "расчётный счёт поставщика если указан",
  "bank_bik": "БИК банка если указан",
  "field8": "поле (8) идентификатор госконтракта если есть",
  "waybillNum": "номер накладной (например 1/1) если это первичный документ",
  "items": [
    {
      "name": "наименование товара",
      "unit": "ед.изм",
      "qty": 0,
      "price": 0,
      "amountNoVat": 0,
      "vatRate": "22%, 20%, 10%, 0%, без НДС",
      "vat": 0,
      "amountWithVat": 0
    }
  ],
  "total": { "qty": 0, "amountNoVat": 0, "vat": 0, "amountWithVat": 0 },
  "registryItems": [
    { "waybillNum": "1/1", "waybillDate": "ДД.ММ.ГГГГ", "recipientName": "название", "recipientInn": "ИНН", "qty": 1, "price": 0, "amount": 0 }
  ],
  "expiryDate": "срок действия для сертификатов/деклараций",
  "productName": "наименование товара для сертификатов/гарантий",
  "hasStamp": null,
  "hasSignature": null,
  "issues": ["замечания видимые в документе"],
  "unreadable": "описание нечитаемых частей или null"
}
Если registryItems не применимы — верни [].
Отвечай ТОЛЬКО JSON, никакого текста вокруг.`;

// ── Системный промпт — полный, аналогичный core.js ────────────────
const SYSTEM_PROMPT = `Ты — опытный специалист по проверке первичной бухгалтерской документации
и документов в сфере государственных закупок (44-ФЗ).

Тебе передают пакет документов для проверки перед оплатой поставщику.
Документы распределены по зонам:
- ЗОНА 1: документ на оплату (УПД, счёт, счёт-фактура или аналог)
- ЗОНА 2: договор и техническое задание (эталон для сверки реквизитов, наименований, цен)
- ЗОНА 3: первичная документация (товарные накладные, акты ввода в эксплуатацию, ТОРГ-12, ТТН, а также реестры УПД/актов/накладных)
- ЗОНА 3: первичная документация (товарные накладные, акты ввода в эксплуатацию, ТОРГ-12, ТТН); реестр загружается сюда же, но является контрольным документом-сводкой, а НЕ первичным
- ЗОНА 4: дополнительные документы (акты проверок, акты комиссии по приёмке, претензии, сертификаты, декларации, гарантийные талоны, служебные записки)

ОБЯЗАТЕЛЬНЫЙ ФОРМАТ ОТВЕТА: верни ТОЛЬКО валидный JSON без markdown-блоков, без пояснений до и после.

СТРУКТУРА JSON:
ПЕРВОЕ ПОЛЕ — receivedFiles[]. Перечисли КАЖДЫЙ переданный тебе файл, без исключений:
{
  "receivedFiles": [
    {
      "filename": "точное имя файла как передано",
      "zone": 1,
      "status": "ok | unreadable | empty | partial",
      "docType": "определённый тип документа или null если нечитаем",
      "comment": "пояснение если status != ok, иначе null"
    }
  ],
  "paymentDoc": {
    "docType": "тип документа",
    "name": "наименование и номер документа",
    "date": "дата ДД.ММ.ГГГГ",
    "inn_supplier": "ИНН поставщика", "name_supplier": "наименование поставщика",
    "inn_buyer": "ИНН покупателя",    "name_buyer": "наименование покупателя",
    "contract_ref": "ссылка на договор (номер, дата)",
    "items": [
      {
        "name": "наименование товара", "unit": "ед.изм",
        "qty": 0, "price": 0, "amountNoVat": 0,
        "vatRate": "ставка НДС: 22%, 20%, 10%, 0%, без НДС",
        "vat": 0, "amountWithVat": 0, "comments": "доп. сведения"
      }
    ],
    "total": { "qty": число, "amountNoVat": число, "vat": число, "amountWithVat": число }
  },
  "contract": {
    "found": true,
    "number": "номер договора", "date": "дата договора",
    "inn_supplier": "ИНН поставщика по договору",
    "inn_buyer": "ИНН покупателя по договору",
    "totalAmount": null, "advancePct": null, "deliveryDeadline": "срок поставки",
    "items": [{ "name": "наименование по договору/ТЗ", "qty": null, "price": null }]
  },
  "primaryDocs": [
    {
      "docType": "тип документа",
      "name": "наименование и номер документа",
      "date": "дата ДД.ММ.ГГГГ",
      "recipient": "наименование и адрес получателя",
      "inn_supplier": "ИНН поставщика если указан",
      "items": [{ "name": "наименование", "unit": "ед.изм", "qty": null, "price": null, "amountNoVat": null, "vatRate": "22%, 20%, 10%, 0% или без НДС", "vat": null, "amountWithVat": null }],
      "total": { "qty": число, "amountNoVat": число, "vat": число, "amountWithVat": число },
      "waybillNum": "номер накладной этого документа (например 1/1) — только для первичных, не реестров",
      "registryItems": [ { "waybillNum": "1/1", "waybillDate": "ДД.ММ.ГГГГ", "recipientName": "название получателя", "recipientInn": "ИНН", "qty": 1, "price": 0, "amount": 0 } ]
    }
  ],
  "aggregate": {
    "items": [{ "name": "наименование", "unit": "ед.изм", "qty": 0, "amountNoVat": 0, "vat": 0, "amountWithVat": 0 }],
    "total": { "qty": число, "amountNoVat": число, "vat": число, "amountWithVat": число }
  },
  "comparison": {
    "qtyMatch": true, "amountNoVatMatch": true, "vatMatch": true, "amountWithVatMatch": true,
    "diff_qty": 0, "diff_amountNoVat": 0, "diff_vat": 0, "diff_amountWithVat": 0,
    "problematicDocs": ["список первичных с расхождениями"],
    "recommendation": "рекомендация: что скорректировать"
  },
  "extraDocs": [
    {
      "docType": "тип (Сертификат / Декларация / Гарантийный талон / Акт комиссии / Претензия и т.д.)",
      "name": "наименование документа", "date": "дата или null",
      "expiryDate": "срок действия или null",
      "productName": "наименование товара или null",
      "qty": "количество или null",
      "hasStamp": null, "hasSignature": null, "matchesContract": null,
      "items": [],
      "total": { "qty": null },
      "issues": ["список замечаний"]
    }
  ],
  "chronology": [
    { "date": "ДД.ММ.ГГГГ", "docName": "наименование документа", "event": "краткое описание" }
  ],
  "rekvizity": {
    "supplierInnConsistent": true, "buyerInnConsistent": true, "supplierNameConsistent": true,
    "inconsistencies": ["описание расхождений"]
  },
  "unreadableData": [
    { "docName": "документ", "location": "место", "description": "что нечитаемо" }
  ],
  "violations": [
    {
      "severity": "critical|significant|minor",
      "category": "суммы|реквизиты|хронология|наименования|подписи|сертификаты|претензии|прочее",
      "docName": "документ где нарушение",
      "text": "подробное описание с конкретными числами, датами, полями"
    }
  ],
  "conclusion": "итоговое заключение текстом",
  "actionRequired": ["действие 1", "действие 2"]
}

ПРАВИЛА РАБОТЫ С ЧИСЛАМИ:
⚠️ КРИТИЧЕСКИ ВАЖНО — ЧИСЛА:
Отклонение даже на 0,01 руб. БЛОКИРУЕТ ОПЛАТУ. Поиск таких отклонений — главная задача.
- Записывай ВСЕ числа ТОЧНО как в документе, ВСЕ знаки после запятой, БЕЗ округления
- Цена 238352,3105269937 → пиши 238352.3105269937 (НЕ 238352.31, НЕ 238352.310527)
- Цена 290789,8188429323 → пиши 290789.8188429323 (НЕ 290789.82)
- НЕ вычисляй одно поле из другого — переписывай значение из соответствующей колонки документа
- amountNoVat = значение из колонки «Стоимость без НДС» документа (даже если не равно qty×price)
- vat = значение из колонки «НДС» документа (даже если не равно amountNoVat×ставка)
- amountWithVat = значение из колонки «Стоимость с НДС» документа (даже если не равно сумме)
- Если в документе qty=7, price=5, amountNoVat=34 — запиши 34. Расхождение будет выявлено JS-проверкой.
- ОКПД2 коды (32.99.53.139) — код товара, НИКОГДА не цена/количество
- Пробелы в числах — разделители разрядов; запятая — десятичный разделитель
- PDF-парсер разбивает числа: «238 352,310» + «52699367» = 238352.31052699367 (одно число)

ПРАВИЛА АНАЛИЗА:

0. РЕЕСТРЫ (реестр УПД / реестр актов / реестр накладных)
   - Реестр — это НЕ первичный документ. Это сводный список первичных документов.
   - Реестр НЕ подтверждает факт поставки самостоятельно и НЕ включается в расчёт итоговых сумм при сверке с документом на оплату.
   - Реестр используется ТОЛЬКО для перекрёстной проверки: каждая строка реестра должна соответствовать отдельному первичному документу из пакета.
   - Проверь каждую строку реестра: номер документа, дата, наименование получателя, количество, сумма — должны совпадать с соответствующим первичным документом.
   - Если первичный документ из реестра отсутствует в пакете — это значимое нарушение (significant): «Первичный документ [номер/дата] из реестра не представлен в пакете».
   - Если данные в строке реестра расходятся с данными первичного документа — нарушение соответствующей степени.
   - Итоговая строка реестра (если есть) должна равняться сумме всех строк реестра.
   - В JSON реестр помещается в primaryDocs с docType="registry"; в aggregate его суммы НЕ включаются.
   - ОБЯЗАТЕЛЬНО: для каждого реестра извлекай массив registryItems[] — каждая строка реестра:
     { "waybillNum": "1/1", "waybillDate": "13.01.2026", "recipientName": "ГБОУ Школа №...", "recipientInn": "7736212529", "qty": 1, "price": 290789.81884293228, "amount": 290789.81884293228 }
   - waybillNum — номер накладной из столбца «Накладная → Номер» (например «1/1», «1/2»)
   - Для каждого первичного документа (не реестра) обязательно указывай waybillNum — номер этого документа (например «1/1»)

1. РЕКВИЗИТЫ
   - ИНН поставщика и покупателя должны совпадать во всех документах
   - Наименования организаций должны совпадать (с учётом допустимых сокращений)
   - Банковские реквизиты (р/с, БИК, корсчёт, банк) должны совпадать во всех УПД одного поставщика; расхождение — significant
   - В УПД проверь поле (8) «Идентификатор государственного контракта»: если поставка по госконтракту — поле должно быть заполнено; пустое «--» или «0» — significant

2. СУММЫ
   - Арифметика внутри каждого документа: qty × price = amountNoVat
   - Сумма всех первичных (зона 3) должна равняться сумме документа на оплату (зона 1)
   - Укажи конкретно: в каком первичном документе и на какую сумму расхождение
   - Допустимые ставки НДС: 22% (базовая с 01.01.2025), 20% (до 2025), 10%, 0%, без НДС. Ставка 22% — НЕ нарушение. Ставки вне этого списка — significant

3. ХРОНОЛОГИЯ
   - Первичные документы не могут быть датированы позже документа на оплату
   - Акт проверки должен быть датирован после поставки; сертификаты не должны быть просрочены
   - Проверяй даты ВНУТРИ одного документа: если в вводной части и в заключении акта разные даты договора — это нарушение (significant)
   - Проверяй ВНУТРЕННЮЮ СОГЛАСОВАННОСТЬ каждого документа: одна и та же дата, номер договора, ИНН, наименование должны совпадать во всех частях документа (вводная часть, таблица, заключение, строка подписи, печать). Расхождение внутри одного документа — significant

4. НАИМЕНОВАНИЯ
   - Перечисли ВСЕ варианты наименования одного товара из всех документов
   - Расхождения: minor если смысл совпадает; significant если может трактоваться иначе
   - Страна происхождения: если указана в одних документах — должна совпадать во всех

5. ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ (зона 4)
   - Акт комиссии: прочитай ВСЕ позиции (товар, количество); сравни каждую с документом на оплату
   - Позиции в акте, отсутствующие в документе на оплату — отметь отдельно
   - Гарантийный талон: сравни количество с документом на оплату; проверь срок гарантии
   - Сертификаты/декларации: срок действия, наличие печати/подписи, соответствие товара
   - Претензии: отражены ли в первичных документах и УПД

6. СТЕПЕНИ НАРУШЕНИЙ
   - critical: блокирует оплату (несоответствие итоговых сумм, неверный ИНН, отсутствие подписей/печатей)
   - significant: требует исправления до оплаты (хронология, расхождение наименований, арифметика, поле (8), банковские реквизиты)
   - minor: рекомендуется исправить (разные форматы наименования, разные коды товара)

9. АКТ ПЕРЕИМЕНОВАНИЯ / АКТ ПЕРЕВОДА НАИМЕНОВАНИЙ
   - Если в пакете присутствует документ типа «Акт переименования», «Акт перевода наименований» или аналог — учитывай его как разрешённый справочник соответствий наименований и ОБЯЗАТЕЛЬНО извлеки из него ВСЕ варианты наименования товара: по внутренней номенклатуре, по ТЗ/договору, по УПД, коды (артикулы, внутренние коды), цены
   - Для каждого другого документа пакета: если хотя бы ОДНО из наименований акта совпадает с наименованием в документе — это НОРМА, нарушение не фиксируй
   - Если НИ ОДНО из наименований акта переименования не совпадает ни с одним документом пакета — это significant нарушение: «Наименование товара в [документ] не совпадает ни с одним вариантом из акта переименования»
   - Расхождение цен между актом переименования и документом на оплату — critical
   - Включи акт переименования в extraDocs[] с docType="rename_act"; в items[] перечисли все варианты наименований

8. НЕЧИТАЕМЫЕ ДАННЫЕ — ОБЯЗАТЕЛЬНО заполняй поле unreadableData[] в следующих случаях:
   — Таблица или её часть не распознана (строки слились, числа смешались с кодами)
   — Конкретное поле документа нечитаемо (например: «кол-во в строке 3 нечитаемо из-за разрыва строки»)
   — Документ передан как пустой или почти пустой (менее 50 значимых символов) — PDF не распознан
   — OCR дал искажённый результат (буквы заменены цифрами или наоборот)
   — Поле содержит явный OCR-мусор (случайные символы, нечитаемые фрагменты)
   НЕ оставляй unreadableData пустым если хотя бы один из этих случаев имеет место.
   Для каждого нечитаемого места создай запись:
   { "docName": "имя файла или документа", "location": "стр.X / строка Y / колонка Z", "description": "что именно нечитаемо и почему" }
   И добавь в violations с severity="significant":
   { "severity": "significant", "category": "прочее", "docName": "имя файла", "text": "Документ [имя] не распознан / частично нечитаем: [описание]. Данные из него не могут быть использованы для сверки." }

7. ОБЯЗАТЕЛЬНЫЙ УЧЁТ ВСЕХ ФАЙЛОВ:
   - receivedFiles[] ДОЛЖЕН содержать ровно столько записей, сколько файлов тебе передано — не больше и не меньше
   - Если файл нечитаем, пустой или повреждён — всё равно включи его в receivedFiles[] со status="unreadable" или "empty"
   - Для каждого файла со status != "ok" добавь запись в unreadableData[] и нарушение в violations[] с severity="significant"
   - Молчать о проблемном файле НЕЛЬЗЯ — это вводит в заблуждение проверяющего
   - Если файл вообще не открылся или пришёл пустым — это critical нарушение: данные из него не могут быть использованы

Отвечай ТОЛЬКО JSON, никакого текста вокруг.`
;

// ── Вспомогательные функции для реестра ──────────────────────────
function isRegistryFile(file) {
  return /реестр/i.test(file.name.replace(/\.\w{2,5}$/i, ''));
}

function isRegistryDocType_sc(docType, name) {
  const dt = (docType || '').toLowerCase();
  const nm = (name || '').toLowerCase();
  return dt === 'registry' || dt.includes('реестр') ||
    nm.startsWith('реестр') || nm.includes('сводный реестр') ||
    nm.includes('реестр упд') || nm.includes('реестр накладных') ||
    nm.includes('реестр актов');
}

function normalizeDocKeySimple(name, date) {
  if (!name && !date) return null;
  const numMatch = String(name || '').match(/(?:№|#|N\s*|УПД\s*|накладная\s*|акт\s*)(\d[\d\-\/]*)/i);
  const num = numMatch ? numMatch[1].trim() : String(name || '').trim().slice(0, 30);
  const d = String(date || '').trim().slice(0, 10);
  if (!num && !d) return null;
  return (num + '|' + d).toLowerCase();
}

// ── Сверка реестра с первичными документами ───────────────────────
// Возвращает массив нарушений { severity, text }
function checkRegistryVsPrimaries(data) {
  const issues = [];
  const registries = (data.primaryDocs || []).filter(p => isRegistryDocType_sc(p.docType, p.name));
  if (!registries.length) return issues;

  // Собираем все первичные (не реестры) с их waybillNum
  const primaries = (data.primaryDocs || []).filter(p => !isRegistryDocType_sc(p.docType, p.name));

  // Нормализуем номер накладной для сравнения
  function normNum(s) {
    return String(s || '').replace(/\s/g, '').replace(/^№/, '').toLowerCase();
  }

  // Извлекаем waybillNum из имени документа (fallback если AI не вернул)
  function extractNumFromName(name) {
    const m = String(name || '').match(/[№#N]?\s*(\d[\d\/\-]*)/i);
    return m ? normNum(m[1]) : null;
  }

  registries.forEach(reg => {
    const regItems = reg.registryItems || [];
    if (!regItems.length) return; // AI не вернул строки — пропускаем JS-сверку

    // Карта первичных документов по нормализованному номеру накладной
    const primByNum = new Map();
    primaries.forEach(p => {
      const wn = p.waybillNum ? normNum(p.waybillNum) : extractNumFromName(p.name);
      if (wn) primByNum.set(wn, p);
    });

    const missingDocs = [];   // есть в реестре, не загружен
    const mismatchDocs = [];  // загружен, данные расходятся

    regItems.forEach(ri => {
      const rn = normNum(ri.waybillNum);
      if (!rn) return;
      const prim = primByNum.get(rn);

      if (!prim) {
        // Документ из реестра не загружен
        missingDocs.push(`№ ${ri.waybillNum}${ri.recipientName ? ' (' + ri.recipientName + ')' : ''}`);
        return;
      }

      // Сверяем qty
      const rQty = Number(ri.qty) || 0;
      const pQty = Number(prim.total?.qty) || 0;
      if (rQty > 0 && pQty > 0 && Math.abs(rQty - pQty) > 0.01) {
        mismatchDocs.push(`Накладная № ${ri.waybillNum}: кол-во в реестре ${rQty} ≠ в документе ${pQty}`);
      }

      // Сверяем сумму
      const rAmt = Number(ri.amount) || 0;
      const pAmt = Number(prim.total?.amountWithVat) || 0;
      if (rAmt > 0 && pAmt > 0 && Math.abs(rAmt - pAmt) > 0.02) {
        mismatchDocs.push(`Накладная № ${ri.waybillNum}: сумма в реестре ${fmtNum(rAmt)} ≠ в документе ${fmtNum(pAmt)}`);
      }

      // Сверяем ИНН получателя
      const rInn = String(ri.recipientInn || '').replace(/\D/g, '');
      const pInn = String(prim.inn_buyer || prim.recipientInn || '').replace(/\D/g, '');
      if (rInn && pInn && rInn !== pInn) {
        mismatchDocs.push(`Накладная № ${ri.waybillNum}: ИНН получателя в реестре ${rInn} ≠ в документе ${pInn}`);
      }
    });

    // Проверяем обратное: загружен документ, которого нет в реестре
    const regNums = new Set(regItems.map(ri => normNum(ri.waybillNum)).filter(Boolean));
    primaries.forEach(p => {
      const wn = p.waybillNum ? normNum(p.waybillNum) : extractNumFromName(p.name);
      if (wn && !regNums.has(wn)) {
        issues.push({ severity: 'significant', text: `Документ «${p.name || wn}» загружен в пакет, но отсутствует в реестре «${reg.name || 'Реестр'}»` });
      }
    });

    // Формируем нарушения
    if (missingDocs.length > 5) {
      issues.push({ severity: 'critical', text: `Реестр «${reg.name || ''}»: в пакете отсутствуют ${missingDocs.length} документов из ${regItems.length}. Первые: ${missingDocs.slice(0, 3).join(', ')} и др.` });
    } else {
      missingDocs.forEach(d => issues.push({ severity: 'critical', text: `Реестр «${reg.name || ''}»: накладная ${d} не загружена в пакет` }));
    }
    mismatchDocs.forEach(d => issues.push({ severity: 'significant', text: d }));
  });

  return issues;
}

// ── State ─────────────────────────────────────────────────────────
const _files = { 1: [], 2: [], 3: [], 4: [] };
let _reportData = null;   // распарсенный JSON от AI
let _rawReportText = '';  // сырой текст для fallback
let _modelTitle  = '';    // название выбранной модели (для шапки отчёта)

// ── Pipeline state ─────────────────────────────────────────────
let _pipelineStrategy = 'single'; // 'single' | 'chunked'

// ── DOM helpers ───────────────────────────────────────────────────
const $ = id => document.getElementById(id);

function showToast(msg, type = 'info') {
  const container = document.getElementById('toastContainer') || document.body;
  const el = document.createElement('div');
  el.className = 'toast';
  el.style.cssText = `pointer-events:auto;background:rgba(30,42,58,0.97);border:1px solid ${
    type === 'error' ? 'rgba(248,113,113,0.3)' : type === 'success' ? 'rgba(74,222,128,0.3)' : 'rgba(255,255,255,0.1)'
  };border-radius:0.75rem;padding:0.6rem 1rem;font-size:0.8rem;color:#e2e8f0;max-width:320px;`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 300); }, 3500);
}

// ── JSZip loader ──────────────────────────────────────────────────
let _jszip = null;
async function ensureJSZip() {
  if (window.JSZip) return window.JSZip;
  if (_jszip) return _jszip;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => { if (window.JSZip) { _jszip = window.JSZip; resolve(_jszip); } else reject(new Error('JSZip не загружен')); };
    s.onerror = () => reject(new Error('Не удалось загрузить JSZip'));
    document.head.appendChild(s);
  });
}

// ── Number formatting ─────────────────────────────────────────────
function fmtNum(v) {
  if (v == null || v === '') return '';
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  if (isNaN(n)) return String(v);
  // Show up to 10 significant decimal digits, trim trailing zeros
  return n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 10 });
}

function parseNum(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

// ── XML utilities ─────────────────────────────────────────────────
function xmlEsc(s) {
  return (s == null ? '' : String(s))
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function colLetter(c) {
  let s = ''; c++;
  while (c > 0) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

// ── Build analysis table HTML ─────────────────────────────────────
function buildTableHtml(data) {
  if (!data) return '<p style="color:#94a3b8">Нет данных для отображения</p>';

  const COL_HEADERS = ['Товар', 'Ед.изм', 'Кол-во', 'Цена за ед.', 'Стоимость без НДС', 'НДС', 'Стоимость с НДС', 'Комментарии'];

  // ── Арифметическая проверка строки таблицы ────────────────────────────────
  // Возвращает Map<field, {actual, expected, label}> для подсветки
  function checkRowArithmetic(item) {
    const errors = {};
    const qty  = parseNum(item.qty);
    const price = parseNum(item.price);
    const amountNoVat   = parseNum(item.amountNoVat);
    const vat           = parseNum(item.vat);
    const amountWithVat = parseNum(item.amountWithVat);

    // qty × price = amountNoVat
    if (qty > 0 && price > 0 && amountNoVat > 0) {
      const exp = Math.round(qty * price * 10000) / 10000;
      if (Math.abs(exp - amountNoVat) > 0.001) {
        errors.amountNoVat = { actual: amountNoVat, expected: exp, label: `${fmtNum(qty)} × ${fmtNum(price)} = ${fmtNum(exp)}` };
      }
    }
    // amountNoVat × vatRate = vat
    const vatRatePct = parseFloat(String(item.vatRate || '').replace('%','').trim());
    if (amountNoVat > 0 && vat > 0 && !isNaN(vatRatePct) && vatRatePct > 0) {
      const expVat = Math.round(amountNoVat * vatRatePct / 100 * 10000) / 10000;
      if (Math.abs(expVat - vat) > 0.001) {
        errors.vat = { actual: vat, expected: expVat, label: `${fmtNum(amountNoVat)} × ${vatRatePct}% = ${fmtNum(expVat)}` };
      }
    }
    // amountNoVat + vat = amountWithVat
    if (amountNoVat > 0 && amountWithVat > 0) {
      const vatForSum = vat || 0;
      const expTotal = Math.round((amountNoVat + vatForSum) * 10000) / 10000;
      if (Math.abs(expTotal - amountWithVat) > 0.001) {
        errors.amountWithVat = { actual: amountWithVat, expected: expTotal, label: `${fmtNum(amountNoVat)} + ${fmtNum(vatForSum)} = ${fmtNum(expTotal)}` };
      }
    }
    return errors;
  }

  // Подсветка ячейки: красный если ошибка, с tooltip
  function cellVal(value, errInfo) {
    const txt = fmtNum(value);
    if (!errInfo) return txt;
    return `<span style="background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.6);border-radius:3px;padding:1px 4px;cursor:help;white-space:nowrap" title="❌ Должно быть: ${fmtNum(errInfo.expected)} (${errInfo.label})">${txt} ⚠</span>`;
  }

  // Подсветка ячейки итоговой строки сравнения (aggregate vs paymentDoc)
  function aggCellVal(value, cmpField, aggCmp) {
    if (!aggCmp) return fmtNum(value);
    const c = aggCmp[cmpField];
    if (!c || c.match) return fmtNum(value);
    return `<span style="background:rgba(239,68,68,0.25);border:1px solid rgba(239,68,68,0.6);border-radius:3px;padding:1px 4px;cursor:help;white-space:nowrap" title="❌ В документе на оплату: ${fmtNum(c.pay)}, расхождение: ${fmtNum(Math.abs(c.agg - c.pay))}">${fmtNum(value)} ⚠</span>`;
  }

  // rowErrors: {amountNoVat?, vat?, amountWithVat?} — ячейки с ошибками
  function itemRow(item, isTotal = false, rowErrors) {
    const bg = isTotal ? 'background:rgba(255,255,255,0.06);font-weight:600;' : '';
    const e = rowErrors || (isTotal ? {} : checkRowArithmetic(item));
    return `<tr style="${bg}">
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);min-width:200px;white-space:pre-wrap">${xmlEsc(item.name || (isTotal ? 'Всего' : ''))}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:center">${xmlEsc(item.unit || '')}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${fmtNum(item.qty)}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${fmtNum(item.price)}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${cellVal(item.amountNoVat, e.amountNoVat)}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${cellVal(item.vat, e.vat)}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${cellVal(item.amountWithVat, e.amountWithVat)}</td>
      <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);min-width:180px;white-space:pre-wrap;font-size:0.75rem;color:#94a3b8">${xmlEsc(item.comments || '')}</td>
    </tr>`;
  }

  function docSection(label, labelColor, docObj, aggCmp) {
    if (!docObj) return '';
    const items = docObj.items || [];
    const total = docObj.total || {};
    const isAggregate = label.startsWith('По сумме');
    const totalRow = isAggregate
      ? `<tr style="background:rgba(255,255,255,0.06);font-weight:600;">
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);min-width:200px">Всего</td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:center"></td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${aggCellVal(total.qty, 'qty', aggCmp)}</td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right"></td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${aggCellVal(total.amountNoVat, 'amountNoVat', aggCmp)}</td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${aggCellVal(total.vat, 'vat', aggCmp)}</td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08);text-align:right">${aggCellVal(total.amountWithVat, 'amountWithVat', aggCmp)}</td>
          <td style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.08)"></td>
        </tr>`
      : itemRow(total, true, {});
    return `
      <tr><td colspan="8" style="padding:0.6rem 0.75rem;background:${labelColor};font-weight:700;font-size:0.85rem;border:1px solid rgba(255,255,255,0.1)">
        ${xmlEsc(label)}
        ${docObj.name ? `<span style="font-weight:400;margin-left:0.5rem">${xmlEsc(docObj.name)}</span>` : ''}
        ${docObj.filename ? `<span style="font-weight:400;color:#94a3b8;margin-left:0.5rem;font-size:0.75rem">${xmlEsc(docObj.filename)}</span>` : ''}
        ${docObj.date ? `<span style="font-weight:400;color:#94a3b8;margin-left:0.5rem;font-size:0.75rem">${xmlEsc(docObj.date)}</span>` : ''}
      </td></tr>
      <tr style="background:rgba(255,255,255,0.04)">
        ${COL_HEADERS.map(h => `<th style="padding:0.4rem 0.6rem;border:1px solid rgba(255,255,255,0.1);font-size:0.75rem;font-weight:600;color:#cbd5e1;text-align:left">${h}</th>`).join('')}
      </tr>
      ${items.map(it => itemRow(it)).join('')}
      ${totalRow}`;
  }

  // Comparison row
  const cmp = data.comparison || {};
  const cmpBg = (cmp.qtyMatch && cmp.amountMatch) ? 'rgba(34,197,94,0.15)' : 'rgba(239,68,68,0.15)';
  const cmpIcon = (cmp.qtyMatch && cmp.amountMatch) ? '✅' : '❌';
  const comparisonRow = `
    <tr><td colspan="8" style="padding:0.75rem;background:${cmpBg};border:1px solid rgba(255,255,255,0.1);font-size:0.85rem">
      ${cmpIcon} <strong>Сверка документа на оплату и первичных документов:</strong> ${xmlEsc(cmp.comment || '')}
      ${cmp.diff_qty ? `<br>Расхождение по кол-ву: ${fmtNum(cmp.diff_qty)}` : ''}
      ${cmp.diff_amount ? `<br>Расхождение по сумме: ${fmtNum(cmp.diff_amount)} руб.` : ''}
    </td></tr>`;

  // Если AI вернул registryItems в корне data — копируем в объект реестра (checkRegistryVsPrimaries читает doc.registryItems)
  if (Array.isArray(data.registryItems) && data.registryItems.length) {
    for (const doc of (data.primaryDocs || [])) {
      if (isRegistryDocType_sc(doc.docType, doc.name) && (!doc.registryItems || !doc.registryItems.length)) {
        doc.registryItems = data.registryItems;
        break;
      }
    }
  }

  // Добавляем JS-нарушения реестра к violations
  const registryIssues = checkRegistryVsPrimaries(data);
  if (registryIssues.length) {
    // Добавляем в data.violations (не мутируем оригинал)
    if (!data._registryChecked) {
      data._registryChecked = true;
      data.violations = [...(data.violations || []), ...registryIssues];
    }
  }

  // Violations
  let violationsHtml = '';
  const violations = data.violations || [];
  if (violations.length) {
    const groups = { critical: [], significant: [], minor: [] };
    violations.forEach(v => (groups[v.severity] || groups.minor).push(v.text));
    const sections = [
      { key: 'critical',    label: '🔴 Критические ошибки',   bg: 'rgba(239,68,68,0.15)',   border: 'rgba(239,68,68,0.3)'   },
      { key: 'significant', label: '🟠 Значимые нарушения',   bg: 'rgba(251,146,60,0.12)',  border: 'rgba(251,146,60,0.3)'  },
      { key: 'minor',       label: '🟡 Замечания',             bg: 'rgba(234,179,8,0.1)',    border: 'rgba(234,179,8,0.25)'  },
    ];
    violationsHtml = `<div style="margin-top:1.5rem">`;
    sections.forEach(({ key, label, bg, border }) => {
      if (!groups[key].length) return;
      violationsHtml += `<div style="margin-bottom:1rem;background:${bg};border:1px solid ${border};border-radius:0.75rem;padding:1rem">
        <div style="font-weight:700;margin-bottom:0.5rem">${label}</div>
        <ul style="margin:0;padding-left:1.25rem">
          ${groups[key].map(t => `<li style="margin-bottom:0.25rem">${xmlEsc(t)}</li>`).join('')}
        </ul>
      </div>`;
    });
    violationsHtml += '</div>';
  }

  // Conclusion
  const conclusionHtml = data.conclusion ? `
    <div style="margin-top:1.5rem;background:rgba(99,102,241,0.1);border:1px solid rgba(99,102,241,0.25);border-radius:0.75rem;padding:1rem">
      <div style="font-weight:700;margin-bottom:0.5rem">✅ Заключение</div>
      <p style="margin:0;line-height:1.6">${xmlEsc(data.conclusion)}</p>
      ${(data.actionRequired || []).length ? `
        <div style="margin-top:0.75rem;font-weight:600">Необходимые действия:</div>
        <ol style="margin:0.25rem 0 0;padding-left:1.25rem">
          ${(data.actionRequired || []).map(a => `<li style="margin-bottom:0.2rem">${xmlEsc(a)}</li>`).join('')}
        </ol>` : ''}
    </div>` : '';

  // Extra docs (акты комиссии, гарантийные талоны, сертификаты и т.д.)
  let extraDocsHtml = '';
  const extras = data.extraDocs || [];
  if (extras.length) {
    extraDocsHtml = `<div style="margin-top:1rem">
      <div style="font-weight:700;color:#94a3b8;font-size:0.78rem;margin-bottom:0.5rem">ДОПОЛНИТЕЛЬНЫЕ ДОКУМЕНТЫ</div>
      <div style="overflow-x:auto"><table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:900px"><tbody>`;
    extras.forEach(e => {
      const meta = [
        e.date ? `Дата: ${e.date}` : null,
        e.expiryDate ? `Действует до: ${e.expiryDate}` : null,
        e.productName ? `Товар: ${e.productName}` : null,
        e.qty != null ? `Кол-во: ${e.qty}` : null,
        e.hasStamp != null ? (e.hasStamp ? '✅ Печать' : '❌ Печать отсутствует') : null,
        e.hasSignature != null ? (e.hasSignature ? '✅ Подпись' : '❌ Подпись отсутствует') : null,
      ].filter(Boolean).join(' · ');
      extraDocsHtml += `<tr><td colspan="8" style="padding:0.6rem 0.75rem;background:rgba(245,158,11,0.1);font-weight:700;font-size:0.85rem;border:1px solid rgba(255,255,255,0.1)">
        ${xmlEsc(e.name || e.docType || 'Доп. документ')}
        ${meta ? `<span style="font-weight:400;color:#94a3b8;margin-left:0.5rem;font-size:0.75rem">${xmlEsc(meta)}</span>` : ''}
      </td></tr>`;
      if (e.issues && e.issues.length) {
        e.issues.forEach(issue => {
          extraDocsHtml += `<tr><td colspan="8" style="padding:0.4rem 0.75rem;border:1px solid rgba(255,255,255,0.07);font-size:0.8rem;color:#fbbf24">⚠ ${xmlEsc(issue)}</td></tr>`;
        });
      }
    });
    extraDocsHtml += `</tbody></table></div></div>`;
  }

  // Chronology
  let chronologyHtml = '';
  const chron = data.chronology || [];
  if (chron.length) {
    chronologyHtml = `<div style="margin-top:1rem;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem;padding:1rem">
      <div style="font-weight:700;margin-bottom:0.5rem;font-size:0.85rem">📅 Хронология событий</div>
      <table style="width:100%;border-collapse:collapse;font-size:0.8rem">
        <thead><tr>
          <th style="padding:0.35rem 0.6rem;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);text-align:left;font-size:0.75rem">Дата</th>
          <th style="padding:0.35rem 0.6rem;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);text-align:left;font-size:0.75rem">Документ</th>
          <th style="padding:0.35rem 0.6rem;border:1px solid rgba(255,255,255,0.1);background:rgba(255,255,255,0.05);text-align:left;font-size:0.75rem">Событие</th>
        </tr></thead><tbody>
        ${chron.map(c => `<tr>
          <td style="padding:0.3rem 0.6rem;border:1px solid rgba(255,255,255,0.07);white-space:nowrap;color:#94a3b8">${xmlEsc(c.date || '')}</td>
          <td style="padding:0.3rem 0.6rem;border:1px solid rgba(255,255,255,0.07)">${xmlEsc(c.docName || '')}</td>
          <td style="padding:0.3rem 0.6rem;border:1px solid rgba(255,255,255,0.07)">${xmlEsc(c.event || '')}</td>
        </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }

  // Запускаем программную проверку арифметики (заполняет data._aggregateComparison)
  // Импортируем логику прямо здесь для simple-check-view (без import)
  if (!data._aggregateComparison && data.paymentDoc?.total && (data.primaryDocs || []).length > 0) {
    const r2 = v => Math.round((Number(v) || 0) * 100) / 100;
    // Реестры не суммируются — они не подтверждают поставку
    const primaries = (data.primaryDocs || []).filter(p => !isRegistryDocType_sc(p.docType, p.name));
    const pd = data.paymentDoc;
    const aggQty   = primaries.reduce((s,p) => s + (Number(p.total?.qty) || 0), 0);
    const aggNoVat = primaries.reduce((s,p) => s + (Number(p.total?.amountNoVat) || 0), 0);
    const aggVat   = primaries.reduce((s,p) => s + (Number(p.total?.vat) || 0), 0);
    const aggTotal = primaries.reduce((s,p) => s + (Number(p.total?.amountWithVat) || 0), 0);
    data._aggregateComparison = {
      qty:           { agg: aggQty,   pay: Number(pd.total.qty || 0),           match: Math.abs(aggQty   - Number(pd.total.qty || 0))           < 0.001 },
      amountNoVat:   { agg: aggNoVat, pay: Number(pd.total.amountNoVat || 0),   match: Math.abs(aggNoVat - Number(pd.total.amountNoVat || 0))   < 0.001 },
      vat:           { agg: aggVat,   pay: Number(pd.total.vat || 0),           match: Math.abs(aggVat   - Number(pd.total.vat || 0))           < 0.001 },
      amountWithVat: { agg: aggTotal, pay: Number(pd.total.amountWithVat || 0), match: Math.abs(aggTotal - Number(pd.total.amountWithVat || 0)) < 0.001 },
    };
  }
  const aggCmp = data._aggregateComparison;

  // ── Шапка отчёта с метаданными ─────────────────────────────────
  const reportMeta = data._meta || {};
  const metaHtml = `<div style="margin-bottom:1rem;padding:0.65rem 1rem;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:0.75rem;display:flex;flex-wrap:wrap;gap:0.75rem;align-items:center;font-size:0.78rem;color:#94a3b8">
    <span>📋 <strong style="color:#e2e8f0">Экспертное заключение</strong></span>
    ${reportMeta.date ? `<span>📅 ${xmlEsc(reportMeta.date)}</span>` : ''}
    ${reportMeta.model ? `<span style="display:flex;align-items:center;gap:0.3rem">🤖 <span style="color:#a78bfa;font-weight:600">${xmlEsc(reportMeta.model)}</span></span>` : ''}
    ${reportMeta.files ? `<span>📁 ${xmlEsc(reportMeta.files)}</span>` : ''}
    ${reportMeta.strategy ? `<span style="color:#a78bfa;font-size:0.72rem">${xmlEsc(reportMeta.strategy)}</span>` : ''}
  </div>`;

  return `
    ${metaHtml}
    <div style="overflow-x:auto">
      <table style="width:100%;border-collapse:collapse;font-size:0.82rem;min-width:900px">
        <tbody>
          ${docSection('Документ на оплату', 'rgba(59,130,246,0.2)', data.paymentDoc)}
          <tr><td colspan="8" style="padding:0.3rem;background:transparent;border:none"></td></tr>
          ${docSection('По сумме первичных документов', 'rgba(16,185,129,0.15)', data.aggregate, aggCmp)}
          ${comparisonRow}
          <tr><td colspan="8" style="padding:0.5rem;background:transparent;border:none;font-weight:700;color:#94a3b8;font-size:0.78rem">ПЕРВИЧНЫЕ ДОКУМЕНТЫ</td></tr>
          ${(data.primaryDocs || []).filter(doc => !isRegistryDocType_sc(doc.docType, doc.name)).map((doc, i) =>
            docSection(`Первичный документ ${i + 1}: ${doc.name || ''}`, 'rgba(139,92,246,0.12)', doc)
          ).join('<tr><td colspan="8" style="padding:0.2rem;background:transparent;border:none"></td></tr>')}
          ${(() => {
            const registries = (data.primaryDocs || []).filter(p => isRegistryDocType_sc(p.docType, p.name));
            if (!registries.length) return '';
            return '<tr><td colspan="8" style="padding:0.3rem 0;background:transparent;border:none"></td></tr>' +
              '<tr><td colspan="8" style="padding:0.5rem 0.75rem;background:transparent;border:none;font-weight:700;color:#818cf8;font-size:0.78rem">📊 РЕЕСТР (контрольный документ, не суммируется)</td></tr>' +
              registries.map((reg, i) =>
                docSection(`Реестр ${i + 1}: ${reg.name || ''}`, 'rgba(99,102,241,0.12)', reg)
              ).join('<tr><td colspan="8" style="padding:0.2rem;background:transparent;border:none"></td></tr>');
          })()}
        </tbody>
      </table>
    </div>
    ${extraDocsHtml}
    ${chronologyHtml}
    ${violationsHtml}
    ${conclusionHtml}`;
}

// ── Simple Markdown → HTML (fallback) ────────────────────────────
function mdToHtml(md) {
  if (!md) return '';
  const lines = md.split('\n');
  const out = [];
  let inTable = false, tableRows = [], inCode = false, codeLines = [];

  function flushTable() {
    if (!tableRows.length) return;
    let html = '<div style="overflow-x:auto;margin:0.75rem 0"><table style="width:100%;border-collapse:collapse;font-size:0.8rem">';
    tableRows.forEach((row, i) => {
      const cells = row.split('|').map(c => c.trim()).filter((_, ci, arr) => ci > 0 && ci < arr.length - 1);
      if (i === 0) {
        html += '<thead><tr>' + cells.map(c => `<th style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);padding:0.5rem 0.75rem;text-align:left;font-weight:600">${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      } else if (i === 1 && cells.every(c => /^[-:]+$/.test(c))) {
        // skip
      } else {
        html += '<tr>' + cells.map(c => `<td style="border:1px solid rgba(255,255,255,0.07);padding:0.45rem 0.75rem">${inline(c)}</td>`).join('') + '</tr>';
      }
    });
    html += '</tbody></table></div>';
    out.push(html); tableRows = []; inTable = false;
  }

  function inline(t) {
    return t.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>').replace(/\*(.+?)\*/g,'<em>$1</em>');
  }

  for (const line of lines) {
    if (line.startsWith('```')) {
      if (inCode) { out.push(`<pre><code>${codeLines.join('\n').replace(/&/g,'&amp;').replace(/</g,'&lt;')}</code></pre>`); codeLines = []; inCode = false; }
      else { if (inTable) flushTable(); inCode = true; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (line.includes('|') && line.trim().startsWith('|')) { inTable = true; tableRows.push(line); continue; }
    if (inTable) flushTable();
    if (/^#{1,6}\s/.test(line)) {
      const m = line.match(/^(#{1,6})\s+(.*)/);
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if (/^(\s*[-*+]|\s*\d+\.) /.test(line)) {
      const text = line.replace(/^\s*[-*+]\s+/,'').replace(/^\s*\d+\.\s+/,'');
      out.push(`<ul><li>${inline(text)}</li></ul>`);
    } else if (!line.trim()) {
      out.push('<p></p>');
    } else {
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  if (inTable) flushTable();
  return out.join('\n').replace(/<\/ul>\n<ul>/g,'');
}

// ── Zone chip rendering ────────────────────────────────────────────
function renderZoneChips(zoneId) {
  const chipsEl = $(`scChips${zoneId}`);
  const badge   = $(`scZoneBadge${zoneId}`);
  const card    = $(`scZoneCard${zoneId}`);
  if (!chipsEl) return;

  const list = _files[zoneId];
  chipsEl.innerHTML = '';
  list.forEach((f, i) => {
    const chip = document.createElement('div');
    chip.className = 'sc-chip';
    chip.innerHTML = `<span class="sc-chip-name" title="${f.name}">${f.name}</span><button class="sc-chip-rm" data-zone="${zoneId}" data-idx="${i}" aria-label="Удалить ${f.name}">✕</button>`;
    chipsEl.appendChild(chip);
  });

  if (badge) {
    if (list.length > 0) { badge.textContent = list.length; badge.classList.remove('hidden'); }
    else { badge.classList.add('hidden'); }
  }
  if (card) {
    if (list.length > 0) { card.style.borderColor = 'rgba(167,139,250,0.4)'; card.style.background = 'rgba(167,139,250,0.04)'; }
    else { card.style.borderColor = ''; card.style.background = ''; }
  }
}

function renderAllZoneChips() { [1,2,3,4].forEach(renderZoneChips); }

function addFiles(zoneId, newFiles) {
  newFiles.forEach(f => {
    if (!_files[zoneId].find(x => x.name === f.name && x.size === f.size)) _files[zoneId].push(f);
  });
  renderZoneChips(zoneId);
  updateAnalyzeBtn();
}

function handleChipRemove(e) {
  const btn = e.target.closest('.sc-chip-rm');
  if (!btn) return;
  const zoneId = parseInt(btn.dataset.zone);
  const idx = parseInt(btn.dataset.idx);
  _files[zoneId].splice(idx, 1);
  renderZoneChips(zoneId);
  updateAnalyzeBtn();
}

function updateAnalyzeBtn() {
  const total = Object.values(_files).reduce((s, arr) => s + arr.length, 0);
  const btn = $('scAnalyzeBtn');
  if (btn) btn.disabled = total === 0;
}

// ── Оценка размера пакета ────────────────────────────────────────
// PDF/DOCX — бинарные форматы: реальный текст ~5% от размера файла.
// Коэффициент: bytes / 80 ≈ токены текста (консервативно).
// Для чистых текстовых файлов (txt, csv) используем bytes / 4.
function estimateFileTokens(file) {
  const name = (file.name || '').toLowerCase();
  const isText = /\.(txt|csv|json|xml|html|md)$/i.test(name);
  return Math.round((file.size || 0) / (isText ? 4 : 80));
}

async function estimatePackage(uploadedFiles, analyzeModelId) {
  const totalTokens = uploadedFiles.reduce((s, u) => s + estimateFileTokens(u.file), 0);
  const contextLimit = MODEL_CONTEXT_LIMITS[analyzeModelId] || 128000;
  // Оставляем 30% контекста для промпта и ответа
  const usableContext = Math.round(contextLimit * 0.70);

  if (totalTokens <= usableContext) {
    return { tokens: totalTokens, strategy: 'single', batches: 1, contextLimit, usableContext };
  }

  // Чанкование: якорные документы (зоны 1+2) всегда в каждом батче
  const anchorFiles = uploadedFiles.filter(u => u.zone === 1 || u.zone === 2);
  const otherFiles  = uploadedFiles.filter(u => u.zone !== 1 && u.zone !== 2);
  const anchorTokens = anchorFiles.reduce((s, u) => s + estimateFileTokens(u.file), 0);

  const batches = [];
  let batch = [...anchorFiles];
  let batchTok = anchorTokens;

  for (const u of otherFiles) {
    const ft = estimateFileTokens(u.file);
    if (batchTok + ft > usableContext - 8000 && batch.length > anchorFiles.length) {
      batches.push(batch);
      batch = [...anchorFiles, u];
      batchTok = anchorTokens + ft;
    } else {
      batch.push(u);
      batchTok += ft;
    }
  }
  if (batch.length > 0) batches.push(batch);

  return {
    tokens: totalTokens,
    strategy: 'chunked',
    batches: batches.length || 1,
    batchGroups: batches,
    contextLimit,
    usableContext,
  };
}

// ── Показ стратегии ──────────────────────────────────────────────
function showStrategyBadge(est) {
  const badge = $('scStrategyBadge');
  if (!badge) return;
  const tokM = (est.tokens / 1000).toFixed(0);
  const limM = (est.usableContext / 1000).toFixed(0);
  if (est.strategy === 'single') {
    badge.innerHTML = `<span style="background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:0.5rem;padding:0.25rem 0.75rem;font-size:0.75rem;color:rgb(74,222,128)">✅ Один запрос (~${tokM}K / ${limM}K токенов)</span>`;
  } else {
    badge.innerHTML = `<span style="background:rgba(251,146,60,0.12);border:1px solid rgba(251,146,60,0.3);border-radius:0.5rem;padding:0.25rem 0.75rem;font-size:0.75rem;color:rgb(251,146,60)">⚡ Чанкование: ${est.batches} батч(а) (~${tokM}K токенов, лимит ${limM}K)</span>`;
  }
  badge.classList.remove('hidden');
}

// ── Фаза 1: извлечение из одного файла ──────────────────────────
async function extractOneFile(fileId, fileName, zone, extractModelId) {
  const zoneLabels = {
    1: 'Документ на оплату (зона 1)',
    2: 'Договор и ТЗ (зона 2)',
    3: 'Первичный документ (зона 3)',
    4: 'Дополнительный документ (зона 4)',
  };
  const userMsg = `Документ: «${fileName}» (${zoneLabels[zone] || 'зона ' + zone})\n\nИзвлеки структурированные данные. Верни ТОЛЬКО JSON.`;
  try {
    const result = await miniappsAI.callModel({
      modelId: extractModelId,
      messages: [
        { role: 'system', content: EXTRACTION_PROMPT },
        { role: 'user', content: [
          { type: 'file_id', fileId },
          { type: 'text', text: userMsg },
        ]},
      ],
      timeoutMs: 120000,
    });
    const text = miniappsAI.extractText(result);
    const parsed = extractReportJSON(text);
    if (parsed) {
      parsed._filename = fileName;
      parsed._zone = zone;
      parsed._fileId = fileId;
    }
    return parsed || { _filename: fileName, _zone: zone, _fileId: fileId, _extractError: 'parse_failed', docType: 'other', items: [], total: {} };
  } catch (err) {
    console.warn('[Phase1] extract error:', fileName, err?.message);
    return { _filename: fileName, _zone: zone, _fileId: fileId, _extractError: err?.message || 'error', docType: 'other', items: [], total: {} };
  }
}

// ── Фаза 2: кросс-анализ на основе извлечённых JSON ─────────────
async function analyzeExtracted(extractedDocs, analyzeModelId, extra, batchIdx, totalBatches) {
  const docsSummary = extractedDocs.map((d, i) => {
    const zoneName = { 1: 'ЗОНА 1 (оплата)', 2: 'ЗОНА 2 (договор/ТЗ)', 3: 'ЗОНА 3 (первичный)', 4: 'ЗОНА 4 (доп.)' }[d._zone] || 'ЗОНА ?';
    return `--- ДОКУМЕНТ ${i + 1}: ${d._filename} [${zoneName}] ---\n${JSON.stringify(d, null, 2)}`;
  }).join('\n\n');

  const batchNote = totalBatches > 1
    ? `\n\nПРИМЕЧАНИЕ: Это батч ${batchIdx}/${totalBatches}. Данные других батчей будут объединены.`
    : '';

  const userContent = `Ниже — структурированные данные, извлечённые из документов пакета.
Проведи полный кросс-анализ и верни итоговый JSON-отчёт по стандартной структуре.${batchNote}
${extra ? '\n\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n' + extra : ''}

ИЗВЛЕЧЁННЫЕ ДАННЫЕ:
${docsSummary}

Верни ТОЛЬКО JSON по указанной структуре.`;

  const result = await miniappsAI.callModel({
    modelId: analyzeModelId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    timeoutMs: 360000,
  });
  return miniappsAI.extractText(result);
}

// ── Финальная склейка результатов нескольких батчей ──────────────
async function mergeChunkedResults(batchResults, analyzeModelId, extra) {
  const summaries = batchResults.map((r, i) => {
    const s = typeof r === 'string' ? r : JSON.stringify(r);
    return `--- БАТЧ ${i + 1} ---\n${s.slice(0, 8000)}`;
  }).join('\n\n');

  const mergePrompt = `Ты получаешь результаты анализа нескольких батчей документов одного пакета.
Объедини их в единый итоговый отчёт: сведи violations без дублей, рассчитай итоговый aggregate,
составь общее заключение. Верни ТОЛЬКО JSON по стандартной структуре.
${extra ? '\nДОП. ИНСТРУКЦИИ: ' + extra : ''}

РЕЗУЛЬТАТЫ БАТЧЕЙ:
${summaries}`;

  const result = await miniappsAI.callModel({
    modelId: analyzeModelId,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: mergePrompt },
    ],
    timeoutMs: 300000,
  });
  return miniappsAI.extractText(result);
}

// ── Wire zone inputs and drag-drop ────────────────────────────────
function wireZone(zoneId) {
  const input = $(`scFile${zoneId}`);
  const drop  = $(`scZoneDrop${zoneId}`);
  if (!input || !drop) return;

  input.addEventListener('change', () => { addFiles(zoneId, Array.from(input.files)); input.value = ''; });
  drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#a78bfa'; drop.style.color = '#c084fc'; });
  drop.addEventListener('dragleave', () => { drop.style.borderColor = ''; drop.style.color = ''; });
  drop.addEventListener('drop', e => { e.preventDefault(); drop.style.borderColor = ''; drop.style.color = ''; addFiles(zoneId, Array.from(e.dataTransfer.files)); });
  drop.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } });
}

// ── Model selector ────────────────────────────────────────────────
function buildModelOptions(sel, defaultId) {
  if (!sel) return;
  sel.innerHTML = '';
  const groups = {};
  MODELS.forEach(m => { const g = m.group || 'Другие'; if (!groups[g]) groups[g] = []; groups[g].push(m); });
  Object.entries(groups).forEach(([groupName, models]) => {
    const optgroup = document.createElement('optgroup');
    optgroup.label = groupName;
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.id;
      opt.textContent = `${m.title}  (~${m.cost} кр.)`;
      optgroup.appendChild(opt);
    });
    sel.appendChild(optgroup);
  });
  sel.value = defaultId || MODELS[0].id;
}

function initModelSelect() {
  const selAnalyze = $('scModelSelect');
  const selExtract = $('scExtractModelSelect');
  const costEl = $('scModelCost');

  buildModelOptions(selAnalyze, MODELS[0].id);

  // Модель извлечения: по умолчанию Claude Haiku (дешёвая, быстрая)
  const haikuModel = MODELS.find(m => m.title.includes('Haiku') && !m.title.includes('Thinking'));
  buildModelOptions(selExtract, haikuModel?.id || MODELS[0].id);

  function updateCost() {
    const ma = MODELS.find(x => x.id === selAnalyze?.value);
    const me = MODELS.find(x => x.id === selExtract?.value);
    if (costEl) {
      const parts = [];
      if (ma) parts.push(`анализ ~${ma.cost} кр.`);
      if (me) parts.push(`извлечение ~${me.cost} кр./файл`);
      costEl.textContent = parts.join(' · ');
    }
  }
  updateCost();
  selAnalyze?.addEventListener('change', updateCost);
  selExtract?.addEventListener('change', updateCost);
}

// ── Progress ──────────────────────────────────────────────────────
function showProgress(stage, detail, pct) {
  $('scProgressCard')?.classList.remove('hidden');
  const s = $('scProgressStage'); if (s) s.textContent = stage;
  const d = $('scProgressDetail'); if (d) d.textContent = detail;
  const b = $('scProgressBar'); if (b) b.style.width = pct + '%';
}
function hideProgress() { $('scProgressCard')?.classList.add('hidden'); }

// ── Надёжный парсер JSON из ответа AI ────────────────────────────
// Стратегии: 1) прямой JSON, 2) убрать markdown, 3) найти первый { … последний }
// 4) починить обрезанный JSON
function extractReportJSON(text) {
  if (!text) return null;

  // 1. Прямой парсинг
  try { return JSON.parse(text.trim()); } catch { /* */ }

  // 2. Убрать markdown-блок (```json ... ``` или ``` ... ```)
  const stripped = text.replace(/^```(?:json)?\s*/im, '').replace(/\s*```\s*$/m, '').trim();
  try { return JSON.parse(stripped); } catch { /* */ }

  // 3. Найти первый { и последний }
  const start = text.indexOf('{');
  if (start === -1) return null;
  const end = text.lastIndexOf('}');
  if (end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch { /* */ }
  }

  // 4. JSON обрезан — пытаемся починить
  const raw = text.slice(start);
  try { return JSON.parse(repairJSON(raw)); } catch { /* */ }

  return null;
}

function repairJSON(raw) {
  let s = raw.trimEnd();
  // Ищем последнюю полную закрытую структуру
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
  if (lastSafe > 1) { try { return s.slice(0, lastSafe); } catch { /* */ } }
  // Закрываем принудительно
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

// ── Main analysis — Pipeline ──────────────────────────────────────
async function runAnalysis() {
  const analyzeModelId = $('scModelSelect')?.value;
  const extractModelId = $('scExtractModelSelect')?.value || analyzeModelId;
  const extra = $('scExtraPrompt')?.value.trim() || '';

  const allFiles = [];
  ZONES.forEach(({ id, role }) => { _files[id].forEach(f => allFiles.push({ file: f, zone: id, role })); });

  if (allFiles.length === 0) { showToast('Загрузите хотя бы один документ', 'error'); return; }

  const registryFiles3 = _files[3].filter(isRegistryFile);
  if (registryFiles3.length > 1) {
    showToast('⚠ Загружено ' + registryFiles3.length + ' реестра(ов). Рекомендуется оставить только один.', 'error');
  }

  const analyzeBtn = $('scAnalyzeBtn');
  if (analyzeBtn) analyzeBtn.disabled = true;
  $('scReportCard')?.classList.add('hidden');
  $('scEmptyState')?.classList.add('hidden');
  $('scCopyBtn')?.classList.add('hidden');
  $('scDownloadBtn')?.classList.add('hidden');
  $('scExcelBtn')?.classList.add('hidden');
  $('scStrategyBadge')?.classList.add('hidden');
  showProgress('Загрузка файлов...', `Загружаем ${allFiles.length} файл(ов)`, 3);

  const chosenAnalyzeModel = MODELS.find(x => x.id === analyzeModelId);
  const chosenExtractModel = MODELS.find(x => x.id === extractModelId);
  _modelTitle = chosenAnalyzeModel ? chosenAnalyzeModel.title.replace(/^[^\w]+/, '').trim() : analyzeModelId;

  try {
    // ── Шаг 1: Загрузка файлов ──────────────────────────────────
    const uploaded = [];
    const UPLOAD_TIMEOUT = 180000;
    const MAX_RETRIES = 3;
    const RETRY_PAUSE = 4000;

    for (let i = 0; i < allFiles.length; i++) {
      const { file, zone, role } = allFiles[i];
      const pct = 3 + Math.round((i / allFiles.length) * 35);
      showProgress('Загрузка файлов...', `${i + 1} / ${allFiles.length}: ${file.name}`, pct);

      let lastErr = null;
      let success = false;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
          if (attempt > 1) {
            showProgress('Загрузка файлов...', `${file.name} — попытка ${attempt}/${MAX_RETRIES}...`, pct);
            await new Promise(res => setTimeout(res, RETRY_PAUSE));
          }
          const up = await miniappsAI.uploadFile(file, { persistence: 'temporary', timeoutMs: UPLOAD_TIMEOUT });
          uploaded.push({ fileId: up.fileId, name: file.name, zone, role, file });
          success = true;
          break;
        } catch (err) {
          lastErr = err;
          console.warn(`[Pipeline] upload ${attempt}/${MAX_RETRIES} failed:`, file.name, err?.message);
        }
      }
      if (!success) {
        const msg = lastErr?.message || String(lastErr);
        showToast(`⚠ ${file.name}: ${msg.slice(0, 100)}`, 'error');
      }
    }

    if (uploaded.length === 0) throw new Error('Ни один файл не загружен. Проверьте размер (макс. 50 МБ).');

    // ── Шаг 2: Оценка пакета — выбор стратегии ──────────────────
    showProgress('Оценка пакета...', 'Определяем стратегию анализа', 40);
    const est = await estimatePackage(uploaded, analyzeModelId);
    _pipelineStrategy = est.strategy;
    showStrategyBadge(est);

    let reportText = '';

    if (est.strategy === 'single') {
      // ── Стратегия A: один запрос (весь пакет влезает) ────────────
      showProgress('Фаза 1 из 1: Анализ...', `${_modelTitle} читает все ${uploaded.length} файл(ов)...`, 50);

      const zoneGroups = {};
      uploaded.forEach(u => { (zoneGroups[u.zone] = zoneGroups[u.zone] || []).push(u); });
      const zoneLabels = { 1: 'Документ на оплату', 2: 'Договор и ТЗ', 3: 'Первичные документы', 4: 'Прочие документы' };
      let intro = 'Проанализируй пакет документов. Состав пакета:\n\n';
      ZONES.forEach(({ id }) => {
        const group = zoneGroups[id] || [];
        if (!group.length) return;
        intro += `ЗОНА ${id}: ${zoneLabels[id]}\n`;
        group.forEach((u, i) => { intro += `  ${i + 1}. ${u.name}\n`; });
        intro += '\n';
      });
      if (extra) intro += `\nДОПОЛНИТЕЛЬНЫЕ ИНСТРУКЦИИ:\n${extra}`;
      intro += '\n\nВерни ТОЛЬКО JSON по указанной структуре.';

      const content = [{ type: 'text', text: intro }];
      ZONES.forEach(({ id }) => { (zoneGroups[id] || []).forEach(u => content.push({ type: 'file_id', fileId: u.fileId })); });

      const result = await miniappsAI.callModel({
        modelId: analyzeModelId,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content },
        ],
        timeoutMs: 360000,
      });
      reportText = miniappsAI.extractText(result);

    } else {
      // ── Стратегия B: чанкование ───────────────────────────────────
      const extractModelTitle = chosenExtractModel
        ? chosenExtractModel.title.replace(/^[^\w]+/, '').trim()
        : extractModelId;

      // Фаза 1: извлечение данных из каждого файла
      const extractedDocs = [];
      for (let i = 0; i < uploaded.length; i++) {
        const u = uploaded[i];
        const pct = 42 + Math.round((i / uploaded.length) * 28);
        showProgress(
          `Фаза 1/2: Извлечение (${extractModelTitle})`,
          `Файл ${i + 1} / ${uploaded.length}: ${u.name}`,
          pct
        );
        const doc = await extractOneFile(u.fileId, u.name, u.zone, extractModelId);
        extractedDocs.push(doc);
        if (doc._extractError) {
          showToast(`⚠ Не удалось извлечь данные из «${u.name}»`, 'error');
        }
      }

      // Фаза 2: кросс-анализ на основе извлечённых JSON
      const batchGroups = est.batchGroups || [uploaded];
      const batchResults = [];

      for (let bi = 0; bi < batchGroups.length; bi++) {
        const pct = 72 + Math.round((bi / batchGroups.length) * 20);
        showProgress(
          `Фаза 2/2: Кросс-анализ (${_modelTitle})`,
          `Батч ${bi + 1} / ${batchGroups.length}`,
          pct
        );
        // Берём extractedDocs только для файлов этого батча
        const batchNames = new Set(batchGroups[bi].map(u => u.name));
        const batchDocs = extractedDocs.filter(d => batchNames.has(d._filename));
        const batchText = await analyzeExtracted(batchDocs, analyzeModelId, extra, bi + 1, batchGroups.length);
        batchResults.push(batchText);
      }

      if (batchResults.length === 1) {
        reportText = batchResults[0];
      } else {
        // Финальная склейка
        showProgress('Финальная сборка...', 'Объединяем результаты батчей', 94);
        reportText = await mergeChunkedResults(batchResults, analyzeModelId, extra);
      }
    }

    showProgress('Формируем отчёт...', 'Обрабатываем ответ', 97);

    if (!reportText || reportText.trim().length < 10) {
      throw new Error('AI вернул пустой ответ. Попробуйте другую модель.');
    }

    _rawReportText = reportText;
    let parsed = null;
    try { parsed = extractReportJSON(reportText); } catch (e) {
      console.warn('[Pipeline] JSON parse failed:', e.message);
    }
    _reportData = parsed;

    // Добавляем метаданные + проверяем покрытие файлов
    if (parsed) {
      const fileList = allFiles.map(f => f.file.name).join(', ');
      const strategyLabel = est.strategy === 'single'
        ? 'один запрос'
        : `чанкование (${est.batches} батч.)`;
      parsed._meta = {
        date: new Date().toLocaleString('ru-RU'),
        model: _modelTitle,
        files: fileList.length > 120 ? fileList.slice(0, 117) + '...' : fileList,
        strategy: strategyLabel,
      };

      const receivedFiles = parsed.receivedFiles || [];
      const uploadedNames = uploaded.map(u => u.name);
      const missingInReport = uploadedNames.filter(name =>
        !receivedFiles.some(rf =>
          rf.filename === name ||
          name.includes(rf.filename) ||
          rf.filename.includes(name.replace(/\.[^.]+$/, ''))
        )
      );
      if (missingInReport.length > 0) {
        showToast(`⚠ AI не отчитался о ${missingInReport.length} файл(ах): ${missingInReport.slice(0,3).join(', ')}${missingInReport.length > 3 ? '...' : ''}`, 'error');
        if (!parsed.violations) parsed.violations = [];
        missingInReport.forEach(name => {
          parsed.violations.unshift({
            severity: 'critical',
            category: 'прочее',
            docName: name,
            text: `⚠ Файл «${name}» был загружен, но AI не упомянул его в отчёте. Данные из него могут быть не учтены.`,
          });
        });
      } else {
        const unreadable = receivedFiles.filter(rf => rf.status !== 'ok');
        if (unreadable.length > 0) {
          showToast(`⚠ ${unreadable.length} файл(ов) нечитаемы: ${unreadable.map(rf => rf.filename).slice(0,2).join(', ')}`, 'error');
        }
      }
    }

    const body = $('scReportBody');
    if (body) {
      body.innerHTML = parsed
        ? buildTableHtml(parsed)
        : `<div style="background:rgba(234,179,8,0.1);border:1px solid rgba(234,179,8,0.25);border-radius:0.75rem;padding:0.75rem 1rem;margin-bottom:1rem;font-size:0.8rem;color:#fbbf24">⚠ AI вернул ответ не в JSON-формате. Показываем текстовый вариант.</div>` + mdToHtml(reportText);
    }

    $('scReportCard')?.classList.remove('hidden');
    $('scCopyBtn')?.classList.remove('hidden');
    $('scDownloadBtn')?.classList.remove('hidden');
    if (parsed) $('scExcelBtn')?.classList.remove('hidden');
    $('scEmptyState')?.classList.add('hidden');
    hideProgress();
    showToast('✅ Анализ завершён!', 'success');

  } catch (err) {
    hideProgress();
    $('scEmptyState')?.classList.remove('hidden');
    console.error('[Pipeline] error:', err);
    const msg = err?.message || String(err);
    if (msg.includes('sign') || msg.includes('auth') || msg.includes('login')) {
      showToast('Требуется вход в miniapps.ai', 'error');
    } else if (msg.includes('credit') || msg.includes('balance')) {
      showToast('Недостаточно кредитов', 'error');
    } else if (msg.includes('timeout')) {
      showToast('Превышено время ожидания. Попробуйте более быструю модель.', 'error');
    } else {
      showToast('Ошибка: ' + msg.slice(0, 150), 'error');
    }
  } finally {
    updateAnalyzeBtn();
  }
}

// ── Download HTML ─────────────────────────────────────────────────
function downloadReport() {
  const date = new Date().toISOString().slice(0, 10);
  const bodyHtml = $('scReportBody')?.innerHTML || '';
  const modelLine = _modelTitle ? `<p style="color:#64748b;font-size:0.8rem;margin:0 0 1.5rem">🤖 Модель: <strong>${_modelTitle}</strong></p>` : '';
  const html = `<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Экспертное заключение ${date}</title>
<style>
body{font-family:Arial,sans-serif;max-width:1200px;margin:0 auto;padding:2rem;color:#1e293b;background:#fff}
h1{color:#0f172a;font-size:1.3rem;border-bottom:2px solid #e2e8f0;padding-bottom:0.5rem;margin-bottom:1.5rem}
table{width:100%;border-collapse:collapse;margin:1rem 0;font-size:0.82rem}
th,td{border:1px solid #e2e8f0;padding:0.4rem 0.6rem;vertical-align:top;text-align:left}
th{background:#f1f5f9;font-weight:600}
p{margin:0.4rem 0;line-height:1.6}
ul,ol{margin:0.4rem 0 0.4rem 1.5rem}
@media print{body{padding:0}}
button{background:#0f172a;color:#fff;border:none;padding:0.5rem 1.5rem;border-radius:0.5rem;cursor:pointer;font-size:0.9rem;margin-bottom:1rem}
</style></head><body>
<button onclick="window.print()">🖨 Печать / PDF</button>
<h1>Экспертное заключение · ${date}</h1>
${modelLine}${bodyHtml}
<hr style="margin-top:2rem;border:none;border-top:1px solid #e2e8f0">
<p style="color:#94a3b8;font-size:0.75rem">Сформировано: ${new Date().toLocaleString('ru-RU')}${_modelTitle ? ' · ' + _modelTitle : ''}</p>
</body></html>`;
  const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `expert-report-${date}.html`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  showToast('HTML отчёт сохранён', 'success');
}

// ── Excel export ──────────────────────────────────────────────────
async function downloadExcel() {
  if (!_reportData) { showToast('Нет данных для экспорта', 'error'); return; }
  const btn = $('scExcelBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Формирую...'; }

  try {
    const JSZip = await ensureJSZip();
    const data = _reportData;
    const reportDate = new Date().toLocaleString('ru-RU');

    // ── SharedStrings ──────────────────────────────────────────────
    const _sst = [], _sstMap = new Map();
    function si(str) {
      const s = str == null ? '' : String(str);
      if (_sstMap.has(s)) return _sstMap.get(s);
      const idx = _sst.length; _sst.push(s); _sstMap.set(s, idx); return idx;
    }
    function sc(v, styleId) { return { v: String(v ?? ''), t: 's', s: styleId, _si: si(String(v ?? '')) }; }
    function nc(v, styleId) {
      const n = parseNum(v);
      return n != null ? { v: n, t: 'n', s: styleId } : sc(v, styleId);
    }

    // ── Styles ─────────────────────────────────────────────────────
    // 0=default, 1=title, 2=sectionHeader, 3=cell, 4=numCell,
    // 5=totalRow, 6=critical, 7=significant, 8=minor, 9=conclusion,
    // 10=paymentHeader, 11=primaryHeader, 12=aggregateHeader, 13=extraHeader,
    // 14=colHeader
    const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="8">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><sz val="13"/><b/><name val="Calibri"/><color rgb="FF0F172A"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF1E293B"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF1E293B"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FFB91C1C"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF92400E"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF374151"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF065F46"/></font>
  </fonts>
  <fills count="12">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF7ED"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEDE9FE"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE0E7FF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFECFDF5"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F4F8"/></patternFill></fill>
  </fills>
  <borders count="3">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="medium"><color rgb="FF94A3B8"/></bottom><diagonal/></border>
    <border>
      <left style="thin"><color rgb="FFE2E8F0"/></left>
      <right style="thin"><color rgb="FFE2E8F0"/></right>
      <top style="thin"><color rgb="FFE2E8F0"/></top>
      <bottom style="thin"><color rgb="FFE2E8F0"/></bottom>
      <diagonal/>
    </border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="15">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="11" borderId="1" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="7" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="0" borderId="2" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="4"  fontId="3" fillId="0" borderId="2" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4"  fontId="2" fillId="7" borderId="2" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="4" borderId="2" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="5" fillId="5" borderId="2" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="6" borderId="2" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="8" borderId="2" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="6" fillId="2" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="7" fillId="3" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="9" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="2" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="7" borderId="2" xfId="0"><alignment horizontal="center" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;

    // ── Column headers ─────────────────────────────────────────────
    const COL_NAMES = ['Товар', 'Ед.изм', 'Кол-во', 'Цена за ед.', 'Стоимость без НДС', 'НДС', 'Стоимость с НДС', 'Комментарии'];
    const NUM_COLS = 8;

    // ── Sheet 1: Analysis table ────────────────────────────────────
    const rows1 = [], merges1 = [];
    let r1 = 0;

    function addRow(cells) {
      rows1.push({ r: r1, cells: cells.map((cell, c) => ({ ...cell, c })) });
      r1++;
    }
    function emptyRow() { rows1.push({ r: r1, cells: [] }); r1++; }
    function merge(r, c1, c2) { merges1.push([r, c1, r, c2]); }

    function addSectionHeader(label, name, filename, date, styleId) {
      const tr = r1;
      addRow([sc(label + (name ? '  ' + name : '') + (filename ? '  [' + filename + ']' : '') + (date ? '  ' + date : ''), styleId)]);
      merge(tr, 0, NUM_COLS - 1);
    }

    function addColHeaders() {
      addRow(COL_NAMES.map(h => sc(h, 2)));
    }

    function addItemRows(items) {
      (items || []).forEach(item => {
        addRow([
          sc(item.name || '', 3),
          sc(item.unit || '', 14),
          nc(item.qty, 4),
          nc(item.price, 4),
          nc(item.amountNoVat, 4),
          nc(item.vat, 4),
          nc(item.amountWithVat, 4),
          sc(item.comments || '', 3),
        ]);
      });
    }

    function addTotalRow(total) {
      if (!total) return;
      addRow([
        sc('Всего', 5),
        sc('', 5),
        nc(total.qty, 5),
        sc('', 5),
        nc(total.amountNoVat, 5),
        nc(total.vat, 5),
        nc(total.amountWithVat, 5),
        sc('', 5),
      ]);
    }

    // Title
    const titleR = r1;
    addRow([sc('Таблица анализа первичных документов  ·  ' + reportDate + (_modelTitle ? '  ·  ' + _modelTitle : ''), 1)]);
    merge(titleR, 0, NUM_COLS - 1);
    emptyRow();

    // 1. Документ на оплату
    addSectionHeader('Документ на оплату', data.paymentDoc?.name, data.paymentDoc?.filename, data.paymentDoc?.date, 13);
    addColHeaders();
    addItemRows(data.paymentDoc?.items);
    addTotalRow(data.paymentDoc?.total);
    emptyRow();

    // 2. По сумме первичных документов (агрегат)
    addSectionHeader('По сумме первичных документов', '', '', '', 11);
    addColHeaders();
    addItemRows(data.aggregate?.items);
    addTotalRow(data.aggregate?.total);
    emptyRow();

    // 3. Первичные документы
    (data.primaryDocs || []).forEach((doc, i) => {
      addSectionHeader(`Документ ${i + 1}`, doc.name, doc.filename, doc.date, 12);
      addColHeaders();
      addItemRows(doc.items);
      addTotalRow(doc.total);
      emptyRow();
    });

    // Comparison
    const cmp = data.comparison || {};
    const cmpR = r1;
    const cmpText = [
      cmp.qtyMatch === false ? `❌ Расхождение по кол-ву: ${fmtNum(cmp.diff_qty)}` : '✅ Кол-во совпадает',
      cmp.amountMatch === false ? `❌ Расхождение по сумме: ${fmtNum(cmp.diff_amount)} руб.` : '✅ Суммы совпадают',
      cmp.comment ? cmp.comment : '',
    ].filter(Boolean).join('  |  ');
    const cmpStyle = (cmp.qtyMatch === false || cmp.amountMatch === false) ? 6 : 7;
    addRow([sc(cmpText, cmpStyle)]);
    merge(cmpR, 0, NUM_COLS - 1);
    emptyRow();

    // Violations
    const violations = data.violations || [];
    if (violations.length) {
      const vTitleR = r1;
      addRow([sc('Нарушения и замечания', 2)]);
      merge(vTitleR, 0, NUM_COLS - 1);
      violations.forEach(v => {
        const sev = v.severity === 'critical' ? 6 : v.severity === 'significant' ? 7 : 8;
        const prefix = v.severity === 'critical' ? '🔴 ' : v.severity === 'significant' ? '🟠 ' : '🟡 ';
        const vR = r1;
        addRow([sc(prefix + v.text, sev)]);
        merge(vR, 0, NUM_COLS - 1);
      });
      emptyRow();
    }

    // Conclusion
    if (data.conclusion) {
      const conR = r1;
      addRow([sc('✅ Заключение', 11)]);
      merge(conR, 0, NUM_COLS - 1);
      const conTextR = r1;
      addRow([sc(data.conclusion, 9)]);
      merge(conTextR, 0, NUM_COLS - 1);
      (data.actionRequired || []).forEach((action, i) => {
        const aR = r1;
        addRow([sc(`${i + 1}. ${action}`, 3)]);
        merge(aR, 0, NUM_COLS - 1);
      });
    }

    // ── Sheet 2: File list ─────────────────────────────────────────
    const rows2 = [], merges2 = [];
    let r2 = 0;
    const ZONE_NAMES = { 1: 'Документ на оплату', 2: 'Договор и ТЗ', 3: 'Первичные документы', 4: 'Прочие документы' };
    function addRow2(cells) { rows2.push({ r: r2, cells: cells.map((cell, c) => ({ ...cell, c })) }); r2++; }

    const t2R = r2;
    addRow2([sc('Состав пакета документов', 1)]);
    merges2.push([t2R, 0, t2R, 2]);
    rows2.push({ r: r2, cells: [] }); r2++;
    addRow2([sc('Зона', 2), sc('Файл', 2), sc('Роль', 2)]);
    for (const zoneId of [1, 2, 3, 4]) {
      for (const f of _files[zoneId]) {
        addRow2([sc(ZONE_NAMES[zoneId], 3), sc(f.name, 3), sc(ZONE_NAMES[zoneId], 3)]);
      }
    }

    // ── XLSX assembly ──────────────────────────────────────────────
    function sheetXml(sheetRows, sheetMerges, colWidths) {
      const colsXml = colWidths.length
        ? '<cols>' + colWidths.map((w, i) => `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
        : '';
      const mergesXml = sheetMerges.length
        ? '<mergeCells count="' + sheetMerges.length + '">' +
          sheetMerges.map(([rr1,cc1,rr2,cc2]) => `<mergeCell ref="${colLetter(cc1)}${rr1+1}:${colLetter(cc2)}${rr2+1}"/>`).join('') +
          '</mergeCells>'
        : '';
      const rowsXml = sheetRows.map(row => {
        if (!row.cells.length) return `<row r="${row.r+1}"></row>`;
        const cellsXml = row.cells.map(cell => {
          const addr = `${colLetter(cell.c)}${row.r+1}`;
          if (cell.t === 'n') return `<c r="${addr}" s="${cell.s}"><v>${cell.v}</v></c>`;
          return `<c r="${addr}" s="${cell.s}" t="s"><v>${cell._si}</v></c>`;
        }).join('');
        return `<row r="${row.r+1}">${cellsXml}</row>`;
      }).join('');
      return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${colsXml}<sheetData>${rowsXml}</sheetData>${mergesXml}</worksheet>`;
    }

    const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${_sst.length}" uniqueCount="${_sst.length}">${_sst.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}</sst>`;

    const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Анализ первички" sheetId="1" r:id="rId1"/><sheet name="Документы" sheetId="2" r:id="rId2"/></sheets></workbook>`;

    const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

    const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

    const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

    const zip = new JSZip();
    zip.file('[Content_Types].xml', contentTypes);
    zip.file('_rels/.rels', rootRels);
    zip.file('xl/workbook.xml', wbXml);
    zip.file('xl/_rels/workbook.xml.rels', wbRels);
    zip.file('xl/styles.xml', STYLES_XML);
    zip.file('xl/sharedStrings.xml', sstXml);
    // Sheet 1: 8 data columns — Товар(40), Ед(8), Кол(12), Цена(18), БезНДС(18), НДС(14), СНДСом(18), Комм(35)
    zip.file('xl/worksheets/sheet1.xml', sheetXml(rows1, merges1, [40, 8, 12, 18, 18, 14, 18, 35]));
    zip.file('xl/worksheets/sheet2.xml', sheetXml(rows2, merges2, [28, 48, 28]));

    const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    const date = new Date().toISOString().slice(0, 10);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = `таблица-анализа-первички-${date}.xlsx`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    showToast('✅ Excel сохранён', 'success');

  } catch (err) {
    console.error('[SimpleCheck] Excel error:', err);
    showToast('Ошибка Excel: ' + (err.message || err), 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📊 Excel'; }
  }
}

// ── Copy ──────────────────────────────────────────────────────────
async function copyReport() {
  const text = _rawReportText || $('scReportBody')?.innerText || '';
  try {
    await navigator.clipboard.writeText(text);
    showToast('Скопировано в буфер обмена', 'success');
  } catch {
    showToast('Не удалось скопировать', 'error');
  }
}

// ── Clear all ─────────────────────────────────────────────────────
function clearAll() {
  ZONES.forEach(({ id }) => { _files[id] = []; });
  _reportData = null;
  _rawReportText = '';
  if ($('scExtraPrompt')) $('scExtraPrompt').value = '';
  $('scReportCard')?.classList.add('hidden');
  $('scCopyBtn')?.classList.add('hidden');
  $('scDownloadBtn')?.classList.add('hidden');
  $('scExcelBtn')?.classList.add('hidden');
  $('scEmptyState')?.classList.remove('hidden');
  hideProgress();
  renderAllZoneChips();
  updateAnalyzeBtn();
}

// ── Open / Close ──────────────────────────────────────────────────
export function openSimpleCheckModal() {
  const modal = document.getElementById('simpleCheckModal');
  if (!modal) return;
  const panel = modal.querySelector('.catalog-panel');
  if (panel) { panel.classList.remove('hidden'); panel.style.display = 'flex'; }
  modal.classList.add('open');

  if (!modal.dataset.initialized) {
    modal.dataset.initialized = '1';
    initModelSelect();
    renderAllZoneChips();
    updateAnalyzeBtn();

    [1,2,3,4].forEach(wireZone);
    document.addEventListener('click', handleChipRemove);

    $('scAnalyzeBtn')?.addEventListener('click', runAnalysis);
    $('scClearAllBtn')?.addEventListener('click', clearAll);
    $('scDownloadBtn')?.addEventListener('click', downloadReport);
    $('scExcelBtn')?.addEventListener('click', downloadExcel);
    $('scCopyBtn')?.addEventListener('click', copyReport);

    const closeModal = () => {
      modal.classList.remove('open');
      const p = modal.querySelector('.catalog-panel');
      if (p) { p.classList.add('hidden'); p.style.display = ''; }
    };
    $('scBackBtn')?.addEventListener('click', closeModal);
    $('scCloseBtn')?.addEventListener('click', closeModal);
    modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && modal.classList.contains('open')) closeModal();
    });
  }
}
