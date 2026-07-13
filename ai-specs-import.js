/**
 * AI-импорт характеристик товаров из контракта/ТЗ (v33).
 *
 * Режимы:
 *   1. 📋 Вставить текст — копипаст из PDF/Word (рекомендуется на сервере)
 *   2. 📄 Загрузить файл — один запрос extract_and_analyze (нет 504)
 *
 * Результат: список карточек → каждый товар в отдельную карточку каталога.
 */

import { addProduct, updateProduct, state } from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';

// Claude Haiku: поддерживает imageInput (читает file_id с PDF/DOCX нативно)
const CLAUDE_HAIKU_MODEL_ID = 'a077725a-e4eb-4bb1-8092-8eaa4f209c2c';

let _inputMode = 'text';
let _selectedFile = null;
let _isAnalyzing = false;
/** @type {Array<{data: object, applied: boolean, expanded: boolean}>} */
let _products = [];

// ─── Detect mode ──────────────────────────────────────────────────

function isMiniappsMode() {
  return typeof window.miniappsAI !== 'undefined' && typeof window.miniappsAI.callModel === 'function';
}

function getHandlerUrl() {
  // Всегда используем абсолютный URL сервера.
  // Относительный путь не работает в miniapps.ai sandbox (URL там miniapps.ai/ru/--XXXX).
  return 'https://mto-cto.falcon28.ru/doc-checker/api/handler.php';
}

// ─── System prompt ────────────────────────────────────────────────

function _buildSystemPrompt(hint) {
  const hintLine = hint ? `\nПодсказка пользователя: ${hint}` : '';
  return `Ты извлекаешь товары из документа государственной закупки (ТЗ, контракт, спецификация).
Найди ВСЕ товары и верни JSON-массив. Если товар один — всё равно массив из одного элемента.${hintLine}

ВАЖНО: Ищи товары в разделах «Перечень объектов закупки», «Приложение 1», «Дополнительные требования к товару», «Приложение 2», таблицах с характеристиками.

═══ ПРИМЕР 1: Один товар ═══
[{"name":"Установщик электронных SMD компонентов","assembly":"required","color":"","specs":[{"param":"Количество монтажных головок","unit":"шт","value":"не менее 8"},{"param":"Скорость монтажа","unit":"комп/час","value":"не менее 11000"},{"param":"Напряжение","unit":"В","value":"220"}]}]

═══ ПРИМЕР 2: Многопозиционный договор — 3 отдельных товара ═══
[{"name":"Степ платформа","assembly":"not_required","color":"","specs":[{"param":"Вид платформы","unit":"","value":"Регулируемая"},{"param":"Количество уровней","unit":"шт","value":"3"},{"param":"Максимальный вес","unit":"кг","value":"≥100 и ≤120"}]},{"name":"Скамья гимнастическая","assembly":"not_required","color":"","specs":[{"param":"Длина","unit":"см","value":">250 и ≤300"},{"param":"Высота","unit":"см","value":"≥27 и ≤30"},{"param":"Материал каркаса","unit":"","value":"дерево"}]},{"name":"Секундомер электронный","assembly":"not_required","color":"","specs":[{"param":"Точность","unit":"с","value":"≥0.01"}]}]

═══ ПРАВИЛА ═══
- КАЖДАЯ пронумерованная позиция (1., 2., 3. …) → ОТДЕЛЬНЫЙ элемент массива. НИКОГДА не объединяй позиции.
- name: полное официальное наименование из заголовка позиции
- ЗАПРЕЩЕНО добавлять поля category и productGroup — категорию и товарную группу устанавливает пользователь вручную
- assembly: "required" если есть монтаж/установка/пусконаладка/сборка, иначе "not_required"
- specs: ВСЕ технические характеристики из всех Приложений для каждого товара
- unit: единица измерения или пустая строка
- Диапазоны значений сохраняй как есть (≥100 и ≤120)
- Отвечай ТОЛЬКО JSON-массивом, без markdown, без пояснений`;
}

function _buildUserMsg(hint, extraNote) {
  const expectedCount = _extractExpectedCount(hint);
  const countHint = expectedCount
    ? `\nОжидается РОВНО ${expectedCount} товаров — найди ВСЕ ${expectedCount} пронумерованных позиций.`
    : '';
  return `Извлеки ВСЕ товары и верни JSON-массив.${countHint}\nВАЖНО: каждая пронумерованная позиция — ОТДЕЛЬНЫЙ элемент массива.${extraNote ? '\n' + extraNote : ''}`;
}

