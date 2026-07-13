/**
 * doc-check-view.js
 * Модуль проверки пакетов документов на оплату.
 *
 * Архитектура (3 этапа):
 *   Этап 1 — AI извлекает структурированный JSON из каждого документа
 *             Структурированные доки: договор, УПД, накладные, счета
 *             Неструктурированные: декларации, сертификаты, гарантийные талоны, служебные записки
 *   Этап 2 — JS программно сверяет данные между документами
 *   Этап 3 — AI пишет финальное заключение
 */

// ── Модели ───────────────────────────────────────────────────────
const MODEL_EXTRACT  = 'dc2db118-7888-466a-a8d1-bf9d96bab4b6'; // DeepSeek V4 Flash Instant
const MODEL_CONCLUDE = '875415fa-08d2-48a3-922f-1d9fa42a3005'; // DeepSeek V3
const MODEL_OCR      = '7d2c89e7-5ee2-4360-8f63-b784c1d2150e'; // Gemini 2.5 Flash-Lite (vision, 1 кредит)

// ── Состояние ────────────────────────────────────────────────────
let _files      = [];
let _parsedDocs = [];
let _crossCheck = null;
let _reportMd   = '';
let _analysing  = false;

// ═══════════════════════════════════════════════════════════════════
// ТИПЫ ДОКУМЕНТОВ
// ═══════════════════════════════════════════════════════════════════

// Структурированные — есть числовые поля (суммы, кол-во, реквизиты)
const STRUCTURED_TYPES = new Set([
  'договор','упд','счет','накладная','акт_приемки','акт_ввода',
  'реестр_накладных','акт_проверки','авансовый_счет','акт_переименования'
]);

// Претензии — отдельная группа (смешанный тип: реквизиты + юридический текст)
const CLAIM_TYPES = new Set(['претензия']);

// Неструктурированные — текстово-логические документы
const UNSTRUCTURED_TYPES = new Set([
  'декларация_соответствия','сертификат_соответствия','гарантийный_талон',
  'служебная_записка','паспорт_изделия','протокол_испытаний','заключение_эксперта',
  'доверенность','письмо','иной_документ'
]);

// ═══════════════════════════════════════════════════════════════════
// ПРОМПТЫ
// ═══════════════════════════════════════════════════════════════════

const EXTRACT_STRUCTURED_SYSTEM = `Ты — аналитик первичных документов для госконтрактов РФ.
Извлеки из документа структурированные данные в формате JSON.
Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown-блоков, без \`\`\`json.

Формат ответа:
{
  "тип": "договор|упд|счет|накладная|акт_приемки|акт_ввода|реестр_накладных|акт_проверки|авансовый_счет|акт_переименования|претензия|неизвестно",
  "номер": "строка или null",
  "дата": "YYYY-MM-DD или строка-как-есть или null",
  "заказчик": {
    "наименование": "строка или null",
    "инн": "строка или null",
    "кпп": "строка или null",
    "адрес": "строка или null",
    "банк": "строка или null",
    "рсч": "строка или null",
    "бик": "строка или null"
  },
  "поставщик": {
    "наименование": "строка или null",
    "инн": "строка или null",
    "кпп": "строка или null",
    "адрес": "строка или null",
    "банк": "строка или null",
    "рсч": "строка или null",
    "бик": "строка или null"
  },
  "получатель": {
    "наименование": "строка или null",
    "адрес": "строка или null",
    "инн": "строка или null"
  },
  "договор_номер": "ссылка на договор или null",
  "договор_дата": "YYYY-MM-DD или null",
  "товары": [
    {
      "наименование": "строка",
      "код": "строка или null",
      "количество": число или null,
      "единица": "строка или null",
      "цена": число или null,
      "сумма_без_ндс": число или null,
      "ндс_ставка": "строка или null",
      "ндс_сумма": число или null,
      "сумма_с_ндс": число или null
    }
  ],
  "итого_количество": число или null,
  "итого_без_ндс": число или null,
  "итого_ндс": число или null,
  "итого_с_ндс": число или null,
  "аванс_процент": число или null,
  "аванс_сумма": число или null,
  "сумма_договора": число или null,
  "подписанты": {
    "заказчик": "ФИО или null",
    "поставщик": "ФИО или null"
  },
  "ссылки_на_накладные": [],
  "замечания": []
}`;

const EXTRACT_CLAIM_SYSTEM = `Ты — юрист-аналитик претензионной работы по госконтрактам РФ.
Извлеки из документа-претензии структурированные данные в формате JSON.
Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown-блоков, без \`\`\`json.

Формат ответа:
{
  "тип": "претензия",
  "номер": "номер претензионного письма или null",
  "дата": "YYYY-MM-DD или строка или null",
  "срок_ответа_дней": число или null,
  "дата_ответа_до": "YYYY-MM-DD или строка — крайний срок ответа или null",
  "заявитель": {
    "наименование": "сторона, направившая претензию или null",
    "инн": "строка или null",
    "должность_подписанта": "строка или null",
    "подписант": "ФИО или null"
  },
  "ответчик": {
    "наименование": "сторона, к которой предъявлена претензия или null",
    "инн": "строка или null"
  },
  "договор_номер": "номер договора/контракта или null",
  "договор_дата": "YYYY-MM-DD или null",
  "основание": "краткое описание нарушения (что произошло) или null",
  "тип_нарушения": "просрочка|недопоставка|некачественный_товар|неоплата|иное или null",
  "требования": ["список требований заявителя: замена, устранение, возврат, штраф и т.д."],
  "сумма_претензии": число или null,
  "сумма_штрафа": число или null,
  "сумма_пени": число или null,
  "пеня_процент_день": число или null,
  "период_просрочки_дней": число или null,
  "ссылки_на_документы": ["накладные, акты, УПД, на которые ссылается претензия"],
  "товары": [
    {
      "наименование": "строка",
      "количество_претензии": число или null,
      "описание_нарушения": "строка или null"
    }
  ],
  "печать_присутствует": true,
  "подпись_присутствует": true,
  "замечания": ["список замеченных проблем или формальных несоответствий"]
}`;

const EXTRACT_UNSTRUCTURED_SYSTEM = `Ты — аналитик документации для госконтрактов РФ.
Извлеки из документа структурированные данные в формате JSON.
Отвечай ТОЛЬКО валидным JSON без пояснений, без markdown-блоков, без \`\`\`json.

Типы неструктурированных документов:
- декларация_соответствия — декларация о соответствии ТР ТС/ГОСТ
- сертификат_соответствия — сертификат соответствия ГОСТ/ТР ТС
- гарантийный_талон — гарантийный талон/гарантийное письмо производителя
- служебная_записка — служебная записка, докладная, заявка
- паспорт_изделия — технический паспорт, инструкция по эксплуатации
- протокол_испытаний — протокол лабораторных испытаний
- заключение_эксперта — экспертное заключение
- доверенность — доверенность на представителя
- письмо — деловое письмо, уведомление
- иной_документ — прочие документы

Формат ответа:
{
  "тип": "декларация_соответствия|сертификат_соответствия|гарантийный_талон|служебная_записка|паспорт_изделия|протокол_испытаний|заключение_эксперта|доверенность|письмо|иной_документ",
  "номер": "регистрационный номер документа или null",
  "дата": "YYYY-MM-DD или строка или null",
  "дата_окончания": "YYYY-MM-DD или строка или null (срок действия)",
  "товары": [
    {
      "наименование": "точное наименование товара из документа",
      "модель": "модель/артикул или null",
      "производитель": "наименование производителя или null",
      "гост_ту": "ГОСТ/ТУ/ТР ТС или null",
      "код_окп_окпд": "код ОКП/ОКПД или null"
    }
  ],
  "орган_сертификации": "наименование органа или null",
  "испытательная_лаборатория": "наименование лаборатории или null",
  "аккредитация_номер": "номер аккредитации или null",
  "изготовитель": {
    "наименование": "строка или null",
    "адрес": "строка или null",
    "инн": "строка или null"
  },
  "заявитель": {
    "наименование": "строка или null",
    "адрес": "строка или null",
    "инн": "строка или null"
  },
  "технические_регламенты": ["список ТР ТС/ГОСТ на соответствие которым выдан документ"],
  "схема_декларирования": "строка или null",
  "гарантийный_срок": "строка или null (например '12 месяцев' или '2 года')",
  "гарантийный_срок_месяцев": число или null,
  "печать_присутствует": true/false/null,
  "подпись_присутствует": true/false/null,
  "подписант": "ФИО подписанта или null",
  "кому": "адресат (для служебных записок/писем) или null",
  "от_кого": "отправитель (для служебных записок/писем) или null",
  "тема": "тема/суть документа или null",
  "договор_номер": "ссылка на договор если есть или null",
  "адреса_получателей": ["список адресов/организаций если указаны"],
  "замечания": ["список замеченных проблем: истёкший срок, нечитаемые данные, несоответствия"]
}`;

const DETECT_TYPE_SYSTEM = `Определи тип документа по его тексту и верни ОДНО слово — тип из списка:
договор, упд, счет, накладная, акт_приемки, акт_ввода, реестр_накладных, акт_проверки, авансовый_счет, акт_переименования, претензия,
декларация_соответствия, сертификат_соответствия, гарантийный_талон, служебная_записка, паспорт_изделия, протокол_испытаний, заключение_эксперта, доверенность, письмо, иной_документ.
Отвечай ТОЛЬКО одним словом из списка без пробелов и пояснений.`;

