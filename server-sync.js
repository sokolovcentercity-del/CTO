/**
 * server-sync.js — синхронизация файлов workspace → сервер
 * Берёт актуальные файлы из miniapps.ai workspace через fetch(),
 * отправляет на сервер через api/index.php?action=writefiles
 */

import { showToast } from './toast.js';

const THIS_URL = import.meta.url;
const UI_DIR   = THIS_URL.replace(/\/[^/]+$/, '/');
const ROOT_DIR = UI_DIR.replace(/ui\/$/, '');

const SERVER_URL = 'https://mto-cto.falcon28.ru/api/?action=writefiles';
const SYNC_PASSWORD_KEY = 'sync_password';

// Полный список файлов для синхронизации
function getFilesToSync() {
  return [
    // Корневые файлы
    { path: 'styles.css',        url: ROOT_DIR + 'styles.css' },
    { path: 'main.js',           url: ROOT_DIR + 'main.js' },
    { path: 'state.js',          url: ROOT_DIR + 'state.js' },
    { path: 'storage.js',        url: ROOT_DIR + 'storage.js' },
    { path: 'auth.js',           url: ROOT_DIR + 'auth.js' },
    { path: 'locales/ru.json',   url: ROOT_DIR + 'locales/ru.json' },
    { path: 'miniapp.i18n.json', url: ROOT_DIR + 'miniapp.i18n.json' },
    // UI модули
    { path: 'ui/dom.js',                      url: UI_DIR + 'dom.js' },
    { path: 'ui/i18n-fallback.js',            url: UI_DIR + 'i18n-fallback.js' },
    { path: 'ui/toast.js',                    url: UI_DIR + 'toast.js' },
    { path: 'ui/filters.js',                  url: UI_DIR + 'filters.js' },
    { path: 'ui/catalog-view.js',             url: UI_DIR + 'catalog-view.js' },
    { path: 'ui/product-list.js',             url: UI_DIR + 'product-list.js' },
    { path: 'ui/product-form.js',             url: UI_DIR + 'product-form.js' },
    { path: 'ui/categories.js',               url: UI_DIR + 'categories.js' },
    { path: 'ui/import-panel.js',             url: UI_DIR + 'import-panel.js' },
    { path: 'ui/recipients-view.js',          url: UI_DIR + 'recipients-view.js' },
    { path: 'ui/needs-matrix-view.js',        url: UI_DIR + 'needs-matrix-view.js' },
    { path: 'ui/needs-import-view.js',        url: UI_DIR + 'needs-import-view.js' },
    { path: 'ui/suppliers-view.js',           url: UI_DIR + 'suppliers-view.js' },
    { path: 'ui/contracts-view.js',           url: UI_DIR + 'contracts-view.js' },
    { path: 'ui/finance-view.js',             url: UI_DIR + 'finance-view.js' },
    { path: 'ui/receiving-view.js',           url: UI_DIR + 'receiving-view.js' },
    { path: 'ui/specs-import.js',             url: UI_DIR + 'specs-import.js' },
    { path: 'ui/act-form-view.js',            url: UI_DIR + 'act-form-view.js' },
    { path: 'ui/acts-registry-view.js',       url: UI_DIR + 'acts-registry-view.js' },
    { path: 'ui/orders-view.js',              url: UI_DIR + 'orders-view.js' },
    { path: 'ui/warehouse-view.js',           url: UI_DIR + 'warehouse-view.js' },
    { path: 'ui/shipment-view.js',            url: UI_DIR + 'shipment-view.js' },
    { path: 'ui/assembly-view.js',            url: UI_DIR + 'assembly-view.js' },
    { path: 'ui/data-io.js',                  url: UI_DIR + 'data-io.js' },
    { path: 'ui/warehouse-locations-view.js', url: UI_DIR + 'warehouse-locations-view.js' },
    { path: 'ui/resizable-cols.js',           url: UI_DIR + 'resizable-cols.js' },
    { path: 'ui/product-groups.js',           url: UI_DIR + 'product-groups.js' },
    { path: 'ui/frozen-table.js',             url: UI_DIR + 'frozen-table.js' },
    { path: 'ui/lib-loader.js',               url: UI_DIR + 'lib-loader.js' },
    { path: 'ui/reports-view.js',             url: UI_DIR + 'reports-view.js' },
    { path: 'ui/inject-contract-496.js',      url: UI_DIR + 'inject-contract-496.js' },
    { path: 'ui/inject-order-496-1.js',       url: UI_DIR + 'inject-order-496-1.js' },
    { path: 'ui/download-archive.js',         url: UI_DIR + 'download-archive.js' },
    { path: 'ui/server-sync.js',              url: UI_DIR + 'server-sync.js' },
    { path: 'ui/doc-check-view.js',           url: UI_DIR + 'doc-check-view.js' },
    // doc-checker
    { path: 'doc-checker/index.html',         url: ROOT_DIR + 'doc-checker/index.html' },
    { path: 'doc-checker/styles.css',         url: ROOT_DIR + 'doc-checker/styles.css' },
    { path: 'doc-checker/main.js',            url: ROOT_DIR + 'doc-checker/main.js' },
    { path: 'doc-checker/doc-analyzer.js',    url: ROOT_DIR + 'doc-checker/doc-analyzer.js' },
    { path: 'doc-checker/pdf-processor.js',   url: ROOT_DIR + 'doc-checker/pdf-processor.js' },
    { path: 'doc-checker/patterns.json',      url: ROOT_DIR + 'doc-checker/patterns.json' },
    { path: 'doc-checker/api/handler.php',    url: ROOT_DIR + 'doc-checker/api/handler.php' },
    { path: 'doc-checker/api/config.php',     url: ROOT_DIR + 'doc-checker/api/config.php' },
    // API (кроме data/)
    { path: 'api/index.php',                  url: ROOT_DIR + 'api/index.php' },
  ];
}

