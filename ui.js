/**
 * doc-checker/ui.js — рендер результатов, скачивание, паттерны
 * v1-split
 */

import { getTypeLabel, getTypeIcon, round2, fmtNum, fmtExact } from './core.js';

const $ = id => document.getElementById(id);

// ─── Утилиты ──────────────────────────────────────────────────────────────────

export function escHtml(str) {
  return (str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function markdownToHtml(text) {
  return (text || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/^### (.+)$/gm, '<h4>$1</h4>').replace(/^## (.+)$/gm, '<h3>$1</h3>').replace(/^# (.+)$/gm, '<h2>$1</h2>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/^- (.+)$/gm, '<li>$1</li>').replace(/(<li>.*<\/li>)/gs, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>').replace(/^(?!<[hul])(.+)$/gm, '<p>$1</p>').replace(/<p><\/p>/g, '');
}

export function showToast(message, type = 'info', duration = 4500) {
  const container = $('toastContainer');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = 'toast toast-' + type;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), duration);
}

export function setProgress(pct, stage, detail) {
  if (pct !== null) { $('progressBar').style.width = pct + '%'; $('progressBar').setAttribute('aria-valuenow', pct); }
  if (stage)  $('progressStageLabel').textContent = stage;
  if (detail) $('progressText').textContent = detail;
}

export function dateSlug() { return new Date().toISOString().slice(0, 10); }
export function triggerDownload(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ─── Рендер карточек документов ──────────────────────────────────────────────

const ZONE_TAG_CSS = { 1: 'zone-tag-1', 2: 'zone-tag-2', 3: 'zone-tag-3', 4: 'zone-tag-4' };
const ZONE_NAMES   = { 1: 'Окно 1', 2: 'Окно 2', 3: 'Окно 3', 4: 'Окно 4' };

export function renderDocCards(documents) {
  const wrap = $('docCardsWrap');
  if (!documents.length) { wrap.innerHTML = '<div style="color:#64748b;">Нет успешно обработанных документов</div>'; return; }
  wrap.innerHTML = documents.map(d => {
    // В новом формате d.data=null, данные хранятся в results.rawData
    // Показываем только имя файла, зону и тип
    if (!d.data) {
      const zone = d.zone || 4;
      const icon = getTypeIcon(d.type);
      return '<div class="doc-card">' +
        '<div class="doc-card-header"><div class="doc-card-icon">' + icon + '</div>' +
        '<div><div class="doc-card-title">' + escHtml(d.filename) + '</div>' +
        '<span class="doc-card-zone ' + ZONE_TAG_CSS[zone] + '">' + ZONE_NAMES[zone] + '</span></div></div></div>';
    }
    const data  = d.data || {};
    const items = data.items || [];
    const totals = data.totals || {};
    const zone  = d.zone || 4;
    const icon  = getTypeIcon(d.type);
    const fields = [
      ['Тип',      getTypeLabel(d.type)],
      ['Номер',    data.doc_number],
      ['Дата',     data.doc_date],
      ['Продавец', data.seller?.name ? (data.seller.name + (data.seller.inn ? ' / ИНН ' + data.seller.inn : '')) : null],
      ['Покупатель', data.buyer?.name ? (data.buyer.name + (data.buyer.inn ? ' / ИНН ' + data.buyer.inn : '')) : null],
      ['Договор',  data.contract_ref],
      ['Итого',    totals.amount_with_vat ? fmtNum(totals.amount_with_vat) + ' руб.' : null],
    ].filter(([, v]) => v);
    const itemsHtml = items.length > 0
      ? '<div class="doc-card-items"><div class="doc-card-items-title">Позиции (' + items.length + ')</div><table class="doc-card-items-table"><tr><th>Наименование</th><th>Кол.</th><th>Сумма с НДС</th></tr>' +
        items.slice(0, 5).map(it => '<tr><td>' + escHtml(it.name || '') + '</td><td>' + (it.qty || '') + '</td><td style="text-align:right">' + fmtNum(it.total) + '</td></tr>').join('') +
        (items.length > 5 ? '<tr><td colspan="3" style="color:#64748b;font-size:0.7rem;">...ещё ' + (items.length - 5) + ' позиций</td></tr>' : '') +
        '</table></div>'
      : '';
    const notesHtml = data.notes ? '<div style="margin-top:0.6rem;font-size:0.72rem;color:#94a3b8;border-top:1px solid rgba(255,255,255,0.06);padding-top:0.5rem;">' + escHtml(data.notes) + '</div>' : '';
    return '<div class="doc-card">' +
      '<div class="doc-card-header">' +
        '<div class="doc-card-icon">' + icon + '</div>' +
        '<div><div class="doc-card-title">' + escHtml(data.doc_name || d.filename) + '</div>' +
        '<div class="doc-card-file">' + escHtml(d.filename) + '</div>' +
        '<span class="doc-card-zone ' + ZONE_TAG_CSS[zone] + '">' + ZONE_NAMES[zone] + '</span></div>' +
      '</div>' +
      '<div class="doc-card-fields">' + fields.map(([label, val]) => '<div class="doc-field"><span class="doc-field-label">' + label + ':</span><span class="doc-field-value">' + escHtml(String(val)) + '</span></div>').join('') + '</div>' +
      itemsHtml + notesHtml + '</div>';
  }).join('');
}

// ─── Рендер сводной таблицы ───────────────────────────────────────────────────

const SECTION_STYLES = {
  payment:   { headerBg: 'rgba(59,130,246,0.15)',  border: 'rgba(59,130,246,0.5)',  icon: '📄', label: 'Документ на оплату' },
  primary:   { headerBg: 'rgba(100,116,139,0.12)', border: 'rgba(100,116,139,0.4)', icon: '📦', label: 'Первичный документ'  },
  registry:  { headerBg: 'rgba(234,179,8,0.1)',    border: 'rgba(234,179,8,0.5)',   icon: '📊', label: 'Реестр (не суммируется)'  },
  aggregate: { headerBg: 'rgba(34,197,94,0.12)',   border: 'rgba(34,197,94,0.5)',   icon: '📊', label: 'Итого по первичным'  },
  extra:     { headerBg: 'rgba(168,85,247,0.12)',  border: 'rgba(168,85,247,0.5)',  icon: '📎', label: 'Доп. документ'       },
};

export function renderSummaryTable(sections) {
  const wrap = $('summaryTableWrap');
  if (!sections || !sections.length) { wrap.innerHTML = '<div style="color:#64748b;padding:1rem;">Нет данных для сводной таблицы</div>'; return; }
  const cols = ['Наименование товара', 'Ед.', 'Кол-во', 'Цена', 'Без НДС', 'НДС', 'С НДС'];
  let html = '<table class="summary-table"><thead><tr>' + cols.map(c => '<th>' + c + '</th>').join('') + '</tr></thead><tbody>';
  sections.forEach(section => {
    const st = SECTION_STYLES[section.kind] || SECTION_STYLES.extra;
    html += '<tr class="row-section-header" style="background:' + st.headerBg + ';border-left:3px solid ' + st.border + ';">' +
      '<td colspan="7" style="padding:0.6rem 0.75rem;"><span style="font-weight:700;font-size:0.85rem;">' + st.icon + ' ' + escHtml(section.label) + '</span>' +
      (section.filename ? '<span style="font-size:0.7rem;color:#94a3b8;margin-left:0.75rem;">📄 ' + escHtml(section.filename) + '</span>' : '') + '</td></tr>';
    if (section.kind === 'registry') {
      html += '<tr><td colspan="7" style="font-size:0.72rem;color:#d97706;padding:0.25rem 0.75rem 0.4rem;' +
        'background:rgba(234,179,8,0.06);border-bottom:1px solid rgba(234,179,8,0.2);">' +
        '⚠️ <strong>Реестр — не первичный документ.</strong> Это список первичных документов. ' +
        'В итоговую сумму <strong>не включается</strong>. ' +
        'Каждая строка реестра должна совпадать с соответствующим первичным документом в пакете.' +
        '</td></tr>';
    }
    const metaParts = [];
    if (section.docDate) metaParts.push('Дата: <strong>' + escHtml(section.docDate) + '</strong>');
    if (section.seller?.name) {
      const inn = section.seller.inn ? ' (ИНН ' + escHtml(section.seller.inn) + ')' : '';
      metaParts.push('Поставщик: <strong>' + escHtml(section.seller.name) + inn + '</strong>');
    }
    if (section.buyer?.name) metaParts.push('Получатель: <strong>' + escHtml(section.buyer.name) + '</strong>');
    if (section.kind === 'extra') {
      if (section.issuer)         metaParts.push('Выдан: <strong>' + escHtml(section.issuer) + '</strong>');
      if (section.validUntil)     metaParts.push('Действует до: <strong>' + escHtml(section.validUntil) + '</strong>');
      if (section.productName)    metaParts.push('Товар: <strong>' + escHtml(section.productName) + '</strong>');
      if (section.warrantyMonths) metaParts.push('Гарантия: <strong>' + section.warrantyMonths + ' мес.</strong>');
      if (section.technicalRegs?.length) metaParts.push('ТР ТС: <strong>' + escHtml(section.technicalRegs.join(', ')) + '</strong>');
    }
    if (metaParts.length) {
      html += '<tr><td colspan="7" style="font-size:0.72rem;color:#94a3b8;padding:0.25rem 0.75rem 0.4rem;border-bottom:1px solid rgba(255,255,255,0.05);">' + metaParts.join(' &nbsp;|&nbsp; ') + '</td></tr>';
    }
    if (section.kind === 'extra') {
      const rows = [];
      if (section.claimAmount)  rows.push(['Сумма претензии', fmtNum(section.claimAmount) + ' руб.']);
      if (section.claimSubject) rows.push(['Предмет претензии', escHtml(section.claimSubject)]);
      const sig = section.signatures;
      if (sig) {
        const sigStatus  = sig.signed === true ? '✅ Подписан' : sig.signed === false ? '❌ Не подписан' : '';
        const stmpStatus = sig.stamp  === true ? '✅ Печать есть' : sig.stamp === false ? '⚠️ Без печати' : '';
        const sigStr = [sigStatus, stmpStatus].filter(Boolean).join(' &nbsp; ');
        if (sigStr) rows.push(['Подпись / Печать', sigStr]);
      }
      if (section.notes) rows.push(['Примечания', escHtml(section.notes)]);
      if (rows.length) {
        html += rows.map(([label, val]) => '<tr><td style="color:#94a3b8;font-size:0.75rem;width:160px;">' + escHtml(label) + '</td><td colspan="6" style="font-size:0.82rem;">' + val + '</td></tr>').join('');
      } else {
        html += '<tr><td colspan="7" class="cell-na">Данные извлечены — см. карточку документа выше</td></tr>';
      }
      html += '<tr style="height:8px;background:rgba(0,0,0,0.3);"><td colspan="7"></td></tr>';
      return;
    }
    const items = section.items || [];
    if (items.length) {
      items.forEach(item => {
        html += '<tr>' +
          '<td>' + escHtml(item.name || '') + '</td>' +
          '<td style="white-space:nowrap;">' + escHtml(item.unit || '') + '</td>' +
          '<td class="cell-number">' + (item.qty != null ? item.qty : '') + '</td>' +
          '<td class="cell-number">' + (item.price ? fmtNum(item.price) : '') + '</td>' +
          '<td class="cell-number">' + (item.amount ? fmtNum(item.amount) : '') + '</td>' +
          '<td class="cell-number">' + (item.vat_amount ? fmtNum(item.vat_amount) : '') + '</td>' +
          '<td class="cell-number">' + (item.total ? fmtNum(item.total) : '') + '</td></tr>';
      });
    } else {
      html += '<tr><td colspan="7" class="cell-na">Позиции не извлечены</td></tr>';
    }
    const t = section.totals || {};
    let compareRow = '';
    if (section.kind === 'aggregate' && section.compareWith) {
      const payTotal  = round2(section.compareWith.amount_with_vat || 0);
      const primTotal = round2(t.amount_with_vat || 0);
      const diff = round2(Math.abs(payTotal - primTotal));
      const matchOk = diff < 0.02;
      const matchLabel = matchOk ? '✅ Совпадает с документом на оплату' : '🔴 Расхождение с документом на оплату: ' + fmtNum(diff) + ' руб.';
      compareRow = '<tr class="row-total" style="background:' + (matchOk ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)') + ';font-weight:700;">' +
        '<td colspan="4" class="' + (matchOk ? 'cell-match' : 'cell-mismatch') + '">' + matchLabel + '</td>' +
        '<td class="cell-number">' + (payTotal ? fmtNum(section.compareWith.amount_no_vat || 0) : '') + '</td>' +
        '<td class="cell-number">' + (payTotal ? fmtNum(section.compareWith.vat_amount || 0) : '') + '</td>' +
        '<td class="cell-number">' + (payTotal ? fmtNum(payTotal) : '') + '</td></tr>';
    }
    html += '<tr class="row-total"><td colspan="4" style="font-weight:600;">Итого</td>' +
      '<td class="cell-number">' + (t.amount_no_vat   ? fmtNum(t.amount_no_vat)   : '—') + '</td>' +
      '<td class="cell-number">' + (t.vat_amount       ? fmtNum(t.vat_amount)       : '—') + '</td>' +
      '<td class="cell-number">' + (t.amount_with_vat  ? fmtNum(t.amount_with_vat)  : '—') + '</td>' +
      '</tr>' + compareRow;
    html += '<tr style="height:8px;background:rgba(0,0,0,0.3);"><td colspan="7"></td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

// ─── Рендер нарушений ─────────────────────────────────────────────────────────

const SEV_CONFIG = {
  critical:    { label: 'Критично',     cls: 'sev-critical',    icon: '🔴', badge: 'badge-critical'    },
  significant: { label: 'Существенно',  cls: 'sev-significant', icon: '🟠', badge: 'badge-significant' },
  warning:     { label: 'Замечание',    cls: 'sev-warning',     icon: '🟡', badge: 'badge-warning'     },
  info:        { label: 'Информация',   cls: 'sev-info',        icon: '🔵', badge: 'badge-info'        },
};

export function renderChronology(chronology) {
  const wrap = document.getElementById('chronologyWrap');
  if (!wrap) return;
  const items = (chronology || []).filter(c => c.date || c.docName);
  if (!items.length) {
    wrap.innerHTML = '<div style="color:#64748b;font-size:0.8rem;padding:0.5rem 0;">Хронология не извлечена моделью</div>';
    return;
  }
  let html = '<table style="width:100%;border-collapse:collapse;font-size:0.82rem;">' +
    '<thead><tr>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;width:110px;">Дата</th>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;width:200px;">Документ</th>' +
    '<th style="text-align:left;padding:0.4rem 0.6rem;border-bottom:1px solid rgba(255,255,255,0.1);color:#94a3b8;font-weight:600;">Событие / Нарушение</th>' +
    '</tr></thead><tbody>';
  items.forEach(c => {
    const hasViolation = c.violation && c.violation !== 'null' && c.violation !== null;
    const rowBg = hasViolation ? 'background:rgba(239,68,68,0.07);' : '';
    const violationHtml = hasViolation
      ? '<div style="color:#f87171;font-size:0.75rem;margin-top:0.2rem;">⚠️ ' + escHtml(c.violation) + '</div>'
      : '';
    html += '<tr style="' + rowBg + 'border-bottom:1px solid rgba(255,255,255,0.05);">' +
      '<td style="padding:0.4rem 0.6rem;white-space:nowrap;color:#e2e8f0;font-weight:' + (hasViolation ? '600' : '400') + ';">' + escHtml(c.date || '—') + '</td>' +
      '<td style="padding:0.4rem 0.6rem;color:#94a3b8;font-size:0.77rem;">' + escHtml((c.docName || '').slice(0, 60)) + '</td>' +
      '<td style="padding:0.4rem 0.6rem;">' +
        '<div style="color:#cbd5e1;">' + escHtml(c.event || '') + '</div>' + violationHtml +
      '</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
}

export function renderIssues(issues, onFeedback) {
  const counts = { critical: 0, significant: 0, warning: 0, info: 0 };
  issues.forEach(i => { if (counts[i.severity] !== undefined) counts[i.severity]++; });
  $('issueCountBadges').innerHTML = Object.entries(counts).filter(([, n]) => n > 0).map(([sev, n]) => {
    const s = SEV_CONFIG[sev];
    return '<span class="issue-badge ' + s.badge + '">' + s.icon + ' ' + n + ' ' + s.label + '</span>';
  }).join('');
  const list = $('issuesList');
  if (!issues.length) { list.innerHTML = '<div class="no-issues">✅ Программных нарушений не выявлено</div>'; return; }
  const byCategory = {};
  issues.forEach(i => {
    // Поддержка обоих форматов: {message,detail} и {text}
    if (!i.message && i.text) { i.message = i.text; }
    const cat = i.category || 'Прочее';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(i);
  });
  list.innerHTML = Object.entries(byCategory).map(([cat, catIssues]) =>
    '<div class="issue-group"><div class="issue-group-title">' + escHtml(cat) + '</div>' +
    catIssues.map((issue, idx) => {
      const s = SEV_CONFIG[issue.severity] || SEV_CONFIG.info;
      const issueId = encodeURIComponent(cat + '_' + idx);
      return '<div class="issue-item ' + s.cls + '" data-issue-id="' + issueId + '">' +
        '<span class="issue-icon">' + s.icon + '</span>' +
        '<div class="issue-body"><div class="issue-msg">' + escHtml(issue.message) + '</div>' +
        (issue.detail ? '<div class="issue-detail">' + escHtml(issue.detail) + '</div>' : '') + '</div>' +
        '<button class="issue-feedback-btn" data-issue-msg="' + escHtml(issue.message) + '" title="Сообщить об ошибке распознавания">🐛 Ошибка</button>' +
        '</div>';
    }).join('') + '</div>'
  ).join('');
  list.addEventListener('click', e => {
    const btn = e.target.closest('.issue-feedback-btn');
    if (!btn) return;
    onFeedback?.(btn.dataset.issueMsg || '');
  });
}

// ─── Скачивание архива ────────────────────────────────────────────────────────

export async function downloadArchive(results) {
  const btn      = $('downloadArchiveBtn');
  const btnIcon  = $('downloadArchiveBtnIcon');
  const btnLabel = $('downloadArchiveBtnLabel');
  if (!btn || !results) return;
  btn.disabled = true;
  if (btnIcon)  btnIcon.textContent  = '⏳';
  if (btnLabel) btnLabel.textContent = 'Формирую архив...';
  try {
    const slug = dateSlug();
    if (btnLabel) btnLabel.textContent = 'Загружаю библиотеки...';
    let XLSX, JSZip;
    try {
      [XLSX, JSZip] = await Promise.all([loadXLSX(), loadJSZip()]);
    } catch (libErr) {
      showToast('Ошибка загрузки библиотек: ' + libErr.message, 'error', 6000);
      btn.disabled = false;
      if (btnIcon)  btnIcon.textContent  = '📦';
      if (btnLabel) btnLabel.textContent = 'Скачать отчёт';
      return;
    }
    const zip = new JSZip();
    try { zip.file('report-' + slug + '.html', new Blob([injectPrintStyles(buildReportHtml(results))], { type: 'text/html;charset=utf-8' })); } catch (e) { console.warn('HTML step failed:', e); }
    try { zip.file('report-' + slug + '.rtf', new Blob([buildRtfReport(results)], { type: 'application/rtf' })); } catch (e) { console.warn('RTF step failed:', e); }
    try {
      const xlsxBlob = await buildExcelBlob(XLSX, results);
      zip.file('table-' + slug + '.xlsx', xlsxBlob);
    } catch (e) { console.warn('Excel step failed:', e); }
    const zipBlob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    triggerDownload(zipBlob, 'doc-check-' + slug + '.zip');
    showToast('✅ Архив скачан. Для PDF откройте report-*.html → Ctrl+P → Сохранить как PDF', 'success', 7000);
  } catch (err) {
    console.error('Archive error:', err);
    showToast('Ошибка: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    if (btnIcon)  btnIcon.textContent  = '📦';
    if (btnLabel) btnLabel.textContent = 'Скачать отчёт';
  }
}

function injectPrintStyles(html) {
  const printCss = '<style>@media print { body { background:#fff!important;color:#000!important;font-family:Arial,sans-serif;font-size:11pt; } .upload-grid,.actions-row,.progress-card,#confirmOverlay,.toast-container,.hint-block,.prompt-card,.download-row,.api-key-card{display:none!important;} .summary-table th{background:#e8f4f8!important;color:#000!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;} .row-section-header td{background:#f0f0f0!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;} .issue-item{border-left:3px solid #999!important;background:#f9f9f9!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;} @page{margin:15mm;} }</style>';
  return html.replace('</head>', printCss + '</head>');
}

function buildReportHtml(results) {
  if (!results) return '';
  const { issues, conclusion, documents, summaryData } = results;
  // Нормализуем формат нарушений
  issues.forEach(i => { if (!i.message && i.text) i.message = i.text; });
  const date = new Date().toLocaleString('ru-RU');
  const critCount = issues.filter(i => i.severity === 'critical').length;
  const sigCount  = issues.filter(i => i.severity === 'significant').length;
  const summaryHtml = (() => {
    if (!summaryData?.length) return '';
    let h = '<h2>Сводная таблица</h2><table border="1" cellpadding="5" cellspacing="0" style="border-collapse:collapse;width:100%;font-size:13px;"><tr style="background:#e8f4f8;"><th>Наименование</th><th>Ед.</th><th>Кол-во</th><th>Цена</th><th>Без НДС</th><th>НДС</th><th>С НДС</th></tr>';
    summaryData.forEach(section => {
      const bg = { payment: '#dbeafe', primary: '#f1f5f9', aggregate: '#dcfce7', extra: '#f5f0ff' }[section.kind] || '#f1f5f9';
      h += '<tr style="background:' + bg + ';font-weight:bold;"><td colspan="7">' + escHtml(section.label) + '</td></tr>';
      if (section.kind === 'extra') {
        if (section.claimAmount)  h += '<tr><td>Сумма претензии</td><td colspan="6">' + fmtNum(section.claimAmount) + ' руб.</td></tr>';
        if (section.notes)        h += '<tr><td>Примечания</td><td colspan="6">' + escHtml(section.notes) + '</td></tr>';
        return;
      }
      (section.items || []).forEach(item => {
        h += '<tr><td>' + escHtml(item.name || '') + '</td><td>' + escHtml(item.unit || '') + '</td><td align="right">' + (item.qty != null ? item.qty : '') + '</td><td align="right">' + (item.price ? fmtNum(item.price) : '') + '</td><td align="right">' + (item.amount ? fmtNum(item.amount) : '') + '</td><td align="right">' + (item.vat_amount ? fmtNum(item.vat_amount) : '') + '</td><td align="right">' + (item.total ? fmtNum(item.total) : '') + '</td></tr>';
      });
      const t = section.totals || {};
      h += '<tr style="background:#f0f0f0;font-weight:bold;"><td colspan="4">Итого</td><td align="right">' + (t.amount_no_vat ? fmtNum(t.amount_no_vat) : '') + '</td><td align="right">' + (t.vat_amount ? fmtNum(t.vat_amount) : '') + '</td><td align="right">' + (t.amount_with_vat ? fmtNum(t.amount_with_vat) : '') + '</td></tr>';
    });
    return h + '</table>';
  })();
  return '<!DOCTYPE html><html lang="ru"><head><meta charset="utf-8"><title>Отчёт проверки — ' + date + '</title>' +
    '<style>body{font-family:Arial,sans-serif;max-width:960px;margin:40px auto;padding:0 20px;color:#222;font-size:14px;}.print-btn{background:#4a90d9;color:#fff;border:none;padding:10px 24px;border-radius:6px;font-size:14px;cursor:pointer;margin-bottom:20px;}@media print{.print-btn{display:none;}}h1{color:#1a1a2e;border-bottom:2px solid #4a90d9;padding-bottom:10px;}h2{color:#2c3e50;margin-top:30px;font-size:16px;}.meta{color:#666;font-size:13px;margin-bottom:20px;}.issue{padding:8px 12px;margin:6px 0;border-radius:4px;border-left:4px solid;}.issue.critical{background:#fff5f5;border-color:#e53e3e;}.issue.significant{background:#fffaf0;border-color:#dd6b20;}.issue.warning{background:#fffff0;border-color:#d69e2e;}.issue.info{background:#ebf8ff;border-color:#3182ce;}.issue-msg{font-weight:bold;margin-bottom:3px;}.issue-detail{font-size:12px;color:#555;}.conclusion{background:#f7f9fc;border:1px solid #ddd;border-radius:6px;padding:20px;white-space:pre-wrap;line-height:1.7;}.no-issues{color:#38a169;font-weight:bold;padding:12px;background:#f0fff4;border-radius:4px;}.doc-list{background:#f8f9fa;border-radius:6px;padding:12px;margin-bottom:16px;}.doc-item{padding:4px 0;border-bottom:1px solid #e9ecef;font-size:13px;}</style>' +
    '</head><body>' +
    '<h1>📋 Отчёт проверки пакета документов на оплату</h1>' +
    '<button class="print-btn" onclick="window.print()">🖨️ Печать / Сохранить как PDF</button>' +
    '<p class="meta">Дата: ' + date + ' | Документов: ' + documents.length + ' | Критических нарушений: ' + critCount + ' | Существенных: ' + sigCount + '</p>' +
    '<h2>Проверенные документы</h2><div class="doc-list">' +
    documents.map(d => '<div class="doc-item">' + getTypeIcon(d.type) + ' <strong>' + escHtml(d.filename) + '</strong> — ' + getTypeLabel(d.type) + (d.data?.doc_name ? ' (' + escHtml(d.data.doc_name) + ')' : '') + '</div>').join('') +
    '</div>' + summaryHtml +
    '<h2>Программные проверки (' + issues.length + ' нарушений)</h2>' +
    (issues.length === 0 ? '<div class="no-issues">✅ Нарушений не выявлено</div>' : issues.map(i => '<div class="issue ' + i.severity + '"><div class="issue-msg">' + escHtml(i.message) + '</div>' + (i.detail ? '<div class="issue-detail">' + escHtml(i.detail) + '</div>' : '') + '</div>').join('')) +
    '<h2>Заключение AI (Claude)</h2><div class="conclusion">' + escHtml(conclusion) + '</div></body></html>';
}

// ─── Excel: нативный XML-генератор (без зависимости от SheetJS Pro cellStyles) ──

function buildExcelBlob(_XLSX, results) {
  // Генерируем xlsx напрямую через XML — единственный способ получить
  // цвета/стили в бесплатной версии SheetJS (cellStyles: true — только Pro).
  const { summaryData, issues, documents } = results;
  const reportDate = new Date().toLocaleString('ru-RU');

  // ── XML-утилиты ────────────────────────────────────────────────────────────
  function xmlEsc(s) {
    return (s == null ? '' : String(s))
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
  }
  function parseNum(v) {
    if (v == null || v === '') return null;
    if (typeof v === 'number') return v;
    const n = parseFloat(String(v).replace(/\s/g, '').replace(',', '.'));
    return isNaN(n) ? null : n;
  }

  // ── Стили (индексы в массиве styles) ───────────────────────────────────────
  // styleId: 0=default, 1=header, 2=sectionPayment, 3=sectionPrimary,
  //          4=sectionAggregate, 5=sectionExtra,
  //          6=meta, 7=data, 8=dataRight, 9=num,
  //          10=totalNeutral, 11=totalOk, 12=totalBad,
  //          13=totalLabelNeutral, 14=totalLabelOk, 15=totalLabelBad,
  //          16=spacer,
  //          17=sevCritical, 18=sevSignificant, 19=sevWarning, 20=sevInfo,
  //          21=sevCriticalBold, 22=docRow
  const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="14">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><sz val="11"/><b/><name val="Calibri"/><color rgb="FF1E293B"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF1E293B"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF1E293B"/></font>
    <font><sz val="9"/><i/><name val="Calibri"/><color rgb="FF64748B"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF475569"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF15803D"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FFB91C1C"/></font>
    <font><sz val="10"/><b/><name val="Calibri"/><color rgb="FF92400E"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FFB91C1C"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FFB45309"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF92400E"/></font>
    <font><sz val="10"/><name val="Calibri"/><color rgb="FF1D4ED8"/></font>
    <font><sz val="13"/><b/><name val="Calibri"/><color rgb="FF1E293B"/></font>
  </fonts>
  <fills count="18">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE2E8F0"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDBEAFE"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF1F5F9"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFDCFCE7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF5F0FF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF8FAFC"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFCBD5E1"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEE2E2"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEF3C7"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFEFCE8"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFEFF6FF"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFE8F4F8"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFD1FAE5"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFCE8E8"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFF0FFF4"/></patternFill></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FFFFF0F0"/></patternFill></fill>
  </fills>
  <borders count="4">
    <border><left/><right/><top/><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="medium"><color rgb="FF94A3B8"/></bottom><diagonal/></border>
    <border><left/><right/><top style="medium"><color rgb="FF94A3B8"/></top><bottom/><diagonal/></border>
    <border><left/><right/><top/><bottom style="thin"><color rgb="FFE2E8F0"/></bottom><diagonal/></border>
  </borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="23">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="13" borderId="1" xfId="0"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="3" fillId="3" borderId="0" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="0" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="5" borderId="0" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="6" borderId="0" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="4" fillId="7" borderId="0" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="3" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="3" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4"  fontId="2" fillId="0" borderId="3" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4"  fontId="3" fillId="4" borderId="2" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4"  fontId="6" fillId="14" borderId="2" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="4"  fontId="7" fillId="15" borderId="2" xfId="0"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="0" fontId="3" fillId="4" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="6" fillId="14" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="7" fillId="15" borderId="2" xfId="0"><alignment horizontal="left" vertical="center"/></xf>
    <xf numFmtId="0" fontId="0" fillId="8" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="9" fillId="9"  borderId="3" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="10" fillId="10" borderId="3" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="11" fillId="11" borderId="3" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="12" fillId="12" borderId="3" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="7" fillId="9"  borderId="3" xfId="0"><alignment horizontal="left" vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="2" fillId="4" borderId="3" xfId="0"><alignment horizontal="left" vertical="center" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`;

  // ── Построитель листа ──────────────────────────────────────────────────────
  class SheetBuilder {
    constructor() {
      this.rows = []; // [{r, cells:[{c,v,t,s,f}]}, ...]
      this.merges = [];
      this.colWidths = [];
      this._r = 0;
    }
    get r() { return this._r; }
    addRow(cells) {
      this.rows.push({ r: this._r, cells });
      this._r++;
      return this._r - 1;
    }
    emptyRow() { this.rows.push({ r: this._r, cells: [] }); this._r++; }
    merge(r1, c1, r2, c2) { this.merges.push([r1, c1, r2, c2]); }
    // cell helpers
    s(v, styleId) { return { v: String(v == null ? '' : v), t: 's', s: styleId }; }
    n(v, styleId) { const num = parseNum(v); return num != null ? { v: num, t: 'n', s: styleId } : { v: '', t: 's', s: styleId }; }
    toXml(sheetName) {
      const colsXml = this.colWidths.length
        ? '<cols>' + this.colWidths.map((w, i) => `<col min="${i+1}" max="${i+1}" width="${w}" customWidth="1"/>`).join('') + '</cols>'
        : '';
      const mergesXml = this.merges.length
        ? '<mergeCells count="' + this.merges.length + '">' +
          this.merges.map(([r1,c1,r2,c2]) => `<mergeCell ref="${colLetter(c1)}${r1+1}:${colLetter(c2)}${r2+1}"/>`).join('') +
          '</mergeCells>'
        : '';
      const rowsXml = this.rows.map(row => {
        if (!row.cells.length) return `<row r="${row.r+1}"><c r="${colLetter(0)}${row.r+1}" s="16" t="s"><v></v></c></row>`;
        const cellsXml = row.cells.map(cell => {
          const addr = `${colLetter(cell.c)}${row.r+1}`;
          if (cell.t === 'n') return `<c r="${addr}" s="${cell.s}"><v>${cell.v}</v></c>`;
          const shared = cell._si != null ? cell._si : 0;
          return `<c r="${addr}" s="${cell.s}" t="s"><v>${cell._si}</v></c>`;
        }).join('');
        return `<row r="${row.r+1}">${cellsXml}</row>`;
      }).join('');
      return { rowsXml, colsXml, mergesXml };
    }
  }

  // SharedStrings — все строковые значения
  const _sst = [];
  const _sstMap = new Map();
  function si(str) {
    const s = str == null ? '' : String(str);
    if (_sstMap.has(s)) return _sstMap.get(s);
    const idx = _sst.length;
    _sst.push(s);
    _sstMap.set(s, idx);
    return idx;
  }

  function colLetter(c) {
    let s = '';
    c++;
    while (c > 0) { s = String.fromCharCode(65 + (c - 1) % 26) + s; c = Math.floor((c - 1) / 26); }
    return s;
  }

  function makeCell(sb, r_unused, c, value, styleId, isNum) {
    const cell = isNum
      ? { c, v: parseNum(value) ?? 0, t: 'n', s: styleId }
      : { c, v: String(value ?? ''), t: 's', s: styleId, _si: si(String(value ?? '')) };
    return cell;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Лист 1: Сводная таблица
  // ═══════════════════════════════════════════════════════════════════════════
  const sb1 = new SheetBuilder();
  sb1.colWidths = [48, 6, 9, 15, 15, 13, 15];

  // Заголовок
  const titleRow = sb1.addRow([makeCell(sb1, 0, 0, 'Сводная таблица проверки документов — ' + reportDate, 0, false)]);
  sb1.merge(titleRow, 0, titleRow, 6);
  sb1.emptyRow();

  // Шапка
  const COLS = ['Наименование товара', 'Ед.', 'Кол-во', 'Цена', 'Без НДС', 'НДС', 'С НДС'];
  sb1.addRow(COLS.map((col, c) => makeCell(sb1, 0, c, col, 1, false)));

  const SECTION_STYLE = { payment: 2, primary: 3, aggregate: 4, extra: 5 };
  const SECTION_LABELS = { payment: 'Документ на оплату', primary: 'Первичный документ', aggregate: 'Итого по первичным', extra: 'Доп. документ' };
  const SECTION_ICONS  = { payment: '📄', primary: '📦', aggregate: '📊', extra: '📎' };

  (summaryData || []).forEach(section => {
    const secStyle = SECTION_STYLE[section.kind] || 3;
    const secLabel = (SECTION_ICONS[section.kind] || '') + ' ' + (SECTION_LABELS[section.kind] || section.label || '');
    const fullLabel = secLabel
      + (section.filename ? '  —  ' + section.filename : '')
      + (section.label && !section.label.startsWith(SECTION_LABELS[section.kind] || '~~~') ? '  (' + section.label + ')' : '');

    const secRow = sb1.addRow([makeCell(sb1, 0, 0, fullLabel, secStyle, false)]);
    sb1.merge(secRow, 0, secRow, 6);

    // Мета
    const metaParts = [];
    if (section.docDate) metaParts.push('Дата: ' + section.docDate);
    if (section.seller?.name) metaParts.push('Поставщик: ' + section.seller.name + (section.seller.inn ? ' (ИНН ' + section.seller.inn + ')' : ''));
    if (section.buyer?.name) metaParts.push('Получатель: ' + section.buyer.name);
    if (section.kind === 'extra') {
      if (section.issuer)         metaParts.push('Выдан: ' + section.issuer);
      if (section.validUntil)     metaParts.push('Действует до: ' + section.validUntil);
      if (section.warrantyMonths) metaParts.push('Гарантия: ' + section.warrantyMonths + ' мес.');
    }
    if (metaParts.length) {
      const mr = sb1.addRow([makeCell(sb1, 0, 0, metaParts.join('  |  '), 6, false)]);
      sb1.merge(mr, 0, mr, 6);
    }

    if (section.kind === 'extra') {
      if (section.claimAmount) {
        const cr = sb1.addRow([makeCell(sb1, 0, 0, 'Сумма претензии', 7, false), ...Array(5).fill(null).map((_, i) => makeCell(sb1, 0, i+1, '', 7, false)), makeCell(sb1, 0, 6, section.claimAmount, 9, true)]);
        sb1.merge(cr, 0, cr, 5);
      }
      if (section.notes) {
        const nr = sb1.addRow([makeCell(sb1, 0, 0, 'Примечания', 7, false), makeCell(sb1, 0, 1, section.notes, 7, false)]);
        sb1.merge(nr, 1, nr, 6);
      }
      // Разделитель
      const sr = sb1.addRow(COLS.map((_, c) => makeCell(sb1, 0, c, '', 16, false)));
      return;
    }

    // Позиции
    const items = section.items || [];
    if (items.length) {
      items.forEach(item => {
        sb1.addRow([
          makeCell(sb1, 0, 0, item.name || '', 7, false),
          makeCell(sb1, 0, 1, item.unit || '', 7, false),
          item.qty != null ? makeCell(sb1, 0, 2, item.qty, 9, true) : makeCell(sb1, 0, 2, '', 8, false),
          item.price      ? makeCell(sb1, 0, 3, item.price, 9, true) : makeCell(sb1, 0, 3, '', 8, false),
          item.amount     ? makeCell(sb1, 0, 4, item.amount, 9, true) : makeCell(sb1, 0, 4, '', 8, false),
          item.vat_amount ? makeCell(sb1, 0, 5, item.vat_amount, 9, true) : makeCell(sb1, 0, 5, '', 8, false),
          item.total      ? makeCell(sb1, 0, 6, item.total, 9, true) : makeCell(sb1, 0, 6, '', 8, false),
        ]);
      });
    } else {
      const er = sb1.addRow([makeCell(sb1, 0, 0, 'Позиции не извлечены', 6, false)]);
      sb1.merge(er, 0, er, 6);
    }

    // Итоги
    const t = section.totals || {};
    let matchOk = undefined;
    let matchLabel = 'Итого';
    if (section.kind === 'aggregate' && section.compareWith) {
      const payTotal  = round2(section.compareWith.amount_with_vat || 0);
      const primTotal = round2(t.amount_with_vat || 0);
      const diff = round2(Math.abs(payTotal - primTotal));
      matchOk = diff < 0.02;
      matchLabel = matchOk ? '✅ Совпадает с документом на оплату' : '🔴 Расхождение: ' + fmtNum(diff) + ' руб.';
    }
    const labelSid = matchOk === true ? 14 : matchOk === false ? 15 : 13;
    const numSid   = matchOk === true ? 11 : matchOk === false ? 12 : 10;
    const tr = sb1.addRow([
      makeCell(sb1, 0, 0, matchLabel, labelSid, false),
      makeCell(sb1, 0, 1, '', labelSid, false),
      makeCell(sb1, 0, 2, '', labelSid, false),
      makeCell(sb1, 0, 3, '', labelSid, false),
      t.amount_no_vat  ? makeCell(sb1, 0, 4, t.amount_no_vat, numSid, true)  : makeCell(sb1, 0, 4, '—', labelSid, false),
      t.vat_amount     ? makeCell(sb1, 0, 5, t.vat_amount, numSid, true)     : makeCell(sb1, 0, 5, '—', labelSid, false),
      t.amount_with_vat ? makeCell(sb1, 0, 6, t.amount_with_vat, numSid, true) : makeCell(sb1, 0, 6, '—', labelSid, false),
    ]);
    sb1.merge(tr, 0, tr, 3);

    // Разделитель
    sb1.addRow(COLS.map((_, c) => makeCell(sb1, 0, c, '', 16, false)));
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Лист 2: Нарушения
  // ═══════════════════════════════════════════════════════════════════════════
  const sb2 = new SheetBuilder();
  sb2.colWidths = [24, 16, 62, 52];

  const t2 = sb2.addRow([makeCell(sb2, 0, 0, 'Нарушения — ' + reportDate, 0, false)]);
  sb2.merge(t2, 0, t2, 3);
  sb2.emptyRow();
  sb2.addRow(['Категория','Уровень','Нарушение','Детали'].map((col, c) => makeCell(sb2, 0, c, col, 1, false)));

  const SEV_RU    = { critical: '🔴 Критично', significant: '🟠 Существенно', warning: '🟡 Замечание', info: '🔵 Информация' };
  const SEV_STYLE = { critical: 17, significant: 18, warning: 19, info: 20 };
  const SEV_BOLD  = { critical: 21 };

  if (!issues || !issues.length) {
    const nr = sb2.addRow([makeCell(sb2, 0, 0, '✅ Нарушений не выявлено', 4, false)]);
    sb2.merge(nr, 0, nr, 3);
  } else {
    issues.forEach(issue => {
      const sty = SEV_STYLE[issue.severity] || 7;
      const boldSty = SEV_BOLD[issue.severity] || sty;
      sb2.addRow([
        makeCell(sb2, 0, 0, issue.category || '', sty, false),
        makeCell(sb2, 0, 1, SEV_RU[issue.severity] || issue.severity, boldSty, false),
        makeCell(sb2, 0, 2, issue.message || '', boldSty, false),
        makeCell(sb2, 0, 3, issue.detail  || '', sty, false),
      ]);
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Лист 3: Документы
  // ═══════════════════════════════════════════════════════════════════════════
  const sb3 = new SheetBuilder();
  sb3.colWidths = [38, 20, 18, 14, 32, 16];

  const t3 = sb3.addRow([makeCell(sb3, 0, 0, 'Проверенные документы', 0, false)]);
  sb3.merge(t3, 0, t3, 5);
  sb3.emptyRow();
  sb3.addRow(['Файл','Тип','Номер','Дата','Поставщик','Сумма с НДС'].map((col, c) => makeCell(sb3, 0, c, col, 1, false)));

  (documents || []).forEach(d => {
    const data = d.data || {};
    const total = data.totals?.amount_with_vat;
    sb3.addRow([
      makeCell(sb3, 0, 0, d.filename || '', 22, false),
      makeCell(sb3, 0, 1, getTypeLabel(d.type) || '', 22, false),
      makeCell(sb3, 0, 2, data.doc_number || '', 22, false),
      makeCell(sb3, 0, 3, data.doc_date   || '', 22, false),
      makeCell(sb3, 0, 4, data.seller?.name || '', 22, false),
      total ? makeCell(sb3, 0, 5, total, 9, true) : makeCell(sb3, 0, 5, '', 22, false),
    ]);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Сборка XLSX через JSZip
  // ═══════════════════════════════════════════════════════════════════════════
  function sheetXml(sb) {
    const { rowsXml, colsXml, mergesXml } = sb.toXml();
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  ${colsXml}
  <sheetData>${rowsXml}</sheetData>
  ${mergesXml}
</worksheet>`;
  }

  const sstXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${_sst.length}" uniqueCount="${_sst.length}">
${_sst.map(s => `<si><t xml:space="preserve">${xmlEsc(s)}</t></si>`).join('')}
</sst>`;

  const wbXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"
  xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Сводная таблица" sheetId="1" r:id="rId1"/>
    <sheet name="Нарушения" sheetId="2" r:id="rId2"/>
    <sheet name="Документы" sheetId="3" r:id="rId3"/>
  </sheets>
</workbook>`;

  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet3.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;

  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet3.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`;

  // Собираем через JSZip (уже загружен)
  if (!window.JSZip) throw new Error('JSZip не загружен');
  const zip = new window.JSZip();
  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', rootRels);
  zip.file('xl/workbook.xml', wbXml);
  zip.file('xl/_rels/workbook.xml.rels', wbRels);
  zip.file('xl/styles.xml', STYLES_XML);
  zip.file('xl/sharedStrings.xml', sstXml);
  zip.file('xl/worksheets/sheet1.xml', sheetXml(sb1));
  zip.file('xl/worksheets/sheet2.xml', sheetXml(sb2));
  zip.file('xl/worksheets/sheet3.xml', sheetXml(sb3));

  return zip.generateAsync({ type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

function buildRtfReport(results) {
  const { issues, conclusion, documents } = results;
  const date = new Date().toLocaleString('ru-RU');
  const critCount = issues.filter(i => i.severity === 'critical').length;
  const sigCount  = issues.filter(i => i.severity === 'significant').length;
  function rtfStr(s) {
    return (s || '').replace(/\\/g, '\\\\').replace(/\{/g, '\\{').replace(/\}/g, '\\}')
      .replace(/[^\u0000-\u007F]/g, ch => {
        const code = ch.charCodeAt(0);
        return '\\u' + (code > 32767 ? code - 65536 : code) + '?';
      });
  }
  function h1(s)  { return '{\\pard\\sb240\\sa120\\b\\fs32 ' + rtfStr(s) + '\\b0\\par}\n'; }
  function h2(s)  { return '{\\pard\\sb200\\sa80\\b\\fs26 ' + rtfStr(s) + '\\b0\\par}\n'; }
  function para(s, opts) { return '{\\pard\\sa80' + (opts ? ' ' + opts : '') + ' ' + rtfStr(s) + '\\par}\n'; }
  let rtf = '{\\rtf1\\ansi\\ansicpg1251\\deff0\n{\\fonttbl{\\f0\\froman\\fcharset204 Times New Roman;}{\\f1\\fswiss\\fcharset204 Arial;}}\n{\\colortbl;\\red0\\green0\\blue0;\\red220\\green53\\blue53;\\red221\\green107\\blue32;\\red215\\green158\\blue46;\\red2\\green132\\blue199;\\red22\\green163\\blue74;}\n\\f1\\fs22\\lang1049\n';
  rtf += h1('Отчёт проверки пакета документов на оплату');
  rtf += para('Дата: ' + date + ' | Документов: ' + documents.length + ' | Критических: ' + critCount + ' | Существенных: ' + sigCount);
  rtf += h2('Проверенные документы');
  documents.forEach(d => { rtf += para(d.filename + ' — ' + getTypeLabel(d.type) + (d.data?.doc_name ? ' (' + d.data.doc_name + ')' : ''), '\\li360\\fi-360'); });
  rtf += h2('Нарушения');
  const SEV_RU = { critical: 'КРИТИЧНО', significant: 'СУЩЕСТВЕННО', warning: 'ЗАМЕЧАНИЕ', info: 'ИНФО' };
  const SEV_CF = { critical: '\\cf2', significant: '\\cf3', warning: '\\cf4', info: '\\cf5' };
  if (!issues.length) {
    rtf += para('Нарушений не выявлено');
  } else {
    issues.forEach(issue => {
      const cf = SEV_CF[issue.severity] || '';
      rtf += '{\\pard\\sa60 ' + cf + '{\\b [' + rtfStr(SEV_RU[issue.severity] || issue.severity) + ']} \\cf0' +
        (issue.category ? ' ' + rtfStr(issue.category) + ':' : '') + ' {\\b ' + rtfStr(issue.message) + '}\\par}\n';
      if (issue.detail) rtf += para(issue.detail, '\\li360\\fs18\\cf0');
    });
  }
  rtf += h2('Заключение AI');
  (conclusion || '').split(/\n\n+/).forEach(p => {
    if (!p.trim()) return;
    rtf += para(p.replace(/^#{1,4}\s+/, '').replace(/\*\*/g, '').replace(/\*/g, ''));
  });
  rtf += '}';
  return rtf;
}

async function loadXLSX() {
  if (window.XLSX) return window.XLSX;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js';
    s.onload = () => window.XLSX ? resolve(window.XLSX) : reject(new Error('XLSX не загружен'));
    s.onerror = () => reject(new Error('Не удалось загрузить XLSX'));
    document.head.appendChild(s);
  });
}

async function loadJSZip() {
  if (window.JSZip) return window.JSZip;
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js';
    s.onload = () => window.JSZip ? resolve(window.JSZip) : reject(new Error('JSZip не загружен'));
    s.onerror = () => reject(new Error('Не удалось загрузить JSZip'));
    document.head.appendChild(s);
  });
}

// ─── Система паттернов ────────────────────────────────────────────────────────

const PATTERNS_KEY = 'doc_checker_patterns_v1';
let _userPatterns = [];

export function loadUserPatterns() {
  try { const raw = sessionStorage.getItem(PATTERNS_KEY); _userPatterns = raw ? JSON.parse(raw) : []; } catch { _userPatterns = []; }
  updatePatternsBadge();
}
export function saveUserPatterns() {
  try { sessionStorage.setItem(PATTERNS_KEY, JSON.stringify(_userPatterns)); } catch { /* */ }
  updatePatternsBadge();
}
export function updatePatternsBadge() {
  const badge = $('patternsBadge');
  if (!badge) return;
  badge.textContent = _userPatterns.length > 0 ? String(_userPatterns.length) : '';
}
export function getUserPatternsPrompt() {
  if (!_userPatterns.length) return '';
  const lines = _userPatterns.map((p, i) =>
    'Паттерн ' + (i + 1) + ' (' + p.source + ', поле ' + p.field + '):\n  Неверно: ' + p.example_wrong + '\n  Верно:   ' + p.example_correct + '\n  Правило: ' + p.rule
  ).join('\n\n');
  return '\n\nПОЛЬЗОВАТЕЛЬСКИЕ ПАТТЕРНЫ ОШИБОК (выявлены на предыдущих анализах):\n' + lines + '\n\nОБЯЗАТЕЛЬНО учти эти паттерны при извлечении данных!';
}
export function openFeedback(issueMsg, allFilesNames) {
  $('fbDocFile').value  = allFilesNames || '';
  $('fbWrong').value    = '';
  $('fbCorrect').value  = '';
  $('fbContext').value  = issueMsg || '';
  $('fbField').value    = 'price';
  $('fbPatternPreview').classList.add('hidden');
  $('feedbackOverlay').classList.remove('hidden');
  setTimeout(() => $('fbWrong').focus(), 100);
}
export function closeFeedback() { $('feedbackOverlay').classList.add('hidden'); }
export function updatePatternPreview() {
  const wrong   = $('fbWrong').value.trim();
  const correct = $('fbCorrect').value.trim();
  if (!wrong || !correct) { $('fbPatternPreview').classList.add('hidden'); return; }
  const pattern = buildPatternFromForm();
  $('fbPatternJson').textContent = JSON.stringify(pattern, null, 2);
  $('fbPatternPreview').classList.remove('hidden');
}
export function buildPatternFromForm() {
  const wrong   = $('fbWrong').value.trim();
  const correct = $('fbCorrect').value.trim();
  const context = $('fbContext').value.trim();
  const field   = $('fbField').value;
  return {
    id: 'user_' + Date.now(), source: 'Пользователь — ' + new Date().toLocaleDateString('ru-RU'),
    doc_type: 'auto', field, example_wrong: wrong, example_correct: correct,
    rule: context || 'Поле "' + field + '": вместо "' + wrong + '" должно быть "' + correct + '"',
    added_by: 'user', added_at: new Date().toISOString().slice(0, 10),
  };
}
export function saveFeedbackPattern() {
  const wrong   = $('fbWrong').value.trim();
  const correct = $('fbCorrect').value.trim();
  if (!wrong || !correct) { showToast('Заполните поля «Что прочитано» и «Как должно быть»', 'warning'); return false; }
  _userPatterns.push(buildPatternFromForm());
  saveUserPatterns();
  closeFeedback();
  showToast('✅ Паттерн сохранён. Будет учтён при следующем анализе.', 'success', 5000);
  return true;
}
export function openPatternsModal() { renderPatternsList(); $('patternsOverlay').classList.remove('hidden'); }
export function renderPatternsList() {
  const wrap = $('patternsListWrap');
  if (!wrap) return;
  const systemPatterns = [
    { id: 'sys_1', source: 'УПД ФНС — цена (qty=1)', field: 'price', added_by: 'system', rule: 'PDF разбивает цену на части. «238 352,31 05269930» = 238352.3105269930. НЕ обрезать после 2 знаков.', example_wrong: '238352.31', example_correct: '238352.3105269930' },
    { id: 'sys_2', source: 'УПД ФНС — цена (qty=72)', field: 'price', added_by: 'system', rule: 'То же число, qty=72. Проверка: 72 × 238352.31052699367 = 17 161 366.36.', example_wrong: '238352.31', example_correct: '238352.31052699367' },
  ];
  const all = [...systemPatterns, ..._userPatterns];
  if (!all.length) { wrap.innerHTML = '<div class="patterns-empty">Паттернов пока нет</div>'; return; }
  wrap.innerHTML = all.map(p => {
    const isUser = p.added_by === 'user';
    const deleteBtn = isUser ? '<button class="pattern-item-delete" data-pattern-id="' + escHtml(p.id) + '" title="Удалить паттерн">✕</button>' : '';
    return '<div class="pattern-item ' + (isUser ? 'pattern-user' : 'pattern-system') + '">' +
      '<div class="pattern-item-header"><span class="pattern-item-source">' + escHtml(p.source) + ' — поле: ' + escHtml(p.field) + '</span>' +
      '<div style="display:flex;gap:0.4rem;align-items:center;"><span class="pattern-item-badge ' + (isUser ? 'pattern-badge-user' : 'pattern-badge-system') + '">' + (isUser ? '👤 Пользователь' : '⚙️ Системный') + '</span>' + deleteBtn + '</div></div>' +
      '<div class="pattern-item-rule">' + escHtml(p.rule) + '</div>' +
      (p.example_wrong && p.example_correct ? '<div class="pattern-item-example"><span class="pattern-ex-wrong">' + escHtml(p.example_wrong) + '</span><span class="pattern-ex-arrow">→</span><span class="pattern-ex-correct">' + escHtml(p.example_correct) + '</span></div>' : '') +
      '</div>';
  }).join('');
  wrap.addEventListener('click', e => {
    const btn = e.target.closest('.pattern-item-delete');
    if (!btn) return;
    _userPatterns = _userPatterns.filter(p => p.id !== btn.dataset.patternId);
    saveUserPatterns();
    renderPatternsList();
    showToast('Паттерн удалён', 'info');
  });
}
export function clearUserPatterns() {
  if (!_userPatterns.length) { showToast('Пользовательских паттернов нет', 'info'); return; }
  if (!confirm('Удалить все ' + _userPatterns.length + ' пользовательских паттернов?')) return;
  _userPatterns = [];
  saveUserPatterns();
  renderPatternsList();
  showToast('Пользовательские паттерны очищены', 'success');
}