const CONCLUDE_SYSTEM = `Ты — эксперт-ревизор первичной документации для оплаты госконтрактов РФ.
Тебе передают:
1. Структурированные данные по каждому документу (JSON)
2. Результаты программной сверки (расхождения, найденные алгоритмически)

Твоя задача — написать профессиональное заключение на русском языке.
НЕ пересчитывай суммы самостоятельно — доверяй результатам программной сверки.
Сосредоточься на смысловых, юридических и логических замечаниях.

Структура ответа:

# ЗАКЛЮЧЕНИЕ ПО ПАКЕТУ ДОКУМЕНТОВ НА ОПЛАТУ

## Общая информация
[Договор, поставщик, заказчик, сумма, состав пакета]

## Хронология документов
[Таблица: документ → дата → статус]

## Результаты проверки

### 1. Реквизиты сторон
[На основе данных программной сверки + дополнительные наблюдения]

### 2. Хронология и логика дат
[Анализ хронологии]

### 3. Наименования товаров и получателей
[Соответствие наименований по всем документам. Если загружен акт переименования — учитывать его как допустимый справочник соответствий и не считать такие расхождения ошибкой само по себе.]

### 4. Расчёт платежей
[Аванс, остаток, итого]

### 5. Арифметика документов
[Внутренняя арифметика каждого документа]

### 6. Сводная сверка (первичка vs УПД)
[Используй данные программной сверки — точные цифры уже вычислены]

### 7. НДС
[Ставки и суммы НДС]

### 8. Декларации, сертификаты, гарантийные документы
[Соответствие товаров договору, сроки действия, наличие печатей и подписей, орган сертификации, технические регламенты]

### 9. Служебные записки и иные документы
[Логическое соответствие контексту поставки, адресаты, содержание]

### 10. Претензии
[Если в пакете есть претензии — анализируй каждую:
- Основание и тип нарушения (просрочка / некачественный товар / недопоставка / неоплата)
- Соответствие реквизитов сторон договору (ИНН заявителя, ответчика)
- Правильность расчёта штрафных санкций (пени, штраф по 44-ФЗ)
- Соблюдение претензионного порядка: срок ответа 30 дней по 44-ФЗ ч.5 ст.95
- Наличие ссылок на конкретные первичные документы (накладные, акты)
- Наличие подписи уполномоченного лица и печати
- Логическое соответствие остальным документам пакета (нарушение подтверждено?)
Если претензий нет — пропусти раздел.]

### 11. Иные замечания
[Прочие наблюдения]

## ИТОГОВАЯ ТАБЛИЦА НЕСООТВЕТСТВИЙ

| № | Документ | Описание | Степень |
|---|---|---|---|
[🔴 Критическое / 🟡 Существенное / 🟠 Формальное]

## ОБЩИЙ ВЫВОД
[Краткое резюме: можно ли оплачивать, что нужно исправить]`;

// ═══════════════════════════════════════════════════════════════════
// ИНИЦИАЛИЗАЦИЯ
// ═══════════════════════════════════════════════════════════════════

export function initDocCheckView() {
  _wireButtons();
}

export function openDocCheckModal() {
  const overlay = document.getElementById('docCheckModal');
  if (!overlay) return;
  overlay.classList.add('open');
  overlay.querySelector('.catalog-panel')?.classList.remove('hidden');
  _renderFileList();
}

export function closeDocCheckModal() {
  const overlay = document.getElementById('docCheckModal');
  if (!overlay) return;
  overlay.classList.remove('open');
  overlay.querySelector('.catalog-panel')?.classList.add('hidden');
}

// ═══════════════════════════════════════════════════════════════════
// СОБЫТИЯ
// ═══════════════════════════════════════════════════════════════════

function _wireButtons() {
  const dropZone  = document.getElementById('dcDropZone');
  const fileInput = document.getElementById('dcFileInput');
  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault(); dropZone.classList.remove('drag-over');
      _addFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', () => { _addFiles(fileInput.files); fileInput.value = ''; });
  }

  document.getElementById('dcClearBtn')?.addEventListener('click', () => {
    _files = []; _parsedDocs = []; _crossCheck = null; _reportMd = '';
    _renderFileList(); _clearReport();
  });

  document.getElementById('dcAnalyseBtn')?.addEventListener('click', _runAnalysis);
  document.getElementById('dcDownloadBtn')?.addEventListener('click', _downloadReport);
  document.getElementById('dcCloseBtn')?.addEventListener('click', closeDocCheckModal);
  document.getElementById('dcBackBtn')?.addEventListener('click', closeDocCheckModal);
  document.getElementById('dcPromptClearBtn')?.addEventListener('click', () => {
    const ta = document.getElementById('dcPromptInput');
    if (ta) ta.value = '';
  });

  const overlay = document.getElementById('docCheckModal');
  if (overlay) {
    overlay.addEventListener('click', e => { if (e.target === overlay) closeDocCheckModal(); });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeDocCheckModal();
    });
  }
}

// ═══════════════════════════════════════════════════════════════════
// ЭТАП 0: ЗАГРУЗКА И ИЗВЛЕЧЕНИЕ ТЕКСТА
// ═══════════════════════════════════════════════════════════════════

// Минимальный порог символов на страницу — если меньше, считаем страницу сканом
const SCAN_TEXT_THRESHOLD = 50;

async function _addFiles(fileList) {
  if (!fileList || fileList.length === 0) return;
  _setStatus('Читаю файлы…', 'info');
  for (const file of Array.from(fileList)) {
    if (_files.find(f => f.name === file.name)) continue;
    try {
      const result = await _extractText(file);
      _files.push({
        name: file.name,
        text: result.text,
        size: file.size,
        fileObj: file,
        scanPages: result.scanPages || 0,
        totalPages: result.totalPages || 0,
      });
    } catch (err) {
      _setStatus(`Ошибка чтения ${file.name}: ${err.message}`, 'error');
    }
  }
  _renderFileList();
  _setStatus('', '');
}

async function _extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.pdf'))                         return await _extractPdfHybrid(file);
  if (name.endsWith('.txt') || name.endsWith('.md')) return { text: await file.text(), scanPages: 0, totalPages: 0 };
  if (name.endsWith('.docx') || name.endsWith('.doc')) return { text: await _extractDocxText(file), scanPages: 0, totalPages: 0 };
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return { text: await _extractXlsxText(file), scanPages: 0, totalPages: 0 };
  try { return { text: await file.text(), scanPages: 0, totalPages: 0 }; }
  catch { return { text: `[${file.name}: формат не поддерживается]`, scanPages: 0, totalPages: 0 }; }
}

// ── Гибридное извлечение PDF ───────────────────────────────────────
// 1. Пробуем PDF.js — извлекаем текстовый слой по страницам
// 2. Страницы с текстом < SCAN_TEXT_THRESHOLD символов → рендерим в canvas → OCR через vision-модель
// 3. Если PDF.js недоступен → fallback: загружаем файл через miniappsAI и просим текстовую модель извлечь текст

async function _extractPdfHybrid(file) {
  // Пробуем загрузить PDF.js
  let pdfjsLib = null;
  try {
    const { loadPDFJS } = await import('./lib-loader.js');
    pdfjsLib = await loadPDFJS();
  } catch { /* PDF.js недоступен — fallback */ }

  if (!pdfjsLib) {
    return await _extractPdfFallback(file);
  }

  // Читаем PDF через PDF.js
  let pdf;
  try {
    const ab = await file.arrayBuffer();
    pdf = await pdfjsLib.getDocument({ data: ab }).promise;
  } catch (err) {
    console.warn('[pdf-hybrid] PDF.js parse error:', err.message);
    return await _extractPdfFallback(file);
  }

  const totalPages = pdf.numPages;
  const pageTexts = [];
  const scanPageNums = [];

  // Этап 1: извлекаем текстовый слой каждой страницы
  for (let i = 1; i <= totalPages; i++) {
    try {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      const pageText = content.items.map(item => item.str).join(' ').trim();
      pageTexts.push({ pageNum: i, text: pageText, isScan: pageText.length < SCAN_TEXT_THRESHOLD });
      if (pageText.length < SCAN_TEXT_THRESHOLD) scanPageNums.push(i);
    } catch {
      pageTexts.push({ pageNum: i, text: '', isScan: true });
      scanPageNums.push(i);
    }
  }

  const textPages = pageTexts.filter(p => !p.isScan);
  const scanPages = pageTexts.filter(p => p.isScan);

  // Если все страницы текстовые — просто объединяем
  if (scanPages.length === 0) {
    const fullText = pageTexts.map(p => p.text).join('\n\n');
    return { text: fullText || `[PDF: текст не извлечён из ${file.name}]`, scanPages: 0, totalPages };
  }

  // Этап 2: OCR для скан-страниц через vision-модель
  _setStatus(`${file.name}: распознаю ${scanPages.length} скан-страниц…`, 'info');
  const ocrResults = await _ocrScanPages(pdf, scanPages);

  // Собираем финальный текст в порядке страниц
  const allPagesText = pageTexts.map(p => {
    if (!p.isScan) return p.text;
    const ocr = ocrResults.get(p.pageNum);
    return ocr ? `[OCR стр.${p.pageNum}]\n${ocr}` : `[стр.${p.pageNum}: скан не распознан]`;
  });

  const finalText = allPagesText.join('\n\n');
  return {
    text: finalText || `[PDF: текст не извлечён из ${file.name}]`,
    scanPages: scanPages.length,
    totalPages,
  };
}

// ── OCR скан-страниц через vision-модель ──────────────────────────
// Рендерим каждую страницу в canvas → PNG blob → uploadFile → vision OCR
// Параллельно, но не более 3 одновременно (чтобы не перегружать API)

async function _ocrScanPages(pdf, scanPages) {
  const results = new Map(); // pageNum → text
  const CONCURRENCY = 3;

  async function processPage(pageInfo) {
    const { pageNum } = pageInfo;
    try {
      // Рендерим страницу в canvas
      const page = await pdf.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // 2x для лучшего качества OCR
      const canvas = document.createElement('canvas');
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      const ctx = canvas.getContext('2d');
      await page.render({ canvasContext: ctx, viewport }).promise;

      // Конвертируем в PNG blob
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png', 0.92));
      if (!blob) return;

      // Загружаем на платформу
      const uploaded = await miniappsAI.uploadFile(
        new File([blob], `page-${pageNum}.png`, { type: 'image/png' }),
        { persistence: 'temporary' }
      );

      // OCR через vision-модель
      const result = await miniappsAI.callModel({
        modelId: MODEL_OCR,
        messages: [{
          role: 'user',
          content: [
            { type: 'image_url', url: uploaded.publicUrl },
            { type: 'text', text: 'Это скан страницы документа на русском языке. Извлеки весь текст точно как написано, сохраняя структуру таблиц. Числа, даты, ИНН, суммы — сохраняй точно. Отвечай только текстом без пояснений.' }
          ]
        }],
        timeoutMs: 45000,
      });

      const text = miniappsAI.extractText(result).trim();
      if (text) results.set(pageNum, text);

    } catch (err) {
      console.warn(`[pdf-ocr] стр.${pageNum}: ${err.message}`);
    }
  }

  // Обрабатываем с ограничением параллельности
  for (let i = 0; i < scanPages.length; i += CONCURRENCY) {
    const batch = scanPages.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(p => processPage(p)));
  }

  return results;
}

