/**
 * Storage layer.
 * Основное хранилище: REST API на mto-cto.falcon28.ru/api/
 * Fallback: localStorage (если API недоступен)
 *
 * API endpoints (PHP):
 *   GET  /api/?action=get&key=xxx        → { ok:true, value:"..." } | { ok:false }
 *   POST /api/?action=set               body: { key, value }        → { ok:true }
 *   GET  /api/?action=getall            → { ok:true, data:{ key:value, ... } }
 *   POST /api/?action=setall            body: { data:{ key:value, ... } }  → { ok:true }
 *
 * Если API недоступен — тихо работаем через localStorage.
 */

import { state, renumberDuplicateNumbers, deduplicateCategories, recalcAllDelivered, recalcAllAssembled, migrateShipmentOrderNums, migrateShipmentProductIds, ensureDefaultWarehouse, normalizeRecipientAddresses, normalizeRecipientAddressNeedKey, normalizeRecipientAddressNeeds, normalizeProductColorState, normalizeNeedEntry, getProductById, normalizeContractExecutionPolicy, seedRecipientAddressNeedsFromAggregate } from './state.js';

// ─── API base URL ──────────────────────────────────────────────────
// Жёстко прописан — window.location в miniapps iframe = miniapps.ai, а не наш сервер
const API_BASE = 'https://mto-cto.falcon28.ru/api/';
function getApiBase() {
  return API_BASE;
}

// ─── Storage keys ─────────────────────────────────────────────────
const STORAGE_KEY              = 'catalog_products';
const NEXT_ID_KEY              = 'catalog_next_id';
const CATEGORIES_KEY           = 'catalog_categories';
const RECIPIENTS_KEY           = 'catalog_recipients';
const NEXT_RECIPIENT_ID_KEY    = 'catalog_next_recipient_id';
const SUPPLIERS_KEY            = 'catalog_suppliers';
const CONTRACTS_KEY            = 'catalog_contracts';
const NEXT_CONTRACT_ID_KEY     = 'catalog_next_contract_id';
const LOTS_KEY                 = 'catalog_lots';
const NEXT_LOT_ID_KEY          = 'catalog_next_lot_id';
const PROGRAMS_KEY             = 'catalog_programs';
const NEXT_PROGRAM_ID_KEY      = 'catalog_next_program_id';
const COMMISSION_KEY           = 'catalog_commission';
const NEXT_COMMISSION_ID_KEY   = 'catalog_next_commission_id';
const INVITED_EXPERTS_KEY      = 'catalog_invited_experts';
const NEXT_INVITED_EXPERT_ID_KEY = 'catalog_next_invited_expert_id';
const INSPECTION_SCHEDULES_KEY = 'catalog_inspection_schedules';
const NEXT_INSPECTION_SCHEDULE_ID_KEY = 'catalog_next_inspection_schedule_id';
const ACTS_KEY                 = 'catalog_acts';
const NEXT_ACT_ID_KEY          = 'catalog_next_act_id';
const PRIMARY_DOCS_KEY         = 'catalog_primary_docs';
const NEXT_PRIMARY_DOC_ID_KEY  = 'catalog_next_primary_doc_id';
const CLAIMS_KEY               = 'catalog_claims';
const NEXT_CLAIM_ID_KEY        = 'catalog_next_claim_id';
const ORDERS_KEY               = 'catalog_orders';
const NEXT_ORDER_ID_KEY        = 'catalog_next_order_id';
const WAREHOUSE_KEY            = 'catalog_warehouse_entries';
const NEXT_WAREHOUSE_ID_KEY    = 'catalog_next_warehouse_id';
const SHIPMENTS_KEY            = 'catalog_shipments';
const NEXT_SHIPMENT_ID_KEY     = 'catalog_next_shipment_id';
const DIRECT_DELIVERIES_KEY    = 'catalog_direct_deliveries';
const NEXT_DIRECT_DELIVERY_ID_KEY = 'catalog_next_direct_delivery_id';
const ASSEMBLY_ACTS_KEY        = 'catalog_assembly_acts';
const NEXT_ASSEMBLY_ACT_ID_KEY = 'catalog_next_assembly_act_id';
const WAREHOUSES_KEY           = 'catalog_warehouses';
const NEXT_WAREHOUSE_LOC_ID_KEY= 'catalog_next_warehouse_loc_id';
const PRODUCT_GROUPS_KEY       = 'catalog_product_groups';

const LS_PREFIX = 'mto_';

const ALL_KEYS = [
  STORAGE_KEY, NEXT_ID_KEY, CATEGORIES_KEY,
  RECIPIENTS_KEY, NEXT_RECIPIENT_ID_KEY,
  SUPPLIERS_KEY, CONTRACTS_KEY, NEXT_CONTRACT_ID_KEY,
  LOTS_KEY, NEXT_LOT_ID_KEY,
  PROGRAMS_KEY, NEXT_PROGRAM_ID_KEY,
  COMMISSION_KEY, NEXT_COMMISSION_ID_KEY,
  INVITED_EXPERTS_KEY, NEXT_INVITED_EXPERT_ID_KEY,
  INSPECTION_SCHEDULES_KEY, NEXT_INSPECTION_SCHEDULE_ID_KEY,
  ACTS_KEY, NEXT_ACT_ID_KEY,
  PRIMARY_DOCS_KEY, NEXT_PRIMARY_DOC_ID_KEY,
  CLAIMS_KEY, NEXT_CLAIM_ID_KEY,
  ORDERS_KEY, NEXT_ORDER_ID_KEY,
  WAREHOUSE_KEY, NEXT_WAREHOUSE_ID_KEY,
  SHIPMENTS_KEY, NEXT_SHIPMENT_ID_KEY,
  DIRECT_DELIVERIES_KEY, NEXT_DIRECT_DELIVERY_ID_KEY,
  ASSEMBLY_ACTS_KEY, NEXT_ASSEMBLY_ACT_ID_KEY,
  WAREHOUSES_KEY, NEXT_WAREHOUSE_LOC_ID_KEY,
  PRODUCT_GROUPS_KEY,
];

