/**
 * Application state management.
 * Single source of truth for products, categories, filters, and sorting.
 */

const DEFAULT_CATEGORIES = ['Мебель', 'Спорт', 'Учебное', 'Пищеблок'];

export const state = {
  products: [],
  categories: [...DEFAULT_CATEGORIES],
  productGroups: [],     // Товарные группы: string[]
  recipients: [],
  suppliers: [],
  programs: [],          // Финансы: целевые программы
  nextProgramId: 1,
  contracts: [],
  lots: [],              // Лотирование: [{ id, lotNumber, contractId, contractNumber, recipientIds, items[{ productId, productName, productCode, qty, nmcd }] }]
  nextLotId: 1,
  warehouses: [],        // Склады: [{ id, name, supplierId, address, phone }]
  nextWarehouseId: 1,
  nextProductGroupId: 1,
  activeWarehouseId: null, // null = сводный режим (все склады)
  commission: [],        // Комиссия приёмки: [{ id, role, name }]
  nextCommissionId: 1,
  invitedExperts: [],    // Приглашённые эксперты: [{ id, role, organization, name }]
  nextInvitedExpertId: 1,
  inspectionSchedules: [], // График проверок / приёмки: [{ id, ...fields }]
  nextInspectionScheduleId: 1,
  acts: [],              // Реестр актов проверки: [{ id, ...actData, savedAt }]
  nextActId: 1,
  primaryDocs: [],       // Реестр первичных документов: [{ id, ...docData, savedAt }]
  nextPrimaryDocId: 1,
  claims: [],            // Претензии по контрактам: [{ id, contractId, ...claimData }]
  nextClaimId: 1,
  orders: [],            // Реестр заявок: [{ id, orderNumber, contractId, ... }]
  nextOrderId: 1,
  warehouseEntries: [],  // Склад: поступления товаров
  nextWarehouseEntryId: 1,
  shipments: [],         // Реестр отгрузок: [{ id, date, items, grid, createdAt }]
  nextShipmentId: 1,
  directDeliveries: [],  // Прямые поставки получателям
  nextDirectDeliveryId: 1,
  filters: { search: '', category: '', color: '' },
  sort: { key: 'number', dir: 'asc' },
  nextId: 1,
  nextRecipientId: 1,
  nextContractId: 1,
};

function normalizeColorCode(value) {
  return String(value || '')
    .trim()
    .replace(/\s+/g, '')
    .replace(/–/g, '-')
    .replace(/—/g, '-');
}

function normalizeVariantId(value) {
  return normalizeColorCode(value).toLowerCase();
}

export function buildProductFullCode(productOrBaseCode, colorCode = '') {
  const baseCode = typeof productOrBaseCode === 'string'
    ? String(productOrBaseCode || '').trim()
    : String(productOrBaseCode?.baseCode || productOrBaseCode?.code || '').trim();
  const normalizedColor = normalizeColorCode(colorCode);
  if (!normalizedColor) return baseCode;
  if (!baseCode) return '';
  return `${baseCode}-${normalizedColor}`;
}

export function normalizeProductColorVariants(product) {
  const rawVariants = Array.isArray(product?.colorVariants) ? product.colorVariants : [];
  const legacyColor = normalizeColorCode(product?.color || '');
  const items = rawVariants.length
    ? rawVariants
    : (legacyColor ? [{ colorCode: legacyColor }] : []);

  const seen = new Set();
  return items
    .map((item, index) => {
      const colorCode = normalizeColorCode(item?.colorCode || item?.code || item?.value || item);
      if (!colorCode) return null;
      const key = normalizeVariantId(item?.id || colorCode);
      if (seen.has(key)) return null;
      seen.add(key);
      return {
        id: key || `variant_${index + 1}`,
        colorCode,
        active: item?.active !== false,
      };
    })
    .filter(Boolean);
}

export function normalizeProductColorState(product) {
  if (!product || typeof product !== 'object') return product;
  product.code = String(product.code || '').trim();
  product.hasColorVariants = Boolean(product.hasColorVariants);
  product.colorVariants = normalizeProductColorVariants(product);
  if (product.colorVariants.length > 0) product.hasColorVariants = true;
  delete product.color;
  return product;
}

export function hasProductColorVariants(product) {
  if (!product || typeof product !== 'object') return false;
  const variants = normalizeProductColorVariants(product);
  return variants.length > 0;
}

export function getProductColorVariants(product) {
  if (!product || typeof product !== 'object') return [];
  return normalizeProductColorVariants(product);
}

export function getProductVariantByKey(product, variantKey) {
  const key = normalizeVariantId(variantKey);
  if (!key) return null;
  return getProductColorVariants(product).find(variant => normalizeVariantId(variant.id || variant.colorCode) === key) || null;
}

export function normalizeNeedEntry(entry, product = null) {
  const base = { qty: 0, delivered: 0, assembled: 0 };
  if (entry == null) return base;
  if (typeof entry !== 'object') return { ...base, qty: Number(entry) || 0 };

  const normalized = {
    ...base,
    qty: Number(entry.qty) || 0,
    delivered: Number(entry.delivered) || 0,
    assembled: Number(entry.assembled) || 0,
  };

  const variantsSource = entry.variants && typeof entry.variants === 'object'
    ? entry.variants
    : null;

  if (variantsSource) {
    const variants = {};
    let totalQty = 0;
    let totalDelivered = 0;
    let totalAssembled = 0;

    Object.entries(variantsSource).forEach(([rawKey, rawVariant]) => {
      const variant = rawVariant && typeof rawVariant === 'object' ? rawVariant : { qty: rawVariant };
      const colorCode = normalizeColorCode(variant.colorCode || rawKey);
      if (!colorCode) return;
      const key = normalizeVariantId(variant.id || colorCode);
      const qty = Number(variant.qty) || 0;
      const delivered = Number(variant.delivered) || 0;
      const assembled = Number(variant.assembled) || 0;
      variants[key] = {
        id: key,
        colorCode,
        qty,
        delivered,
        assembled,
      };
      totalQty += qty;
      totalDelivered += delivered;
      totalAssembled += assembled;
    });

    normalized.variants = variants;
    normalized.qty = totalQty;
    normalized.delivered = totalDelivered;
    normalized.assembled = totalAssembled;
  }

  return normalized;
}

/** Get all used product numbers */
function getUsedNumbers() {
  return new Set(state.products.map(p => p.number));
}

/** Generate a unique product number that doesn't collide with any existing */
export function generateNumber() {
  const used = getUsedNumbers();
  let candidate = state.products.length > 0
    ? Math.max(...state.products.map(p => p.number)) + 1
    : 1;
  while (used.has(candidate)) {
    candidate++;
  }
  return candidate;
}

/** Ensure a specific number is unique; if not, find the next available */
export function ensureUniqueNumber(desired) {
  const used = getUsedNumbers();
  let n = desired;
  while (used.has(n)) {
    n++;
  }
  return n;
}

/** Get all categories (predefined + from products) */
export function getCategories() {
  const seen = new Map(); // lowercase -> canonical name
  for (const cat of state.categories) {
    seen.set(cat.toLowerCase(), cat);
  }
  state.products.forEach(p => {
    if (p.category && !seen.has(p.category.toLowerCase())) {
      seen.set(p.category.toLowerCase(), p.category);
    }
  });
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Get unique colors from products */
export function getColors() {
  const cols = new Set(
    state.products.flatMap(p => hasProductColorVariants(p)
      ? getProductColorVariants(p).map(variant => variant.colorCode)
      : [])
  );
  return [...cols].sort((a, b) => a.localeCompare(b));
}

/** Get filtered and sorted products */
export function getFilteredProducts() {
  const { search, category, color } = state.filters;
  const query = search.toLowerCase().trim();

  let result = state.products.filter(p => {
    if (category && p.category !== category) return false;
    if (color && !getProductColorVariants(p).some(variant => variant.colorCode === color)) return false;
    if (query) {
      const specsText = Array.isArray(p.specs) ? p.specs.join(' ') : (p.characteristics || '');
      const variantCodes = getProductColorVariants(p)
        .map(variant => variant.colorCode)
        .join(' ');
      const haystack = [p.name, p.category, specsText, variantCodes, String(p.number)]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      if (!haystack.includes(query)) return false;
    }
    return true;
  });

  // Apply sorting
  const { key, dir } = state.sort;
  const mult = dir === 'asc' ? 1 : -1;

  result.sort((a, b) => {
    let va = a[key];
    let vb = b[key];

    // Numeric sort for 'number'
    if (key === 'number') {
      return ((va || 0) - (vb || 0)) * mult;
    }

    // String sort for everything else
    va = (va || '').toString().toLowerCase();
    vb = (vb || '').toString().toLowerCase();
    return va.localeCompare(vb) * mult;
  });

  return result;
}

/** Set sort column and direction */
export function setSort(key) {
  if (state.sort.key === key) {
    state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
  } else {
    state.sort.key = key;
    state.sort.dir = 'asc';
  }
}

/** Add a category */
export function addCategory(name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (state.categories.some(c => c.toLowerCase() === lower)) return false;
  state.categories.push(trimmed);
  state.categories.sort((a, b) => a.localeCompare(b));
  return true;
}

/** Remove a category */
export function removeCategory(name) {
  const idx = state.categories.indexOf(name);
  if (idx === -1) return false;
  state.categories.splice(idx, 1);
  return true;
}

/**
 * Normalize a single spec entry to { param, unit, value }.
 * Handles old plain strings (e.g. "Длина: 120 см" or "Длина 120 см").
 */
function normalizeSpecItem(s) {
  if (s && typeof s === 'object') {
    return {
      param: String(s.param ?? ''),
      unit:  String(s.unit  ?? ''),
      value: String(s.value ?? ''),
    };
  }
  // Migrate old string: try "Param: value unit" or "Param | unit | value"
  const str = String(s ?? '').trim();
  if (!str) return null;
  // Pipe-separated: "param | unit | value"
  const pipeParts = str.split('|').map(p => p.trim());
  if (pipeParts.length === 3) {
    return { param: pipeParts[0], unit: pipeParts[1], value: pipeParts[2] };
  }
  // Colon-separated: "param: value"
  const colonIdx = str.indexOf(':');
  if (colonIdx > 0) {
    return { param: str.slice(0, colonIdx).trim(), unit: '', value: str.slice(colonIdx + 1).trim() };
  }
  // Fallback: put whole string into param
  return { param: str, unit: '', value: '' };
}

/**
 * Normalize product specs to { param, unit, value }[].
 * Handles old string `characteristics` and new `specs` array.
 */
export function normalizeSpecs(product) {
  if (Array.isArray(product.specs)) {
    return product.specs.map(normalizeSpecItem).filter(Boolean);
  }
  if (typeof product.characteristics === 'string' && product.characteristics.trim()) {
    return product.characteristics
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean)
      .map(normalizeSpecItem)
      .filter(Boolean);
  }
  return [];
}

/** Add a product (manual entry — number is auto-assigned) */
export function addProduct(product) {
  // Enforce unique name rule
  const nameLow = (product.name || '').trim().toLowerCase();
  if (nameLow) {
    const dup = state.products.find(p => (p.name || '').trim().toLowerCase() === nameLow);
    if (dup) return { error: 'duplicate', existing: dup };
  }
  product.id = state.nextId++;
  product.number = generateNumber();
  // Normalize specs
  if (!Array.isArray(product.specs)) {
    product.specs = normalizeSpecs(product);
  }
  normalizeProductColorState(product);
  if (product.assembly === undefined) product.assembly = 'not_required';
  delete product.characteristics;
  state.products.push(product);
  return { ok: true, product };
}

/** Update a product by id */
export function updateProduct(id, data) {
  const idx = state.products.findIndex(p => p.id === id);
  if (idx === -1) return null;
  // Enforce unique name rule (exclude self)
  const newName = (data.name || '').trim().toLowerCase();
  if (newName) {
    const dup = state.products.find(p => p.id !== id && (p.name || '').trim().toLowerCase() === newName);
    if (dup) return { error: 'duplicate', existing: dup };
  }
  // Normalize specs in incoming data
  if (data.specs !== undefined && !Array.isArray(data.specs)) {
    data.specs = normalizeSpecs(data);
  }
  if (data.characteristics !== undefined && data.specs === undefined) {
    data.specs = typeof data.characteristics === 'string'
      ? data.characteristics.split('\n').map(s => s.trim()).filter(Boolean)
      : [];
    delete data.characteristics;
  }
  Object.assign(state.products[idx], data);
  normalizeProductColorState(state.products[idx]);
  return state.products[idx];
}

/** Delete a product by id */
export function deleteProduct(id) {
  const idx = state.products.findIndex(p => p.id === id);
  if (idx === -1) return false;
  state.products.splice(idx, 1);
  // Clean up recipient needs referencing deleted product
  removeRecipientNeedsForProduct(id);
  return true;
}

/** Get recipient by id */
export function getRecipientById(id) {
  return state.recipients.find(r => r.id === id) || null;
}

