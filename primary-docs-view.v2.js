import { state, savePrimaryDoc, updatePrimaryDoc, deletePrimaryDoc } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { loadPDFJS } from './lib-loader.js';
import { confirmDeleteWithImpact } from './dom.js';

const DOC_TYPE_OPTIONS = [
  ['upd', 'УПД'],
  ['waybill', 'Товарная накладная'],
  ['invoice', 'Счёт / счёт-фактура'],
  ['act', 'Акт'],
  ['registry', 'Реестр'],
  ['other', 'Другое'],
];

const uiState = {
  queue: [],
  drafts: [],
  activeTab: 'drafts',
  status: '',
  analyzing: false,
  nextQueueId: 1,
  registrySearch: '',
  registryContractFilter: '',
  registrySelectedId: null,
};

function sameId(a, b) {
  return String(a ?? '') === String(b ?? '');
}

function syncRegistryToolbar() {
  const searchEl = document.getElementById('primaryDocsToolbarSearch');
  const contractEl = document.getElementById('primaryDocsToolbarContract');
  const toolbarEl = document.getElementById('primaryDocsRegistryToolbar');
  if (!searchEl || !contractEl || !toolbarEl) return;

  const isRegistry = uiState.activeTab === 'registry';
  toolbarEl.style.display = isRegistry ? 'grid' : 'none';
  searchEl.value = uiState.registrySearch || '';
  contractEl.value = uiState.registryContractFilter || '';
}

const PRIMARY_DOC_PROMPT = `Ты анализируешь ОДИН первичный документ. Верни строго один JSON-объект без markdown и пояснений.

ОБЯЗАТЕЛЬНО:
- извлекай только то, что реально есть в документе
- не округляй числа и не обрезай дробную часть
- если число разорвано PDF-парсером, склей его в одно значение
- если поле пустое — верни пустую строку или null
- если в документе несколько дат, обязательно различай: date, shipmentDate, receiveDate, signDate
- field8 — это поле 8 УПД «Идентификатор государственного контракта...», если пусто — верни пустую строку
- status — статус УПД (например 1 или 2)
- totals.qty = сумма qty по строкам, если её можно определить
- issues[] — только краткие наблюдения по самому документу, без общих рассуждений

ВАЖНО ПО ЧИСЛАМ:
- 238 352,310 52699367 = 238352.31052699367
- 62 393,024 59016393 = 62393.02459016393
- qty × price должно совпадать с amountNoVat по строке
- country извлекай как есть, например «АВСТРИЯ»

Верни JSON такого вида:
{
  "docType": "upd|waybill|invoice|act|registry|other",
  "title": "",
  "number": "",
  "date": "",
  "status": "",
  "field8": "",
  "shipmentDate": "",
  "receiveDate": "",
  "signDate": "",
  "currency": "",
  "seller": { "name": "", "inn": "", "kpp": "", "address": "" },
  "buyer": { "name": "", "inn": "", "kpp": "", "address": "" },
  "shipper": { "name": "", "address": "" },
  "consignee": { "name": "", "address": "" },
  "contract": { "number": "", "date": "", "ref": "" },
  "items": [
    {
      "line": 1,
      "code": "",
      "name": "",
      "unitCode": "",
      "unit": "",
      "qty": "",
      "price": "",
      "amountNoVat": "",
      "vatRate": "",
      "vatAmount": "",
      "amountWithVat": "",
      "country": ""
    }
  ],
  "totals": {
    "qty": "",
    "amountNoVat": "",
    "vatAmount": "",
    "amountWithVat": ""
  },
  "issues": []
}`;

function getHandlerUrl(action = '') {
  const base = new URL('/doc-checker/api/handler.php', window.location.origin).href;
  return action ? `${base}?action=${encodeURIComponent(action)}` : base;
}

function escHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try { return JSON.parse(text); } catch {}

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try { return JSON.parse(text.slice(start, end + 1)); } catch {}
  }

  return null;
}

async function readServerJson(response) {
  const raw = await response.text();
  const text = String(raw || '').trim();

  if (!text) throw new Error('Пустой ответ сервера');
  if (/^<!DOCTYPE|^<html|^<br|^<b>/i.test(text)) {
    const snippet = text.replace(/\s+/g, ' ').slice(0, 180);
    throw new Error('Сервер вернул HTML/PHP-ошибку вместо JSON: ' + snippet);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error('Некорректный JSON от сервера');
  }

  if (!response.ok) {
    throw new Error(data?.details || data?.error || ('HTTP ' + response.status));
  }
  if (data?.error) {
    throw new Error(data.details || data.error);
  }

  return data;
}

async function ensureHandlerReady() {
  const response = await fetch(getHandlerUrl('test'), {
    method: 'GET',
    cache: 'no-store',
  });
  const data = await readServerJson(response);
  if (!data?.ok) throw new Error('handler.php не прошёл проверку');
  return data;
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

function compactText(text, limit = 2200) {
  const value = String(text || '').trim();
  if (!value) return '';
  return value.length > limit ? value.slice(0, limit) + '…' : value;
}

function getFileExt(name) {
  return String(name || '').split('.').pop()?.toLowerCase() || '';
}

function countMeaningfulChars(text) {
  const matches = String(text || '').match(/[A-Za-zА-Яа-яЁё0-9]/g);
  return matches ? matches.length : 0;
}

function looksDamagedText(text) {
  const value = String(text || '');
  const meaningful = countMeaningfulChars(value);
  if (meaningful < 80) return true;
  const lines = value.split('\n').filter(Boolean);
  const tabLines = lines.filter(line => line.includes('\t')).length;
  const weird = (value.match(/[�\u0000-\u001F]/g) || []).length;
  return weird > 30 && tabLines === 0;
}

function groupPdfTextItems(items) {
  const rows = [];
  const tolerance = 3;

  for (const item of items || []) {
    const text = String(item?.str || '').trim();
    if (!text) continue;

    const x = Number(item?.transform?.[4] || 0);
    const y = Number(item?.transform?.[5] || 0);
    let row = rows.find(r => Math.abs(r.y - y) <= tolerance);
    if (!row) {
      row = { y, cells: [] };
      rows.push(row);
    }
    row.cells.push({ x, text });
  }

  rows.sort((a, b) => b.y - a.y);

  return rows
    .map(row => row.cells.sort((a, b) => a.x - b.x).map(cell => cell.text).join('\t').trim())
    .filter(Boolean);
}

async function extractPdfTextBrowser(file) {
  const pdfjsLib = await loadPDFJS();
  const buffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
  const pages = [];

  for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
    const page = await pdf.getPage(pageNum);
    const textContent = await page.getTextContent();
    const lines = groupPdfTextItems(textContent?.items || []);
    if (lines.length) {
      pages.push(`--- Page ${pageNum} ---\n${lines.join('\n')}`);
    }
  }

  const text = pages.join('\n\n').trim();
  return {
    text,
    method: 'pdfjs-browser',
    length: text.length,
  };
}