// ─── localStorage helpers ─────────────────────────────────────────

function lsGet(key) {
  // Пробуем sessionStorage если localStorage заблокирован (Chrome/Яндекс iframe)
  try { const v = localStorage.getItem(LS_PREFIX + key); if (v !== null) return v; } catch { /* */ }
  try { return sessionStorage.getItem(LS_PREFIX + key); } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, value); } catch { /* quota или блокировка */ }
  try { sessionStorage.setItem(LS_PREFIX + key, value); } catch { /* */ }
}
function lsGetAll() {
  const result = {};
  ALL_KEYS.forEach(k => {
    const v = lsGet(k);
    if (v !== null) result[k] = v;
  });
  return result;
}
function lsSetAll(data) {
  Object.entries(data).forEach(([k, v]) => lsSet(k, v));
}

// ─── API helpers ──────────────────────────────────────────────────

let _apiAvailable = null; // null = неизвестно, true/false = проверено
let _lastDataSignature = '';

function makeDataSignature(all = {}) {
  return ALL_KEYS.map(key => `${key}::${all[key] ?? ''}`).join('\u001f');
}

async function checkApi() {
  if (_apiAvailable !== null) return _apiAvailable;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const resp = await fetch(getApiBase() + '?action=ping', {
      method: 'GET',
      signal: ctrl.signal,
      cache: 'no-store',
    });
    clearTimeout(timer);
    _apiAvailable = resp.ok;
  } catch {
    _apiAvailable = false;
  }
  return _apiAvailable;
}

async function apiGetAll() {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    const resp = await fetch(getApiBase() + '?action=getall', {
      method: 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return null;
    const json = await resp.json();
    if (!json.ok || !json.data) return null;
    return json.data; // { key: value, ... }
  } catch {
    return null;
  }
}

async function apiSetAll(data) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const resp = await fetch(getApiBase() + '?action=setall', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (!resp.ok) return false;
    const json = await resp.json();
    return !!json.ok;
  } catch {
    return false;
  }
}

// ─── Category resolution helper ───────────────────────────────────

function resolveCategoryFromCatalog(productId, productCode, productName) {
  const products = state.products || [];
  if (productId) {
    const p = products.find(p => p.id === productId);
    if (p && p.category) return p.category;
  }
  const code = (productCode || '').trim().toLowerCase();
  const name = (productName || '').trim().toLowerCase();
  if (code) {
    const p = products.find(p => p.code && p.code.trim().toLowerCase() === code);
    if (p && p.category) return p.category;
  }
  if (code) {
    const p = products.find(p => {
      const pc = (p.code || '').trim().toLowerCase();
      return pc && (pc === code || code.includes(pc) || pc.includes(code));
    });
    if (p && p.category) return p.category;
  }
  if (name) {
    const p = products.find(p => p.name && p.name.trim().toLowerCase() === name);
    if (p && p.category) return p.category;
  }
  if (name) {
    const p = products.find(p => {
      const pn = (p.name || '').trim().toLowerCase();
      return pn && pn.length > 3 && (pn === name || name.includes(pn) || pn.includes(name));
    });
    if (p && p.category) return p.category;
  }
  return '';
}

// ─── Parse helper ─────────────────────────────────────────────────