function _extractExpectedCount(hint) {
  if (!hint) return null;
  const m = hint.match(/(\d+)\s*(?:позиц|товар|предмет|наименован|штук|пункт)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── Styles ───────────────────────────────────────────────────────

function _injectStyles() {
  if (document.getElementById('aiSpecsStyle')) return;
  const s = document.createElement('style');
  s.id = 'aiSpecsStyle';
  s.textContent = `
@keyframes aiSpin{to{transform:rotate(360deg)}}

#aiSpecsImportModal.modal-overlay{align-items:flex-start;padding:0.5rem;}
#aiSpecsImportModal .ais-panel{
  display:flex;flex-direction:column;
  width:98vw;max-width:1100px;
  height:96vh;max-height:96vh;
  background:rgb(10,15,30);
  border:1px solid rgba(255,255,255,0.1);
  border-radius:1.25rem;overflow:hidden;
}
#aiSpecsImportModal .ais-header{
  display:flex;align-items:center;gap:0.75rem;
  padding:0.75rem 1.25rem;
  border-bottom:1px solid rgba(255,255,255,0.08);
  flex-shrink:0;
}
#aiSpecsImportModal .ais-body{
  display:flex;flex:1;min-height:0;overflow:hidden;
}
/* Left: input panel */
#aiSpecsImportModal .ais-left{
  width:360px;min-width:300px;flex-shrink:0;
  display:flex;flex-direction:column;gap:0.65rem;
  border-right:1px solid rgba(255,255,255,0.07);
  overflow-y:auto;padding:1rem;
}
/* Right: results */
#aiSpecsImportModal .ais-right{
  flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;
}
#aiSpecsImportModal .ais-right-hdr{
  display:flex;align-items:center;gap:0.5rem;flex-wrap:wrap;
  padding:0.6rem 1rem;
  border-bottom:1px solid rgba(255,255,255,0.07);
  flex-shrink:0;
}
/* Scrollable product list — KEY FIX */
#aiSpecsImportModal .ais-prod-list{
  flex:1;min-height:0;
  overflow-y:scroll;overflow-x:hidden;
  padding:0.75rem 1rem 2rem;
  display:flex;flex-direction:column;gap:0.6rem;
}
/* Tabs */
#aiSpecsImportModal .ais-tabs{
  display:flex;gap:0.2rem;background:rgba(255,255,255,0.04);
  border-radius:0.65rem;padding:0.2rem;flex-shrink:0;
}
#aiSpecsImportModal .ais-tab{
  flex:1;border:none;border-radius:0.45rem;
  padding:0.35rem 0.5rem;font-size:0.75rem;font-weight:600;
  cursor:pointer;transition:all 0.15s;background:transparent;
  color:rgb(100,116,139);
}
#aiSpecsImportModal .ais-tab.active{background:rgb(6,182,212);color:#000;}

/* Product card */
#aiSpecsImportModal .ais-card{
  border:1px solid rgba(255,255,255,0.1);
  border-radius:0.875rem;
  background:rgba(255,255,255,0.025);
  overflow:hidden;flex-shrink:0;
  /* KEY: full width, no min-width constraint */
  width:100%;box-sizing:border-box;
}
#aiSpecsImportModal .ais-card.applied{
  border-color:rgba(34,197,94,0.4);background:rgba(34,197,94,0.04);
}
#aiSpecsImportModal .ais-card-hd{
  display:flex;align-items:flex-start;gap:0.5rem;
  padding:0.65rem 0.75rem;cursor:pointer;user-select:none;
  min-width:0;
}
#aiSpecsImportModal .ais-card-hd:hover{background:rgba(255,255,255,0.03);}
#aiSpecsImportModal .ais-card-info{flex:1;min-width:0;overflow:hidden;}
#aiSpecsImportModal .ais-card-name{
  font-size:0.82rem;font-weight:600;color:#fff;
  word-break:break-word;white-space:normal;line-height:1.45;
}
#aiSpecsImportModal .ais-card-meta{
  font-size:0.7rem;color:rgb(100,116,139);
  margin-top:0.15rem;word-break:break-word;white-space:normal;line-height:1.4;
}
#aiSpecsImportModal .ais-card-arrow{
  color:rgb(100,116,139);font-size:0.65rem;
  flex-shrink:0;padding-top:0.3rem;min-width:12px;
}
#aiSpecsImportModal .ais-add-btn{
  background:rgba(34,197,94,0.12);
  border:1px solid rgba(34,197,94,0.3);
  border-radius:0.5rem;
  padding:0.3rem 0.65rem;
  color:rgb(134,239,172);font-size:0.72rem;font-weight:600;
  cursor:pointer;white-space:nowrap;flex-shrink:0;
}
#aiSpecsImportModal .ais-add-btn:disabled{
  background:rgba(34,197,94,0.25);color:rgb(74,222,128);cursor:default;
}
/* Specs table */
#aiSpecsImportModal .ais-specs-wrap{
  padding:0.4rem 0.75rem 0.75rem;
  border-top:1px solid rgba(255,255,255,0.06);
  overflow-x:auto;
}
#aiSpecsImportModal .ais-specs-tbl{
  width:100%;border-collapse:collapse;min-width:300px;
}
#aiSpecsImportModal .ais-specs-tbl th{
  font-size:0.62rem;font-weight:600;text-transform:uppercase;
  letter-spacing:0.04em;color:rgb(100,116,139);
  padding:0.2rem 0.4rem 0.3rem;text-align:left;white-space:nowrap;
}
#aiSpecsImportModal .ais-specs-tbl td{
  font-size:0.77rem;color:rgb(203,213,225);
  padding:0.22rem 0.4rem;
  border-bottom:1px solid rgba(255,255,255,0.04);
  vertical-align:top;
  word-break:break-word;white-space:normal;line-height:1.45;
}
#aiSpecsImportModal .ais-specs-tbl tr:last-child td{border-bottom:none;}
#aiSpecsImportModal .ais-specs-tbl .col-p{width:40%;}
#aiSpecsImportModal .ais-specs-tbl .col-u{width:12%;white-space:nowrap;}
#aiSpecsImportModal .ais-specs-tbl .col-v{width:48%;}
/* Empty state */
#aiSpecsImportModal .ais-empty{
  flex:1;display:flex;flex-direction:column;align-items:center;
  justify-content:center;gap:0.5rem;
  color:rgb(71,85,105);font-size:0.8rem;text-align:center;padding:3rem 2rem;
}
/* Inputs */
#aiSpecsImportModal textarea,
#aiSpecsImportModal input[type=text]{
  width:100%;box-sizing:border-box;
  background:rgba(255,255,255,0.05);
  border:1px solid rgba(255,255,255,0.1);
  border-radius:0.65rem;
  padding:0.6rem 0.8rem;
  color:#fff;font-size:0.8rem;outline:none;
  font-family:inherit;
}
#aiSpecsImportModal textarea{resize:vertical;line-height:1.5;}
#aiSpecsImportModal textarea:focus,
#aiSpecsImportModal input[type=text]:focus{border-color:rgba(6,182,212,0.5);}
`;
  document.head.appendChild(s);
}

// ─── Modal ────────────────────────────────────────────────────────

function getOrCreateModal() {
  let modal = document.getElementById('aiSpecsImportModal');
  if (modal) return modal;

  _injectStyles();

  modal = document.createElement('div');
  modal.id = 'aiSpecsImportModal';
  modal.className = 'modal-overlay';
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'ИИ-импорт характеристик');
  modal.innerHTML = `
    <div class="ais-panel">
      <!-- Header -->
      <div class="ais-header">
        <span style="font-size:1.1rem;">🤖</span>
        <h2 style="font-size:0.95rem;font-weight:700;color:#fff;margin:0;flex:1;">ИИ-импорт товаров в каталог</h2>
        <div id="aiSpecsModeInd" style="font-size:0.65rem;padding:0.18rem 0.5rem;border-radius:0.4rem;background:rgba(255,255,255,0.06);color:rgb(100,116,139);"></div>
        <button id="aiSpecsCloseBtn" aria-label="Закрыть"
          style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;width:30px;height:30px;display:flex;align-items:center;justify-content:center;color:rgb(148,163,184);font-size:0.9rem;cursor:pointer;flex-shrink:0;">✕</button>
      </div>

      <!-- Body -->
      <div class="ais-body">

        <!-- LEFT -->
        <div class="ais-left">
          <div class="ais-tabs">
            <button id="aiTabText" class="ais-tab active" type="button">📋 Текст</button>
            <button id="aiTabFile" class="ais-tab" type="button">📄 Файл</button>
          </div>

          <!-- TEXT -->
          <div id="aiSecText">
            <div style="background:rgba(34,197,94,0.08);border:1px solid rgba(34,197,94,0.2);border-radius:0.65rem;padding:0.5rem 0.75rem;margin-bottom:0.5rem;">
              <p style="font-size:0.73rem;color:rgb(134,239,172);margin:0;line-height:1.5;">
                ✅ Скопируйте текст из PDF (Ctrl+A → Ctrl+C) и вставьте сюда.
              </p>
            </div>
            <label for="aiSpecsTa" style="display:block;font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgb(100,116,139);margin-bottom:0.3rem;">Текст ТЗ или контракта</label>
            <textarea id="aiSpecsTa" rows="14"
              placeholder="Вставьте сюда текст из PDF, Word или сайта…&#10;&#10;Например: скопируйте Приложение 1 и Приложение 2 целиком."
              style="min-height:200px;"></textarea>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:0.25rem;">
              <span id="aiSpecsTaLen" style="font-size:0.65rem;color:rgb(100,116,139);">0 символов</span>
              <button id="aiSpecsClearTa" type="button" style="background:none;border:none;color:rgb(100,116,139);font-size:0.7rem;cursor:pointer;">✕ Очистить</button>
            </div>
          </div>

          <!-- FILE -->
          <div id="aiSecFile" style="display:none;flex-direction:column;gap:0.5rem;">
            <div id="aiFileBanner" style="background:rgba(251,191,36,0.07);border:1px solid rgba(251,191,36,0.2);border-radius:0.65rem;padding:0.5rem 0.75rem;">
              <p style="font-size:0.73rem;color:rgb(253,224,71);margin:0;line-height:1.5;">
                ✅ PDF читается <strong>в браузере</strong> через PDF.js → DeepSeek.<br>
                <span style="color:rgb(100,116,139);">Нет таймаутов. Если PDF скан — используйте «Текст».</span>
              </p>
            </div>
            <label id="aiDropZone"
              style="border:2px dashed rgba(255,255,255,0.15);border-radius:0.75rem;padding:1.25rem;text-align:center;cursor:pointer;background:rgba(255,255,255,0.02);display:block;"
              tabindex="0" role="button" aria-label="Загрузить файл">
              <div style="font-size:1.5rem;margin-bottom:0.25rem;">📄</div>
              <p style="font-size:0.8rem;font-weight:600;color:#fff;margin:0 0 0.15rem;">Нажмите или перетащите</p>
              <p style="font-size:0.68rem;color:rgb(100,116,139);margin:0;">PDF, DOCX, TXT — до 50 МБ</p>
              <input id="aiFileInput" type="file" accept=".pdf,.docx,.doc,.txt,.xlsx,.xls,.csv" style="display:none;" aria-hidden="true"/>
            </label>
            <div id="aiFileChip" style="display:none;align-items:center;gap:0.5rem;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.65rem;padding:0.45rem 0.65rem;">
              <span>📎</span>
              <span id="aiFileName" style="font-size:0.78rem;color:#fff;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"></span>
              <button id="aiRemoveFile" aria-label="Удалить" style="background:none;border:none;color:rgb(100,116,139);font-size:0.85rem;cursor:pointer;">✕</button>
            </div>
          </div>

          <!-- Hint -->
          <div>
            <label for="aiSpecsHint" style="display:block;font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;color:rgb(100,116,139);margin-bottom:0.3rem;">Подсказка (необязательно)</label>
            <input id="aiSpecsHint" type="text" placeholder="Например: 14 позиций спортивного инвентаря"/>
          </div>

          <!-- Progress -->
          <div id="aiProgress" style="display:none;align-items:center;gap:0.5rem;">
            <div style="width:14px;height:14px;border:2px solid rgba(6,182,212,0.3);border-top-color:rgb(6,182,212);border-radius:50%;animation:aiSpin 0.8s linear infinite;flex-shrink:0;"></div>
            <span id="aiProgressText" style="font-size:0.77rem;color:rgb(148,163,184);">Загрузка…</span>
          </div>

          <!-- Error -->
          <div id="aiError" style="display:none;background:rgba(239,68,68,0.1);border:1px solid rgba(239,68,68,0.25);border-radius:0.65rem;padding:0.6rem 0.75rem;">
            <p id="aiErrorText" style="font-size:0.77rem;color:rgb(252,165,165);margin:0 0 0.3rem;white-space:pre-wrap;"></p>
            <details id="aiRawDetails" style="display:none;">
              <summary style="font-size:0.65rem;color:rgb(100,116,139);cursor:pointer;">Ответ ИИ (отладка)</summary>
              <pre id="aiRawText" style="font-size:0.63rem;color:rgb(148,163,184);margin:0.3rem 0 0;white-space:pre-wrap;word-break:break-all;max-height:120px;overflow-y:auto;background:rgba(0,0,0,0.3);padding:0.35rem;border-radius:0.4rem;"></pre>
            </details>
          </div>

          <!-- Analyze button -->
          <button id="aiAnalyzeBtn"
            style="background:linear-gradient(135deg,rgb(6,182,212),rgb(34,211,238));border:none;border-radius:0.75rem;padding:0.65rem 1rem;color:#000;font-size:0.85rem;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:0.5rem;margin-top:auto;flex-shrink:0;">
            <span>🔍</span><span id="aiAnalyzeBtnLabel">Извлечь товары</span>
          </button>
        </div><!-- /ais-left -->

        <!-- RIGHT -->
        <div class="ais-right">
          <div id="aiResultsHeader" class="ais-right-hdr" style="display:none;">
            <span style="font-size:0.88rem;font-weight:700;color:rgb(34,211,238);">
              ✅ Найдено: <span id="aiProdCount">0</span> товаров
            </span>
            <div style="display:flex;gap:0.4rem;flex-wrap:wrap;margin-left:auto;">
              <button id="aiExpandAllBtn" type="button"
                style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.5rem;padding:0.28rem 0.65rem;color:rgb(148,163,184);font-size:0.72rem;cursor:pointer;">
                ▼ Раскрыть все
              </button>
              <button id="aiApplyAllBtn" type="button"
                style="display:none;background:rgba(6,182,212,0.12);border:1px solid rgba(6,182,212,0.3);border-radius:0.5rem;padding:0.28rem 0.65rem;color:rgb(103,232,249);font-size:0.72rem;font-weight:600;cursor:pointer;">
                ✅ Добавить все в каталог
              </button>
            </div>
          </div>

          <div id="aiProdList" class="ais-prod-list">
            <div class="ais-empty">
              <div style="font-size:2rem;">📋</div>
              <div>Вставьте текст или загрузите файл ТЗ/контракта,<br>затем нажмите «Извлечь товары»</div>
            </div>
          </div>
        </div><!-- /ais-right -->

      </div><!-- /ais-body -->
    </div>`;

  document.body.appendChild(modal);
  _wireHandlers(modal);
  return modal;
}

// ─── Wire handlers ────────────────────────────────────────────────

function _wireHandlers(modal) {
  modal.addEventListener('click', e => { if (e.target === modal) closeAiSpecsImport(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && modal.classList.contains('open')) closeAiSpecsImport();
  });

  document.getElementById('aiSpecsCloseBtn')?.addEventListener('click', closeAiSpecsImport);
  document.getElementById('aiTabText')?.addEventListener('click', () => _setMode('text'));
  document.getElementById('aiTabFile')?.addEventListener('click', () => _setMode('file'));

  const ta = document.getElementById('aiSpecsTa');
  const taLen = document.getElementById('aiSpecsTaLen');
  ta?.addEventListener('input', () => {
    if (taLen) taLen.textContent = ta.value.length.toLocaleString('ru') + ' символов';
  });
  document.getElementById('aiSpecsClearTa')?.addEventListener('click', () => {
    if (ta) ta.value = '';
    if (taLen) taLen.textContent = '0 символов';
    _hideError();
  });

  const dropZone = document.getElementById('aiDropZone');
  const fileInput = document.getElementById('aiFileInput');
  dropZone?.addEventListener('dragover', e => { e.preventDefault(); dropZone.style.borderColor = 'rgb(6,182,212)'; });
  dropZone?.addEventListener('dragleave', () => { dropZone.style.borderColor = 'rgba(255,255,255,0.15)'; });
  dropZone?.addEventListener('drop', e => { e.preventDefault(); dropZone.style.borderColor = 'rgba(255,255,255,0.15)'; const f = e.dataTransfer?.files?.[0]; if (f) _setFile(f); });
  fileInput?.addEventListener('change', () => { const f = fileInput.files?.[0]; if (f) _setFile(f); fileInput.value = ''; });
  document.getElementById('aiRemoveFile')?.addEventListener('click', () => _setFile(null));

  document.getElementById('aiAnalyzeBtn')?.addEventListener('click', _runAnalysis);
  document.getElementById('aiExpandAllBtn')?.addEventListener('click', _toggleExpandAll);
  document.getElementById('aiApplyAllBtn')?.addEventListener('click', _applyAll);
}

// ─── Input mode toggle ────────────────────────────────────────────

function _setMode(mode) {
  _inputMode = mode;
  document.getElementById('aiTabText')?.classList.toggle('active', mode === 'text');
  document.getElementById('aiTabFile')?.classList.toggle('active', mode === 'file');
  const secText = document.getElementById('aiSecText');
  const secFile = document.getElementById('aiSecFile');
  if (secText) secText.style.display = mode === 'text' ? 'block' : 'none';
  if (secFile) secFile.style.display = mode === 'file' ? 'flex' : 'none';
  _hideError();
}

// ─── File management ──────────────────────────────────────────────

function _setFile(file) {
  _selectedFile = file;
  const chip = document.getElementById('aiFileChip');
  const nameEl = document.getElementById('aiFileName');
  const dz = document.getElementById('aiDropZone');
  if (file) {
    if (nameEl) nameEl.textContent = file.name;
    if (chip) chip.style.display = 'flex';
    if (dz) dz.style.display = 'none';
  } else {
    if (chip) chip.style.display = 'none';
    if (dz) dz.style.display = 'block';
  }
  _hideError();
}

// ─── HTTP helper (как в doc-checker: 240с, 3 ретрая, 502/503/504/429) ────────

function _sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function _callHandler(url, payload, timeoutMs = 240000) {
  const MAX_RETRIES = 3;
  let lastErr;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      let resp;
      try {
        resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: ctrl.signal,
        });
      } finally {
        clearTimeout(timer);
      }
      const text = await resp.text();
      console.log('[ai-specs] attempt', attempt, 'status:', resp.status, 'body[:200]:', text.slice(0, 200));
      let data;
      try { data = JSON.parse(text); }
      catch { throw new Error('Сервер вернул не-JSON: ' + text.slice(0, 300)); }

      // 502/503/504 — ретрай с паузой
      if (resp.status === 502 || resp.status === 503 || resp.status === 504) {
        const wait = 15 * attempt;
        _setProgressText(`⏳ Сервер не ответил (${resp.status}), пауза ${wait}с, попытка ${attempt}/${MAX_RETRIES}…`);
        console.warn('[ai-specs] HTTP', resp.status, '→ ждём', wait, 'с...');
        await _sleep(wait * 1000);
        lastErr = new Error('HTTP ' + resp.status);
        continue;
      }
      // 429/529 — rate limit
      if (resp.status === 429 || resp.status === 529) {
        const wait = attempt * 20;
        _setProgressText(`Лимит API, пауза ${wait}с…`);
        await _sleep(wait * 1000);
        lastErr = new Error('Rate limit ' + resp.status);
        continue;
      }
      if (!resp.ok) {
        const errMsg = typeof data?.error === 'string' ? data.error : (data?.error?.message || JSON.stringify(data));
        throw new Error('API ошибка ' + resp.status + ': ' + errMsg);
      }
      return data;
    } catch (err) {
      clearTimeout(timer);
      lastErr = err;
      if (err.name === 'AbortError') {
        const wait = 10 * attempt;
        _setProgressText(`⏳ Таймаут (${Math.round(timeoutMs / 1000)}с), пауза ${wait}с, попытка ${attempt}/${MAX_RETRIES}…`);
        console.warn('[ai-specs] AbortError → ждём', wait, 'с...');
        if (attempt < MAX_RETRIES) { await _sleep(wait * 1000); continue; }
      }
      if (attempt < MAX_RETRIES) {
        _setProgressText(`Ошибка, повтор ${attempt + 1}/${MAX_RETRIES}: ${err.message.slice(0, 60)}`);
        await _sleep(5000 * attempt);
      }
    }
  }
  const msg = lastErr?.name === 'AbortError'
    ? `Таймаут (${Math.round(timeoutMs / 1000)}с после ${MAX_RETRIES} попыток). Попробуйте вставить текст.`
    : (lastErr?.message || 'Все попытки исчерпаны');
  return { error: msg };
}

