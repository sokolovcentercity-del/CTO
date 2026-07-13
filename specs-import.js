/**
 * Specs Import Modal
 * Импорт характеристик товара из Excel (.xlsx), Word (.docx) или PDF.
 * Парсинг выполняется локально — без обращений к AI/сети.
 */

import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

let _onImportCallback = null;
let _parsedSpecs = [];

// ─── Modal helpers ────────────────────────────────────────────────

function getOverlay() { return document.getElementById('specsImportModal'); }

export function openSpecsImportModal(onImport) {
  _onImportCallback = onImport;
  _parsedSpecs = [];
  resetUI();
  getOverlay()?.classList.add('open');
}

function closeSpecsImportModal() {
  getOverlay()?.classList.remove('open');
}

function resetUI() {
  const preview = document.getElementById('specsImportPreview');
  if (preview) preview.innerHTML = '';
  const confirmBtn = document.getElementById('specsImportConfirmBtn');
  if (confirmBtn) confirmBtn.classList.add('hidden');
  const fileInput = document.getElementById('specsImportFileInput');
  if (fileInput) fileInput.value = '';
  setStatus('');
}

function setStatus(msg, isError = false) {
  const el = document.getElementById('specsImportStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = isError
    ? 'text-xs text-red-400 mt-2 min-h-[1.25rem]'
    : 'text-xs text-slate-400 mt-2 min-h-[1.25rem]';
}

function setLoading(loading) {
  const spinner = document.getElementById('specsImportSpinner');
  const btn = document.getElementById('specsImportConfirmBtn');
  if (spinner) spinner.classList.toggle('hidden', !loading);
  if (btn) btn.disabled = loading;
}

// ─── Library loaders ──────────────────────────────────────────────

async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => reject(new Error('XLSX load failed'));
    document.head.appendChild(s);
  });
}

async function loadMammoth() {
  if (window.mammoth) return window.mammoth;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/mammoth/1.6.0/mammoth.browser.min.js';
    s.onload = () => resolve(window.mammoth);
    s.onerror = () => reject(new Error('Mammoth load failed'));
    document.head.appendChild(s);
  });
}

async function loadPDFJS() {
  if (window.pdfjsLib) return window.pdfjsLib;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc =
        'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve(window.pdfjsLib);
    };
    s.onerror = () => reject(new Error('PDF.js load failed'));
    document.head.appendChild(s);
  });
}

// ─── Text extraction ──────────────────────────────────────────────

async function extractFromExcel(file) {
  const XLSX = await loadXLSX();
  const data = await file.arrayBuffer();
  const wb = XLSX.read(data, { type: 'array' });
  const lines = [];
  wb.SheetNames.forEach(name => {
    const sheet = wb.Sheets[name];
    const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
    rows.forEach(row => {
      const cells = row.map(c => String(c ?? '').trim()).filter(Boolean);
      if (cells.length) lines.push(cells.join(' | '));
    });
  });
  return lines.join('\n');
}

async function extractFromWord(file) {
  const mammoth = await loadMammoth();
  const data = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return result.value || '';
}

async function extractFromPDF(file) {
  const pdfjsLib = await loadPDFJS();
  const data = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data }).promise;
  const pages = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map(item => item.str).join(' '));
  }
  return pages.join('\n');
}

async function extractText(file) {
  const name = file.name.toLowerCase();
  if (name.endsWith('.xlsx') || name.endsWith('.xls')) return extractFromExcel(file);
  if (name.endsWith('.docx') || name.endsWith('.doc')) return extractFromWord(file);
  if (name.endsWith('.pdf')) return extractFromPDF(file);
  throw new Error(t('specsImport.unsupportedFormat'));
}

// ─── Local parsing (без AI) ───────────────────────────────────────

/**
 * Парсит текст характеристик локально, без AI.
 * Поддерживает форматы:
 *   Параметр | Ед.изм. | Значение
 *   Параметр: Значение ед.изм.
 *   Параметр — Значение
 *   Параметр <TAB> Значение
 */
