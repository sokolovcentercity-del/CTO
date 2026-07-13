/**
 * Excel import panel.
 * Handles file selection, parsing with SheetJS, preview, and import.
 */

import { $, el, clearChildren, qs } from './dom.js';
import { addProducts, state } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadXLSX } from './lib-loader.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

let parsedProducts = [];
let onSaveCallback = null;

/** Column name mapping (Russian + English).
 * Категория и товарная группа намеренно ИСКЛЮЧЕНЫ — устанавливаются пользователем вручную.
 */
const COLUMN_MAP = {
  'номер': 'number', '№': 'number', 'number': 'number', 'id': 'number', 'no': 'number',
  'наименование': 'name', 'название': 'name', 'товар': 'name', 'name': 'name', 'product': 'name', 'title': 'name',
  'цвет': 'color', 'color': 'color', 'colour': 'color',
  'характеристики': 'specs', 'описание': 'specs', 'свойства': 'specs',
  'description': 'specs', 'specs': 'specs', 'specifications': 'specs', 'features': 'specs',
};

/** Map a header string to a field name */
function mapHeader(header) {
  const normalized = String(header).toLowerCase().trim();
  return COLUMN_MAP[normalized] || null;
}

/** Parse Excel data rows into product objects */
function parseRows(headers, rows) {
  // Try to map headers
  const fieldMap = {};
  headers.forEach((h, i) => {
    const field = mapHeader(h);
    if (field) fieldMap[i] = field;
  });

  // If we couldn't detect any columns, try positional mapping
  const mappedFields = Object.values(fieldMap);
  const usePositional = !mappedFields.includes('name') && headers.length >= 2;

  return rows
    .filter(row => row.some(cell => cell != null && String(cell).trim() !== ''))
    .map((row, idx) => {
      const product = { number: 0, name: '', category: '', color: '', specs: [] };

      if (usePositional) {
        // Positional fallback: №, Name, Color, Characteristics
        // Категория и товарная группа намеренно пропущены — устанавливает пользователь
        product.number = parseInt(row[0], 10) || idx + 1;
        product.name = String(row[1] || '').trim();
        product.color = String(row[2] || '').trim();
        const rawSpecs = String(row[3] || '').trim();
        product.specs = rawSpecs ? rawSpecs.split('\n').map(s => s.trim()).filter(Boolean) : [];
      } else {
        Object.entries(fieldMap).forEach(([colIdx, field]) => {
          const val = String(row[parseInt(colIdx)] || '').trim();
          if (field === 'number') {
            product.number = parseInt(val, 10) || idx + 1;
          } else if (field === 'specs') {
            product.specs = val ? val.split('\n').map(s => s.trim()).filter(Boolean) : [];
          } else if (field === 'category' || field === 'productGroup') {
            // Игнорируем — категорию и товарную группу устанавливает пользователь вручную
          } else {
            product[field] = val;
          }
        });
        if (!product.number) product.number = idx + 1;
      }
      // Гарантируем что category и productGroup всегда пустые после импорта
      product.category = '';
      product.productGroup = '';

      return product;
    })
    .filter(p => p.name); // Only keep products with a name
}