function _fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result || '').split(',')[1] || r.result);
    r.onerror = () => reject(new Error('Ошибка чтения файла'));
    r.readAsDataURL(file);
  });
}

function _readFileAsText(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result || '');
    r.onerror = () => reject(new Error('Ошибка чтения файла'));
    r.readAsText(file, 'utf-8');
  });
}

// ─── PDF.js extraction (same pipeline as doc-checker) ─────────────

// Как в doc-checker: локальные libs/ первыми, потом CDN
const PDFJS_URLS = [
  '../doc-checker/libs/pdf.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.min.js',
];
const PDFJS_WORKER_URLS = [
  '../doc-checker/libs/pdf.worker.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js',
  'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
  'https://unpkg.com/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
];

let _pdfjsLoaded = false;

function _loadScript(src) {
  return new Promise((resolve, reject) => {
    if (document.querySelector('script[src="' + src + '"]')) { resolve(); return; }
    const s = document.createElement('script');
    s.src = src; s.onload = resolve;
    s.onerror = () => reject(new Error('Не удалось загрузить: ' + src));
    document.head.appendChild(s);
  });
}

// Загрузка скрипта с таймаутом — браузер не поддерживает abort для <script>,
// поэтому используем Promise.race
function _loadScriptWithTimeout(src, timeoutMs = 8000) {
  const load = _loadScript(src);
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('Таймаут загрузки: ' + src)), timeoutMs)
  );
  return Promise.race([load, timeout]);
}

