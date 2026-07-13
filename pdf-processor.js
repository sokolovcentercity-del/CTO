/**
 * pdf-processor.js
 * Конвертирует файлы для отправки в AI.
 * - Для Claude: base64 (нативное чтение PDF/DOCX)
 * - Для Яндекс: извлечение текста через PDF.js (поддерживает кириллицу)
 */

const PDFJS_CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
const PDFJS_WORKER = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

let _pdfjsLoaded = false;

/**
 * Загружает PDF.js если ещё не загружен.
 */
async function loadPDFJS() {
  if (_pdfjsLoaded && window.pdfjsLib) return window.pdfjsLib;
  if (window.pdfjsLib) { _pdfjsLoaded = true; return window.pdfjsLib; }

  await loadScript(PDFJS_CDN);
  if (window.pdfjsLib) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
    _pdfjsLoaded = true;
    return window.pdfjsLib;
  }
  throw new Error('PDF.js не загружен');
}

/**
 * Извлекает текст из PDF через PDF.js (поддерживает кириллицу).
 * @param {File} file
 * @returns {Promise<string>}
 */
export async function extractPdfText(file) {
  const pages = await extractPdfPages(file);
  return pages.map((p, i) => p.text ? ('--- Страница ' + (i + 1) + ' ---\n' + p.text) : '').filter(Boolean).join('\n\n');
}

/**
 * Постраничное извлечение PDF: текст + canvasData для сканов.
 * Возвращает массив { text, canvasData } для каждой страницы.
 * canvasData = { render(canvas): Promise } если страница — скан.
 * @param {File} file
 * @returns {Promise<Array<{text: string, canvasData: object|null}>>}
 */
export async function extractPdfPages(file) {
  const pdfjsLib = await loadPDFJS();
  const arrayBuffer = await file.arrayBuffer();
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
  const pdf = await loadingTask.promise;

  const result = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);

    // Извлекаем текст
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map(item => item.str)
      .join(' ')
      .replace(/\s{3,}/g, '  ')
      .trim();

    const hasText = pageText.replace(/\s/g, '').length > 30;

    let canvasData = null;
    if (!hasText) {
      // Страница-скан: сохраняем функцию рендера
      const viewport = page.getViewport({ scale: 2.0 });
      canvasData = {
        width:  viewport.width,
        height: viewport.height,
        render: async (canvas) => {
          canvas.width  = viewport.width;
          canvas.height = viewport.height;
          const ctx = canvas.getContext('2d');
          await page.render({ canvasContext: ctx, viewport }).promise;
        },
      };
    }

    result.push({ text: pageText, canvasData });
  }
  return result;
}

/**
 * Конвертирует File в base64-строку (для Claude).
 * @param {File} file
 * @returns {Promise<{base64: string, mediaType: string}>}
 */
export async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = reader.result;
      const base64 = dataUrl.split(',')[1];
      resolve({ base64, mediaType: file.type || guessMimeType(file.name) });
    };
    reader.onerror = () => reject(new Error('Ошибка чтения файла: ' + file.name));
    reader.readAsDataURL(file);
  });
}

/**
 * Определяет MIME-тип по расширению файла.
 */
function guessMimeType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const types = {
    pdf:  'application/pdf',
    docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    doc:  'application/msword',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    xls:  'application/vnd.ms-excel',
    txt:  'text/plain',
    csv:  'text/csv',
    md:   'text/markdown',
    png:  'image/png',
    jpg:  'image/jpeg',
    jpeg: 'image/jpeg',
  };
  return types[ext] || 'application/octet-stream';
}

/**
 * Определяет тип файла по расширению.
 */
export function getFileType(filename) {
  const ext = filename.toLowerCase().split('.').pop();
  const types = {
    pdf: 'pdf',
    docx: 'docx', doc: 'docx',
    xlsx: 'xlsx', xls: 'xlsx',
    txt: 'txt', md: 'txt', csv: 'txt',
    png: 'image', jpg: 'image', jpeg: 'image',
  };
  return types[ext] || 'unknown';
}

/**
 * Форматирует размер файла.
 */
export function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' Б';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' КБ';
  return (bytes / 1024 / 1024).toFixed(1) + ' МБ';
}

/**
 * Читает Excel через SheetJS как текст (CSV по листам).
 */
export async function extractExcelAsText(file) {
  if (!window.XLSX) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js')
      .catch(() => loadScript('https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'))
      .catch(() => loadScript('https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js'));
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

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src; s.onload = resolve; s.onerror = reject;
    document.head.appendChild(s);
  });
}