function parseJSON(raw, fallback) {
  if (!raw) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ─── Apply loaded data to state ───────────────────────────────────

async function applyData(all) {
  let recipientNeedsMigrated = false;
  let lotsMigrated = false;

  // Products
  const products = parseJSON(all[STORAGE_KEY], null);
  if (Array.isArray(products)) state.products = products;

  const nextId = parseInt(all[NEXT_ID_KEY], 10);
  if (nextId > 0) state.nextId = nextId;

  // Categories
  const cats = parseJSON(all[CATEGORIES_KEY], null);
  if (Array.isArray(cats) && cats.length > 0) state.categories = cats;

  // Recipients
  const recs = parseJSON(all[RECIPIENTS_KEY], null);
  if (Array.isArray(recs)) state.recipients = recs;

  const nextRecId = parseInt(all[NEXT_RECIPIENT_ID_KEY], 10);
  if (nextRecId > 0) state.nextRecipientId = nextRecId;

  if (state.recipients.length > 0) {
    const maxRecId = state.recipients.reduce((max, r) => Math.max(max, r.id || 0), 0);
    state.nextRecipientId = Math.max(state.nextRecipientId, maxRecId + 1);
  }

  // Migrate recipients
  state.recipients.forEach(r => {
    if (r.address         === undefined) r.address         = '';
    r.addresses = normalizeRecipientAddresses(r.addresses, r.address);
    r.address = r.addresses[0] || '';
    if (r.addressNeeds === undefined || !r.addressNeeds || typeof r.addressNeeds !== 'object') {
      r.addressNeeds = {};
      recipientNeedsMigrated = true;
    }
    if (r.readinessStatus === undefined) r.readinessStatus = '';
    if (r.targetProgram   === undefined) r.targetProgram   = '';
    if (r.needs) {
      Object.keys(r.needs).forEach(pid => {
        const product = getProductById(Number(pid));
        const before = JSON.stringify(r.needs[pid]);
        r.needs[pid] = normalizeNeedEntry(r.needs[pid], product);
        if (JSON.stringify(r.needs[pid]) !== before) recipientNeedsMigrated = true;
      });
    }

    const beforeAddressNeeds = JSON.stringify(r.addressNeeds || {});
    r.addressNeeds = normalizeRecipientAddressNeeds(r.addressNeeds, r);

    if (Object.keys(r.addressNeeds).length === 0 && r.addresses.length === 1 && r.needs && Object.keys(r.needs).length > 0) {
      const onlyAddress = r.addresses[0];
      const onlyKey = normalizeRecipientAddressNeedKey(onlyAddress);
      r.addressNeeds[onlyKey] = {
        address: onlyAddress,
        needs: {},
      };
      Object.keys(r.needs).forEach(pid => {
        const product = getProductById(Number(pid));
        r.addressNeeds[onlyKey].needs[pid] = normalizeNeedEntry(r.needs[pid], product);
      });
      recipientNeedsMigrated = true;
    }

    if (seedRecipientAddressNeedsFromAggregate(r)) {
      recipientNeedsMigrated = true;
    }

    if (JSON.stringify(r.addressNeeds || {}) !== beforeAddressNeeds) {
      recipientNeedsMigrated = true;
    }
  });

  // Migrate product specs and color variants
  state.products.forEach(p => {
    if (!Array.isArray(p.specs)) {
      if (typeof p.characteristics === 'string' && p.characteristics.trim()) {
        p.specs = p.characteristics.split('\n').map(s => s.trim()).filter(Boolean);
      } else {
        p.specs = [];
      }
      delete p.characteristics;
    }
    p.specs = p.specs.map(s => {
      if (s && typeof s === 'object') return s;
      const str = String(s != null ? s : '').trim();
      if (!str) return null;
      const pipes = str.split('|').map(x => x.trim());
      if (pipes.length === 3) return { param: pipes[0], unit: pipes[1], value: pipes[2] };
      const ci = str.indexOf(':');
      if (ci > 0) return { param: str.slice(0, ci).trim(), unit: '', value: str.slice(ci + 1).trim() };
      return { param: str, unit: '', value: '' };
    }).filter(Boolean);
    normalizeProductColorState(p);
  });

  state.recipients.forEach(r => {
    if (!r.needs) return;
    Object.keys(r.needs).forEach(pid => {
      const product = getProductById(Number(pid));
      const before = JSON.stringify(r.needs[pid]);
      r.needs[pid] = normalizeNeedEntry(r.needs[pid], product);
      if (JSON.stringify(r.needs[pid]) !== before) recipientNeedsMigrated = true;
    });
  });

  // Suppliers
  const supps = parseJSON(all[SUPPLIERS_KEY], null);
  if (Array.isArray(supps)) state.suppliers = supps;
  (state.suppliers || []).forEach(s => {
    if (!Array.isArray(s.contracts)) s.contracts = [];
  });

  // Contracts
  const contracts = parseJSON(all[CONTRACTS_KEY], null);
  if (Array.isArray(contracts)) state.contracts = contracts;

  const nextContractId = parseInt(all[NEXT_CONTRACT_ID_KEY], 10);
  if (nextContractId > 0) state.nextContractId = nextContractId;
  if (state.contracts.length > 0) {
    const maxCId = state.contracts.reduce((max, c) => Math.max(max, c.id || 0), 0);
    state.nextContractId = Math.max(state.nextContractId, maxCId + 1);
  }
  state.contracts.forEach(c => {
    if (c.lotId === undefined) c.lotId = null;
    if (!Array.isArray(c.programs)) c.programs = [];
    if (!Array.isArray(c.items))    c.items    = [];
    if (!Array.isArray(c.renameActRows)) c.renameActRows = [];
    c.executionPolicy = normalizeContractExecutionPolicy(c.executionPolicy, c);
    c.items.forEach(item => {
      if (!item.receiving) item.receiving = {};
      if (item.receiving.shippingAllowed === undefined) item.receiving.shippingAllowed = false;
      if (item.soNotRequired === undefined) item.soNotRequired = false;
      if (item.specificationName === undefined) item.specificationName = '';
      if (item.itemId === undefined) item.itemId = '';
    });
  });

  // Lots
  const lots = parseJSON(all[LOTS_KEY], null);
  if (Array.isArray(lots)) state.lots = lots;

  const nextLotId = parseInt(all[NEXT_LOT_ID_KEY], 10);
  if (nextLotId > 0) state.nextLotId = nextLotId;
  if (!state.nextLotId) state.nextLotId = 1;
  if (state.lots.length > 0) {
    const maxLotId = state.lots.reduce((max, lot) => Math.max(max, Number(lot.id) || 0), 0);
    state.nextLotId = Math.max(state.nextLotId, maxLotId + 1);
  }
  state.lots.forEach((lot) => {
    if (!Array.isArray(lot.recipientIds)) lot.recipientIds = [];
    if (!Array.isArray(lot.items)) lot.items = [];
    lot.recipientIds = lot.recipientIds
      .map((value) => {
        if (typeof value === 'number') return Number(value) || null;
        if (typeof value === 'string') {
          const trimmed = value.trim();
          const numeric = Number(trimmed);
          if (Number.isFinite(numeric) && numeric > 0) return numeric;
          const byName = (state.recipients || []).find((recipient) =>
            String(recipient?.name || '').trim().toLowerCase() === trimmed.toLowerCase()
          );
          return byName ? Number(byName.id) || null : null;
        }
        if (value && typeof value === 'object') {
          const directId = Number(value.id ?? value.recipientId ?? value.value ?? value.key ?? 0) || 0;
          if (directId > 0) return directId;
          const name = String(value.name ?? value.recipientName ?? value.label ?? value.title ?? '').trim();
          if (!name) return null;
          const byName = (state.recipients || []).find((recipient) =>
            String(recipient?.name || '').trim().toLowerCase() === name.toLowerCase()
          );
          return byName ? Number(byName.id) || null : null;
        }
        return null;
      })
      .filter((id) => id != null);
    lot.items = lot.items
      .map((item) => {
        const qty = Number(item?.qty) || 0;
        const productId = Number(item?.productId) || Number(item?.productRef) || null;
        const product = productId != null ? state.products.find((p) => p.id === productId) : null;
        const productName = String(item?.productName || product?.name || '').trim();
        const productCode = String(item?.productCode || product?.code || '').trim();
        const hasNmcd = item?.nmcd !== undefined && item?.nmcd !== null && item?.nmcd !== '';
        const nmcd = hasNmcd ? (Number(item?.nmcd) || 0) : 0;
        const migrated = (
          Number(item?.productId) !== productId
          || Number(item?.productRef) > 0
          || String(item?.productName || '').trim() !== productName
          || String(item?.productCode || '').trim() !== productCode
          || ((item?.nmcd !== undefined && item?.nmcd !== null && item?.nmcd !== '') ? (Number(item?.nmcd) || 0) : 0) !== nmcd
        );
        if (migrated) lotsMigrated = true;
        if ((!productId && !productName && !productCode) || qty <= 0) return null;
        return { productId, productName, productCode, qty, nmcd };
      })
      .filter(Boolean);
    if (lot.contractNumber === undefined) lot.contractNumber = '';
  });

  // Programs
  const progs = parseJSON(all[PROGRAMS_KEY], null);
  if (Array.isArray(progs)) state.programs = progs;

  const nextProgId = parseInt(all[NEXT_PROGRAM_ID_KEY], 10);
  if (nextProgId > 0) state.nextProgramId = nextProgId;
  if (state.programs.length > 0) {
    const maxPId = state.programs.reduce((max, p) => Math.max(max, p.id || 0), 0);
    state.nextProgramId = Math.max(state.nextProgramId, maxPId + 1);
  }
  state.programs.forEach(p => {
    if (p.code  === undefined) p.code  = '';
    if (p.kbk   === undefined) p.kbk   = '';
    if (p.limit === undefined) p.limit = 0;
  });

  // Commission
  const comm = parseJSON(all[COMMISSION_KEY], null);
  if (Array.isArray(comm)) state.commission = comm;

  const nextCommId = parseInt(all[NEXT_COMMISSION_ID_KEY], 10);
  if (nextCommId > 0) state.nextCommissionId = nextCommId;
  if (state.commission.length > 0) {
    const maxCmId = state.commission.reduce((max, c) => Math.max(max, c.id || 0), 0);
    state.nextCommissionId = Math.max(state.nextCommissionId, maxCmId + 1);
  }
  state.commission.forEach((m, i) => { if (!m.id) m.id = i + 1; });

  // Invited experts
  const invitedExperts = parseJSON(all[INVITED_EXPERTS_KEY], null);
  if (Array.isArray(invitedExperts)) state.invitedExperts = invitedExperts;

  const nextInvitedExpertId = parseInt(all[NEXT_INVITED_EXPERT_ID_KEY], 10);
  if (nextInvitedExpertId > 0) state.nextInvitedExpertId = nextInvitedExpertId;
  if (state.invitedExperts.length > 0) {
    const maxExpertId = state.invitedExperts.reduce((max, expert) => Math.max(max, expert.id || 0), 0);
    state.nextInvitedExpertId = Math.max(state.nextInvitedExpertId, maxExpertId + 1);
  }
  state.invitedExperts.forEach((expert, i) => {
    if (!expert.id) expert.id = i + 1;
    if (expert.role === undefined) expert.role = '';
    if (expert.organization === undefined) expert.organization = '';
    if (expert.name === undefined) expert.name = '';
  });

  // Inspection schedules
  const inspectionSchedules = parseJSON(all[INSPECTION_SCHEDULES_KEY], null);
  if (Array.isArray(inspectionSchedules)) state.inspectionSchedules = inspectionSchedules;

  const nextInspectionScheduleId = parseInt(all[NEXT_INSPECTION_SCHEDULE_ID_KEY], 10);
  if (nextInspectionScheduleId > 0) state.nextInspectionScheduleId = nextInspectionScheduleId;
  if (!state.nextInspectionScheduleId) state.nextInspectionScheduleId = 1;
  if (state.inspectionSchedules.length > 0) {
    const maxInspectionScheduleId = state.inspectionSchedules.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0);
    state.nextInspectionScheduleId = Math.max(state.nextInspectionScheduleId, maxInspectionScheduleId + 1);
  }
  state.inspectionSchedules.forEach((item, i) => {
    if (!item.id) item.id = i + 1;
    if (item.date === undefined) item.date = '';
    if (item.time === undefined) item.time = '';
    if (item.supplierId === undefined) item.supplierId = null;
    if (item.supplierName === undefined) item.supplierName = '';
    if (item.contractId === undefined) item.contractId = null;
    if (item.contractDate === undefined) item.contractDate = '';
    if (item.contractNumber === undefined) item.contractNumber = '';
    if (item.contractTitle === undefined) item.contractTitle = '';
    if (item.recipientId === undefined) item.recipientId = null;
    if (item.recipientName === undefined) item.recipientName = '';
    if (item.address === undefined) item.address = '';
    if (item.expertId === undefined) item.expertId = null;
    if (item.expertName === undefined) item.expertName = '';
    if (!Array.isArray(item.expertIds)) item.expertIds = item.expertId ? [item.expertId] : [];
    if (!Array.isArray(item.expertNames)) item.expertNames = item.expertName ? [item.expertName] : [];
    if (item.recipientRepresentative === undefined) item.recipientRepresentative = '';
    if (item.supplierNoticeDate === undefined) item.supplierNoticeDate = '';
    if (item.supplierNoticeNumber === undefined) item.supplierNoticeNumber = '';
    if (item.note === undefined) item.note = '';
    if (item.contractOwner === undefined) item.contractOwner = '';
    if (item.acceptanceStatus === undefined) item.acceptanceStatus = '';
    if (item.correctionDeadline === undefined) item.correctionDeadline = '';
    if (item.shortResult === undefined) item.shortResult = '';
    if (item.incorrectTz === undefined) item.incorrectTz = '';
    if (item.linkedActId === undefined) item.linkedActId = null;
  });

  // Acts
  const acts = parseJSON(all[ACTS_KEY], null);
  if (Array.isArray(acts)) state.acts = acts;

  const nextActId = parseInt(all[NEXT_ACT_ID_KEY], 10);
  if (nextActId > 0) state.nextActId = nextActId;
  if (state.acts.length > 0) {
    const maxAId = state.acts.reduce((max, a) => Math.max(max, a.id || 0), 0);
    state.nextActId = Math.max(state.nextActId, maxAId + 1);
  }

  // Primary documents registry
  const primaryDocs = parseJSON(all[PRIMARY_DOCS_KEY], null);
  if (Array.isArray(primaryDocs)) state.primaryDocs = primaryDocs;

  const nextPrimaryDocId = parseInt(all[NEXT_PRIMARY_DOC_ID_KEY], 10);
  if (nextPrimaryDocId > 0) state.nextPrimaryDocId = nextPrimaryDocId;
  if (!state.nextPrimaryDocId) state.nextPrimaryDocId = 1;
  if (state.primaryDocs.length > 0) {
    const maxPrimaryDocId = state.primaryDocs.reduce((max, d) => Math.max(max, d.id || 0), 0);
    state.nextPrimaryDocId = Math.max(state.nextPrimaryDocId, maxPrimaryDocId + 1);
  }

  // Claims registry
  const claims = parseJSON(all[CLAIMS_KEY], null);
  if (Array.isArray(claims)) state.claims = claims;

  const nextClaimId = parseInt(all[NEXT_CLAIM_ID_KEY], 10);
  if (nextClaimId > 0) state.nextClaimId = nextClaimId;
  if (!state.nextClaimId) state.nextClaimId = 1;
  if (state.claims.length > 0) {
    const maxClaimId = state.claims.reduce((max, claim) => Math.max(max, Number(claim.id) || 0), 0);
    state.nextClaimId = Math.max(state.nextClaimId, maxClaimId + 1);
  }
  state.claims.forEach((claim) => {
    if (!claim.paymentStatus) claim.paymentStatus = 'unpaid';
    if (!Array.isArray(claim.files)) claim.files = [];
  });

  // Orders
  const orders = parseJSON(all[ORDERS_KEY], null);
  if (Array.isArray(orders)) state.orders = orders;

  const nextOrderId = parseInt(all[NEXT_ORDER_ID_KEY], 10);
  if (nextOrderId > 0) state.nextOrderId = nextOrderId;
  if (state.orders.length > 0) {
    const maxOId = state.orders.reduce((max, o) => Math.max(max, o.id || 0), 0);
    state.nextOrderId = Math.max(state.nextOrderId, maxOId + 1);
  }
  (state.orders || []).forEach(o => {
    if (!o.readinessState) o.readinessState = 'not_applicable';
    if (!o.executionActs || typeof o.executionActs !== 'object') {
      o.executionActs = { notReady: null, ready: null };
    } else {
      if (o.executionActs.notReady === undefined) o.executionActs.notReady = null;
      if (o.executionActs.ready === undefined) o.executionActs.ready = null;
    }
    (o.items || []).forEach(item => {
      if (!Array.isArray(item.deliverySchedules)) item.deliverySchedules = [];
    });
  });

  // Warehouse entries
  const entries = parseJSON(all[WAREHOUSE_KEY], null);
  if (Array.isArray(entries)) state.warehouseEntries = entries;

  const nextWhId = parseInt(all[NEXT_WAREHOUSE_ID_KEY], 10);
  if (nextWhId > 0) state.nextWarehouseEntryId = nextWhId;
  if (state.warehouseEntries.length > 0) {
    const maxWhId = state.warehouseEntries.reduce((max, e) => Math.max(max, e.id || 0), 0);
    state.nextWarehouseEntryId = Math.max(state.nextWarehouseEntryId, maxWhId + 1);
  }

  // Shipments
  const shipments = parseJSON(all[SHIPMENTS_KEY], null);
  if (Array.isArray(shipments)) state.shipments = shipments;

  const nextShipId = parseInt(all[NEXT_SHIPMENT_ID_KEY], 10);
  if (nextShipId > 0) state.nextShipmentId = nextShipId;
  if (state.shipments.length > 0) {
    const maxShId = state.shipments.reduce((max, s) => Math.max(max, s.id || 0), 0);
    state.nextShipmentId = Math.max(state.nextShipmentId, maxShId + 1);
  }

  // Direct deliveries
  const directDeliveries = parseJSON(all[DIRECT_DELIVERIES_KEY], null);
  if (Array.isArray(directDeliveries)) state.directDeliveries = directDeliveries;

  const nextDirectDeliveryId = parseInt(all[NEXT_DIRECT_DELIVERY_ID_KEY], 10);
  if (nextDirectDeliveryId > 0) state.nextDirectDeliveryId = nextDirectDeliveryId;
  if (!state.nextDirectDeliveryId) state.nextDirectDeliveryId = 1;
  if (state.directDeliveries.length > 0) {
    const maxDirectId = state.directDeliveries.reduce((max, d) => Math.max(max, Number(d.id) || 0), 0);
    state.nextDirectDeliveryId = Math.max(state.nextDirectDeliveryId, maxDirectId + 1);
  }

  // Backfill legacy lot recipients from linked contracts/orders if recipientIds were not stored
  (state.lots || []).forEach((lot) => {
    const currentIds = Array.isArray(lot.recipientIds)
      ? lot.recipientIds.map(id => Number(id) || 0).filter(Boolean)
      : [];
    if (currentIds.length) return;

    const contract = (state.contracts || []).find((item) => {
      if (lot.contractId != null && String(item.id) === String(lot.contractId)) return true;
      const contractNumber = String(lot.contractNumber || '').trim().toLowerCase();
      if (contractNumber && String(item.number || '').trim().toLowerCase() === contractNumber) return true;
      const lotNumber = String(lot.lotNumber || '').trim().toLowerCase();
      if (lotNumber && String(item.lotNumber || '').trim().toLowerCase() === lotNumber) return true;
      return false;
    });
    if (!contract?.id) return;

    const inferred = new Set();
    (state.orders || []).forEach((order) => {
      if (String(order?.contractId) !== String(contract.id)) return;
      (order.deliveryRows || []).forEach((row) => {
        (row.recipients || []).forEach((recipient) => {
          const recipientId = Number(recipient?.recipientId) || 0;
          if (recipientId > 0) inferred.add(recipientId);
        });
      });
    });
    (state.directDeliveries || []).forEach((delivery) => {
      if (String(delivery?.contractId) !== String(contract.id)) return;
      (delivery.rows || []).forEach((row) => {
        const recipientId = Number(row?.recipientId) || 0;
        if (recipientId > 0) inferred.add(recipientId);
      });
    });

    if (inferred.size > 0) {
      lot.recipientIds = [...inferred];
      lotsMigrated = true;
    }
  });

  // Assembly acts
  const aActs = parseJSON(all[ASSEMBLY_ACTS_KEY], null);
  if (Array.isArray(aActs)) state.assemblyActs = aActs;
  if (!state.assemblyActs) state.assemblyActs = [];

  const nextAsmActId = parseInt(all[NEXT_ASSEMBLY_ACT_ID_KEY], 10);
  if (nextAsmActId > 0) state.nextAssemblyActId = nextAsmActId;
  if (!state.nextAssemblyActId) state.nextAssemblyActId = 1;
  if (state.assemblyActs.length > 0) {
    const maxAsmId = state.assemblyActs.reduce((max, a) => Math.max(max, a.id || 0), 0);
    state.nextAssemblyActId = Math.max(state.nextAssemblyActId, maxAsmId + 1);
  }

  // Product Groups (Товарные группы)
  const pGroups = parseJSON(all[PRODUCT_GROUPS_KEY], null);
  if (Array.isArray(pGroups)) state.productGroups = pGroups;
  if (!Array.isArray(state.productGroups)) state.productGroups = [];

  // Warehouses (locations)
  const whs = parseJSON(all[WAREHOUSES_KEY], null);
  if (Array.isArray(whs)) state.warehouses = whs;

  const nextWhLocId = parseInt(all[NEXT_WAREHOUSE_LOC_ID_KEY], 10);
  if (nextWhLocId > 0) state.nextWarehouseId = nextWhLocId;
  if (state.warehouses.length > 0) {
    const maxWhLocId = state.warehouses.reduce((max, w) => Math.max(max, w.id || 0), 0);
    state.nextWarehouseId = Math.max(state.nextWarehouseId, maxWhLocId + 1);
  }

  // Migrate warehouse entries
  let warehouseMigrated = false;
  (state.warehouseEntries || []).forEach(e => {
    if (e.accepted === undefined) e.accepted = false;
    if (e.shipped  === undefined) e.shipped  = 0;
    if (e.received === undefined) e.received = 0;
    if (!Array.isArray(e.items)) { e.items = []; warehouseMigrated = true; }

    if (e.items.length === 0 && e.orderId) {
      const order = (state.orders || []).find(o => o.id === e.orderId);
      if (order) {
        const grouped = new Map();
        (order.deliveryRows || []).forEach(r => {
          const key = (r.contractItemName || '').trim();
          if (!key) return;
          if (!grouped.has(key)) {
            grouped.set(key, { code: (r.contractItemCode || '').trim(), price: Number(r.price) || 0, totalQty: 0 });
          }
          grouped.get(key).totalQty += Number(r.qty) || 0;
        });
        grouped.forEach((v, name) => {
          const prod = v.code
            ? state.products.find(p => p.code && p.code.trim() === v.code) ||
              state.products.find(p => p.name && p.name.trim().toLowerCase() === name.toLowerCase())
            : state.products.find(p => p.name && p.name.trim().toLowerCase() === name.toLowerCase());
          const finalCode = v.code || (prod ? (prod.code || '') : '');
          const finalName = prod ? prod.name : name;
          e.items.push({
            productId:   prod ? prod.id   : null,
            productCode: finalCode,
            productName: finalName,
            category:    resolveCategoryFromCatalog(prod ? prod.id : null, finalCode, finalName),
            price:       v.price,
            qty:         v.totalQty,
            cost:        v.price * v.totalQty,
          });
        });
        if (e.items.length > 0) warehouseMigrated = true;
      }
    }

    if (e.items.length === 0 && (e.productName || e.productCode)) {
      const prod = e.productId
        ? state.products.find(p => p.id === e.productId)
        : (e.productCode ? state.products.find(p => p.code && p.code === e.productCode) : null);
      e.items = [{
        productId:   e.productId   != null ? e.productId   : null,
        productCode: e.productCode != null ? e.productCode : '',
        productName: e.productName != null ? e.productName : '',
        category:    prod ? (prod.category || '') : (e.category || ''),
        price:       0,
        qty:         e.received || 0,
        cost:        0,
      }];
      warehouseMigrated = true;
    }

    if (!e.category) {
      const resolved = resolveCategoryFromCatalog(e.productId, e.productCode, e.productName);
      if (resolved) { e.category = resolved; warehouseMigrated = true; }
    }
    (e.items || []).forEach(item => {
      if (!item.category) {
        const resolved = resolveCategoryFromCatalog(item.productId, item.productCode, item.productName);
        if (resolved) { item.category = resolved; warehouseMigrated = true; }
      }
    });
  });

  // Recalculate nextId from existing products
  if (state.products.length > 0) {
    const maxId = state.products.reduce((max, p) => Math.max(max, p.id || 0), 0);
    state.nextId = Math.max(state.nextId, maxId + 1);
  }

  const fixed = renumberDuplicateNumbers();
  const catsBefore = state.categories.length;
  deduplicateCategories();
  const shipmentsMigrated  = migrateShipmentOrderNums();
  const productIdsMigrated = migrateShipmentProductIds();
  ensureDefaultWarehouse();
  recalcAllDelivered();
  recalcAllAssembled();

  return fixed > 0 || state.categories.length !== catsBefore || warehouseMigrated || shipmentsMigrated > 0 || productIdsMigrated > 0 || recipientNeedsMigrated || lotsMigrated;
}

