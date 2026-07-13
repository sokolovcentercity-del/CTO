/**
 * Product add/edit form modal.
 * Specs are structured as { param, unit, value }[] — three fields per row.
 * Category and productGroup are required fields.
 */

import { $, el, clearChildren, qs } from './dom.js';
import { addProduct, updateProduct, generateNumber, getCategories, addCategory, normalizeSpecs, getProductGroups, getProductSpecificationMappings, getProductColorVariants, hasProductColorVariants, state, getRecipientAddresses, getRecipientNeedMetrics } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { openSpecsImportModal } from './specs-import.js';
import { refreshProductGroupDatalist } from './product-groups.js';
import { openAiSpecsImport } from './ai-specs-import.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;
const tf = (key, fallback, vals) => {
  const value = t(key, vals);
  return value === key ? fallback : value;
};

let currentProduct = null;
let onSaveCallback = null;
let currentMode = 'edit';
let onCloseCallback = null;

/** Current specs list: { param, unit, value }[] */
let _specs = [];
let _colorVariants = [];

function normalizeColorCodeInput(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/–/g, '-')
    .replace(/—/g, '-');
}

function collectColorVariantsFromDOM() {
  const container = $('colorVariantsList');
  if (!container) return [..._colorVariants];
  return [...container.querySelectorAll('[data-color-variant-row]')]
    .map(row => {
      const input = row.querySelector('input[data-color-code]');
      const colorCode = normalizeColorCodeInput(input?.value || '');
      if (!colorCode) return null;
      return {
        id: colorCode.toLowerCase(),
        colorCode,
        active: true,
      };
    })
    .filter(Boolean);
}

function renderColorVariantsList() {
  const container = $('colorVariantsList');
  const wrap = $('colorVariantsWrap');
  const checkbox = $('fieldHasColorVariants');
  if (!container || !wrap || !checkbox) return;

  wrap.classList.toggle('hidden', !checkbox.checked);
  clearChildren(container);

  if (!checkbox.checked) return;
  if (_colorVariants.length === 0) {
    _colorVariants = [{ id: '', colorCode: '', active: true }];
  }

  _colorVariants.forEach((variant, idx) => {
    const row = el('div', {
      className: 'rounded-xl border border-white/10 bg-slate-950/40 p-3 space-y-2',
      'data-color-variant-row': String(idx),
    });

    const top = el('div', { className: 'flex items-center justify-between gap-3' });
    top.appendChild(el('span', {
      className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-400',
    }, `${tf('form.colorVariantLabel', 'Цвет')} ${idx + 1}`));

    const removeBtn = el('button', {
      type: 'button',
      className: `rounded-lg p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition ${isViewMode() ? 'hidden' : ''}`,
      'aria-label': t('actions.delete'),
    }, '✕');
    removeBtn.addEventListener('click', () => {
      _colorVariants = collectColorVariantsFromDOM();
      _colorVariants.splice(idx, 1);
      renderColorVariantsList();
    });
    top.appendChild(removeBtn);
    row.appendChild(top);

    const input = el('input', {
      type: 'text',
      value: variant.colorCode || '',
      'data-color-code': 'true',
      className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
      placeholder: tf('form.colorVariantPlaceholder', 'Например: 123-45-67'),
      'aria-label': tf('form.colorVariantPlaceholder', 'Код цвета'),
    });
    input.readOnly = isViewMode();
    row.appendChild(input);

    container.appendChild(row);
  });
}

function ensureSpecificationMappingsHost() {
  const specsSection = $('specsListWrap')?.closest('div');
  if (!specsSection?.parentElement) return null;

  let section = $('productSpecificationMappingsSection');
  if (!section) {
    section = document.createElement('div');
    section.id = 'productSpecificationMappingsSection';
    section.className = 'space-y-2';
    specsSection.parentElement.insertBefore(section, specsSection);
  }

  return section;
}