// ── Fallback: загружаем PDF как файл и просим текстовую модель ─────
async function _extractPdfFallback(file) {
  try {
    const uploaded = await miniappsAI.uploadFile(file, { persistence: 'temporary' });
    const result = await miniappsAI.callModel({
      modelId: MODEL_EXTRACT,
      messages: [{
        role: 'user',
        content: [
          { type: 'file_id', fileId: uploaded.fileId },
          { type: 'text', text: 'Извлеки весь текст из этого документа. Сохраняй структуру таблиц. Числа сохраняй точно.' }
        ]
      }],
      timeoutMs: 60000,
    });
    return {
      text: miniappsAI.extractText(result) || `[PDF: текст не извлечён из ${file.name}]`,
      scanPages: 0,
      totalPages: 0,
    };
  } catch (err) {
    return { text: `[PDF ${file.name}: ошибка — ${err.message}]`, scanPages: 0, totalPages: 0 };
  }
}

async function _extractDocxText(file) {
  try {
    const ab = await file.arrayBuffer();
    const text = new TextDecoder('utf-8').decode(new Uint8Array(ab));
    const matches = text.match(/<w:t[^>]*>([^<]*)<\/w:t>/g) || [];
    const extracted = matches.map(m => m.replace(/<[^>]+>/g, '')).join(' ');
    return extracted.length > 50 ? extracted : `[DOCX ${file.name}: не удалось извлечь текст]`;
  } catch { return `[DOCX ${file.name}: ошибка чтения]`; }
}

async function _extractXlsxText(file) {
  if (typeof XLSX !== 'undefined') {
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { type: 'array' });
      return wb.SheetNames.map(s => `=== ${s} ===\n${XLSX.utils.sheet_to_csv(wb.Sheets[s])}`).join('\n');
    } catch { /* fall */ }
  }
  return `[XLSX ${file.name}: SheetJS не загружен]`;
}

// ═══════════════════════════════════════════════════════════════════
// ЭТАП 1: ОПРЕДЕЛЕНИЕ ТИПА + СТРУКТУРИРОВАННОЕ ИЗВЛЕЧЕНИЕ
// ═══════════════════════════════════════════════════════════════════

async function _detectDocType(fileName, text) {
  // Быстрое определение по ключевым словам (без AI)
  const t = (fileName + ' ' + text.slice(0, 500)).toLowerCase();
  if (/декларац.{0,10}соответств/i.test(t))  return 'декларация_соответствия';
  if (/сертификат.{0,10}соответств/i.test(t)) return 'сертификат_соответствия';
  if (/гарантийн.{0,10}(талон|лист|письмо)/i.test(t)) return 'гарантийный_талон';
  if (/служебн.{0,10}записк/i.test(t))        return 'служебная_записка';
  if (/паспорт.{0,10}(изделия|устройства|оборудования)/i.test(t)) return 'паспорт_изделия';
  if (/протокол.{0,10}испытани/i.test(t))      return 'протокол_испытаний';
  if (/доверенность/i.test(t))                 return 'доверенность';
  if (/универсальн.{0,10}передаточн/i.test(t) || /упд/i.test(t)) return 'упд';
  if (/товарн.{0,10}накладн|торг-12|торг12/i.test(t)) return 'накладная';
  if (/договор.{0,10}(поставк|купли|контракт)/i.test(t) || /государственн.{0,10}контракт/i.test(t)) return 'договор';
  if (/акт.{0,15}приём|акт.{0,15}прием/i.test(t)) return 'акт_приемки';
  if (/реестр.{0,10}накладн/i.test(t))         return 'реестр_накладных';
  if (/счёт.{0,10}факту|счет.{0,10}факту/i.test(t)) return 'счет';
  if (/счёт.{0,10}на.{0,10}(оплат|аванс)|счет.{0,10}на.{0,10}(оплат|аванс)/i.test(t)) return 'авансовый_счет';
  // Претензия — определяем до AI (без дополнительного запроса)
  if (/претензи(я|онн)|требование.{0,20}(устранени|возмещени|замен|уплат)|уведомление.{0,20}наруш/i.test(t)) return 'претензия';
  // Если не определили — спросить AI
  return null;
}