// ─── Build save data object ───────────────────────────────────────

function buildSaveData() {
  return {
    [STORAGE_KEY]:               JSON.stringify(state.products),
    [NEXT_ID_KEY]:               String(state.nextId),
    [CATEGORIES_KEY]:            JSON.stringify(state.categories),
    [RECIPIENTS_KEY]:            JSON.stringify(state.recipients),
    [NEXT_RECIPIENT_ID_KEY]:     String(state.nextRecipientId),
    [SUPPLIERS_KEY]:             JSON.stringify(state.suppliers || []),
    [CONTRACTS_KEY]:             JSON.stringify(state.contracts || []),
    [NEXT_CONTRACT_ID_KEY]:      String(state.nextContractId),
    [LOTS_KEY]:                  JSON.stringify(state.lots || []),
    [NEXT_LOT_ID_KEY]:           String(state.nextLotId || 1),
    [PROGRAMS_KEY]:              JSON.stringify(state.programs || []),
    [NEXT_PROGRAM_ID_KEY]:       String(state.nextProgramId),
    [COMMISSION_KEY]:            JSON.stringify(state.commission || []),
    [NEXT_COMMISSION_ID_KEY]:    String(state.nextCommissionId),
    [INVITED_EXPERTS_KEY]:       JSON.stringify(state.invitedExperts || []),
    [NEXT_INVITED_EXPERT_ID_KEY]: String(state.nextInvitedExpertId || 1),
    [INSPECTION_SCHEDULES_KEY]:  JSON.stringify(state.inspectionSchedules || []),
    [NEXT_INSPECTION_SCHEDULE_ID_KEY]: String(state.nextInspectionScheduleId || 1),
    [ACTS_KEY]:                  JSON.stringify(state.acts || []),
    [NEXT_ACT_ID_KEY]:           String(state.nextActId),
    [PRIMARY_DOCS_KEY]:          JSON.stringify(state.primaryDocs || []),
    [NEXT_PRIMARY_DOC_ID_KEY]:   String(state.nextPrimaryDocId || 1),
    [CLAIMS_KEY]:                JSON.stringify(state.claims || []),
    [NEXT_CLAIM_ID_KEY]:         String(state.nextClaimId || 1),
    [ORDERS_KEY]:                JSON.stringify(state.orders || []),
    [NEXT_ORDER_ID_KEY]:         String(state.nextOrderId),
    [WAREHOUSE_KEY]:             JSON.stringify(state.warehouseEntries || []),
    [NEXT_WAREHOUSE_ID_KEY]:     String(state.nextWarehouseEntryId),
    [SHIPMENTS_KEY]:             JSON.stringify(state.shipments || []),
    [NEXT_SHIPMENT_ID_KEY]:      String(state.nextShipmentId),
    [DIRECT_DELIVERIES_KEY]:     JSON.stringify(state.directDeliveries || []),
    [NEXT_DIRECT_DELIVERY_ID_KEY]: String(state.nextDirectDeliveryId || 1),
    [ASSEMBLY_ACTS_KEY]:         JSON.stringify(state.assemblyActs || []),
    [NEXT_ASSEMBLY_ACT_ID_KEY]:  String(state.nextAssemblyActId || 1),
    [WAREHOUSES_KEY]:            JSON.stringify(state.warehouses || []),
    [NEXT_WAREHOUSE_LOC_ID_KEY]: String(state.nextWarehouseId || 1),
    [PRODUCT_GROUPS_KEY]:        JSON.stringify(state.productGroups || []),
  };
}