function renderProductSpecificationMappings(product) {
  const host = ensureSpecificationMappingsHost();
  if (!host) return;

  const mappings = product
    ? getProductSpecificationMappings(product.id, product.name)
    : [];

  const title = tf('form.specificationNamesTitle', 'Наименование по спецификации');
  const hint = tf('form.specificationNamesHint', 'Значения подтягиваются из контрактов и могут отличаться по лотам.');
  const empty = product
    ? tf('form.specificationNamesEmpty', 'Для этого товара ещё нет значений из контрактов.')
    : tf('form.specificationNamesNewHint', 'Сначала сохраните товар и привяжите его в контракте.');

  host.innerHTML = `
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${title}</label>
      <p class="mb-2 text-xs text-slate-500">${hint}</p>
      <div id="productSpecificationMappingsList"></div>
    </div>`;

  const list = $('productSpecificationMappingsList');
  if (!list) return;

  if (!mappings.length) {
    list.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-slate-500">${escapeHtml(empty)}</div>`;
    return;
  }

  list.innerHTML = mappings.map((row) => {
    const contractLabel = [row.contractNumber ? `№ ${row.contractNumber}` : '', row.contractTitle || '']
      .filter(Boolean)
      .join(' · ');
    const lotLabel = row.lotNumber
      ? `<span class="rounded-lg bg-violet-400/15 px-2 py-0.5 text-[10px] font-semibold text-violet-300">Лот ${escapeHtml(row.lotNumber)}</span>`
      : '';
    const codeLabel = row.code
      ? `<span class="rounded-lg bg-white/8 px-2 py-0.5 text-[10px] font-semibold text-slate-300">${escapeHtml(row.code)}</span>`
      : '';
    const priceLabel = row.price
      ? `<span class="text-xs text-emerald-400 tabular-nums">${Number(row.price).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ₽</span>`
      : '';

    return `
      <div class="rounded-xl border border-white/10 bg-white/[0.04] px-4 py-3">
        <div class="flex items-center gap-2 flex-wrap">
          <span class="text-xs font-semibold text-white">${escapeHtml(row.specificationName)}</span>
          ${lotLabel}
          ${codeLabel}
          ${priceLabel}
        </div>
        <p class="mt-1 text-[11px] text-slate-500">${escapeHtml(contractLabel || 'Контракт без номера')}</p>
      </div>`;
  }).join('');
}

function ensureNeedByAddressHost() {
  const specsSection = $('specsListWrap')?.closest('div');
  if (!specsSection?.parentElement) return null;

  let section = $('productNeedByAddressSection');
  if (!section) {
    section = document.createElement('div');
    section.id = 'productNeedByAddressSection';
    section.className = 'space-y-2';
    specsSection.parentElement.insertBefore(section, specsSection);
  }

  return section;
}

function collectProductNeedAddressOptions(product) {
  if (!product) return [];
  const options = [];
  (state.recipients || []).forEach((recipient) => {
    const addresses = getRecipientAddresses(recipient);
    if (addresses.length === 0) {
      const qty = getRecipientNeedMetrics(recipient, { productId: product.id }).qty;
      if (qty > 0) {
        options.push({
          value: `${recipient.id}::`,
          recipientName: recipient.name || '—',
          address: '',
          qty,
        });
      }
      return;
    }

    addresses.forEach((address) => {
      const qty = getRecipientNeedMetrics(recipient, { productId: product.id, address }).qty;
      if (qty <= 0) return;
      options.push({
        value: `${recipient.id}::${address}`,
        recipientName: recipient.name || '—',
        address,
        qty,
      });
    });
  });
  return options;
}