// HEAD-проверка с коротким таймаутом (3 сек) — не зависнет если CDN недоступен
async function _headCheck(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 3000);
  try {
    const r = await fetch(url, { method: 'HEAD', cache: 'no-store', signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(t);
  }
}

async function _loadPDFJS() {
  if (_pdfjsLoaded && window.pdfjsLib) return window.pdfjsLib;
  if (window.pdfjsLib) { _pdfjsLoaded = true; return window.pdfjsLib; }

  // Как в doc-checker: просто пробуем по порядку без HEAD-проверок
  for (const url of PDFJS_URLS) {
    try {
      await _loadScript(url);
      if (window.pdfjsLib) { console.log('[ai-specs] PDF.js loaded from:', url); break; }
    } catch (e) { console.warn('[ai-specs] PDF.js load failed:', url, e.message); }
  }

  if (!window.pdfjsLib) throw new Error('PDF.js не удалось загрузить ни из одного источника');

  // Worker: пробуем по порядку через fetch HEAD (как в doc-checker)
  let workerSet = false;
  for (const wurl of PDFJS_WORKER_URLS) {
    try {
      const resp = await fetch(wurl, { method: 'HEAD', cache: 'no-store' });
      if (resp.ok) {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = wurl;
        console.log('[ai-specs] PDF.js worker:', wurl);
        workerSet = true;
        break;
      }
    } catch { /* next */ }
  }
  if (!workerSet) {
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URLS[1];
  }

  _pdfjsLoaded = true;
  return window.pdfjsLib;
}

async function _extractPdfText(file) {
  const pdfjsLib = await _loadPDFJS();
  const buf = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: buf }).promise;
  const parts = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const tc = await page.getTextContent();
    // Group by Y-coord (same as doc-checker) to preserve table rows
    const byY = new Map();
    tc.items.forEach(item => {
      const y = Math.round(item.transform[5]);
      if (!byY.has(y)) byY.set(y, []);
      byY.get(y).push({ x: item.transform[4], str: item.str });
    });
    const rows = [...byY.entries()]
      .sort((a, b) => b[0] - a[0])
      .map(([, items]) => items.sort((a, b) => a.x - b.x).map(it => it.str).join('\t'));
    const pageText = rows.join('\n').replace(/\s{3,}/g, '  ').trim();
    const meaningful = (pageText.match(/[а-яёА-ЯЁa-zA-Z0-9]/g) || []).length;
    console.log('[ai-specs PDF.js] стр.' + i + '/' + pdf.numPages + ': ' + meaningful + ' символов');
    if (meaningful > 30) parts.push(pageText);
  }
  return parts.join('\n\n');
}