/** Normalize recipient address list with backward compatibility */
export function normalizeRecipientAddresses(addresses, fallbackAddress = '') {
  const source = Array.isArray(addresses)
    ? addresses
    : (typeof addresses === 'string' && addresses.trim()
        ? addresses.split(/\r?\n|\s*\|\s*|\s*;;\s*/)
        : []);

  const result = [];
  const seen = new Set();

  source.forEach(addr => {
    const value = String(addr || '').trim();
    if (!value) return;
    const key = value.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    result.push(value);
  });

  const fallback = String(fallbackAddress || '').trim();
  if (result.length === 0 && fallback) result.push(fallback);
  return result;
}

/** Normalize recipient address key for address-level needs */
export function normalizeRecipientAddressNeedKey(address = '') {
  return String(address || '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Normalize recipient address-level needs map */
export function normalizeRecipientAddressNeeds(addressNeeds, recipient = null) {
  const source = addressNeeds && typeof addressNeeds === 'object' ? addressNeeds : {};
  const knownAddresses = normalizeRecipientAddresses(recipient?.addresses, recipient?.address || '');
  const knownByKey = new Map(
    knownAddresses.map(address => [normalizeRecipientAddressNeedKey(address), address])
  );
  const result = {};

  Object.entries(source).forEach(([rawKey, rawValue]) => {
    if (!rawValue || typeof rawValue !== 'object') return;

    const sourceAddress = typeof rawValue.address === 'string'
      ? rawValue.address
      : (knownByKey.get(normalizeRecipientAddressNeedKey(rawKey)) || rawKey);
    const normalizedAddress = String(sourceAddress || '').trim();
    if (!normalizedAddress) return;

    const key = normalizeRecipientAddressNeedKey(normalizedAddress);
    if (!key) return;

    const rawNeeds = rawValue.needs && typeof rawValue.needs === 'object'
      ? rawValue.needs
      : rawValue;

    const nextNeeds = {};
    Object.entries(rawNeeds || {}).forEach(([productId, entry]) => {
      const product = getProductById(Number(productId));
      nextNeeds[productId] = normalizeNeedEntry(entry, product);
    });

    result[key] = {
      address: knownByKey.get(key) || normalizedAddress,
      needs: nextNeeds,
    };
  });

  return result;
}

/** Get recipient addresses as normalized array */
export function getRecipientAddresses(recipient) {
  return normalizeRecipientAddresses(recipient?.addresses, recipient?.address || '');
}

function getRecipientAddressNeedsMapSafe(recipient) {
  if (!recipient || typeof recipient !== 'object') return {};
  if (!recipient.addressNeeds || typeof recipient.addressNeeds !== 'object') {
    recipient.addressNeeds = {};
  }
  recipient.addressNeeds = normalizeRecipientAddressNeeds(recipient.addressNeeds, recipient);
  return recipient.addressNeeds;
}

export function seedRecipientAddressNeedsFromAggregate(recipient) {
  if (!recipient || typeof recipient !== 'object') return false;

  const addresses = getRecipientAddresses(recipient);
  if (addresses.length === 0) return false;

  const addressNeeds = getRecipientAddressNeedsMapSafe(recipient);
  const hasAddressData = Object.values(addressNeeds).some((entry) => {
    const needs = entry?.needs && typeof entry.needs === 'object' ? entry.needs : null;
    return !!(needs && Object.keys(needs).length > 0);
  });
  if (hasAddressData) return false;

  const aggregateNeeds = recipient.needs && typeof recipient.needs === 'object'
    ? recipient.needs
    : {};
  const productIds = Object.keys(aggregateNeeds);
  if (productIds.length === 0) return false;

  const firstAddress = addresses[0];
  const firstKey = normalizeRecipientAddressNeedKey(firstAddress);
  if (!firstKey) return false;

  const nextNeeds = {};
  productIds.forEach((productId) => {
    const product = getProductById(Number(productId));
    nextNeeds[productId] = normalizeNeedEntry(aggregateNeeds[productId], product);
  });

  recipient.addressNeeds = {
    [firstKey]: {
      address: firstAddress,
      needs: nextNeeds,
    },
  };
  return true;
}

/** Add a recipient */
export function addRecipient(name) {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const recipient = {
    id: state.nextRecipientId++,
    name: trimmed,
    address: '',
    addresses: [],
    addressNeeds: {},
    readinessStatus: '',
    targetProgram: '',
    needs: {},
  };
  state.recipients.push(recipient);
  return recipient;
}

/** Delete a recipient by id */
export function deleteRecipient(id) {
  const idx = state.recipients.findIndex(r => r.id === id);
  if (idx === -1) return false;
  state.recipients.splice(idx, 1);
  return true;
}

/** Update recipient fields */
export function updateRecipient(id, data) {
  const r = getRecipientById(id);
  if (!r) return null;
  if (data.name !== undefined) r.name = data.name;
  if (data.addresses !== undefined) {
    r.addresses = normalizeRecipientAddresses(data.addresses, data.address);
    r.address = r.addresses[0] || '';
  } else if (data.address !== undefined) {
    r.address = data.address;
    r.addresses = normalizeRecipientAddresses(r.addresses, data.address);
  }
  if (data.readinessStatus !== undefined) r.readinessStatus = data.readinessStatus;
  if (data.targetProgram !== undefined) r.targetProgram = data.targetProgram;
  return r;
}

/** Update recipient needs */
export function updateRecipientNeeds(id, needs) {
  const r = getRecipientById(id);
  if (!r) return null;
  r.needs = needs;
  return r;
}

/** Remove a product reference from all recipients' needs */
export function removeRecipientNeedsForProduct(productId) {
  state.recipients.forEach(r => {
    delete r.needs[productId];
  });
}

/** Add multiple products (for import — numbers come from file) */
export function addProducts(products) {
  let skipped = 0;
  products.forEach(p => {
    const nameLow = (p.name || '').trim().toLowerCase();
    if (nameLow && state.products.some(ex => (ex.name || '').trim().toLowerCase() === nameLow)) {
      skipped++;
      return; // пропускаем дубликат
    }
    p.id = state.nextId++;
    if (!p.number || p.number <= 0) {
      p.number = generateNumber();
    } else {
      p.number = ensureUniqueNumber(p.number);
    }
    if (p.category && !state.categories.some(c => c.toLowerCase() === p.category.toLowerCase())) {
      state.categories.push(p.category);
    }
    // Normalize specs
    if (!Array.isArray(p.specs)) {
      p.specs = normalizeSpecs(p);
    }
    normalizeProductColorState(p);
    delete p.characteristics;
    state.products.push(p);
  });
  state.categories.sort((a, b) => a.localeCompare(b));
  return products.length;
}

/** Find product by id */
export function getProductById(id) {
  return state.products.find(p => p.id === id) || null;
}

/**
 * Scan all products for duplicate numbers and reassign unique numbers.
 * Returns the number of products that were renumbered.
 */
export function renumberDuplicateNumbers() {
  if (state.products.length <= 1) return 0;

  const sorted = [...state.products].sort((a, b) => (a.number - b.number) || (a.id - b.id));

  const used = new Set();
  let renumbered = 0;
  let nextFree = 1;

  for (const product of sorted) {
    if (used.has(product.number)) {
      while (used.has(nextFree)) nextFree++;
      product.number = nextFree;
      renumbered++;
    }
    used.add(product.number);
    if (nextFree <= product.number) nextFree = product.number + 1;
  }

  return renumbered;
}

/**
 * Deduplicate categories case-insensitively.
 * Keeps the first occurrence (original casing), removes case-only duplicates.
 * Also normalizes product category references to match the kept variant.
 */
export function deduplicateCategories() {
  const seen = new Map(); // lowercase -> canonical name
  const kept = [];

  for (const cat of state.categories) {
    const lower = cat.toLowerCase();
    if (!seen.has(lower)) {
      seen.set(lower, cat);
      kept.push(cat);
    }
  }

  // Also merge categories found in products
  for (const p of state.products) {
    if (!p.category) continue;
    const lower = p.category.toLowerCase();
    if (!seen.has(lower)) {
      seen.set(lower, p.category);
      kept.push(p.category);
    }
  }

  state.categories = kept.sort((a, b) => a.localeCompare(b));

  // Normalize product category references to the canonical form
  for (const p of state.products) {
    if (!p.category) continue;
    const canonical = seen.get(p.category.toLowerCase());
    if (canonical && canonical !== p.category) {
      p.category = canonical;
    }
  }
}

// ─── Contracts ───────────────────────────────────────────────────

/** Add a contract */
export function addContract(data) {
  const contract = {
    id: state.nextContractId++,
    title: data.title || '',
    number: data.number || '',
    lotNumber: data.lotNumber || '',
    lotId: data.lotId ?? null,
    date: data.date || '',
    supplierId: data.supplierId || null,
    totalPrice: data.totalPrice || 0,
    programs: data.programs || [],
    items: data.items || [],
    renameActRows: Array.isArray(data.renameActRows) ? data.renameActRows : [],
    executionPolicy: normalizeContractExecutionPolicy(data.executionPolicy || {}, data),
  };
  state.contracts.push(contract);
  return contract;
}

/** Update a contract by id */
export function updateContract(id, data) {
  const c = state.contracts.find(ct => ct.id === id);
  if (!c) return null;
  if (data.title     !== undefined) c.title     = data.title;
  if (data.number    !== undefined) c.number    = data.number;
  if (data.lotNumber !== undefined) c.lotNumber = data.lotNumber;
  if (data.lotId     !== undefined) c.lotId     = data.lotId;
  if (data.date      !== undefined) c.date      = data.date;
  if (data.supplierId !== undefined) c.supplierId = data.supplierId;
  if (data.totalPrice !== undefined) c.totalPrice = data.totalPrice;
  if (data.advancePct !== undefined) c.advancePct = data.advancePct;
  if (data.programs  !== undefined) c.programs  = data.programs;
  if (data.items     !== undefined) c.items     = data.items;
  if (data.renameActRows !== undefined) c.renameActRows = data.renameActRows;
  if (data.executionPolicy !== undefined) c.executionPolicy = normalizeContractExecutionPolicy(data.executionPolicy, c);
  else c.executionPolicy = normalizeContractExecutionPolicy(c.executionPolicy, c);
  return c;
}

/** Delete a contract by id */
export function deleteContract(id) {
  const idx = state.contracts.findIndex(ct => ct.id === id);
  if (idx === -1) return false;
  state.contracts.splice(idx, 1);
  (state.lots || []).forEach((lot) => {
    if (String(lot.contractId) !== String(id)) return;
    lot.contractId = null;
    lot.contractNumber = '';
  });
  return true;
}

/** Get contract by id */
export function getContractById(id) {
  return state.contracts.find(ct => ct.id === id) || null;
}

// ─── Contract execution / payment policy ─────────────────────────

const DEFAULT_CONTRACT_EXECUTION_POLICY = Object.freeze({
  usesReadiness: false,
  allowWarehouseRoute: true,
  allowDirectRoute: true,
  routeWhenReady: 'direct',
  routeWhenNotReady: 'warehouse',
  scenarioWhenReady: 'full',
  scenarioWhenNotReady: 'split',
  stage1Percent: 70,
  stage2Percent: 30,
  requireNotReadyAct: true,
  requireReadyAct: true,
  hasAdvance: false,
  advancePercent: 0,
  advanceOffsetMode: 'sequential',
});

function roundMoneyValue(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function clampMoneyValue(value, min = 0, max = Infinity) {
  const normalized = roundMoneyValue(value);
  return Math.min(max, Math.max(min, normalized));
}

function normalizeExecutionRouteValue(value, fallback = 'direct') {
  return ['direct', 'warehouse', 'manual'].includes(value) ? value : fallback;
}

function normalizeExecutionScenarioValue(value, fallback = 'full') {
  return ['full', 'split'].includes(value) ? value : fallback;
}

function normalizeReadinessValue(value) {
  return ['ready', 'not_ready', 'not_applicable'].includes(value)
    ? value
    : 'not_applicable';
}

export function normalizeContractExecutionPolicy(policy = {}, contract = null) {
  const fallbackAdvance = Number(contract?.advancePct) || 0;
  const next = {
    ...DEFAULT_CONTRACT_EXECUTION_POLICY,
    ...(policy && typeof policy === 'object' ? policy : {}),
  };

  next.usesReadiness = Boolean(next.usesReadiness);
  next.allowWarehouseRoute = next.allowWarehouseRoute !== false;
  next.allowDirectRoute = next.allowDirectRoute !== false;
  next.routeWhenReady = normalizeExecutionRouteValue(next.routeWhenReady, 'direct');
  next.routeWhenNotReady = normalizeExecutionRouteValue(next.routeWhenNotReady, 'warehouse');
  next.scenarioWhenReady = normalizeExecutionScenarioValue(next.scenarioWhenReady, 'full');
  next.scenarioWhenNotReady = normalizeExecutionScenarioValue(next.scenarioWhenNotReady, 'split');
  next.stage1Percent = Math.max(0, Math.min(100, Number(next.stage1Percent) || 0));
  next.stage2Percent = Math.max(0, Math.min(100, Number(next.stage2Percent) || 0));
  if (!next.stage1Percent && !next.stage2Percent) {
    next.stage1Percent = DEFAULT_CONTRACT_EXECUTION_POLICY.stage1Percent;
    next.stage2Percent = DEFAULT_CONTRACT_EXECUTION_POLICY.stage2Percent;
  }
  next.requireNotReadyAct = Boolean(next.requireNotReadyAct);
  next.requireReadyAct = Boolean(next.requireReadyAct);
  next.hasAdvance = Boolean(next.hasAdvance || fallbackAdvance > 0);
  next.advancePercent = Math.max(0, Number(next.advancePercent ?? fallbackAdvance) || 0);
  next.advanceOffsetMode = ['sequential', 'proportional', 'manual'].includes(next.advanceOffsetMode)
    ? next.advanceOffsetMode
    : 'sequential';

  return next;
}

export function getContractExecutionPolicy(contract) {
  return normalizeContractExecutionPolicy(contract?.executionPolicy || {}, contract);
}

export function getContractAdvanceAmount(contract, totalAmount = null) {
  const policy = getContractExecutionPolicy(contract);
  if (!policy.hasAdvance || policy.advancePercent <= 0) return 0;
  const base = totalAmount == null ? Number(contract?.totalPrice) || 0 : Number(totalAmount) || 0;
  if (base <= 0) return 0;
  return Math.round((base * policy.advancePercent) * 100) / 10000;
}

function buildSequentialStageOffsets(stageAmounts = [], advanceAmount = 0) {
  let remaining = roundMoneyValue(advanceAmount);
  return stageAmounts.map((amount) => {
    const normalizedAmount = roundMoneyValue(amount);
    const offset = clampMoneyValue(Math.min(normalizedAmount, remaining), 0, normalizedAmount);
    remaining = clampMoneyValue(remaining - offset, 0);
    return offset;
  });
}

function buildProportionalStageOffsets(stageAmounts = [], advancePercent = 0) {
  const normalizedPercent = Math.max(0, Number(advancePercent) || 0);
  return stageAmounts.map((amount) => {
    const normalizedAmount = roundMoneyValue(amount);
    return clampMoneyValue(normalizedAmount * normalizedPercent / 100, 0, normalizedAmount);
  });
}

function buildManualStageOffsets(stageAmounts = [], manualOffsets = {}) {
  const stage1 = clampMoneyValue(manualOffsets?.stage1, 0, roundMoneyValue(stageAmounts[0] || 0));
  const stage2 = clampMoneyValue(manualOffsets?.stage2, 0, roundMoneyValue(stageAmounts[1] || 0));
  return stageAmounts.map((amount, index) => {
    const normalizedAmount = roundMoneyValue(amount);
    if (index === 0) return clampMoneyValue(stage1, 0, normalizedAmount);
    if (index === 1) return clampMoneyValue(stage2, 0, normalizedAmount);
    return 0;
  });
}

export function buildOrderExecutionScenario(contract, orderData = {}) {
  const policy = getContractExecutionPolicy(contract);
  const route = orderData?.deliveryMode === 'warehouse' ? 'warehouse' : 'direct';
  const readinessState = policy.usesReadiness
    ? normalizeReadinessValue(orderData?.readinessState)
    : 'not_applicable';

  const recommendedRoute = !policy.usesReadiness
    ? 'manual'
    : (readinessState === 'not_ready'
      ? policy.routeWhenNotReady
      : readinessState === 'ready'
        ? policy.routeWhenReady
        : 'manual');

  const scenarioType = !policy.usesReadiness
    ? normalizeExecutionScenarioValue(
        route === 'warehouse' ? policy.scenarioWhenNotReady : policy.scenarioWhenReady,
        'full',
      )
    : (readinessState === 'not_ready'
      ? policy.scenarioWhenNotReady
      : readinessState === 'ready'
        ? policy.scenarioWhenReady
        : 'full');

  const stage1Percent = scenarioType === 'split'
    ? Math.max(0, Math.min(100, Number(policy.stage1Percent) || 0))
    : 100;
  const stage2Percent = scenarioType === 'split'
    ? Math.max(0, Math.min(100, Number(policy.stage2Percent) || (100 - stage1Percent)))
    : 0;

  const needsNotReadyAct = Boolean(
    policy.usesReadiness
    && readinessState === 'not_ready'
    && policy.requireNotReadyAct
  );
  const needsReadyAct = Boolean(
    policy.usesReadiness
    && readinessState === 'not_ready'
    && scenarioType === 'split'
    && policy.requireReadyAct
  );

  let code = 'direct_full';
  if (route === 'warehouse' && scenarioType === 'split') code = 'warehouse_split';
  else if (route === 'warehouse' && scenarioType === 'full') code = 'warehouse_full';
  else if (route === 'direct' && scenarioType === 'split') code = 'direct_split';

  return {
    code,
    route,
    readinessState,
    recommendedRoute,
    routeMatchesRecommendation: recommendedRoute === 'manual' || recommendedRoute === route,
    scenarioType,
    stage1Percent,
    stage2Percent,
    needsNotReadyAct,
    needsReadyAct,
    hasAdvance: policy.hasAdvance,
    advancePercent: policy.advancePercent,
    advanceOffsetMode: policy.advanceOffsetMode,
  };
}

export function buildOrderPaymentPlan(contract, orderData = {}, manualAdvanceOffsets = {}) {
  const scenario = buildOrderExecutionScenario(contract, orderData);
  const policy = getContractExecutionPolicy(contract);
  const totalAmount = roundMoneyValue(orderData?.totalAmount);
  const stage1Amount = scenario.scenarioType === 'split'
    ? roundMoneyValue(totalAmount * (Number(scenario.stage1Percent) || 0) / 100)
    : totalAmount;
  const stage2Amount = scenario.scenarioType === 'split'
    ? roundMoneyValue(totalAmount * (Number(scenario.stage2Percent) || 0) / 100)
    : 0;
  const stageAmounts = [stage1Amount, stage2Amount];
  const advanceAmount = getContractAdvanceAmount(contract, totalAmount);

  let stageOffsets = [0, 0];
  if (policy.hasAdvance && advanceAmount > 0) {
    if (policy.advanceOffsetMode === 'manual') {
      stageOffsets = buildManualStageOffsets(stageAmounts, manualAdvanceOffsets);
    } else if (policy.advanceOffsetMode === 'proportional') {
      stageOffsets = buildProportionalStageOffsets(stageAmounts, policy.advancePercent);
    } else {
      stageOffsets = buildSequentialStageOffsets(stageAmounts, advanceAmount);
    }
  }

  const stage1Offset = clampMoneyValue(stageOffsets[0], 0, stage1Amount);
  const stage2Offset = clampMoneyValue(stageOffsets[1], 0, stage2Amount);
  const stage1Payable = clampMoneyValue(stage1Amount - stage1Offset, 0, stage1Amount);
  const stage2Payable = clampMoneyValue(stage2Amount - stage2Offset, 0, stage2Amount);
  const allocatedAdvance = roundMoneyValue(stage1Offset + stage2Offset);
  const unallocatedAdvance = clampMoneyValue(advanceAmount - allocatedAdvance, 0);

  return {
    scenario,
    policy,
    total: totalAmount,
    advanceAmount,
    advanceOffsetMode: policy.advanceOffsetMode,
    stage1Percent: Number(scenario.stage1Percent) || (scenario.scenarioType === 'split' ? 0 : 100),
    stage2Percent: Number(scenario.stage2Percent) || 0,
    stage1Amount,
    stage2Amount,
    stage1Offset,
    stage2Offset,
    stage1Payable,
    stage2Payable,
    allocatedAdvance,
    unallocatedAdvance,
    manualAdvanceOffsets: {
      stage1: clampMoneyValue(manualAdvanceOffsets?.stage1, 0, stage1Amount),
      stage2: clampMoneyValue(manualAdvanceOffsets?.stage2, 0, stage2Amount),
    },
  };
}

/**
 * Returns unique lot numbers for a product across all contracts.
 * Matching priority: contract item.productRef === productId, fallback by item name.
 */
export function getLotNumbersForProduct(productId, productName = '') {
  const nameLow = String(productName || '').trim().toLowerCase();
  const seen = new Set();
  const lots = [];

  for (const contract of (state.contracts || [])) {
    const lot = String(contract?.lotNumber || '').trim();
    if (!lot) continue;

    const hasProduct = (contract.items || []).some(item => {
      if (productId && item.productRef === productId) return true;
      if (!productId && nameLow) {
        return String(item.name || '').trim().toLowerCase() === nameLow;
      }
      if (productId && nameLow && !item.productRef) {
        return String(item.name || '').trim().toLowerCase() === nameLow;
      }
      return false;
    });

    if (!hasProduct) continue;
    const key = lot.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    lots.push(lot);
  }

  return lots.sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Returns unique contract item base codes for a product.
 * Code belongs to the contract item, not to the catalog product.
 */
export function getContractItemCodesForProduct(productId, productName = '') {
  const nameLow = String(productName || '').trim().toLowerCase();
  const seen = new Set();
  const codes = [];

  for (const contract of (state.contracts || [])) {
    for (const item of (contract.items || [])) {
      const itemCode = String(item?.code || '').trim();
      if (!itemCode) continue;

      const matchById = productId && item?.productRef === productId;
      const matchByName = !matchById && nameLow && String(item?.name || '').trim().toLowerCase() === nameLow;
      if (!matchById && !matchByName) continue;

      const key = itemCode.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      codes.push(itemCode);
    }
  }

  return codes.sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Returns unique full variant codes for a product color based on contract item codes.
 * Example: 987/6543 + 123-45-67 => 987/6543-123-45-67
 */
export function getFullVariantCodesForProduct(productId, productName = '', colorCode = '') {
  const normalizedColor = normalizeColorCode(colorCode);
  if (!normalizedColor) return [];
  const baseCodes = getContractItemCodesForProduct(productId, productName);
  return baseCodes
    .map(code => buildProductFullCode(code, normalizedColor))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'ru'));
}

/**
 * Finds catalog product + color variant by full contract item code.
 * Example: 987/6543-123-45-67 → product + variant with colorCode 123-45-67.
 */
export function resolveProductVariantByContractCode(contractCode = '', fallbackProductName = '') {
  const normalizedCode = String(contractCode || '').trim().toLowerCase();
  const nameLow = String(fallbackProductName || '').trim().toLowerCase();
  if (!normalizedCode && !nameLow) return null;

  const candidateProducts = (state.products || []).filter((product) => {
    if (!hasProductColorVariants(product)) return false;
    if (!nameLow) return true;
    return String(product.name || '').trim().toLowerCase() === nameLow;
  });

  for (const product of candidateProducts) {
    for (const variant of getProductColorVariants(product)) {
      const fullCodes = getFullVariantCodesForProduct(product.id, product.name, variant.colorCode);
      const matchedCode = fullCodes.find(code => String(code || '').trim().toLowerCase() === normalizedCode);
      if (!matchedCode) continue;
      return {
        product,
        productId: product.id,
        productName: product.name || '',
        variantId: variant.id,
        colorCode: variant.colorCode,
        fullCode: matchedCode,
      };
    }
  }

  return null;
}

/**
 * Returns need metrics for a recipient, optionally narrowed to a color variant.
 * For color variants qty/delivered/assembled are returned only for the matched sub-row.
 */
export function getRecipientNeedMetrics(recipient, {
  productId = null,
  productName = '',
  contractCode = '',
  variantId = '',
  colorCode = '',
  address = '',
} = {}) {
  const fallback = { qty: 0, delivered: 0, assembled: 0, productId: null, variantId: '', colorCode: '' };
  if (!recipient) return fallback;

  let resolvedProduct = productId ? getProductById(productId) : null;
  let resolvedVariantId = normalizeVariantId(variantId || colorCode);
  let resolvedColorCode = normalizeColorCode(colorCode);

  if ((!resolvedProduct || !resolvedVariantId) && contractCode) {
    const variantMeta = resolveProductVariantByContractCode(contractCode, productName);
    if (variantMeta) {
      if (!resolvedProduct) resolvedProduct = variantMeta.product;
      if (!resolvedVariantId) resolvedVariantId = normalizeVariantId(variantMeta.variantId || variantMeta.colorCode);
      if (!resolvedColorCode) resolvedColorCode = normalizeColorCode(variantMeta.colorCode);
    }
  }

  if (!resolvedProduct && productName) {
    const fallbackName = String(productName || '').trim().toLowerCase();
    resolvedProduct = (state.products || []).find(product => String(product.name || '').trim().toLowerCase() === fallbackName) || null;
  }

  if (!resolvedProduct) return fallback;

  const addressKey = normalizeRecipientAddressNeedKey(address);
  const addressNeeds = getRecipientAddressNeedsMapSafe(recipient);
  const addressEntry = addressKey
    ? addressNeeds[addressKey]?.needs?.[resolvedProduct.id]
    : null;
  const recipientAddresses = getRecipientAddresses(recipient);
  const hasAnyAddressProductData = Object.values(addressNeeds).some((entry) => {
    const productNeeds = entry?.needs && typeof entry.needs === 'object' ? entry.needs : null;
    return !!(productNeeds && productNeeds[resolvedProduct.id]);
  });
  const isFirstAddressFallback = Boolean(
    addressKey
    && recipientAddresses.length > 1
    && !addressEntry
    && !hasAnyAddressProductData
    && normalizeRecipientAddressNeedKey(recipientAddresses[0] || '') === addressKey
  );
  const shouldUseAggregateFallback = !addressKey || recipientAddresses.length <= 1;
  const entry = normalizeNeedEntry(
    addressEntry ?? ((shouldUseAggregateFallback || isFirstAddressFallback) ? recipient?.needs?.[resolvedProduct.id] : null),
    resolvedProduct,
  );
  const isMultiColor = hasProductColorVariants(resolvedProduct);
  const hasVariants = Boolean(entry?.variants && typeof entry.variants === 'object');

  if (!resolvedVariantId || !hasVariants) {
    if (isMultiColor && resolvedVariantId) {
      return {
        qty: 0,
        delivered: 0,
        assembled: 0,
        productId: resolvedProduct.id,
        variantId: resolvedVariantId,
        colorCode: resolvedColorCode,
      };
    }

    if (isMultiColor && !hasVariants) {
      return {
        qty: 0,
        delivered: 0,
        assembled: 0,
        productId: resolvedProduct.id,
        variantId: '',
        colorCode: '',
      };
    }

    return {
      qty: Number(entry?.qty) || 0,
      delivered: Number(entry?.delivered) || 0,
      assembled: Number(entry?.assembled) || 0,
      productId: resolvedProduct.id,
      variantId: '',
      colorCode: '',
    };
  }

  const variants = Object.values(entry.variants || {});
  const variantEntry = variants.find((variant) => {
    const key = normalizeVariantId(variant?.id || variant?.colorCode);
    return key === resolvedVariantId;
  }) || null;

  if (!variantEntry) {
    return {
      qty: 0,
      delivered: 0,
      assembled: 0,
      productId: resolvedProduct.id,
      variantId: resolvedVariantId,
      colorCode: resolvedColorCode,
    };
  }

  return {
    qty: Number(variantEntry.qty) || 0,
    delivered: Number(variantEntry.delivered) || 0,
    assembled: Number(variantEntry.assembled) || 0,
    productId: resolvedProduct.id,
    variantId: normalizeVariantId(variantEntry.id || variantEntry.colorCode),
    colorCode: normalizeColorCode(variantEntry.colorCode),
  };
}

function normalizeDeliveryText(value) {
  return String(value || '').trim().toLowerCase();
}

function parseOrderIdFromShipmentRow(row) {
  if (row?.orderId != null && row.orderId !== '') return Number(row.orderId) || null;
  if (!row?.orderKey) return null;
  const parts = String(row.orderKey).split('::');
  if (parts.length !== 2 || parts[1] === 'noorder') return null;
  const parsed = Number(parts[1]);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function resolveShipmentRowSupplierMeta(row) {
  if (!row) return { supplierId: null, supplierName: '' };

  if (row.supplierId != null) {
    const supplier = (state.suppliers || []).find(s => String(s.id) === String(row.supplierId));
    if (supplier) return { supplierId: supplier.id, supplierName: supplier.name || '' };
  }

  const directName = String(row.supplierName || '').trim();
  if (directName) return { supplierId: row.supplierId ?? null, supplierName: directName };

  const orderId = parseOrderIdFromShipmentRow(row);
  const order = orderId != null ? (state.orders || []).find(o => String(o.id) === String(orderId)) : null;
  const contractId = row.contractId ?? order?.contractId ?? null;
  const contract = contractId != null ? (state.contracts || []).find(c => String(c.id) === String(contractId)) : null;
  const supplierId = contract?.supplierId ?? null;
  const supplier = supplierId != null ? (state.suppliers || []).find(s => String(s.id) === String(supplierId)) : null;

  return {
    supplierId,
    supplierName: supplier?.name || '',
  };
}

export function getSupplierDeliveryChannels(supplierId, supplierName = '') {
  const targetId = supplierId != null ? String(supplierId) : '';
  const targetName = normalizeDeliveryText(supplierName);
  let warehouse = false;
  let direct = false;

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      const meta = resolveShipmentRowSupplierMeta(row);
      const matches = (targetId && meta.supplierId != null && String(meta.supplierId) === targetId)
        || (!targetId && targetName && normalizeDeliveryText(meta.supplierName) === targetName)
        || (targetId && targetName && normalizeDeliveryText(meta.supplierName) === targetName);
      if (matches) {
        warehouse = true;
        break;
      }
    }
    if (warehouse && direct) break;
  }

  for (const delivery of (state.directDeliveries || [])) {
    const matches = (targetId && delivery.supplierId != null && String(delivery.supplierId) === targetId)
      || (!targetId && targetName && normalizeDeliveryText(delivery.supplierName) === targetName)
      || (targetId && targetName && normalizeDeliveryText(delivery.supplierName) === targetName);
    if (matches) {
      direct = true;
      break;
    }
  }

  return { warehouse, direct };
}

export function getContractDeliveryChannels(contractId) {
  const targetId = String(contractId);
  let warehouse = false;
  let direct = false;

  for (const order of (state.orders || [])) {
    if (String(order.contractId) !== targetId) continue;
    if (order.deliveryMode === 'direct') direct = true;
    else warehouse = true;
    if (warehouse && direct) break;
  }

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      const orderId = parseOrderIdFromShipmentRow(row);
      const order = orderId != null ? (state.orders || []).find(o => String(o.id) === String(orderId)) : null;
      const rowContractId = row.contractId ?? order?.contractId ?? null;
      if (rowContractId != null && String(rowContractId) === targetId) {
        warehouse = true;
        break;
      }
    }
    if (warehouse && direct) break;
  }

  if (!direct) {
    direct = (state.directDeliveries || []).some(delivery => String(delivery.contractId) === targetId);
  }

  return { warehouse, direct };
}