function renderProductNeedByAddress(product) {
  const host = ensureNeedByAddressHost();
  if (!host) return;
  if (!product || !isViewMode()) {
    host.remove();
    return;
  }

  const options = collectProductNeedAddressOptions(product);
  const title = tf('catalog.needByAddressTitle', 'Потребность по адресам');
  const hint = tf('catalog.needByAddressHint', 'Выберите получателя и адрес, чтобы увидеть потребность по этому товару.');
  const empty = tf('catalog.needByAddressEmpty', 'По этому товару адресная потребность не указана.');

  host.innerHTML = `
    <div>
      <label class="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400">${title}</label>
      <p class="mb-2 text-xs text-slate-500">${hint}</p>
      <div id="productNeedByAddressContent"></div>
    </div>`;

  const content = $('productNeedByAddressContent');
  if (!content) return;

  if (!options.length) {
    content.innerHTML = `<div class="rounded-xl border border-dashed border-white/10 bg-white/[0.03] px-4 py-3 text-xs text-slate-500">${escapeHtml(empty)}</div>`;
    return;
  }

  const selectWrap = el('div', { className: 'space-y-3' });
  const select = el('select', {
    className: 'w-full rounded-xl border border-white/10 bg-slate-900 px-4 py-2.5 text-sm text-white transition focus:border-cyan-400/50',
    'aria-label': tf('catalog.needByAddressSelect', 'Получатель и адрес'),
  });
  options.forEach((option) => {
    select.appendChild(el('option', { value: option.value }, `${option.recipientName}${option.address ? ` — ${option.address}` : ''}`));
  });
  selectWrap.appendChild(select);

  const info = el('div', { className: 'rounded-xl border border-cyan-400/20 bg-cyan-400/10 px-4 py-3' });
  selectWrap.appendChild(info);
  content.appendChild(selectWrap);

  const renderInfo = () => {
    const current = options.find(option => option.value === select.value) || options[0];
    if (!current) return;
    info.innerHTML = `
      <div class="text-sm font-semibold text-white">${escapeHtml(current.recipientName)}</div>
      <div class="mt-1 text-xs text-slate-300">${escapeHtml(current.address || 'Адрес не указан')}</div>
      <div class="mt-2 inline-flex items-center rounded-lg bg-cyan-400/20 px-2.5 py-1 text-sm font-bold text-cyan-200">${escapeHtml(tf('catalog.needByAddressQty', 'Потребность: {count} шт.', { count: current.qty }))}</div>`;
  };
  select.addEventListener('change', renderInfo);
  renderInfo();
}

function isViewMode() {
  return currentMode === 'view';
}

function setFormMode(viewMode) {
  const readonly = !!viewMode;
  const titleEl = qs('[data-form-title]', $('formModal'));
  if (titleEl) {
    titleEl.textContent = readonly
      ? t('catalog.viewTitle')
      : (currentProduct ? t('form.editTitle') : t('form.addTitle'));
  }

  const controlsToToggle = [
    'fieldName',
    'fieldProductGroup',
    'fieldCategory',
    'newCategoryInput',
    'fieldAssemblyRequired',
    'fieldAssemblyNotRequired',
    'fieldHasColorVariants',
  ];

  controlsToToggle.forEach(id => {
    const node = $(id);
    if (!node) return;
    if (node.tagName === 'SELECT' || node.type === 'radio' || node.type === 'checkbox') {
      node.disabled = readonly;
    } else {
      node.readOnly = readonly;
    }
  });

  ['addSpecBtn', 'importSpecsBtn', 'aiSpecsImportBtn', 'addCategoryInlineBtn', 'formSaveBtn', 'addColorVariantBtn'].forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.classList.toggle('hidden', readonly);
    btn.disabled = readonly;
  });

  renderColorVariantsList();

  const cancelBtn = $('formCancelBtn');
  if (cancelBtn) cancelBtn.textContent = readonly ? t('actions.close') : t('actions.cancel');
}

// ─── Category select ──────────────────────────────────────────────

function populateCategorySelect(selectedValue = '') {
  const sel = $('fieldCategory');
  if (!sel) return;
  clearChildren(sel);
  sel.appendChild(el('option', { value: '' }, t('form.selectCategory')));
  getCategories().forEach(cat => {
    sel.appendChild(el('option', { value: cat }, cat));
  });
  sel.appendChild(el('option', { value: '__add_new__' }, t('form.addCategory')));
  if (selectedValue) sel.value = selectedValue;
}

// ─── Specs list ───────────────────────────────────────────────────

