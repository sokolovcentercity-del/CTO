// Primary Docs v3 (real extraction via handler.php extract_text)

function getHandlerUrl() {
  return '/doc-checker/api/handler.php';
}

function parseJsonObject(raw) {
  const text = String(raw || '').trim();
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  const fenced = text.match(/```json\s*([\s\S]*?)```/i) || text.match(/```([\s\S]*?)```/);
  if (fenced) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {}
  }

  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start !== -1 && end !== -1 && end > start) {
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {}
  }

  return null;
}

async function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const base64 = result.includes(',') ? result.split(',')[1] : result;
      resolve(base64);
    };
    reader.onerror = () => reject(new Error('Не удалось прочитать файл'));
    reader.readAsDataURL(file);
  });
}

export function initPrimaryDocsView() {
  let modal = document.getElementById('primaryDocsModal');

  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'primaryDocsModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.7);z-index:300;display:none;align-items:center;justify-content:center;';

    modal.innerHTML = `
      <div style="width:90%;max-width:900px;background:#0f172a;border-radius:1rem;padding:1rem;display:flex;flex-direction:column;gap:0.75rem;max-height:90vh;">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:1rem;">
          <div>
            <div style="color:#fff;font-weight:700;">📄 Первичные документы</div>
            <div style="color:#94a3b8;font-size:0.8rem;">Извлечение текста через handler.php → анализ через DeepSeek</div>
          </div>
          <button id="primaryDocsClose" style="color:#fff;background:transparent;border:1px solid rgba(255,255,255,0.16);border-radius:0.5rem;padding:0.35rem 0.6rem;cursor:pointer;">✕</button>
        </div>

        <input id="primaryDocsInput" type="file" multiple />

        <div style="display:flex;gap:0.75rem;align-items:center;flex-wrap:wrap;">
          <button id="primaryDocsAnalyze" style="background:cyan;padding:0.55rem 0.9rem;border-radius:0.5rem;border:none;font-weight:700;cursor:pointer;">Анализировать</button>
          <div id="primaryDocsStatus" style="color:#94a3b8;font-size:0.8rem;"></div>
        </div>

        <div id="primaryDocsResults" style="overflow:auto;flex:1;min-height:160px;"></div>
      </div>
    `;

    document.body.appendChild(modal);
  }

  const closeBtn = document.getElementById('primaryDocsClose');
  const analyzeBtn = document.getElementById('primaryDocsAnalyze');
  const input = document.getElementById('primaryDocsInput');
  const resultsWrap = document.getElementById('primaryDocsResults');
  const statusEl = document.getElementById('primaryDocsStatus');

  if (closeBtn) closeBtn.onclick = () => { modal.style.display = 'none'; };

  if (analyzeBtn) {
    analyzeBtn.onclick = async () => {
      const files = Array.from(input?.files || []);
      if (!files.length) {
        resultsWrap.innerHTML = '<div style="color:#fca5a5;">Выберите хотя бы один файл.</div>';
        return;
      }

      analyzeBtn.disabled = true;
      resultsWrap.innerHTML = '';
      const out = [];

      try {
        for (let i = 0; i < files.length; i++) {
          const f = files[i];
          statusEl.textContent = `Файл ${i + 1}/${files.length}: ${f.name}`;
          resultsWrap.innerHTML = '<div style="color:#94a3b8;">⏳ Обработка...</div>';

          try {
            const base64 = await fileToBase64(f);

            const extracted = await fetch(getHandlerUrl(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'extract_text',
                file: base64,
                name: f.name,
              }),
            }).then(async (r) => {
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data?.error || ('HTTP ' + r.status));
              return data;
            });

            const text = String(extracted?.text || '').trim();
            if (!text || text.length < 20) {
              out.push({ name: f.name, error: 'Не удалось извлечь текст', method: extracted?.method || '-' });
              continue;
            }

            const analysis = await fetch(getHandlerUrl(), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                action: 'analyze',
                system: 'Верни строго JSON-объект без пояснений: {"type":"","number":"","date":"","itemsCount":0}.',
                messages: [
                  {
                    role: 'user',
                    content: `Файл: ${f.name}\n\nИзвлечённый текст:\n${text.slice(0, 120000)}`,
                  },
                ],
                max_tokens: 2000,
              }),
            }).then(async (r) => {
              const data = await r.json().catch(() => ({}));
              if (!r.ok) throw new Error(data?.error || ('HTTP ' + r.status));
              return data;
            });

            const parsed = parseJsonObject(analysis?.text || '');
            if (!parsed) {
              out.push({
                name: f.name,
                error: 'DeepSeek не вернул корректный JSON',
                method: extracted?.method || '-',
                raw: String(analysis?.text || '').slice(0, 1200),
              });
              continue;
            }

            out.push({
              name: f.name,
              method: extracted?.method || '-',
              length: extracted?.length || text.length,
              data: parsed,
            });
          } catch (e) {
            out.push({ name: f.name, error: e.message || 'Ошибка', method: '-' });
          }
        }
      } finally {
        statusEl.textContent = '';
        analyzeBtn.disabled = false;
      }

      resultsWrap.innerHTML = out.map((d) => {
        if (d.error) {
          return `
            <div style="border:1px solid #ef4444;border-radius:0.75rem;padding:0.75rem;margin-bottom:0.75rem;background:rgba(127,29,29,0.2);">
              <div style="color:#fff;font-weight:600;word-break:break-word;">${d.name}</div>
              <div style="color:#fca5a5;font-size:0.82rem;margin-top:0.25rem;">${d.error}</div>
              <div style="color:#94a3b8;font-size:0.75rem;margin-top:0.35rem;">Метод: ${d.method || '-'}</div>
              ${d.raw ? `<pre style="margin-top:0.5rem;white-space:pre-wrap;color:#cbd5e1;font-size:0.72rem;">${d.raw.replace(/</g, '&lt;')}</pre>` : ''}
            </div>`;
        }

        return `
          <div style="border:1px solid #334155;border-radius:0.75rem;padding:0.75rem;margin-bottom:0.75rem;background:rgba(15,23,42,0.65);">
            <div style="color:#fff;font-weight:600;word-break:break-word;">${d.name}</div>
            <div style="color:#94a3b8;font-size:0.75rem;margin-top:0.25rem;">Метод: ${d.method || '-'} · Символов: ${d.length || '-'}</div>
            <div style="color:#cbd5e1;font-size:0.84rem;margin-top:0.5rem;display:grid;gap:0.25rem;">
              <div><span style="color:#94a3b8;">Тип:</span> ${d.data?.type || '-'}</div>
              <div><span style="color:#94a3b8;">№:</span> ${d.data?.number || '-'}</div>
              <div><span style="color:#94a3b8;">Дата:</span> ${d.data?.date || '-'}</div>
              <div><span style="color:#94a3b8;">Позиций:</span> ${d.data?.itemsCount ?? '-'}</div>
            </div>
          </div>`;
      }).join('');
    };
  }

  let btn = document.getElementById('primaryDocsBtn');
  if (!btn) {
    btn = document.createElement('button');
    btn.id = 'primaryDocsBtn';
    btn.textContent = '📄 Первичка';
    btn.style.cssText = 'position:fixed;bottom:1rem;right:5rem;z-index:200;background:#0ea5e9;color:#000;padding:0.5rem 0.75rem;border-radius:0.5rem;border:none;font-weight:700;cursor:pointer;';
    document.body.appendChild(btn);
  }

  btn.onclick = () => {
    modal.style.display = 'flex';
  };
}