export function getRecipientDeliveryChannels(recipientId) {
  const targetId = String(recipientId);
  let warehouse = false;
  let direct = false;

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      if ((row.recipients || []).some(rec => String(rec.recipientId) === targetId && (Number(rec.qty) || 0) > 0)) {
        warehouse = true;
        break;
      }
    }
    if (warehouse && direct) break;
  }

  if (!direct) {
    direct = (state.directDeliveries || []).some(delivery =>
      (delivery.rows || []).some(row => String(row.recipientId) === targetId && (Number(row.actualQty) || 0) > 0)
    );
  }

  return { warehouse, direct };
}

/**
 * Возвращает все варианты «наименования по спецификации» для товара,
 * сгруппированные по контрактам/лотам. Значения тянутся из модуля контрактов.
 */
export function getProductSpecificationMappings(productId, productName = '') {
  const nameLow = String(productName || '').trim().toLowerCase();
  const result = [];

  for (const contract of (state.contracts || [])) {
    const contractNumber = String(contract?.number || '').trim();
    const contractTitle = String(contract?.title || '').trim();
    const lotNumber = String(contract?.lotNumber || '').trim();

    for (const item of (contract.items || [])) {
      const itemNameLow = String(item?.name || '').trim().toLowerCase();
      const matches = (productId && item?.productRef === productId)
        || (!productId && nameLow && itemNameLow === nameLow)
        || (productId && nameLow && !item?.productRef && itemNameLow === nameLow);

      if (!matches) continue;

      const specificationName = String(item?.specificationName || '').trim();
      if (!specificationName) continue;

      result.push({
        contractId: contract.id,
        contractNumber,
        contractTitle,
        lotNumber,
        itemId: item.itemId || null,
        productName: String(item?.name || '').trim(),
        specificationName,
        price: Number(item?.price) || 0,
        code: String(item?.code || '').trim(),
      });
    }
  }

  return result.sort((a, b) => {
    const lotCmp = String(a.lotNumber || '').localeCompare(String(b.lotNumber || ''), 'ru');
    if (lotCmp !== 0) return lotCmp;
    const numberCmp = String(a.contractNumber || '').localeCompare(String(b.contractNumber || ''), 'ru');
    if (numberCmp !== 0) return numberCmp;
    return String(a.specificationName || '').localeCompare(String(b.specificationName || ''), 'ru');
  });
}