/** Render the three-column specs list */
function renderSpecsList() {
  const container = $('specsListWrap');
  if (!container) return;
  clearChildren(container);

  if (_specs.length > 0) {
    const header = el('div', {
      className: 'grid gap-2 mb-1',
      style: 'grid-template-columns: 1fr 90px 1fr 32px',
    });
    header.appendChild(el('span', { className: 'text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1' }, t('form.specParam')));
    header.appendChild(el('span', { className: 'text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1' }, t('form.specUnit')));
    header.appendChild(el('span', { className: 'text-[10px] font-semibold uppercase tracking-wider text-slate-500 px-1' }, t('form.specValue')));
    header.appendChild(el('span', {}));
    container.appendChild(header);
  }

  _specs.forEach((spec, idx) => {
    const row = el('div', {
      className: 'grid gap-2 items-center',
      style: 'grid-template-columns: 1fr 90px 1fr 32px',
      'data-spec-row': String(idx),
    });

    const inputCls = 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50 focus:bg-white/[0.07]';

    const paramInput = el('input', {
      type: 'text',
      className: inputCls,
      placeholder: t('form.specParamPlaceholder'),
      value: spec.param,
      'aria-label': t('form.specParam'),
      'data-spec-field': 'param',
    });
    paramInput.readOnly = isViewMode();
    if (!isViewMode()) paramInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSpecRow(); } });

    const unitInput = el('input', {
      type: 'text',
      className: inputCls,
      placeholder: t('form.specUnitPlaceholder'),
      value: spec.unit,
      'aria-label': t('form.specUnit'),
      'data-spec-field': 'unit',
    });
    unitInput.readOnly = isViewMode();
    if (!isViewMode()) unitInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSpecRow(); } });

    const valueInput = el('input', {
      type: 'text',
      className: inputCls,
      placeholder: t('form.specValuePlaceholder'),
      value: spec.value,
      'aria-label': t('form.specValue'),
      'data-spec-field': 'value',
    });
    valueInput.readOnly = isViewMode();
    if (!isViewMode()) valueInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addSpecRow(); } });

    const delBtn = el('button', {
      type: 'button',
      className: `shrink-0 w-8 h-8 flex items-center justify-center rounded-xl text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition ${isViewMode() ? 'hidden' : ''}`,
      'aria-label': t('actions.delete'),
    }, '✕');
    delBtn.addEventListener('click', () => {
      _specs = collectSpecsFromDOM();
      _specs.splice(idx, 1);
      renderSpecsList();
    });

    row.append(paramInput, unitInput, valueInput, delBtn);
    container.appendChild(row);
  });

  if (_specs.length > 0) {
    requestAnimationFrame(() => {
      const allInputs = container.querySelectorAll('input');
      if (allInputs.length) allInputs[allInputs.length - 3]?.focus();
    });
  }
}

function addSpecRow() {
  _specs = collectSpecsFromDOM();
  _specs.push({ param: '', unit: '', value: '' });
  renderSpecsList();
}

function collectSpecsFromDOM() {
  const container = document.getElementById('specsListWrap');
  if (!container) return [..._specs];
  const rows = container.querySelectorAll('[data-spec-row]');
  const result = [];
  rows.forEach(row => {
    const inputs = row.querySelectorAll('input[data-spec-field]');
    const obj = { param: '', unit: '', value: '' };
    inputs.forEach(inp => { obj[inp.dataset.specField] = inp.value; });
    result.push(obj);
  });
  return result;
}

// ─── Field error highlight ────────────────────────────────────────

function setFieldError(fieldId, hasError) {
  const el = $(fieldId);
  if (!el) return;
  if (hasError) {
    el.classList.add('border-red-500/70');
    el.classList.remove('border-white/10');
  } else {
    el.classList.remove('border-red-500/70');
    el.classList.add('border-white/10');
  }
}

// ─── Open / Close ─────────────────────────────────────────────────

export function openProductForm(product = null, onSave = null, options = {}) {
  currentProduct = product;
  onSaveCallback = onSave;
  currentMode = options.mode === 'view' ? 'view' : 'edit';
  onCloseCallback = typeof options.onClose === 'function' ? options.onClose : null;

  const overlay = $('formModal');
  if (!overlay) return;

  const isEdit = !!product;
  const titleEl = qs('[data-form-title]', overlay);
  if (titleEl) titleEl.textContent = isEdit ? t('form.editTitle') : t('form.addTitle');

  const numberInput = $('fieldNumber');
  const nameInput   = $('fieldName');
  const hasVariantsInput = $('fieldHasColorVariants');

  if (numberInput) {
    numberInput.value = isEdit ? product.number : generateNumber();
    numberInput.readOnly = true;
    numberInput.classList.add('opacity-60', 'cursor-not-allowed');
  }
  if (nameInput) nameInput.value = product?.name || '';
  if (hasVariantsInput) hasVariantsInput.checked = hasProductColorVariants(product);
  _colorVariants = isEdit ? getProductColorVariants(product).map(variant => ({ ...variant })) : [];

  // Assembly field
  const assemblyVal     = product?.assembly ?? 'not_required';
  const radioRequired    = $('fieldAssemblyRequired');
  const radioNotRequired = $('fieldAssemblyNotRequired');
  if (radioRequired)    radioRequired.checked    = (assemblyVal === 'required');
  if (radioNotRequired) radioNotRequired.checked = (assemblyVal !== 'required');

  // Product group field
  const pgInput = $('fieldProductGroup');
  if (pgInput) pgInput.value = product?.productGroup || '';
  refreshProductGroupDatalist();

  renderProductSpecificationMappings(product);
  renderProductNeedByAddress(product);

  // Clear previous validation errors
  setFieldError('fieldCategory', false);
  setFieldError('fieldProductGroup', false);

  // Populate specs
  _specs = normalizeSpecs(product || {});
  if (_specs.length === 0) _specs = [{ param: '', unit: '', value: '' }];
  renderSpecsList();

  populateCategorySelect(product?.category || '');

  const newCatWrap  = $('newCategoryWrap');
  if (newCatWrap)  newCatWrap.classList.add('hidden');
  const newCatInput = $('newCategoryInput');
  if (newCatInput) newCatInput.value = '';

  setFormMode(isViewMode());

  overlay.classList.add('open');
  setTimeout(() => nameInput?.focus(), 100);
}