// ─── Load ─────────────────────────────────────────────────────────
//
// Стратегия: «API первичен, localStorage — кэш»
//
// 1. Пробуем загрузить данные с сервера (до 5 сек)
// 2. Если сервер ответил — используем его данные (актуальные для всех браузеров)
// 3. Если сервер недоступен — используем localStorage как fallback

// Callback для перерисовки UI после фоновой синхронизации
let _refreshCallback = null;

/** Зарегистрировать функцию перерисовки UI (вызывается из main.js) */
export function setRefreshCallback(fn) {
  _refreshCallback = fn;
}

/** Возвращает текущий статус подключения к серверу */
export function getApiStatus() {
  return _apiAvailable; // null = проверяется, true = подключён, false = офлайн
}

/** Запустить авто-синхронизацию каждые N секунд */
export function startAutoSync(intervalMs = 15000) {
  setInterval(async () => {
    try {
      const apiData = await apiGetAll();
      if (!apiData || Object.keys(apiData).length === 0) return;
      const nextSignature = makeDataSignature(apiData);
      if (nextSignature === _lastDataSignature) {
        _apiAvailable = true;
        return;
      }
      _apiAvailable = true;
      _lastDataSignature = nextSignature;
      lsSetAll(apiData);
      await applyData(apiData);
      // Перерисовываем UI с новыми данными
      if (typeof _refreshCallback === 'function') {
        try { _refreshCallback(); } catch {}
      }
    } catch {}
  }, intervalMs);
}