/**
 * Sync contract items with catalog:
 * - removes items for deleted products
 * - adds missing products (qty=0, price=0)
 * - sorts by product number
 */
export function syncContractItems(contract) {
  const existingMap = new Map(contract.items.map(i => [i.productId, i]));
  const productIds = new Set(state.products.map(p => p.id));

  // Remove items for deleted products
  contract.items = contract.items.filter(i => productIds.has(i.productId));

  // Add missing products
  for (const p of state.products) {
    if (!existingMap.has(p.id)) {
      contract.items.push({
        productId: p.id,
        price: 0,
        qty: 0,
        ordered: 0,
        delivered: 0,
        paidAdvance: 0,
        paid50: 0,
        paid30: 0,
        receiving: {},
      });
    }
  }

  // Sort by product number
  contract.items.sort((a, b) => {
    const pa = state.products.find(p => p.id === a.productId);
    const pb = state.products.find(p => p.id === b.productId);
    return ((pa?.number || 0) - (pb?.number || 0));
  });
}

// ─── Finance Programs ─────────────────────────────────────────────

/** Get all finance programs */
export function getPrograms() {
  return state.programs;
}

/** Get program names as string array (for dropdowns) */
export function getProgramNames() {
  return state.programs.map(p => p.name).filter(Boolean);
}

/** Add a finance program */
export function addProgram(data) {
  const program = {
    id: state.nextProgramId++,
    name: data.name || '',
    code: data.code || '',
    kbk: data.kbk || '',
    limit: data.limit || 0,
  };
  state.programs.push(program);
  return program;
}

/** Update a finance program */
export function updateProgram(id, data) {
  const p = state.programs.find(pr => pr.id === id);
  if (!p) return null;
  if (data.name  !== undefined) p.name  = data.name;
  if (data.code  !== undefined) p.code  = data.code;
  if (data.kbk   !== undefined) p.kbk   = data.kbk;
  if (data.limit !== undefined) p.limit = data.limit;
  return p;
}

/** Delete a finance program */
export function deleteProgram(id) {
  const idx = state.programs.findIndex(p => p.id === id);
  if (idx === -1) return false;
  state.programs.splice(idx, 1);
  return true;
}

// ─── Receiving ────────────────────────────────────────────────────

/**
 * Update receiving data for a specific item in a contract.
 * @param {number} contractId
 * @param {number} productId
 * @param {object} receivingData
 */
export function updateReceivingItem(contractId, productId, receivingData) {
  const contract = state.contracts.find(c => c.id === contractId);
  if (!contract) return null;
  const item = contract.items.find(i => i.productId === productId);
  if (!item) return null;
  item.receiving = { ...(item.receiving || {}), ...receivingData };
  return item;
}

// ─── Commission (Приёмочная комиссия) ─────────────────────────────

/** Get all commission members */
export function getCommission() {
  return state.commission;
}

/** Add a commission member */
export function addCommissionMember(role, name) {
  const member = {
    id: state.nextCommissionId++,
    role: role || '',
    name: name || '',
  };
  state.commission.push(member);
  return member;
}

/** Update a commission member */
export function updateCommissionMember(id, role, name) {
  const m = state.commission.find(c => c.id === id);
  if (!m) return null;
  m.role = role ?? m.role;
  m.name = name ?? m.name;
  return m;
}

/** Remove a commission member */
export function removeCommissionMember(id) {
  const idx = state.commission.findIndex(c => c.id === id);
  if (idx === -1) return false;
  state.commission.splice(idx, 1);
  return true;
}

// ─── Invited Experts (Приглашённые эксперты) ─────────────────────

/** Get all invited experts */
export function getInvitedExperts() {
  return state.invitedExperts;
}

/** Add an invited expert */
export function addInvitedExpert(role, organization, name) {
  const expert = {
    id: state.nextInvitedExpertId++,
    role: role || '',
    organization: organization || '',
    name: name || '',
  };
  state.invitedExperts.push(expert);
  return expert;
}

/** Update an invited expert */
export function updateInvitedExpert(id, role, organization, name) {
  const expert = state.invitedExperts.find(item => item.id === id);
  if (!expert) return null;
  expert.role = role ?? expert.role;
  expert.organization = organization ?? expert.organization;
  expert.name = name ?? expert.name;
  return expert;
}

/** Remove an invited expert */
export function removeInvitedExpert(id) {
  const idx = state.invitedExperts.findIndex(item => item.id === id);
  if (idx === -1) return false;
  state.invitedExperts.splice(idx, 1);
  return true;
}

// ─── Inspection Schedule (График проверок) ───────────────────────

/** Get all inspection schedule entries */
export function getInspectionSchedules() {
  return state.inspectionSchedules || [];
}

/** Get one inspection schedule entry by id */
export function getInspectionScheduleById(id) {
  return (state.inspectionSchedules || []).find(item => String(item.id) === String(id)) || null;
}

/** Add inspection schedule entry */
export function addInspectionSchedule(data = {}) {
  const entry = {
    id: state.nextInspectionScheduleId++,
    date: data.date || '',
    time: data.time || '',
    supplierId: data.supplierId ?? null,
    supplierName: data.supplierName || '',
    contractId: data.contractId ?? null,
    contractDate: data.contractDate || '',
    contractNumber: data.contractNumber || '',
    contractTitle: data.contractTitle || '',
    recipientId: data.recipientId ?? null,
    recipientName: data.recipientName || '',
    address: data.address || '',
    expertId: data.expertId ?? null,
    expertName: data.expertName || '',
    expertIds: Array.isArray(data.expertIds) ? data.expertIds.map(id => Number(id) || 0).filter(Boolean) : [],
    expertNames: Array.isArray(data.expertNames) ? data.expertNames.map(name => String(name || '').trim()).filter(Boolean) : [],
    recipientRepresentative: data.recipientRepresentative || '',
    supplierNoticeDate: data.supplierNoticeDate || '',
    supplierNoticeNumber: data.supplierNoticeNumber || '',
    note: data.note || '',
    contractOwner: data.contractOwner || '',
    acceptanceStatus: data.acceptanceStatus || '',
    correctionDeadline: data.correctionDeadline || '',
    shortResult: data.shortResult || '',
    incorrectTz: data.incorrectTz || '',
    linkedActId: data.linkedActId ?? null,
    createdAt: new Date().toISOString(),
  };
  state.inspectionSchedules.push(entry);
  return entry;
}