export function closeProductForm() {
  const overlay = $('formModal');
  if (overlay) overlay.classList.remove('open');
  const closeCb = onCloseCallback;
  currentProduct = null;
  currentMode = 'edit';
  onCloseCallback = null;
  _specs = [];
  _colorVariants = [];

  const numberInput = $('fieldNumber');
  if (numberInput) {
    numberInput.readOnly = false;
    numberInput.classList.remove('opacity-60', 'cursor-not-allowed');
  }

  ['fieldName', 'fieldProductGroup', 'newCategoryInput'].forEach(id => {
    const node = $(id);
    if (node) node.readOnly = false;
  });
  ['fieldCategory', 'fieldAssemblyRequired', 'fieldAssemblyNotRequired', 'fieldHasColorVariants'].forEach(id => {
    const node = $(id);
    if (node) node.disabled = false;
  });
  ['addSpecBtn', 'importSpecsBtn', 'aiSpecsImportBtn', 'addCategoryInlineBtn', 'formSaveBtn', 'addColorVariantBtn'].forEach(id => {
    const btn = $(id);
    if (!btn) return;
    btn.classList.remove('hidden');
    btn.disabled = false;
  });
  const cancelBtn = $('formCancelBtn');
  if (cancelBtn) cancelBtn.textContent = t('actions.cancel');
  $('productSpecificationMappingsSection')?.remove();
  $('productNeedByAddressSection')?.remove();

  if (closeCb) {
    try {
      closeCb();
    } catch (err) {
      console.warn('[product-form] onClose callback failed:', err);
    }
  }
}

// ─── Category handlers ────────────────────────────────────────────

function handleCategoryChange() {
  const sel  = $('fieldCategory');
  const wrap = $('newCategoryWrap');
  if (!sel || !wrap) return;
  if (sel.value === '__add_new__') {
    wrap.classList.remove('hidden');
    setTimeout(() => $('newCategoryInput')?.focus(), 50);
  } else {
    wrap.classList.add('hidden');
    setFieldError('fieldCategory', false);
  }
}