// Загрузить один файл из workspace
async function fetchWorkspaceFile(url) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    const resp = await fetch(url, { signal: ctrl.signal, cache: 'no-store', credentials: 'omit' });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, error: `HTTP ${resp.status}` };
    const text = await resp.text();
    return { ok: true, content: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ─── UI модал синхронизации ───────────────────────────────────────

function createSyncModal() {
  const existing = document.getElementById('serverSyncModal');
  if (existing) return existing;

  const modal = document.createElement('div');
  modal.id = 'serverSyncModal';
  modal.style.cssText = [
    'position:fixed', 'inset:0', 'z-index:9990',
    'display:none', 'align-items:flex-start', 'justify-content:center',
    'background:rgba(2,6,23,0.92)', 'backdrop-filter:blur(8px)',
    'overflow-y:auto', 'padding:1.5rem 1rem',
  ].join(';');

  modal.innerHTML = `
    <div style="width:100%;max-width:520px;margin:0 auto;">
      <div style="background:rgba(15,23,42,0.98);border:1px solid rgba(255,255,255,0.1);border-radius:1.5rem;padding:2rem;box-shadow:0 24px 64px rgba(0,0,0,0.6);">

        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:1.5rem;">
          <div style="display:flex;align-items:center;gap:0.75rem;">
            <span style="font-size:1.5rem;">🔄</span>
            <div>
              <h2 style="color:#fff;font-size:1.1rem;font-weight:700;margin:0;">Синхронизация с сервером</h2>
              <p style="color:rgb(100,116,139);font-size:0.75rem;margin:0.2rem 0 0;">mto-cto.falcon28.ru</p>
            </div>
          </div>
          <button id="syncModalCloseBtn" style="background:none;border:none;color:rgb(100,116,139);font-size:1.25rem;cursor:pointer;padding:0.25rem 0.5rem;border-radius:0.5rem;" aria-label="Закрыть">✕</button>
        </div>

        <div style="margin-bottom:1.25rem;">
          <label style="display:block;color:rgb(148,163,184);font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em;margin-bottom:0.5rem;">Пароль синхронизации</label>
          <input id="syncPasswordInput" type="password"
            style="width:100%;box-sizing:border-box;background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.65rem 1rem;color:#fff;font-size:0.9rem;outline:none;"
            placeholder="Введите пароль (по умолчанию: sync2025)">
          <p style="color:rgb(100,116,139);font-size:0.7rem;margin:0.4rem 0 0;">Пароль задаётся в <code style="background:rgba(255,255,255,0.08);padding:0.1em 0.3em;border-radius:0.25em;">api/index.php</code> константой <code style="background:rgba(255,255,255,0.08);padding:0.1em 0.3em;border-radius:0.25em;">WRITE_PASSWORD</code></p>
        </div>

        <div id="syncFileList" style="margin-bottom:1.25rem;max-height:280px;overflow-y:auto;border:1px solid rgba(255,255,255,0.07);border-radius:0.75rem;background:rgba(0,0,0,0.2);">
          <div style="padding:0.75rem 1rem;color:rgb(100,116,139);font-size:0.8rem;">
            Будет обновлено <strong style="color:#fff;" id="syncFileCount">0</strong> файлов
          </div>
        </div>

        <div id="syncProgressWrap" style="display:none;margin-bottom:1.25rem;">
          <div style="display:flex;justify-content:space-between;font-size:0.75rem;color:rgb(148,163,184);margin-bottom:0.4rem;">
            <span id="syncProgressLabel">Загрузка...</span>
            <span id="syncProgressPct">0%</span>
          </div>
          <div style="background:rgba(255,255,255,0.06);border-radius:99px;height:6px;overflow:hidden;">
            <div id="syncProgressBar" style="height:100%;background:linear-gradient(90deg,rgb(34,211,238),rgb(34,197,94));border-radius:99px;transition:width 0.3s;width:0%;"></div>
          </div>
          <div id="syncProgressDetail" style="font-size:0.72rem;color:rgb(100,116,139);margin-top:0.4rem;min-height:1rem;"></div>
        </div>

        <div id="syncResultWrap" style="display:none;margin-bottom:1.25rem;border-radius:0.75rem;padding:0.875rem 1rem;font-size:0.82rem;"></div>

        <div style="display:flex;gap:0.75rem;">
          <button id="syncStartBtn"
            style="flex:1;background:linear-gradient(135deg,rgb(34,211,238),rgb(6,182,212));border:none;border-radius:0.75rem;padding:0.75rem 1rem;color:#000;font-size:0.9rem;font-weight:700;cursor:pointer;transition:opacity 0.2s;">
            🚀 Обновить файлы на сервере
          </button>
          <button id="syncCancelBtn"
            style="background:rgba(255,255,255,0.05);border:1px solid rgba(255,255,255,0.1);border-radius:0.75rem;padding:0.75rem 1rem;color:rgb(148,163,184);font-size:0.85rem;cursor:pointer;">
            Отмена
          </button>
        </div>

        <p style="text-align:center;color:rgb(71,85,105);font-size:0.68rem;margin-top:1rem;margin-bottom:0;">
          ⚠️ api/data/storage.json (база данных) никогда не перезаписывается
        </p>
      </div>
    </div>`;

  document.body.appendChild(modal);
  return modal;
}

// Заполнить список файлов в модале
function populateFileList() {
  const files = getFilesToSync();
  const listEl = document.getElementById('syncFileList');
  const countEl = document.getElementById('syncFileCount');
  if (!listEl || !countEl) return;
  countEl.textContent = files.length;

  const groups = {
    'Корневые файлы':   files.filter(f => !f.path.includes('/')),
    'UI модули':        files.filter(f => f.path.startsWith('ui/')),
    'doc-checker':      files.filter(f => f.path.startsWith('doc-checker/')),
    'API':              files.filter(f => f.path.startsWith('api/')),
  };

  let html = '';
  for (const [group, groupFiles] of Object.entries(groups)) {
    if (!groupFiles.length) continue;
    html += `<div style="padding:0.5rem 1rem;background:rgba(255,255,255,0.03);border-bottom:1px solid rgba(255,255,255,0.05);">
      <span style="font-size:0.68rem;font-weight:700;text-transform:uppercase;letter-spacing:0.05em;color:rgb(100,116,139);">${group}</span>
    </div>`;
    groupFiles.forEach(f => {
      html += `<div id="syncFile_${CSS.escape(f.path)}" style="display:flex;align-items:center;gap:0.5rem;padding:0.35rem 1rem;border-bottom:1px solid rgba(255,255,255,0.03);font-size:0.75rem;">
        <span class="sync-status-icon" style="width:16px;text-align:center;flex-shrink:0;color:rgb(100,116,139);">○</span>
        <span style="flex:1;color:rgb(148,163,184);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${f.path}">${f.path}</span>
        <span class="sync-file-status" style="font-size:0.68rem;color:rgb(100,116,139);flex-shrink:0;"></span>
      </div>`;
    });
  }
  listEl.innerHTML = html;
}

function setFileStatus(path, icon, statusText, color) {
  try {
    const row = document.getElementById('syncFile_' + CSS.escape(path));
    if (!row) return;
    const iconEl = row.querySelector('.sync-status-icon');
    const statusEl = row.querySelector('.sync-file-status');
    if (iconEl) { iconEl.textContent = icon; iconEl.style.color = color; }
    if (statusEl) { statusEl.textContent = statusText; statusEl.style.color = color; }
  } catch { /* CSS.escape may not exist in old browsers */ }
}

// Основная функция синхронизации
async function runSync(password, onProgress) {
  const files = getFilesToSync();
  const total = files.length;
  let fetched = 0;
  let uploaded = 0;
  let failed = 0;

  onProgress(0, `Загрузка файлов из workspace (0/${total})...`, '');

  // 1. Загружаем все файлы из workspace параллельно (по 5)
  const BATCH = 5;
  const fileData = [];

  for (let i = 0; i < files.length; i += BATCH) {
    const batch = files.slice(i, i + BATCH);
    const results = await Promise.all(batch.map(async (f) => {
      const r = await fetchWorkspaceFile(f.url);
      fetched++;
      const pct = Math.round(fetched / total * 40);
      onProgress(pct, `Загрузка из workspace (${fetched}/${total})...`, f.path);

      if (r.ok) {
        setFileStatus(f.path, '⬆', 'ожидает', 'rgb(148,163,184)');
        return { path: f.path, content: r.content };
      } else {
        setFileStatus(f.path, '✕', 'не загружен', 'rgb(239,68,68)');
        failed++;
        return null;
      }
    }));
    fileData.push(...results.filter(Boolean));
  }

  onProgress(40, `Отправка на сервер (${fileData.length} файлов)...`, '');

  // 2. Отправляем на сервер батчами по 10 файлов
  const UPLOAD_BATCH = 10;
  const serverResults = [];

  for (let i = 0; i < fileData.length; i += UPLOAD_BATCH) {
    const batch = fileData.slice(i, i + UPLOAD_BATCH);
    const pct = 40 + Math.round((i / fileData.length) * 55);
    onProgress(pct, `Запись на сервер (${Math.min(i + UPLOAD_BATCH, fileData.length)}/${fileData.length})...`, '');

    try {
      const resp = await fetch(SERVER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password, files: batch }),
      });

      const data = await resp.json();
      if (!resp.ok || !data.ok) {
        // Весь батч провалился
        batch.forEach(f => {
          setFileStatus(f.path, '✕', 'ошибка сервера', 'rgb(239,68,68)');
          failed++;
        });
        if (resp.status === 403) {
          throw new Error('Неверный пароль синхронизации');
        }
        continue;
      }

      // Обрабатываем результаты по каждому файлу
      (data.results || []).forEach((r, idx) => {
        const filePath = batch[idx]?.path || r.path;
        if (r.ok) {
          setFileStatus(filePath, '✓', `${(r.size / 1024).toFixed(1)}КБ`, 'rgb(34,197,94)');
          uploaded++;
        } else {
          setFileStatus(filePath, '✕', r.error || 'ошибка', 'rgb(239,68,68)');
          failed++;
        }
      });
      serverResults.push(...(data.results || []));

    } catch (e) {
      if (e.message.includes('пароль')) throw e;
      batch.forEach(f => {
        setFileStatus(f.path, '✕', 'сеть', 'rgb(239,68,68)');
        failed++;
      });
    }
  }

  onProgress(100, 'Готово!', '');
  return { uploaded, failed, total };
}

