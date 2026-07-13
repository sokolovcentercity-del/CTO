/**
 * Data I/O module.
 * Export full project state to JSON, import from JSON.
 */

import { state, ensureDefaultWarehouse } from '../state.js';
import { loadFromStorage, saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

const t = (key, vals) => window.miniappI18n?.t(key, vals) ?? key;

// ─── Helpers ──────────────────────────────────────────────────────

function collectExportData() {
  return {
    _version: 1,
    _exportedAt: new Date().toISOString(),
    products: state.products || [],
    categories: state.categories || [],
    nextId: state.nextId || 1,
    recipients: state.recipients || [],
    nextRecipientId: state.nextRecipientId || 1,
    suppliers: state.suppliers || [],
    contracts: state.contracts || [],
    nextContractId: state.nextContractId || 1,
    lots: state.lots || [],
    nextLotId: state.nextLotId || 1,
    programs: state.programs || [],
    nextProgramId: state.nextProgramId || 1,
    commission: state.commission || [],
    nextCommissionId: state.nextCommissionId || 1,
    inspectionSchedules: state.inspectionSchedules || [],
    nextInspectionScheduleId: state.nextInspectionScheduleId || 1,
    acts: state.acts || [],
    nextActId: state.nextActId || 1,
    claims: state.claims || [],
    nextClaimId: state.nextClaimId || 1,
    orders: state.orders || [],
    nextOrderId: state.nextOrderId || 1,
    warehouseEntries: state.warehouseEntries || [],
    nextWarehouseEntryId: state.nextWarehouseEntryId || 1,
    shipments: state.shipments || [],
    nextShipmentId: state.nextShipmentId || 1,
    assemblyActs: state.assemblyActs || [],
    nextAssemblyActId: state.nextAssemblyActId || 1,
    warehouses: state.warehouses || [],
    nextWarehouseId: state.nextWarehouseId || 1,
    productGroups: state.productGroups || [],
  };
}

function applyImportData(data) {
  if (!data || typeof data !== 'object') throw new Error('Неверный формат файла');
  if (data._version !== 1) throw new Error('Неподдерживаемая версия файла');

  const arr = (v) => Array.isArray(v) ? v : [];
  const num = (v, def = 1) => (typeof v === 'number' && v > 0) ? v : def;

  state.products            = arr(data.products);
  state.categories          = arr(data.categories);
  state.nextId              = num(data.nextId);
  state.recipients          = arr(data.recipients);
  state.nextRecipientId     = num(data.nextRecipientId);
  state.suppliers           = arr(data.suppliers);
  state.contracts           = arr(data.contracts);
  state.nextContractId      = num(data.nextContractId);
  state.lots                = arr(data.lots);
  state.nextLotId           = num(data.nextLotId);
  state.programs            = arr(data.programs);
  state.nextProgramId       = num(data.nextProgramId);
  state.commission          = arr(data.commission);
  state.nextCommissionId    = num(data.nextCommissionId);
  state.inspectionSchedules = arr(data.inspectionSchedules);
  state.nextInspectionScheduleId = num(data.nextInspectionScheduleId);
  state.acts                = arr(data.acts);
  state.nextActId           = num(data.nextActId);
  state.claims              = arr(data.claims);
  state.nextClaimId         = num(data.nextClaimId);
  state.orders              = arr(data.orders);
  state.nextOrderId         = num(data.nextOrderId);
  state.warehouseEntries    = arr(data.warehouseEntries);
  state.nextWarehouseEntryId = num(data.nextWarehouseEntryId);
  state.shipments           = arr(data.shipments);
  state.nextShipmentId      = num(data.nextShipmentId);
  state.assemblyActs        = arr(data.assemblyActs);
  state.nextAssemblyActId   = num(data.nextAssemblyActId);
  state.warehouses          = arr(data.warehouses);
  state.nextWarehouseId     = num(data.nextWarehouseId);
  state.productGroups       = arr(data.productGroups);
  ensureDefaultWarehouse();
}

// ─── Export ───────────────────────────────────────────────────────

export function exportProjectJson() {
  try {
    const data = collectExportData();
    const json = JSON.stringify(data, null, 2);
    const blob = new Blob([json], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);

    const dateStr = new Date().toISOString().slice(0, 10);
    const a = document.createElement('a');
    a.href = url;
    a.download = `project-backup-${dateStr}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 5000);

    showToast(t('dataio.exportSuccess'), 'success');
  } catch (err) {
    console.error('Export error:', err);
    showToast(t('dataio.exportError'), 'error');
  }
}

// ─── Import modal ─────────────────────────────────────────────────

let _onImportDone = null;

export function openImportJsonModal(onDone) {
  _onImportDone = onDone || null;
  const overlay = document.getElementById('dataImportModal');
  if (overlay) {
    // Reset state
    const status   = document.getElementById('dataImportStatus');
    const confirm  = document.getElementById('dataImportConfirmBtn');
    const fileInput = document.getElementById('dataImportFileInput');
    const dropZone = document.getElementById('dataImportDropZone');
    if (status)  { status.textContent = ''; status.className = 'text-xs min-h-[1rem]'; }
    if (confirm) { confirm.classList.add('hidden'); confirm.dataset.pendingJson = ''; }
    if (fileInput) fileInput.value = '';
    if (dropZone) dropZone.classList.remove('drag-over');
    overlay.classList.add('open');
  }
}

export function closeImportJsonModal() {
  const overlay = document.getElementById('dataImportModal');
  if (overlay) overlay.classList.remove('open');
}

function handleFile(file) {
  if (!file) return;
  if (!file.name.endsWith('.json')) {
    setImportStatus(t('dataio.wrongFormat'), 'error');
    return;
  }
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const data = JSON.parse(e.target.result);
      // Basic validation
      if (data._version !== 1) {
        setImportStatus(t('dataio.badVersion'), 'error');
        return;
      }
      const prodCount = Array.isArray(data.products) ? data.products.length : 0;
      const recCount  = Array.isArray(data.recipients) ? data.recipients.length : 0;
      const ctCount   = Array.isArray(data.contracts) ? data.contracts.length : 0;
      setImportStatus(
        t('dataio.fileOk', { products: prodCount, recipients: recCount, contracts: ctCount }),
        'ok'
      );
      const confirm = document.getElementById('dataImportConfirmBtn');
      if (confirm) {
        confirm.classList.remove('hidden');
        confirm.dataset.pendingJson = JSON.stringify(data);
      }
    } catch {
      setImportStatus(t('dataio.parseError'), 'error');
    }
  };
  reader.readAsText(file);
}

function setImportStatus(msg, type) {
  const el = document.getElementById('dataImportStatus');
  if (!el) return;
  el.textContent = msg;
  el.className = 'text-xs min-h-[1rem] ' + (
    type === 'error' ? 'text-red-400' :
    type === 'ok'    ? 'text-emerald-400' :
                       'text-slate-400'
  );
}

async function confirmImport() {
  const confirm = document.getElementById('dataImportConfirmBtn');
  if (!confirm || !confirm.dataset.pendingJson) return;
  try {
    const data = JSON.parse(confirm.dataset.pendingJson);
    applyImportData(data);
    await saveToStorage();
    closeImportJsonModal();
    showToast(t('dataio.importSuccess'), 'success');
    _onImportDone?.();
  } catch (err) {
    console.error('Import error:', err);
    setImportStatus(t('dataio.importError') + ': ' + err.message, 'error');
  }
}

// ─── Init ─────────────────────────────────────────────────────────

export function initDataIO(onImportDone) {
  // Export button
  const exportBtn = document.getElementById('exportJsonBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportProjectJson);

  // Import button (open modal)
  const importBtn = document.getElementById('importJsonBtn');
  if (importBtn) importBtn.addEventListener('click', () => openImportJsonModal(onImportDone));

  // Modal close
  const closeBtn = document.getElementById('dataImportCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeImportJsonModal);

  const cancelBtn = document.getElementById('dataImportCancelBtn');
  if (cancelBtn) cancelBtn.addEventListener('click', closeImportJsonModal);

  // Overlay click
  const overlay = document.getElementById('dataImportModal');
  if (overlay) {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeImportJsonModal();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) closeImportJsonModal();
    });
  }

  // File input
  const fileInput = document.getElementById('dataImportFileInput');
  if (fileInput) {
    fileInput.addEventListener('change', (e) => {
      handleFile(e.target.files[0]);
    });
  }

  // Drop zone
  const dropZone = document.getElementById('dataImportDropZone');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      handleFile(e.dataTransfer.files[0]);
    });
    dropZone.addEventListener('click', () => fileInput?.click());
    dropZone.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput?.click(); }
    });
  }

  // Confirm import
  const confirmBtn = document.getElementById('dataImportConfirmBtn');
  if (confirmBtn) confirmBtn.addEventListener('click', confirmImport);
}