/** Update inspection schedule entry */
export function updateInspectionSchedule(id, data = {}) {
  const entry = getInspectionScheduleById(id);
  if (!entry) return null;
  Object.assign(entry, data, { id: entry.id, updatedAt: new Date().toISOString() });
  return entry;
}

/** Delete inspection schedule entry */
export function deleteInspectionSchedule(id) {
  const idx = (state.inspectionSchedules || []).findIndex(item => String(item.id) === String(id));
  if (idx === -1) return false;
  state.inspectionSchedules.splice(idx, 1);
  return true;
}

// ─── Acts Registry ────────────────────────────────────────────────

/** Get all saved acts */
export function getActs() {
  return state.acts;
}

/** Save a new act */
export function saveAct(actData) {
  const act = {
    id: state.nextActId++,
    ...actData,
    savedAt: new Date().toISOString(),
  };
  state.acts.push(act);
  return act;
}

/** Update an existing act by id */
export function updateAct(id, actData) {
  const idx = state.acts.findIndex(a => a.id === id);
  if (idx === -1) return null;
  state.acts[idx] = {
    ...state.acts[idx],
    ...actData,
    id,
    updatedAt: new Date().toISOString(),
  };
  return state.acts[idx];
}

/** Delete an act by id */
export function deleteAct(id) {
  const idx = state.acts.findIndex(a => a.id === id);
  if (idx === -1) return false;
  state.acts.splice(idx, 1);
  return true;
}

// ─── Primary Documents Registry ──────────────────────────────────

/** Get all saved primary documents */
export function getPrimaryDocs() {
  return state.primaryDocs || [];
}

/** Get one saved primary document by id */
export function getPrimaryDocById(id) {
  return (state.primaryDocs || []).find(d => String(d.id) === String(id)) || null;
}

/** Save a new recognized primary document */
export function savePrimaryDoc(docData) {
  const doc = {
    ...docData,
    id: state.nextPrimaryDocId++,
    savedAt: new Date().toISOString(),
  };
  state.primaryDocs.push(doc);
  return doc;
}

/** Update an existing primary document */
export function updatePrimaryDoc(id, docData) {
  const list = state.primaryDocs || [];
  const idx = list.findIndex(d => String(d.id) === String(id));
  if (idx === -1) return null;
  const stableId = list[idx].id;
  list[idx] = {
    ...list[idx],
    ...docData,
    id: stableId,
    updatedAt: new Date().toISOString(),
  };
  return list[idx];
}

/** Delete a saved primary document */
export function deletePrimaryDoc(id) {
  const list = state.primaryDocs || [];
  let idx = list.findIndex(d => String(d.id) === String(id));
  if (idx === -1) {
    const numericId = Number(id);
    if (Number.isFinite(numericId)) {
      idx = list.findIndex(d => Number(d.id) === numericId);
    }
  }
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

// ─── Claims Registry ─────────────────────────────────────────────

/** Get all saved claims */
export function getClaims() {
  return state.claims || [];
}

/** Get one saved claim by id */
export function getClaimById(id) {
  return (state.claims || []).find(claim => String(claim.id) === String(id)) || null;
}

/** Save a new contract claim */
export function saveClaim(claimData) {
  const claim = {
    id: state.nextClaimId++,
    ...claimData,
    savedAt: new Date().toISOString(),
  };
  state.claims.push(claim);
  return claim;
}

/** Update an existing contract claim */
export function updateClaim(id, claimData) {
  const list = state.claims || [];
  const idx = list.findIndex(claim => String(claim.id) === String(id));
  if (idx === -1) return null;
  list[idx] = {
    ...list[idx],
    ...claimData,
    id: list[idx].id,
    updatedAt: new Date().toISOString(),
  };
  return list[idx];
}

/** Delete a saved claim */
export function deleteClaim(id) {
  const list = state.claims || [];
  const idx = list.findIndex(claim => String(claim.id) === String(id));
  if (idx === -1) return false;
  list.splice(idx, 1);
  return true;
}

// ─── Lotting (Лотирование) ──────────────────────────────────────

function resolveLotRecipientId(rawValue) {
  if (rawValue == null || rawValue === '') return null;

  if (typeof rawValue === 'number') {
    return Number.isFinite(rawValue) && rawValue > 0 ? rawValue : null;
  }

  if (typeof rawValue === 'string') {
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    const numeric = Number(trimmed);
    if (Number.isFinite(numeric) && numeric > 0) return numeric;

    const byName = (state.recipients || []).find((recipient) =>
      String(recipient?.name || '').trim().toLowerCase() === trimmed.toLowerCase()
    );
    return byName ? Number(byName.id) || null : null;
  }

  if (typeof rawValue === 'object') {
    const directId = Number(
      rawValue.id
      ?? rawValue.recipientId
      ?? rawValue.value
      ?? rawValue.key
      ?? 0
    ) || 0;
    if (directId > 0) return directId;

    const name = String(
      rawValue.name
      ?? rawValue.recipientName
      ?? rawValue.label
      ?? rawValue.title
      ?? ''
    ).trim();
    if (!name) return null;

    const byName = (state.recipients || []).find((recipient) =>
      String(recipient?.name || '').trim().toLowerCase() === name.toLowerCase()
    );
    return byName ? Number(byName.id) || null : null;
  }

  return null;
}

function normalizeLotRecipientIds(recipientIds = []) {
  const seen = new Set();
  const result = [];
  (Array.isArray(recipientIds) ? recipientIds : []).forEach((value) => {
    const numeric = resolveLotRecipientId(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return;
    if (seen.has(numeric)) return;
    seen.add(numeric);
    result.push(numeric);
  });
  return result;
}

function normalizeLotItems(items = []) {
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const productId = Number(item?.productId) || Number(item?.productRef) || null;
      const qty = Number(item?.qty) || 0;
      const hasNmcd = item?.nmcd !== undefined && item?.nmcd !== null && item?.nmcd !== '';
      const nmcd = hasNmcd ? (Number(item?.nmcd) || 0) : 0;
      const product = productId != null ? getProductById(productId) : null;
      const productName = String(item?.productName || product?.name || '').trim();
      const productCode = String(item?.productCode || product?.code || '').trim();
      if ((!productId && !productName && !productCode) || qty <= 0) return null;
      return {
        productId,
        productName,
        productCode,
        qty,
        nmcd,
      };
    })
    .filter(Boolean);
}

export function getLots() {
  return state.lots || [];
}

export function getLotById(id) {
  return (state.lots || []).find((lot) => String(lot.id) === String(id)) || null;
}

export function findLotByNumber(lotNumber) {
  const normalized = String(lotNumber || '').trim().toLowerCase();
  if (!normalized) return null;
  return (state.lots || []).find((lot) => String(lot.lotNumber || '').trim().toLowerCase() === normalized) || null;
}

export function addLot(data = {}) {
  const lot = {
    id: state.nextLotId++,
    lotNumber: String(data.lotNumber || '').trim(),
    contractId: data.contractId ?? null,
    contractNumber: String(data.contractNumber || '').trim(),
    recipientIds: normalizeLotRecipientIds(data.recipientIds),
    items: normalizeLotItems(data.items),
    createdAt: new Date().toISOString(),
  };
  state.lots.push(lot);
  return lot;
}

export function updateLot(id, data = {}) {
  const lot = getLotById(id);
  if (!lot) return null;
  if (data.lotNumber !== undefined) lot.lotNumber = String(data.lotNumber || '').trim();
  if (data.contractId !== undefined) lot.contractId = data.contractId ?? null;
  if (data.contractNumber !== undefined) lot.contractNumber = String(data.contractNumber || '').trim();
  if (data.recipientIds !== undefined) lot.recipientIds = normalizeLotRecipientIds(data.recipientIds);
  if (data.items !== undefined) lot.items = normalizeLotItems(data.items);
  lot.updatedAt = new Date().toISOString();
  return lot;
}

export function deleteLot(id) {
  const idx = (state.lots || []).findIndex((lot) => String(lot.id) === String(id));
  if (idx === -1) return false;
  const removedLot = state.lots[idx];
  state.lots.splice(idx, 1);
  (state.contracts || []).forEach((contract) => {
    if (String(contract.lotId) !== String(id)) return;
    contract.lotId = null;
    if (String(contract.lotNumber || '').trim().toLowerCase() === String(removedLot?.lotNumber || '').trim().toLowerCase()) {
      contract.lotNumber = '';
    }
  });
  return true;
}

export function bindContractToLot(lotId, contractId, contractNumber = '') {
  const lot = getLotById(lotId);
  if (!lot) return null;
  lot.contractId = contractId ?? null;
  lot.contractNumber = String(contractNumber || '').trim();
  lot.updatedAt = new Date().toISOString();
  return lot;
}

export function clearContractBindingFromLots(contractId, exceptLotId = null) {
  let changed = 0;
  (state.lots || []).forEach((lot) => {
    if (String(lot.contractId) !== String(contractId)) return;
    if (exceptLotId != null && String(lot.id) === String(exceptLotId)) return;
    lot.contractId = null;
    lot.contractNumber = '';
    lot.updatedAt = new Date().toISOString();
    changed += 1;
  });
  return changed;
}

export function syncLotsWithContracts() {
  const lots = state.lots || [];
  const contracts = state.contracts || [];
  let changed = 0;

  const lotById = new Map();
  const lotByNumber = new Map();
  lots.forEach((lot) => {
    if (lot?.id != null) lotById.set(String(lot.id), lot);
    const numberKey = String(lot?.lotNumber || '').trim().toLowerCase();
    if (numberKey) lotByNumber.set(numberKey, lot);
    if (lot.contractId != null) {
      const linkedContract = contracts.find(contract => String(contract.id) === String(lot.contractId));
      if (!linkedContract) {
        lot.contractId = null;
        lot.contractNumber = '';
        changed += 1;
      }
    }
  });

  contracts.forEach((contract) => {
    let lot = null;
    if (contract?.lotId != null) {
      lot = lotById.get(String(contract.lotId)) || null;
    }
    if (!lot) {
      const lotNumberKey = String(contract?.lotNumber || '').trim().toLowerCase();
      if (lotNumberKey) lot = lotByNumber.get(lotNumberKey) || null;
    }

    if (!lot) {
      if (contract?.lotId != null) {
        contract.lotId = null;
        changed += 1;
      }
      return;
    }

    if (contract.lotId !== lot.id) {
      contract.lotId = lot.id;
      changed += 1;
    }
    if (!String(contract.lotNumber || '').trim() && lot.lotNumber) {
      contract.lotNumber = lot.lotNumber;
      changed += 1;
    }
    if (String(lot.contractId || '') !== String(contract.id)) {
      lot.contractId = contract.id;
      changed += 1;
    }
    const nextContractNumber = String(contract.number || '').trim();
    if (String(lot.contractNumber || '').trim() !== nextContractNumber) {
      lot.contractNumber = nextContractNumber;
      changed += 1;
    }
  });

  return changed;
}

function resolveContractItemProduct(item) {
  const productRef = Number(item?.productRef) || Number(item?.productId) || null;
  if (productRef) {
    const byId = getProductById(productRef);
    if (byId) return byId;
  }
  const code = String(item?.code || '').trim().toLowerCase();
  if (code) {
    const byCode = (state.products || []).find(product => String(product.code || '').trim().toLowerCase() === code);
    if (byCode) return byCode;
  }
  const name = String(item?.name || '').trim().toLowerCase();
  if (name) {
    return (state.products || []).find(product => String(product.name || '').trim().toLowerCase() === name) || null;
  }
  return null;
}

function collectRecipientIdsForContract(contractId, existingRecipientIds = []) {
  const ids = new Set(normalizeLotRecipientIds(existingRecipientIds));

  (state.orders || []).forEach((order) => {
    if (String(order?.contractId) !== String(contractId)) return;
    (order.deliveryRows || []).forEach((row) => {
      (row.recipients || []).forEach((recipient) => {
        const recipientId = Number(recipient?.recipientId) || 0;
        if (recipientId > 0) ids.add(recipientId);
      });
    });
  });

  (state.directDeliveries || []).forEach((delivery) => {
    if (String(delivery?.contractId) !== String(contractId)) return;
    (delivery.rows || []).forEach((row) => {
      const recipientId = Number(row?.recipientId) || 0;
      if (recipientId > 0) ids.add(recipientId);
    });
  });

  return [...ids];
}

