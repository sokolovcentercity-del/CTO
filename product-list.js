/**
 * Product list/grid rendering.
 * Handles card display and empty state.
 */

import { getFilteredProducts, state } from '../state.js';
import { el, $, clearChildren } from './dom.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

/** Known color name to hex mapping */
const COLOR_MAP = {
  'красный': '#ef4444', 'red': '#ef4444',
  'синий': '#3b82f6', 'blue': '#3b82f6',
  'зелёный': '#22c55e', 'green': '#22c55e',
  'жёлтый': '#eab308', 'yellow': '#eab308',
  'чёрный': '#1e293b', 'black': '#1e293b',
  'белый': '#f8fafc', 'white': '#f8fafc',
  'серый': '#94a3b8', 'gray': '#94a3b8', 'grey': '#94a3b8',
  'оранжевый': '#f97316', 'orange': '#f97316',
  'фиолетовый': '#a855f7', 'purple': '#a855f7',
  'розовый': '#ec4899', 'pink': '#ec4899',
  'коричневый': '#a16207', 'brown': '#a16207',
  'голубой': '#06b6d4', 'cyan': '#06b6d4',
};

/** Try to resolve a color name to hex */
function resolveColor(colorName) {
  if (!colorName) return null;
  const lower = colorName.toLowerCase().trim();
  if (COLOR_MAP[lower]) return COLOR_MAP[lower];
  // Check if it's already a hex color
  if (/^#[0-9a-f]{3,8}$/i.test(colorName)) return colorName;
  return null;
}

/** Render a single product card */
function renderCard(product, onEdit, onDelete) {
  const colorHex = resolveColor(product.color);

  const card = el('div', {
    className: 'product-card group relative flex flex-col rounded-2xl border border-white/10 bg-white/5 p-5',
  });

  // Header row: number badge + actions
  const header = el('div', { className: 'mb-3 flex items-start justify-between' });

  const numBadge = el(
    'span',
    { className: 'inline-flex items-center rounded-lg bg-cyan-400/15 px-2.5 py-1 text-xs font-bold text-cyan-300' },
    `${t('card.number')} ${product.number}`,
  );

  const actions = el('div', { className: 'flex gap-1 opacity-0 transition-opacity group-hover:opacity-100' });

  const editBtn = el(
    'button',
    {
      className: 'rounded-lg p-1.5 text-slate-400 hover:bg-white/10 hover:text-white transition',
      'aria-label': t('actions.edit'),
      title: t('actions.edit'),
      onClick: () => onEdit(product),
    },
    '✎',
  );

  const deleteBtn = el(
    'button',
    {
      className: 'rounded-lg p-1.5 text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': t('actions.delete'),
      title: t('actions.delete'),
      onClick: () => onDelete(product),
    },
    '✕',
  );

  actions.append(editBtn, deleteBtn);
  header.append(numBadge, actions);

  // Name
  const name = el('h3', { className: 'text-lg font-semibold text-white leading-tight' }, product.name || '—');

  // Category + Color row
  const meta = el('div', { className: 'mt-2 flex flex-wrap items-center gap-2' });

  if (product.category) {
    meta.appendChild(
      el(
        'span',
        { className: 'inline-flex items-center rounded-lg bg-amber-400/15 px-2.5 py-0.5 text-xs font-medium text-amber-300' },
        product.category,
      ),
    );
  }

  if (product.color) {
    const colorTag = el('span', {
      className: 'inline-flex items-center gap-1.5 rounded-lg bg-white/10 px-2.5 py-0.5 text-xs font-medium text-slate-300',
    });
    if (colorHex) {
      colorTag.appendChild(
        el('span', {
          className: 'color-swatch',
          style: `background:${colorHex}`,
        }),
      );
    }
    colorTag.appendChild(document.createTextNode(product.color));
    meta.appendChild(colorTag);
  }

  // Characteristics
  let specs = null;
  if (product.characteristics) {
    specs = el('p', {
      className: 'mt-3 text-sm leading-relaxed text-slate-400 line-clamp-3',
    });
    specs.textContent = product.characteristics;
  }

  card.append(header, name, meta);
  if (specs) card.appendChild(specs);

  return card;
}

/** Render empty state */
function renderEmpty() {
  return el(
    'div',
    { className: 'flex flex-col items-center justify-center py-20 text-center' },
    el('span', { className: 'text-5xl mb-4' }, t('empty.icon')),
    el('h2', { className: 'text-xl font-semibold text-slate-300 mb-2' }, t('empty.title')),
    el('p', { className: 'text-sm text-slate-500 max-w-xs' }, t('empty.subtitle')),
  );
}

/** Render the full product grid */
export function renderProductList(onEdit, onDelete) {
  const container = $('productGrid');
  if (!container) return;

  clearChildren(container);

  const products = getFilteredProducts();

  if (products.length === 0 && state.products.length === 0) {
    container.appendChild(renderEmpty());
    return;
  }

  if (products.length === 0) {
    container.appendChild(
      el(
        'div',
        { className: 'flex flex-col items-center justify-center py-16 text-center' },
        el('span', { className: 'text-4xl mb-3' }, '🔍'),
        el('p', { className: 'text-sm text-slate-500' }, t('filters.noResults')),
      ),
    );
    return;
  }

  const grid = el('div', {
    className: 'grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3',
  });

  products.forEach(p => {
    grid.appendChild(renderCard(p, onEdit, onDelete));
  });

  container.appendChild(grid);
}

/** Get count of currently filtered products */
export function getVisibleCount() {
  return getFilteredProducts().length;
}