export async function loadFromStorage() {
  let all = {};
  let needsMigrationSave = false;

  // ── Шаг 1: ВСЕГДА сначала берём из localStorage (мгновенно, не блокирует UI) ─
  try {
    all = lsGetAll();
    _lastDataSignature = makeDataSignature(all);
  } catch (err) {
    console.warn('[storage] localStorage read failed:', err.message);
  }

  // ── Шаг 2: применяем данные из localStorage — приложение стартует немедленно ─
  try {
    needsMigrationSave = await applyData(all);
  } catch (err) {
    console.warn('[storage] applyData failed:', err.message);
    ensureDefaultWarehouse();
  }

  // ── Шаг 3: в фоне пробуем загрузить с сервера (не блокирует загрузку UI) ─
  // Запускаем без await — приложение уже загружено и работает
  (async () => {
    try {
      const apiData = await apiGetAll();
      if (apiData && Object.keys(apiData).length > 0) {
        const nextSignature = makeDataSignature(apiData);
        if (nextSignature === _lastDataSignature) {
          _apiAvailable = true;
          return;
        }
        _apiAvailable = true;
        _lastDataSignature = nextSignature;
        lsSetAll(apiData);
        // Применяем свежие данные с сервера и перерисовываем UI
        await applyData(apiData);
        if (typeof _refreshCallback === 'function') {
          try { _refreshCallback(); } catch {}
        }
        console.log('[storage] Данные синхронизированы с сервера');
      }
    } catch {
      _apiAvailable = false;
    }
  })();

  if (needsMigrationSave) {
    await saveToStorage();
  }
}

// ─── Save ─────────────────────────────────────────────────────────

export async function saveToStorage() {
  const data = buildSaveData();
  _lastDataSignature = makeDataSignature(data);

  // 1. Сохраняем в localStorage — мгновенно (кэш)
  lsSetAll(data);

  // 2. Отправляем на сервер — ждём подтверждения
  try {
    const ok = await apiSetAll(data);
    if (ok) {
      _apiAvailable = true;
    } else {
      console.warn('[storage] apiSetAll вернул false');
      _apiAvailable = false;
    }
  } catch (err) {
    console.warn('[storage] apiSetAll error:', err.message);
    _apiAvailable = false;
  }
}