function buildLotItemsFromContract(contract, existingLot = null) {
  const existingItems = Array.isArray(existingLot?.items) ? existingLot.items : [];

  return (contract?.items || [])
    .map((item) => {
      const product = resolveContractItemProduct(item);
      const productId = Number(item?.productRef) || product?.id || null;
      const productName = String(item?.name || product?.name || '').trim();
      const productCode = String(item?.code || product?.code || '').trim();
      const qty = Number(item?.qty) || 0;
      if ((!productId && !productName) || qty <= 0) return null;

      const existingItem = existingItems.find((lotItem) => {
        if (productId && Number(lotItem?.productId) === productId) return true;
        if (productCode && String(lotItem?.productCode || '').trim().toLowerCase() === productCode.toLowerCase()) return true;
        if (productName && String(lotItem?.productName || '').trim().toLowerCase() === productName.toLowerCase()) return true;
        return false;
      });

      const nmcd = existingItem?.nmcd != null && existingItem?.nmcd !== ''
        ? (Number(existingItem.nmcd) || 0)
        : 0;

      return { productId, productName, productCode, qty, nmcd };
    })
    .filter(Boolean);
}

export function syncLotsFromContractCards(contractIds = null, options = {}) {
  const allowedIds = contractIds == null
    ? null
    : new Set((Array.isArray(contractIds) ? contractIds : [contractIds]).map(id => String(id)));
  const forceUpdate = options?.forceUpdate === true;

  const stats = { created: 0, updated: 0, linked: 0, skipped: 0 };

  (state.contracts || []).forEach((contract) => {
    if (allowedIds && !allowedIds.has(String(contract?.id))) return;

    const lotNumber = String(contract?.lotNumber || '').trim();
    if (!lotNumber) {
      stats.skipped += 1;
      return;
    }

    const existingById = contract?.lotId != null ? getLotById(contract.lotId) : null;
    const existingByNumber = findLotByNumber(lotNumber);
    const existingLot = existingById || existingByNumber || null;
    const payload = {
      lotNumber,
      contractId: contract.id,
      contractNumber: String(contract.number || '').trim(),
      recipientIds: collectRecipientIdsForContract(contract.id, existingLot?.recipientIds || []),
      items: buildLotItemsFromContract(contract, existingLot),
    };

    let targetLot = existingLot;
    if (targetLot) {
      let lotChanged = false;
      if (forceUpdate) {
        updateLot(targetLot.id, payload);
        lotChanged = true;
      } else {
        if (!String(targetLot.lotNumber || '').trim()) {
          targetLot.lotNumber = payload.lotNumber;
          lotChanged = true;
        }
        if (!targetLot.contractId || String(targetLot.contractId) !== String(contract.id)) {
          targetLot.contractId = contract.id;
          lotChanged = true;
        }
        if (String(targetLot.contractNumber || '').trim() !== payload.contractNumber) {
          targetLot.contractNumber = payload.contractNumber;
          lotChanged = true;
        }
        if ((!Array.isArray(targetLot.recipientIds) || targetLot.recipientIds.length === 0) && payload.recipientIds.length) {
          targetLot.recipientIds = payload.recipientIds;
          lotChanged = true;
        }
        if ((!Array.isArray(targetLot.items) || targetLot.items.length === 0) && payload.items.length) {
          targetLot.items = payload.items;
          lotChanged = true;
        }
        if (lotChanged) targetLot.updatedAt = new Date().toISOString();
      }
      if (lotChanged) stats.updated += 1;
    } else {
      targetLot = addLot(payload);
      stats.created += 1;
    }

    if (contract.lotId !== targetLot.id) {
      contract.lotId = targetLot.id;
      stats.linked += 1;
    }
    if (!String(contract.lotNumber || '').trim()) {
      contract.lotNumber = targetLot.lotNumber || lotNumber;
    }

    clearContractBindingFromLots(contract.id, targetLot.id);
    bindContractToLot(targetLot.id, contract.id, String(contract.number || '').trim());
  });

  syncLotsWithContracts();
  return stats;
}

export function getRecipientNamesForLot(lot) {
  return normalizeLotRecipientIds(lot?.recipientIds)
    .map((recipientId) => getRecipientById(recipientId)?.name || '')
    .filter(Boolean);
}

// ─── Orders (Заявки) ─────────────────────────────────────────────

/** Generate order number: last 4 digits of contract number + seq + program code */
export function generateOrderNumber(contract, seqNum, programCode) {
  const contractNum = String(contract.number || '');
  const last4 = contractNum.replace(/\D/g, '').slice(-4).padStart(4, '0') || '0000';
  const seq = String(seqNum).padStart(2, '0');
  const code = programCode ? `-${programCode}` : '';
  return `${last4}-${seq}${code}`;
}

/** Get next sequence number for a contract */
export function getNextOrderSeq(contractId) {
  const existing = state.orders.filter(o => o.contractId === contractId);
  if (existing.length === 0) return 1;
  const maxSeq = existing.reduce((max, o) => Math.max(max, o.seqNum || 0), 0);
  return maxSeq + 1;
}

/** Add an order */
export function addOrder(data) {
  const order = { id: state.nextOrderId++, ...data, createdAt: new Date().toISOString() };
  state.orders.push(order);
  return order;
}

/** Update an order */
export function updateOrder(id, data) {
  const o = state.orders.find(x => x.id === id);
  if (!o) return null;
  Object.assign(o, data);
  return o;
}

/** Delete an order */
export function deleteOrder(id) {
  const idx = state.orders.findIndex(x => x.id === id);
  if (idx === -1) return false;
  state.orders.splice(idx, 1);
  return true;
}

// ─── Warehouse (Склад) ────────────────────────────────────────────

/**
 * Warehouse entry shape:
 * { id, productId, productCode, productName, supplierId, contractId, orderId,
 *   date, received, shipped, accepted, notes, createdAt }
 *
 * balance = received - shipped  (computed on read)
 * category: string — подтягивается из каталога по productId при сохранении
 * accepted: boolean — true = принято, false = не принято
 */

/** Compute balance for an entry */
export function warehouseBalance(entry) {
  return (entry.received || 0) - (entry.shipped || 0);
}

/** Get all warehouse entries (with computed balance) */
export function getWarehouseEntries() {
  return state.warehouseEntries.map(e => ({ ...e, balance: warehouseBalance(e) }));
}

/** Add a warehouse entry */
export function addWarehouseEntry(data) {
  const entry = {
    id: state.nextWarehouseEntryId++,
    productId:   data.productId   ?? null,
    productCode: data.productCode ?? '',
    productName: data.productName ?? '',
    category:    data.category    ?? '',
    supplierId:  data.supplierId  ?? null,
    contractId:  data.contractId  ?? null,
    orderId:     data.orderId     ?? null,
    date:        data.date        ?? '',
    received:    Number(data.received)  || 0,
    shipped:     Number(data.shipped)   || 0,
    accepted:    Boolean(data.accepted),
    notes:       data.notes       ?? '',
    items:       Array.isArray(data.items) ? data.items : [],
    createdAt:   new Date().toISOString(),
    warehouseId: data.warehouseId ?? null,
  };
  state.warehouseEntries.push(entry);
  return entry;
}

/** Update a warehouse entry */
export function updateWarehouseEntry(id, data) {
  const e = state.warehouseEntries.find(x => x.id === id);
  if (!e) return null;
  const fields = ['productId','productCode','productName','supplierId','contractId',
                  'orderId','date','received','shipped','accepted','notes','category',
                  'items'];
  fields.push('warehouseId');
  for (const f of fields) {
    if (data[f] !== undefined) e[f] = data[f];
  }
  if (data.received !== undefined) e.received = Number(data.received) || 0;
  if (data.shipped  !== undefined) e.shipped  = Number(data.shipped)  || 0;
  return e;
}

/** Delete a warehouse entry */
export function deleteWarehouseEntry(id) {
  const idx = state.warehouseEntries.findIndex(x => x.id === id);
  if (idx === -1) return false;
  state.warehouseEntries.splice(idx, 1);
  return true;
}

// ─── Warehouses (Склады) ──────────────────────────────────────────

/** Ensure default "Основной склад" exists and migrate old entries */
export function ensureDefaultWarehouse() {
  if (state.warehouses.length === 0) {
    const main = {
      id: state.nextWarehouseId++,
      name: 'Основной склад',
      supplierId: null,
      address: '',
      phone: '',
      isDefault: true,
    };
    state.warehouses.push(main);
    // Migrate all existing entries to the main warehouse
    state.warehouseEntries.forEach(e => {
      if (!e.warehouseId) e.warehouseId = main.id;
    });
    return main;
  }
  // Migrate entries that have no warehouseId to first warehouse
  const first = state.warehouses[0];
  state.warehouseEntries.forEach(e => {
    if (!e.warehouseId) e.warehouseId = first.id;
  });
  return first;
}

export function addWarehouse(data) {
  const wh = {
    id: state.nextWarehouseId++,
    name: data.name || 'Склад',
    supplierId: data.supplierId ?? null,
    address: data.address ?? '',
    phone: data.phone ?? '',
    isDefault: false,
  };
  state.warehouses.push(wh);
  return wh;
}

export function updateWarehouse(id, data) {
  const wh = state.warehouses.find(w => w.id === id);
  if (!wh) return null;
  if (data.name       !== undefined) wh.name       = data.name;
  if (data.supplierId !== undefined) wh.supplierId = data.supplierId;
  if (data.address    !== undefined) wh.address    = data.address;
  if (data.phone      !== undefined) wh.phone      = data.phone;
  return wh;
}

export function deleteWarehouse(id) {
  const wh = state.warehouses.find(w => w.id === id);
  if (!wh || wh.isDefault) return false;
  const idx = state.warehouses.findIndex(w => w.id === id);
  if (idx === -1) return false;
  state.warehouses.splice(idx, 1);
  const fallback = state.warehouses[0];
  if (fallback) {
    state.warehouseEntries.forEach(e => {
      if (e.warehouseId === id) e.warehouseId = fallback.id;
    });
  }
  return true;
}

export function getWarehouseById(id) {
  return state.warehouses.find(w => w.id === id) || null;
}

// ─── Acts shipping helpers ────────────────────────────────────────

/**
 * Returns true if ANY saved delivery act has shippingAllowed === true
 * for a product matching the given productCode or productName.
 *
 * This is the authoritative source for «принято / допущено к отгрузке»
 * in the warehouse module.
 */
export function isShippingAllowedByActs(productCode, productName) {
  const code = (productCode || '').trim().toLowerCase();
  const name = (productName || '').trim().toLowerCase();
  if (!code && !name) return false;

  return (state.acts || []).some(act => {
    if ((act.mode || 'so') !== 'delivery') return false;
    return (act.selectedItems || []).some(si => {
      if (si.selected === false) return false;
      if (si.shippingAllowed !== true) return false;
      const siCode = (si.itemCode || '').trim().toLowerCase();
      const siName = (si.name    || '').trim().toLowerCase();
      // Match by code first (more reliable), then by name
      if (code && siCode && siCode === code) return true;
      if (name && siName && siName === name) return true;
      return false;
    });
  });
}

// ─── Shipments (Отгрузки) ─────────────────────────────────────────

/**
 * Shipment shape:
 * { id, date, note, rows: [{ codeKey, productCode, productName, category, recipients: [{ recipientId, recipientName, qty }] }], totalQty, createdAt }
 */

/** Get all shipments */
export function getShipments() {
  return state.shipments;
}

/** Add a shipment record */
export function addShipment(data) {
  const shipment = { id: state.nextShipmentId++, ...data, createdAt: new Date().toISOString() };
  state.shipments.push(shipment);
  return shipment;
}

/** Update a shipment record */
export function updateShipment(id, data) {
  const s = state.shipments.find(x => x.id === id);
  if (!s) return null;
  Object.assign(s, data, { id, updatedAt: new Date().toISOString() });
  return s;
}

/** Delete a shipment record */
export function deleteShipment(id) {
  const idx = state.shipments.findIndex(s => s.id === id);
  if (idx === -1) return false;
  state.shipments.splice(idx, 1);
  return true;
}

// ─── Direct Deliveries (Прямые поставки) ─────────────────────────

/** Get all direct deliveries */
export function getDirectDeliveries() {
  return state.directDeliveries || [];
}

/** Get one direct delivery by id */
export function getDirectDeliveryById(id) {
  return (state.directDeliveries || []).find(d => String(d.id) === String(id)) || null;
}

/** Add a direct delivery record */
export function addDirectDelivery(data) {
  const delivery = {
    id: state.nextDirectDeliveryId++,
    supplierId: data.supplierId ?? null,
    supplierName: data.supplierName || '',
    contractId: data.contractId ?? null,
    orderId: data.orderId ?? null,
    orderNumber: data.orderNumber || '',
    date: data.date || '',
    notes: data.notes || '',
    rows: Array.isArray(data.rows) ? data.rows : [],
    totalQty: Number(data.totalQty) || 0,
    totalCost: Number(data.totalCost) || 0,
    createdAt: new Date().toISOString(),
  };
  state.directDeliveries.push(delivery);
  return delivery;
}

/** Update a direct delivery record */
export function updateDirectDelivery(id, data) {
  const delivery = getDirectDeliveryById(id);
  if (!delivery) return null;
  Object.assign(delivery, data, {
    id: delivery.id,
    updatedAt: new Date().toISOString(),
  });
  return delivery;
}