async function _stage1_extractStructured(onProgress) {
  _parsedDocs = [];
  for (let i = 0; i < _files.length; i++) {
    const f = _files[i];
    onProgress(`Этап 1/3 — анализ: ${f.name} (${i + 1}/${_files.length})…`);

    try {
      // Шаг 1: определяем тип документа
      let docType = await _detectDocType(f.name, f.text);
      if (!docType) {
        // Спрашиваем AI
        const typeResult = await miniappsAI.callModel({
          modelId: MODEL_EXTRACT,
          messages: [
            { role: 'system', content: DETECT_TYPE_SYSTEM },
            { role: 'user', content: `Файл: ${f.name}\n\n${f.text.slice(0, 2000)}` }
          ],
          timeoutMs: 30000,
        });
        docType = miniappsAI.extractText(typeResult).trim().toLowerCase().replace(/\s+/g,'_') || 'иной_документ';
      }

      // Шаг 2: выбираем промпт в зависимости от типа
      const isUnstructured = UNSTRUCTURED_TYPES.has(docType);
      const isClaim        = CLAIM_TYPES.has(docType);
      const systemPrompt   = isClaim        ? EXTRACT_CLAIM_SYSTEM
                           : isUnstructured ? EXTRACT_UNSTRUCTURED_SYSTEM
                           :                  EXTRACT_STRUCTURED_SYSTEM;

      const result = await miniappsAI.callModel({
        modelId: MODEL_EXTRACT,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `Документ: ${f.name}\nОпределённый тип: ${docType}\n\n${f.text.slice(0, 40000)}` }
        ],
        timeoutMs: 60000,
      });

      const raw     = miniappsAI.extractText(result).trim();
      const cleaned = raw.replace(/^```json\s*/i,'').replace(/^```\s*/i,'').replace(/```\s*$/i,'').trim();
      let parsed;
      try { parsed = JSON.parse(cleaned); } catch {
        parsed = { тип: docType, _parseError: true, _raw: raw.slice(0,300) };
      }

      // Гарантируем тип (AI мог переопределить)
      if (!parsed.тип) parsed.тип = docType;
      parsed._isUnstructured = UNSTRUCTURED_TYPES.has(parsed.тип);
      parsed._isClaim        = CLAIM_TYPES.has(parsed.тип);
      _parsedDocs.push({ fileName: f.name, ...parsed });

    } catch (err) {
      _parsedDocs.push({ fileName: f.name, тип: 'иной_документ', _isUnstructured: true, _error: err.message });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// ЭТАП 2: ПРОГРАММНАЯ СВЕРКА
// ═══════════════════════════════════════════════════════════════════

function _stage2_crossCheck() {
  const issues = [];
  const info   = {};

  // ── Опорные документы ─────────────────────────────────────────
  const contract   = _parsedDocs.find(d => d.тип === 'договор');
  const upd        = _parsedDocs.find(d => d.тип === 'упд' || d.тип === 'счет');
  const invoices   = _parsedDocs.filter(d => ['накладная','акт_приемки','акт_ввода'].includes(d.тип));
  const registry   = _parsedDocs.find(d => d.тип === 'реестр_накладных');
  const advance    = _parsedDocs.find(d => d.тип === 'авансовый_счет');
  const checks     = _parsedDocs.filter(d => d.тип === 'акт_проверки');
  const claims     = _parsedDocs.filter(d => d._isClaim);

  // Неструктурированные документы
  const declarations = _parsedDocs.filter(d => d.тип === 'декларация_соответствия');
  const certificates = _parsedDocs.filter(d => d.тип === 'сертификат_соответствия');
  const warranties   = _parsedDocs.filter(d => d.тип === 'гарантийный_талон');
  const memos        = _parsedDocs.filter(d => d.тип === 'служебная_записка');
  const passports    = _parsedDocs.filter(d => d.тип === 'паспорт_изделия');
  const letters      = _parsedDocs.filter(d => ['письмо','доверенность','иной_документ'].includes(d.тип));

  info.contract   = contract;
  info.upd        = upd;
  info.invoices   = invoices;
  info.registry   = registry;
  info.advance    = advance;
  info.unstructured = { declarations, certificates, warranties, memos, passports, letters };
  info.claims = claims;

  // ── Список наименований товаров из договора ────────────────────
  const contractProductNames = (contract?.товары || []).map(t => _norm(t.наименование));

  // ─────────────────────────────────────────────────────────────────
  // 1. РЕКВИЗИТЫ СТОРОН
  // ─────────────────────────────────────────────────────────────────
  if (contract) {
    const cSupInn = _norm(contract.поставщик?.инн);
    const cCusInn = _norm(contract.заказчик?.инн);

    for (const doc of _parsedDocs.filter(d => !d._isUnstructured)) {
      if (doc === contract) continue;

      const dSupInn = _norm(doc.поставщик?.инн);
      if (dSupInn && cSupInn && dSupInn !== cSupInn) {
        issues.push({ level:'critical', doc:doc.fileName, field:'ИНН поставщика',
          expected:cSupInn, actual:dSupInn,
          message:`ИНН поставщика «${dSupInn}» ≠ договорному «${cSupInn}»` });
      }

      const dCusInn = _norm(doc.заказчик?.инн);
      if (dCusInn && cCusInn && dCusInn !== cCusInn) {
        issues.push({ level:'critical', doc:doc.fileName, field:'ИНН заказчика',
          expected:cCusInn, actual:dCusInn,
          message:`ИНН заказчика «${dCusInn}» ≠ договорному «${cCusInn}»` });
      }

      const cSupName = _norm(contract.поставщик?.наименование);
      const dSupName = _norm(doc.поставщик?.наименование);
      if (cSupName && dSupName && !_fuzzyMatch(cSupName, dSupName)) {
        issues.push({ level:'significant', doc:doc.fileName, field:'Наименование поставщика',
          expected:contract.поставщик?.наименование, actual:doc.поставщик?.наименование,
          message:`Наименование поставщика отличается от договора` });
      }

      if (doc.договор_номер && contract.номер) {
        const docRef = _norm(doc.договор_номер);
        const cNum   = _norm(contract.номер);
        if (docRef && cNum && !docRef.includes(cNum) && !cNum.includes(docRef)) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Номер договора',
            expected:contract.номер, actual:doc.договор_номер,
            message:`Ссылка на договор «${doc.договор_номер}» не совпадает с «${contract.номер}»` });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 2. ХРОНОЛОГИЯ
  // ─────────────────────────────────────────────────────────────────
  const dates = _parsedDocs
    .filter(d => d.дата)
    .map(d => ({ doc:d.fileName, тип:d.тип, date:_parseDate(d.дата) }))
    .filter(d => d.date)
    .sort((a,b) => a.date - b.date);
  info.chronology = dates;

  if (upd && upd.дата) {
    const updDate = _parseDate(upd.дата);
    for (const inv of invoices) {
      if (!inv.дата) continue;
      const invDate = _parseDate(inv.дата);
      if (invDate && updDate && invDate > updDate) {
        issues.push({ level:'critical', doc:inv.fileName, field:'Хронология',
          expected:`≤ ${upd.дата} (дата УПД)`, actual:inv.дата,
          message:`Дата накладной ${inv.дата} позже даты УПД ${upd.дата}` });
      }
    }
  }

  if (invoices.length > 0 && checks.length > 0) {
    const firstInvDate = invoices.map(d => _parseDate(d.дата)).filter(Boolean).sort((a,b)=>a-b)[0];
    for (const chk of checks) {
      const chkDate = _parseDate(chk.дата);
      if (chkDate && firstInvDate && chkDate < firstInvDate) {
        issues.push({ level:'significant', doc:chk.fileName, field:'Хронология',
          message:`Акт проверки (${chk.дата}) датирован раньше первой поставки` });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 3. СВОДНАЯ СВЕРКА ПЕРВИЧКА vs УПД
  // ─────────────────────────────────────────────────────────────────
  if (upd && invoices.length > 0) {
    const updTotal = _toNum(upd.итого_с_ндс) || _toNum(upd.итого_без_ндс);
    const updQty   = _toNum(upd.итого_количество);
    const updNds   = _toNum(upd.итого_ндс);

    let invTotalSum = 0, invTotalQty = 0, invTotalNds = 0;
    for (const inv of invoices) {
      invTotalSum += _toNum(inv.итого_с_ндс) || _toNum(inv.итого_без_ндс) || 0;
      invTotalQty += _toNum(inv.итого_количество) || 0;
      invTotalNds += _toNum(inv.итого_ндс) || 0;
    }

    info.summaryCheck = { updTotal, updQty, updNds, invTotalSum, invTotalQty, invTotalNds };

    if (updTotal && invTotalSum && Math.abs(updTotal - invTotalSum) > 0.01) {
      issues.push({ level:'critical', doc:'Сводная сверка', field:'Итоговая сумма',
        expected:_fmt(updTotal)+' (УПД)', actual:_fmt(invTotalSum)+' (накладные)',
        message:`Сумма по накладным ${_fmt(invTotalSum)} ≠ сумме УПД ${_fmt(updTotal)}. Расхождение: ${_fmt(Math.abs(updTotal-invTotalSum))} руб.` });
    }
    if (updQty && invTotalQty && Math.abs(updQty - invTotalQty) > 0.001) {
      issues.push({ level:'critical', doc:'Сводная сверка', field:'Итоговое количество',
        expected:updQty+' (УПД)', actual:invTotalQty+' (накладные)',
        message:`Кол-во по накладным ${invTotalQty} ≠ кол-ву в УПД ${updQty}. Расхождение: ${Math.abs(updQty-invTotalQty)}` });
    }
    if (updNds && invTotalNds && Math.abs(updNds - invTotalNds) > 0.01) {
      issues.push({ level:'critical', doc:'Сводная сверка', field:'НДС',
        expected:_fmt(updNds)+' (УПД)', actual:_fmt(invTotalNds)+' (накладные)',
        message:`НДС по накладным ${_fmt(invTotalNds)} ≠ НДС в УПД ${_fmt(updNds)}. Расхождение: ${_fmt(Math.abs(updNds-invTotalNds))} руб.` });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 4. ВНУТРЕННЯЯ АРИФМЕТИКА СТРУКТУРИРОВАННЫХ ДОКУМЕНТОВ
  // ─────────────────────────────────────────────────────────────────
  for (const doc of _parsedDocs.filter(d => !d._isUnstructured)) {
    if (!doc.товары || doc.товары.length === 0) continue;
    _checkInternalArithmetic(doc).forEach(a => {
      if (!issues.find(i => i.doc === doc.fileName && i.field === a.field))
        issues.push({ ...a, doc: doc.fileName });
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // 5. РАСЧЁТ ПЛАТЕЖЕЙ
  // ─────────────────────────────────────────────────────────────────
  if (contract) {
    const contractSum = _toNum(contract.сумма_договора);
    const advancePct  = _toNum(contract.аванс_процент);
    const advanceSum  = _toNum(contract.аванс_сумма);

    if (contractSum && advancePct && advanceSum) {
      const expected = _round2(contractSum * advancePct / 100);
      if (Math.abs(expected - advanceSum) > 1) {
        issues.push({ level:'significant', doc:contract.fileName, field:'Аванс',
          expected:_fmt(expected), actual:_fmt(advanceSum),
          message:`Сумма аванса ${_fmt(advanceSum)} ≠ ${advancePct}% от суммы договора ${_fmt(contractSum)} = ${_fmt(expected)}` });
      }
    }
    if (advance && contractSum) {
      const advDocSum = _toNum(advance.итого_с_ндс) || _toNum(advance.итого_без_ндс);
      if (advDocSum && advancePct) {
        const expected = _round2(contractSum * advancePct / 100);
        if (Math.abs(advDocSum - expected) > 1) {
          issues.push({ level:'significant', doc:advance.fileName, field:'Сумма аванс-счёта',
            expected:_fmt(expected), actual:_fmt(advDocSum),
            message:`Сумма авансового счёта ${_fmt(advDocSum)} ≠ ожидаемому авансу ${_fmt(expected)}` });
        }
      }
    }
    info.payments = { contractSum, advancePct, advanceSum };
  }

  // ─────────────────────────────────────────────────────────────────
  // 6. НАИМЕНОВАНИЯ ТОВАРОВ В ПЕРВИЧКЕ vs ДОГОВОР
  // ─────────────────────────────────────────────────────────────────
  if (contractProductNames.length > 0) {
    for (const doc of invoices) {
      if (!doc.товары) continue;
      for (const item of doc.товары) {
        const itemName = _norm(item.наименование);
        if (itemName && !contractProductNames.some(cn => _fuzzyMatch(cn, itemName))) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Наименование товара',
            expected:contract.товары[0]?.наименование, actual:item.наименование,
            message:`Наименование «${item.наименование}» не найдено в договоре` });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 7. ДЕКЛАРАЦИИ И СЕРТИФИКАТЫ СООТВЕТСТВИЯ
  // ─────────────────────────────────────────────────────────────────
  const today = new Date();

  for (const doc of [...declarations, ...certificates]) {
    // 7а. Срок действия
    if (doc.дата_окончания) {
      const expDate = _parseDate(doc.дата_окончания);
      if (expDate && expDate < today) {
        issues.push({ level:'critical', doc:doc.fileName, field:'Срок действия',
          expected:`> ${today.toLocaleDateString('ru-RU')}`, actual:doc.дата_окончания,
          message:`Срок действия документа истёк: ${doc.дата_окончания}` });
      }
    } else {
      issues.push({ level:'formal', doc:doc.fileName, field:'Срок действия',
        message:`Срок действия не указан или не удалось определить` });
    }

    // 7б. Наличие печати и подписи
    if (doc.печать_присутствует === false) {
      issues.push({ level:'significant', doc:doc.fileName, field:'Печать',
        message:`Печать отсутствует в документе` });
    }
    if (doc.подпись_присутствует === false) {
      issues.push({ level:'significant', doc:doc.fileName, field:'Подпись',
        message:`Подпись отсутствует в документе` });
    }

    // 7в. Соответствие наименования товара договору
    if (contractProductNames.length > 0 && doc.товары?.length > 0) {
      for (const item of doc.товары) {
        const itemName = _norm(item.наименование);
        if (itemName && !contractProductNames.some(cn => _fuzzyMatch(cn, itemName))) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Наименование товара',
            expected:contract?.товары?.[0]?.наименование, actual:item.наименование,
            message:`Товар «${item.наименование}» в документе не соответствует договору` });
        }
      }
    }

    // 7г. Орган сертификации
    if (!doc.орган_сертификации) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Орган сертификации',
        message:`Орган по сертификации не указан или не распознан` });
    }

    // 7д. Технические регламенты
    if (!doc.технические_регламенты || doc.технические_регламенты.length === 0) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Технические регламенты',
        message:`Список ТР ТС / ГОСТ не указан или не распознан` });
    }

    // 7е. Изготовитель vs поставщик (для сертификатов)
    if (doc.тип === 'сертификат_соответствия' && doc.заявитель?.инн && contract?.поставщик?.инн) {
      const certApplicantInn = _norm(doc.заявитель.инн);
      const supInn = _norm(contract.поставщик.инн);
      if (certApplicantInn && supInn && certApplicantInn !== supInn) {
        issues.push({ level:'formal', doc:doc.fileName, field:'Заявитель сертификата',
          expected:contract.поставщик.инн, actual:doc.заявитель.инн,
          message:`ИНН заявителя сертификата «${doc.заявитель.инн}» ≠ ИНН поставщика «${contract.поставщик.инн}». Возможно, заявитель — производитель (норма).` });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 8. ГАРАНТИЙНЫЕ ТАЛОНЫ
  // ─────────────────────────────────────────────────────────────────
  for (const doc of warranties) {
    // 8а. Гарантийный срок
    if (!doc.гарантийный_срок && !doc.гарантийный_срок_месяцев) {
      issues.push({ level:'significant', doc:doc.fileName, field:'Гарантийный срок',
        message:`Гарантийный срок не указан или не распознан` });
    }

    // 8б. Наименование товара
    if (contractProductNames.length > 0 && doc.товары?.length > 0) {
      for (const item of doc.товары) {
        const itemName = _norm(item.наименование);
        if (itemName && !contractProductNames.some(cn => _fuzzyMatch(cn, itemName))) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Наименование товара',
            expected:contract?.товары?.[0]?.наименование, actual:item.наименование,
            message:`Товар «${item.наименование}» в гарантийном талоне не соответствует договору` });
        }
      }
    }

    // 8в. Наличие подписи
    if (doc.подпись_присутствует === false) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Подпись',
        message:`Подпись в гарантийном талоне отсутствует` });
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 9. СЛУЖЕБНЫЕ ЗАПИСКИ
  // ─────────────────────────────────────────────────────────────────
  for (const doc of memos) {
    // 9а. Наличие адресата
    if (!doc.кому) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Адресат',
        message:`Адресат служебной записки не указан или не распознан` });
    }
    // 9б. Наличие темы
    if (!doc.тема) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Тема',
        message:`Тема/суть служебной записки не указана` });
    }
    // 9в. Наличие подписи
    if (doc.подпись_присутствует === false) {
      issues.push({ level:'formal', doc:doc.fileName, field:'Подпись',
        message:`Подпись в служебной записке отсутствует` });
    }
    // 9г. Ссылка на договор
    if (contract && doc.договор_номер) {
      const docRef = _norm(doc.договор_номер);
      const cNum   = _norm(contract.номер);
      if (docRef && cNum && !docRef.includes(cNum) && !cNum.includes(docRef)) {
        issues.push({ level:'significant', doc:doc.fileName, field:'Ссылка на договор',
          expected:contract.номер, actual:doc.договор_номер,
          message:`Ссылка на договор в записке «${doc.договор_номер}» не совпадает с «${contract.номер}»` });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 10. ПАСПОРТА ИЗДЕЛИЙ
  // ─────────────────────────────────────────────────────────────────
  for (const doc of passports) {
    if (contractProductNames.length > 0 && doc.товары?.length > 0) {
      for (const item of doc.товары) {
        const itemName = _norm(item.наименование);
        if (itemName && !contractProductNames.some(cn => _fuzzyMatch(cn, itemName))) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Наименование товара',
            expected:contract?.товары?.[0]?.наименование, actual:item.наименование,
            message:`Товар «${item.наименование}» в паспорте изделия не соответствует договору` });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 10. ПРЕТЕНЗИИ
  // ─────────────────────────────────────────────────────────────────
  for (const doc of claims) {
    // 10а. ИНН сторон vs договор
    if (contract) {
      const cSupInn = _norm(contract.поставщик?.инн);
      const cCusInn = _norm(contract.заказчик?.инн);
      const claimantInn   = _norm(doc.заявитель?.инн);
      const respondentInn = _norm(doc.ответчик?.инн);
      if (claimantInn && respondentInn) {
        const knownInns = new Set([cSupInn, cCusInn].filter(Boolean));
        if (claimantInn && !knownInns.has(claimantInn)) {
          issues.push({ level:'critical', doc:doc.fileName, field:'ИНН заявителя претензии',
            expected:`${cCusInn} (заказчик) или ${cSupInn} (поставщик)`,
            actual: doc.заявитель?.инн,
            message:`ИНН заявителя претензии «${doc.заявитель?.инн}» не совпадает ни с ИНН заказчика, ни с ИНН поставщика из договора` });
        }
        if (respondentInn && !knownInns.has(respondentInn)) {
          issues.push({ level:'critical', doc:doc.fileName, field:'ИНН ответчика претензии',
            expected:`${cCusInn} (заказчик) или ${cSupInn} (поставщик)`,
            actual: doc.ответчик?.инн,
            message:`ИНН ответчика претензии «${doc.ответчик?.инн}» не совпадает ни с ИНН заказчика, ни с ИНН поставщика из договора` });
        }
      }
      // Ссылка на договор
      if (doc.договор_номер && contract.номер) {
        const docRef = _norm(doc.договор_номер);
        const cNum   = _norm(contract.номер);
        if (docRef && cNum && !docRef.includes(cNum) && !cNum.includes(docRef)) {
          issues.push({ level:'critical', doc:doc.fileName, field:'Номер договора в претензии',
            expected:contract.номер, actual:doc.договор_номер,
            message:`Претензия ссылается на договор «${doc.договор_номер}», но в пакете договор «${contract.номер}»` });
        }
      }
    }

    // 10б. Срок ответа — 30 дней по 44-ФЗ ч.5 ст.95
    const claimDate = _parseDate(doc.дата);
    if (claimDate) {
      const deadline30 = new Date(claimDate);
      deadline30.setDate(deadline30.getDate() + 30);
      if (doc.срок_ответа_дней !== null && doc.срок_ответа_дней !== undefined) {
        const days = _toNum(doc.срок_ответа_дней);
        if (days > 0 && days !== 30) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Срок ответа на претензию',
            expected:'30 дней (44-ФЗ ч.5 ст.95)', actual:`${days} дней`,
            message:`Указан срок ответа ${days} дн. По 44-ФЗ ч.5 ст.95 стандартный срок — 30 дней` });
        }
      }
      if (doc.дата_ответа_до) {
        const deadlineDoc = _parseDate(doc.дата_ответа_до);
        if (deadlineDoc && Math.abs(deadlineDoc - deadline30) > 86400000 * 3) {
          issues.push({ level:'formal', doc:doc.fileName, field:'Дата ответа на претензию',
            expected:deadline30.toLocaleDateString('ru-RU'), actual:doc.дата_ответа_до,
            message:`Срок ответа ${doc.дата_ответа_до} отличается от расчётного по 44-ФЗ (${deadline30.toLocaleDateString('ru-RU')})` });
        }
      }
    }

    // 10в. Расчёт пени: пени = база × % × дни
    if (doc.сумма_пени && doc.пеня_процент_день && doc.период_просрочки_дней) {
      const base = _toNum(contract?.сумма_договора) || _toNum(doc.сумма_претензии);
      if (base) {
        const calcPeni = _round2(base * (_toNum(doc.пеня_процент_день) / 100) * _toNum(doc.период_просрочки_дней));
        const docPeni  = _toNum(doc.сумма_пени);
        if (docPeni && Math.abs(calcPeni - docPeni) > 1) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Расчёт пени',
            expected:_fmt(calcPeni), actual:_fmt(docPeni),
            message:`Расчётная пеня ${_fmt(calcPeni)} ≠ заявленной ${_fmt(docPeni)} (база ${_fmt(base)} × ${doc.пеня_процент_день}% × ${doc.период_просрочки_дней} дн.)` });
        }
      }
    }

    // 10г. Наличие подписи и печати
    if (doc.подпись_присутствует === false) {
      issues.push({ level:'critical', doc:doc.fileName, field:'Подпись',
        message:`Претензия не подписана — юридически недействительна` });
    }
    if (doc.печать_присутствует === false) {
      issues.push({ level:'significant', doc:doc.fileName, field:'Печать',
        message:`Претензия не содержит печати организации` });
    }

    // 10д. Наличие ссылок на первичные документы
    if (!doc.ссылки_на_документы || doc.ссылки_на_документы.length === 0) {
      issues.push({ level:'significant', doc:doc.fileName, field:'Ссылки на документы',
        message:`Претензия не содержит ссылок на конкретные первичные документы (накладные, акты), подтверждающие нарушение` });
    }

    // 10е. Наименования товаров в претензии vs договор
    if (contractProductNames.length > 0 && doc.товары?.length > 0) {
      for (const item of doc.товары) {
        const itemName = _norm(item.наименование);
        if (itemName && !contractProductNames.some(cn => _fuzzyMatch(cn, itemName))) {
          issues.push({ level:'significant', doc:doc.fileName, field:'Наименование товара в претензии',
            expected:contract?.товары?.[0]?.наименование, actual:item.наименование,
            message:`Товар «${item.наименование}» в претензии не найден в договоре` });
        }
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // 11. ЗАМЕЧАНИЯ ОТ AI ИЗ КАЖДОГО ДОКУМЕНТА
  // ─────────────────────────────────────────────────────────────────
  for (const doc of _parsedDocs) {
    if (doc.замечания?.length > 0) {
      for (const z of doc.замечания) {
        issues.push({ level:'formal', doc:doc.fileName, field:'AI-замечание',
          message:z });
      }
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // ИТОГОВАЯ СТАТИСТИКА
  // ─────────────────────────────────────────────────────────────────
  info.unstructuredSummary = {
    claims:       claims.length,
    declarations: declarations.length,
    certificates: certificates.length,
    warranties:   warranties.length,
    memos:        memos.length,
    passports:    passports.length,
    letters:      letters.length,
  };

  return { issues, info };
}

// ── Вспомогательные функции ────────────────────────────────────────

function _checkInternalArithmetic(doc) {
  const issues = [];
  if (!doc.товары || doc.товары.length === 0) return issues;

  let calcTotal = 0, calcNds = 0;
  for (const item of doc.товары) {
    const qty   = _toNum(item.количество);
    const price = _toNum(item.цена);
    const sum   = _toNum(item.сумма_без_ндс) || _toNum(item.сумма_с_ндс);
    const nds   = _toNum(item.ндс_сумма);
    if (qty && price && sum) {
      const expected = _round2(qty * price);
      if (Math.abs(expected - sum) > 0.02) {
        issues.push({ level:'significant',
          field:`Арифметика: ${item.наименование?.slice(0,40)}`,
          message:`${qty} × ${_fmt(price)} = ${_fmt(expected)}, в документе: ${_fmt(sum)} (расхождение ${_fmt(Math.abs(expected-sum))} руб.)` });
      }
    }
    if (sum) calcTotal += sum;
    if (nds)  calcNds  += nds;
  }

  const docTotal = _toNum(doc.итого_с_ндс) || _toNum(doc.итого_без_ндс);
  const docNds   = _toNum(doc.итого_ндс);
  if (docTotal && calcTotal && Math.abs(docTotal - calcTotal) > 0.02) {
    issues.push({ level:'significant', field:'Итоговая сумма документа',
      message:`Сумма строк ${_fmt(calcTotal)} ≠ итогу ${_fmt(docTotal)} (расхождение ${_fmt(Math.abs(docTotal-calcTotal))} руб.)` });
  }
  if (docNds && calcNds && Math.abs(docNds - calcNds) > 0.02) {
    issues.push({ level:'significant', field:'Итоговый НДС',
      message:`НДС строк ${_fmt(calcNds)} ≠ итоговому НДС ${_fmt(docNds)} (расхождение ${_fmt(Math.abs(docNds-calcNds))} руб.)` });
  }
  return issues;
}

function _norm(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g,' ').trim();
}

function _fuzzyMatch(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (a.includes(b) || b.includes(a)) return true;
  // Совпадение первых 10 символов
  if (a.length >= 10 && b.length >= 10 && a.slice(0,10) === b.slice(0,10)) return true;
  // Совпадение по словам (≥ 2 общих значимых слова)
  const wa = new Set(a.split(/\s+/).filter(w => w.length > 3));
  const wb = b.split(/\s+/).filter(w => w.length > 3);
  const common = wb.filter(w => wa.has(w)).length;
  if (common >= 2) return true;
  return false;
}

function _parseDate(s) {
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return new Date(s);
  const m = s.match(/(\d{1,2})\.(\d{2})\.(\d{4})/);
  if (m) return new Date(`${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`);
  return null;
}

function _toNum(v) {
  if (v === null || v === undefined || v === '') return 0;
  const n = parseFloat(String(v).replace(/\s/g,'').replace(',','.'));
  return isNaN(n) ? 0 : n;
}

function _round2(n) { return Math.round(n * 100) / 100; }

function _fmt(n) {
  if (!n && n !== 0) return '—';
  return Number(n).toLocaleString('ru-RU', { minimumFractionDigits:2, maximumFractionDigits:2 });
}

// ═══════════════════════════════════════════════════════════════════
// ЭТАП 3: AI ЗАКЛЮЧЕНИЕ
// ═══════════════════════════════════════════════════════════════════

async function _stage3_conclude(onProgress) {
  onProgress('Этап 3/3 — AI формирует заключение…');

  const extraPrompt = (document.getElementById('dcPromptInput')?.value || '').trim();

  const docsJson = JSON.stringify(_parsedDocs.map(d => ({
    fileName:             d.fileName,
    тип:                  d.тип,
    _isUnstructured:      d._isUnstructured,
    номер:                d.номер,
    дата:                 d.дата,
    дата_окончания:       d.дата_окончания,
    заказчик:             d.заказчик,
    поставщик:            d.поставщик,
    изготовитель:         d.изготовитель,
    заявитель:            d.заявитель,
    получатель:           d.получатель,
    договор_номер:        d.договор_номер,
    товары:               d.товары?.slice(0, 15),
    итого_количество:     d.итого_количество,
    итого_без_ндс:        d.итого_без_ндс,
    итого_ндс:            d.итого_ндс,
    итого_с_ндс:          d.итого_с_ндс,
    аванс_процент:        d.аванс_процент,
    аванс_сумма:          d.аванс_сумма,
    сумма_договора:       d.сумма_договора,
    орган_сертификации:   d.орган_сертификации,
    технические_регламенты: d.технические_регламенты,
    гарантийный_срок:     d.гарантийный_срок,
    печать_присутствует:  d.печать_присутствует,
    подпись_присутствует: d.подпись_присутствует,
    тема:                 d.тема,
    кому:                 d.кому,
    от_кого:              d.от_кого,
    // Поля претензии
    основание:            d.основание,
    тип_нарушения:        d.тип_нарушения,
    требования:           d.требования,
    сумма_претензии:      d.сумма_претензии,
    сумма_штрафа:         d.сумма_штрафа,
    сумма_пени:           d.сумма_пени,
    пеня_процент_день:    d.пеня_процент_день,
    период_просрочки_дней:d.период_просрочки_дней,
    срок_ответа_дней:     d.срок_ответа_дней,
    дата_ответа_до:       d.дата_ответа_до,
    ссылки_на_документы:  d.ссылки_на_документы,
    ответчик:             d.ответчик,
    замечания:            d.замечания,
  })), null, 2);

  const crossJson = JSON.stringify({
    всего_проблем:   _crossCheck.issues.length,
    критических:     _crossCheck.issues.filter(i => i.level === 'critical').length,
    существенных:    _crossCheck.issues.filter(i => i.level === 'significant').length,
    формальных:      _crossCheck.issues.filter(i => i.level === 'formal').length,
    проблемы:        _crossCheck.issues,
    агрегированные_данные: {
      хронология:          _crossCheck.info.chronology,
      претензии:           (_crossCheck.info.claims||[]).map(c => ({
        файл:c.fileName, основание:c.основание, тип_нарушения:c.тип_нарушения,
        требования:c.требования, сумма:c.сумма_претензии,
        пени:c.сумма_пени, срок_ответа_дней:c.срок_ответа_дней,
      })),
      сводная_сверка:      _crossCheck.info.summaryCheck,
      платежи:             _crossCheck.info.payments,
      неструктурированные: _crossCheck.info.unstructuredSummary,
    }
  }, null, 2);

  const userMsg = [
    '## Структурированные данные по документам:\n```json\n' + docsJson + '\n```',
    '\n## Результаты программной сверки:\n```json\n' + crossJson + '\n```',
    extraPrompt ? `\n## Дополнительные указания:\n${extraPrompt}` : '',
  ].join('');

  const result = await miniappsAI.callModel({
    modelId: MODEL_CONCLUDE,
    messages: [
      { role: 'system', content: CONCLUDE_SYSTEM },
      { role: 'user',   content: userMsg },
    ],
    timeoutMs: 180000,
  });

  return miniappsAI.extractText(result);
}

// ═══════════════════════════════════════════════════════════════════
// ОСНОВНОЙ ЗАПУСК
// ═══════════════════════════════════════════════════════════════════

async function _runAnalysis() {
  if (_analysing || _files.length === 0) return;
  _analysing = true;

  const analyseBtn  = document.getElementById('dcAnalyseBtn');
  const downloadBtn = document.getElementById('dcDownloadBtn');
  const progressEl  = document.getElementById('dcProgress');

  if (analyseBtn)  { analyseBtn.disabled = true; analyseBtn.textContent = '⏳ Анализирую…'; }
  if (downloadBtn) downloadBtn.classList.add('hidden');
  _showProgressPanel();

  const onProgress = (msg) => {
    _setStatus(msg, 'info');
    if (progressEl) progressEl.textContent = msg;
  };

  try {
    await _stage1_extractStructured(onProgress);
    _renderExtractedCards();

    onProgress('Этап 2/3 — программная сверка данных…');
    await new Promise(r => setTimeout(r, 100));
    _crossCheck = _stage2_crossCheck();
    _renderCrossCheckPanel();

    _reportMd = await _stage3_conclude(onProgress);
    if (!_reportMd) throw new Error('Модель вернула пустой ответ');

    _renderReport(_reportMd);
    if (downloadBtn) downloadBtn.classList.remove('hidden');
    const n = _crossCheck.issues.length;
    const c = _crossCheck.issues.filter(i => i.level === 'critical').length;
    _setStatus(`✅ Анализ завершён · Найдено проблем: ${n} (критических: ${c})`, 'success');

  } catch (err) {
    const msg = err?.message || String(err);
    _showError(msg);
    _setStatus('Ошибка: ' + msg, 'error');
  } finally {
    _analysing = false;
    if (analyseBtn) {
      analyseBtn.disabled = _files.length === 0;
      analyseBtn.textContent = '🔍 Проверить документы';
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// РЕНДЕР UI
// ═══════════════════════════════════════════════════════════════════

function _showProgressPanel() {
  const wrap = document.getElementById('dcReportWrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="flex flex-col items-center justify-center gap-4 py-10">
      <div class="w-10 h-10 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
      <p id="dcProgress" class="text-sm text-slate-400 text-center">Запускаю анализ…</p>
      <div class="text-xs text-slate-500 text-center space-y-1">
        <p>Этап 1: определение типов + извлечение структуры</p>
        <p>Этап 2: программная сверка реквизитов, сумм, сроков</p>
        <p>Этап 3: AI заключение с рекомендациями</p>
      </div>
    </div>`;
}

function _renderExtractedCards() {
  const wrap = document.getElementById('dcReportWrap');
  if (!wrap) return;

  const cards = _parsedDocs.map(doc => {
    const typeLabel = _docTypeLabel(doc.тип);
    const hasError  = doc._error || doc._parseError;
    const isUnstr   = doc._isUnstructured;
    const isClaim   = doc._isClaim;

    // Поля для претензии
    const claimFields = isClaim ? [
      doc.номер   ? `<span>№ ${doc.номер}</span>` : '',
      doc.дата    ? `<span>📅 ${doc.дата}</span>` : '',
      doc.тип_нарушения ? `<span class="text-amber-300">⚠ ${doc.тип_нарушения.replace(/_/g,' ')}</span>` : '',
      doc.основание ? `<span class="col-span-2 italic text-slate-400">${doc.основание}</span>` : '',
      doc.сумма_претензии ? `<span class="text-red-400">💰 Сумма: ${_fmt(doc.сумма_претензии)} руб.</span>` : '',
      doc.сумма_пени      ? `<span class="text-red-300">📉 Пени: ${_fmt(doc.сумма_пени)} руб.</span>` : '',
      doc.срок_ответа_дней ? `<span>⏱ Срок ответа: ${doc.срок_ответа_дней} дн.</span>` : '',
      doc.требования?.length ? `<span class="col-span-2 text-slate-300">📋 ${doc.требования.slice(0,2).join('; ')}${doc.требования.length>2?' …':''}</span>` : '',
      doc.подпись_присутствует === false ? `<span class="text-red-400">🔴 Нет подписи</span>` : '',
      doc.печать_присутствует  === false ? `<span class="text-amber-400">⚠ Нет печати</span>` : '',
    ].filter(Boolean).join('') : null;

    // Дополнительные поля для неструктурированных
    const extraFields = isUnstr ? [
      doc.дата_окончания ? `<span>⏳ Действует до: ${doc.дата_окончания}</span>` : '',
      doc.орган_сертификации ? `<span>🏛 ${doc.орган_сертификации}</span>` : '',
      doc.гарантийный_срок ? `<span>🛡 Гарантия: ${doc.гарантийный_срок}</span>` : '',
      doc.тема ? `<span class="col-span-2 italic text-slate-400">${doc.тема}</span>` : '',
      doc.товары?.[0]?.наименование ? `<span class="col-span-2 text-cyan-300">📦 ${doc.товары[0].наименование}${doc.товары.length > 1 ? ` +${doc.товары.length-1}` : ''}</span>` : '',
      doc.печать_присутствует === false ? `<span class="text-amber-400">⚠ Нет печати</span>` : '',
      doc.подпись_присутствует === false ? `<span class="text-amber-400">⚠ Нет подписи</span>` : '',
    ].filter(Boolean).join('') : [
      doc.номер ? `<span>№ ${doc.номер}</span>` : '',
      doc.дата  ? `<span>📅 ${doc.дата}</span>` : '',
      doc.поставщик?.инн  ? `<span>Пост. ИНН: ${doc.поставщик.инн}</span>` : '',
      doc.заказчик?.инн   ? `<span>Зак. ИНН: ${doc.заказчик.инн}</span>` : '',
      doc.итого_с_ндс     ? `<span class="text-green-400">Итого: ${_fmt(doc.итого_с_ндс)} руб.</span>` : '',
      doc.итого_количество? `<span>Кол-во: ${doc.итого_количество}</span>` : '',
    ].filter(Boolean).join('');

    const borderClass = hasError ? 'border-red-500/20 bg-red-500/[0.04]'
                      : isClaim  ? 'border-orange-500/20 bg-orange-500/[0.04]'
                      : isUnstr  ? 'border-violet-500/20 bg-violet-500/[0.03]'
                      :            'border-white/10 bg-white/[0.03]';
    const badgeClass  = hasError ? 'bg-red-500/20 text-red-400'
                      : isClaim  ? 'bg-orange-400/15 text-orange-300'
                      : isUnstr  ? 'bg-violet-400/15 text-violet-300'
                      :            'bg-cyan-400/10 text-cyan-300';
    const fieldsToRender = isClaim ? claimFields : extraFields;

    return `
      <div class="rounded-xl border ${borderClass} p-3 mb-2">
        <div class="flex items-center gap-2 mb-1">
          <span class="text-base">${_docTypeIcon(doc.тип)}</span>
          <span class="text-xs font-semibold text-white truncate">${doc.fileName}</span>
          <span class="ml-auto shrink-0 text-[10px] px-2 py-0.5 rounded-full ${badgeClass}">${typeLabel}</span>
        </div>
        <div class="grid grid-cols-2 gap-x-4 gap-y-0.5 text-[11px] text-slate-400">
          ${fieldsToRender}
          ${hasError ? `<span class="col-span-2 text-red-400">⚠ ${doc._error || 'Ошибка разбора JSON'}</span>` : ''}
        </div>
      </div>`;
  }).join('');

  const claimCount  = _parsedDocs.filter(d =>  d._isClaim).length;
  const structCount = _parsedDocs.filter(d => !d._isUnstructured && !d._isClaim).length;
  const unstrCount  = _parsedDocs.filter(d =>  d._isUnstructured).length;

  wrap.innerHTML = `
    <div id="dcExtractedSection" class="mb-4">
      <div class="flex items-center gap-2 mb-2">
        <h3 class="text-xs font-bold text-slate-400 uppercase tracking-wide">Этап 1 — Извлечённые данные</h3>
        <span class="text-[10px] px-2 py-0.5 rounded-full bg-cyan-400/10 text-cyan-300">${structCount} финанс.</span>
        ${claimCount ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-orange-400/15 text-orange-300">${claimCount} претензий</span>` : ''}
        ${unstrCount ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-violet-400/15 text-violet-300">${unstrCount} иных</span>` : ''}
      </div>
      ${cards}
    </div>
    <div id="dcCrossCheckSection"></div>
    <div id="dcFinalReportSection">
      <div class="flex items-center justify-center gap-3 py-8">
        <div class="w-6 h-6 border-2 border-cyan-400 border-t-transparent rounded-full animate-spin"></div>
        <span class="text-xs text-slate-400">Ожидание AI заключения…</span>
      </div>
    </div>`;
}

function _renderCrossCheckPanel() {
  const section = document.getElementById('dcCrossCheckSection');
  if (!section || !_crossCheck) return;

  const { issues } = _crossCheck;
  const critical    = issues.filter(i => i.level === 'critical');
  const significant = issues.filter(i => i.level === 'significant');
  const formal      = issues.filter(i => i.level === 'formal');

  const renderIssues = (list, borderColor, icon) => list.map(i => `
    <div class="flex gap-2 rounded-lg border ${borderColor} px-3 py-2 mb-1.5 text-xs">
      <span class="shrink-0 mt-0.5">${icon}</span>
      <div class="min-w-0">
        <span class="font-semibold text-white">${i.doc}</span>
        ${i.field ? ` · <span class="text-slate-400">${i.field}</span>` : ''}
        <p class="text-slate-300 mt-0.5 break-words">${i.message}</p>
        ${i.expected ? `<p class="text-slate-500 mt-0.5">Ожидалось: ${i.expected} / Факт: ${i.actual}</p>` : ''}
      </div>
    </div>`).join('');

  const summaryCheck = _crossCheck.info.summaryCheck;
  const summaryHtml = summaryCheck ? `
    <div class="rounded-xl border border-white/10 bg-white/[0.02] p-3 mb-3">
      <p class="text-xs font-bold text-slate-300 mb-2">Сводная сверка первичка ↔ УПД</p>
      <table class="w-full text-xs">
        <thead><tr class="text-slate-500">
          <th class="text-left pb-1">Показатель</th>
          <th class="text-right pb-1">УПД</th>
          <th class="text-right pb-1">Накладные</th>
          <th class="text-right pb-1">Расхождение</th>
        </tr></thead>
        <tbody>
          <tr class="${Math.abs((summaryCheck.updTotal||0)-(summaryCheck.invTotalSum||0))>0.01?'text-red-400':'text-green-400'}">
            <td class="py-0.5">Сумма</td>
            <td class="text-right">${_fmt(summaryCheck.updTotal)}</td>
            <td class="text-right">${_fmt(summaryCheck.invTotalSum)}</td>
            <td class="text-right">${_fmt(Math.abs((summaryCheck.updTotal||0)-(summaryCheck.invTotalSum||0)))}</td>
          </tr>
          <tr class="${Math.abs((summaryCheck.updQty||0)-(summaryCheck.invTotalQty||0))>0.001?'text-red-400':'text-green-400'}">
            <td class="py-0.5">Количество</td>
            <td class="text-right">${summaryCheck.updQty||'—'}</td>
            <td class="text-right">${summaryCheck.invTotalQty||'—'}</td>
            <td class="text-right">${Math.abs((summaryCheck.updQty||0)-(summaryCheck.invTotalQty||0))||'0'}</td>
          </tr>
          <tr class="${Math.abs((summaryCheck.updNds||0)-(summaryCheck.invTotalNds||0))>0.01?'text-red-400':'text-green-400'}">
            <td class="py-0.5">НДС</td>
            <td class="text-right">${_fmt(summaryCheck.updNds)}</td>
            <td class="text-right">${_fmt(summaryCheck.invTotalNds)}</td>
            <td class="text-right">${_fmt(Math.abs((summaryCheck.updNds||0)-(summaryCheck.invTotalNds||0)))}</td>
          </tr>
        </tbody>
      </table>
    </div>` : '';

  // Статистика по неструктурированным
  const us = _crossCheck.info.unstructuredSummary;
  const unstrStats = us ? [
    us.claims       > 0 ? `${us.claims} претензий` : '',
    us.declarations > 0 ? `${us.declarations} декл.` : '',
    us.certificates > 0 ? `${us.certificates} серт.` : '',
    us.warranties   > 0 ? `${us.warranties} гарант.` : '',
    us.memos        > 0 ? `${us.memos} сл.зап.` : '',
    us.passports    > 0 ? `${us.passports} паспорт.` : '',
    us.letters      > 0 ? `${us.letters} писем` : '',
  ].filter(Boolean).join(', ') : '';

  section.innerHTML = `
    <div class="mb-4">
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <h3 class="text-xs font-bold text-slate-400 uppercase tracking-wide">Этап 2 — Программная сверка</h3>
        <div class="flex gap-2 ml-auto flex-wrap">
          ${critical.length    ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-red-500/20 text-red-400">${critical.length} крит.</span>` : ''}
          ${significant.length ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-amber-500/20 text-amber-400">${significant.length} сущ.</span>` : ''}
          ${formal.length      ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-slate-500/20 text-slate-400">${formal.length} форм.</span>` : ''}
          ${!issues.length     ? `<span class="text-[10px] px-2 py-0.5 rounded-full bg-green-500/20 text-green-400">✓ Расхождений нет</span>` : ''}
        </div>
      </div>
      ${unstrStats ? `<p class="text-[10px] text-slate-500 mb-2">Проверено неструктурированных: ${unstrStats}</p>` : ''}
      ${summaryHtml}
      ${renderIssues(critical,    'border-red-500/20 bg-red-500/[0.05]',    '🔴')}
      ${renderIssues(significant, 'border-amber-500/20 bg-amber-500/[0.05]','🟡')}
      ${renderIssues(formal,      'border-slate-500/20 bg-slate-500/[0.05]','🟠')}
    </div>`;
}

function _renderReport(md) {
  const section = document.getElementById('dcFinalReportSection');
  const wrap    = document.getElementById('dcReportWrap');
  const target  = section || wrap;
  if (!target) return;
  target.innerHTML = `
    <h3 class="text-xs font-bold text-slate-400 uppercase tracking-wide mb-3">Этап 3 — AI Заключение</h3>
    <div class="dc-report">${_mdToHtml(md)}</div>`;
}

function _clearReport() {
  const wrap = document.getElementById('dcReportWrap');
  if (wrap) wrap.innerHTML = `<p class="text-xs text-slate-500 text-center py-8">Загрузите документы и нажмите «Проверить»</p>`;
  document.getElementById('dcDownloadBtn')?.classList.add('hidden');
}

function _showError(msg) {
  const wrap = document.getElementById('dcReportWrap');
  if (!wrap) return;
  wrap.innerHTML = `
    <div class="rounded-xl border border-red-500/20 bg-red-500/[0.07] px-5 py-4">
      <p class="text-sm font-semibold text-red-400 mb-1">⚠ Ошибка анализа</p>
      <p class="text-xs text-red-300">${msg}</p>
      ${msg.includes('sign')||msg.includes('auth')||msg.includes('credit')
        ? '<p class="text-xs text-slate-400 mt-2">Возможно, требуется войти в аккаунт miniapps.ai или пополнить баланс.</p>' : ''}
    </div>`;
}

function _mdToHtml(md) {
  return md
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/^### (.+)$/gm,'<h3 class="text-sm font-bold text-cyan-300 mt-5 mb-2 uppercase tracking-wide">$1</h3>')
    .replace(/^## (.+)$/gm,'<h2 class="text-base font-bold text-white mt-6 mb-3 border-b border-white/10 pb-2">$1</h2>')
    .replace(/^# (.+)$/gm,'<h1 class="text-lg font-bold text-cyan-400 mb-4">$1</h1>')
    .replace(/\*\*([^*]+)\*\*/g,'<strong class="text-white font-semibold">$1</strong>')
    .replace(/^(\|.+\|)$/gm, line => {
      const cells = line.split('|').slice(1,-1).map(c=>c.trim());
      if (cells.every(c=>/^[-: ]+$/.test(c))) return '';
      return '<tr>' + cells.map(c=>`<td class="px-3 py-1.5 text-xs border-b border-white/10 text-slate-200">${c}</td>`).join('') + '</tr>';
    })
    .replace(/((<tr>.*?<\/tr>\n?)+)/gs,'<div class="overflow-x-auto my-3"><table class="w-full border-collapse"><tbody>$1</tbody></table></div>')
    .replace(/✅/g,'<span class="text-green-400">✅</span>')
    .replace(/❌/g,'<span class="text-red-400">❌</span>')
    .replace(/⚠/g,'<span class="text-amber-400">⚠</span>')
    .replace(/🔴/g,'<span class="text-red-400">🔴</span>')
    .replace(/🟡/g,'<span class="text-amber-400">🟡</span>')
    .replace(/🟠/g,'<span class="text-orange-400">🟠</span>')
    .replace(/🟢/g,'<span class="text-green-400">🟢</span>')
    .replace(/^- (.+)$/gm,'<li class="ml-4 text-sm text-slate-300 mb-1">• $1</li>')
    .replace(/^\d+\. (.+)$/gm,'<li class="ml-4 text-sm text-slate-300 mb-1">$1</li>')
    .replace(/\n\n/g,'</p><p class="text-sm text-slate-300 mb-2">')
    .replace(/\n/g,'<br>');
}

function _docTypeLabel(t) {
  const map = {
    договор:'Договор', упд:'УПД', счет:'Счёт', накладная:'Накладная',
    акт_приемки:'Акт приёмки', акт_ввода:'Акт ввода', реестр_накладных:'Реестр',
    акт_проверки:'Акт проверки', авансовый_счет:'Аванс-счёт',
    акт_переименования:'Акт переим.', претензия:'Претензия',
    декларация_соответствия:'Декларация соотв.', сертификат_соответствия:'Сертификат',
    гарантийный_талон:'Гарантийный талон', служебная_записка:'Служ. записка',
    паспорт_изделия:'Паспорт изделия', протокол_испытаний:'Протокол испыт.',
    заключение_эксперта:'Заключение', доверенность:'Доверенность',
    письмо:'Письмо', иной_документ:'Иной документ', неизвестно:'Неизвестно'
  };
  return map[t] || t || 'Неизвестно';
}

function _docTypeIcon(t) {
  const map = {
    договор:'📋', упд:'🧾', счет:'💳', накладная:'📦',
    акт_приемки:'✅', акт_ввода:'🔧', реестр_накладных:'📑',
    акт_проверки:'🔍', авансовый_счет:'💰', акт_переименования:'✏️', претензия:'⚠️',
    декларация_соответствия:'🏷', сертификат_соответствия:'🏆',
    гарантийный_талон:'🛡', служебная_записка:'📝',
    паспорт_изделия:'📗', протокол_испытаний:'🔬',
    заключение_эксперта:'🎓', доверенность:'📜',
    письмо:'✉️', иной_документ:'📎', неизвестно:'📎'
  };
  return map[t] || '📎';
}

// ═══════════════════════════════════════════════════════════════════
// СПИСОК ФАЙЛОВ
// ═══════════════════════════════════════════════════════════════════

function _renderFileList() {
  const wrap       = document.getElementById('dcFileList');
  const badge      = document.getElementById('dcFileCount');
  const analyseBtn = document.getElementById('dcAnalyseBtn');
  const clearBtn   = document.getElementById('dcClearBtn');

  if (badge) {
    const n = _files.length;
    badge.textContent = n > 0 ? `${n} файл${n===1?'':n<5?'а':'ов'}` : '';
    badge.classList.toggle('hidden', n === 0);
  }
  if (analyseBtn) analyseBtn.disabled = _files.length === 0 || _analysing;
  if (clearBtn)   clearBtn.classList.toggle('hidden', _files.length === 0);

  if (!wrap) return;
  if (_files.length === 0) {
    wrap.innerHTML = `<p class="text-xs text-slate-500 text-center py-4">Файлы не загружены</p>`;
    return;
  }

  wrap.innerHTML = _files.map((f,i) => {
    const scanBadge = f.scanPages > 0
      ? `<span class="inline-flex items-center gap-1 rounded-md bg-amber-400/10 border border-amber-400/20 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">🔍 OCR ${f.scanPages}/${f.totalPages} стр.</span>`
      : (f.totalPages > 0 ? `<span class="inline-flex items-center gap-1 rounded-md bg-green-400/10 border border-green-400/20 px-1.5 py-0.5 text-[9px] font-semibold text-green-300">✓ текст ${f.totalPages} стр.</span>` : '');
    return `
    <div class="flex items-center gap-3 rounded-xl border border-white/10 bg-white/[0.03] px-3 py-2.5">
      <span class="text-base shrink-0">${_fileIcon(f.name)}</span>
      <div class="flex-1 min-w-0">
        <p class="text-xs font-medium text-white truncate">${f.name}</p>
        <div class="flex items-center gap-1.5 mt-0.5 flex-wrap">
          <span class="text-[10px] text-slate-500">${_formatSize(f.size)} · ${(f.text?.length||0).toLocaleString('ru')} симв.</span>
          ${scanBadge}
        </div>
      </div>
      <button type="button" data-idx="${i}"
        class="dc-remove-btn shrink-0 rounded-lg p-1 text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition"
        aria-label="Удалить файл">✕</button>
    </div>`;
  }).join('');

  wrap.querySelectorAll('.dc-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      _files.splice(parseInt(btn.dataset.idx), 1);
      _renderFileList();
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// СКАЧАТЬ ОТЧЁТ (.docx)
// ═══════════════════════════════════════════════════════════════════

async function _downloadReport() {
  if (!_reportMd) return;
  const btn = document.getElementById('dcDownloadBtn');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Формирую…'; }
  try {
    const dateStr = new Date().toISOString().slice(0,10);
    await _downloadAsDocx(_reportMd, `zakluchenie-proverki-${dateStr}`);
  } catch {
    const blob = new Blob([_reportMd], { type:'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `zakluchenie-${new Date().toISOString().slice(0,10)}.txt`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 3000);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '📥 Скачать отчёт (.docx)'; }
  }
}

async function _downloadAsDocx(md, filename) {
  if (typeof JSZip === 'undefined') await _loadJsZip();
  const zip = new JSZip();
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>`);
  zip.file('word/document.xml', _buildDocXml(md));
  const ab   = await zip.generateAsync({ type:'arraybuffer' });
  const blob = new Blob([ab], { type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href = url; a.download = `${filename}.docx`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function _buildDocXml(md) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  const paras = md.split('\n').map(line => {
    if (line.startsWith('# '))   return `<w:p><w:r><w:rPr><w:b/><w:sz w:val="32"/><w:color w:val="1E40AF"/></w:rPr><w:t xml:space="preserve">${esc(line.slice(2))}</w:t></w:r></w:p>`;
    if (line.startsWith('## '))  return `<w:p><w:r><w:rPr><w:b/><w:sz w:val="26"/></w:rPr><w:t xml:space="preserve">${esc(line.slice(3))}</w:t></w:r></w:p>`;
    if (line.startsWith('### ')) return `<w:p><w:r><w:rPr><w:b/><w:sz w:val="22"/><w:color w:val="0E7490"/></w:rPr><w:t xml:space="preserve">${esc(line.slice(4))}</w:t></w:r></w:p>`;
    if (/^\|[-: |]+\|$/.test(line)) return '';
    if (line.startsWith('| '))   return `<w:p><w:r><w:rPr><w:rFonts w:ascii="Courier New"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`;
    if (line.startsWith('- '))   return `<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">• ${esc(line.slice(2))}</w:t></w:r></w:p>`;
    if (line.trim() === '')      return `<w:p/>`;
    const parts = line.split(/(\*\*[^*]+\*\*)/g);
    const runs  = parts.map(p => p.startsWith('**')&&p.endsWith('**')
      ? `<w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">${esc(p.slice(2,-2))}</w:t></w:r>`
      : p ? `<w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r>` : '').join('');
    return `<w:p><w:pPr><w:spacing w:after="80"/></w:pPr>${runs}</w:p>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1134" w:right="850" w:bottom="1134" w:left="1701"/></w:sectPr></w:body></w:document>`;
}

async function _loadJsZip() {
  return new Promise((resolve, reject) => {
    if (typeof JSZip !== 'undefined') { resolve(); return; }
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = resolve;
    s.onerror = () => {
      const s2 = document.createElement('script');
      s2.src = 'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js';
      s2.onload = resolve; s2.onerror = reject;
      document.head.appendChild(s2);
    };
    document.head.appendChild(s);
  });
}

// ── Утилиты ────────────────────────────────────────────────────────
function _fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  if (ext === 'pdf') return '📄';
  if (['xlsx','xls'].includes(ext)) return '📊';
  if (['docx','doc'].includes(ext)) return '📝';
  return '📃';
}
function _formatSize(b) {
  if (b < 1024) return b + ' Б';
  if (b < 1048576) return (b/1024).toFixed(0) + ' КБ';
  return (b/1048576).toFixed(1) + ' МБ';
}
function _setStatus(msg, type) {
  const el = document.getElementById('dcStatus');
  if (!el) return;
  if (!msg) { el.textContent = ''; el.className = 'text-xs min-h-[1rem]'; return; }
  const c = { info:'text-slate-400', success:'text-green-400', error:'text-red-400' };
  el.textContent = msg;
  el.className = `text-xs min-h-[1rem] ${c[type] || 'text-slate-400'}`;
}
