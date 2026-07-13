/**
 * Category management modal.
 * Allows adding and removing product categories.
 */

import { $, el, clearChildren } from './dom.js';
import { state, addCategory, removeCategory, getCategories } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

/** Render the category list inside the modal */
function renderCategoryList() {
  const container = $('categoryManageList');
  if (!container) return;
  clearChildren(container);

  const categories = getCategories();

  if (categories.length === 0) {
    container.appendChild(
      el('p', { className: 'text-sm text-slate-500 py-4 text-center' }, t('categories.empty')),
    );
    return;
  }

  categories.forEach(cat => {
    const usedCount = state.products.filter(p => p.category === cat).length;

    const row = el('div', {
      className: 'flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-2.5',
    });

    const left = el('div', { className: 'flex items-center gap-2 min-w-0' });
    left.appendChild(el('span', { className: 'text-sm text-white truncate' }, cat));
    if (usedCount > 0) {
      left.appendChild(
        el('span', { className: 'text-xs text-slate-500 whitespace-nowrap' }, `(${usedCount})`),
      );
    }

    const delBtn = el('button', {
      className: 'shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': t('categories.delete'),
      title: t('categories.delete'),
      onClick: () => handleDeleteCategory(cat),
    }, '✕');

    row.append(left, delBtn);
    container.appendChild(row);
  });
}

/** Handle delete category */
async function handleDeleteCategory(name) {
  removeCategory(name);
  await saveToStorage();
  showToast(t('toast.categoryDeleted'), 'success');
  renderCategoryList();
}

/** Handle add category from modal */
async function handleAddCategory() {
  const input = $('newCatInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  if (addCategory(name)) {
    await saveToStorage();
    showToast(t('toast.categoryAdded'), 'success');
    input.value = '';
    renderCategoryList();
  }
}

/** Open categories management modal */
export function openCategoriesModal() {
  const overlay = $('categoriesModal');
  if (!overlay) return;
  renderCategoryList();
  overlay.classList.add('open');
  setTimeout(() => $('newCatInput')?.focus(), 100);
}

/** Close categories management modal */
export function closeCategoriesModal() {
  const overlay = $('categoriesModal');
  if (overlay) overlay.classList.remove('open');
}

/** Initialize categories panel events */
export function initCategoriesPanel() {
  const overlay = $('categoriesModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeCategoriesModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closeCategoriesModal();
    }
  });

  const closeBtn = $('categoriesCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeCategoriesModal);

  const addBtn = $('addCatBtn');
  if (addBtn) addBtn.addEventListener('click', handleAddCategory);

  const input = $('newCatInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddCategory();
      }
    });
  }
}