/** Render preview table */
function renderPreview(products) {
  const container = $('importPreview');
  if (!container) return;
  clearChildren(container);

  if (products.length === 0) {
    container.appendChild(
      el('p', { className: 'text-sm text-slate-500 py-4 text-center' }, t('import.noData')),
    );
    return;
  }

  // Counter
  const counter = el(
    'p',
    { className: 'text-sm text-slate-400 mb-3' },
    `${t('import.preview')}: ${products.length} ${products.length === 1 ? 'товар' : 'товаров'}`,
  );
  container.appendChild(counter);

  // Table wrapper
  const wrapper = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });

  const table = el('table', { className: 'w-full text-sm' });

  // Header
  const thead = el('thead', { className: 'bg-white/5' });
  const headerRow = el('tr', {});
  [t('card.number'), t('form.name'), t('form.category'), t('form.color'), t('form.characteristics')].forEach(text => {
    headerRow.appendChild(el('th', { className: 'px-3 py-2 text-left text-xs font-semibold text-slate-400 uppercase tracking-wider' }, text));
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  // Body
  const tbody = el('tbody', { className: 'divide-y divide-white/5' });
  products.slice(0, 50).forEach(p => {
    const row = el('tr', { className: 'hover:bg-white/5' });
    row.appendChild(el('td', { className: 'px-3 py-2 text-slate-300 whitespace-nowrap' }, String(p.number)));
    row.appendChild(el('td', { className: 'px-3 py-2 text-white font-medium' }, p.name));
    row.appendChild(el('td', { className: 'px-3 py-2 text-slate-400' }, p.category || '—'));
    row.appendChild(el('td', { className: 'px-3 py-2 text-slate-400' }, p.color || '—'));
    const specsArr = Array.isArray(p.specs) ? p.specs.filter(Boolean) : [];
    const specsCell = el('td', { className: 'px-3 py-2 text-slate-500 max-w-[200px]' });
    specsCell.textContent = specsArr.length ? specsArr.slice(0, 2).join('; ') + (specsArr.length > 2 ? '…' : '') : '—';
    row.appendChild(specsCell);
    tbody.appendChild(row);
  });
  table.appendChild(tbody);

  if (products.length > 50) {
    const moreRow = el('tr', {},
      el('td', {
        className: 'px-3 py-2 text-center text-xs text-slate-500',
        colspan: '5',
      }, `… и ещё ${products.length - 50} шт.`),
    );
    tbody.appendChild(moreRow);
  }

  wrapper.appendChild(table);
  container.appendChild(wrapper);

  // Show import button
  const importBtn = $('importConfirmBtn');
  if (importBtn) {
    importBtn.textContent = t('import.importBtn', { count: products.length });
    importBtn.classList.remove('hidden');
  }
}

/** Handle file selection */
async function handleFile(file) {
  try {
    const XLSX = await loadXLSX();
    const data = await file.arrayBuffer();
    const workbook = XLSX.read(data, { type: 'array' });

    const firstSheet = workbook.Sheets[workbook.SheetNames[0]];
    const jsonData = XLSX.utils.sheet_to_json(firstSheet, { header: 1 });

    if (jsonData.length < 2) {
      showToast(t('import.noData'), 'warning');
      return;
    }

    const headers = jsonData[0].map(h => String(h || ''));
    const rows = jsonData.slice(1);
    parsedProducts = parseRows(headers, rows);

    renderPreview(parsedProducts);
  } catch (err) {
    console.error('Excel parse error:', err);
    showToast(t('import.error'), 'error');
  }
}

/** Confirm import */
async function handleImportConfirm() {
  if (parsedProducts.length === 0) return;

  const count = addProducts(parsedProducts);
  await saveToStorage();

  showToast(t('toast.imported', { count }), 'success');
  closeImportModal();

  if (onSaveCallback) onSaveCallback();
  parsedProducts = [];
}

/** Open import modal */
export function openImportModal(onSave = null) {
  onSaveCallback = onSave;
  parsedProducts = [];

  const overlay = $('importModal');
  if (!overlay) return;

  // Reset state
  const preview = $('importPreview');
  if (preview) clearChildren(preview);

  const importBtn = $('importConfirmBtn');
  if (importBtn) importBtn.classList.add('hidden');

  const fileInput = $('importFileInput');
  if (fileInput) fileInput.value = '';

  overlay.classList.add('open');
}

/** Close import modal */
export function closeImportModal() {
  const overlay = $('importModal');
  if (overlay) overlay.classList.remove('open');
}

/** Generate and download an Excel template */
async function downloadTemplate() {
  try {
    const XLSX = await loadXLSX();
    const ws = XLSX.utils.aoa_to_sheet([
      ['№', 'Наименование', 'Цвет', 'Характеристики'],
      ['1', 'Пример товара', 'Чёрный', 'Память 128 ГБ, экран 6.1"'],
      // Категория и товарная группа не включены — устанавливаются пользователем вручную в карточке товара
    ]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Товары');
    XLSX.writeFile(wb, 'catalog_template.xlsx');
  } catch (err) {
    console.error('Template download error:', err);
    showToast(t('toast.error'), 'error');
  }
}

/** Initialize import panel event listeners */
export function initImportPanel() {
  const overlay = $('importModal');
  if (!overlay) return;

  // Close on backdrop
  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeImportModal();
  });

  // Close on Escape
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closeImportModal();
    }
  });

  // Cancel button
  const cancelBtn = $('importCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeImportModal);

  // Import button
  const importBtn = $('importConfirmBtn');
  if (importBtn) importBtn.addEventListener('click', handleImportConfirm);

  // File input
  const fileInput = $('importFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (file) handleFile(file);
    });
  }

  // Drop zone
  const dropZone = $('dropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('drag-over');
    });
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer?.files?.[0];
      if (file && (file.name.endsWith('.xlsx') || file.name.endsWith('.xls'))) {
        handleFile(file);
      } else {
        showToast(t('import.error'), 'error');
      }
    });
  }

  // Template download
  const templateBtn = $('downloadTemplateBtn');
  if (templateBtn) templateBtn.addEventListener('click', downloadTemplate);
}