// ─── Публичный API ────────────────────────────────────────────────

export function openServerSyncModal() {
  const modal = createSyncModal();

  // Восстановить пароль из sessionStorage
  const savedPwd = sessionStorage.getItem(SYNC_PASSWORD_KEY) || '';
  const pwdInput = document.getElementById('syncPasswordInput');
  if (pwdInput && savedPwd) pwdInput.value = savedPwd;

  populateFileList();

  modal.style.display = 'flex';

  // Кнопка закрыть
  const closeBtn = document.getElementById('syncModalCloseBtn');
  const cancelBtn = document.getElementById('syncCancelBtn');
  function closeModal() { modal.style.display = 'none'; }
  if (closeBtn) closeBtn.onclick = closeModal;
  if (cancelBtn) cancelBtn.onclick = closeModal;
  modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });

  // Escape
  const onKey = e => { if (e.key === 'Escape') { closeModal(); document.removeEventListener('keydown', onKey); } };
  document.addEventListener('keydown', onKey);

  // Кнопка запуска
  const startBtn = document.getElementById('syncStartBtn');
  if (startBtn) {
    startBtn.onclick = async () => {
      const pwd = document.getElementById('syncPasswordInput')?.value?.trim();
      if (!pwd) {
        showToast('Введите пароль синхронизации', 'warning');
        return;
      }

      // Сохранить пароль
      try { sessionStorage.setItem(SYNC_PASSWORD_KEY, pwd); } catch { /* */ }

      startBtn.disabled = true;
      startBtn.textContent = '⏳ Синхронизация...';
      if (cancelBtn) cancelBtn.disabled = true;

      const progressWrap = document.getElementById('syncProgressWrap');
      const resultWrap = document.getElementById('syncResultWrap');
      const progressBar = document.getElementById('syncProgressBar');
      const progressLabel = document.getElementById('syncProgressLabel');
      const progressPct = document.getElementById('syncProgressPct');
      const progressDetail = document.getElementById('syncProgressDetail');

      if (progressWrap) progressWrap.style.display = 'block';
      if (resultWrap) resultWrap.style.display = 'none';

      // Перезаполнить список (сброс статусов)
      populateFileList();

      function onProgress(pct, label, detail) {
        if (pct !== null && progressBar) {
          progressBar.style.width = pct + '%';
          if (progressPct) progressPct.textContent = pct + '%';
        }
        if (label && progressLabel) progressLabel.textContent = label;
        if (detail && progressDetail) progressDetail.textContent = detail;
      }

      try {
        const { uploaded, failed, total } = await runSync(pwd, onProgress);

        const ok = failed === 0;
        if (resultWrap) {
          resultWrap.style.display = 'block';
          resultWrap.style.background = ok
            ? 'rgba(34,197,94,0.1)'
            : 'rgba(245,158,11,0.1)';
          resultWrap.style.border = `1px solid ${ok ? 'rgba(34,197,94,0.3)' : 'rgba(245,158,11,0.3)'}`;
          resultWrap.style.color = ok ? 'rgb(74,222,128)' : 'rgb(251,191,36)';
          resultWrap.innerHTML = ok
            ? `✅ Успешно обновлено <strong>${uploaded}</strong> файлов на сервере!`
            : `⚠️ Обновлено: <strong>${uploaded}</strong> файлов. Ошибок: <strong>${failed}</strong>. Проверьте красные строки выше.`;
        }

        showToast(
          ok ? `✅ Синхронизировано ${uploaded} файлов` : `⚠ ${uploaded} OK, ${failed} ошибок`,
          ok ? 'success' : 'warning'
        );

      } catch (err) {
        if (resultWrap) {
          resultWrap.style.display = 'block';
          resultWrap.style.background = 'rgba(239,68,68,0.1)';
          resultWrap.style.border = '1px solid rgba(239,68,68,0.3)';
          resultWrap.style.color = 'rgb(252,165,165)';
          resultWrap.textContent = '❌ Ошибка: ' + err.message;
        }
        showToast('Ошибка синхронизации: ' + err.message, 'error');
      } finally {
        startBtn.disabled = false;
        startBtn.textContent = '🔄 Синхронизировать снова';
        if (cancelBtn) cancelBtn.disabled = false;
      }
    };
  }
}