// ─── Analysis: miniappsAI SDK (Claude Haiku — читает PDF нативно) ──

async function _analyzeSdkFile(file, hint) {
  _setProgressText('Загрузка файла в Claude…');
  let uploaded;
  try {
    uploaded = await window.miniappsAI.uploadFile(file, { persistence: 'temporary' });
  } catch (err) {
    throw new Error('Ошибка загрузки файла: ' + (err?.message || String(err)));
  }

  _setProgressText('Claude читает документ…');
  const result = await window.miniappsAI.callModel({
    modelId: CLAUDE_HAIKU_MODEL_ID,
    messages: [
      { role: 'system', content: _buildSystemPrompt(hint) },
      {
        role: 'user', content: [
          { type: 'file_id', fileId: uploaded.fileId },
          { type: 'text', text: _buildUserMsg(hint, '') },
        ]
      },
    ],
    timeoutMs: 120000,
  });
  return window.miniappsAI.extractText(result).trim();
}

async function _analyzeSdkText(text, hint) {
  _setProgressText('Анализ текста (Claude Haiku)…');
  const result = await window.miniappsAI.callModel({
    modelId: CLAUDE_HAIKU_MODEL_ID,
    messages: [
      { role: 'system', content: _buildSystemPrompt(hint) },
      { role: 'user', content: `${_buildUserMsg(hint, '')}\n\nТЕКСТ:\n${text.slice(0, 180000)}` },
    ],
    timeoutMs: 120000,
  });
  return window.miniappsAI.extractText(result).trim();
}

// ─── Analysis: server text mode ───────────────────────────────────

async function _analyzeText(text, hint) {
  const url = getHandlerUrl();
  _setProgressText('Анализ текста…');
  // max_tokens 8000 — достаточно для JSON-списка товаров, успевает до nginx-таймаута
  // provider не передаём — handler.php читает из config.php
  const userContent = _buildUserMsg(hint, '') + '\n\nТЕКСТ ДОКУМЕНТА:\n' + text.slice(0, 120000);
  const resp = await _callHandler(url, {
    action: 'analyze',
    system: _buildSystemPrompt(hint),
    messages: [{ role: 'user', content: userContent }],
    max_tokens: 8000,
  }, 240000);
  if (resp.error) throw new Error(resp.error);
  return _extractRawText(resp);
}

// ─── Analysis: server file mode — PDF.js in browser (no 504) ─────

async function _analyzeFile(file, hint) {
  const ext = file.name.split('.').pop().toLowerCase();

  // TXT/CSV — читаем напрямую
  if (['txt', 'csv', 'md'].includes(ext)) {
    _setProgressText('Чтение текстового файла…');
    const docText = await _readFileAsText(file);
    if (docText.length < 30) throw new Error('Файл пустой или не читается');
    return _analyzeText(docText, hint);
  }

  // PDF — PDF.js в браузере (как в doc-checker), потом DeepSeek только с текстом (без PHP fallback)
  if (ext === 'pdf') {
    _setProgressText('PDF.js загружается…');
    let docText = '';
    try {
      docText = await _extractPdfText(file);
    } catch (pdfErr) {
      console.warn('[ai-specs] PDF.js error:', pdfErr);
      throw new Error(
        'PDF.js не смог прочитать файл: ' + pdfErr.message +
        '\n\n💡 Совет: откройте PDF, нажмите Ctrl+A → Ctrl+C и вставьте текст в режим «📋 Текст».'
      );
    }

    const meaningful = (docText.match(/[а-яёА-ЯЁa-zA-Z0-9]/g) || []).length;
    console.log('[ai-specs] PDF.js извлёк', docText.length, 'символов, значимых:', meaningful);

    if (meaningful < 50) {
      throw new Error(
        'PDF содержит мало текста (' + meaningful + ' символов). Возможно, это скан.\n\n' +
        '💡 Совет: откройте PDF, нажмите Ctrl+A → Ctrl+C и вставьте текст в режим «📋 Текст».\n' +
        'Или используйте Word-версию документа (.docx).'
      );
    }

    _setProgressText('Текст извлечён (' + docText.length + ' симв.), анализирую…');
    return _analyzeText(docText, hint);
  }

  // DOCX/DOC — через PHP парсер
  _setProgressText('Извлечение текста из DOCX…');
  const url = getHandlerUrl();
  const b64 = await _fileToBase64(file);
  const resp = await _callHandler(url, {
    action: 'extract_and_analyze',
    base64: b64,
    mediaType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    filename: file.name,
    system: _buildSystemPrompt(hint),
    userPrefix: _buildUserMsg(hint, 'Документ: "' + file.name + '"'),
    max_tokens: 8000,
  }, 240000);
  if (resp.error) throw new Error(resp.error);
  return _extractRawText(resp);
}

