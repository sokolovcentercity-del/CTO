/**
 * Product Groups management modal.
 * Allows adding, editing and removing product groups (товарные группы).
 */

import { $, el, clearChildren } from './dom.js';
import { state, addProductGroup, removeProductGroup, getProductGroups, countProductsInGroup } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// id of the group currently being edited inline (null = none)
let _editingGroup = null;

/** Render the groups list inside the modal */
function renderGroupList() {
  const container = $('productGroupManageList');
  if (!container) return;
  clearChildren(container);

  const groups = getProductGroups();

  if (groups.length === 0) {
    container.appendChild(
      el('p', { className: 'text-sm text-slate-500 py-4 text-center' }, t('productGroups.empty')),
    );
    return;
  }

  groups.forEach(group => {
    const usedCount = countProductsInGroup(group);
    const isEditing = _editingGroup === group;

    const row = el('div', {
      className: 'flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2',
    });

    if (isEditing) {
      // ── Edit mode ──
      const inp = el('input', {
        type: 'text',
        className: 'flex-1 min-w-0 rounded-lg border border-cyan-400/50 bg-white/10 px-2 py-1 text-sm text-white outline-none',
        value: group,
        'aria-label': t('productGroups.editLabel'),
      });

      const saveBtn = el('button', {
        type: 'button',
        className: 'shrink-0 rounded-lg px-2 py-1 text-xs font-semibold bg-cyan-400/20 text-cyan-400 hover:bg-cyan-400/30 transition',
        'aria-label': t('actions.save'),
      });
      saveBtn.textContent = '✓';

      const cancelBtn = el('button', {
        type: 'button',
        className: 'shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/10 transition',
        'aria-label': t('actions.cancel'),
      });
      cancelBtn.textContent = '✕';

      const doSave = async () => {
        const newName = inp.value.trim();
        if (!newName) { inp.focus(); return; }
        if (newName === group) { _editingGroup = null; renderGroupList(); return; }
        // Check duplicate
        const lower = newName.toLowerCase();
        if (state.productGroups.some(g => g !== group && g.toLowerCase() === lower)) {
          showToast(t('productGroups.duplicate'), 'warning');
          inp.focus();
          return;
        }
        // Rename in state
        const idx = state.productGroups.indexOf(group);
        if (idx !== -1) state.productGroups[idx] = newName;
        state.productGroups.sort((a, b) => a.localeCompare(b));
        // Update all products referencing this group
        state.products.forEach(p => {
          if (p.productGroup === group) p.productGroup = newName;
        });
        await saveToStorage();
        showToast(t('productGroups.renamed'), 'success');
        _editingGroup = null;
        renderGroupList();
        refreshProductGroupDatalist();
      };

      saveBtn.addEventListener('click', doSave);
      cancelBtn.addEventListener('click', () => { _editingGroup = null; renderGroupList(); });
      inp.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); doSave(); }
        if (e.key === 'Escape') { _editingGroup = null; renderGroupList(); }
      });

      row.append(inp, saveBtn, cancelBtn);
      requestAnimationFrame(() => { inp.focus(); inp.select(); });
    } else {
      // ── View mode ──
      const left = el('div', { className: 'flex items-center gap-2 min-w-0 flex-1' });
      const nameSpan = el('span', { className: 'text-sm text-white truncate' });
      nameSpan.textContent = group;
      left.appendChild(nameSpan);
      if (usedCount > 0) {
        const badge = el('span', { className: 'text-xs text-slate-500 whitespace-nowrap shrink-0' });
        badge.textContent = `(${usedCount})`;
        left.appendChild(badge);
      }

      const editBtn = el('button', {
        type: 'button',
        className: 'shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-white/10 hover:text-white transition',
        'aria-label': t('actions.edit'),
        title: t('actions.edit'),
      });
      editBtn.textContent = '✎';
      editBtn.addEventListener('click', () => { _editingGroup = group; renderGroupList(); });

      const delBtn = el('button', {
        type: 'button',
        className: 'shrink-0 rounded-lg px-2 py-1 text-xs text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
        'aria-label': t('productGroups.delete'),
        title: t('productGroups.delete'),
      });
      delBtn.textContent = '✕';
      delBtn.addEventListener('click', () => handleDeleteGroup(group));

      row.append(left, editBtn, delBtn);
    }

    container.appendChild(row);
  });
}

/** Handle delete group */
async function handleDeleteGroup(name) {
  removeProductGroup(name);
  await saveToStorage();
  showToast(t('toast.categoryDeleted'), 'success');
  if (_editingGroup === name) _editingGroup = null;
  renderGroupList();
  refreshProductGroupDatalist();
}

/** Handle add group */
async function handleAddGroup() {
  const input = $('newProductGroupInput');
  if (!input) return;
  const name = input.value.trim();
  if (!name) return;

  if (addProductGroup(name)) {
    await saveToStorage();
    showToast(t('toast.categoryAdded'), 'success');
    input.value = '';
    renderGroupList();
    refreshProductGroupDatalist();
  } else {
    showToast(t('productGroups.duplicate'), 'warning');
  }
}

/** Refresh the datalist used in the product form */
export function refreshProductGroupDatalist() {
  const datalist = document.getElementById('productGroupDatalist');
  if (!datalist) return;
  clearChildren(datalist);
  getProductGroups().forEach(g => {
    const opt = document.createElement('option');
    opt.value = g;
    datalist.appendChild(opt);
  });
}

/** Open product groups management modal */
export function openProductGroupsModal() {
  _editingGroup = null;
  const overlay = $('productGroupsModal');
  if (!overlay) return;
  renderGroupList();
  overlay.classList.add('open');
  setTimeout(() => $('newProductGroupInput')?.focus(), 100);
}

/** Close product groups management modal */
export function closeProductGroupsModal() {
  _editingGroup = null;
  const overlay = $('productGroupsModal');
  if (overlay) overlay.classList.remove('open');
}

/** Initialize product groups panel events */
export function initProductGroupsPanel() {
  const overlay = $('productGroupsModal');
  if (!overlay) return;

  overlay.addEventListener('click', e => {
    if (e.target === overlay) closeProductGroupsModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && overlay.classList.contains('open')) {
      closeProductGroupsModal();
    }
  });

  const closeBtn = $('productGroupsCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeProductGroupsModal);

  const addBtn = $('addProductGroupBtn');
  if (addBtn) addBtn.addEventListener('click', handleAddGroup);

  const input = $('newProductGroupInput');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleAddGroup();
      }
    });
  }
}