/** Delete a direct delivery record */
export function deleteDirectDelivery(id) {
  const idx = (state.directDeliveries || []).findIndex(d => String(d.id) === String(id));
  if (idx === -1) return false;
  state.directDeliveries.splice(idx, 1);
  return true;
}

// ─── Delivered recalculation ──────────────────────────────────────

/**
 * Атомарный пересчёт delivered у всех получателей из реестра отгрузок.
 * Вызывается после загрузки и после каждого сохранения/редактирования отгрузки.
 * Гарантирует консистентность: delivered = сумма всех отгрузок по данному
 * товару для данного получателя.
 */
export function recalcAllDelivered() {
  // Собираем суммы по (recipientId, productId) из всех отгрузок
  const deliveredMap = new Map(); // key: `${recipientId}:${productId}` -> total qty
  const deliveredVariantMap = new Map(); // key: `${recipientId}:${productId}:${variantId}` -> total qty

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      const variantMeta = row.variantId || row.colorCode || row.productId
        ? {
            productId: row.productId ?? null,
            variantId: row.variantId || '',
            colorCode: row.colorCode || '',
            product: row.productId ? getProductById(row.productId) : null,
          }
        : resolveProductVariantByContractCode(row.productCode || '', row.productName || '');
      const prod = variantMeta?.product
        || (row.productId ? getProductById(row.productId) : null)
        || (row.productName
          ? state.products.find(p => p.name && p.name.trim().toLowerCase() === row.productName.trim().toLowerCase())
          : null);
      const resolvedProd = prod || null;
      if (!resolvedProd) continue;

      for (const recEntry of (row.recipients || [])) {
        const qty = Number(recEntry.qty) || 0;
        if (qty <= 0) continue;
        const mapKey = `${recEntry.recipientId}:${resolvedProd.id}`;
        deliveredMap.set(mapKey, (deliveredMap.get(mapKey) || 0) + qty);
        const variantKey = normalizeVariantId(variantMeta?.variantId || variantMeta?.colorCode || '');
        if (variantKey) {
          const variantMapKey = `${recEntry.recipientId}:${resolvedProd.id}:${variantKey}`;
          deliveredVariantMap.set(variantMapKey, (deliveredVariantMap.get(variantMapKey) || 0) + qty);
        }
      }
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    for (const row of (delivery.rows || [])) {
      const qty = Number(row.actualQty) || 0;
      const recipientId = row.recipientId;
      if (!recipientId || qty <= 0) continue;

      const code = (row.productCode || '').trim().toLowerCase();
      const name = (row.productName || '').trim().toLowerCase();
      const prod = code
        ? state.products.find(p => (p.code || '').trim().toLowerCase() === code)
        : null;
      const prodByName = !prod && name
        ? state.products.find(p => (p.name || '').trim().toLowerCase() === name)
        : null;
      const resolvedProd = prod || prodByName;
      if (!resolvedProd) continue;

      const mapKey = `${recipientId}:${resolvedProd.id}`;
      deliveredMap.set(mapKey, (deliveredMap.get(mapKey) || 0) + qty);
      const variantMeta = row.variantId || row.colorCode || row.productId
        ? {
            productId: row.productId ?? null,
            variantId: row.variantId || '',
            colorCode: row.colorCode || '',
          }
        : resolveProductVariantByContractCode(row.productCode || '', row.productName || '');
      const variantKey = normalizeVariantId(variantMeta?.variantId || variantMeta?.colorCode || '');
      if (variantKey) {
        const variantMapKey = `${recipientId}:${resolvedProd.id}:${variantKey}`;
        deliveredVariantMap.set(variantMapKey, (deliveredVariantMap.get(variantMapKey) || 0) + qty);
      }
    }
  }

  // Применяем к state.recipients
  for (const rec of (state.recipients || [])) {
    if (!rec.needs) continue;
    for (const [pidStr, entry] of Object.entries(rec.needs)) {
      const pid = Number(pidStr);
      const mapKey = `${rec.id}:${pid}`;
      const newDelivered = deliveredMap.get(mapKey) || 0;
      const product = getProductById(pid);
      const normalizedEntry = normalizeNeedEntry(entry, product);
      if (normalizedEntry?.variants && typeof normalizedEntry.variants === 'object') {
        let variantsDeliveredTotal = 0;
        Object.entries(normalizedEntry.variants).forEach(([variantId, variantEntry]) => {
          const variantKey = normalizeVariantId(variantId || variantEntry?.id || variantEntry?.colorCode);
          const deliveredVariant = deliveredVariantMap.get(`${rec.id}:${pid}:${variantKey}`) || 0;
          variantEntry.delivered = deliveredVariant;
          variantsDeliveredTotal += deliveredVariant;
        });
        normalizedEntry.delivered = variantsDeliveredTotal;
        rec.needs[pidStr] = normalizedEntry;
      } else if (typeof entry === 'object') {
        entry.delivered = newDelivered;
      } else {
        rec.needs[pidStr] = { qty: Number(entry) || 0, delivered: newDelivered, assembled: 0 };
      }
    }
    // Set delivered for products that appear in shipments but not yet in needs
    for (const [mapKey, qty] of deliveredMap.entries()) {
      const [rId, pId] = mapKey.split(':').map(Number);
      if (rId !== rec.id) continue;
      if (!rec.needs[pId]) {
        rec.needs[pId] = { qty: 0, delivered: qty, assembled: 0 };
      }
    }
  }
}

// ─── Assembled recalculation ──────────────────────────────────────

/**
 * Атомарный пересчёт assembled у всех получателей из реестра актов сборки.
 * Вызывается после загрузки и после каждого сохранения/удаления акта сборки.
 *
 * Одинаковые товары из разных заявок или разных контрактов суммируются:
 * assembled = Σ item.assembled по всем актам для данного (recipientId, productId).
 *
 * ПРАВИЛО: assembled не может превышать delivered.
 * Если превышает — обрезается до delivered, возвращается список нарушений.
 *
 * @returns {{ warnings: Array<{recipientName:string, productName:string, assembled:number, delivered:number}> }}
 */
export function recalcAllAssembled() {
  const warnings = [];

  // Собираем суммы по (recipientId, productId) из всех актов сборки
  const assembledMap = new Map(); // key: `${recipientId}:${productId}` -> total assembled

  for (const act of (state.assemblyActs || [])) {
    const recipientId = act.recipientId;
    if (!recipientId) continue;

    for (const item of (act.items || [])) {
      const qty = Number(item.assembled) || 0;
      if (qty <= 0) continue;

      // Resolve productId: сначала из поля item.productId, затем по коду/имени
      let prod = item.productId
        ? state.products.find(p => p.id === item.productId)
        : null;

      if (!prod) {
        const code = (item.productCode || '').trim().toLowerCase();
        const name = (item.productName || '').trim().toLowerCase();
        if (code) {
          prod = state.products.find(p => (p.code || '').trim().toLowerCase() === code);
          if (!prod) prod = state.products.find(p => {
            const pc = (p.code || '').trim().toLowerCase();
            return pc && (pc.includes(code) || code.includes(pc));
          });
        }
        if (!prod && name) {
          prod = state.products.find(p => (p.name || '').trim().toLowerCase() === name);
          if (!prod) prod = state.products.find(p => {
            const pn = (p.name || '').trim().toLowerCase();
            return pn && pn.length > 3 && (pn.includes(name) || name.includes(pn));
          });
        }
      }

      if (!prod) continue;

      const mapKey = `${recipientId}:${prod.id}`;
      assembledMap.set(mapKey, (assembledMap.get(mapKey) || 0) + qty);
    }
  }

  // Применяем к state.recipients
  for (const rec of (state.recipients || [])) {
    if (!rec.needs) continue;
    for (const [pidStr, entry] of Object.entries(rec.needs)) {
      const pid = Number(pidStr);
      const mapKey = `${rec.id}:${pid}`;
      let newAssembled = assembledMap.get(mapKey) || 0;
      if (typeof entry === 'object') {
        // Enforce assembled ≤ delivered
        const delivered = entry.delivered || 0;
        if (newAssembled > delivered && delivered > 0) {
          const prod = state.products.find(p => p.id === pid);
          warnings.push({
            recipientName: rec.name,
            productName: prod ? (prod.name || prod.code || String(pid)) : String(pid),
            assembled: newAssembled,
            delivered,
          });
          newAssembled = delivered;
        }
        entry.assembled = newAssembled;
      } else {
        rec.needs[pidStr] = { qty: Number(entry) || 0, delivered: 0, assembled: newAssembled };
      }
    }
    // Применяем для товаров, которые есть в актах, но не в needs
    for (const [mapKey, qty] of assembledMap.entries()) {
      const [rId, pId] = mapKey.split(':').map(Number);
      if (rId !== rec.id) continue;
      if (!rec.needs[pId]) {
        // No delivery recorded yet — assembled cannot exceed delivered (0)
        // Don't create a needs entry with assembled > 0 if delivered = 0
        rec.needs[pId] = { qty: 0, delivered: 0, assembled: 0 };
        if (qty > 0) {
          const prod = state.products.find(p => p.id === pId);
          warnings.push({
            recipientName: rec.name,
            productName: prod ? (prod.name || prod.code || String(pId)) : String(pId),
            assembled: qty,
            delivered: 0,
          });
        }
      }
    }
  }

  return { warnings };
}

/**
 * Миграция: добавляет productId в строки старых отгрузок, где он отсутствует.
 * Ищет товар по productCode, затем по productName.
 * Возвращает количество изменённых строк.
 */
export function migrateShipmentProductIds() {
  let changed = 0;
  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      if (row.productId) continue;
      const code = (row.productCode || '').trim().toLowerCase();
      const name = (row.productName || '').trim().toLowerCase();
      let prod = null;
      if (code) prod = state.products.find(p => (p.code || '').trim().toLowerCase() === code);
      if (!prod && code) prod = state.products.find(p => { const pc = (p.code || '').trim().toLowerCase(); return pc && (pc.includes(code) || code.includes(pc)); });
      if (!prod && name) prod = state.products.find(p => (p.name || '').trim().toLowerCase() === name);
      if (!prod && name) prod = state.products.find(p => { const pn = (p.name || '').trim().toLowerCase(); return pn && pn.length > 3 && (pn.includes(name) || name.includes(pn)); });
      if (prod) { row.productId = prod.id; changed++; }
    }
  }
  return changed;
}

/**
 * Миграция: заполняет orderNum / orderId в строках старых отгрузок,
 * где эти поля отсутствуют или равны null.
 *
 * Алгоритм:
 *  1. Если у строки есть orderKey вида «codeKey::orderId» — берём orderId из него.
 *  2. Если orderId найден — ищем заявку в state.orders и берём orderNumber.
 *  3. Если orderKey нет / orderId = noorder — ищем складскую запись
 *     по codeKey и берём её orderId, затем заявку.
 *
 * Возвращает количество изменённых строк.
 */
export function migrateShipmentOrderNums() {
  let changed = 0;

  for (const shipment of (state.shipments || [])) {
    for (const row of (shipment.rows || [])) {
      // Уже заполнено — пропускаем
      if (row.orderNum) continue;

      let resolvedOrderId = row.orderId ?? null;

      // Шаг 1: попробуем извлечь orderId из orderKey
      if (!resolvedOrderId && row.orderKey) {
        const parts = row.orderKey.split('::');
        if (parts.length === 2 && parts[1] !== 'noorder') {
          const parsed = Number(parts[1]);
          if (!isNaN(parsed)) resolvedOrderId = parsed;
        }
      }

      // Шаг 2: если orderId всё ещё нет — ищем по codeKey в складских записях
      if (!resolvedOrderId && row.codeKey) {
        const ck = row.codeKey.toLowerCase();
        for (const entry of (state.warehouseEntries || [])) {
          if (!entry.orderId) continue;
          const items = Array.isArray(entry.items) ? entry.items : [];
          const match = items.some(item => {
            const code = (item.productCode || '').trim().toLowerCase();
            const name = (item.productName || '').trim().toLowerCase();
            return (code && code === ck) || (name && name === ck);
          });
          if (match) { resolvedOrderId = entry.orderId; break; }
        }
      }

      // Шаг 3: по orderId находим заявку и берём номер
      if (resolvedOrderId) {
        const order = (state.orders || []).find(o => o.id === resolvedOrderId);
        if (order) {
          row.orderId  = resolvedOrderId;
          row.orderNum = order.orderNumber || ('Заявка #' + resolvedOrderId);
          // Обновляем orderKey если он был без orderId
          if (!row.orderKey || row.orderKey.endsWith('::noorder')) {
            row.orderKey = (row.codeKey || '') + '::' + String(resolvedOrderId);
          }
          changed++;
        }
      }
    }
  }

  return changed;
}

// ─── Order delivery/assembly aggregates ──────────────────────────

/**
 * Суммарное количество поставленного по заявке для данного товара.
 * Источник: state.warehouseEntries — записи с orderId === orderId,
 * в entry.items ищем совпадение по имени или коду.
 */
