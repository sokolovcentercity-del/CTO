/**
 * Dynamic library loader with CDN fallback chain.
 * Loads xlsx, jszip, pdf.js.
 * На сервере (после распаковки архива) сначала пробует локальные libs/.
 * В preview/miniapps.ai — только CDN.
 *
 * Approved CDN origins: cdn.tailwindcss.com, cdn.jsdelivr.net, unpkg.com,
 * cdnjs.cloudflare.com, www.gstatic.com, miniapps.ai
 */

const THIS_URL = import.meta.url;
const ROOT_DIR = THIS_URL.replace(/ui\/[^/]+$/, '');

const CDN_XLSX_URLS = [
  'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://unpkg.com/xlsx@0.18.5/dist/xlsx.full.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];

const CDN_JSZIP_URLS = [
  'https://cdn.jsdelivr.net/npm/jszip@3.10.1/dist/jszip.min.js',
  'https://unpkg.com/jszip@3.10.1/dist/jszip.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
];

// PDF.js — используем cdnjs (входит в approved origins)
const CDN_PDFJS_URLS = [
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
];

/**
 * Check if a local file exists via HEAD request.
 * Returns true only if status 200 and not a miniapps.ai platform URL.
 * Silently returns false on any error (CORS, 404, sandbox block, etc.)
 */
async function localFileExists(path) {
  // В miniapps.ai preview локальные libs/ не существуют — не пробуем
  if (ROOT_DIR.includes('miniapps.ai') || ROOT_DIR.includes('localhost')) return false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(ROOT_DIR + path, { method: 'HEAD', signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Load a script from a list of URLs, trying each in order.
 * Returns the window global once loaded.
 */
async function loadScriptWithFallback(urls, globalName) {
  if (window[globalName]) return window[globalName];

  for (const url of urls) {
    try {
      await new Promise((resolve, reject) => {
        const existing = document.querySelector(`script[src="${url}"]`);
        if (existing) {
          if (window[globalName]) { resolve(); return; }
          existing.addEventListener('load', resolve);
          existing.addEventListener('error', reject);
          return;
        }
        const script = document.createElement('script');
        script.src = url;
        script.onload = resolve;
        script.onerror = reject;
        document.head.appendChild(script);
      });
      if (window[globalName]) {
        const label = url.startsWith(ROOT_DIR) ? 'локальный' : new URL(url).hostname;
        console.log(`[lib-loader] ${globalName} загружен (${label})`);
        return window[globalName];
      }
    } catch {
      // Тихо пробуем следующий URL — не засоряем консоль
    }
  }
  throw new Error(`Не удалось загрузить ${globalName} ни из одного источника`);
}

/** Load SheetJS (XLSX) */
export async function loadXLSX() {
  const urls = [...CDN_XLSX_URLS];
  // Если локальный файл доступен (на сервере после распаковки архива) — ставим первым
  if (await localFileExists('libs/xlsx.full.min.js')) {
    urls.unshift(ROOT_DIR + 'libs/xlsx.full.min.js');
  }
  return loadScriptWithFallback(urls, 'XLSX');
}

/** Load JSZip */
export async function loadJSZip() {
  const urls = [...CDN_JSZIP_URLS];
  // Если локальный файл доступен (на сервере после распаковки архива) — ставим первым
  if (await localFileExists('libs/jszip.min.js')) {
    urls.unshift(ROOT_DIR + 'libs/jszip.min.js');
  }
  return loadScriptWithFallback(urls, 'JSZip');
}

/**
 * Load PDF.js (pdfjs-dist).
 * После загрузки устанавливает workerSrc для off-thread рендеринга.
 * Возвращает window.pdfjsLib.
 */
export async function loadPDFJS() {
  const configurePdfWorker = (lib) => {
    if (!lib) return lib;
    if (lib.GlobalWorkerOptions) {
      lib.GlobalWorkerOptions.workerSrc = new URL('ui/pdf-worker.js', ROOT_DIR).href;
    }
    if (typeof lib.setVerbosityLevel === 'function') {
      lib.setVerbosityLevel(0);
    }
    return lib;
  };

  if (window.pdfjsLib) return configurePdfWorker(window.pdfjsLib);

  const urls = [...CDN_PDFJS_URLS];
  if (await localFileExists('libs/pdf.min.js')) {
    urls.unshift(ROOT_DIR + 'libs/pdf.min.js');
  }
  if (!ROOT_DIR.includes('miniapps.ai') && !ROOT_DIR.includes('localhost')) {
    urls.unshift(new URL('doc-checker/libs/pdf.min.js', ROOT_DIR).href);
  }

  const lib = await loadScriptWithFallback(urls, 'pdfjsLib');

  // PDF.js создаёт blob:-обёртку, если workerSrc указывает на CDN.
  // Same-origin bridge позволяет загрузить worker обычным URL и обойти CSP
  // предпросмотра, где worker-src blob запрещён.
  return configurePdfWorker(lib);
}