async function handleInlineAddCategory() {
  const input = $('newCategoryInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;
  if (addCategory(name)) {
    await saveToStorage();
    populateCategorySelect(name);
    $('newCategoryWrap')?.classList.add('hidden');
    input.value = '';
    showToast(t('toast.categoryAdded'), 'success');
    setFieldError('fieldCategory', false);
  }
}

// ─── Save ─────────────────────────────────────────────────────────

export async function handleFormSubmit() {
  const nameInput      = $('fieldName');
  const categorySelect = $('fieldCategory');
  const pgInput        = $('fieldProductGroup');
  const hasVariantsInput = $('fieldHasColorVariants');

  const name = (nameInput?.value || '').trim();
  if (!name) {
    nameInput?.focus();
    showToast(t('form.required'), 'warning');
    return;
  }

  let category = categorySelect?.value || '';
  if (category === '__add_new__') category = '';

  // Validate required: category
  if (!category) {
    setFieldError('fieldCategory', true);
    categorySelect?.focus();
    showToast(t('form.categoryRequired'), 'warning');
    return;
  }
  setFieldError('fieldCategory', false);

  // Validate required: productGroup
  const productGroup = (pgInput?.value || '').trim();
  if (!productGroup) {
    setFieldError('fieldProductGroup', true);
    pgInput?.focus();
    showToast(t('form.productGroupRequired'), 'warning');
    return;
  }
  setFieldError('fieldProductGroup', false);

  // Collect specs
  const specs = collectSpecsFromDOM().filter(s => s.param.trim() || s.unit.trim() || s.value.trim());
  const hasColorVariants = Boolean(hasVariantsInput?.checked);
  const colorVariants = hasColorVariants ? collectColorVariantsFromDOM() : [];

  if (hasColorVariants && colorVariants.length === 0) {
    showToast(tf('form.colorVariantsRequired', 'Добавьте хотя бы один цветовой вариант'), 'warning');
    return;
  }

  const duplicateColor = new Set();
  const hasDuplicateColor = colorVariants.some(variant => {
    const key = normalizeColorCodeInput(variant.colorCode);
    if (duplicateColor.has(key)) return true;
    duplicateColor.add(key);
    return false;
  });
  if (hasDuplicateColor) {
    showToast(tf('form.colorVariantsDuplicate', 'Коды цветов не должны повторяться'), 'warning');
    return;
  }

  const data = {
    name,
    category,
    hasColorVariants,
    colorVariants,
    productGroup,
    specs,
  };

  const radioReq = $('fieldAssemblyRequired');
  data.assembly = (radioReq && radioReq.checked) ? 'required' : 'not_required';

  if (currentProduct) {
    const upd = updateProduct(currentProduct.id, data);
    if (upd && upd.error === 'duplicate') {
      nameInput?.focus();
      nameInput?.classList.add('border-red-500/70');
      nameInput?.classList.remove('border-white/10');
      showToast(`⚠ Товар с именем «${name}» уже есть в каталоге (№${upd.existing.number})`, 'warning');
      return;
    }
  } else {
    const result = addProduct(data);
    if (result && result.error === 'duplicate') {
      nameInput?.focus();
      nameInput?.classList.add('border-red-500/70');
      nameInput?.classList.remove('border-white/10');
      showToast(`⚠ Товар с именем «${name}» уже есть в каталоге (№${result.existing.number})`, 'warning');
      return;
    }
  }

  showToast(t('toast.saved'), 'success');
  await saveToStorage();
  closeProductForm();
  if (onSaveCallback) onSaveCallback();
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Init ─────────────────────────────────────────────────────────

export function initProductForm() {
  const overlay = $('formModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeProductForm();
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) closeProductForm();
  });

  $('formCancelBtn')?.addEventListener('click', closeProductForm);
  $('formSaveBtn')?.addEventListener('click', handleFormSubmit);

  $('fieldCategory')?.addEventListener('change', handleCategoryChange);
  $('addCategoryInlineBtn')?.addEventListener('click', handleInlineAddCategory);
  $('newCategoryInput')?.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleInlineAddCategory(); }
  });

  // Clear productGroup error on input
  $('fieldProductGroup')?.addEventListener('input', () => setFieldError('fieldProductGroup', false));
  $('fieldHasColorVariants')?.addEventListener('change', () => {
    if ($('fieldHasColorVariants')?.checked && _colorVariants.length === 0) {
      _colorVariants = [{ id: '', colorCode: '', active: true }];
    }
    renderColorVariantsList();
  });
  $('addColorVariantBtn')?.addEventListener('click', () => {
    _colorVariants = collectColorVariantsFromDOM();
    _colorVariants.push({ id: '', colorCode: '', active: true });
    renderColorVariantsList();
  });

  $('addSpecBtn')?.addEventListener('click', addSpecRow);

  $('importSpecsBtn')?.addEventListener('click', () => {
    openSpecsImportModal(importedSpecs => {
      const nonEmpty = _specs.filter(s => s.param.trim() || s.unit.trim() || s.value.trim());
      _specs = [...nonEmpty, ...importedSpecs];
      if (_specs.length === 0) _specs = [{ param: '', unit: '', value: '' }];
      renderSpecsList();
    });
  });

  $('aiSpecsImportBtn')?.addEventListener('click', () => {
    // Открываем ИИ-импорт в режиме каталога — товары добавляются напрямую
    openAiSpecsImport();
  });
}