function parseSpecsLocally(rawText) {
  const specs = [];
  const lines = rawText.split('\n');

  // Единицы измерения для автоопределения
  const UNITS = ['мм','см','м','км','кг','г','т','л','мл','вт','квт','в','а','гц','мгц','ггц',
    'мп','гб','мб','тб','шт','pc','mm','cm','kg','g','hz','w','v','a','gb','mb'];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.length < 2) continue;
    // Пропускаем строки-заголовки (все заглавные, короткие, без цифр)
    if (trimmed === trimmed.toUpperCase() && trimmed.length < 30 && !/\d/.test(trimmed)) continue;

    let param = '', unit = '', value = '';

    // Формат с трубой: Параметр | Ед. | Значение
    if (trimmed.includes('|')) {
      const parts = trimmed.split('|').map(p => p.trim());
      if (parts.length >= 3) {
        param = parts[0]; unit = parts[1]; value = parts[2];
      } else if (parts.length === 2) {
        param = parts[0]; value = parts[1];
      }
    }
    // Формат с табуляцией
    else if (trimmed.includes('\t')) {
      const parts = trimmed.split('\t').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) { param = parts[0]; value = parts.slice(1).join(' '); }
    }
    // Формат с двоеточием: Параметр: Значение
    else if (trimmed.includes(':')) {
      const ci = trimmed.indexOf(':');
      param = trimmed.slice(0, ci).trim();
      value = trimmed.slice(ci + 1).trim();
    }
    // Формат с тире/дефисом: Параметр — Значение
    else if (/\s[—–-]\s/.test(trimmed)) {
      const m = trimmed.match(/^(.+?)\s[—–-]\s(.+)$/);
      if (m) { param = m[1].trim(); value = m[2].trim(); }
    }
    // Просто строка — кладём в param
    else {
      param = trimmed;
    }

    if (!param) continue;
    // Убрать нумерацию в начале
    param = param.replace(/^[\d.)\-*•]+\s*/, '').trim();

    // Попытка извлечь единицу из значения: «120 мм» → value=«120», unit=«мм»
    if (!unit && value) {
      const m = value.match(/^([\d.,\s]+)\s*([а-яёa-z%°]+\.?)$/i);
      if (m) {
        const candidate = m[2].toLowerCase().replace(/\.$/, '');
        if (UNITS.includes(candidate)) { value = m[1].trim(); unit = m[2].trim(); }
      }
    }

    // Слишком длинные строки — не характеристики
    if (param.length > 100 || value.length > 200) continue;
    if (!param) continue;
    specs.push({ param, unit, value });
  }

  return specs;
}

// ─── Render preview ───────────────────────────────────────────────

function escHtml(str) {
  return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function renderPreview(specs) {
  const container = document.getElementById('specsImportPreview');
  if (!container) return;

  if (!specs.length) {
    container.innerHTML = `<p class="text-sm text-slate-500 py-3 text-center">${t('specsImport.noSpecs')}</p>`;
    return;
  }

  const headerCls = 'text-[10px] font-semibold uppercase tracking-wider text-slate-500';
  const cellCls = 'text-sm text-slate-200 truncate';

  container.innerHTML = `
    <p class="text-xs text-slate-400 mb-2">${t('specsImport.found')}: <span class="text-cyan-400 font-semibold">${specs.length}</span></p>
    <div class="rounded-xl border border-white/10 overflow-hidden">
      <div class="grid gap-0 bg-slate-800/60 px-3 py-2" style="grid-template-columns: 1fr 90px 1fr">
        <span class="${headerCls}">${t('form.specParam')}</span>
        <span class="${headerCls}">${t('form.specUnit')}</span>
        <span class="${headerCls}">${t('form.specValue')}</span>
      </div>
      <ul class="divide-y divide-white/5 max-h-52 overflow-y-auto" id="specsPreviewList">
        ${specs.map(s => `
          <li class="grid gap-2 px-3 py-2 hover:bg-white/[0.03]" style="grid-template-columns: 1fr 90px 1fr">
            <span class="${cellCls}">${escHtml(s.param)}</span>
            <span class="text-sm text-slate-400 truncate">${escHtml(s.unit)}</span>
            <span class="${cellCls}">${escHtml(s.value)}</span>
          </li>`).join('')}
      </ul>
    </div>`;

  const confirmBtn = document.getElementById('specsImportConfirmBtn');
  if (confirmBtn) {
    confirmBtn.textContent = t('specsImport.importBtn', { count: specs.length });
    confirmBtn.classList.remove('hidden');
  }
}

// ─── File handler ─────────────────────────────────────────────────

async function handleFile(file) {
  setStatus(t('specsImport.extracting'));
  setLoading(true);
  document.getElementById('specsImportConfirmBtn')?.classList.add('hidden');

  try {
    const rawText = await extractText(file);
    if (!rawText.trim()) {
      setStatus(t('specsImport.emptyFile'), true);
      setLoading(false);
      return;
    }

    setStatus(t('specsImport.parsing'));
    _parsedSpecs = parseSpecsLocally(rawText);

    setStatus(_parsedSpecs.length === 0 ? t('specsImport.noSpecs') : '', _parsedSpecs.length === 0);
    renderPreview(_parsedSpecs);
  } catch (err) {
    console.error('Specs import error:', err);
    setStatus(err.message || t('specsImport.error'), true);
  } finally {
    setLoading(false);
  }
}

// ─── Confirm import ───────────────────────────────────────────────

function handleConfirm() {
  if (!_parsedSpecs.length) return;
  _onImportCallback?.([..._parsedSpecs]);
  closeSpecsImportModal();
  showToast(t('specsImport.success', { count: _parsedSpecs.length }), 'success');
}

// ─── Init ─────────────────────────────────────────────────────────

export function initSpecsImport() {
  const overlay = document.getElementById('specsImportModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeSpecsImportModal();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeSpecsImportModal();
  });

  document.getElementById('specsImportCloseBtn')?.addEventListener('click', closeSpecsImportModal);
  document.getElementById('specsImportCancelBtn')?.addEventListener('click', closeSpecsImportModal);
  document.getElementById('specsImportConfirmBtn')?.addEventListener('click', handleConfirm);

  const fileInput = document.getElementById('specsImportFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    });
  }

  const dropZone = document.getElementById('specsDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file) handleFile(file);
    });
  }
}