// ─── Extract text from response ───────────────────────────────────

function _extractRawText(resp) {
  return (
    resp.text
    || resp.choices?.[0]?.message?.content
    || resp.result?.alternatives?.[0]?.message?.text
    || resp.content?.[0]?.text
    || JSON.stringify(resp)
  );
}

// ─── JSON parsing ─────────────────────────────────────────────────

function _parseProductList(raw) {
  const strategies = [
    () => JSON.parse(raw),
    () => JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '')),
    () => { const i = raw.indexOf('['), j = raw.lastIndexOf(']'); if (i !== -1 && j > i) return JSON.parse(raw.slice(i, j + 1)); throw new Error('no []'); },
    () => { const i = raw.indexOf('{'), j = raw.lastIndexOf('}'); if (i !== -1 && j > i) { const p = JSON.parse(raw.slice(i, j + 1)); return Array.isArray(p) ? p : [p]; } throw new Error('no {}'); },
  ];
  for (const fn of strategies) {
    try {
      const p = fn();
      if (!p) continue;
      const arr = Array.isArray(p) ? p : [p];
      if (arr.length > 0) return arr;
    } catch { /* next */ }
  }
  return null;
}

// ─── Main analysis runner ─────────────────────────────────────────

async function _runAnalysis() {
  if (_isAnalyzing) return;

  const hint = (document.getElementById('aiSpecsHint')?.value || '').trim();
  const sdk = isMiniappsMode();

  if (_inputMode === 'text') {
    const text = (document.getElementById('aiSpecsTa')?.value || '').trim();
    if (text.length < 30) { _showError('Вставьте текст ТЗ или контракта (минимум 30 символов).'); return; }
  } else {
    if (!_selectedFile) { _showError('Загрузите файл контракта или ТЗ.'); return; }
  }

  _isAnalyzing = true;
  _hideError();
  _setLoading(true);
  _showProgress('Инициализация…');

  // Mode indicator
  const modeEl = document.getElementById('aiSpecsModeInd');
  if (modeEl) {
    if (sdk && _inputMode === 'file') { modeEl.textContent = '🟣 Claude Haiku (нативный PDF)'; modeEl.style.color = 'rgb(196,181,253)'; }
    else if (sdk) { modeEl.textContent = '🟣 Claude Haiku'; modeEl.style.color = 'rgb(196,181,253)'; }
    else if (_inputMode === 'text') { modeEl.textContent = '🟢 DeepSeek'; modeEl.style.color = 'rgb(134,239,172)'; }
    else { modeEl.textContent = '🟢 PDF.js→DeepSeek (без таймаута)'; modeEl.style.color = 'rgb(134,239,172)'; }
  }

  let rawResponse = '';
  try {
    if (sdk) {
      if (_inputMode === 'text') {
        const text = (document.getElementById('aiSpecsTa')?.value || '').trim();
        rawResponse = await _analyzeSdkText(text, hint);
      } else {
        rawResponse = await _analyzeSdkFile(_selectedFile, hint);
      }
    } else {
      if (_inputMode === 'text') {
        const text = (document.getElementById('aiSpecsTa')?.value || '').trim();
        rawResponse = await _analyzeText(text, hint);
      } else {
        rawResponse = await _analyzeFile(_selectedFile, hint);
      }
    }

    console.log('[ai-specs] raw[:500]:', rawResponse.slice(0, 500));
    const products = _parseProductList(rawResponse);

    if (!products || products.length === 0) {
      _showErrorWithRaw(
        'ИИ не нашёл товары в документе.\n• Добавьте подсказку: название товара или количество позиций\n• Убедитесь что текст содержит характеристики товаров',
        rawResponse
      );
      return;
    }

    _products = products.map(p => ({ data: p, applied: false, expanded: false }));
    _renderResults();

  } catch (err) {
    _showErrorWithRaw(err?.message || String(err), rawResponse);
  } finally {
    _isAnalyzing = false;
    _setLoading(false);
    _hideProgress();
  }
}

// ─── Expand / collapse ────────────────────────────────────────────

function _toggleExpandAll() {
  // Если все раскрыты — свернуть, иначе — раскрыть все
  const allExpanded = _products.length > 0 && _products.every(p => p.expanded);
  _products.forEach(p => { p.expanded = !allExpanded; });
  _rerenderList();
  _updateExpandBtn();
}

function _updateExpandBtn() {
  const btn = document.getElementById('aiExpandAllBtn');
  if (!btn) return;
  const allExpanded = _products.length > 0 && _products.every(p => p.expanded);
  btn.textContent = allExpanded ? '▲ Свернуть все' : '▼ Раскрыть все';
}

// ─── Results rendering ────────────────────────────────────────────

function _renderResults() {
  const countEl = document.getElementById('aiProdCount');
  const headerEl = document.getElementById('aiResultsHeader');
  if (countEl) countEl.textContent = String(_products.length);
  if (headerEl) headerEl.style.display = 'flex';

  _rerenderList();
  _updateApplyAllBtn();
  _updateExpandBtn();
}

/** Re-render entire list, preserving scroll position */
function _rerenderList() {
  const listEl = document.getElementById('aiProdList');
  if (!listEl) return;
  const scrollTop = listEl.scrollTop;
  listEl.innerHTML = '';
  _products.forEach((item, idx) => listEl.appendChild(_buildCard(item, idx)));
  listEl.scrollTop = scrollTop;
}