async function extractDocumentText(entry, index, total) {
  const file = entry.file;
  const ext = getFileExt(file.name);
  const isPdf = ext === 'pdf';
  let browserResult = null;
  let serverResult = null;

  if (isPdf) {
    try {
      updateStatus(`Файл ${index}/${total}: PDF.js извлечение — ${file.name}`);
      browserResult = await extractPdfTextBrowser(file);
      if (browserResult?.text && !looksDamagedText(browserResult.text)) {
        return browserResult;
      }
    } catch (error) {
      console.warn('[primary-docs] PDF.js fallback to server extract_text', error);
    }
  }

  updateStatus(`Файл ${index}/${total}: server extract_text — ${file.name}`);
  const base64 = await fileToBase64(file);
  serverResult = await fetch(getHandlerUrl('extract_text'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'extract_text', file: base64, name: file.name }),
  }).then(readServerJson);

  const serverText = String(serverResult?.text || '').trim();
  const serverPayload = {
    text: serverText,
    method: serverResult?.method || 'server',
    length: serverResult?.length || serverText.length,
  };

  if (browserResult?.text && countMeaningfulChars(browserResult.text) > countMeaningfulChars(serverText)) {
    return browserResult;
  }

  return serverPayload;
}

function normalizeDigits(value) {
  return String(value || '').replace(/\D/g, '');
}