export function calcOrderDelivered(orderId, productName, productCode) {
  if (!orderId) return 0;
  const nameLow = (productName || '').trim().toLowerCase();
  const codeLow = (productCode || '').trim().toLowerCase();
  let total = 0;
  for (const entry of (state.warehouseEntries || [])) {
    if (entry.orderId !== orderId) continue;
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length > 0) {
      for (const item of items) {
        const iName = (item.productName || '').trim().toLowerCase();
        const iCode = (item.productCode || '').trim().toLowerCase();
        const matchCode = codeLow && iCode && codeLow === iCode;
        const matchName = nameLow && iName && nameLow === iName;
        if (matchCode || matchName) total += Number(item.qty) || 0;
      }
    } else {
      // Старый формат: одна запись = один товар
      const eName = (entry.productName || '').trim().toLowerCase();
      const eCode = (entry.productCode || '').trim().toLowerCase();
      const matchCode = codeLow && eCode && codeLow === eCode;
      const matchName = nameLow && eName && nameLow === eName;
      if (matchCode || matchName) total += Number(entry.received) || 0;
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    if (delivery.orderId !== orderId) continue;
    for (const row of (delivery.rows || [])) {
      const actualQty = Number(row.actualQty) || 0;
      if (actualQty <= 0) continue;
      const rName = (row.productName || '').trim().toLowerCase();
      const rCode = (row.productCode || '').trim().toLowerCase();
      const matchCode = codeLow && rCode && codeLow === rCode;
      const matchName = nameLow && rName && nameLow === rName;
      if (matchCode || matchName) total += actualQty;
    }
  }
  return total;
}

/**
 * Суммарное количество собранного для данного товара по данному контракту.
 * Источник: state.assemblyActs — фильтруем по contractId,
 * в act.items ищем совпадение по productId, коду или имени.
 * Если contractId не задан — считаем по всем актам.
 */
export function calcOrderAssembled(contractId, productName, productCode, productId) {
  const nameLow = (productName || '').trim().toLowerCase();
  const codeLow = (productCode || '').trim().toLowerCase();
  let total = 0;
  for (const act of (state.assemblyActs || [])) {
    if (contractId && act.contractId !== contractId) continue;
    for (const item of (act.items || [])) {
      // 1. По productId
      if (productId && item.productId && item.productId === productId) {
        total += Number(item.assembled) || 0;
        continue;
      }
      // 2. По коду
      const iCode = (item.productCode || '').trim().toLowerCase();
      if (codeLow && iCode && codeLow === iCode) {
        total += Number(item.assembled) || 0;
        continue;
      }
      // 3. По имени
      const iName = (item.productName || '').trim().toLowerCase();
      if (nameLow && iName && nameLow === iName) {
        total += Number(item.assembled) || 0;
      }
    }
  }
  return total;
}

/**
 * Суммарное поставленное по контракту для данного товара
 * (суммирует по всем записям склада с contractId === contractId).
 * Источник: state.warehouseEntries.
 */
export function calcContractDelivered(contractId, productName, productCode) {
  if (!contractId) return 0;
  const nameLow = (productName || '').trim().toLowerCase();
  const codeLow = (productCode || '').trim().toLowerCase();
  let total = 0;
  for (const entry of (state.warehouseEntries || [])) {
    if (entry.contractId !== contractId) continue;
    const items = Array.isArray(entry.items) ? entry.items : [];
    if (items.length > 0) {
      for (const item of items) {
        const iName = (item.productName || '').trim().toLowerCase();
        const iCode = (item.productCode || '').trim().toLowerCase();
        const matchCode = codeLow && iCode && codeLow === iCode;
        const matchName = nameLow && iName && nameLow === iName;
        if (matchCode || matchName) total += Number(item.qty) || 0;
      }
    } else {
      const eName = (entry.productName || '').trim().toLowerCase();
      const eCode = (entry.productCode || '').trim().toLowerCase();
      const matchCode = codeLow && eCode && codeLow === eCode;
      const matchName = nameLow && eName && nameLow === eName;
      if (matchCode || matchName) total += Number(entry.received) || 0;
    }
  }

  for (const delivery of (state.directDeliveries || [])) {
    if (delivery.contractId !== contractId) continue;
    for (const row of (delivery.rows || [])) {
      const actualQty = Number(row.actualQty) || 0;
      if (actualQty <= 0) continue;
      const rName = (row.productName || '').trim().toLowerCase();
      const rCode = (row.productCode || '').trim().toLowerCase();
      const matchCode = codeLow && rCode && codeLow === rCode;
      const matchName = nameLow && rName && nameLow === rName;
      if (matchCode || matchName) total += actualQty;
    }
  }
  return total;
}

/**
 * Суммарное собранное по контракту для данного товара
 * (суммирует по всем актам сборки данного контракта).
 */
export function calcContractAssembled(contractId, productName, productCode, productId) {
  return calcOrderAssembled(contractId, productName, productCode, productId);
}

// ─── Product Groups (Товарные группы) ────────────────────────────

/** Get all product groups (sorted) */
export function getProductGroups() {
  if (!Array.isArray(state.productGroups)) state.productGroups = [];
  return [...state.productGroups].sort((a, b) => a.localeCompare(b));
}

/** Add a product group; returns true if added, false if duplicate */
export function addProductGroup(name) {
  const trimmed = name.trim();
  if (!trimmed) return false;
  if (!Array.isArray(state.productGroups)) state.productGroups = [];
  const lower = trimmed.toLowerCase();
  if (state.productGroups.some(g => g.toLowerCase() === lower)) return false;
  state.productGroups.push(trimmed);
  state.productGroups.sort((a, b) => a.localeCompare(b));
  return true;
}

/** Remove a product group by name */
export function removeProductGroup(name) {
  if (!Array.isArray(state.productGroups)) return false;
  const idx = state.productGroups.indexOf(name);
  if (idx === -1) return false;
  state.productGroups.splice(idx, 1);
  return true;
}

/** Count products using a given group */
export function countProductsInGroup(groupName) {
  return state.products.filter(p => p.productGroup === groupName).length;
}

// ─── Needs / Contract quantity helpers ───────────────────────────

/**
 * Суммарная потребность по товару (productId) по всем получателям.
 * Источник: state.recipients[].needs[productId].qty
 */
export function calcTotalNeedForProduct(productId, recipientIds = null) {
  let total = 0;
  const product = getProductById(productId);
  const isMultiColor = hasProductColorVariants(product);
  const scopedRecipients = Array.isArray(recipientIds) && recipientIds.length
    ? new Set(recipientIds.map(id => String(id)))
    : null;

  for (const rec of (state.recipients || [])) {
    if (!rec.needs) continue;
    if (scopedRecipients && !scopedRecipients.has(String(rec.id))) continue;
    const entry = normalizeNeedEntry(rec.needs[productId], product);
    let qty = Number(entry.qty) || 0;
    if (isMultiColor && entry?.variants && typeof entry.variants === 'object') {
      qty = Object.values(entry.variants).reduce((sum, variant) => sum + (Number(variant?.qty) || 0), 0);
    } else if (isMultiColor) {
      qty = 0;
    }
    total += qty;
  }
  return total;
}

/**
 * Суммарное количество товара во всех контрактах по имени/коду.
 * excludeContractId — текущий контракт (исключить из суммы, чтобы не считать дважды).
 * Сопоставление: по item.productRef (id каталога), затем по имени.
 */
export function calcTotalContractedForProduct(productId, productName, excludeContractId) {
  const nameLow = (productName || '').trim().toLowerCase();
  let total = 0;
  for (const c of (state.contracts || [])) {
    for (const item of (c.items || [])) {
      const matchById   = productId && item.productRef === productId;
      const matchByName = !matchById && nameLow && (item.name || '').trim().toLowerCase() === nameLow;
      if (matchById || matchByName) total += Number(item.qty) || 0;
    }
  }
  // Вычитаем текущий контракт (он учтён через DOM-значение отдельно)
  if (excludeContractId) {
    const excContract = state.contracts.find(c => c.id === excludeContractId);
    if (excContract) {
      for (const item of (excContract.items || [])) {
        const matchById   = productId && item.productRef === productId;
        const matchByName = !matchById && nameLow && (item.name || '').trim().toLowerCase() === nameLow;
        if (matchById || matchByName) total -= Number(item.qty) || 0;
      }
    }
  }
  return total;
}

// ─── Assembly helpers ─────────────────────────────────────────────

/**
 * Считает количество, уже собранного по предыдущим актам для данного
 * (recipientId, productId), исключая акт с id === excludeActId.
 *
 * Используется в форме нового акта сборки чтобы показать «Собрано ранее»
 * и вычислить доступное количество (delivered - previouslyAssembled).
 *
 * @param {number} recipientId
 * @param {number} productId
 * @param {number|null} [excludeActId] — id редактируемого акта (исключить из суммы)
 * @param {number|null} [supplierId]   — если задан, считать только акты этого поставщика
 * @returns {number}
 */
export function calcPreviouslyAssembled(recipientId, productId, excludeActId = null, supplierId = null) {
  let total = 0;
  for (const act of (state.assemblyActs || [])) {
    if (act.recipientId !== recipientId) continue;
    if (excludeActId !== null && act.id === excludeActId) continue;
    // Фильтрация по поставщику: если supplierId задан — берём только акты этого поставщика
    if (supplierId !== null) {
      // Поставщик акта определяется через контракт акта
      const actContract = act.contractId
        ? (state.contracts || []).find(c => c.id === act.contractId)
        : null;
      const actSupplierId = actContract?.supplierId ?? null;
      if (actSupplierId !== supplierId) continue;
    }
    for (const item of (act.items || [])) {
      let pid = item.productId ?? null;
      if (!pid) {
        const code = (item.productCode || '').trim().toLowerCase();
        const name = (item.productName || '').trim().toLowerCase();
        const found = code
          ? state.products.find(p => (p.code || '').trim().toLowerCase() === code)
          : null;
        const foundByName = !found && name
          ? state.products.find(p => (p.name || '').trim().toLowerCase() === name)
          : null;
        pid = (found || foundByName)?.id ?? null;
      }
      if (pid === productId) total += Number(item.assembled) || 0;
    }
  }
  return total;
}

/**
 * Возвращает Map<supplierId, assembledQty> — сколько собрано для данного
 * (recipientId, productId) по каждому поставщику.
 * Поставщик определяется через контракт акта сборки.
 *
 * @param {number} recipientId
 * @param {number} productId
 * @param {number|null} [excludeActId]
 * @returns {Map<number|null, number>}  key = supplierId (null = неизвестен)
 */
export function calcAssembledBySupplier(recipientId, productId, excludeActId = null) {
  const result = new Map(); // supplierId -> total

  for (const act of (state.assemblyActs || [])) {
    if (act.recipientId !== recipientId) continue;
    if (excludeActId !== null && act.id === excludeActId) continue;

    const actContract = act.contractId
      ? (state.contracts || []).find(c => c.id === act.contractId)
      : null;
    const actSupplierId = actContract?.supplierId ?? null;

    for (const item of (act.items || [])) {
      let pid = item.productId ?? null;
      if (!pid) {
        const code = (item.productCode || '').trim().toLowerCase();
        const name = (item.productName || '').trim().toLowerCase();
        const found = code
          ? state.products.find(p => (p.code || '').trim().toLowerCase() === code)
          : null;
        const foundByName = !found && name
          ? state.products.find(p => (p.name || '').trim().toLowerCase() === name)
          : null;
        pid = (found || foundByName)?.id ?? null;
      }
      if (pid !== productId) continue;

      const qty = Number(item.assembled) || 0;
      if (qty <= 0) continue;
      result.set(actSupplierId, (result.get(actSupplierId) || 0) + qty);
    }
  }

  return result;
}

/**
 * Распределяет суммарно собранное количество по заявкам FIFO.
 *
 * Логика:
 *  1. Берём историю доставок для (recipientId, productId) — отсортированную по дате.
 *  2. Берём суммарно собранное из актов для (recipientId, productId).
 *  3. Заполняем заявки слева направо (FIFO): сначала ранние, потом поздние.
 *
 * @param {number} recipientId
 * @param {number} productId
 * @param {Array<{orderId, orderNum, date, qty}>} deliveryEntries — история доставок (уже отсортирована)
 * @returns {Array<{orderId, orderNum, date, deliveredQty, assembledQty}>}
 */
export function getAssemblyFifoByOrders(recipientId, productId, deliveryEntries) {
  // Считаем суммарно собранное из всех актов для (recipientId, productId)
  let totalAssembled = 0;
  for (const act of (state.assemblyActs || [])) {
    if (act.recipientId !== recipientId) continue;
    for (const item of (act.items || [])) {
      let pid = item.productId ?? null;
      if (!pid) {
        const code = (item.productCode || '').trim().toLowerCase();
        const name = (item.productName || '').trim().toLowerCase();
        const found = code
          ? state.products.find(p => (p.code || '').trim().toLowerCase() === code)
          : null;
        const foundByName = !found && name
          ? state.products.find(p => (p.name || '').trim().toLowerCase() === name)
          : null;
        pid = (found || foundByName)?.id ?? null;
      }
      if (pid === productId) totalAssembled += Number(item.assembled) || 0;
    }
  }

  // Распределяем по заявкам FIFO
  let remaining = totalAssembled;
  return deliveryEntries.map(entry => {
    const take = Math.min(remaining, entry.qty);
    remaining = Math.max(0, remaining - take);
    return { ...entry, assembledQty: take };
  });
}