function _buildCard(item, idx) {
  const { data, applied, expanded } = item;
  const specCount = Array.isArray(data.specs) ? data.specs.length : 0;

  const card = document.createElement('div');
  card.className = 'ais-card' + (applied ? ' applied' : '');

  // Header row
  const hd = document.createElement('div');
  hd.className = 'ais-card-hd';
  hd.addEventListener('click', () => {
    item.expanded = !item.expanded;
    // Replace only this card in DOM (fast, no full re-render)
    const list = document.getElementById('aiProdList');
    if (list) {
      const cards = list.querySelectorAll('.ais-card');
      const oldCard = cards[idx];
      if (oldCard) list.replaceChild(_buildCard(item, idx), oldCard);
    }
    _updateExpandBtn();
  });

  const info = document.createElement('div');
  info.className = 'ais-card-info';
  info.innerHTML = `
    <div class="ais-card-name">${idx + 1}. ${_esc(data.name || '—')}</div>
    <div class="ais-card-meta">
      ${specCount > 0 ? specCount + ' характ.' : ''}
      ${data.assembly === 'required' ? (specCount > 0 ? ' · ' : '') + '<span style="color:rgb(251,191,36);">⚙ монтаж</span>' : ''}
      ${applied ? ' · <span style="color:rgb(74,222,128);">✓ добавлен</span>' : ''}
      <span style="color:rgb(71,85,105);font-size:0.65rem;"> — категория задаётся вручную</span>
    </div>`;

  const arrow = document.createElement('span');
  arrow.className = 'ais-card-arrow';
  arrow.textContent = expanded ? '▲' : '▼';

  const addBtn = document.createElement('button');
  addBtn.type = 'button';
  addBtn.className = 'ais-add-btn';
  addBtn.textContent = applied ? '✓ Добавлен' : '+ В каталог';
  addBtn.disabled = applied;
  addBtn.addEventListener('click', e => { e.stopPropagation(); _applyOne(idx); });

  hd.append(info, arrow, addBtn);
  card.appendChild(hd);

  // Specs table (expanded)
  if (expanded && specCount > 0) {
    const wrap = document.createElement('div');
    wrap.className = 'ais-specs-wrap';

    const tbl = document.createElement('table');
    tbl.className = 'ais-specs-tbl';
    tbl.innerHTML = `
      <colgroup><col class="col-p"><col class="col-u"><col class="col-v"></colgroup>
      <thead><tr><th>Параметр</th><th>Ед.</th><th>Значение</th></tr></thead>`;

    const tbody = document.createElement('tbody');
    data.specs.forEach(s => {
      const tr = document.createElement('tr');
      [s.param || '', s.unit || '', s.value || ''].forEach(v => {
        const td = document.createElement('td');
        td.textContent = v;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    card.appendChild(wrap);
  }

  return card;
}

// ─── Duplicate detection ──────────────────────────────────────────

/** Найти товар в каталоге с таким же именем (без учёта регистра) */
function _findDuplicate(name) {
  if (!name) return null;
  const nameLow = name.trim().toLowerCase();
  return (state.products || []).find(p => (p.name || '').trim().toLowerCase() === nameLow) || null;
}

/**
 * Показывает inline-диалог на карточке с выбором действия при дубликате.
 * Вызывает callback(action) где action = 'skip' | 'update' | 'copy'
 */
function _showDuplicateDialog(idx, existingProduct, callback) {
  const list = document.getElementById('aiProdList');
  if (!list) { callback('copy'); return; }
  const cards = list.querySelectorAll('.ais-card');
  const card = cards[idx];
  if (!card) { callback('copy'); return; }

  // Убираем старый диалог если есть
  card.querySelector('.ais-dup-dialog')?.remove();

  const dlg = document.createElement('div');
  dlg.className = 'ais-dup-dialog';
  dlg.style.cssText = [
    'padding:0.6rem 0.75rem',
    'border-top:1px solid rgba(251,191,36,0.3)',
    'background:rgba(251,191,36,0.06)',
    'display:flex', 'flex-direction:column', 'gap:0.4rem',
  ].join(';');
  dlg.innerHTML = `
    <div style="font-size:0.73rem;color:rgb(253,224,71);line-height:1.4;">
      ⚠ Товар <strong>«${_esc((existingProduct.name || '').slice(0, 50))}»</strong> уже есть в каталоге (№${existingProduct.number}).<br>
      <span style="font-size:0.68rem;color:rgb(148,163,184);">Названия товаров уникальны — создать копию нельзя.</span>
    </div>
    <div style="display:flex;gap:0.4rem;flex-wrap:wrap;">
      <button class="ais-dup-btn" data-action="skip"
        style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:0.45rem;padding:0.28rem 0.65rem;color:rgb(148,163,184);font-size:0.72rem;cursor:pointer;">
        Пропустить
      </button>
      <button class="ais-dup-btn" data-action="update"
        style="background:rgba(251,191,36,0.12);border:1px solid rgba(251,191,36,0.3);border-radius:0.45rem;padding:0.28rem 0.65rem;color:rgb(253,224,71);font-size:0.72rem;font-weight:600;cursor:pointer;">
        Обновить характеристики
      </button>
    </div>`;

  dlg.querySelectorAll('.ais-dup-btn').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      dlg.remove();
      callback(btn.dataset.action);
    });
  });

  card.appendChild(dlg);
}

// ─── Apply ────────────────────────────────────────────────────────

function _applyOne(idx) {
  const item = _products[idx];
  if (!item || item.applied) return;

  const productData = _buildProductData(item.data);
  const existing = _findDuplicate(productData.name);

  if (existing) {
    // Показываем диалог выбора действия прямо на карточке
    _showDuplicateDialog(idx, existing, (action) => {
      if (action === 'skip') {
        item.applied = true; // помечаем как «обработан»
        const list = document.getElementById('aiProdList');
        if (list) {
          const cards = list.querySelectorAll('.ais-card');
          if (cards[idx]) list.replaceChild(_buildCard(item, idx), cards[idx]);
        }
        _updateApplyAllBtn();
        showToast(`⏭ «${productData.name.slice(0, 35)}» пропущен`, 'info');
        return;
      }
      if (action === 'update') {
        try {
          updateProduct(existing.id, {
            category: productData.category,
            productGroup: productData.productGroup,
            color: productData.color,
            assembly: productData.assembly,
            specs: productData.specs,
          });
          item.applied = true;
          saveToStorage().catch(e => console.warn('[ai-specs] save error:', e));
          showToast(`✏️ «${productData.name.slice(0, 35)}» обновлён в каталоге`, 'success');
        } catch (e) { showToast('Ошибка обновления: ' + e.message, 'error'); }
      }
      const list = document.getElementById('aiProdList');
      if (list) {
        const cards = list.querySelectorAll('.ais-card');
        if (cards[idx]) list.replaceChild(_buildCard(item, idx), cards[idx]);
      }
      _updateApplyAllBtn();
    });
    return;
  }

  // Нет дубликата — добавляем сразу
  try {
    addProduct(productData);
    item.applied = true;
    saveToStorage().catch(e => console.warn('[ai-specs] save error:', e));
    showToast(`✅ «${(item.data.name || 'Товар').slice(0, 40)}» добавлен в каталог`, 'success');
    const list = document.getElementById('aiProdList');
    if (list) {
      const cards = list.querySelectorAll('.ais-card');
      if (cards[idx]) list.replaceChild(_buildCard(item, idx), cards[idx]);
    }
    _updateApplyAllBtn();
  } catch (e) {
    showToast('Ошибка: ' + e.message, 'error');
  }
}