function firstDateFromText(value) {
  const m = String(value || '').match(/(\d{2}[.\-/]\d{2}[.\-/]\d{4})/);
  return m ? m[1].replace(/-/g, '.').replace(/\//g, '.') : '';
}

function autoMatchContract(doc) {
  const fromDoc = [doc?.contract?.number, doc?.contract?.ref, doc?.field8, doc?.title]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (!fromDoc) return null;

  const found = (state.contracts || []).find(contract => {
    const number = String(contract.number || '').toLowerCase().trim();
    return number && fromDoc.includes(number);
  });
  return found ? found.id : null;
}

function normalizeDoc(raw, meta = {}) {
  const data = raw && typeof raw === 'object' ? raw : {};
  const items = Array.isArray(data.items) ? data.items : [];
  const issues = Array.isArray(data.issues) ? data.issues.filter(Boolean) : [];
  const contractId = autoMatchContract(data);

  return {
    id: meta.id || null,
    sourceName: meta.sourceName || '',
    extractMethod: meta.extractMethod || '',
    extractedLength: meta.extractedLength || 0,
    extractedPreview: meta.extractedPreview || '',
    docType: data.docType || 'other',
    title: data.title || meta.sourceName || '',
    number: data.number || '',
    date: data.date || firstDateFromText(meta.sourceName),
    status: data.status || '',
    field8: data.field8 || '',
    shipmentDate: data.shipmentDate || '',
    receiveDate: data.receiveDate || '',
    signDate: data.signDate || '',
    currency: data.currency || '',
    seller: {
      name: data.seller?.name || '',
      inn: data.seller?.inn || '',
      kpp: data.seller?.kpp || '',
      address: data.seller?.address || '',
    },
    buyer: {
      name: data.buyer?.name || '',
      inn: data.buyer?.inn || '',
      kpp: data.buyer?.kpp || '',
      address: data.buyer?.address || '',
    },
    shipper: {
      name: data.shipper?.name || '',
      address: data.shipper?.address || '',
    },
    consignee: {
      name: data.consignee?.name || '',
      address: data.consignee?.address || '',
    },
    contract: {
      number: data.contract?.number || '',
      date: data.contract?.date || '',
      ref: data.contract?.ref || '',
    },
    items: items.map((item, index) => ({
      line: item.line ?? (index + 1),
      code: item.code || '',
      name: item.name || '',
      unitCode: item.unitCode || '',
      unit: item.unit || '',
      qty: item.qty ?? '',
      price: item.price ?? '',
      amountNoVat: item.amountNoVat ?? '',
      vatRate: item.vatRate || '',
      vatAmount: item.vatAmount ?? '',
      amountWithVat: item.amountWithVat ?? '',
      country: item.country || '',
    })),
    totals: {
      qty: data.totals?.qty ?? '',
      amountNoVat: data.totals?.amountNoVat ?? '',
      vatAmount: data.totals?.vatAmount ?? '',
      amountWithVat: data.totals?.amountWithVat ?? '',
    },
    issues,
    contractId,
    orderId: null,
    notes: '',
  };
}

function getDocTypeLabel(type) {
  return DOC_TYPE_OPTIONS.find(([value]) => value === type)?.[1] || 'Документ';
}

function getLinkedContract(doc) {
  if (!doc) return null;
  return (state.contracts || []).find(contract => Number(contract.id) === Number(doc.contractId)) || null;
}

function getDocContractNumberText(doc) {
  const linked = getLinkedContract(doc);
  return String(
    linked?.number || doc?.contract?.number || doc?.contract?.ref || doc?.field8 || ''
  ).trim();
}

function getSavedRegistryDocs() {
  const search = uiState.registrySearch.trim().toLowerCase();
  const contractFilter = uiState.registryContractFilter.trim().toLowerCase();

  return [...(state.primaryDocs || [])]
    .sort((a, b) => String(b.updatedAt || b.savedAt || '').localeCompare(String(a.updatedAt || a.savedAt || '')))
    .filter(doc => {
      const contractNumber = getDocContractNumberText(doc).toLowerCase();

      if (contractFilter && !contractNumber.includes(contractFilter)) return false;
      if (!search) return true;

      const haystack = [
        doc.sourceName,
        doc.title,
        doc.number,
        doc.date,
        doc.seller?.name,
        doc.buyer?.name,
        contractNumber,
      ].filter(Boolean).join(' ').toLowerCase();
      return haystack.includes(search);
    });
}

function ensureRegistrySelection(docs) {
  if (!docs.length) {
    uiState.registrySelectedId = null;
    return null;
  }
  const selected = docs.find(doc => sameId(doc.id, uiState.registrySelectedId));
  if (selected) return selected;
  uiState.registrySelectedId = docs[0].id;
  return docs[0];
}

function getOrdersForContract(contractId) {
  return (state.orders || []).filter(order => order.contractId === contractId);
}

function updateStatus(message) {
  uiState.status = message;
  const statusEl = document.getElementById('primaryDocsStatus');
  if (statusEl) statusEl.textContent = message || '';
}

function findDraft(id) {
  return uiState.drafts.find(doc => sameId(doc.id, id)) || null;
}

function findSaved(id) {
  return (state.primaryDocs || []).find(doc => sameId(doc.id, id)) || null;
}

function setDocField(kind, id, field, value) {
  const target = kind === 'draft' ? findDraft(id) : findSaved(id);
  if (!target) return;

  if (field.startsWith('seller.')) {
    target.seller[field.split('.')[1]] = value;
  } else if (field.startsWith('buyer.')) {
    target.buyer[field.split('.')[1]] = value;
  } else if (field.startsWith('contract.')) {
    target.contract[field.split('.')[1]] = value;
  } else {
    target[field] = value;
  }

  if (field === 'contractId') {
    const numericValue = value ? Number(value) : null;
    target.contractId = Number.isFinite(numericValue) ? numericValue : null;
    const orders = getOrdersForContract(target.contractId);
    if (!orders.some(order => order.id === target.orderId)) target.orderId = null;
  }

  if (field === 'orderId') {
    const numericValue = value ? Number(value) : null;
    target.orderId = Number.isFinite(numericValue) ? numericValue : null;
  }
}

function cloneDocData(value) {
  if (typeof structuredClone === 'function') return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function getEventElement(target) {
  if (target instanceof Element) return target;
  if (target && target.parentElement instanceof Element) return target.parentElement;
  return null;
}

function emitPrimaryDocsChanged(detail = {}) {
  try {
    window.dispatchEvent(new CustomEvent('primary-docs-changed', { detail }));
  } catch {
    // ignore event dispatch issues
  }
}

function syncDocFromDom(kind, id) {
  const target = kind === 'draft' ? findDraft(id) : findSaved(id);
  if (!target) return null;

  const fields = document.querySelectorAll(
    `[data-kind="${kind}"][data-id="${id}"][data-field]`,
  );

  fields.forEach((fieldEl) => {
    const field = fieldEl.dataset.field;
    if (!field) return;
    setDocField(kind, id, field, fieldEl.value);
  });

  return target;
}

function removeQueuedFile(id) {
  uiState.queue = uiState.queue.filter(file => file.id !== id);
  renderQueue();
}

function clearQueue() {
  uiState.queue = [];
  renderQueue();
}

function renderQueue() {
  const wrap = document.getElementById('primaryDocsQueue');
  const countEl = document.getElementById('primaryDocsQueueCount');
  if (!wrap || !countEl) return;

  countEl.textContent = uiState.queue.length ? `${uiState.queue.length} файл(ов)` : '';

  if (!uiState.queue.length) {
    wrap.innerHTML = '<p style="color:#64748b;font-size:0.78rem;">Файлы пока не добавлены.</p>';
    return;
  }

  wrap.innerHTML = uiState.queue.map(file => `
    <div style="display:flex;align-items:center;gap:0.5rem;padding:0.45rem 0.55rem;border:1px solid rgba(255,255,255,0.08);border-radius:0.7rem;background:rgba(255,255,255,0.03);margin-bottom:0.35rem;">
      <span style="font-size:0.95rem;">📄</span>
      <div style="flex:1;min-width:0;">
        <div style="color:#e2e8f0;font-size:0.78rem;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(file.file.name)}</div>
        <div style="color:#64748b;font-size:0.68rem;">${Math.max(1, Math.round(file.file.size / 1024))} KB</div>
      </div>
      <button type="button" data-action="remove-queue" data-id="${file.id}" style="border:none;background:transparent;color:#94a3b8;cursor:pointer;font-size:0.95rem;">✕</button>
    </div>
  `).join('');
}

function renderTabs() {
  const draftsBtn = document.getElementById('primaryDocsTabDrafts');
  const registryBtn = document.getElementById('primaryDocsTabRegistry');
  if (!draftsBtn || !registryBtn) return;

  const setActive = (btn, active) => {
    btn.style.background = active ? 'rgba(6,182,212,0.18)' : 'rgba(255,255,255,0.04)';
    btn.style.color = active ? '#fff' : '#94a3b8';
    btn.style.borderColor = active ? 'rgba(6,182,212,0.35)' : 'rgba(255,255,255,0.08)';
  };

  setActive(draftsBtn, uiState.activeTab === 'drafts');
  setActive(registryBtn, uiState.activeTab === 'registry');
  syncRegistryToolbar();
}

function renderDrafts() {
  const wrap = document.getElementById('primaryDocsContent');
  if (!wrap) return;

  if (!uiState.drafts.length) {
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.75rem;min-height:320px;text-align:center;">
        <div style="font-size:3rem;">📄</div>
        <div style="font-size:1rem;font-weight:700;color:#fff;">Черновиков пока нет</div>
        <div style="max-width:420px;color:#64748b;font-size:0.82rem;line-height:1.6;">
          Загрузите первичные документы слева и нажмите «Распознать файлы». Модуль извлечёт номер, дату, продавца, покупателя, договор, табличную часть и суммы.
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = uiState.drafts.map(doc => renderDocCard(doc, 'draft')).join('');
}

function renderRegistry() {
  const wrap = document.getElementById('primaryDocsContent');
  if (!wrap) return;

  const docs = getSavedRegistryDocs();
  const selected = ensureRegistrySelection(docs);

  if (!docs.length) {
    wrap.innerHTML = `
      <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:0.75rem;min-height:320px;text-align:center;">
        <div style="font-size:3rem;">🗂️</div>
        <div style="font-size:1rem;font-weight:700;color:#fff;">Реестр пуст</div>
        <div style="max-width:420px;color:#64748b;font-size:0.82rem;line-height:1.6;">
          Сохранённые карточки первичных документов будут появляться здесь.
        </div>
      </div>`;
    return;
  }

  wrap.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(320px,420px) minmax(0,1fr);gap:1rem;align-items:start;min-height:100%;">
      <section style="display:flex;flex-direction:column;min-height:0;border:1px solid rgba(255,255,255,0.08);border-radius:1.15rem;background:rgba(255,255,255,0.03);overflow:hidden;">
        <div style="padding:0.9rem;border-bottom:1px solid rgba(255,255,255,0.08);display:flex;flex-direction:column;gap:0.7rem;background:rgba(15,23,42,0.58);">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;flex-wrap:wrap;">
            <div>
              <div style="font-size:0.82rem;font-weight:800;color:#fff;">Реестр первичных документов</div>
              <div style="margin-top:0.2rem;font-size:0.72rem;color:#64748b;">${docs.length} документ(ов) по текущему фильтру</div>
            </div>
          </div>
          <div style="font-size:0.72rem;color:#94a3b8;">Используйте фильтры в верхней панели справа.</div>
        </div>
        <div style="flex:1;min-height:0;overflow:auto;padding:0.7rem;display:flex;flex-direction:column;gap:0.65rem;">
          ${docs.map(doc => renderRegistryListRow(doc, selected)).join('')}
        </div>
      </section>
      <section style="min-width:0;min-height:0;">
        ${selected ? renderDocCard(selected, 'saved') : `
          <div style="display:flex;align-items:center;justify-content:center;min-height:320px;border:1px dashed rgba(255,255,255,0.08);border-radius:1.15rem;background:rgba(255,255,255,0.02);color:#64748b;font-size:0.82rem;">
            Выберите документ слева
          </div>`}
      </section>
    </div>`;
}

function renderRegistryListRow(doc, selectedDoc) {
  const selected = sameId(doc.id, selectedDoc?.id);
  const contractNumber = getDocContractNumberText(doc) || '—';
  const linkedContract = getLinkedContract(doc);
  const totalAmount = doc.totals?.amountWithVat || doc.totals?.amountNoVat || '—';
  const stamp = doc.updatedAt || doc.savedAt || '';
  const dateLabel = stamp ? new Date(stamp).toLocaleString('ru-RU') : '—';

  return `
    <button type="button" data-action="select-saved" data-id="${doc.id}" onclick="window.__primaryDocsUi?.selectSaved(this.getAttribute('data-id')); return false;" style="width:100%;text-align:left;border:1px solid ${selected ? 'rgba(34,211,238,0.35)' : 'rgba(255,255,255,0.08)'};border-radius:1rem;background:${selected ? 'rgba(6,182,212,0.1)' : 'rgba(255,255,255,0.03)'};padding:0.85rem;cursor:pointer;transition:0.18s;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:0.75rem;">
        <div style="min-width:0;flex:1;">
          <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;">
            <span style="font-size:0.7rem;font-weight:800;color:${selected ? '#67e8f9' : '#94a3b8'};text-transform:uppercase;letter-spacing:0.05em;">${escHtml(getDocTypeLabel(doc.docType))}</span>
            <span style="font-size:0.8rem;font-weight:700;color:#fff;">${escHtml(doc.number || 'без номера')}</span>
          </div>
          <div style="margin-top:0.3rem;font-size:0.8rem;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(doc.title || doc.sourceName || 'Документ')}</div>
        </div>
        <span style="padding:0.22rem 0.5rem;border-radius:999px;background:rgba(255,255,255,0.05);font-size:0.68rem;color:#cbd5e1;flex-shrink:0;">${escHtml(doc.date || 'без даты')}</span>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.55rem;margin-top:0.7rem;">
        <div>
          <div style="font-size:0.66rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Контракт</div>
          <div style="margin-top:0.18rem;font-size:0.76rem;color:#fff;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(linkedContract?.number || contractNumber)}</div>
        </div>
        <div>
          <div style="font-size:0.66rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Сумма</div>
          <div style="margin-top:0.18rem;font-size:0.76rem;color:#86efac;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(totalAmount)}</div>
        </div>
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:0.55rem;margin-top:0.55rem;">
        <div>
          <div style="font-size:0.66rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Продавец</div>
          <div style="margin-top:0.18rem;font-size:0.74rem;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(doc.seller?.name || '—')}</div>
        </div>
        <div>
          <div style="font-size:0.66rem;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">Обновлён</div>
          <div style="margin-top:0.18rem;font-size:0.74rem;color:#cbd5e1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(dateLabel)}</div>
        </div>
      </div>
    </button>`;
}

function renderDocCard(doc, kind) {
  const contractOptions = (state.contracts || []).map(contract => {
    const selected = Number(doc.contractId) === Number(contract.id) ? 'selected' : '';
    return `<option value="${contract.id}" ${selected}>${escHtml(contract.number || contract.title || ('Контракт #' + contract.id))}</option>`;
  }).join('');

  const orderOptions = getOrdersForContract(Number(doc.contractId)).map(order => {
    const selected = Number(doc.orderId) === Number(order.id) ? 'selected' : '';
    return `<option value="${order.id}" ${selected}>${escHtml(order.orderNumber || ('Заявка #' + order.id))}</option>`;
  }).join('');

  const issuesHtml = (doc.issues || []).length
    ? `<div style="margin-top:0.8rem;padding:0.7rem 0.8rem;border-radius:0.8rem;background:rgba(245,158,11,0.08);border:1px solid rgba(245,158,11,0.18);">
        <div style="color:#fbbf24;font-size:0.72rem;font-weight:700;margin-bottom:0.35rem;">Замечания по документу</div>
        ${(doc.issues || []).map(issue => `<div style="color:#fcd34d;font-size:0.76rem;line-height:1.45;margin-bottom:0.2rem;">• ${escHtml(issue)}</div>`).join('')}
      </div>`
    : '';

  const itemsTable = (doc.items || []).length
    ? `<div style="margin-top:0.8rem;overflow:auto;border:1px solid rgba(255,255,255,0.08);border-radius:0.9rem;">
        <table style="width:100%;border-collapse:collapse;min-width:920px;">
          <thead>
            <tr style="background:rgba(255,255,255,0.04);">
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:left;">#</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:left;">Код</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:left;">Наименование</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:left;">Ед.</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:right;">Кол-во</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:right;">Цена</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:right;">Без НДС</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:right;">НДС</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:right;">С НДС</th>
              <th style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.08);font-size:0.7rem;color:#94a3b8;text-align:left;">Страна</th>
            </tr>
          </thead>
          <tbody>
            ${(doc.items || []).map(item => `
              <tr>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;">${escHtml(item.line)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;">${escHtml(item.code)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#fff;min-width:260px;">${escHtml(item.name)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;">${escHtml(item.unit || item.unitCode)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;text-align:right;">${escHtml(item.qty)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;text-align:right;">${escHtml(item.price)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;text-align:right;">${escHtml(item.amountNoVat)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;text-align:right;">${escHtml(item.vatAmount)} ${item.vatRate ? `<span style="color:#64748b;">(${escHtml(item.vatRate)})</span>` : ''}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#fff;text-align:right;">${escHtml(item.amountWithVat)}</td>
                <td style="padding:0.55rem;border-bottom:1px solid rgba(255,255,255,0.05);font-size:0.76rem;color:#cbd5e1;">${escHtml(item.country)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '<div style="margin-top:0.8rem;color:#64748b;font-size:0.78rem;">Табличная часть не извлечена.</div>';

  const saveLabel = kind === 'draft' ? 'Сохранить в реестр' : 'Сохранить изменения';
  const actionButtons = kind === 'draft'
    ? `<button type="button" data-action="save-draft" data-id="${doc.id}" onclick="window.__primaryDocsUi?.saveDraft(this.getAttribute('data-id')); return false;" style="border:none;border-radius:0.8rem;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#082f49;padding:0.75rem 1rem;font-weight:700;cursor:pointer;">${saveLabel}</button>`
    : `<button type="button" data-action="save-saved" data-id="${doc.id}" onclick="window.__primaryDocsUi?.saveSaved(this.getAttribute('data-id')); return false;" style="border:none;border-radius:0.8rem;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#082f49;padding:0.75rem 1rem;font-weight:700;cursor:pointer;">${saveLabel}</button>
       <button type="button" data-action="delete-saved" data-id="${doc.id}" onclick="window.__primaryDocsUi?.deleteSaved(this.getAttribute('data-id')); return false;" style="border:1px solid rgba(239,68,68,0.35);border-radius:0.8rem;background:rgba(239,68,68,0.08);color:#fca5a5;padding:0.75rem 1rem;font-weight:700;cursor:pointer;">Удалить</button>`;

  return `
    <section style="border:1px solid rgba(255,255,255,0.08);border-radius:1.2rem;background:rgba(255,255,255,0.03);padding:1rem;margin-bottom:1rem;">
      <div style="display:flex;flex-wrap:wrap;gap:0.6rem;align-items:center;justify-content:space-between;">
        <div>
          <div style="display:flex;align-items:center;gap:0.45rem;flex-wrap:wrap;">
            <span style="font-size:1.1rem;">📄</span>
            <span style="font-size:0.96rem;font-weight:700;color:#fff;">${escHtml(doc.title || doc.sourceName || 'Документ')}</span>
            <span style="padding:0.18rem 0.45rem;border-radius:999px;background:rgba(6,182,212,0.14);color:#67e8f9;font-size:0.68rem;font-weight:700;">${escHtml(getDocTypeLabel(doc.docType))}</span>
            ${doc.extractMethod ? `<span style="padding:0.18rem 0.45rem;border-radius:999px;background:rgba(255,255,255,0.06);color:#94a3b8;font-size:0.68rem;">${escHtml(doc.extractMethod)}</span>` : ''}
          </div>
          <div style="margin-top:0.25rem;color:#64748b;font-size:0.72rem;">Источник: ${escHtml(doc.sourceName || '—')} · символов: ${escHtml(doc.extractedLength || 0)}</div>
        </div>
        <div style="display:flex;gap:0.5rem;flex-wrap:wrap;">${actionButtons}</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.8rem;margin-top:1rem;">
        ${renderInputField(kind, doc.id, 'title', 'Название карточки', doc.title)}
        ${renderSelectField(kind, doc.id, 'docType', 'Тип документа', DOC_TYPE_OPTIONS, doc.docType)}
        ${renderInputField(kind, doc.id, 'number', 'Номер документа', doc.number)}
        ${renderInputField(kind, doc.id, 'date', 'Дата документа', doc.date)}
        ${renderInputField(kind, doc.id, 'status', 'Статус УПД', doc.status)}
        ${renderInputField(kind, doc.id, 'field8', 'Поле 8 УПД', doc.field8)}
        ${renderInputField(kind, doc.id, 'shipmentDate', 'Дата отгрузки', doc.shipmentDate)}
        ${renderInputField(kind, doc.id, 'receiveDate', 'Дата приёмки', doc.receiveDate)}
        ${renderInputField(kind, doc.id, 'signDate', 'Дата подписи', doc.signDate)}
        ${renderInputField(kind, doc.id, 'currency', 'Валюта', doc.currency)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.8rem;margin-top:0.8rem;">
        ${renderInputField(kind, doc.id, 'seller.name', 'Продавец', doc.seller?.name)}
        ${renderInputField(kind, doc.id, 'buyer.name', 'Покупатель', doc.buyer?.name)}
        ${renderInputField(kind, doc.id, 'seller.inn', 'ИНН продавца', doc.seller?.inn)}
        ${renderInputField(kind, doc.id, 'buyer.inn', 'ИНН покупателя', doc.buyer?.inn)}
        ${renderInputField(kind, doc.id, 'seller.kpp', 'КПП продавца', doc.seller?.kpp)}
        ${renderInputField(kind, doc.id, 'buyer.kpp', 'КПП покупателя', doc.buyer?.kpp)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.8rem;margin-top:0.8rem;">
        ${renderInputField(kind, doc.id, 'contract.number', '№ договора', doc.contract?.number)}
        ${renderInputField(kind, doc.id, 'contract.date', 'Дата договора', doc.contract?.date)}
      </div>

      <div style="display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0.8rem;margin-top:0.8rem;">
        <label style="display:flex;flex-direction:column;gap:0.35rem;">
          <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Контракт в проекте</span>
          <select data-kind="${kind}" data-id="${doc.id}" data-field="contractId" style="width:100%;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;">
            <option value="">— Не привязан —</option>
            ${contractOptions}
          </select>
        </label>
        <label style="display:flex;flex-direction:column;gap:0.35rem;">
          <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Заявка</span>
          <select data-kind="${kind}" data-id="${doc.id}" data-field="orderId" style="width:100%;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;">
            <option value="">— Не привязана —</option>
            ${orderOptions}
          </select>
        </label>
      </div>

      <div style="display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:0.8rem;margin-top:0.8rem;">
        ${renderReadonlyStat('Итого qty', doc.totals?.qty)}
        ${renderReadonlyStat('Без НДС', doc.totals?.amountNoVat)}
        ${renderReadonlyStat('НДС', doc.totals?.vatAmount)}
        ${renderReadonlyStat('С НДС', doc.totals?.amountWithVat)}
      </div>

      ${itemsTable}
      ${issuesHtml}

      <details style="margin-top:0.8rem;border:1px solid rgba(255,255,255,0.08);border-radius:0.9rem;background:rgba(255,255,255,0.02);padding:0.65rem 0.8rem;">
        <summary style="cursor:pointer;color:#94a3b8;font-size:0.76rem;font-weight:700;">Показать извлечённый текст</summary>
        <pre style="white-space:pre-wrap;word-break:break-word;font-size:0.72rem;line-height:1.55;color:#cbd5e1;margin:0.75rem 0 0;">${escHtml(doc.extractedPreview || 'Текст не сохранён')}</pre>
      </details>

      <label style="display:flex;flex-direction:column;gap:0.35rem;margin-top:0.8rem;">
        <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">Комментарий</span>
        <textarea data-kind="${kind}" data-id="${doc.id}" data-field="notes" rows="3" style="width:100%;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.75rem 0.85rem;color:#fff;resize:vertical;">${escHtml(doc.notes || '')}</textarea>
      </label>
    </section>`;
}

function renderInputField(kind, id, field, label, value) {
  return `
    <label style="display:flex;flex-direction:column;gap:0.35rem;">
      <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(label)}</span>
      <input type="text" value="${escHtml(value || '')}" data-kind="${kind}" data-id="${id}" data-field="${field}" style="width:100%;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;">
    </label>`;
}

function renderSelectField(kind, id, field, label, options, value) {
  return `
    <label style="display:flex;flex-direction:column;gap:0.35rem;">
      <span style="font-size:0.72rem;font-weight:700;color:#94a3b8;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(label)}</span>
      <select data-kind="${kind}" data-id="${id}" data-field="${field}" style="width:100%;border-radius:0.8rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;">
        ${options.map(([optionValue, optionLabel]) => `<option value="${escHtml(optionValue)}" ${String(value) === String(optionValue) ? 'selected' : ''}>${escHtml(optionLabel)}</option>`).join('')}
      </select>
    </label>`;
}

function renderReadonlyStat(label, value) {
  return `
    <div style="border:1px solid rgba(255,255,255,0.08);border-radius:0.9rem;background:rgba(255,255,255,0.03);padding:0.75rem 0.85rem;">
      <div style="font-size:0.68rem;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:0.05em;">${escHtml(label)}</div>
      <div style="margin-top:0.25rem;color:#fff;font-size:0.85rem;font-weight:700;">${escHtml(value || '—')}</div>
    </div>`;
}

function bindRenderedActionButtons() {
  const root = document.getElementById('primaryDocsContent');
  if (!root) return;

  root.querySelectorAll('[data-action="select-saved"]').forEach((btn) => {
    btn.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      uiState.registrySelectedId = btn.dataset.id;
      renderRegistry();
    };
  });

  root.querySelectorAll('[data-action="save-draft"]').forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await saveDraft(btn.dataset.id);
    };
  });

  root.querySelectorAll('[data-action="save-saved"]').forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await saveExisting(btn.dataset.id);
    };
  });

  root.querySelectorAll('[data-action="delete-saved"]').forEach((btn) => {
    btn.onclick = async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await removeExisting(btn.dataset.id);
    };
  });
}

function renderContent() {
  renderTabs();
  if (uiState.activeTab === 'registry') renderRegistry();
  else renderDrafts();

  bindRenderedActionButtons();

  const savedCountEl = document.getElementById('primaryDocsSavedCount');
  const draftCountEl = document.getElementById('primaryDocsDraftCount');
  if (savedCountEl) savedCountEl.textContent = (state.primaryDocs || []).length ? String((state.primaryDocs || []).length) : '0';
  if (draftCountEl) draftCountEl.textContent = uiState.drafts.length ? String(uiState.drafts.length) : '0';
}

function exposeGlobalPrimaryDocsUi() {
  window.__primaryDocsUi = {
    selectSaved(id) {
      uiState.registrySelectedId = id;
      renderRegistry();
    },
    async saveDraft(id) {
      await saveDraft(id);
    },
    async saveSaved(id) {
      await saveExisting(id);
    },
    async deleteSaved(id) {
      await removeExisting(id);
    },
  };
}

async function analyzeQueue() {
  if (uiState.analyzing) return;
  if (!uiState.queue.length) {
    showToast('Сначала выберите файлы', 'info');
    return;
  }

  uiState.analyzing = true;
  uiState.drafts = [];
  uiState.activeTab = 'drafts';
  renderContent();
  updateStatus('Подготовка к распознаванию...');

  try {
    updateStatus('Проверка server handler...');
    await ensureHandlerReady();

    for (let i = 0; i < uiState.queue.length; i++) {
      const entry = uiState.queue[i];
      const extracted = await extractDocumentText(entry, i + 1, uiState.queue.length);

      const text = String(extracted?.text || '').trim();
      if (!text || text.length < 20) {
        uiState.drafts.push(normalizeDoc({ title: entry.file.name, issues: ['Не удалось извлечь текст'] }, {
          id: 'draft-' + entry.id,
          sourceName: entry.file.name,
          extractMethod: extracted?.method || '-',
          extractedLength: extracted?.length || 0,
          extractedPreview: compactText(text || ''),
        }));
        renderContent();
        continue;
      }

      updateStatus(`Файл ${i + 1}/${uiState.queue.length}: анализ документа — ${entry.file.name}`);
      const analysis = await fetch(getHandlerUrl('analyze'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'analyze',
          system: PRIMARY_DOC_PROMPT,
          messages: [{ role: 'user', content: `Файл: ${entry.file.name}\n\nТекст документа:\n${text.slice(0, 140000)}` }],
          max_tokens: 12000,
        }),
      }).then(readServerJson);

      const parsed = parseJsonObject(analysis?.text || '');
      if (!parsed) {
        uiState.drafts.push(normalizeDoc({
          title: entry.file.name,
          issues: ['DeepSeek не вернул корректный JSON по документу'],
        }, {
          id: 'draft-' + entry.id,
          sourceName: entry.file.name,
          extractMethod: extracted?.method || '-',
          extractedLength: extracted?.length || text.length,
          extractedPreview: compactText(text),
        }));
      } else {
        uiState.drafts.push(normalizeDoc(parsed, {
          id: 'draft-' + entry.id,
          sourceName: entry.file.name,
          extractMethod: extracted?.method || '-',
          extractedLength: extracted?.length || text.length,
          extractedPreview: compactText(text),
        }));
      }

      renderContent();
    }

    updateStatus(`Готово: распознано ${uiState.drafts.length} файл(ов)`);
    showToast('Первичные документы распознаны', 'success');
  } catch (error) {
    console.error('[primary-docs]', error);
    updateStatus('Ошибка: ' + (error.message || 'неизвестная ошибка'));
    showToast('Ошибка модуля первички: ' + (error.message || 'неизвестная ошибка'), 'error');
  } finally {
    uiState.analyzing = false;
  }
}

async function saveDraft(id) {
  const draft = syncDocFromDom('draft', id) || findDraft(id);
  if (!draft) return;
  const saved = savePrimaryDoc(cloneDocData(draft));
  await saveToStorage();
  uiState.drafts = uiState.drafts.filter(doc => !sameId(doc.id, id));
  renderContent();
  emitPrimaryDocsChanged({ contractId: saved.contractId ?? null, docId: saved.id, action: 'save' });
  showToast(`Документ «${saved.title || saved.sourceName}» сохранён`, 'success');
}

async function saveAllDrafts() {
  if (!uiState.drafts.length) {
    showToast('Нет черновиков для сохранения', 'info');
    return;
  }
  uiState.drafts.forEach(doc => syncDocFromDom('draft', doc.id));
  const docs = uiState.drafts.map(doc => cloneDocData(doc));
  const savedDocs = docs.map(doc => savePrimaryDoc(doc));
  await saveToStorage();
  uiState.drafts = [];
  uiState.activeTab = 'registry';
  renderContent();
  emitPrimaryDocsChanged({
    contractIds: [...new Set(savedDocs.map(doc => doc.contractId).filter(Boolean))],
    action: 'save-all',
  });
  showToast('Все черновики сохранены в реестр', 'success');
}

async function saveExisting(id) {
  try {
    const doc = syncDocFromDom('saved', id) || findSaved(id);
    if (!doc) {
      showToast('Документ не найден в реестре', 'error');
      return;
    }
    const updated = updatePrimaryDoc(id, cloneDocData(doc));
    if (!updated) {
      showToast('Не удалось сохранить документ', 'error');
      return;
    }
    await saveToStorage();
    uiState.registrySelectedId = updated.id;
    renderContent();
    emitPrimaryDocsChanged({ contractId: updated.contractId ?? null, docId: updated.id, action: 'update' });
    showToast('Изменения сохранены', 'success');
  } catch (error) {
    console.error('[primary-docs] saveExisting failed', error);
    showToast('Ошибка сохранения: ' + (error?.message || 'неизвестная ошибка'), 'error');
  }
}

async function removeExisting(id) {
  try {
    const doc = findSaved(id) || findSaved(uiState.registrySelectedId);
    if (!doc) {
      showToast('Документ не найден в реестре', 'error');
      return;
    }
    if (!confirmDeleteWithImpact({
      title: 'Удалить первичный документ?',
      subject: doc.title || doc.sourceName || 'без названия',
      impacts: [
        'документ будет удалён из реестра первички',
      ],
      risks: [
        'связанные контракт, заявка и другие документы не удаляются автоматически',
      ],
    })) return;
    let deleted = deletePrimaryDoc(doc.id);
    if (!deleted) {
      const list = state.primaryDocs || [];
      const idx = list.findIndex(item => sameId(item.id, doc.id) || sameId(item.id, id));
      if (idx !== -1) {
        list.splice(idx, 1);
        deleted = true;
      }
    }
    if (!deleted) {
      showToast('Не удалось удалить документ', 'error');
      return;
    }
    await saveToStorage();
    const remaining = getSavedRegistryDocs();
    const nextSelected = remaining.find(item => !sameId(item.id, doc.id)) || remaining[0] || null;
    uiState.registrySelectedId = nextSelected?.id ?? null;
    renderContent();
    emitPrimaryDocsChanged({ contractId: doc.contractId ?? null, docId: doc.id, action: 'delete' });
    showToast('Документ удалён', 'success');
  } catch (error) {
    console.error('[primary-docs] removeExisting failed', error);
    showToast('Ошибка удаления: ' + (error?.message || 'неизвестная ошибка'), 'error');
  }
}

function attachEvents(modal) {
  modal.addEventListener('click', async (event) => {
    const targetEl = getEventElement(event.target);
    const actionEl = targetEl?.closest('[data-action]');
    if (actionEl) {
      event.preventDefault();
      event.stopPropagation();
      const action = actionEl.dataset.action;
      const id = actionEl.dataset.id;
      if (action === 'remove-queue') removeQueuedFile(Number(id));
      if (action === 'select-saved') {
        uiState.registrySelectedId = id;
        renderRegistry();
      }
      if (action === 'save-draft') await saveDraft(id);
      if (action === 'save-saved') await saveExisting(id);
      if (action === 'delete-saved') await removeExisting(id);
      return;
    }

    const target = targetEl;
    if (!target) return;
    if (target.id === 'primaryDocsBtn') openPrimaryDocsModal();
    if (target.id === 'primaryDocsClose' || target.id === 'primaryDocsCloseFooter') closePrimaryDocsModal();
    if (target.id === 'primaryDocsAnalyze') analyzeQueue();
    if (target.id === 'primaryDocsClearQueue') clearQueue();
    if (target.id === 'primaryDocsSaveAll') saveAllDrafts();
    if (target.id === 'primaryDocsTabDrafts') { uiState.activeTab = 'drafts'; renderContent(); }
    if (target.id === 'primaryDocsTabRegistry') { uiState.activeTab = 'registry'; renderContent(); }
  });

  modal.addEventListener('input', (event) => {
    const targetEl = getEventElement(event.target);
    const fieldEl = targetEl?.closest('[data-field]');
    if (fieldEl) {
      setDocField(fieldEl.dataset.kind, fieldEl.dataset.id, fieldEl.dataset.field, fieldEl.value);
    }

    if (targetEl?.id === 'primaryDocsToolbarSearch') {
      uiState.registrySearch = targetEl.value || '';
      if (uiState.activeTab === 'registry') renderRegistry();
    }

    if (targetEl?.id === 'primaryDocsToolbarContract') {
      uiState.registryContractFilter = targetEl.value || '';
      if (uiState.activeTab === 'registry') renderRegistry();
    }
  });

  modal.addEventListener('change', (event) => {
    const targetEl = getEventElement(event.target);
    const fieldEl = targetEl?.closest('[data-field]');
    if (fieldEl) {
      setDocField(fieldEl.dataset.kind, fieldEl.dataset.id, fieldEl.dataset.field, fieldEl.value);
      if (fieldEl.dataset.field === 'contractId' || fieldEl.dataset.field === 'orderId') {
        if (fieldEl.dataset.kind === 'saved') uiState.registrySelectedId = fieldEl.dataset.id;
        renderContent();
      }
    }

    if (targetEl?.id === 'primaryDocsFileInput') {
      const files = Array.from(targetEl.files || []);
      files.forEach(file => {
        uiState.queue.push({ id: uiState.nextQueueId++, file });
      });
      targetEl.value = '';
      renderQueue();
    }
  });

  modal.addEventListener('dragover', (event) => {
    const targetEl = getEventElement(event.target);
    const dropZone = targetEl?.closest('#primaryDocsDropZone');
    if (!dropZone) return;
    event.preventDefault();
    dropZone.style.borderColor = 'rgba(6,182,212,0.45)';
    dropZone.style.background = 'rgba(6,182,212,0.06)';
  });

  modal.addEventListener('dragleave', (event) => {
    const targetEl = getEventElement(event.target);
    const dropZone = targetEl?.closest('#primaryDocsDropZone');
    if (!dropZone) return;
    dropZone.style.borderColor = 'rgba(255,255,255,0.12)';
    dropZone.style.background = 'rgba(255,255,255,0.03)';
  });

  modal.addEventListener('drop', (event) => {
    const targetEl = getEventElement(event.target);
    const dropZone = targetEl?.closest('#primaryDocsDropZone');
    if (!dropZone) return;
    event.preventDefault();
    dropZone.style.borderColor = 'rgba(255,255,255,0.12)';
    dropZone.style.background = 'rgba(255,255,255,0.03)';
    const files = Array.from(event.dataTransfer?.files || []);
    files.forEach(file => {
      uiState.queue.push({ id: uiState.nextQueueId++, file });
    });
    renderQueue();
  });
}

function ensureModal() {
  let modal = document.getElementById('primaryDocsModal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'primaryDocsModal';
    modal.style.cssText = 'position:fixed;inset:0;z-index:340;display:none;background:rgba(2,6,23,0.78);backdrop-filter:blur(6px);';
    modal.innerHTML = `
      <div style="width:100%;height:100%;display:flex;flex-direction:column;background:#020617;">
        <div style="display:flex;align-items:center;justify-content:space-between;padding:1rem 1.25rem;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(2,6,23,0.88);">
          <div style="display:flex;align-items:center;gap:0.85rem;">
            <button id="primaryDocsClose" type="button" style="border:none;background:rgba(255,255,255,0.05);color:#94a3b8;border-radius:0.8rem;padding:0.55rem 0.75rem;cursor:pointer;">←</button>
            <div>
              <div style="font-size:0.75rem;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#22d3ee;">Первичные документы</div>
              <div style="font-size:1.05rem;font-weight:800;color:#fff;">Распознавание и реестр первички</div>
            </div>
          </div>
          <div style="display:flex;gap:0.55rem;align-items:center;flex-wrap:wrap;">
            <span style="padding:0.25rem 0.55rem;border-radius:999px;background:rgba(255,255,255,0.06);color:#cbd5e1;font-size:0.72rem;">Черновики: <b id="primaryDocsDraftCount">0</b></span>
            <span style="padding:0.25rem 0.55rem;border-radius:999px;background:rgba(255,255,255,0.06);color:#cbd5e1;font-size:0.72rem;">В реестре: <b id="primaryDocsSavedCount">0</b></span>
          </div>
        </div>

        <div style="flex:1;min-height:0;display:flex;overflow:hidden;">
          <aside style="width:360px;max-width:42vw;flex-shrink:0;border-right:1px solid rgba(255,255,255,0.08);background:rgba(15,23,42,0.72);overflow:auto;padding:1rem;">
            <div style="padding:0.9rem;border:1px solid rgba(6,182,212,0.16);background:rgba(6,182,212,0.05);border-radius:1rem;line-height:1.55;">
              <div style="font-size:0.85rem;font-weight:800;color:#fff;">📄 Модуль первички</div>
              <div style="margin-top:0.35rem;color:#94a3b8;font-size:0.76rem;">Работает по логике doc-checker: извлекает текст через server handler, отправляет в DeepSeek и строит структурированную карточку документа.</div>
            </div>

            <div id="primaryDocsDropZone" style="margin-top:0.9rem;border:1.5px dashed rgba(255,255,255,0.12);border-radius:1rem;background:rgba(255,255,255,0.03);padding:1.1rem;text-align:center;cursor:pointer;" onclick="document.getElementById('primaryDocsFileInput').click()">
              <div style="font-size:2rem;">📂</div>
              <div style="margin-top:0.35rem;color:#fff;font-size:0.85rem;font-weight:700;">Выберите файлы первички</div>
              <div style="margin-top:0.2rem;color:#64748b;font-size:0.72rem;">PDF, DOCX, XLSX, TXT · можно несколько</div>
              <input id="primaryDocsFileInput" type="file" multiple accept=".pdf,.docx,.doc,.xlsx,.xls,.txt,.csv,.md" style="display:none;" />
            </div>

            <div style="display:flex;gap:0.55rem;margin-top:0.9rem;">
              <button id="primaryDocsAnalyze" type="button" style="flex:1;border:none;border-radius:0.9rem;background:linear-gradient(135deg,#06b6d4,#22d3ee);color:#082f49;padding:0.85rem 1rem;font-weight:800;cursor:pointer;">Распознать файлы</button>
              <button id="primaryDocsSaveAll" type="button" style="border:1px solid rgba(16,185,129,0.25);border-radius:0.9rem;background:rgba(16,185,129,0.08);color:#6ee7b7;padding:0.85rem 1rem;font-weight:800;cursor:pointer;">Сохранить все</button>
            </div>

            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:1rem;margin-bottom:0.5rem;">
              <div style="font-size:0.74rem;font-weight:800;color:#94a3b8;text-transform:uppercase;letter-spacing:0.06em;">Очередь файлов <span id="primaryDocsQueueCount" style="color:#64748b;"></span></div>
              <button id="primaryDocsClearQueue" type="button" style="border:none;background:transparent;color:#fda4af;font-size:0.72rem;cursor:pointer;">Очистить</button>
            </div>
            <div id="primaryDocsQueue"></div>

            <div id="primaryDocsStatus" style="margin-top:1rem;min-height:1rem;color:#94a3b8;font-size:0.78rem;"></div>
          </aside>

          <main style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:0.8rem;padding:0.9rem 1rem;border-bottom:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.02);">
              <div style="display:flex;gap:0.55rem;align-items:center;">
                <button id="primaryDocsTabDrafts" type="button" style="border:1px solid rgba(255,255,255,0.08);border-radius:999px;padding:0.55rem 0.9rem;background:rgba(6,182,212,0.18);color:#fff;font-size:0.78rem;font-weight:800;cursor:pointer;">Черновики</button>
                <button id="primaryDocsTabRegistry" type="button" style="border:1px solid rgba(255,255,255,0.08);border-radius:999px;padding:0.55rem 0.9rem;background:rgba(255,255,255,0.04);color:#94a3b8;font-size:0.78rem;font-weight:800;cursor:pointer;">Реестр</button>
              </div>
              <div id="primaryDocsRegistryToolbar" style="display:none;grid-template-columns:minmax(220px,300px) minmax(180px,220px);gap:0.55rem;align-items:center;">
                <input id="primaryDocsToolbarSearch" type="search" placeholder="Поиск по документу, продавцу, номеру…" style="width:100%;border-radius:0.9rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;" />
                <input id="primaryDocsToolbarContract" type="search" placeholder="Номер контракта…" style="width:100%;border-radius:0.9rem;border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.04);padding:0.7rem 0.85rem;color:#fff;" />
              </div>
            </div>
            <div id="primaryDocsContent" style="flex:1;min-height:0;overflow:auto;padding:1rem 1rem 5rem;"></div>
            <div style="padding:0.85rem 1rem;border-top:1px solid rgba(255,255,255,0.08);display:flex;justify-content:flex-end;background:rgba(2,6,23,0.88);">
              <button id="primaryDocsCloseFooter" type="button" style="border:1px solid rgba(255,255,255,0.12);border-radius:0.9rem;background:rgba(255,255,255,0.05);color:#cbd5e1;padding:0.75rem 1rem;font-weight:700;cursor:pointer;">Закрыть</button>
            </div>
          </main>
        </div>
      </div>`;
    document.body.appendChild(modal);
    attachEvents(modal);
  }

  return modal;
}

export function openPrimaryDocsModal() {
  const modal = ensureModal();
  modal.style.display = 'block';
  renderQueue();
  renderContent();
  updateStatus(uiState.status);
}

export function openPrimaryDocsRegistry(docId = null) {
  if (docId != null) uiState.registrySelectedId = docId;
  uiState.activeTab = 'registry';
  openPrimaryDocsModal();
}

export function openPrimaryDocsDrafts() {
  uiState.activeTab = 'drafts';
  openPrimaryDocsModal();
}

function closePrimaryDocsModal() {
  const modal = document.getElementById('primaryDocsModal');
  if (modal) modal.style.display = 'none';
}

export function initPrimaryDocsView() {
  exposeGlobalPrimaryDocsUi();
  ensureModal();
}