function _applyAll() {
  const toApply = _products.filter(p => !p.applied);
  if (toApply.length === 0) return;

  // Проверяем дубликаты среди всех товаров
  const duplicates = toApply.filter(item => _findDuplicate(_buildProductData(item.data).name));
  if (duplicates.length > 0) {
    const names = duplicates.map(item => `«${(item.data.name || '').slice(0, 40)}»`).join(', ');
    showToast(`⚠ Найдены дубликаты: ${names}. Добавьте их по одному.`, 'info', 6000);
    // Добавляем только те, у которых нет дублей
    const noDups = toApply.filter(item => !_findDuplicate(_buildProductData(item.data).name));
    if (noDups.length === 0) return;
    let count = 0;
    noDups.forEach(item => {
      try { addProduct(_buildProductData(item.data)); item.applied = true; count++; }
      catch (e) { console.warn('[ai-specs] addProduct error:', e); }
    });
    saveToStorage().catch(e => console.warn('[ai-specs] save error:', e));
    if (count > 0) showToast(`✅ Добавлено ${count} товаров (без дублей)`, 'success');
    _rerenderList();
    _updateApplyAllBtn();
    return;
  }

  let count = 0;
  toApply.forEach(item => {
    try {
      addProduct(_buildProductData(item.data));
      item.applied = true;
      count++;
    } catch (e) { console.warn('[ai-specs] addProduct error:', e); }
  });

  saveToStorage().catch(e => console.warn('[ai-specs] save error:', e));
  showToast(`✅ Добавлено ${count} товаров в каталог`, 'success');
  _rerenderList();
  _updateApplyAllBtn();
}

function _updateApplyAllBtn() {
  const btn = document.getElementById('aiApplyAllBtn');
  if (!btn) return;
  const notApplied = _products.filter(p => !p.applied).length;
  btn.style.display = _products.length > 1 ? 'inline-block' : 'none';
  btn.disabled = notApplied === 0;
  btn.textContent = notApplied > 0
    ? `✅ Добавить все (${notApplied}) в каталог`
    : `✓ Все добавлены`;
}

function _buildProductData(data) {
  return {
    name: data.name || 'Товар без названия',
    // category и productGroup намеренно НЕ берём из AI — устанавливает пользователь вручную
    category: '',
    productGroup: '',
    color: data.color || '',
    assembly: data.assembly || 'not_required',
    specs: Array.isArray(data.specs) ? data.specs.filter(s => s.param || s.value) : [],
  };
}

// ─── UI helpers ───────────────────────────────────────────────────

function _esc(str) {
  return String(str)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function _showProgress(text) {
  const el = document.getElementById('aiProgress');
  if (el) el.style.display = 'flex';
  _setProgressText(text);
}
function _hideProgress() {
  const el = document.getElementById('aiProgress');
  if (el) el.style.display = 'none';
}
function _setProgressText(text) {
  const el = document.getElementById('aiProgressText');
  if (el) el.textContent = text;
}
function _showError(msg) {
  const wrap = document.getElementById('aiError');
  const textEl = document.getElementById('aiErrorText');
  const rawD = document.getElementById('aiRawDetails');
  if (wrap) wrap.style.display = 'block';
  if (textEl) textEl.textContent = msg;
  if (rawD) rawD.style.display = 'none';
}
function _showErrorWithRaw(msg, raw) {
  const wrap = document.getElementById('aiError');
  const textEl = document.getElementById('aiErrorText');
  const rawD = document.getElementById('aiRawDetails');
  const rawT = document.getElementById('aiRawText');
  if (wrap) wrap.style.display = 'block';
  if (textEl) textEl.textContent = msg;
  if (raw && raw.length > 0) {
    if (rawD) rawD.style.display = 'block';
    if (rawT) rawT.textContent = raw.slice(0, 2000);
  }
}
function _hideError() {
  const el = document.getElementById('aiError');
  if (el) el.style.display = 'none';
}
function _setLoading(on) {
  const btn = document.getElementById('aiAnalyzeBtn');
  const lbl = document.getElementById('aiAnalyzeBtnLabel');
  if (!btn) return;
  btn.disabled = on;
  btn.style.opacity = on ? '0.6' : '1';
  if (lbl) lbl.textContent = on ? 'Анализирую…' : 'Извлечь товары';
}

// ─── Public API ───────────────────────────────────────────────────

export function openAiSpecsImport() {
  _selectedFile = null;
  _products = [];
  _isAnalyzing = false;
  _inputMode = 'text';

  const modal = getOrCreateModal();

  _setFile(null);
  _hideError();
  _setLoading(false);
  _hideProgress();
  _setMode('text');

  // Reset results
  const listEl = document.getElementById('aiProdList');
  if (listEl) {
    listEl.innerHTML = `<div class="ais-empty">
      <div style="font-size:2rem;">📋</div>
      <div>Вставьте текст или загрузите файл ТЗ/контракта,<br>затем нажмите «Извлечь товары»</div>
    </div>`;
  }
  const headerEl = document.getElementById('aiResultsHeader');
  if (headerEl) headerEl.style.display = 'none';

  const hintEl = document.getElementById('aiSpecsHint');
  if (hintEl) hintEl.value = '';
  const ta = document.getElementById('aiSpecsTa');
  if (ta) ta.value = '';
  const taLen = document.getElementById('aiSpecsTaLen');
  if (taLen) taLen.textContent = '0 символов';

  // Update banner
  const fileBanner = document.getElementById('aiFileBanner');
  if (fileBanner) {
    if (isMiniappsMode()) {
      fileBanner.style.background = 'rgba(99,102,241,0.08)';
      fileBanner.style.borderColor = 'rgba(99,102,241,0.25)';
      fileBanner.innerHTML = '<p style="font-size:0.73rem;color:rgb(165,180,252);margin:0;line-height:1.5;">🟣 <strong>Claude Haiku</strong> читает PDF нативно — лучшее качество.</p>';
    } else {
      fileBanner.style.background = 'rgba(34,197,94,0.07)';
      fileBanner.style.borderColor = 'rgba(34,197,94,0.2)';
      fileBanner.innerHTML = '<p style="font-size:0.73rem;color:rgb(134,239,172);margin:0;line-height:1.5;">✅ PDF читается <strong>в браузере</strong> через PDF.js → DeepSeek.<br><span style="color:rgb(100,116,139);">Нет таймаутов. Если PDF скан — используйте «Текст».</span></p>';
    }
  }

  modal.classList.add('open');
  setTimeout(() => ta?.focus(), 150);
}

export function closeAiSpecsImport() {
  const modal = document.getElementById('aiSpecsImportModal');
  if (modal) modal.classList.remove('open');
}
