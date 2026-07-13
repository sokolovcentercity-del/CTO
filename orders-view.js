/**
 * Orders view — registry and card form.
 *
 * DELIVERY MODEL:
 *   - order.deliveryRows: one row per (product × address) for shipment allocation totals.
 *     Fields: contractItemName, contractItemCode, price, qty, date, address, recipientName, recipientId
 *   - order.deliverySchedules: shared delivery dates for the whole order.
 *   - order.scheduleItems: qty per product for each shared delivery date.
 *   - UI: address rows listed in a top table; product table shows total qty by address
 *     and separate qty inputs for each shared delivery date.
 */

import { $, el, clearChildren, confirmDeleteWithImpact } from './dom.js';
import { state } from '../state.js';
import {
  addOrder, updateOrder, deleteOrder,
  generateOrderNumber, getNextOrderSeq,
  calcOrderDelivered, calcOrderAssembled,
  hasProductColorVariants, getProductColorVariants, buildProductFullCode,
  getRecipientNeedMetrics,
  buildOrderPaymentPlan, getContractExecutionPolicy,
} from '../state.js';
import { saveToStorage } from '../storage.js';
import { showToast } from './toast.js';
import { renderProgramFinanceSummary, refreshContractItemsOrdered } from './contracts-view.js';
import { makeColumnsResizable } from './resizable-cols.js';
import { attachFrozenManager } from './frozen-table.js';
import { loadXLSX } from './lib-loader.js';
import { enhancePredictiveInput } from './filters.js';
import { autofillContractExecutionPolicyFromDocument } from './contract-policy-import.js';
import { formatProgramLabel, getProgramByIdentity } from './program-format.js';

const UI_TEXT_FALLBACKS = {
  'actions.edit': 'Редактировать',
  'actions.delete': 'Удалить',

  'orders.empty': 'Заявок пока нет',
  'orders.emptyHint': 'Нажмите «Новая заявка», чтобы создать',
  'orders.searchEmpty': 'Ничего не найдено',
  'orders.searchEmptyHint': 'Попробуйте другой запрос',
  'orders.openOrder': 'Открыть заявку',
  'orders.sendEmail': 'Отправить на email поставщика',
  'orders.sentBadge': '✉ Отправлена',
  'orders.sectionInfo': 'Основная информация',
  'orders.fieldContract': 'Контракт',
  'orders.selectContract': 'Выберите контракт…',
  'orders.fieldProgram': 'Целевая программа',
  'orders.fieldNumber': 'Номер заявки',
  'orders.numberAutoHint': 'Будет сформирован автоматически',
  'orders.fieldAdvanceAmount': 'Аванс по заявке',
  'orders.advanceIncluded': 'Расчёт: {percent}% от суммы заявки',
  'orders.advanceNotUsed': 'По контракту аванс не предусмотрен',
  'orders.fieldWarehouse': 'Склад доставки',
  'orders.selectWarehouse': '— Выберите склад (необязательно) —',
  'orders.optional': 'Необязательно',
  'orders.fieldDeliveryMode': 'Способ поставки',
  'orders.deliveryModeWarehouse': 'На склад',
  'orders.deliveryModeDirect': 'Прямая получателям',
  'orders.directHint': 'Сформируйте разнарядку в формате получатель → адрес → количество.',
  'orders.warehouseHint': 'Выберите склад и адрес поставки со склада.',
  'orders.warehouseAddressLabel': 'Адрес склада',
  'orders.selectWarehouseAddress': '— Выберите адрес склада —',
  'orders.noWarehouseAddress': 'У выбранного склада не указан адрес',
  'orders.chooseWarehouseFirst': 'Сначала выберите склад',
  'orders.chooseWarehouse': 'Выберите склад доставки',
  'orders.chooseDeliveryMode': 'Выберите способ поставки',
  'orders.chooseRecipient': '— Выберите получателя —',
  'orders.chooseRecipientAddress': '— Выберите адрес получателя —',
  'orders.noRecipientAddresses': 'У получателя нет адресов',
  'orders.recipientRequired': 'Выберите получателя для каждой строки разнарядки',
  'orders.recipientAddressRequired': 'Выберите адрес для каждого получателя',
  'orders.recipientProgramHint': 'Доступны только получатели программы «{program}»',
  'orders.noRecipientsForProgram': 'Нет получателей с целевой программой «{program}»',
  'orders.recipientProgramMismatch': 'Получатель «{recipient}» не относится к программе заявки «{program}»',
  'orders.importDispatchProgramMismatch': 'В Excel есть получатели с другой целевой программой: {names}',
  'orders.sentStatus': 'Статус отправки',
  'orders.sentLabel': 'Отправлена поставщику',
  'orders.sentDate': 'Дата отправки',
  'orders.saveFirst': 'Сначала сохраните заявку',
  'orders.programRequired': 'Выберите целевую программу из раздела «Финансы»',
  'orders.selectContractFirstOption': '— Сначала выберите контракт —',
  'orders.noProgramsInContract': '— Нет программ, привязанных к контракту —',
  'orders.sectionItems': 'Товары заявки',
  'orders.addressesTitle': 'Адреса поставки',
  'orders.addAddress': 'Добавить адрес',
  'orders.addressesHint': 'Добавьте адреса поставки — для каждого можно указать отдельное количество товара',
  'orders.recipientNamePlaceholder': 'Получатель (название организации)',
  'orders.recipientNameLabel': 'Название получателя',
  'orders.addressPlaceholder': 'Адрес поставки',
  'orders.addressLabel': 'Адрес поставки',
  'orders.removeAddress': 'Удалить адрес',
  'orders.addressesFirstHint': 'Добавьте адреса поставки выше — затем укажите количество для каждого адреса',
  'orders.selectContractFirst': 'Выберите контракт для отображения товаров',
  'orders.noApprovedItems': 'Нет товаров с согласованным сигнальным образцом',
  'orders.noApprovedItemsHint': 'В разделе «Контракты» установите статус «Согласован» в поле «Сигн. образец» для нужных товаров',
  'orders.colNumber': '№',
  'orders.colProduct': 'Товар',
  'orders.colCode': 'Код',
  'orders.colPrice': 'Цена, ₽',
  'orders.colTotalQty': 'Итого шт.',
  'orders.colCost': 'Стоимость',
  'orders.colDelivered': 'Поставлено',
  'orders.colAssembled': 'Собрано',
  'orders.colDelivery': 'Срок поставки',
  'orders.qtyForAddress': 'Кол-во для',
  'orders.addressGeneric': 'адреса',
  'orders.totalLabel': 'Итого',
  'orders.contractRequired': 'Выберите контракт',
  'orders.excelLibMissing': 'Библиотека Excel не загружена',
  'orders.exportedFile': 'Файл скачан: {name}',
  'orders.importDispatch': 'Импорт разнарядки',
  'orders.downloadDispatchTemplate': 'Шаблон Excel',
  'orders.importDispatchNoContract': 'Сначала выберите контракт',
  'orders.importDispatchReplaceConfirm': 'Текущая разнарядка будет заменена данными из Excel. Продолжить?',
  'orders.importDispatchReadError': 'Не удалось прочитать Excel-файл',
  'orders.importDispatchUnsupported': 'Формат Excel не распознан. Используйте экспорт заявки или таблицу со столбцами Получатель / Адрес / Товар / Количество.',
  'orders.importDispatchMissingColumns': 'В шаблоне не хватает обязательных столбцов: {columns}',
  'orders.importDispatchEmpty': 'В файле нет данных для импорта',
  'orders.importDispatchNoMatches': 'Ни одна строка не сопоставлена с товарами контракта',
  'orders.importDispatchImported': 'Разнарядка импортирована: адресов {addresses}, товаров {items}',
  'orders.importDispatchPartial': 'Импорт выполнен частично: не сопоставлено строк — {count}',
  'orders.dispatchTemplateDownloaded': 'Шаблон Excel скачан',
  'orders.deliverySchedulesTitle': 'Сроки поставки',
  'orders.removeDelivery': 'Удалить срок',
  'orders.scheduleQtyLabel': 'Кол-во на срок',
  'orders.scheduleQtyMismatch': 'По срокам: {scheduled} из {total} шт.',
  'orders.scheduleDateRequired': 'Укажите дату для каждого срока, где заполнено количество',
  'orders.scheduleItemMismatch': 'По товару «{name}» сумма по срокам ({scheduled} шт.) не совпадает с общим количеством ({total} шт.)',
  'orders.scheduleAddressMismatch': 'По товару «{name}» сумма по адресам ({distributed} шт.) не совпадает с количеством по срокам ({total} шт.)',
  'orders.addressDistributionHint': 'По адресам распределено: {distributed} из {total} шт.',
  'orders.scheduleSummaryTitle': 'Сроки поставки',
};

function fillTemplate(template, vals) {
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(vals?.[name] ?? `{${name}}`));
}

const t = (key, vals) => {
  const localized = window.miniappI18n?.t(key, vals);
  if (localized && localized !== key) return localized;
  if (UI_TEXT_FALLBACKS[key]) return fillTemplate(UI_TEXT_FALLBACKS[key], vals);
  return key;
};

const ORDER_TEXT_FALLBACKS = {
  overageTitle: 'Превышение лимитов контракта',
  overageItem: 'заявлено {current}, доступно {remaining} (превышение: {over})',
  overageTotal: 'Сумма заказов {ordered} ₽ превышает цену контракта {limit} ₽ (превышение: {over} ₽)',
  overageProgram: 'Программа {name}: заказы {ordered} ₽ превышают бюджет {limit} ₽ (превышение: {over} ₽)',
  overageConfirm: '⚠️ Обнаружено превышение лимитов контракта или целевой программы.\n\nСохранить заявку несмотря на превышение?',
  availableQtyHint: 'Доступно {available} шт.',
  availableQtyExceededHint: 'Доступно {available} шт. · превышение на {over} шт.',
  contractRemainingHint: 'Остаток по контракту: {remaining} ₽ из {limit} ₽',
  contractExceededHint: 'Контракт: заявлено {total} ₽ из {limit} ₽ · превышение {over} ₽',
  programRemainingHint: 'Остаток по программе «{name}»: {remaining} ₽ из {limit} ₽',
  programExceededHint: 'Программа «{name}»: заявлено {total} ₽ из {limit} ₽ · превышение {over} ₽',
  colorProgramNeedHint: 'Потребность по программе: {need} шт.',
  colorProgramNeedExceededHint: 'Потребность по программе: {need} шт. · превышение на {over} шт.',
  directRecipientNeedHint: 'Потр.: {need} шт. · др. заявки: {ordered} шт. · остаток: {remaining} шт.',
  directRecipientNeedExceededHint: 'Потр.: {need} шт. · др. заявки: {ordered} шт. · превышение: {over} шт.',
  directRecipientNeedEmpty: 'Потребность не указана · др. заявки: {ordered} шт.',
  directRecipientFillButton: 'Заполнить остаток ({remaining})',
  directRecipientFillDone: 'Остаток закрыт',
  directRecipientFillUnavailable: 'Нет остатка',
  directMatrixAutofillButton: 'Заполнить матрицу по остаткам',
  directMatrixAutofillHint: 'Автоматически добавит получателей и подставит остаток потребности по каждому товару в первый срок поставки.',
  directMatrixAutofillConfirm: 'Текущая матрица заявки будет перезаполнена остатками потребности. Продолжить?',
  directMatrixAutofillDone: 'Матрица заполнена: получателей {recipients}, строк {rows}, всего {qty} шт.',
  directMatrixAutofillNoData: 'Не найдено остатков потребности для автозаполнения.',
  directMatrixAutofillNoRecipients: 'Для автозаполнения не найдены получатели с адресами и остатками потребности.',
  paymentLedgerTitle: 'Бухгалтерская сводка по оплате',
  paymentLedgerHint: 'Показывает начисление по этапам, зачёт аванса и сумму к оплате.',
  paymentLedgerColStage: 'Этап',
  paymentLedgerColPercent: '%',
  paymentLedgerColAccrued: 'Начислено',
  paymentLedgerColAdvanceOffset: 'Зачтено авансом',
  paymentLedgerColPayable: 'К оплате',
  paymentLedgerColAdvanceRemainder: 'Остаток аванса',
  paymentLedgerTotal: 'Итого',
};

function tOrder(key, vals) {
  const fullKey = `orders.${key}`;
  const localized = window.miniappI18n?.t(fullKey, vals);
  if (localized && localized !== fullKey) return localized;

  const template = ORDER_TEXT_FALLBACKS[key] || fullKey;
  return fillTemplate(template, vals);
}

const fmt = new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtMoney = v => fmt.format(Number(v) || 0);
const fmtDate = d => {
  if (!d) return '—';
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}`;
};

function getExecutionReadinessLabel(value) {
  switch (value) {
    case 'ready': return 'Место эксплуатации готово';
    case 'not_ready': return 'Место эксплуатации не готово';
    default: return 'Готовность не используется';
  }
}

function roundMoney(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

function getOrderAdvanceSnapshot(contract, executionPlan = null) {
  const percent = Math.max(
    0,
    Number(
      executionPlan?.policy?.advancePercent
      ?? contract?.executionPolicy?.advancePercent
      ?? contract?.advancePct
      ?? 0,
    ) || 0,
  );
  const total = roundMoney(executionPlan?.total ?? buildOrderAmountTotal());
  const amount = roundMoney(executionPlan?.advanceAmount ?? (total * percent / 100));
  return {
    percent,
    total,
    amount,
  };
}

function buildOrderAmountTotal() {
  return itemRows.reduce((sum, item) => sum + getItemEffectiveQty(item, deliveryModeState) * (Number(item.price) || 0), 0);
}

function buildExecutionPlan(contract) {
  const total = buildOrderAmountTotal();
  return buildOrderPaymentPlan(contract, {
    deliveryMode: deliveryModeState,
    readinessState: executionReadinessState,
    totalAmount: total,
  }, executionManualAdvanceState);
}

function buildExecutionScenarioDescription(plan) {
  const { scenario } = plan;
  const routeText = deliveryModeState === 'warehouse' ? 'заявка идёт на склад' : 'заявка идёт сразу получателю';
  if (scenario.scenarioType === 'split') {
    return `${routeText}; расчёт в 2 этапа: ${scenario.stage1Percent}% + ${scenario.stage2Percent}%`;
  }
  return `${routeText}; полный расчёт одной оплатой`;
}

function buildExecutionReminderList(plan) {
  const reminders = [];
  if (plan.policy.usesReadiness && executionReadinessState === 'not_applicable') {
    reminders.push('Укажите, готово ли место эксплуатации: от этого зависит рекомендуемый маршрут и набор актов.');
  }
  if (plan.scenario.recommendedRoute !== 'manual' && !plan.scenario.routeMatchesRecommendation) {
    reminders.push(`По настройке контракта ожидается маршрут «${EXECUTION_ROUTE_LABELS[plan.scenario.recommendedRoute] || plan.scenario.recommendedRoute}», а сейчас выбран «${EXECUTION_ROUTE_LABELS[plan.scenario.route] || plan.scenario.route}».`);
  }
  if (plan.scenario.needsNotReadyAct && !executionActsState.notReady) {
    reminders.push('Не сформирован акт неготовности места эксплуатации.');
  }
  if (plan.scenario.needsReadyAct && !executionActsState.ready) {
    reminders.push('Не сформирован акт готовности места эксплуатации для финального этапа.');
  }
  if (plan.advanceOffsetMode === 'manual' && plan.advanceAmount > 0 && plan.unallocatedAdvance > 0.01) {
    reminders.push(`Ручной зачёт аванса распределён не полностью: осталось ${fmtMoney(plan.unallocatedAdvance)} ₽.`);
  }
  return reminders;
}

function buildExecutionAccountingRows(plan) {
  const rows = [];
  let remainingAdvance = roundMoney(plan.advanceAmount);

  const pushRow = ({ label, percent, accrued, advanceOffset, payable }) => {
    remainingAdvance = Math.max(0, roundMoney(remainingAdvance - advanceOffset));
    rows.push({
      label,
      percent,
      accrued: roundMoney(accrued),
      advanceOffset: roundMoney(advanceOffset),
      payable: roundMoney(payable),
      advanceRemainder: roundMoney(remainingAdvance),
    });
  };

  pushRow({
    label: plan.scenario.scenarioType === 'split' ? 'Этап 1' : 'Оплата по заявке',
    percent: plan.scenario.scenarioType === 'split' ? (Number(plan.stage1Percent) || 0) : 100,
    accrued: plan.stage1Amount,
    advanceOffset: plan.stage1Offset,
    payable: plan.stage1Payable,
  });

  if (plan.scenario.scenarioType === 'split') {
    pushRow({
      label: 'Этап 2',
      percent: Number(plan.stage2Percent) || 0,
      accrued: plan.stage2Amount,
      advanceOffset: plan.stage2Offset,
      payable: plan.stage2Payable,
    });
  }

  return rows;
}

function getExecutionActSupplier(contract) {
  return contract?.supplierId
    ? (state.suppliers || []).find(s => s.id === contract.supplierId) || null
    : null;
}

function getExecutionActContractFiles(contract) {
  if (!contract) return [];
  const direct = Array.isArray(contract.bundleDocuments)
    ? contract.bundleDocuments
        .filter(file => file?.dataUrl)
        .map(file => ({
          id: file.id,
          sourceType: file.sourceType || 'bundle',
          originalName: file.originalName || 'contract-document',
          mimeType: file.mimeType || 'application/octet-stream',
          sizeBytes: Number(file.sizeBytes) || 0,
          uploadedAt: file.uploadedAt || '',
          dataUrl: file.dataUrl,
        }))
    : [];
  if (direct.length) return direct;

  return [contract.bundleDocument, contract.contractDocument, contract.tzDocument]
    .filter(file => file?.dataUrl)
    .map((file, index) => ({
      id: file.id || `contract_doc_${index + 1}`,
      sourceType: file.sourceType || (index === 0 ? 'bundle' : index === 1 ? 'contract' : 'tz'),
      originalName: file.originalName || 'contract-document',
      mimeType: file.mimeType || 'application/octet-stream',
      sizeBytes: Number(file.sizeBytes) || 0,
      uploadedAt: file.uploadedAt || '',
      dataUrl: file.dataUrl,
    }));
}

function getExecutionActPartyMeta(contract) {
  return {
    customerName: String(
      contract?.customerName
      || 'Государственное автономное учреждение города Москвы «Центр технического оснащения и модернизации образования»'
    ).trim(),
    customerSignerRole: String(contract?.customerSignerRole || 'директора').trim(),
    customerSignerName: String(contract?.customerSignerName || '________________________').trim(),
    customerSignerBasis: String(contract?.customerSignerBasis || 'Устава').trim(),
    supplierName: '________________________',
    supplierSignerRole: '',
    supplierSignerName: '',
    supplierSignerBasis: '',
  };
}

async function ensureExecutionActPartyMeta(contract) {
  return getExecutionActPartyMeta(contract);
}

function getExecutionActPlannedDate() {
  const dates = (deliverySchedules || [])
    .map(schedule => String(schedule?.date || '').trim())
    .filter(Boolean)
    .sort();
  return dates[0] || '';
}

function getExecutionActAddressesHtml() {
  const unique = [];
  const seen = new Set();

  (addressRows || []).forEach((row, idx) => {
    const recipient = String(row?.recipientName || '').trim();
    const address = String(row?.address || '').trim();
    const text = recipient && address
      ? `${recipient}, ${address}`
      : (recipient || address || `Адрес ${idx + 1}`);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) return;
    seen.add(key);
    unique.push(text);
  });

  if (!unique.length) return '________________________';
  if (unique.length === 1) return unique[0];
  return unique.map((text, idx) => `${idx + 1}. ${text}`).join('\n');
}

function getExecutionActItems() {
  const groups = new Map();

  (itemRows || []).forEach((item) => {
    const qty = Math.max(0, Number(getItemEffectiveQty(item, deliveryModeState)) || 0);
    const key = [
      String(item?.contractItemName || '').trim().toLowerCase(),
      String(item?.baseCode || item?.contractItemCode || '').trim().toLowerCase(),
      String(item?.contractItemCode || '').trim().toLowerCase(),
    ].join('::');

    if (!groups.has(key)) {
      groups.set(key, {
        name: String(item?.contractItemName || item?.displayName || 'Мебель').trim() || 'Мебель',
        code: String(item?.baseCode || item?.contractItemCode || '').trim(),
        qty: 0,
      });
    }
    groups.get(key).qty += qty;
  });

  return [...groups.values()].filter(item => item.qty > 0);
}

function rtfEscape(value) {
  const source = String(value ?? '');
  let out = '';
  for (let i = 0; i < source.length; i += 1) {
    const code = source.charCodeAt(i);
    const ch = source[i];
    if (ch === '\\') out += '\\\\';
    else if (ch === '{') out += '\\{';
    else if (ch === '}') out += '\\}';
    else if (ch === '\n') out += '\\line ';
    else if (code > 127) out += `\\u${code > 32767 ? code - 65536 : code}?`;
    else out += ch;
  }
  return out;
}

function buildRtfParagraph(text, { align = 'left', bold = false, size = 24, spaceAfter = 120 } = {}) {
  const alignCode = align === 'center' ? '\\qc' : align === 'right' ? '\\qr' : '\\ql';
  const boldOpen = bold ? '\\b ' : '';
  const boldClose = bold ? '\\b0' : '';
  return `${alignCode}\\sa${spaceAfter}\\fs${size} ${boldOpen}${rtfEscape(text)}${boldClose}\\par\n`;
}

function buildRtfTableRow(cells, widths, options = {}) {
  const rowHeight = Number(options.rowHeight) || 360;
  let current = 0;
  const header = widths.reduce((acc, width) => {
    current += width;
    return acc + `\\clbrdrt\\brdrs\\brdrw15\\clbrdrl\\brdrs\\brdrw15\\clbrdrb\\brdrs\\brdrw15\\clbrdrr\\brdrs\\brdrw15\\cellx${current}`;
  }, `\\trowd\\trgaph108\\trleft0\\trrh${rowHeight}`);
  const body = cells.map((cell = {}) => {
    const alignCode = cell.align === 'center' ? '\\qc' : cell.align === 'right' ? '\\qr' : '\\ql';
    const boldOpen = cell.bold ? '\\b ' : '';
    const boldClose = cell.bold ? '\\b0' : '';
    const size = cell.size || 22;
    return `${alignCode}\\intbl\\sa60\\sl240\\slmult1\\fs${size} ${boldOpen}${rtfEscape(cell.text || '')}${boldClose}\\cell`;
  }).join('');
  return `${header}${body}\\row\n`;
}

function buildExecutionActRtf(type, contract, orderNumber, programName, parties) {
  const isNotReady = type === 'notReady';
  const todayIso = new Date().toISOString().slice(0, 10);
  const items = getExecutionActItems();
  const plannedDate = getExecutionActPlannedDate();
  const contractNumber = String(contract?.number || '').trim() || '________________';
  const contractDate = String(contract?.date || '').trim() || '________________';
  const orderLabel = String(orderNumber || '').trim() || '________________';
  const readinessWord = isNotReady ? 'не готово' : 'готово';
  const startDateText = plannedDate ? fmtDate(plannedDate) : '________________';
  const addressText = getExecutionActAddressesHtml().replace(/<br>/g, '; ').replace(/<[^>]+>/g, '');
  const customerPerson = [parties.customerSignerRole, parties.customerSignerName].filter(Boolean).join(' ');
  const intro = `Мы, нижеподписавшиеся, Подрядчик ________________________ в лице ________________________, действующего на основании ________________________, и Заказчик ${parties.customerName || '________________________'} в лице ${customerPerson || '________________________'}, действующего на основании ${parties.customerSignerBasis || '________________________'}, составили настоящий Акт о том, что место эксплуатации мебели по адресу: ${addressText || '________________________'} ${readinessWord} для оказания сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию следующей мебели:`;
  const itemsRows = (items.length ? items : [{ name: '________________________', code: '', qty: 0 }])
    .map((item, index) => buildRtfTableRow([
      { text: String(index + 1), align: 'center' },
      { text: `${item.name || '________________________'}${item.code ? ` (${item.code})` : ''}${item.qty > 0 ? ` — ${item.qty} шт.` : ''}` },
    ], [900, 9300]))
    .join('');

  const extraParagraphs = isNotReady
    ? [
        buildRtfParagraph('Конкретные причины неготовности места эксплуатации мебели: ________________________', { size: 24 }),
        buildRtfParagraph(`Заказчик и Подрядчик пришли к соглашению о переносе срока начала оказания сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию мебели, изготовленной по Договору № ${contractNumber} от ${contractDate}.`, { size: 24 }),
        buildRtfParagraph(`Плановая дата начала оказания сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию мебели: ${startDateText}`, { size: 24 }),
        buildRtfParagraph('Подрядчик может приступить к оказанию сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию изготовленной мебели после приемки готовности места эксплуатации мебели и подписания соответствующего акта.', { size: 24 }),
      ].join('')
    : [
        buildRtfParagraph(`Плановая дата начала оказания сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию мебели: ${startDateText}`, { size: 24 }),
        buildRtfParagraph(`Подрядчик может приступить к оказанию сопутствующих услуг по сборке, расстановке и вводу в эксплуатацию мебели по Договору № ${contractNumber} от ${contractDate}.`, { size: 24 }),
      ].join('');

  const signatureRows = buildRtfTableRow([
    { text: 'Заказчик', bold: true, align: 'center' },
    { text: 'Подрядчик', bold: true, align: 'center' },
  ], [5100, 5100], { rowHeight: 720 })
    + buildRtfTableRow([
      { text: '________________________', align: 'center' },
      { text: '________________________', align: 'center' },
    ], [5100, 5100], { rowHeight: 720 })
    + buildRtfTableRow([
      { text: parties.customerSignerName || '________________________', align: 'center' },
      { text: '________________________', align: 'center' },
    ], [5100, 5100], { rowHeight: 720 });

  return `{\\rtf1\\ansi\\ansicpg1251\\deff0
{\\fonttbl{\\f0 Times New Roman;}}
\\viewkind4\\uc1\\pard
${buildRtfParagraph('АКТ', { align: 'center', bold: true, size: 28, spaceAfter: 40 })}
${buildRtfParagraph(isNotReady ? 'о неготовности места эксплуатации мебели' : 'о готовности места эксплуатации мебели', { align: 'center', bold: true, size: 24, spaceAfter: 120 })}
${buildRtfParagraph(`по Договору от ${contractDate} № ${contractNumber}`, { align: 'center', size: 24, spaceAfter: 120 })}
${buildRtfParagraph('г. Москва', { size: 24, spaceAfter: 40 })}
${buildRtfParagraph(`«${fmtDate(todayIso)}»`, { align: 'right', size: 24, spaceAfter: 160 })}
${buildRtfParagraph(intro, { size: 24, spaceAfter: 120 })}
${buildRtfParagraph(`Заявка на изготовление мебели: № ${orderLabel}${programName ? ` · ${programName}` : ''}`, { size: 22, spaceAfter: 120 })}
${buildRtfTableRow([
  { text: '№ п/п', align: 'center', bold: true },
  { text: 'Наименование мебели', align: 'center', bold: true },
], [900, 9300])}
${itemsRows}
${extraParagraphs}
${buildRtfParagraph('', { size: 24, spaceAfter: 120 })}
${signatureRows}
}`;
}

async function downloadExecutionAct(type, contract, orderNumber, programName) {
  const parties = await ensureExecutionActPartyMeta(contract);
  const rtf = buildExecutionActRtf(type, contract, orderNumber, programName, parties);
  const fileName = `${type === 'notReady' ? 'akt-negotovnosti' : 'akt-gotovnosti'}-${String(orderNumber || contract?.number || 'order').replace(/[^0-9A-Za-zА-Яа-я_-]+/g, '-')}.rtf`;
  const blob = new Blob([rtf], { type: 'application/rtf;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

function getOrderProgramValue(order) {
  return order?.programCode || order?.programName || '';
}

// ─── State ──────────────────────────────────────────────────────
let editingOrderId = null;
let registrySearchQuery = '';
let deliveryModeState = 'direct';
let directAddressRowsDraft = [];
let validationRefreshFrame = 0;
let executionReadinessState = 'not_applicable';
let executionActsState = { notReady: null, ready: null };
let executionManualAdvanceState = { stage1: 0, stage2: 0 };

const EXECUTION_ROUTE_LABELS = {
  direct: 'сразу получателю',
  warehouse: 'на склад',
  manual: 'определяет пользователь',
};

const EXECUTION_SCENARIO_LABELS = {
  full: 'полный расчёт',
  split: 'этапная схема',
};

const ADVANCE_OFFSET_MODE_LABELS = {
  sequential: 'приоритетный зачёт',
  proportional: 'пропорциональный зачёт',
  manual: 'ручной зачёт',
};

function requestValidationRefresh() {
  if (validationRefreshFrame) return;
  validationRefreshFrame = requestAnimationFrame(() => {
    validationRefreshFrame = 0;
    validateCurrentOrder();
  });
}

/**
 * addressRows: list of delivery addresses.
 * Each: { id, address, recipientName, recipientId }
 */
let addressRows = [];
let nextAddrId = 1;
function makeAddrId() { return nextAddrId++; }

let deliverySchedules = [];
let nextScheduleId = 1;
function makeScheduleId() { return nextScheduleId++; }

/**
 * itemRows: one entry per contract item.
 * Each: { id, contractItemName, contractItemCode, price, qtys: Map<addrId, qty>, date }
 */
let itemRows = [];
let nextItemId = 1;
function makeItemId() { return nextItemId++; }

function cloneDeliverySchedules(rows) {
  return (rows || []).map(row => ({
    id: row?.id ?? makeScheduleId(),
    date: parseHumanDateToIso(row?.date || ''),
  }));
}

function ensureItemRuntimeFields(item) {
  if (!(item?.qtys instanceof Map)) {
    item.qtys = new Map(item?.qtys ? Array.from(item.qtys.entries()) : []);
  }
  if (!(item?.scheduleQtys instanceof Map)) {
    item.scheduleQtys = new Map(item?.scheduleQtys ? Array.from(item.scheduleQtys.entries()) : []);
  }
  if (!(item?.scheduleAddrQtys instanceof Map)) {
    item.scheduleAddrQtys = new Map(item?.scheduleAddrQtys ? Array.from(item.scheduleAddrQtys.entries()) : []);
  }
  return item;
}

function getScheduleAddrKey(scheduleId, addrId) {
  return `${scheduleId}::${addrId}`;
}

function getItemScheduleAddrQty(item, scheduleId, addrId) {
  ensureItemRuntimeFields(item);
  return Number(item.scheduleAddrQtys.get(getScheduleAddrKey(scheduleId, addrId))) || 0;
}

function setItemScheduleAddrQty(item, scheduleId, addrId, qty) {
  ensureItemRuntimeFields(item);
  item.scheduleAddrQtys.set(getScheduleAddrKey(scheduleId, addrId), Math.max(0, parseInt(qty, 10) || 0));
}

function ensureDirectMatrixForItem(item) {
  ensureItemRuntimeFields(item);
  ensureDeliverySchedules();

  const hasMatrixData = Array.from(item.scheduleAddrQtys.values()).some(value => (Number(value) || 0) > 0);
  if (hasMatrixData) return;

  const firstSchedule = deliverySchedules[0];
  if (!firstSchedule) return;

  addressRows.forEach(addr => {
    const qty = Number(item.qtys.get(addr.id)) || 0;
    if (qty > 0) {
      item.scheduleAddrQtys.set(getScheduleAddrKey(firstSchedule.id, addr.id), qty);
    }
  });
}

function syncDirectTotalsForItem(item) {
  ensureItemRuntimeFields(item);
  ensureDirectMatrixForItem(item);
  ensureDeliverySchedules();

  const allowedKeys = new Set();
  deliverySchedules.forEach(schedule => {
    addressRows.forEach(addr => {
      const key = getScheduleAddrKey(schedule.id, addr.id);
      allowedKeys.add(key);
      if (!item.scheduleAddrQtys.has(key)) item.scheduleAddrQtys.set(key, 0);
    });
  });
  Array.from(item.scheduleAddrQtys.keys()).forEach(key => {
    if (!allowedKeys.has(key)) item.scheduleAddrQtys.delete(key);
  });

  item.qtys = new Map();
  addressRows.forEach(addr => {
    const total = deliverySchedules.reduce((sum, schedule) => sum + getItemScheduleAddrQty(item, schedule.id, addr.id), 0);
    item.qtys.set(addr.id, total);
  });

  item.scheduleQtys = new Map();
  deliverySchedules.forEach(schedule => {
    const total = addressRows.reduce((sum, addr) => sum + getItemScheduleAddrQty(item, schedule.id, addr.id), 0);
    item.scheduleQtys.set(schedule.id, total);
  });
}

function syncDirectTotalsFromMatrix() {
  if (deliveryModeState !== 'direct') return;
  itemRows.forEach(syncDirectTotalsForItem);
}

function ensureDeliverySchedules() {
  if (!Array.isArray(deliverySchedules)) deliverySchedules = [];
  if (deliverySchedules.length === 0) {
    deliverySchedules = [{ id: makeScheduleId(), date: '' }];
  }
}

function getItemTotalQty(item) {
  ensureItemRuntimeFields(item);
  return addressRows.reduce((sum, addr) => sum + (Number(item.qtys.get(addr.id)) || 0), 0);
}

function getItemDistributedQty(item) {
  return getItemTotalQty(item);
}

function getItemScheduledQty(item) {
  ensureItemRuntimeFields(item);
  ensureDeliverySchedules();
  return deliverySchedules.reduce((sum, schedule) => sum + (Number(item.scheduleQtys.get(schedule.id)) || 0), 0);
}

function getItemEffectiveQty(item, mode = deliveryModeState) {
  return mode === 'direct'
    ? getItemDistributedQty(item)
    : getItemScheduledQty(item);
}

function syncDirectScheduleQtyForItem(item) {
  if (deliveryModeState !== 'direct' || !item) return;
  syncDirectTotalsForItem(item);
}

function syncDirectScheduleQtysFromRecipients() {
  if (deliveryModeState !== 'direct') return;
  ensureDeliveryScheduleState();
  syncDirectTotalsFromMatrix();
}

function syncScheduleQtyMaps() {
  ensureDeliverySchedules();
  const allowedIds = new Set(deliverySchedules.map(schedule => schedule.id));
  itemRows.forEach(item => {
    ensureItemRuntimeFields(item);
    Array.from(item.scheduleQtys.keys()).forEach(key => {
      if (!allowedIds.has(key)) item.scheduleQtys.delete(key);
    });
    deliverySchedules.forEach(schedule => {
      if (!item.scheduleQtys.has(schedule.id)) item.scheduleQtys.set(schedule.id, 0);
    });
    const allowedAddrKeys = new Set();
    deliverySchedules.forEach(schedule => {
      addressRows.forEach(addr => {
        const key = getScheduleAddrKey(schedule.id, addr.id);
        allowedAddrKeys.add(key);
        if (!item.scheduleAddrQtys.has(key)) item.scheduleAddrQtys.set(key, 0);
      });
    });
    Array.from(item.scheduleAddrQtys.keys()).forEach(key => {
      if (!allowedAddrKeys.has(key)) item.scheduleAddrQtys.delete(key);
    });
  });
}

function ensureDeliveryScheduleState() {
  ensureDeliverySchedules();
  syncScheduleQtyMaps();
}

function buildScheduleBreakdownForSave() {
  ensureDeliveryScheduleState();
  return itemRows.map(item => {
    ensureItemRuntimeFields(item);
    if (deliveryModeState === 'direct') syncDirectTotalsForItem(item);
    return {
      contractItemName: item.contractItemName,
      displayName: item.displayName || item.contractItemName,
      contractItemCode: item.contractItemCode,
      baseCode: item.baseCode || item.contractItemCode,
      colorCode: item.colorCode || '',
      variantId: item.variantId || '',
      productId: item.productId ?? null,
      isColorVariant: Boolean(item.isColorVariant || item.variantId || item.colorCode),
      price: Number(item.price) || 0,
      quantities: deliverySchedules.map(schedule => ({
        scheduleId: schedule.id,
        date: schedule.date || '',
        qty: Math.max(0, parseInt(item.scheduleQtys.get(schedule.id), 10) || 0),
        addressQuantities: addressRows.map(addr => ({
          addressId: addr.id,
          recipientId: addr.recipientId ?? null,
          recipientName: addr.recipientName || '',
          address: addr.address || '',
          qty: getItemScheduleAddrQty(item, schedule.id, addr.id),
        })),
      })),
    };
  });
}

function getSingleScheduleDateForRows() {
  const meaningful = deliverySchedules.filter(schedule => String(schedule.date || '').trim());
  return meaningful.length === 1 ? meaningful[0].date : '';
}

function getScheduleSummaryText(item) {
  ensureItemRuntimeFields(item);
  ensureDeliverySchedules();
  const parts = deliverySchedules
    .map((schedule, index) => {
      const qty = Math.max(0, parseInt(item.scheduleQtys.get(schedule.id), 10) || 0);
      if (qty <= 0) return '';
      const label = schedule.date ? fmtDate(schedule.date) : `${t('orders.deliveryDate')} ${index + 1}`;
      return `${label} — ${qty} шт.`;
    })
    .filter(Boolean);
  return parts.join('; ');
}

function buildDeliveryScheduleValidation() {
  ensureDeliveryScheduleState();

  const missingDates = [];
  deliverySchedules.forEach((schedule, index) => {
    const hasQty = itemRows.some(item => (Number(item.scheduleQtys.get(schedule.id)) || 0) > 0);
    if (hasQty && !String(schedule.date || '').trim()) {
      missingDates.push({ index: index + 1 });
    }
  });

  const itemMismatches = [];
  itemRows.forEach(item => {
    const total = getItemScheduledQty(item);
    const distributed = getItemDistributedQty(item);
    if (distributed !== total) {
      itemMismatches.push({
        name: item.contractItemName || '—',
        total,
        distributed,
      });
    }
  });

  return {
    missingDates,
    itemMismatches,
    hasIssues: missingDates.length > 0 || itemMismatches.length > 0,
  };
}

function cloneAddressRows(rows) {
  return (rows || []).map(row => ({ ...row }));
}

function inferDeliveryMode(order) {
  if (order?.deliveryMode === 'warehouse') return 'warehouse';
  if (order?.deliveryMode === 'direct') return 'direct';
  if (order?.warehouseId) return 'warehouse';
  return 'direct';
}

function parseAddressOptions(rawValue) {
  const raw = String(rawValue || '').trim();
  if (!raw) return [];
  const parts = raw
    .split(/\r?\n|\s*\|\s*|\s*;;\s*/)
    .map(part => part.trim())
    .filter(Boolean);
  const uniq = [];
  const seen = new Set();
  parts.forEach(part => {
    const key = part.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    uniq.push(part);
  });
  return uniq.length ? uniq : [raw];
}

function getRecipientAddressOptions(recipient) {
  const fromArray = Array.isArray(recipient?.addresses)
    ? recipient.addresses.map(addr => String(addr || '').trim()).filter(Boolean)
    : [];
  if (fromArray.length > 0) {
    return [...new Set(fromArray.map(addr => addr.toLowerCase()))]
      .map(lower => fromArray.find(addr => addr.toLowerCase() === lower));
  }
  return parseAddressOptions(recipient?.address || '');
}

function getContractRelevantRecipientAddresses(contract, recipient) {
  const allAddresses = getRecipientAddressOptions(recipient);
  if (!contract || !recipient || allAddresses.length <= 1) return allAddresses;

  const contractItems = getApprovedItems(contract).flatMap(item => buildOrderRowsForContractItem(item, contract.number));
  if (!contractItems.length) return allAddresses;

  const relevantAddresses = allAddresses.filter(address => (
    contractItems.some(item => {
      const metrics = getRecipientNeedMetrics(recipient, {
        productId: item.productId ?? null,
        productName: item.contractItemName || item.displayName || '',
        contractCode: item.contractItemCode || item.baseCode || '',
        variantId: item.variantId || '',
        colorCode: item.colorCode || '',
        address,
      });
      return (Number(metrics?.qty) || 0) > 0;
    })
  ));

  return relevantAddresses.length ? relevantAddresses : allAddresses;
}

function getWarehouseAddressOptions(warehouse) {
  return parseAddressOptions(warehouse?.address || '');
}

function ensureDirectAddressRows() {
  if (directAddressRowsDraft.length > 0) {
    addressRows = cloneAddressRows(directAddressRowsDraft).map(row => ({
      ...row,
      warehouseId: null,
    }));
    return;
  }

  const directRows = addressRows.filter(row => !row.warehouseId);
  if (directRows.length > 0) {
    addressRows = directRows.map(row => ({ ...row, warehouseId: null }));
    return;
  }

  addressRows = [{ id: makeAddrId(), address: '', recipientName: '', recipientId: null, warehouseId: null }];
}

function syncWarehouseAddressRows(warehouseId, preferredAddress = '') {
  const warehouse = (state.warehouses || []).find(wh => wh.id === warehouseId) || null;
  if (!warehouse) {
    addressRows = [];
    return;
  }

  const options = getWarehouseAddressOptions(warehouse);
  const selectedAddress = preferredAddress && options.includes(preferredAddress)
    ? preferredAddress
    : (options[0] || warehouse.address || '');

  const existingId = addressRows[0]?.id || makeAddrId();
  addressRows = [{
    id: existingId,
    address: selectedAddress,
    recipientName: warehouse.name || '',
    recipientId: null,
    warehouseId: warehouse.id,
  }];
}

// ─── Helpers ────────────────────────────────────────────────────
function getSupplierName(supplierId) {
  if (!supplierId) return '—';
  const s = (state.suppliers || []).find(x => x.id === supplierId);
  return s ? s.name : '—';
}

function getContractDisplay(c) {
  if (!c) return '—';
  return c.number ? `№ ${c.number}` : (c.title || `ID ${c.id}`);
}

function getApprovedItems(contract) {
  if (!contract || !Array.isArray(contract.items)) return [];
  return contract.items;
}

function getItemName(contractItem) {
  return contractItem.name && contractItem.name.trim() ? contractItem.name.trim() : '—';
}

function buildItemCode(contractItem, contractNumber) {
  void contractNumber;
  return String(contractItem?.code || '').trim();
}

function resolveProductByContractItem(contractItem) {
  const ref = contractItem.productRef ?? contractItem.productId ?? null;
  if (ref != null) {
    const p = state.products.find(p => p.id === ref);
    if (p) return p;
  }
  const name = (contractItem.name || '').trim().toLowerCase();
  if (name) {
    const p = state.products.find(p => (p.name || '').trim().toLowerCase() === name);
    if (p) return p;
  }
  return null;
}

function productRequiresAssembly(product) {
  return product && product.assembly === 'required';
}

function buildOrderRowsForContractItem(contractItem, contractNumber) {
  const catalogProduct = resolveProductByContractItem(contractItem);
  const baseName = getItemName(contractItem);
  const baseCode = buildItemCode(contractItem, contractNumber);
  const price = Number(contractItem.price) || 0;

  if (!hasProductColorVariants(catalogProduct)) {
    return [{
      id: makeItemId(),
      contractItemName: baseName,
      displayName: baseName,
      contractItemCode: baseCode,
      baseCode,
      price,
      date: '',
      qtys: new Map(),
      scheduleQtys: new Map(),
      colorCode: '',
      variantId: '',
      productId: catalogProduct?.id ?? contractItem.productRef ?? contractItem.productId ?? null,
      isColorVariant: false,
    }];
  }

  return getProductColorVariants(catalogProduct).map(variant => ({
    id: makeItemId(),
    contractItemName: baseName,
    displayName: `${baseName} · ${variant.colorCode}`,
    contractItemCode: variant.fullCode || buildProductFullCode(baseCode, variant.colorCode),
    baseCode,
    price,
    date: '',
    qtys: new Map(),
    scheduleQtys: new Map(),
    colorCode: variant.colorCode,
    variantId: variant.id,
    productId: catalogProduct?.id ?? contractItem.productRef ?? contractItem.productId ?? null,
    isColorVariant: true,
  }));
}

// ─── Flat rows ↔ structured model ───────────────────────────────

/**
 * Convert flat deliveryRows (saved format) → addressRows + itemRows
 */
function loadFromDeliveryRows(deliveryRows) {
  addressRows = [];
  itemRows = [];
  nextAddrId = 1;
  nextItemId = 1;

  if (!deliveryRows || deliveryRows.length === 0) return;

  // Collect unique addresses (preserve order)
  const addrMap = new Map(); // "address||recipientName" → addrId
  deliveryRows.forEach(r => {
    const key = (r.address || '') + '||' + (r.recipientName || '');
    if (!addrMap.has(key)) {
      const id = makeAddrId();
      addrMap.set(key, id);
      addressRows.push({
        id,
        address: r.address || '',
        recipientName: r.recipientName || '',
        recipientId: r.recipientId ?? null,
      });
    }
  });

  // Collect unique items (distinguish color variants by product + code + display name)
  const itemMap = new Map(); // unique row key → itemId
  deliveryRows.forEach(r => {
    const key = [
      r.productId ?? '',
      normalizeCompare(r.baseCode || r.contractItemCode || ''),
      normalizeCompare(r.contractItemCode || ''),
      normalizeCompare(r.displayName || r.contractItemName || ''),
      normalizeCompare(r.colorCode || ''),
      String(r.variantId || '').trim(),
    ].join('::');
    if (!itemMap.has(key)) {
      const id = makeItemId();
      itemMap.set(key, id);
      itemRows.push({
        id,
        contractItemName: r.contractItemName || '',
        displayName: r.displayName || r.contractItemName || '',
        contractItemCode: r.contractItemCode || '',
        baseCode: r.baseCode || r.contractItemCode || '',
        price: Number(r.price) || 0,
        date: r.date || '',
        qtys: new Map(),
        scheduleQtys: new Map(),
        colorCode: r.colorCode || '',
        variantId: r.variantId || '',
        productId: r.productId ?? null,
        isColorVariant: Boolean(r.variantId || r.colorCode),
      });
    }
    // Set qty for this address
    const itemId = itemMap.get(key);
    const addrId = addrMap.get((r.address || '') + '||' + (r.recipientName || ''));
    const item = itemRows.find(x => x.id === itemId);
    if (item && addrId != null) {
      item.qtys.set(addrId, (item.qtys.get(addrId) || 0) + (Number(r.qty) || 0));
    }
  });
}

/**
 * Convert addressRows + itemRows → flat deliveryRows for saving
 */
function buildDeliveryRowsForSave() {
  const sharedDate = getSingleScheduleDateForRows();
  const rows = [];
  itemRows.forEach(item => {
    const singleAddressId = addressRows.length === 1 ? addressRows[0].id : null;
    const scheduledQty = getItemScheduledQty(item);
    addressRows.forEach(addr => {
      const qty = singleAddressId != null && addr.id === singleAddressId
        ? scheduledQty
        : (item.qtys.get(addr.id) || 0);
      rows.push({
        contractItemName: item.contractItemName,
        displayName: item.displayName || item.contractItemName,
        contractItemCode: item.contractItemCode,
        baseCode: item.baseCode || item.contractItemCode,
        colorCode: item.colorCode || '',
        variantId: item.variantId || '',
        productId: item.productId ?? null,
        price: item.price,
        qty,
        date: sharedDate,
        address: addr.address,
        recipientName: addr.recipientName,
        recipientId: addr.recipientId,
      });
    });
  });
  return rows;
}

function normalizeCompare(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[«»"']/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildOrderDisplayEntries(rows) {
  const entries = [];
  const grouped = new Map();

  (rows || []).forEach(item => {
    const isVariant = Boolean(item?.isColorVariant || item?.colorCode);
    if (!isVariant) {
      entries.push({ kind: 'single', item });
      return;
    }

    const key = [
      item?.productId ?? '',
      normalizeCompare(item?.contractItemName || item?.displayName || ''),
      normalizeCompare(item?.baseCode || item?.contractItemCode || ''),
    ].join('::');

    if (!grouped.has(key)) {
      const group = {
        kind: 'group',
        key,
        title: item?.contractItemName || item?.displayName || '—',
        baseCode: item?.baseCode || item?.contractItemCode || '',
        productId: item?.productId ?? null,
        items: [],
      };
      grouped.set(key, group);
      entries.push(group);
    }
    grouped.get(key).items.push(item);
  });

  const display = [];
  entries.forEach(entry => {
    if (entry.kind !== 'group') {
      display.push(entry);
      return;
    }

    display.push({
      kind: 'summary',
      title: entry.title,
      baseCode: entry.baseCode,
      productId: entry.productId,
      items: entry.items,
    });

    entry.items.forEach(item => {
      display.push({ kind: 'variant', item, parentTitle: entry.title });
    });
  });

  return display;
}

function looksEmptyRow(row) {
  return !Array.isArray(row) || row.every(cell => String(cell ?? '').trim() === '');
}

function parseHumanDateToIso(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '—') return '';
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{1,2})[.\/-](\d{1,2})[.\/-](\d{2,4})$/);
  if (!m) return raw;
  const day = m[1].padStart(2, '0');
  const month = m[2].padStart(2, '0');
  const year = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${year}-${month}-${day}`;
}

function toNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  const raw = String(value ?? '').trim();
  if (!raw || raw === '—') return 0;
  const normalized = raw.replace(/\s+/g, '').replace(',', '.');
  const num = Number(normalized);
  return Number.isFinite(num) ? num : 0;
}

function buildOrderItemRowsFromContract(contract) {
  if (!contract) return [];
  return getApprovedItems(contract).flatMap(item => buildOrderRowsForContractItem(item, contract.number));
}

function buildImportItemRows(contract) {
  nextItemId = 1;
  const rows = buildOrderItemRowsFromContract(contract);
  rows.forEach(row => {
    row.qtys = new Map();
    row.date = '';
    row.scheduleQtys = new Map();
  });
  return rows;
}

function buildAddressRowsFromSavedDeliveryRows(deliveryRows = []) {
  const rows = [];
  const seen = new Map();

  deliveryRows.forEach(row => {
    const recipientIdKey = row?.recipientId != null ? String(row.recipientId) : '';
    const key = [
      recipientIdKey,
      normalizeCompare(row?.recipientName || ''),
      normalizeCompare(row?.address || ''),
    ].join('||');
    if (seen.has(key)) return;

    const addrRow = {
      id: makeAddrId(),
      address: String(row?.address || '').trim(),
      recipientName: String(row?.recipientName || '').trim(),
      recipientId: row?.recipientId ?? null,
      warehouseId: null,
    };
    seen.set(key, addrRow);
    rows.push(addrRow);
  });

  return rows;
}

function findOrderItemRowBySavedRow(rows, savedRow) {
  const savedVariantId = String(savedRow?.variantId || '').trim();
  const savedColorCode = normalizeCompare(savedRow?.colorCode || '');
  const savedProductId = savedRow?.productId != null ? String(savedRow.productId) : '';
  const savedFullCode = normalizeCompare(savedRow?.contractItemCode || '');
  const savedBaseCode = normalizeCompare(savedRow?.baseCode || '');
  const savedContractItemName = normalizeCompare(savedRow?.contractItemName || '');
  const savedDisplayName = normalizeCompare(savedRow?.displayName || '');
  const savedName = savedDisplayName || savedContractItemName;
  const looksLikeVariantRow = Boolean(
    savedVariantId
    || savedColorCode
    || (savedDisplayName && savedDisplayName !== savedContractItemName)
  );

  if (savedFullCode) {
    const byFullCode = rows.find(item => normalizeCompare(item?.contractItemCode || '') === savedFullCode);
    if (byFullCode) return byFullCode;
  }

  if (savedProductId && (savedBaseCode || savedName || savedColorCode)) {
    const byProductScopedIdentity = rows.find(item => {
      if (String(item?.productId ?? '') !== savedProductId) return false;
      const baseCodeMatches = savedBaseCode
        ? normalizeCompare(item?.baseCode || item?.contractItemCode || '') === savedBaseCode
        : true;
      const nameMatches = savedName
        ? (
            normalizeCompare(item?.displayName || '') === savedName
            || normalizeCompare(item?.contractItemName || '') === savedName
          )
        : true;
      const colorMatches = savedColorCode
        ? normalizeCompare(item?.colorCode || '') === savedColorCode
        : true;
      return baseCodeMatches && nameMatches && colorMatches;
    });
    if (byProductScopedIdentity) return byProductScopedIdentity;
  }

  if (savedColorCode) {
    const byColorAndProduct = rows.find(item =>
      normalizeCompare(item?.colorCode || '') === savedColorCode
      && (!savedProductId || String(item?.productId ?? '') === savedProductId)
      && (!savedDisplayName || normalizeCompare(item?.displayName || '') === savedDisplayName)
    );
    if (byColorAndProduct) return byColorAndProduct;
  }

  if (looksLikeVariantRow && savedDisplayName) {
    const byDisplayName = rows.find(item =>
      normalizeCompare(item?.displayName || '') === savedDisplayName
      && (!savedProductId || String(item?.productId ?? '') === savedProductId)
    );
    if (byDisplayName) return byDisplayName;
  }

  if (savedVariantId) {
    const byScopedVariantId = rows.find(item => {
      if (String(item?.variantId || '').trim() !== savedVariantId) return false;
      if (savedProductId && String(item?.productId ?? '') !== savedProductId) return false;
      if (savedBaseCode && normalizeCompare(item?.baseCode || item?.contractItemCode || '') !== savedBaseCode) return false;
      if (savedName) {
        const itemDisplayName = normalizeCompare(item?.displayName || '');
        const itemContractName = normalizeCompare(item?.contractItemName || '');
        if (itemDisplayName !== savedName && itemContractName !== savedName) return false;
      }
      return true;
    });
    if (byScopedVariantId) return byScopedVariantId;
  }

  if (looksLikeVariantRow) return null;

  if (savedBaseCode || savedName) {
    const byBaseCodeAndName = rows.find(item => {
      const codeMatches = savedBaseCode
        ? normalizeCompare(item?.baseCode || item?.contractItemCode || '') === savedBaseCode
        : true;
      const nameMatches = savedName
        ? (
            normalizeCompare(item?.contractItemName || '') === savedName
            || normalizeCompare(item?.displayName || '') === savedName
          )
        : true;
      const productMatches = savedProductId ? String(item?.productId ?? '') === savedProductId : true;
      return codeMatches && nameMatches && productMatches;
    });
    if (byBaseCodeAndName) return byBaseCodeAndName;
  }

  if (savedName) {
    return rows.find(item =>
      normalizeCompare(item?.displayName || '') === savedName
      || normalizeCompare(item?.contractItemName || '') === savedName
    ) || null;
  }

  return null;
}

function applySavedDeliveryRowsToOrderItems(deliveryRows = []) {
  itemRows.forEach(item => {
    ensureItemRuntimeFields(item);
    item.qtys = new Map();
  });

  deliveryRows.forEach(row => {
    const item = findOrderItemRowBySavedRow(itemRows, row);
    if (!item) return;

    const addressRow = addressRows.find(addr => {
      if (row?.recipientId != null && addr?.recipientId != null && String(addr.recipientId) === String(row.recipientId)) {
        return normalizeCompare(addr.address || '') === normalizeCompare(row.address || '');
      }
      return normalizeCompare(addr.recipientName || '') === normalizeCompare(row.recipientName || '')
        && normalizeCompare(addr.address || '') === normalizeCompare(row.address || '');
    });
    if (!addressRow) return;

    item.qtys.set(addressRow.id, (Number(item.qtys.get(addressRow.id)) || 0) + (Number(row?.qty) || 0));
    if (!item.date && row?.date) item.date = parseHumanDateToIso(row.date);
  });
}

function hydrateSchedulesFromFlatRows(flatRows) {
  const uniqueDates = [];
  const seenDates = new Set();

  (flatRows || []).forEach(row => {
    const isoDate = parseHumanDateToIso(row?.date || '');
    const key = isoDate || '__blank__';
    if (seenDates.has(key)) return;
    seenDates.add(key);
    uniqueDates.push(isoDate);
  });

  deliverySchedules = uniqueDates
    .filter((date, idx) => date || idx === 0)
    .map(date => ({ id: makeScheduleId(), date: date || '' }));
  ensureDeliverySchedules();
  syncScheduleQtyMaps();

  (flatRows || []).forEach(row => {
    const item = itemRows.find(candidate =>
      normalizeCompare(candidate.contractItemCode) === normalizeCompare(row?.contractItemCode)
      || normalizeCompare(candidate.contractItemName) === normalizeCompare(row?.contractItemName)
    );
    if (!item) return;
    const isoDate = parseHumanDateToIso(row?.date || '');
    const schedule = deliverySchedules.find(candidate => candidate.date === isoDate)
      || deliverySchedules[0];
    item.scheduleQtys.set(schedule.id, (item.scheduleQtys.get(schedule.id) || 0) + (Number(row?.qty) || 0));
  });
}

function hydrateSchedulesFromSavedOrder(order) {
  const rawSchedules = Array.isArray(order?.deliverySchedules) ? order.deliverySchedules : [];
  const rawScheduleItems = Array.isArray(order?.scheduleItems) ? order.scheduleItems : [];

  if (rawSchedules.length === 0 || rawScheduleItems.length === 0) {
    hydrateSchedulesFromFlatRows(order?.deliveryRows || []);
    return;
  }

  const scheduleIdMap = new Map();
  deliverySchedules = rawSchedules.map(raw => {
    const runtimeId = makeScheduleId();
    scheduleIdMap.set(String(raw?.id ?? raw?.scheduleId ?? runtimeId), runtimeId);
    return {
      id: runtimeId,
      date: parseHumanDateToIso(raw?.date || ''),
    };
  });

  ensureDeliveryScheduleState();

  rawScheduleItems.forEach(rawItem => {
    const item = findOrderItemRowBySavedRow(itemRows, rawItem);
    if (!item) return;

    const rawDisplayName = normalizeCompare(rawItem?.displayName || '');
    const rawContractName = normalizeCompare(rawItem?.contractItemName || '');
    const rawBaseCode = normalizeCompare(rawItem?.baseCode || '');
    const rawFullCode = normalizeCompare(rawItem?.contractItemCode || '');
    const hasExplicitVariantMarker = Boolean(
      rawItem?.variantId
      || rawItem?.colorCode
      || (rawDisplayName && rawDisplayName !== rawContractName)
      || (rawBaseCode && rawFullCode && rawFullCode !== rawBaseCode)
    );

    if ((item.isColorVariant || item.colorCode) && !hasExplicitVariantMarker) {
      return;
    }

    const quantities = Array.isArray(rawItem?.quantities) ? rawItem.quantities : [];
    quantities.forEach(entry => {
      const runtimeId = scheduleIdMap.get(String(entry?.scheduleId ?? entry?.id ?? ''))
        || deliverySchedules.find(schedule => schedule.date === parseHumanDateToIso(entry?.date || ''))?.id;
      if (!runtimeId) return;
      item.scheduleQtys.set(runtimeId, Math.max(0, parseInt(entry?.qty, 10) || 0));

      const addressQuantities = Array.isArray(entry?.addressQuantities) ? entry.addressQuantities : [];
      addressQuantities.forEach(addrEntry => {
        const addrRow = addressRows.find(addr => {
          if (addrEntry?.recipientId != null && addr?.recipientId != null && String(addr.recipientId) === String(addrEntry.recipientId)) {
            return normalizeCompare(addr.address || '') === normalizeCompare(addrEntry.address || '');
          }
          return normalizeCompare(addr.recipientName || '') === normalizeCompare(addrEntry.recipientName || '')
            && normalizeCompare(addr.address || '') === normalizeCompare(addrEntry.address || '');
        });
        if (!addrRow) return;
        setItemScheduleAddrQty(item, runtimeId, addrRow.id, addrEntry.qty);
      });
    });
  });

  syncScheduleQtyMaps();
  if (deliveryModeState === 'direct') syncDirectTotalsFromMatrix();
}

function reconcileScheduleQtysWithDeliveryRows(order) {
  ensureDeliveryScheduleState();
  const flatRows = Array.isArray(order?.deliveryRows) ? order.deliveryRows : [];

  itemRows.forEach(item => {
    ensureItemRuntimeFields(item);

    const distributedQty = getItemDistributedQty(item);
    const scheduledQty = getItemScheduledQty(item);
    if (distributedQty === scheduledQty) return;

    item.scheduleQtys = new Map();
    deliverySchedules.forEach(schedule => item.scheduleQtys.set(schedule.id, 0));

    const matchingRows = flatRows.filter(row => findOrderItemRowBySavedRow([item], row) === item);
    if (matchingRows.length > 0) {
      matchingRows.forEach(row => {
        const qty = Math.max(0, Number(row?.qty) || 0);
        if (!qty) return;
        const isoDate = parseHumanDateToIso(row?.date || '');
        const schedule = deliverySchedules.find(candidate => candidate.date === isoDate)
          || deliverySchedules[0];
        if (!schedule) return;
        item.scheduleQtys.set(schedule.id, (Number(item.scheduleQtys.get(schedule.id)) || 0) + qty);
      });
    }

    const reconciledQty = getItemScheduledQty(item);
    if (reconciledQty === distributedQty) return;

    const firstSchedule = deliverySchedules[0] || { id: makeScheduleId(), date: '' };
    if (!deliverySchedules.length) {
      deliverySchedules = [firstSchedule];
    }
    item.scheduleQtys = new Map();
    deliverySchedules.forEach(schedule => item.scheduleQtys.set(schedule.id, 0));
    item.scheduleQtys.set(firstSchedule.id, distributedQty);
  });

  syncScheduleQtyMaps();
}

function hydrateSchedulesFromImportedItems(importedItems) {
  const runtimeSchedules = [];
  const scheduleByKey = new Map();

  const ensureSchedule = (dateValue) => {
    const date = parseHumanDateToIso(dateValue || '');
    const key = date || '__blank__';
    if (scheduleByKey.has(key)) return scheduleByKey.get(key);
    const schedule = { id: makeScheduleId(), date };
    scheduleByKey.set(key, schedule);
    runtimeSchedules.push(schedule);
    return schedule;
  };

  (importedItems || []).forEach(item => {
    ensureItemRuntimeFields(item);
    item.scheduleQtys = new Map();
    const entries = Array.isArray(item.__scheduleEntries) && item.__scheduleEntries.length > 0
      ? item.__scheduleEntries
      : [{ date: item.date || '', qty: getItemTotalQty(item) }];

    entries.forEach(entry => {
      const schedule = ensureSchedule(entry?.date || '');
      const qty = Math.max(0, parseInt(entry?.qty, 10) || 0);
      item.scheduleQtys.set(schedule.id, (item.scheduleQtys.get(schedule.id) || 0) + qty);
    });
  });

  deliverySchedules = runtimeSchedules;
  ensureDeliveryScheduleState();
}

function findItemRowForImport(importRows, codeValue, nameValue) {
  const code = normalizeCompare(codeValue);
  const name = normalizeCompare(nameValue);
  if (code) {
    const byCode = importRows.find(row => normalizeCompare(row.contractItemCode) === code);
    if (byCode) return byCode;
  }
  if (name) {
    const byName = importRows.find(row =>
      normalizeCompare(row.contractItemName) === name
      || normalizeCompare(row.displayName || '') === name
    );
    if (byName) return byName;
  }
  return null;
}

function parseAddressRegistryBlock(aoa) {
  const startIdx = aoa.findIndex(row => normalizeCompare(row?.[0]).includes('адреса поставки'));
  if (startIdx === -1) return [];
  const rows = [];
  for (let i = startIdx + 1; i < aoa.length; i += 1) {
    const row = aoa[i] || [];
    if (looksEmptyRow(row)) break;
    const recipientName = String(row[1] || '').trim();
    const address = String(row[2] || '').trim();
    if (!recipientName && !address) break;
    rows.push({ recipientName, address });
  }
  return rows;
}

function parseExportedDispatchWorkbook(aoa, contract) {
  const headerRowIndex = aoa.findIndex(row => {
    const c0 = normalizeCompare(row?.[0]);
    const c1 = normalizeCompare(row?.[1]);
    return c0 === '№' && c1 === 'наименование';
  });
  if (headerRowIndex === -1) return null;

  const headerRow = aoa[headerRowIndex] || [];
  const addressMeta = parseAddressRegistryBlock(aoa);
  const addressLabels = headerRow.slice(7).map(v => String(v || '').trim()).filter(Boolean);
  const addressRowsImported = (addressMeta.length > 0 ? addressMeta : addressLabels.map(label => ({ recipientName: label, address: label })))
    .map((row, idx) => ({
      id: makeAddrId(),
      recipientName: row.recipientName || '',
      recipientId: null,
      address: row.address || row.recipientName || addressLabels[idx] || '',
      warehouseId: null,
    }))
    .filter(row => row.recipientName || row.address);

  if (addressRowsImported.length === 0) return null;

  const importedItemRows = buildImportItemRows(contract);
  let matchedRows = 0;
  let unmatchedRows = 0;

  for (let i = headerRowIndex + 1; i < aoa.length; i += 1) {
    const row = aoa[i] || [];
    if (looksEmptyRow(row)) break;
    if (normalizeCompare(row?.[3]) === 'итого:') break;

    const itemRow = findItemRowForImport(importedItemRows, row[2], row[1]);
    if (!itemRow) {
      unmatchedRows += 1;
      continue;
    }

    itemRow.date = parseHumanDateToIso(row[6]) || itemRow.date;
    for (let col = 0; col < addressRowsImported.length; col += 1) {
      const qty = Math.max(0, Math.round(toNumber(row[7 + col])));
      if (qty > 0) itemRow.qtys.set(addressRowsImported[col].id, qty);
    }
    itemRow.__scheduleEntries = [{
      date: itemRow.date || '',
      qty: addressRowsImported.reduce((sum, _, colIdx) => sum + Math.max(0, Math.round(toNumber(row[7 + colIdx]))), 0),
    }];
    matchedRows += 1;
  }

  return {
    mode: 'direct',
    addressRows: addressRowsImported,
    itemRows: importedItemRows,
    matchedRows,
    unmatchedRows,
  };
}

function detectDispatchColumnIndexes(headerRow) {
  const normalized = headerRow.map(cell => normalizeCompare(cell));
  const findAny = (variants) => normalized.findIndex(val => variants.some(v => val.includes(v)));
  return {
    recipient: findAny(['получатель', 'организация']),
    address: findAny(['адрес']),
    code: findAny(['код товара', 'код']),
    name: findAny(['наименование', 'товар']),
    qty: findAny(['количество', 'кол-во', 'qty']),
    date: findAny(['срок поставки', 'дата поставки', 'дата']),
  };
}

function getMissingDispatchColumns(indexes) {
  const missing = [];
  if (indexes.recipient === -1) missing.push('Получатель');
  if (indexes.address === -1) missing.push('Адрес');
  if (indexes.qty === -1) missing.push('Количество');
  if (indexes.code === -1 && indexes.name === -1) missing.push('Код товара или Наименование');
  return missing;
}

function parseDispatchRowsWorkbook(aoa, contract) {
  let headerRowIndex = -1;
  let indexes = null;
  let missingColumns = [];

  for (let i = 0; i < Math.min(aoa.length, 20); i += 1) {
    const candidate = detectDispatchColumnIndexes(aoa[i] || []);
    const candidateMissing = getMissingDispatchColumns(candidate);
    if (candidateMissing.length === 0) {
      headerRowIndex = i;
      indexes = candidate;
      break;
    }
    if (!missingColumns.length || candidateMissing.length < missingColumns.length) {
      missingColumns = candidateMissing;
    }
  }

  if (headerRowIndex === -1 || !indexes) {
    return {
      error: 'missing-columns',
      missingColumns,
    };
  }

  const importedItemRows = buildImportItemRows(contract);
  const addrMap = new Map();
  const importedAddresses = [];
  let matchedRows = 0;
  let unmatchedRows = 0;

  const ensureAddress = (recipientName, address) => {
    const key = `${normalizeCompare(recipientName)}||${normalizeCompare(address)}`;
    if (addrMap.has(key)) return addrMap.get(key);
    const row = {
      id: makeAddrId(),
      recipientName: String(recipientName || '').trim(),
      recipientId: null,
      address: String(address || '').trim(),
      warehouseId: null,
    };
    importedAddresses.push(row);
    addrMap.set(key, row);
    return row;
  };

  for (let i = headerRowIndex + 1; i < aoa.length; i += 1) {
    const row = aoa[i] || [];
    if (looksEmptyRow(row)) continue;

    const recipientName = String(row[indexes.recipient] || '').trim();
    const address = String(row[indexes.address] || '').trim();
    const qty = Math.max(0, Math.round(toNumber(row[indexes.qty])));
    if (!recipientName || !address || qty <= 0) continue;

    const itemRow = findItemRowForImport(
      importedItemRows,
      indexes.code >= 0 ? row[indexes.code] : '',
      indexes.name >= 0 ? row[indexes.name] : ''
    );
    if (!itemRow) {
      unmatchedRows += 1;
      continue;
    }

    const addrRow = ensureAddress(recipientName, address);
    addrRow.recipientName = recipientName;
    addrRow.address = address;
    itemRow.qtys.set(addrRow.id, (itemRow.qtys.get(addrRow.id) || 0) + qty);
    const maybeDate = indexes.date >= 0 ? parseHumanDateToIso(row[indexes.date]) : '';
    if (maybeDate && !itemRow.date) itemRow.date = maybeDate;
    if (!Array.isArray(itemRow.__scheduleEntries)) itemRow.__scheduleEntries = [];
    itemRow.__scheduleEntries.push({ date: maybeDate || '', qty });
    matchedRows += 1;
  }

  if (importedAddresses.length === 0) return null;

  return {
    mode: 'direct',
    addressRows: importedAddresses,
    itemRows: importedItemRows,
    matchedRows,
    unmatchedRows,
  };
}

async function downloadDispatchTemplate() {
  const XLSX = window.XLSX || await loadXLSX().catch(() => null);
  if (!XLSX) {
    showToast(t('orders.excelLibMissing'), 'error');
    return;
  }

  const contractId = Number(document.getElementById('orderContractSel')?.value) || null;
  const contract = (state.contracts || []).find(c => c.id === contractId) || null;
  const contractItems = contract ? buildOrderItemRowsFromContract(contract) : [];
  const recipients = (state.recipients || []).slice().sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'ru'));

  const wb = XLSX.utils.book_new();
  const dispatchRows = [[
    'Получатель',
    'Адрес',
    'Код товара',
    'Наименование',
    'Количество',
    'Срок поставки',
  ]];

  if (contractItems.length > 0) {
    contractItems.forEach(item => {
      dispatchRows.push([
        '',
        '',
        item.contractItemCode || '',
        item.displayName || item.contractItemName || '',
        '',
        '',
      ]);
    });
  } else {
    dispatchRows.push(['', '', '', '', '', '']);
  }

  const wsDispatch = XLSX.utils.aoa_to_sheet(dispatchRows);
  wsDispatch['!cols'] = [
    { wch: 30 },
    { wch: 42 },
    { wch: 18 },
    { wch: 46 },
    { wch: 12 },
    { wch: 16 },
  ];

  const refsRows = [
    ['Инструкция'],
    ['1. Заполняйте только лист «Разнарядка».'],
    ['2. Обязательные столбцы: Получатель, Адрес, Код товара или Наименование, Количество.'],
    ['3. Получатель и адрес должны совпадать с карточками в модуле «Получатели».'],
    ['4. Срок поставки необязателен. Формат: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.'],
    [],
    ['Контракт', contract ? getContractDisplay(contract) : 'Не выбран'],
    [],
    ['Получатели и адреса'],
    ['Получатель', 'Адрес'],
  ];

  if (recipients.length > 0) {
    recipients.forEach(recipient => {
      const options = getRecipientAddressOptions(recipient);
      if (options.length === 0) {
        refsRows.push([recipient.name || '', '']);
      } else {
        options.forEach(addr => refsRows.push([recipient.name || '', addr]));
      }
    });
  } else {
    refsRows.push(['—', '—']);
  }

  refsRows.push([]);
  refsRows.push(['Товары контракта']);
  refsRows.push(['Код товара', 'Наименование', 'Цена, ₽']);
  if (contractItems.length > 0) {
    contractItems.forEach(item => refsRows.push([item.contractItemCode || '', item.displayName || item.contractItemName || '', item.price || 0]));
  } else {
    refsRows.push(['—', 'Выберите контракт в карточке заявки, чтобы получить список товаров', '']);
  }

  const wsRefs = XLSX.utils.aoa_to_sheet(refsRows);
  wsRefs['!cols'] = [{ wch: 32 }, { wch: 52 }, { wch: 14 }];

  XLSX.utils.book_append_sheet(wb, wsDispatch, 'Разнарядка');
  XLSX.utils.book_append_sheet(wb, wsRefs, 'Справочники');

  const suffix = contract?.number
    ? String(contract.number).replace(/[/\\?%*:|"<>]/g, '-')
    : 'blank';
  const fileName = `Шаблон_разнарядки_${suffix}.xlsx`;
  XLSX.writeFile(wb, fileName);
  showToast(t('orders.dispatchTemplateDownloaded'), 'success');
}

function xmlEscape(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function xmlCell(value, {
  styleId = 'Cell',
  type,
  mergeAcross = 0,
  mergeDown = 0,
  index = null,
} = {}) {
  const attrs = [];
  if (index != null) attrs.push(` ss:Index="${index}"`);
  if (styleId) attrs.push(` ss:StyleID="${styleId}"`);
  if (mergeAcross > 0) attrs.push(` ss:MergeAcross="${mergeAcross}"`);
  if (mergeDown > 0) attrs.push(` ss:MergeDown="${mergeDown}"`);

  const raw = value ?? '';
  const normalizedType = type || (typeof raw === 'number' && Number.isFinite(raw) ? 'Number' : 'String');
  const dataValue = normalizedType === 'Number' ? String(raw) : xmlEscape(raw).replace(/\n/g, '&#10;');
  return `<Cell${attrs.join('')}><Data ss:Type="${normalizedType}">${dataValue}</Data></Cell>`;
}

function xmlRow(cells, { height = null, autoFit = true } = {}) {
  const attrs = [];
  if (height != null) attrs.push(` ss:Height="${height}"`);
  if (!autoFit) attrs.push(' ss:AutoFitHeight="0"');
  return `<Row${attrs.join('')}>${cells.join('')}</Row>`;
}

function buildSpreadsheetWorksheetXml(name, { columns = [], rows = [] }) {
  const colsXml = columns.map(width => `<Column ss:AutoFitWidth="0" ss:Width="${width}"/>`).join('');
  return `
    <Worksheet ss:Name="${xmlEscape(name)}">
      <Table>${colsXml}${rows.join('')}</Table>
      <WorksheetOptions xmlns="urn:schemas-microsoft-com:office:excel">
        <PageSetup>
          <Layout x:Orientation="Landscape"/>
          <Header x:Margin="0.3"/>
          <Footer x:Margin="0.3"/>
          <PageMargins x:Bottom="0.5" x:Left="0.4" x:Right="0.4" x:Top="0.5"/>
        </PageSetup>
        <FitToPage/>
        <Print>
          <ValidPrinterInfo/>
          <PaperSizeIndex>9</PaperSizeIndex>
          <HorizontalResolution>600</HorizontalResolution>
          <VerticalResolution>600</VerticalResolution>
        </Print>
        <ProtectObjects>False</ProtectObjects>
        <ProtectScenarios>False</ProtectScenarios>
      </WorksheetOptions>
    </Worksheet>`;
}

function buildSpreadsheetWorkbookXml(sheets) {
  const stylesXml = `
    <Styles>
      <Style ss:ID="Default" ss:Name="Normal">
        <Alignment ss:Vertical="Center"/>
        <Borders/>
        <Font ss:FontName="Arial" ss:Size="10" ss:Color="#0F172A"/>
        <Interior/>
        <NumberFormat/>
        <Protection/>
      </Style>
      <Style ss:ID="Title">
        <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
        <Font ss:FontName="Arial" ss:Size="14" ss:Bold="1" ss:Color="#0F172A"/>
      </Style>
      <Style ss:ID="Section">
        <Alignment ss:Vertical="Center"/>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
      </Style>
      <Style ss:ID="MetaLabel">
        <Alignment ss:Vertical="Center"/>
        <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/></Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#334155"/>
        <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
      </Style>
      <Style ss:ID="MetaValue">
        <Alignment ss:Vertical="Center" ss:WrapText="1"/>
        <Borders><Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#E2E8F0"/></Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Color="#0F172A"/>
      </Style>
      <Style ss:ID="HeaderPrimary">
        <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
        <Interior ss:Color="#DDEAFE" ss:Pattern="Solid"/>
      </Style>
      <Style ss:ID="HeaderSecondary">
        <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
        <Interior ss:Color="#EEF4FF" ss:Pattern="Solid"/>
      </Style>
      <Style ss:ID="HeaderTertiary">
        <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#94A3B8"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="9" ss:Color="#334155"/>
        <Interior ss:Color="#F8FAFC" ss:Pattern="Solid"/>
      </Style>
      <Style ss:ID="Cell">
        <Alignment ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        </Borders>
      </Style>
      <Style ss:ID="CellCenter">
        <Alignment ss:Horizontal="Center" ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        </Borders>
      </Style>
      <Style ss:ID="CellMoney">
        <Alignment ss:Horizontal="Right" ss:Vertical="Center" ss:WrapText="1"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        </Borders>
        <NumberFormat ss:Format="# ##0.00"/>
      </Style>
      <Style ss:ID="CellInteger">
        <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#CBD5E1"/>
        </Borders>
        <NumberFormat ss:Format="0"/>
      </Style>
      <Style ss:ID="TotalLabel">
        <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
        <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
      </Style>
      <Style ss:ID="TotalMoney">
        <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
        <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
        <NumberFormat ss:Format="# ##0.00"/>
      </Style>
      <Style ss:ID="TotalInteger">
        <Alignment ss:Horizontal="Right" ss:Vertical="Center"/>
        <Borders>
          <Border ss:Position="Bottom" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Left" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Right" ss:LineStyle="Continuous" ss:Weight="1" ss:Color="#64748B"/>
          <Border ss:Position="Top" ss:LineStyle="Continuous" ss:Weight="2" ss:Color="#64748B"/>
        </Borders>
        <Font ss:FontName="Arial" ss:Size="10" ss:Bold="1" ss:Color="#0F172A"/>
        <Interior ss:Color="#E2E8F0" ss:Pattern="Solid"/>
        <NumberFormat ss:Format="0"/>
      </Style>
      <Style ss:ID="Muted">
        <Alignment ss:Vertical="Center" ss:WrapText="1"/>
        <Font ss:FontName="Arial" ss:Size="9" ss:Color="#64748B"/>
      </Style>
    </Styles>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
    <?mso-application progid="Excel.Sheet"?>
    <Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
      xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns:ss="urn:schemas-microsoft-com:office:spreadsheet"
      xmlns:html="http://www.w3.org/TR/REC-html40">
      <DocumentProperties xmlns="urn:schemas-microsoft-com:office:office">
        <Author>Miniapps AI</Author>
        <Created>${new Date().toISOString()}</Created>
      </DocumentProperties>
      <ExcelWorkbook xmlns="urn:schemas-microsoft-com:office:excel">
        <ProtectStructure>False</ProtectStructure>
        <ProtectWindows>False</ProtectWindows>
      </ExcelWorkbook>
      ${stylesXml}
      ${sheets.join('')}
    </Workbook>`;
}

async function handleDispatchImportFile(file) {
  if (!file) return;

  const contractId = Number(document.getElementById('orderContractSel')?.value) || null;
  const contract = (state.contracts || []).find(c => c.id === contractId) || null;
  if (!contract) {
    showToast(t('orders.importDispatchNoContract'), 'error');
    return;
  }

  const hasExistingData = addressRows.length > 0 || itemRows.some(row => Array.from(row.qtys?.values?.() || []).some(qty => qty > 0));
  if (hasExistingData && !confirm(t('orders.importDispatchReplaceConfirm'))) return;

  try {
    const XLSX = window.XLSX || await loadXLSX();
    const buffer = await file.arrayBuffer();
    const wb = XLSX.read(buffer, { type: 'array' });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) throw new Error('No sheet');
    const aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: false });

    const parsed = parseExportedDispatchWorkbook(aoa, contract) || parseDispatchRowsWorkbook(aoa, contract);
    if (parsed?.error === 'missing-columns') {
      showToast(t('orders.importDispatchMissingColumns', {
        columns: (parsed.missingColumns || []).join(', '),
      }), 'error', 6000);
      return;
    }
    if (!parsed) {
      showToast(t('orders.importDispatchUnsupported'), 'error', 5000);
      return;
    }
    if (!parsed.addressRows?.length) {
      showToast(t('orders.importDispatchEmpty'), 'error');
      return;
    }
    const invalidRecipients = getImportedRecipientsWithWrongProgram(parsed.addressRows, getCurrentOrderProgramName());
    if (invalidRecipients.length > 0) {
      showToast(t('orders.importDispatchProgramMismatch', {
        names: invalidRecipients.join(', '),
      }), 'error', 6000);
      return;
    }
    if (!parsed.itemRows?.some(row => Array.from(row.qtys.values()).some(qty => qty > 0))) {
      showToast(t('orders.importDispatchNoMatches'), 'error', 5000);
      return;
    }

    parsed.addressRows.forEach(row => {
      const recipient = findRecipientForAddressRow(row);
      if (recipient) {
        row.recipientId = recipient.id;
        row.recipientName = recipient.name || row.recipientName || '';
      }
    });

    addressRows = cloneAddressRows(parsed.addressRows);
    directAddressRowsDraft = cloneAddressRows(parsed.addressRows);
    itemRows = parsed.itemRows;
    hydrateSchedulesFromImportedItems(itemRows);

    const deliveryModeSel = document.getElementById('orderDeliveryModeSel');
    if (deliveryModeSel) {
      deliveryModeSel.value = 'direct';
      deliveryModeSel.dispatchEvent(new Event('change'));
    }

    if ((parsed.unmatchedRows || 0) > 0) {
      showToast(t('orders.importDispatchPartial', { count: parsed.unmatchedRows }), 'warning', 5000);
    } else {
      const importedItemsCount = parsed.itemRows.filter(row => Array.from(row.qtys.values()).some(qty => qty > 0)).length;
      showToast(t('orders.importDispatchImported', {
        addresses: parsed.addressRows.length,
        items: importedItemsCount,
      }), 'success', 4500);
    }
  } catch (error) {
    console.error('[orders] import dispatch failed', error);
    showToast(t('orders.importDispatchReadError'), 'error', 5000);
  }
}

// ─── Limit helpers ───────────────────────────────────────────────

function getCurrentContractId() {
  const sel = document.getElementById('orderContractSel');
  return sel ? Number(sel.value) || null : null;
}

function normalizeOrderItemLimitKey(parts = []) {
  return parts
    .map(part => normalizeCompare(part || ''))
    .filter(Boolean)
    .join('::');
}

function getLimitKeyFromContractItem(contractItem = {}) {
  return normalizeOrderItemLimitKey([
    contractItem.productRef ?? contractItem.productId ?? '',
    contractItem.code || '',
    contractItem.name || '',
  ]);
}

function getLimitKeyFromOrderItem(item = {}) {
  return normalizeOrderItemLimitKey([
    item.productId ?? '',
    item.baseCode || item.contractItemCode || '',
    item.contractItemName || item.displayName || '',
  ]);
}

function getLimitKeyFromSavedDeliveryRow(row = {}) {
  return normalizeOrderItemLimitKey([
    row.productId ?? '',
    row.baseCode || row.contractItemCode || '',
    row.contractItemName || row.displayName || '',
  ]);
}

function getItemQtyLimit(item, contractId) {
  const contract = (state.contracts || []).find(c => c.id === contractId);
  if (!contract) return Infinity;
  const itemKey = getLimitKeyFromOrderItem(item);
  const ci = (contract.items || []).find(i => getLimitKeyFromContractItem(i) === itemKey);
  if (!ci) return Infinity;
  const contractQty = Number(ci.qty) || 0;
  if (contractQty === 0) return Infinity;

  let alreadyOrdered = 0;
  (state.orders || [])
    .filter(o => o.contractId === contractId && o.id !== editingOrderId)
    .forEach(order => {
      (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(r => {
        if (getLimitKeyFromSavedDeliveryRow(r) === itemKey) {
          alreadyOrdered += Number(r.qty) || 0;
        }
      });
    });

  return Math.max(0, contractQty - alreadyOrdered);
}

function getContractMoneyLimit(contractId) {
  const contract = (state.contracts || []).find(c => c.id === contractId);
  if (!contract) return Infinity;
  const totalPrice = Number(contract.totalPrice) || 0;
  if (totalPrice === 0) return Infinity;

  let alreadySpent = 0;
  (state.orders || [])
    .filter(o => o.contractId === contractId && o.id !== editingOrderId)
    .forEach(order => {
      (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(r => {
        alreadySpent += (Number(r.qty) || 0) * (Number(r.price) || 0);
      });
    });

  return Math.max(0, totalPrice - alreadySpent);
}

function syncOrderCardFromDom() {
  const scheduleDateInputs = document.querySelectorAll('#orderItemsWrap input[type="date"][data-schedule]');
  scheduleDateInputs.forEach(inp => {
    const scheduleId = Number(inp.dataset.schedule);
    const schedule = deliverySchedules.find(entry => entry.id === scheduleId);
    if (!schedule) return;
    schedule.date = inp.value || '';
  });

  const scheduleQtyInputs = document.querySelectorAll('#orderItemsWrap input[data-row][data-schedule]:not([data-addr])');
  scheduleQtyInputs.forEach(inp => {
    const rowIdx = Number(inp.dataset.row);
    const scheduleId = Number(inp.dataset.schedule);
    if (!Number.isFinite(rowIdx) || !Number.isFinite(scheduleId) || !itemRows[rowIdx]) return;
    ensureItemRuntimeFields(itemRows[rowIdx]);
    itemRows[rowIdx].scheduleQtys.set(scheduleId, Math.max(0, parseInt(inp.value, 10) || 0));
  });

  const qtyInputs = document.querySelectorAll('#orderItemsWrap input[data-row][data-addr]:not([data-schedule])');
  qtyInputs.forEach(inp => {
    const rowIdx = Number(inp.dataset.row);
    const addrId = Number(inp.dataset.addr);
    if (!Number.isFinite(rowIdx) || !Number.isFinite(addrId) || !itemRows[rowIdx]) return;
    itemRows[rowIdx].qtys.set(addrId, Math.max(0, parseInt(inp.value, 10) || 0));
  });

  const scheduleAddrInputs = document.querySelectorAll('#orderItemsWrap input[data-row][data-schedule][data-addr]');
  scheduleAddrInputs.forEach(inp => {
    const rowIdx = Number(inp.dataset.row);
    const addrId = Number(inp.dataset.addr);
    const scheduleId = Number(inp.dataset.schedule);
    if (!Number.isFinite(rowIdx) || !Number.isFinite(addrId) || !Number.isFinite(scheduleId) || !itemRows[rowIdx]) return;
    setItemScheduleAddrQty(itemRows[rowIdx], scheduleId, addrId, inp.value);
  });

  syncDirectScheduleQtysFromRecipients();
}

function resolveProgramNameByValue(programValue) {
  const value = String(programValue || '').trim();
  if (!value) return '';
  return getProgramByIdentity(value)?.name || value;
}

function formatProgramValueLabel(programValue) {
  const value = String(programValue || '').trim();
  if (!value) return '';
  return formatProgramLabel(getProgramByIdentity(value) || value);
}

function resolveOrderProgramName(order) {
  if (!order) return '';
  return resolveProgramNameByValue(order.programName || order.programCode || '');
}

function resolveRecipientProgramName(recipient) {
  return resolveProgramNameByValue(recipient?.targetProgram || '');
}

function getCurrentOrderProgramName() {
  const programSel = document.getElementById('orderProgramSel');
  return resolveProgramNameByValue(programSel?.value || '');
}

function isRecipientAllowedForProgram(recipient, orderProgramName) {
  if (!recipient) return false;
  const currentProgram = String(orderProgramName || '').trim();
  if (!currentProgram) return true;
  const recipientProgram = resolveRecipientProgramName(recipient);
  return !!recipientProgram && recipientProgram === currentProgram;
}

function findRecipientForAddressRow(row) {
  if (!row) return null;
  if (row.recipientId != null) {
    const byId = (state.recipients || []).find(r => String(r.id) === String(row.recipientId));
    if (byId) return byId;
  }
  const normalizedName = normalizeCompare(row.recipientName || '');
  if (!normalizedName) return null;
  return (state.recipients || []).find(r => normalizeCompare(r.name || '') === normalizedName) || null;
}

function getImportedRecipientsWithWrongProgram(addressRowsToCheck, orderProgramName) {
  if (!orderProgramName) return [];
  const invalidNames = [];
  const seen = new Set();
  (addressRowsToCheck || []).forEach(row => {
    const recipient = findRecipientForAddressRow(row);
    if (!recipient || isRecipientAllowedForProgram(recipient, orderProgramName)) return;
    const key = String(recipient.id);
    if (seen.has(key)) return;
    seen.add(key);
    invalidNames.push(recipient.name || row.recipientName || '—');
  });
  return invalidNames;
}

function getRecipientsForOrderProgram(orderProgramName) {
  const recipients = state.recipients || [];
  if (!orderProgramName) return recipients;
  return recipients.filter(recipient => isRecipientAllowedForProgram(recipient, orderProgramName));
}

function getNeedMetricsForOrderItemAndRecipient(item, recipient) {
  if (!recipient || !item) {
    return {
      qty: 0,
      delivered: 0,
      assembled: 0,
      productId: item?.productId ?? null,
      variantId: item?.variantId || '',
      colorCode: item?.colorCode || '',
    };
  }

  return getRecipientNeedMetrics(recipient, {
    productId: item.productId ?? null,
    productName: item.contractItemName || item.displayName || '',
    contractCode: item.contractItemCode || item.baseCode || '',
    variantId: item.variantId || '',
    colorCode: item.colorCode || '',
  });
}

function getProgramNeedForOrderItem(item, orderProgramName) {
  return getRecipientsForOrderProgram(orderProgramName).reduce((acc, recipient) => {
    const metrics = getNeedMetricsForOrderItemAndRecipient(item, recipient);
    acc.qty += Number(metrics.qty) || 0;
    acc.delivered += Number(metrics.delivered) || 0;
    acc.assembled += Number(metrics.assembled) || 0;
    return acc;
  }, {
    qty: 0,
    delivered: 0,
    assembled: 0,
  });
}

function getRecipientNeedForOrderItem(item, recipientId, address = '') {
  const recipient = (state.recipients || []).find(r => String(r.id) === String(recipientId)) || null;
  if (!recipient || !item) {
    return {
      qty: 0,
      delivered: 0,
      assembled: 0,
      productId: item?.productId ?? null,
      variantId: item?.variantId || '',
      colorCode: item?.colorCode || '',
    };
  }

  return getRecipientNeedMetrics(recipient, {
    productId: item.productId ?? null,
    productName: item.contractItemName || item.displayName || '',
    contractCode: item.contractItemCode || item.baseCode || '',
    variantId: item.variantId || '',
    colorCode: item.colorCode || '',
    address,
  });
}

function getSelectedRecipientAddressesForDirectOrder() {
  const seen = new Set();
  return (addressRows || []).filter((row) => {
    const recipientId = row?.recipientId;
    const address = String(row?.address || '').trim();
    if (recipientId == null || recipientId === '' || !address) return false;
    const key = `${recipientId}::${normalizeCompare(address)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function getSelectedRecipientsNeedForOrderItem(item) {
  return getSelectedRecipientAddressesForDirectOrder().reduce((acc, row) => {
    const metrics = getRecipientNeedForOrderItem(item, row.recipientId, row.address || '');
    acc.qty += Number(metrics.qty) || 0;
    acc.delivered += Number(metrics.delivered) || 0;
    acc.assembled += Number(metrics.assembled) || 0;
    return acc;
  }, {
    qty: 0,
    delivered: 0,
    assembled: 0,
  });
}

function getRecipientAllocatedQtyForItem(item, recipientId, address = '') {
  if (!recipientId || !item?.qtys) return 0;
  const addressKey = normalizeCompare(address || '');
  return addressRows.reduce((sum, addr) => {
    if (String(addr.recipientId || '') !== String(recipientId)) return sum;
    if (addressKey && normalizeCompare(addr.address || '') !== addressKey) return sum;
    return sum + (Number(item.qtys.get(addr.id)) || 0);
  }, 0);
}

function getRecipientOrderedInOtherOrders(item, recipientId, address = '') {
  if (!recipientId || !item) return 0;

  const addressKey = normalizeCompare(address || '');
  let total = 0;
  (state.orders || [])
    .filter(order => order.id !== editingOrderId)
    .forEach(order => {
      (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(row => {
        if (String(row?.recipientId || '') !== String(recipientId)) return;
        if (addressKey && normalizeCompare(row?.address || '') !== addressKey) return;
        if (findOrderItemRowBySavedRow([item], row) !== item) return;
        total += Number(row?.qty) || 0;
      });
    });

  return total;
}

function buildRecipientNeedSnapshot(item, recipientId, address = '', options = {}) {
  const includeCurrentOrder = options.includeCurrentOrder !== false;
  const recipientNeed = getRecipientNeedForOrderItem(item, recipientId, address);
  const needQty = Number(recipientNeed.qty) || 0;
  const orderedOther = getRecipientOrderedInOtherOrders(item, recipientId, address);
  const currentAllocated = includeCurrentOrder ? getRecipientAllocatedQtyForItem(item, recipientId, address) : 0;
  const remaining = Math.max(0, needQty - orderedOther - currentAllocated);
  const over = Math.max(0, orderedOther + currentAllocated - needQty);

  return {
    needQty,
    orderedOther,
    currentAllocated,
    remaining,
    over,
  };
}

function getRecipientDefaultOrderAddress(recipient) {
  const options = getRecipientAddressOptions(recipient);
  return options[0] || '';
}

function buildRecipientAddressGroups(rows = []) {
  const groups = [];
  const groupMap = new Map();

  rows.forEach((row, index) => {
    const recipientKey = row?.recipientId != null
      ? `id:${row.recipientId}`
      : `name:${normalizeCompare(row?.recipientName || '') || index}`;

    if (!groupMap.has(recipientKey)) {
      const group = {
        key: recipientKey,
        recipientName: String(row?.recipientName || '').trim(),
        rows: [],
      };
      groupMap.set(recipientKey, group);
      groups.push(group);
    }

    groupMap.get(recipientKey).rows.push(row);
  });

  return groups;
}

function hasDirectOrderMatrixData() {
  const hasAddressData = (addressRows || []).some(row =>
    String(row?.recipientName || '').trim()
    || String(row?.address || '').trim()
    || row?.recipientId != null
  );
  const hasQtyData = (itemRows || []).some(item => {
    ensureItemRuntimeFields(item);
    return Array.from(item.qtys.values()).some(value => (Number(value) || 0) > 0)
      || Array.from(item.scheduleQtys.values()).some(value => (Number(value) || 0) > 0)
      || Array.from(item.scheduleAddrQtys.values()).some(value => (Number(value) || 0) > 0);
  });
  return hasAddressData || hasQtyData;
}

function autofillDirectOrderMatrixByRemainingNeed() {
  ensureDeliveryScheduleState();

  const currentOrderProgramName = getCurrentOrderProgramName();
  const recipients = getRecipientsForOrderProgram(currentOrderProgramName);
  const nextAddressRows = [];

  recipients.forEach((recipient) => {
    const recipientAddresses = getRecipientAddressOptions(recipient);
    recipientAddresses.forEach((address) => {
      if (!address) return;

      const hasRemainingNeed = itemRows.some(item => buildRecipientNeedSnapshot(item, recipient.id, address, {
        includeCurrentOrder: false,
      }).remaining > 0);
      if (!hasRemainingNeed) return;

      nextAddressRows.push({
        id: makeAddrId(),
        address,
        recipientName: recipient.name || '',
        recipientId: recipient.id,
        warehouseId: null,
      });
    });
  });

  if (nextAddressRows.length === 0) {
    return { ok: false, reason: 'no-recipients' };
  }

  const primarySchedule = deliverySchedules[0] || { id: makeScheduleId(), date: '' };
  if (!deliverySchedules.length) deliverySchedules = [primarySchedule];

  addressRows = nextAddressRows;
  directAddressRowsDraft = cloneAddressRows(nextAddressRows);
  syncScheduleQtyMaps();

  let filledRows = 0;
  let totalQty = 0;

  itemRows.forEach((item) => {
    ensureItemRuntimeFields(item);
    item.qtys = new Map();
    item.scheduleQtys = new Map();
    item.scheduleAddrQtys = new Map();

    nextAddressRows.forEach((addr) => {
      const snapshot = buildRecipientNeedSnapshot(item, addr.recipientId, addr.address || '', {
        includeCurrentOrder: false,
      });
      if (snapshot.remaining <= 0) return;
      setItemScheduleAddrQty(item, primarySchedule.id, addr.id, snapshot.remaining);
      filledRows += 1;
      totalQty += snapshot.remaining;
    });

    syncDirectTotalsForItem(item);
  });

  if (filledRows === 0 || totalQty === 0) {
    return { ok: false, reason: 'no-data' };
  }

  return {
    ok: true,
    recipients: nextAddressRows.length,
    rows: filledRows,
    qty: totalQty,
  };
}

function getContractProgramBudget(contract, programValue) {
  const programName = resolveProgramNameByValue(programValue);
  if (!contract || !programName) return { programName, budget: 0 };

  const prog = (contract.programs || []).find(p => {
    const name = typeof p === 'string' ? p : (p?.name || '');
    return name === programName;
  });

  return {
    programName,
    budget: Number(prog?.price) || 0,
  };
}

function buildCurrentOrderValidation() {
  syncOrderCardFromDom();

  const contractId = getCurrentContractId();
  const contract = (state.contracts || []).find(c => c.id === contractId);
  if (!contract) {
    return {
      contract: null,
      itemOverages: [],
      contractOverage: 0,
      programOverage: 0,
      currentOrderTotal: 0,
      otherOrdersTotal: 0,
      totalWithCurrent: 0,
      contractTotalPrice: 0,
      programName: '',
      programBudget: 0,
      otherProgramTotal: 0,
      programTotalWithCurrent: 0,
      hasOverage: false,
    };
  }

  const currentOrderItemQty = new Map();
  let currentOrderTotal = 0;

  itemRows.forEach(item => {
    const key = getLimitKeyFromOrderItem(item);
    const qty = getItemEffectiveQty(item, deliveryModeState);
    currentOrderTotal += qty * (Number(item.price) || 0);
    if (key) currentOrderItemQty.set(key, (currentOrderItemQty.get(key) || 0) + qty);
  });

  const otherOrdersItemQty = new Map();
  let otherOrdersTotal = 0;

  (state.orders || [])
    .filter(order => order.contractId === contractId && order.id !== editingOrderId)
    .forEach(order => {
      (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(row => {
        const qty = Number(row.qty) || 0;
        const price = Number(row.price) || 0;
        const key = getLimitKeyFromSavedDeliveryRow(row);
        otherOrdersTotal += qty * price;
        if (key) otherOrdersItemQty.set(key, (otherOrdersItemQty.get(key) || 0) + qty);
      });
    });

  const itemOverages = [];
  currentOrderItemQty.forEach((currentQty, itemKey) => {
    const contractItem = (contract.items || []).find(i => getLimitKeyFromContractItem(i) === itemKey);
    if (!contractItem) return;
    const contractQty = Number(contractItem.qty) || 0;
    const alreadyOrdered = otherOrdersItemQty.get(itemKey) || 0;
    const remaining = Math.max(0, contractQty - alreadyOrdered);
    if (contractQty > 0 && currentQty > remaining) {
      itemOverages.push({
        name: contractItem.name || '—',
        current: currentQty,
        remaining,
        over: currentQty - remaining,
      });
    }
  });

  const contractTotalPrice = Number(contract.totalPrice) || 0;
  const totalWithCurrent = otherOrdersTotal + currentOrderTotal;
  const contractOverage = contractTotalPrice > 0 && totalWithCurrent > contractTotalPrice
    ? totalWithCurrent - contractTotalPrice
    : 0;

  const programValue = document.getElementById('orderProgramSel')?.value || '';
  const { programName, budget: programBudget } = getContractProgramBudget(contract, programValue);
  let otherProgramTotal = 0;

  if (programName) {
    (state.orders || [])
      .filter(order => order.contractId === contractId && order.id !== editingOrderId)
      .forEach(order => {
        if (resolveOrderProgramName(order) !== programName) return;
        (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(row => {
          otherProgramTotal += (Number(row.qty) || 0) * (Number(row.price) || 0);
        });
      });
  }

  const programTotalWithCurrent = otherProgramTotal + currentOrderTotal;
  const programOverage = programName && programTotalWithCurrent > programBudget
    ? programTotalWithCurrent - programBudget
    : 0;

  return {
    contract,
    itemOverages,
    contractOverage,
    programOverage,
    currentOrderTotal,
    otherOrdersTotal,
    totalWithCurrent,
    contractTotalPrice,
    programName,
    programBudget,
    otherProgramTotal,
    programTotalWithCurrent,
    hasOverage: itemOverages.length > 0 || contractOverage > 0 || programOverage > 0,
  };
}

function applyItemAvailabilityVisual(currentQty, availableQty, qtyInputs, totalQtyTd, totalCostTd) {
  const hasLimit = Number.isFinite(availableQty) && availableQty !== Infinity;
  const exceeded = hasLimit && currentQty > availableQty;

  qtyInputs.forEach(inp => {
    inp.style.borderColor = exceeded ? 'rgb(239, 68, 68)' : '';
    inp.title = hasLimit ? `Доступно по контракту: ${availableQty} шт.` : '';
  });

  if (totalQtyTd) {
    totalQtyTd.style.color = exceeded ? 'rgb(248, 113, 113)' : '';
    totalQtyTd.title = hasLimit
      ? `Доступно по контракту: ${availableQty} шт. · Введено: ${currentQty} шт.`
      : '';
  }

  if (totalCostTd) {
    totalCostTd.style.color = exceeded ? 'rgb(248, 113, 113)' : '';
  }
}

function renderOrderMoneyHintLines(container, validation) {
  if (!container) return;
  clearChildren(container);

  if (!validation?.contract) return;

  const contractRemaining = Math.max(0, (validation.contractTotalPrice || 0) - (validation.totalWithCurrent || 0));
  const contractLine = el('div', {
    className: validation.contractOverage > 0
      ? 'text-[10px] leading-tight text-red-400 font-medium'
      : 'text-[10px] leading-tight text-slate-500',
  }, validation.contractOverage > 0
    ? tOrder('contractExceededHint', {
        total: fmtMoney(validation.totalWithCurrent),
        limit: fmtMoney(validation.contractTotalPrice),
        over: fmtMoney(validation.contractOverage),
      })
    : tOrder('contractRemainingHint', {
        remaining: fmtMoney(contractRemaining),
        limit: fmtMoney(validation.contractTotalPrice),
      }));
  container.appendChild(contractLine);

  if (validation.programName) {
    const programRemaining = Math.max(0, (validation.programBudget || 0) - (validation.programTotalWithCurrent || 0));
    const programLine = el('div', {
      className: validation.programOverage > 0
        ? 'text-[10px] leading-tight text-red-400 font-medium'
        : 'text-[10px] leading-tight text-slate-500',
    }, validation.programOverage > 0
      ? tOrder('programExceededHint', {
          name: validation.programName,
          total: fmtMoney(validation.programTotalWithCurrent),
          limit: fmtMoney(validation.programBudget),
          over: fmtMoney(validation.programOverage),
        })
      : tOrder('programRemainingHint', {
          name: validation.programName,
          remaining: fmtMoney(programRemaining),
          limit: fmtMoney(validation.programBudget),
        }));
    container.appendChild(programLine);
  }
}

// ─── Badge ───────────────────────────────────────────────────────
export function updateOrdersBadge() {
  const badge = $('ordersBadge');
  if (!badge) return;
  const count = (state.orders || []).length;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ─── Registry Panel ──────────────────────────────────────────────
function renderRegistryList() {
  const container = $('ordersRegistryList');
  if (!container) return;
  clearChildren(container);

  const q = registrySearchQuery.trim().toLowerCase();
  const allOrders = state.orders || [];

  const searchInputEl = document.getElementById('ordersSearchInput');
  if (searchInputEl) {
    searchInputEl.setAttribute('list', 'ordersSearchOptions');
    let list = document.getElementById('ordersSearchOptions');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'ordersSearchOptions';
      searchInputEl.insertAdjacentElement('afterend', list);
    }
    const options = [...new Set(
      allOrders.flatMap(o => {
        const contract = (state.contracts || []).find(c => c.id === o.contractId);
        const supplier = contract?.supplierId
          ? (state.suppliers || []).find(s => s.id === contract.supplierId)
          : null;
        return [o.orderNumber, contract?.number, contract?.title, supplier?.name]
          .map(v => String(v || '').trim())
          .filter(Boolean);
      })
    )].sort((a, b) => a.localeCompare(b, 'ru'));
    list.innerHTML = options.map(option => `<option value="${option.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')}"></option>`).join('');
    enhancePredictiveInput(searchInputEl, {
      listId: 'ordersSearchOptions',
      options,
      icon: '🔍',
      minWidth: '260px',
    });
  }

  const orders = q
    ? allOrders.filter(o => {
        const contract = (state.contracts || []).find(c => c.id === o.contractId);
        const contractStr = contract
          ? `${contract.number || ''} ${contract.title || ''}`.toLowerCase()
          : '';
        const supplierStr = getSupplierName(contract?.supplierId).toLowerCase();
        const orderNum = (o.orderNumber || '').toLowerCase();
        return contractStr.includes(q) || supplierStr.includes(q) || orderNum.includes(q);
      })
    : allOrders;

  if (orders.length === 0) {
    container.appendChild(
      el('div', { className: 'py-12 text-center' },
        el('p', { className: 'text-4xl mb-3' }, q ? '🔍' : '📋'),
        el('p', { className: 'text-sm font-semibold text-slate-300 mb-1' },
          q ? t('orders.searchEmpty') : t('orders.empty')),
        el('p', { className: 'text-xs text-slate-500' },
          q ? t('orders.searchEmptyHint') : t('orders.emptyHint')),
      )
    );
    return;
  }

  [...orders].reverse().forEach(order => {
    const contract = (state.contracts || []).find(c => c.id === order.contractId);
    const totalCost = (order.deliveryRows || []).reduce((s, r) =>
      s + (Number(r.qty) || 0) * (Number(r.price) || 0), 0);
    const uniqueItems = new Set((order.deliveryRows || []).map(r => r.variantId || r.colorCode || r.contractItemCode || r.contractItemName)).size;
    const uniqueAddrs = new Set((order.deliveryRows || []).map(r => r.address || '')).size;
    const programLabel = order.programCode
      ? formatProgramLabel(getProgramByIdentity(order.programCode) || getProgramByIdentity(order.programName) || order.programCode)
      : '';

    const card = el('div', { className: 'rounded-xl border border-white/10 bg-white/5 overflow-hidden transition hover:border-cyan-400/20' });

    const displayOrderNumber = (order.orderNumber && order.orderNumber.trim())
      ? order.orderNumber
      : `Заявка #${order.id}`;

    const headerRow = el('div', { className: 'flex items-center gap-2 px-4 py-3 cursor-pointer select-none' });
    headerRow.setAttribute('role', 'button');
    headerRow.setAttribute('aria-expanded', 'false');

    const arrow = el('span', { className: 'text-slate-500 text-xs shrink-0 select-none' }, '▶');
    arrow.style.transition = 'transform 0.2s';
    headerRow.appendChild(arrow);

    const titleArea = el('div', { className: 'flex-1 min-w-0 flex items-center gap-2 flex-wrap' });
    titleArea.appendChild(el('span', { className: 'text-sm font-bold text-cyan-400 truncate' }, displayOrderNumber));
    if (order.sent) titleArea.appendChild(el('span', { className: 'rounded-md bg-emerald-400/15 px-2 py-0.5 text-[10px] font-semibold text-emerald-400' }, t('orders.sentBadge')));
    titleArea.appendChild(el('span', { className: 'text-xs text-slate-400 truncate' },
      `${getContractDisplay(contract)} · ${getSupplierName(contract?.supplierId)}`));
    if (programLabel) titleArea.appendChild(el('span', { className: 'text-xs text-slate-400 truncate' }, programLabel));
    titleArea.appendChild(el('span', { className: 'text-xs text-slate-500' },
      `${uniqueItems} поз. · ${uniqueAddrs} адр. · ${fmtMoney(totalCost)} ₽`));
    titleArea.appendChild(el('span', { className: 'text-xs text-amber-300' },
      `${t('orders.fieldAdvanceAmount')}: ${fmtMoney(order.advanceAmount || 0)} ₽`));
    headerRow.appendChild(titleArea);

    const actions = el('div', { className: 'flex gap-1 shrink-0' });

    const supplier = contract?.supplierId
      ? (state.suppliers || []).find(s => s.id === contract.supplierId)
      : null;
    if (supplier?.email) {
      const emailBtn = el('button', {
        className: 'rounded-lg p-2 text-slate-400 hover:bg-emerald-500/20 hover:text-emerald-400 transition',
        'aria-label': t('orders.sendEmail'),
        title: `${t('orders.sendEmail')}: ${supplier.email}`,
      }, '✉');
      emailBtn.addEventListener('click', e => {
        e.stopPropagation();
        sendOrderByEmail(order, contract, supplier);
      });
      actions.appendChild(emailBtn);
    }

    const editBtn = el('button', {
      className: 'rounded-lg p-2 text-slate-400 hover:bg-white/10 hover:text-white transition',
      'aria-label': t('actions.edit'),
      title: t('actions.edit'),
    }, '✎');
    editBtn.addEventListener('click', e => { e.stopPropagation(); openOrderCard(order.id); });

    const delBtn = el('button', {
      className: 'rounded-lg p-2 text-slate-400 hover:bg-red-500/20 hover:text-red-400 transition',
      'aria-label': t('actions.delete'),
      title: t('actions.delete'),
    }, '✕');
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      if (!confirmDeleteWithImpact({
        title: 'Удалить заявку?',
        subject: displayOrderNumber,
        impacts: [
          'заявка будет удалена из реестра',
        ],
        recalculations: [
          'показатели «Заказано» и финансовые суммы по контракту будут пересчитаны',
        ],
        risks: [
          'уже оформленные отгрузки, акты и прямые поставки по этой заявке не удаляются автоматически',
        ],
      })) return;
      const contractIdToRefresh = order.contractId || null;
      deleteOrder(order.id);
      if (contractIdToRefresh) {
        syncOrderedToContract(contractIdToRefresh);
        refreshContractItemsOrdered(contractIdToRefresh);
      }
      saveToStorage();
      updateOrdersBadge();
      renderRegistryList();
      showToast(t('orders.deleted'), 'success');
    });

    actions.append(editBtn, delBtn);
    headerRow.appendChild(actions);
    card.appendChild(headerRow);

    const body = el('div', { className: 'hidden border-t border-white/10 px-4 py-3 space-y-1' });
    const dateStr = order.createdAt ? new Date(order.createdAt).toLocaleDateString('ru-RU') : '';
    if (order.sentDate) body.appendChild(el('p', { className: 'text-xs text-slate-500' }, `✉ Отправлена: ${fmtDate(order.sentDate)}`));
    if (dateStr) body.appendChild(el('p', { className: 'text[10px] text-slate-600' }, `Создана: ${dateStr}`));
    body.appendChild(el('p', { className: 'text-xs text-amber-300' },
      `${t('orders.fieldAdvanceAmount')}: ${fmtMoney(order.advanceAmount || 0)} ₽ · ${(Number(order.advancePercent) || 0)}%`));

    // Show address list preview
    const addrSet = new Set();
    (order.deliveryRows || []).forEach(r => {
      if (r.address) addrSet.add((r.recipientName ? r.recipientName + ': ' : '') + r.address);
    });
    addrSet.forEach(a => body.appendChild(el('p', { className: 'text-xs text-slate-500' }, `📍 ${a}`)));

    const openBtn = el('button', {
      type: 'button',
      className: 'mt-2 inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/5 px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-400/15 transition',
    }, `✎ ${t('orders.openOrder')}`);
    openBtn.addEventListener('click', (e) => { e.stopPropagation(); openOrderCard(order.id, true); });
    body.appendChild(openBtn);
    card.appendChild(body);

    headerRow.addEventListener('click', e => {
      if (e.target.closest('button')) return;
      const expanded = headerRow.getAttribute('aria-expanded') === 'true';
      headerRow.setAttribute('aria-expanded', String(!expanded));
      arrow.style.transform = expanded ? '' : 'rotate(90deg)';
      body.classList.toggle('hidden', expanded);
    });

    container.appendChild(card);
  });
}

// ─── Email / Excel send ──────────────────────────────────────────
function markOrderAsSent(orderId, supplier) {
  const o = (state.orders || []).find(x => x.id === orderId);
  if (!o) return;
  o.supplierId = supplier?.id ?? o.supplierId ?? null;
  o.sent = true;
  o.sentDate = new Date().toISOString().slice(0, 10);
  o.status = 'sent';
  saveToStorage();
  renderRegistryList();
}

function buildOrderExportContext(order = null) {
  const contractSel = $('orderContractSel');
  const programSel = $('orderProgramSel');
  const numDisplay = $('orderNumberDisplay');
  const warehouseSel = $('orderWarehouseSel');

  const contractId = order?.contractId ?? (contractSel ? Number(contractSel.value) : null);
  const contract = contractId ? (state.contracts || []).find(c => c.id === contractId) : null;
  const supplier = contract?.supplierId
    ? (state.suppliers || []).find(s => s.id === contract.supplierId)
    : null;

  return {
    orderNumber: order?.orderNumber || numDisplay?.textContent || '—',
    contract,
    supplier,
    programCode: order?.programCode || programSel?.value || '',
    deliveryMode: order?.deliveryMode || deliveryModeState || 'direct',
    deliveryModeLabel: (order?.deliveryMode || deliveryModeState || 'direct') === 'warehouse'
      ? t('orders.deliveryModeWarehouse')
      : t('orders.deliveryModeDirect'),
    selectedWarehouse: warehouseSel?.selectedOptions?.[0]?.textContent?.trim() || '—',
    addressRows: order
      ? buildAddressRowsFromSavedDeliveryRows(order.deliveryRows || [])
      : cloneAddressRows(addressRows),
    itemRows: order
      ? (() => {
          const rows = [];
          const grouped = new Map();
          (order.deliveryRows || []).forEach(row => {
            const key = [
              row.productId ?? '',
              normalizeCompare(row.baseCode || row.contractItemCode || ''),
              normalizeCompare(row.contractItemCode || ''),
              normalizeCompare(row.displayName || row.contractItemName || ''),
              normalizeCompare(row.colorCode || ''),
              String(row.variantId || '').trim(),
            ].join('::');
            if (!grouped.has(key)) {
              const item = {
                id: makeItemId(),
                contractItemName: row.contractItemName || '',
                displayName: row.displayName || row.contractItemName || '',
                contractItemCode: row.contractItemCode || '',
                baseCode: row.baseCode || row.contractItemCode || '',
                price: Number(row.price) || 0,
                date: row.date || '',
                qtys: new Map(),
                scheduleQtys: new Map(),
                scheduleAddrQtys: new Map(),
                colorCode: row.colorCode || '',
                variantId: row.variantId || '',
                productId: row.productId ?? null,
                isColorVariant: Boolean(row.variantId || row.colorCode),
              };
              grouped.set(key, item);
              rows.push(item);
            }
          });
          return rows;
        })()
      : itemRows,
    deliverySchedules: order
      ? cloneDeliverySchedules(order.deliverySchedules || [])
      : cloneDeliverySchedules(deliverySchedules),
    scheduleItems: order
      ? (Array.isArray(order.scheduleItems) ? order.scheduleItems : [])
      : buildScheduleBreakdownForSave(),
    deliveryRows: order
      ? (Array.isArray(order.deliveryRows) ? order.deliveryRows : [])
      : buildDeliveryRowsForSave(),
  };
}

function getContractRenameActRow(contract, item, fallbackIndex = -1) {
  const rows = Array.isArray(contract?.renameActRows) ? contract.renameActRows : [];
  const itemId = String(item?.itemId || '').trim();
  if (itemId) {
    const exact = rows.find(row => String(row?.contractItemId || '').trim() === itemId);
    if (exact) return exact;
  }
  if (fallbackIndex >= 0 && rows[fallbackIndex]) return rows[fallbackIndex];
  const code = normalizeCompare(item?.code || '');
  const name = normalizeCompare(item?.name || item?.contractItemName || item?.displayName || '');
  return rows.find((row) => {
    const rowCode = normalizeCompare(row?.productCode || '');
    const rowName = normalizeCompare(row?.productName || row?.specificationName || '');
    return (code && rowCode && code === rowCode) || (name && rowName && name === rowName);
  }) || null;
}

function buildOrderContractItemNamesText(contract, item, fallbackIndex = -1) {
  const renameRow = getContractRenameActRow(contract, item, fallbackIndex);
  const variants = [];
  const seen = new Set();

  [
    item?.contractItemName,
    item?.displayName,
    item?.name,
    renameRow?.productName,
    item?.specificationName,
    renameRow?.specificationName,
  ].forEach((value) => {
    const text = String(value || '').trim();
    if (!text) return;
    const key = normalizeCompare(text);
    if (seen.has(key)) return;
    seen.add(key);
    variants.push(text);
  });

  const code = String(item?.contractItemCode || item?.code || renameRow?.productCode || '').trim();
  const main = variants.shift() || '—';
  const extra = variants.length ? ` (${variants.join('; ')})` : '';
  const codeText = code ? ` Код ${code}` : '';
  return `${main}${extra}${codeText}`.trim();
}

function buildOrderContractCharacteristicsText(contract, item, fallbackIndex = -1) {
  const renameRow = getContractRenameActRow(contract, item, fallbackIndex);
  const direct = [
    renameRow?.characteristics,
    item?.characteristics,
    item?.specSummary,
  ].map(value => String(value || '').trim()).find(Boolean);
  if (direct) return direct;

  let contractItem = (contract?.items || []).find((candidate) => {
    const sameId = String(candidate?.itemId || '').trim() && String(candidate?.itemId || '').trim() === String(item?.itemId || '').trim();
    const sameCode = normalizeCompare(candidate?.code || '') && normalizeCompare(candidate?.code || '') === normalizeCompare(item?.contractItemCode || item?.code || '');
    const sameName = normalizeCompare(candidate?.name || '') && normalizeCompare(candidate?.name || '') === normalizeCompare(item?.contractItemName || item?.displayName || '');
    return sameId || sameCode || sameName;
  }) || null;

  if (!contractItem && fallbackIndex >= 0) {
    contractItem = (contract?.items || [])[fallbackIndex] || null;
  }

  if (contractItem?.characteristics) return String(contractItem.characteristics).trim();
  const product = resolveProductByContractItem(contractItem || item);
  if (Array.isArray(product?.specs) && product.specs.length > 0) {
    const fromSpecs = product.specs
      .map((spec) => {
        const param = String(spec?.param || '').trim();
        const value = String(spec?.value || '').trim();
        const unit = String(spec?.unit || '').trim();
        const tail = [value, unit].filter(Boolean).join(' ');
        if (param && tail) return `${param}: ${tail}`;
        return param || tail;
      })
      .filter(Boolean)
      .join('; ');
    if (fromSpecs) return fromSpecs;
  }
  return 'В соответствии с договором';
}

function buildOrderWordRows(context) {
  const contract = context.contract || null;
  const rows = [];
  const schedules = Array.isArray(context.deliverySchedules) && context.deliverySchedules.length
    ? context.deliverySchedules
    : [{ id: '__single__', date: '' }];
  const addresses = Array.isArray(context.addressRows) && context.addressRows.length
    ? context.addressRows
    : [{ id: '__single__', recipientName: '', address: '' }];
  const servicesText = 'Доставка изготовленной мебели в место ее доставки, погрузочно-разгрузочные работы, включая подъем изготовленной мебели на этаж, сборка и расстановка изготовленной мебели в месте ее эксплуатации, а также ввод изготовленной мебели в эксплуатацию';
  const servicePeriodText = '10 календарных дней с момента доставки мебели в место ее эксплуатации';
  const warehousePlaceFallback = 'В соответствии с заявкой Заказчика';

  (context.itemRows || []).forEach((item, itemIndex) => {
    const namesText = buildOrderContractItemNamesText(contract, item, itemIndex);
    const characteristicsText = buildOrderContractCharacteristicsText(contract, item, itemIndex);
    const unitText = String(item?.unit || 'шт.').trim() || 'шт.';
    const price = Number(item?.price) || 0;

    if (context.deliveryMode === 'direct') {
      schedules.forEach((schedule) => {
        addresses.forEach((addr) => {
          const qty = getItemScheduleAddrQty(item, schedule.id, addr.id);
          if (qty <= 0) return;
          rows.push({
            namesText,
            characteristicsText,
            qty,
            unitText,
            deliveryAddress: addr.address || '—',
            recipientName: addr.recipientName || '—',
            deliveryTerm: schedule?.date ? `до ${fmtDate(schedule.date)}` : 'по заявке Заказчика',
            exploitationPlace: addr.address || warehousePlaceFallback,
            servicesText,
            servicePeriodText,
            amount: qty * price,
          });
        });
      });
      return;
    }

    schedules.forEach((schedule) => {
      const qty = Math.max(0, parseInt(item.scheduleQtys?.get?.(schedule.id), 10) || 0);
      if (qty <= 0) return;
      const addr = addresses[0] || { address: '', recipientName: '' };
      rows.push({
        namesText,
        characteristicsText,
        qty,
        unitText,
        deliveryAddress: addr.address || '—',
        recipientName: addr.recipientName || '—',
        deliveryTerm: schedule?.date ? `до ${fmtDate(schedule.date)}` : 'по заявке Заказчика',
        exploitationPlace: warehousePlaceFallback,
        servicesText,
        servicePeriodText,
        amount: qty * price,
      });
    });
  });

  if (!rows.length) {
    (context.itemRows || []).forEach((item, itemIndex) => {
      const qty = getItemEffectiveQty(item, context.deliveryMode);
      if (qty <= 0) return;
      const addr = addresses[0] || { address: '', recipientName: '' };
      rows.push({
        namesText: buildOrderContractItemNamesText(contract, item, itemIndex),
        characteristicsText: buildOrderContractCharacteristicsText(contract, item, itemIndex),
        qty,
        unitText: String(item?.unit || 'шт.').trim() || 'шт.',
        deliveryAddress: addr.address || '—',
        recipientName: addr.recipientName || '—',
        deliveryTerm: 'по заявке Заказчика',
        exploitationPlace: addr.address || warehousePlaceFallback,
        servicesText,
        servicePeriodText,
        amount: qty * (Number(item?.price) || 0),
      });
    });
  }

  return rows;
}

function buildOrderWordRtf(context) {
  const contract = context.contract || null;
  const supplierName = context.supplier?.name || '________________________';
  const contractDateText = contract?.date ? fmtDate(contract.date) : '________________';
  const contractNumberText = contract?.number || '________________';
  const orderNumberText = context.orderNumber || '________________';
  const rows = buildOrderWordRows(context);
  const titleText = contract?.title ? `на ${contract.title}` : 'на изготовление мебели';
  const totalAmount = rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0);
  const contactLine = 'Главный специалист отдела городских проектов и МТС ГАУ ЦТО ________________________________';
  const phoneLine = 'Тел.: ________________________________';
  const widths = [500, 1800, 2900, 650, 750, 1600, 1200, 1200, 1200, 2000, 1600];

  const tableHeader = buildRtfTableRow([
    { text: '№ п/п', align: 'center', bold: true, size: 16 },
    { text: 'Наименование мебели в соответствии с Договором', align: 'center', bold: true, size: 16 },
    { text: 'Характеристики мебели в соответствии с Договором', align: 'center', bold: true, size: 16 },
    { text: 'Объем', align: 'center', bold: true, size: 16 },
    { text: 'Единица измерения', align: 'center', bold: true, size: 16 },
    { text: 'Адрес доставки мебели', align: 'center', bold: true, size: 16 },
    { text: 'Наименование адресата', align: 'center', bold: true, size: 16 },
    { text: 'Срок доставки по адресу доставки мебели', align: 'center', bold: true, size: 16 },
    { text: 'Место эксплуатации', align: 'center', bold: true, size: 16 },
    { text: 'Вид оказываемых сопутствующих услуг по месту эксплуатации товара', align: 'center', bold: true, size: 16 },
    { text: 'Сроки оказываемых сопутствующих услуг по месту эксплуатации мебели', align: 'center', bold: true, size: 16 },
  ], widths);

  const tableRows = rows.map((row, index) => buildRtfTableRow([
    { text: `${index + 1}.`, align: 'center', size: 16 },
    { text: row.namesText, size: 16 },
    { text: row.characteristicsText, size: 16 },
    { text: String(row.qty || ''), align: 'center', size: 16 },
    { text: row.unitText, align: 'center', size: 16 },
    { text: row.deliveryAddress, size: 16 },
    { text: row.recipientName, size: 16 },
    { text: row.deliveryTerm, size: 16 },
    { text: row.exploitationPlace, size: 16 },
    { text: row.servicesText, size: 16 },
    { text: row.servicePeriodText, size: 16 },
  ], widths)).join('');

  const signatureTable = buildRtfTableRow([
    { text: 'Подпись', align: 'center', bold: true, size: 18 },
    { text: 'Подпись', align: 'center', bold: true, size: 18 },
  ], [7600, 7600], { rowHeight: 720 })
    + buildRtfTableRow([
      { text: '______________________________', align: 'center', size: 18 },
      { text: '______________________________', align: 'center', size: 18 },
    ], [7600, 7600], { rowHeight: 720 })
    + buildRtfTableRow([
      { text: `${contactLine}\n${phoneLine}`, align: 'center', size: 18 },
      { text: context.supplier?.name ? context.supplier.name : '______________________________', align: 'center', size: 18 },
    ], [7600, 7600], { rowHeight: 720 })
    + buildRtfTableRow([
      { text: 'Дата: __________________ 20__', align: 'center', size: 18 },
      { text: `Дата: ${new Date().toLocaleDateString('ru-RU')}`, align: 'center', size: 18 },
    ], [7600, 7600], { rowHeight: 720 });

  return `{\\rtf1\\ansi\\ansicpg1251\\deff0
{\\fonttbl{\\f0 Times New Roman;}}
\\paperw16840\\paperh11907\\margl567\\margr567\\margt567\\margb567\\landscape
${buildRtfParagraph(`Кому: ${supplierName}`, { size: 22, spaceAfter: 120 })}
${buildRtfParagraph(`Заявка № ${orderNumberText}`, { align: 'center', bold: true, size: 28, spaceAfter: 60 })}
${buildRtfParagraph(titleText, { align: 'center', size: 22, spaceAfter: 160 })}
${buildRtfParagraph(`На основании гражданско-правового договора от ${contractDateText} № ${contractNumberText} просим Вас осуществить изготовление и поставку следующего товара:`, { size: 20, spaceAfter: 180 })}
${tableHeader}
${tableRows}
${buildRtfParagraph(`Итого сумма по заявке ${fmtMoney(totalAmount)} руб.`, { bold: true, size: 22, spaceAfter: 180 })}
${signatureTable}
}`;
}

async function buildOrderWordArtifact(order = null) {
  const context = buildOrderExportContext(order);
  applyScheduleBreakdownToExportItems(context);
  const rtf = buildOrderWordRtf(context);
  const safeNum = String(context.orderNumber || 'order').replace(/[/\\?%*:|"<>]/g, '-');
  const fileName = `Заявка_${safeNum}.rtf`;
  const blob = new Blob([rtf], { type: 'application/rtf;charset=utf-8' });
  const file = typeof File !== 'undefined'
    ? new File([blob], fileName, { type: blob.type })
    : null;
  return { blob, file, fileName, context };
}

function applyScheduleBreakdownToExportItems(context) {
  const addrRows = context.addressRows || [];
  const runtimeSchedules = context.deliverySchedules || [];
  const rows = context.itemRows || [];
  rows.forEach(item => {
    ensureItemRuntimeFields(item);
    item.qtys = new Map();
    item.scheduleQtys = new Map();
    item.scheduleAddrQtys = new Map();
  });

  const scheduleIdMap = new Map();
  runtimeSchedules.forEach(schedule => {
    scheduleIdMap.set(String(schedule.id), schedule.id);
  });

  (context.scheduleItems || []).forEach(rawItem => {
    const item = findOrderItemRowBySavedRow(rows, rawItem);
    if (!item) return;
    ensureItemRuntimeFields(item);
    const quantities = Array.isArray(rawItem?.quantities) ? rawItem.quantities : [];
    quantities.forEach(entry => {
      const runtimeScheduleId = scheduleIdMap.get(String(entry?.scheduleId ?? entry?.id ?? ''))
        || runtimeSchedules.find(schedule => schedule.date === parseHumanDateToIso(entry?.date || ''))?.id;
      if (!runtimeScheduleId) return;
      item.scheduleQtys.set(runtimeScheduleId, Math.max(0, parseInt(entry?.qty, 10) || 0));
      (entry.addressQuantities || []).forEach(addrEntry => {
        const addr = addrRows.find(row => {
          if (addrEntry?.recipientId != null && row?.recipientId != null && String(row.recipientId) === String(addrEntry.recipientId)) {
            return normalizeCompare(row.address || '') === normalizeCompare(addrEntry.address || '');
          }
          return normalizeCompare(row.recipientName || '') === normalizeCompare(addrEntry.recipientName || '')
            && normalizeCompare(row.address || '') === normalizeCompare(addrEntry.address || '');
        });
        if (!addr) return;
        setItemScheduleAddrQty(item, runtimeScheduleId, addr.id, addrEntry.qty);
      });
    });
  });

  if ((context.deliveryMode || 'direct') === 'direct') {
    rows.forEach(syncDirectTotalsForItem);
    return;
  }

  rows.forEach(item => {
    const totalByAddr = new Map();
    runtimeSchedules.forEach(schedule => {
      addrRows.forEach(addr => {
        const qty = getItemScheduleAddrQty(item, schedule.id, addr.id);
        if (qty > 0) totalByAddr.set(addr.id, (totalByAddr.get(addr.id) || 0) + qty);
      });
    });
    if (totalByAddr.size > 0) {
      item.qtys = totalByAddr;
    } else if (addrRows.length === 1) {
      const total = runtimeSchedules.reduce((sum, schedule) => sum + (Number(item.scheduleQtys.get(schedule.id)) || 0), 0);
      item.qtys.set(addrRows[0].id, total);
    }
  });
}

async function buildOrderExcelArtifact(order = null) {
  const XLSX = window.XLSX || await loadXLSX().catch(() => null);
  if (!XLSX) throw new Error(t('orders.excelLibMissing'));

  const cloneStyle = style => JSON.parse(JSON.stringify(style));
  const borderAll = {
    top: { style: 'thin', color: { rgb: 'CBD5E1' } },
    bottom: { style: 'thin', color: { rgb: 'CBD5E1' } },
    left: { style: 'thin', color: { rgb: 'CBD5E1' } },
    right: { style: 'thin', color: { rgb: 'CBD5E1' } },
  };
  const styles = {
    title: {
      font: { name: 'Arial', sz: 14, bold: true, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
    },
    subtitle: {
      font: { name: 'Arial', sz: 10, italic: true, color: { rgb: '334155' } },
      alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
    },
    intro: {
      font: { name: 'Arial', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'left', vertical: 'center', wrapText: true },
    },
    header: {
      font: { name: 'Arial', sz: 10, bold: true, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      fill: { fgColor: { rgb: 'EEF4FF' } },
      border: borderAll,
    },
    bodyText: {
      font: { name: 'Arial', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
      border: borderAll,
    },
    bodyCenter: {
      font: { name: 'Arial', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center', vertical: 'top', wrapText: true },
      border: borderAll,
    },
    bodyInteger: {
      font: { name: 'Arial', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center', vertical: 'top', wrapText: true },
      border: borderAll,
      numFmt: '0',
    },
    note: {
      font: { name: 'Arial', sz: 9, color: { rgb: '475569' } },
      alignment: { horizontal: 'left', vertical: 'top', wrapText: true },
    },
    signature: {
      font: { name: 'Arial', sz: 10, color: { rgb: '0F172A' } },
      alignment: { horizontal: 'center', vertical: 'center', wrapText: true },
      border: borderAll,
    },
  };

  const ensureCell = (sheet, rowIndex, colIndex) => {
    const ref = XLSX.utils.encode_cell({ r: rowIndex, c: colIndex });
    if (!sheet[ref]) sheet[ref] = { t: 's', v: '' };
    return sheet[ref];
  };

  const applyStyleToRange = (sheet, range, style) => {
    for (let row = range.s.r; row <= range.e.r; row += 1) {
      for (let col = range.s.c; col <= range.e.c; col += 1) {
        ensureCell(sheet, row, col).s = cloneStyle(style);
      }
    }
  };

  const applyStyleToRow = (sheet, rowIndex, fromCol, toCol, style) => {
    applyStyleToRange(sheet, {
      s: { r: rowIndex, c: fromCol },
      e: { r: rowIndex, c: toCol },
    }, style);
  };

  const setFreezePane = (sheet, rows, cols = 0) => {
    sheet['!freeze'] = {
      xSplit: cols,
      ySplit: rows,
      topLeftCell: XLSX.utils.encode_cell({ r: rows, c: cols }),
    };
  };

  const context = buildOrderExportContext(order);
  applyScheduleBreakdownToExportItems(context);

  const contract = context.contract || null;
  const supplier = context.supplier || null;
  const servicesText = 'Погрузочно-разгрузочные работы, включая подъем изготовленной мебели на этаж; сборка; расстановка; ввод изготовленной мебели в эксплуатацию';
  const servicePeriodText = 'В течение 10 календарных дней с даты доставки мебели в место эксплуатации';
  const placeFallback = context.deliveryMode === 'warehouse'
    ? 'Определяется Заказчиком / по уведомлению о месте эксплуатации'
    : 'В соответствии с заявкой Заказчика';

  const findContractItemForExport = (item) => {
    if (!contract?.items?.length) return null;
    return contract.items.find(ci => {
      const itemCode = normalizeCompare(item?.baseCode || item?.contractItemCode || '');
      const itemName = normalizeCompare(item?.contractItemName || item?.displayName || '');
      return normalizeCompare(ci?.code || '') === itemCode
        || normalizeCompare(ci?.name || '') === itemName;
    }) || null;
  };

  const buildCharacteristicsText = (contractItem, item) => {
    const specText = Array.isArray(contractItem?.specs) && contractItem.specs.length
      ? contractItem.specs
          .map(spec => {
            const param = String(spec?.param || '').trim();
            const value = String(spec?.value || '').trim();
            const unit = String(spec?.unit || '').trim();
            return [param, value && ':', value, unit].filter(Boolean).join(' ');
          })
          .filter(Boolean)
          .join('; ')
      : '';
    const fallbackText = String(contractItem?.specificationName || '').trim();
    if (specText) return specText;
    if (fallbackText) return fallbackText;
    return `В соответствии с Договором и Техническим заданием${item?.colorCode ? `, цвет/вариант: ${item.colorCode}` : ''}`;
  };

  const getUnitText = (contractItem, item) => {
    const unit = String(contractItem?.unit || item?.unit || '').trim();
    return unit || 'шт.';
  };

  const deliveryDateText = (schedule, qty) => {
    const dateLabel = schedule?.date ? fmtDate(schedule.date) : 'по заявке Заказчика';
    return `${dateLabel}, ${qty} шт.`;
  };

  const exportRows = [];
  const schedules = Array.isArray(context.deliverySchedules) && context.deliverySchedules.length
    ? context.deliverySchedules
    : [{ id: '__single__', date: '' }];
  const addresses = Array.isArray(context.addressRows) && context.addressRows.length
    ? context.addressRows
    : [{ id: '__single__', recipientName: '', address: '' }];

  context.itemRows.forEach((item) => {
    const contractItem = findContractItemForExport(item);
    if (context.deliveryMode === 'direct') {
      schedules.forEach(schedule => {
        addresses.forEach(addr => {
          const qty = getItemScheduleAddrQty(item, schedule.id, addr.id);
          if (qty <= 0) return;
          exportRows.push({
            item,
            contractItem,
            qty,
            deliveryAddress: addr.address || '',
            recipientName: addr.recipientName || '',
            exploitationAddress: addr.address || placeFallback,
            deliveryTerm: deliveryDateText(schedule, qty),
          });
        });
      });
      return;
    }

    const warehouseAddr = addresses[0] || { address: '', recipientName: '' };
    schedules.forEach(schedule => {
      const qty = Math.max(0, parseInt(item.scheduleQtys?.get?.(schedule.id), 10) || 0);
      if (qty <= 0) return;
      exportRows.push({
        item,
        contractItem,
        qty,
        deliveryAddress: warehouseAddr.address || '',
        recipientName: warehouseAddr.recipientName || '',
        exploitationAddress: placeFallback,
        deliveryTerm: deliveryDateText(schedule, qty),
      });
    });
  });

  if (!exportRows.length) {
    context.itemRows.forEach((item) => {
      const contractItem = findContractItemForExport(item);
      exportRows.push({
        item,
        contractItem,
        qty: getItemEffectiveQty(item, context.deliveryMode),
        deliveryAddress: addresses[0]?.address || '',
        recipientName: addresses[0]?.recipientName || '',
        exploitationAddress: addresses[0]?.address || placeFallback,
        deliveryTerm: 'по заявке Заказчика',
      });
    });
  }

  const totalCols = 11;
  const aoa = [];
  const merges = [];
  const pushRow = (row = []) => {
    aoa.push(row);
    return aoa.length - 1;
  };

  const supplierLine = supplier?.name ? `Кому: ${supplier.name}` : 'Кому: _____________________';
  const contractDateText = contract?.date ? fmtDate(contract.date) : '___ . ___ . ______';
  const contractNumberText = contract?.number || '________________';
  const orderNumberText = context.orderNumber || '________________';
  const titleText = `Заявка № ${orderNumberText} на изготовление мебели`;
  const introText = `На основании Договора № ${contractNumberText} от ${contractDateText} просим Вас выполнить работы по изготовлению следующей мебели:`;

  const rowKому = pushRow([supplierLine]);
  merges.push({ s: { r: rowKому, c: 0 }, e: { r: rowKому, c: totalCols - 1 } });
  pushRow([]);

  const rowTitle = pushRow([titleText]);
  merges.push({ s: { r: rowTitle, c: 0 }, e: { r: rowTitle, c: totalCols - 1 } });

  const rowIntro = pushRow([introText]);
  merges.push({ s: { r: rowIntro, c: 0 }, e: { r: rowIntro, c: totalCols - 1 } });
  pushRow([]);

  const headerRow = pushRow([
    '№ п/п',
    'Наименование мебели в соответствии с Договором',
    'Характеристики мебели в соответствии с Договором',
    'Объем',
    'Единица измерения',
    'Адрес доставки мебели',
    'Наименование адресата',
    'Срок доставки по адресу доставки мебели и объем',
    'Место эксплуатации мебели*',
    'Вид оказываемых сопутствующих услуг по месту эксплуатации мебели',
    'Сроки оказываемых сопутствующих услуг по месту эксплуатации мебели**',
  ]);

  exportRows.forEach((row, index) => {
    pushRow([
      index + 1,
      row.item?.contractItemName || row.item?.displayName || '—',
      buildCharacteristicsText(row.contractItem, row.item),
      Number(row.qty) || 0,
      getUnitText(row.contractItem, row.item),
      row.deliveryAddress || '—',
      row.recipientName || '—',
      row.deliveryTerm || 'по заявке Заказчика',
      row.exploitationAddress || placeFallback,
      servicesText,
      servicePeriodText,
    ]);
  });

  pushRow([]);
  const note1 = pushRow(['* Место эксплуатации мебели может быть изменено Заказчиком путем корректировки заявки.']);
  merges.push({ s: { r: note1, c: 0 }, e: { r: note1, c: totalCols - 1 } });
  const note2 = pushRow(['** Указывается период, в течение которого Подрядчик оказывает сопутствующие услуги в предусмотренный Договором и Техническим заданием срок, с даты доставки мебели в место ее эксплуатации.']);
  merges.push({ s: { r: note2, c: 0 }, e: { r: note2, c: totalCols - 1 } });

  pushRow([]);
  const signHeader = pushRow([
    'Подпись',
    '',
    'Инициалы, фамилия ответственного лица Заказчика, телефон',
    '',
    'Дата/время',
    '',
    'Подпись',
    '',
    'Инициалы, фамилия ответственного лица Подрядчика',
    '',
    'Дата/время',
  ]);
  merges.push(
    { s: { r: signHeader, c: 0 }, e: { r: signHeader, c: 1 } },
    { s: { r: signHeader, c: 2 }, e: { r: signHeader, c: 3 } },
    { s: { r: signHeader, c: 4 }, e: { r: signHeader, c: 5 } },
    { s: { r: signHeader, c: 6 }, e: { r: signHeader, c: 7 } },
    { s: { r: signHeader, c: 8 }, e: { r: signHeader, c: 9 } },
    { s: { r: signHeader, c: 10 }, e: { r: signHeader, c: 10 } },
  );
  const signBlank = pushRow([
    '________________', '',
    '________________', '',
    '________________', '',
    '________________', '',
    '________________', '',
    '________________',
  ]);
  merges.push(
    { s: { r: signBlank, c: 0 }, e: { r: signBlank, c: 1 } },
    { s: { r: signBlank, c: 2 }, e: { r: signBlank, c: 3 } },
    { s: { r: signBlank, c: 4 }, e: { r: signBlank, c: 5 } },
    { s: { r: signBlank, c: 6 }, e: { r: signBlank, c: 7 } },
    { s: { r: signBlank, c: 8 }, e: { r: signBlank, c: 9 } },
    { s: { r: signBlank, c: 10 }, e: { r: signBlank, c: 10 } },
  );

  const sheet = XLSX.utils.aoa_to_sheet(aoa);
  sheet['!merges'] = merges;
  sheet['!cols'] = [
    { wch: 7 },
    { wch: 30 },
    { wch: 42 },
    { wch: 10 },
    { wch: 12 },
    { wch: 28 },
    { wch: 24 },
    { wch: 22 },
    { wch: 28 },
    { wch: 34 },
    { wch: 30 },
  ];
  sheet['!rows'] = aoa.map((row, index) => {
    if (index === rowTitle) return { hpx: 30 };
    if (index === rowIntro) return { hpx: 34 };
    if (index === headerRow) return { hpx: 52 };
    if (index === note1 || index === note2) return { hpx: 30 };
    return { hpx: 24 + Math.max(0, Math.ceil((Math.max(...row.map(cell => String(cell || '').length), 0) - 28) / 24) * 8) };
  });

  applyStyleToRange(sheet, { s: { r: rowKому, c: 0 }, e: { r: rowKому, c: totalCols - 1 } }, styles.subtitle);
  applyStyleToRange(sheet, { s: { r: rowTitle, c: 0 }, e: { r: rowTitle, c: totalCols - 1 } }, styles.title);
  applyStyleToRange(sheet, { s: { r: rowIntro, c: 0 }, e: { r: rowIntro, c: totalCols - 1 } }, styles.intro);
  applyStyleToRow(sheet, headerRow, 0, totalCols - 1, styles.header);

  for (let row = headerRow + 1; row < note1 - 1; row += 1) {
    ensureCell(sheet, row, 0).s = cloneStyle(styles.bodyCenter);
    ensureCell(sheet, row, 1).s = cloneStyle(styles.bodyText);
    ensureCell(sheet, row, 2).s = cloneStyle(styles.bodyText);
    ensureCell(sheet, row, 3).s = cloneStyle(styles.bodyInteger);
    ensureCell(sheet, row, 4).s = cloneStyle(styles.bodyCenter);
    for (let col = 5; col < totalCols; col += 1) {
      ensureCell(sheet, row, col).s = cloneStyle(styles.bodyText);
    }
  }

  applyStyleToRange(sheet, { s: { r: note1, c: 0 }, e: { r: note2, c: totalCols - 1 } }, styles.note);
  applyStyleToRow(sheet, signHeader, 0, totalCols - 1, styles.header);
  applyStyleToRow(sheet, signBlank, 0, totalCols - 1, styles.signature);
  setFreezePane(sheet, headerRow + 1, 0);

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Заявка');

  const arrayBuffer = XLSX.write(wb, {
    bookType: 'xlsx',
    type: 'array',
    compression: true,
    cellStyles: true,
  });

  const safeNum = String(context.orderNumber || 'order').replace(/[/\\?%*:|"<>]/g, '-');
  const fileName = `Заявка_${safeNum}.xlsx`;
  const blob = new Blob([arrayBuffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const file = typeof File !== 'undefined'
    ? new File([blob], fileName, { type: blob.type })
    : null;

  return { blob, file, fileName, context };
}

function downloadBlobFile(blob, fileName) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1500);
}

async function sendOrderByEmail(order, contract, supplier) {
  try {
    const { blob, file, fileName } = await buildOrderWordArtifact(order);
    const subject = `Заявка на поставку ${order?.orderNumber || `#${order?.id || ''}`}`.trim();

    let shared = false;
    if (file && navigator.share && navigator.canShare) {
      try {
        const shareData = {
          title: subject,
          text: `Заявка подготовлена в Word: ${fileName}`,
          files: [file],
        };
        if (navigator.canShare(shareData)) {
          await navigator.share(shareData);
          shared = true;
        }
      } catch (err) {
        if (err?.name === 'AbortError') return;
        console.warn('[orders] navigator.share unavailable, fallback to download+mailto:', err);
        shared = false;
      }
    }

    const openMailClient = (email, mailSubject, fileLabel) => {
      const mailtoSubject = encodeURIComponent(mailSubject);
      const mailtoBody = encodeURIComponent(`Во вложении Word-файл заявки: ${fileLabel}`);
      const href = `mailto:${email}?subject=${mailtoSubject}&body=${mailtoBody}`;

      try {
        const link = document.createElement('a');
        link.href = href;
        link.style.display = 'none';
        document.body.appendChild(link);
        link.click();
        link.remove();
      } catch (mailErr) {
        console.warn('[orders] mailto anchor fallback failed, switching to location.href:', mailErr);
        window.location.href = href;
        return;
      }
    }

    if (!shared) {
      downloadBlobFile(blob, fileName);
      openMailClient(supplier.email, subject, fileName);
      showToast(`📝 Word-файл скачан. Открыт почтовый клиент: ${supplier.email}`, 'success', 5000);
    } else {
      showToast(`📝 Заявка подготовлена для отправки: ${supplier.email}`, 'success', 5000);
    }

    markOrderAsSent(order.id, supplier);
  } catch (error) {
    console.error('[orders] send word failed', error);
    showToast(error?.message || 'Не удалось подготовить Word для отправки', 'error', 5000);
  }
}

// ─── Order Card ──────────────────────────────────────────────────

let _orderReadonly = false;
export function openOrderCard(orderId, readonly = false) {
  editingOrderId = orderId || null;
  addressRows = [];
  deliverySchedules = [];
  itemRows = [];
  nextAddrId = 1;
  nextScheduleId = 1;
  nextItemId = 1;
  executionReadinessState = 'not_applicable';
  executionActsState = { notReady: null, ready: null };
  executionManualAdvanceState = { stage1: 0, stage2: 0 };

  const panel = $('orderCardPanel');
  const listPanel = $('ordersRegistryListPanel');
  if (!panel || !listPanel) return;

  if (orderId) {
    const order = (state.orders || []).find(o => o.id === orderId);
    if (order) {
      deliveryModeState = inferDeliveryMode(order);
      executionReadinessState = order.readinessState || 'not_applicable';
      executionActsState = {
        notReady: order.executionActs?.notReady || null,
        ready: order.executionActs?.ready || null,
      };
      executionManualAdvanceState = {
        stage1: Number(order.paymentPlan?.manualAdvanceOffsets?.stage1) || 0,
        stage2: Number(order.paymentPlan?.manualAdvanceOffsets?.stage2) || 0,
      };
      const contract = order.contractId
        ? (state.contracts || []).find(c => c.id === order.contractId)
        : null;

      if (contract) {
        itemRows = buildImportItemRows(contract);

        if (deliveryModeState === 'warehouse') {
          syncWarehouseAddressRows(
            Number(order.warehouseId) || null,
            order.deliveryAddress || order.deliveryRows?.[0]?.address || ''
          );
        } else {
          addressRows = buildAddressRowsFromSavedDeliveryRows(order.deliveryRows || []);
          if (addressRows.length === 0) {
            ensureDirectAddressRows();
          }
          directAddressRowsDraft = cloneAddressRows(addressRows.filter(row => !row.warehouseId));
        }

        applySavedDeliveryRowsToOrderItems(order.deliveryRows || []);
      } else if (Array.isArray(order.deliveryRows) && order.deliveryRows.length > 0) {
        loadFromDeliveryRows(order.deliveryRows);
      } else if (Array.isArray(order.items) && order.items.length > 0) {
        // Migrate old format
        const flatRows = [];
        order.items.forEach(item => {
          const scheds = Array.isArray(item.deliverySchedules) ? item.deliverySchedules : [];
          if (scheds.length === 0) {
            flatRows.push({
              contractItemName: item.contractItemName || '—',
              contractItemCode: item.contractItemCode || '—',
              price: Number(item.price) || 0,
              qty: Number(item.qty) || 0,
              date: item.defaultDate || '',
              address: '',
              recipientName: '',
            });
          } else {
            scheds.forEach(sc => {
              flatRows.push({
                contractItemName: item.contractItemName || '—',
                contractItemCode: item.contractItemCode || '—',
                price: Number(sc.price) || Number(item.price) || 0,
                qty: Number(sc.qty) || 0,
                date: sc.date || '',
                address: '',
                recipientName: '',
              });
            });
          }
        });
        loadFromDeliveryRows(flatRows);
      }
      hydrateSchedulesFromSavedOrder(order);
      reconcileScheduleQtysWithDeliveryRows(order);

      if (deliveryModeState === 'warehouse' && order.warehouseId) {
        syncWarehouseAddressRows(order.warehouseId, addressRows[0]?.address || '');
        applySavedDeliveryRowsToOrderItems(order.deliveryRows || []);
      } else {
        directAddressRowsDraft = cloneAddressRows(addressRows.filter(row => !row.warehouseId));
      }
    }
  } else {
    deliveryModeState = 'direct';
    directAddressRowsDraft = [];
    deliverySchedules = [];
  }

  ensureDeliveryScheduleState();

  listPanel.classList.add('hidden');
  panel.classList.remove('hidden');
  _orderReadonly = readonly;
  renderOrderCard();
  if (readonly) setOrderCardReadonly(true);
}

function closeOrderCard() {
  const panel = $('orderCardPanel');
  const listPanel = $('ordersRegistryListPanel');
  if (!panel || !listPanel) return;
  panel.classList.add('hidden');
  listPanel.classList.remove('hidden');
}

function setOrderCardReadonly(readonly) {
  _orderReadonly = readonly;
  const panel = $('orderCardPanel');
  if (!panel) return;
  panel.querySelectorAll('input, select, textarea').forEach(inp => {
    inp.disabled = readonly;
    inp.style.opacity = readonly ? '0.7' : '';
    inp.style.cursor = readonly ? 'default' : '';
  });
  const saveBtn = $('orderCardSaveBtn');
  const exportBtn = $('orderExportBtn');
  const templateBtn = $('orderTemplateBtn');
  const importBtn = $('orderImportBtn');
  const editBtn = $('orderCardEditBtn');
  if (saveBtn) saveBtn.classList.toggle('hidden', readonly);
  if (exportBtn) exportBtn.classList.toggle('hidden', readonly);
  if (templateBtn) templateBtn.classList.toggle('hidden', readonly);
  if (importBtn) importBtn.classList.toggle('hidden', readonly);
  if (editBtn) editBtn.classList.toggle('hidden', !readonly);
  panel.querySelectorAll('.addr-del-btn, .addr-add-btn').forEach(b => {
    b.classList.toggle('hidden', readonly);
  });
  panel.querySelectorAll('.schedule-add-btn, .schedule-del-btn').forEach(b => {
    b.classList.toggle('hidden', readonly);
  });
}

// ─── Render order card ───────────────────────────────────────────

function renderOrderCard() {
  const wrap = $('orderCardBody');
  if (!wrap) return;
  clearChildren(wrap);

  const order = editingOrderId
    ? (state.orders || []).find(o => o.id === editingOrderId)
    : null;

  if (order && !deliveryModeState) {
    deliveryModeState = inferDeliveryMode(order);
  }

  const contracts = state.contracts || [];

  // ── Info section ──
  const infoSection = el('section', {});
  infoSection.appendChild(
    el('h3', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3' },
      t('orders.sectionInfo'))
  );

  const fields = el('div', { className: 'space-y-4' });

  // Contract
  const contractSel = el('select', {
    id: 'orderContractSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  contractSel.appendChild(el('option', { value: '' }, t('orders.selectContract')));
  contracts.forEach(c => {
    const supplierName = getSupplierName(c.supplierId);
    const contractLabel = supplierName && supplierName !== '—'
      ? `${getContractDisplay(c)} — ${supplierName}`
      : getContractDisplay(c);
    const opt = el('option', { value: String(c.id) }, contractLabel);
    if (order && order.contractId === c.id) opt.selected = true;
    contractSel.appendChild(opt);
  });

  // Program
  const programSel = el('select', {
    id: 'orderProgramSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });

  // Number display
  const numDisplay = el('div', {
    id: 'orderNumberDisplay',
    className: 'w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-bold text-cyan-400',
  }, order ? (order.orderNumber || '—') : t('orders.numberAutoHint'));

  const advanceAmountDisplay = el('div', {
    id: 'orderAdvanceAmountDisplay',
    className: 'w-full rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-2.5 text-sm font-bold text-amber-300',
  }, `${fmtMoney(order?.advanceAmount || 0)} ₽`);

  const advanceAmountHint = el('p', {
    id: 'orderAdvanceAmountHint',
    className: 'mt-1 text-[11px] text-slate-500',
  }, t('orders.advanceNotUsed'));

  const deliveryModeSel = el('select', {
    id: 'orderDeliveryModeSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  deliveryModeSel.appendChild(el('option', { value: 'warehouse' }, t('orders.deliveryModeWarehouse')));
  deliveryModeSel.appendChild(el('option', { value: 'direct' }, t('orders.deliveryModeDirect')));
  deliveryModeSel.value = deliveryModeState || inferDeliveryMode(order);

  const deliveryModeWarehouseBtn = el('button', {
    type: 'button',
    className: 'segmented-btn',
    'data-mode': 'warehouse',
  }, `🏭 ${t('orders.deliveryModeWarehouse')}`);

  const deliveryModeDirectBtn = el('button', {
    type: 'button',
    className: 'segmented-btn',
    'data-mode': 'direct',
  }, `🚚 ${t('orders.deliveryModeDirect')}`);

  const deliveryModeButtons = [deliveryModeWarehouseBtn, deliveryModeDirectBtn];
  const deliveryModeHint = el('p', {
    id: 'orderDeliveryModeHint',
    className: 'mt-2 text-[11px] text-slate-500',
  });

  const deliveryModeToggle = el('div', { className: 'segmented-toggle' },
    deliveryModeWarehouseBtn,
    deliveryModeDirectBtn,
  );

  const deliveryModeField = el('div', {});
  deliveryModeSel.classList.add('hidden');
  deliveryModeField.appendChild(deliveryModeSel);
  deliveryModeField.appendChild(deliveryModeToggle);
  deliveryModeField.appendChild(deliveryModeHint);

  // Warehouse selector
  const warehouseSel = el('select', {
    id: 'orderWarehouseSel',
    className: 'w-full rounded-xl border border-white/10 bg-white/5 px-4 py-2.5 text-sm text-slate-300 transition focus:border-cyan-400/50 focus:bg-white/[0.07]',
  });
  warehouseSel.appendChild(el('option', { value: '' }, t('orders.selectWarehouse')));
  (state.warehouses || []).forEach(wh => {
    const opt = el('option', { value: String(wh.id) }, wh.name + (wh.address ? ` — ${wh.address}` : ''));
    if (order?.warehouseId === wh.id) opt.selected = true;
    warehouseSel.appendChild(opt);
  });

  const warehouseField = wrapField(labelEl('orderWarehouseSel', t('orders.fieldWarehouse')), (() => {
    const w = el('div', {});
    w.appendChild(warehouseSel);
    w.appendChild(el('p', { id: 'orderWarehouseHint', className: 'mt-1 text-[11px] text-slate-500' }, t('orders.warehouseHint')));
    return w;
  })());

  function updateAdvancePreview(contractForAdvance = null) {
    const activeContract = contractForAdvance || contracts.find(c => c.id === Number(contractSel.value)) || null;
    if (!advanceAmountDisplay || !advanceAmountHint) return;

    const executionPlan = activeContract ? buildExecutionPlan(activeContract) : null;
    const snapshot = getOrderAdvanceSnapshot(activeContract, executionPlan);
    advanceAmountDisplay.textContent = `${fmtMoney(snapshot.amount)} ₽`;
    advanceAmountHint.textContent = snapshot.percent > 0
      ? t('orders.advanceIncluded', { percent: snapshot.percent })
      : t('orders.advanceNotUsed');
    advanceAmountDisplay.className = snapshot.percent > 0
      ? 'w-full rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-2.5 text-sm font-bold text-amber-300'
      : 'w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-bold text-slate-300';
  }

  fields.appendChild(wrapField(labelEl('orderContractSel', t('orders.fieldContract')), contractSel));
  fields.appendChild(wrapField(labelEl('orderProgramSel', t('orders.fieldProgram')), programSel));
  fields.appendChild(wrapField(labelEl('orderNumberDisplay', t('orders.fieldNumber')), numDisplay));
  fields.appendChild(wrapField(labelEl('orderAdvanceAmountDisplay', t('orders.fieldAdvanceAmount')), (() => {
    const box = el('div', {});
    box.appendChild(advanceAmountDisplay);
    box.appendChild(advanceAmountHint);
    return box;
  })()));
  fields.appendChild(wrapField(labelEl('orderDeliveryModeSel', t('orders.fieldDeliveryMode')), deliveryModeField));
  fields.appendChild(warehouseField);

  const executionSection = el('div', { className: 'rounded-2xl border border-white/10 bg-white/[0.04] p-4 space-y-3' });
  const updateExecutionSection = (contractForExecution) => {
    clearChildren(executionSection);
    executionSection.appendChild(el('div', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400' }, 'Исполнение и оплата'));

    if (!contractForExecution) {
      executionSection.appendChild(el('p', { className: 'text-xs text-slate-500' }, 'Выберите контракт, чтобы увидеть схему исполнения и оплаты по заявке.'));
      updateAdvancePreview(null);
      return;
    }

    const plan = buildExecutionPlan(contractForExecution);
    const scenario = plan.scenario;
    updateAdvancePreview(contractForExecution);
    const readinessOptions = [
      { value: 'not_applicable', label: 'Не используется' },
      { value: 'ready', label: 'Место готово' },
      { value: 'not_ready', label: 'Место не готово' },
    ];

    const topGrid = el('div', { className: 'grid gap-3 lg:grid-cols-2' });
    topGrid.appendChild(el('div', { className: 'rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3' },
      el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-1' }, 'Маршрут заявки'),
      el('div', { className: 'text-sm font-semibold text-white' }, deliveryModeState === 'warehouse' ? 'На склад' : 'Сразу получателю'),
      el('div', { className: 'mt-1 text-xs text-slate-500' }, buildExecutionScenarioDescription(plan)),
    ));

    const readinessCard = el('div', { className: 'rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3 space-y-2' });
    readinessCard.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-500' }, 'Готовность места эксплуатации'));
    const readinessSelect = el('select', {
      className: 'w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50',
    });
    readinessSelect.disabled = !plan.policy.usesReadiness;
    readinessOptions.forEach((option) => {
      const opt = el('option', { value: option.value }, option.label);
      if (executionReadinessState === option.value) opt.selected = true;
      readinessSelect.appendChild(opt);
    });
    readinessSelect.addEventListener('change', () => {
      executionReadinessState = readinessSelect.value || 'not_applicable';
      updateExecutionSection(contractForExecution);
    });
    readinessCard.appendChild(readinessSelect);
    readinessCard.appendChild(el('p', { className: 'text-xs text-slate-500' }, getExecutionReadinessLabel(executionReadinessState)));
    topGrid.appendChild(readinessCard);
    executionSection.appendChild(topGrid);

    const scenarioBox = el('div', { className: 'rounded-xl border border-cyan-400/15 bg-cyan-400/[0.05] px-4 py-3 space-y-3' });
    scenarioBox.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-cyan-300' }, 'Расчёт по сценарию'));
    scenarioBox.appendChild(el('div', { className: 'text-sm font-semibold text-white' }, scenario.scenarioType === 'split' ? 'Этапная схема оплаты' : 'Полный расчёт одной оплатой'));
    scenarioBox.appendChild(el('div', { className: 'text-xs text-slate-300' }, `Рекомендуемый маршрут по контракту: ${EXECUTION_ROUTE_LABELS[scenario.recommendedRoute] || 'определяет пользователь'}`));
    scenarioBox.appendChild(el('div', { className: 'text-xs text-slate-300' }, `Сумма заявки: ${fmtMoney(plan.total)} ₽`));

    if (plan.policy.hasAdvance && plan.policy.advancePercent > 0) {
      scenarioBox.appendChild(el('div', { className: 'text-xs text-amber-300' }, `По контракту предусмотрен аванс ${plan.policy.advancePercent}% (${fmtMoney(plan.advanceAmount)} ₽). Режим зачёта: ${ADVANCE_OFFSET_MODE_LABELS[plan.advanceOffsetMode] || ADVANCE_OFFSET_MODE_LABELS.sequential}.`));
    }

    const accountingRows = buildExecutionAccountingRows(plan);
    const accountingWrap = el('div', { className: 'rounded-xl border border-white/10 bg-slate-950/35 px-3 py-3 space-y-2' });
    accountingWrap.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-400' }, tOrder('paymentLedgerTitle')));
    accountingWrap.appendChild(el('div', { className: 'text-xs text-slate-500' }, tOrder('paymentLedgerHint')));

    const accountingScroll = el('div', { className: 'overflow-x-auto rounded-xl border border-white/10' });
    const accountingTable = el('table', { className: 'min-w-full text-xs border-collapse' });
    accountingTable.innerHTML = `
      <thead>
        <tr class="bg-white/[0.04] border-b border-white/10 text-slate-400 uppercase tracking-wider">
          <th class="px-3 py-2 text-left font-semibold whitespace-nowrap">${tOrder('paymentLedgerColStage')}</th>
          <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">${tOrder('paymentLedgerColPercent')}</th>
          <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">${tOrder('paymentLedgerColAccrued')}</th>
          <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">${tOrder('paymentLedgerColAdvanceOffset')}</th>
          <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">${tOrder('paymentLedgerColPayable')}</th>
          <th class="px-3 py-2 text-right font-semibold whitespace-nowrap">${tOrder('paymentLedgerColAdvanceRemainder')}</th>
        </tr>
      </thead>
      <tbody>
        ${accountingRows.map((row) => `
          <tr class="border-b border-white/5 text-slate-200">
            <td class="px-3 py-2 whitespace-nowrap">${row.label}</td>
            <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">${row.percent}%</td>
            <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">${fmtMoney(row.accrued)} ₽</td>
            <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap text-amber-300">${fmtMoney(row.advanceOffset)} ₽</td>
            <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap text-emerald-300 font-semibold">${fmtMoney(row.payable)} ₽</td>
            <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">${fmtMoney(row.advanceRemainder)} ₽</td>
          </tr>
        `).join('')}
      </tbody>
      <tfoot>
        <tr class="bg-white/[0.04] border-t border-white/10 text-white">
          <td class="px-3 py-2 font-semibold whitespace-nowrap">${tOrder('paymentLedgerTotal')}</td>
          <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">100%</td>
          <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">${fmtMoney(plan.stage1Amount + plan.stage2Amount)} ₽</td>
          <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap text-amber-300">${fmtMoney(plan.allocatedAdvance)} ₽</td>
          <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap text-emerald-300 font-semibold">${fmtMoney(plan.stage1Payable + plan.stage2Payable)} ₽</td>
          <td class="px-3 py-2 text-right tabular-nums whitespace-nowrap">${fmtMoney(plan.unallocatedAdvance)} ₽</td>
        </tr>
      </tfoot>`;
    accountingScroll.appendChild(accountingTable);
    accountingWrap.appendChild(accountingScroll);
    scenarioBox.appendChild(accountingWrap);

    const stagesWrap = el('div', { className: 'grid gap-3 lg:grid-cols-2' });
    const stageCards = [
      {
        title: scenario.scenarioType === 'split' ? `Этап 1 · ${scenario.stage1Percent}%` : 'Оплата по заявке',
        amount: plan.stage1Amount,
        offset: plan.stage1Offset,
        payable: plan.stage1Payable,
        field: 'stage1',
      },
    ];
    if (scenario.scenarioType === 'split') {
      stageCards.push({
        title: `Этап 2 · ${scenario.stage2Percent}%`,
        amount: plan.stage2Amount,
        offset: plan.stage2Offset,
        payable: plan.stage2Payable,
        field: 'stage2',
      });
    }

    stageCards.forEach((stageCard) => {
      const card = el('div', { className: 'rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3 space-y-1.5' });
      card.appendChild(el('div', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400' }, stageCard.title));
      card.appendChild(el('div', { className: 'text-xs text-slate-300' }, `Начисление: ${fmtMoney(stageCard.amount)} ₽`));
      card.appendChild(el('div', { className: 'text-xs text-amber-300' }, `Зачёт аванса: ${fmtMoney(stageCard.offset)} ₽`));
      card.appendChild(el('div', { className: 'text-sm font-semibold text-emerald-300' }, `К оплате: ${fmtMoney(stageCard.payable)} ₽`));

      if (plan.advanceOffsetMode === 'manual' && plan.advanceAmount > 0) {
        const input = el('input', {
          type: 'number',
          min: '0',
          step: '0.01',
          value: String(executionManualAdvanceState[stageCard.field] || 0),
          className: 'mt-2 w-full rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-sm text-white transition focus:border-cyan-400/50',
          'aria-label': `Ручной зачёт аванса: ${stageCard.title}`,
        });
        input.addEventListener('change', () => {
          executionManualAdvanceState = {
            ...executionManualAdvanceState,
            [stageCard.field]: Math.max(0, Number(input.value) || 0),
          };
          updateExecutionSection(contractForExecution);
        });
        card.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-500 mt-2' }, 'Ручной зачёт для этапа'));
        card.appendChild(input);
      }

      stagesWrap.appendChild(card);
    });

    scenarioBox.appendChild(stagesWrap);

    if (plan.policy.hasAdvance && plan.policy.advancePercent > 0) {
      scenarioBox.appendChild(el('div', {
        className: plan.unallocatedAdvance > 0.01 ? 'text-xs text-amber-200' : 'text-xs text-slate-300',
      }, `Зачтено аванса: ${fmtMoney(plan.allocatedAdvance)} ₽${plan.unallocatedAdvance > 0.01 ? ` · Осталось распределить: ${fmtMoney(plan.unallocatedAdvance)} ₽` : ''}`));
    }

    executionSection.appendChild(scenarioBox);

    const reminders = buildExecutionReminderList(plan);
    if (reminders.length) {
      const reminderBox = el('div', { className: 'rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-4 py-3' });
      reminderBox.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-amber-300 mb-2' }, 'Напоминания'));
      const list = el('ul', { className: 'space-y-1 text-xs text-amber-200 list-disc pl-4' });
      reminders.forEach(line => list.appendChild(el('li', {}, line)));
      reminderBox.appendChild(list);
      executionSection.appendChild(reminderBox);
    }

    if (plan.policy.usesReadiness) {
      const actsBox = el('div', { className: 'rounded-xl border border-white/10 bg-slate-950/35 px-4 py-3 space-y-3' });
      actsBox.appendChild(el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-500' }, 'Акты готовности / неготовности'));
      const actions = el('div', { className: 'flex flex-wrap gap-2' });
      const contractNumber = contractForExecution?.number || '—';
      const orderNumber = numDisplay.textContent || '—';
      const programName = programSel?.selectedOptions?.[0]?.textContent?.trim() || programSel?.value || '—';

      const notReadyBtn = el('button', {
        type: 'button',
        className: 'inline-flex items-center gap-2 rounded-xl border border-amber-400/30 bg-amber-400/[0.08] px-3 py-2 text-xs font-semibold text-amber-300 transition hover:bg-amber-400/[0.15]',
      }, '📄 Акт неготовности');
      notReadyBtn.addEventListener('click', async () => {
        executionActsState.notReady = {
          createdAt: new Date().toISOString(),
          contractNumber,
          orderNumber,
          readinessState: 'not_ready',
        };
        await downloadExecutionAct('notReady', contractForExecution, orderNumber, programName);
        showToast('Акт неготовности сформирован', 'success');
        updateExecutionSection(contractForExecution);
      });
      actions.appendChild(notReadyBtn);

      const readyBtn = el('button', {
        type: 'button',
        className: 'inline-flex items-center gap-2 rounded-xl border border-emerald-400/30 bg-emerald-400/[0.08] px-3 py-2 text-xs font-semibold text-emerald-300 transition hover:bg-emerald-400/[0.15]',
      }, '📄 Акт готовности');
      readyBtn.addEventListener('click', async () => {
        executionActsState.ready = {
          createdAt: new Date().toISOString(),
          contractNumber,
          orderNumber,
          readinessState: 'ready',
        };
        await downloadExecutionAct('ready', contractForExecution, orderNumber, programName);
        showToast('Акт готовности сформирован', 'success');
        updateExecutionSection(contractForExecution);
      });
      actions.appendChild(readyBtn);
      actsBox.appendChild(actions);

      const statusLines = el('div', { className: 'space-y-1 text-xs text-slate-400' });
      statusLines.appendChild(el('div', {}, executionActsState.notReady
        ? `Акт неготовности: сформирован ${new Date(executionActsState.notReady.createdAt).toLocaleString('ru-RU')}`
        : 'Акт неготовности: ещё не сформирован'));
      statusLines.appendChild(el('div', {}, executionActsState.ready
        ? `Акт готовности: сформирован ${new Date(executionActsState.ready.createdAt).toLocaleString('ru-RU')}`
        : 'Акт готовности: ещё не сформирован'));
      actsBox.appendChild(statusLines);
      executionSection.appendChild(actsBox);
    }
  };

  fields.appendChild(executionSection);

  // ── Sent status ──
  const sentWrap = el('div', { className: 'flex items-center justify-between rounded-xl border border-white/10 bg-white/5 px-4 py-3' });
  const sentLeft = el('div', { className: 'flex items-center gap-3' });
  const sentCheckbox = el('input', { type: 'checkbox', id: 'orderSentCheck', className: 'w-4 h-4 rounded accent-cyan-400 cursor-pointer' });
  if (order?.sent) sentCheckbox.checked = true;
  const sentLabel = el('label', { 'for': 'orderSentCheck', className: 'text-sm font-medium text-slate-300 cursor-pointer select-none' }, t('orders.sentLabel'));
  sentLeft.append(sentCheckbox, sentLabel);
  const sentDateInput = el('input', {
    type: 'date', id: 'orderSentDate',
    className: 'rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-white focus:border-cyan-400/50 focus:outline-none',
    'aria-label': t('orders.sentDate'),
  });
  sentDateInput.value = order?.sentDate || '';
  sentDateInput.style.display = order?.sent ? '' : 'none';
  sentCheckbox.addEventListener('change', () => {
    sentDateInput.style.display = sentCheckbox.checked ? '' : 'none';
    if (sentCheckbox.checked && !sentDateInput.value)
      sentDateInput.value = new Date().toISOString().slice(0, 10);
  });
  sentWrap.appendChild(sentLeft);
  sentWrap.appendChild(sentDateInput);

  const sentSection = el('div', { className: 'space-y-2' });
  sentSection.appendChild(sentWrap);

  const contractForEmail = order?.contractId
    ? (state.contracts || []).find(c => c.id === order.contractId)
    : null;
  const supplierForEmail = contractForEmail?.supplierId
    ? (state.suppliers || []).find(s => s.id === contractForEmail.supplierId)
    : null;
  if (supplierForEmail?.email) {
    const emailBtn = el('button', {
      type: 'button',
      className: 'w-full inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-400/25 bg-emerald-400/[0.06] px-4 py-2.5 text-sm font-semibold text-emerald-400 transition hover:bg-emerald-400/15',
    }, `✉ ${t('orders.sendEmail')} (${supplierForEmail.email})`);
    emailBtn.addEventListener('click', () => {
      if (order) {
        sendOrderByEmail(order, contractForEmail, supplierForEmail);
        sentCheckbox.checked = true;
        sentDateInput.style.display = '';
        if (!sentDateInput.value) sentDateInput.value = new Date().toISOString().slice(0, 10);
      } else {
        showToast(t('orders.saveFirst'), 'info');
      }
    });
    sentSection.appendChild(emailBtn);
  }

  fields.appendChild(el('div', {}, ...(() => {
    const lbl = el('label', { className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400' }, t('orders.sentStatus'));
    return [lbl, sentSection];
  })()));

  infoSection.appendChild(fields);
  wrap.appendChild(infoSection);

  // ── Validation warnings ──
  const validationWarningsWrap = el('div', { id: 'orderValidationWarnings', className: 'mt-4' });
  validationWarningsWrap.style.minHeight = '132px';
  validationWarningsWrap.style.transition = 'opacity 0.16s ease';
  wrap.appendChild(validationWarningsWrap);

  // ── Program helpers ──
  function refreshProgramOptions() {
    clearChildren(programSel);
    const contractId = Number(contractSel.value) || null;
    const contract = contractId ? contracts.find(c => c.id === contractId) : null;
    const contractProgNames = (contract?.programs || []).map(p =>
      typeof p === 'string' ? p : (p.name || p.code || '')
    ).filter(Boolean);
    const globalProgs = (state.programs || []).filter(p =>
      contractProgNames.includes(p.name) || contractProgNames.includes(p.code)
    );
    const missingProgs = contractProgNames.filter(name =>
      !globalProgs.some(p => p.name === name || p.code === name)
    );
    if (!contract) {
      programSel.appendChild(el('option', { value: '' }, t('orders.selectContractFirstOption')));
    } else if (globalProgs.length === 0 && missingProgs.length === 0) {
      programSel.appendChild(el('option', { value: '' }, t('orders.noProgramsInContract')));
    } else {
      const allProgs = [
        ...globalProgs.map(p => ({ value: p.code || p.name, label: formatProgramLabel(p) || p.name || p.code || '' })),
        ...missingProgs.map(name => ({ value: name, label: formatProgramLabel(name) || name })),
      ];
      allProgs.forEach(prog => {
        const opt = el('option', { value: prog.value }, prog.label);
        if (order && getOrderProgramValue(order) === prog.value) opt.selected = true;
        programSel.appendChild(opt);
      });
      if (!getOrderProgramValue(order) && allProgs.length === 1) programSel.value = allProgs[0].value;
    }
  }

  function refreshOrderNumber() {
    const contractId = contractSel.value;
    const c = contracts.find(x => x.id === Number(contractId));
    const programCode = programSel.value;
    if (!c) { numDisplay.textContent = t('orders.numberAutoHint'); return; }
    if (editingOrderId !== null) {
      const existingOrder = (state.orders || []).find(o => o.id === editingOrderId);
      if (existingOrder) {
        const programChanged = getOrderProgramValue(existingOrder) !== programCode;
        if (!programChanged && existingOrder.orderNumber) {
          numDisplay.textContent = existingOrder.orderNumber;
        } else if (existingOrder.orderNumber && programChanged) {
          const seq = existingOrder.seqNum || 1;
          numDisplay.textContent = generateOrderNumber(c, seq, programCode);
        } else {
          const seq = getNextOrderSeq(c.id);
          numDisplay.textContent = generateOrderNumber(c, seq, programCode);
        }
        return;
      }
    }
    const seq = getNextOrderSeq(c.id);
    numDisplay.textContent = generateOrderNumber(c, seq, programCode);
  }

  function refreshDeliveryModeUi() {
    const isWarehouse = deliveryModeState === 'warehouse';
    warehouseField.classList.toggle('hidden', !isWarehouse);
    const warehouseHint = document.getElementById('orderWarehouseHint');
    if (warehouseHint) warehouseHint.textContent = t('orders.warehouseHint');
    if (deliveryModeHint) {
      deliveryModeHint.textContent = isWarehouse ? t('orders.warehouseHint') : t('orders.directHint');
    }
    deliveryModeButtons.forEach(btn => {
      const active = btn.dataset.mode === deliveryModeState;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function rerenderDeliverySections() {
    const selectedContract = contracts.find(x => x.id === Number(contractSel.value)) || null;
    refreshDeliveryModeUi();
    renderAddressesSection(addrSection, selectedContract, deliveryModeState, warehouseSel);
    renderItemsSection(itemsWrap, selectedContract);
    updateExecutionSection(selectedContract);
    updateAdvancePreview(selectedContract);
    validateCurrentOrder();
  }

  contractSel.addEventListener('change', () => {
    const contractId = Number(contractSel.value);
    const c = contracts.find(x => x.id === contractId);
    executionActsState = { notReady: null, ready: null };
    executionManualAdvanceState = { stage1: 0, stage2: 0 };
    if (!c || !getContractExecutionPolicy(c).usesReadiness) {
      executionReadinessState = 'not_applicable';
    }
    // Reset only contract items; delivery targets remain selected for the chosen mode.
    itemRows = c ? buildOrderItemRowsFromContract(c) : [];
    deliverySchedules = [{ id: makeScheduleId(), date: '' }];
    syncScheduleQtyMaps();
    refreshProgramOptions();
    refreshOrderNumber();
    rerenderDeliverySections();
  });

  programSel.addEventListener('change', () => {
    refreshOrderNumber();
    rerenderDeliverySections();
  });

  deliveryModeSel.addEventListener('change', () => {
    const prevMode = deliveryModeState;
    deliveryModeState = deliveryModeSel.value || 'direct';

    if (prevMode === 'direct') {
      directAddressRowsDraft = cloneAddressRows(addressRows.filter(row => !row.warehouseId));
    }

    if (deliveryModeState === 'warehouse') {
      syncWarehouseAddressRows(Number(warehouseSel.value) || null, addressRows[0]?.address || '');
    } else {
      ensureDirectAddressRows();
    }

    rerenderDeliverySections();
  });

  deliveryModeButtons.forEach(btn => {
    btn.addEventListener('click', () => {
      if (deliveryModeSel.value === btn.dataset.mode) return;
      deliveryModeSel.value = btn.dataset.mode;
      deliveryModeSel.dispatchEvent(new Event('change'));
    });
  });

  warehouseSel.addEventListener('change', () => {
    if (deliveryModeState === 'warehouse') {
      syncWarehouseAddressRows(Number(warehouseSel.value) || null, addressRows[0]?.address || '');
      rerenderDeliverySections();
    }
  });

  refreshProgramOptions();
  if (order?.contractId) contractSel.value = String(order.contractId);
  refreshProgramOptions();
  if (order && getOrderProgramValue(order)) programSel.value = getOrderProgramValue(order);
  refreshOrderNumber();
  refreshDeliveryModeUi();

  const currentContract = order?.contractId
    ? contracts.find(c => String(c.id) === String(order.contractId))
    : null;

  if (deliveryModeState === 'warehouse') {
    if (order?.warehouseId) warehouseSel.value = String(order.warehouseId);
    syncWarehouseAddressRows(Number(warehouseSel.value) || null, addressRows[0]?.address || '');
  } else {
    ensureDirectAddressRows();
  }

  // ── Addresses section ──
  const addrSection = el('section', { id: 'orderAddrSection', className: 'mt-6' });
  wrap.appendChild(addrSection);

  // ── Items section ──
  const itemsWrap = el('div', { id: 'orderItemsWrap' });
  const itemsSection = el('section', { className: 'mt-6' });
  itemsSection.appendChild(
    el('h3', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400 mb-3' },
      t('orders.sectionItems'))
  );
  itemsSection.appendChild(itemsWrap);
  wrap.appendChild(itemsSection);

  updateExecutionSection(currentContract);
  updateAdvancePreview(currentContract);
  renderAddressesSection(addrSection, currentContract, deliveryModeState, warehouseSel);
  renderItemsSection(itemsWrap, currentContract);
  validateCurrentOrder();
}

function labelEl(forId, text) {
  return el('label', { 'for': forId, className: 'mb-1.5 block text-xs font-semibold uppercase tracking-wider text-slate-400' }, text);
}
function wrapField(label, input) {
  const div = el('div', {});
  div.appendChild(label);
  div.appendChild(input);
  return div;
}

// ─── Addresses section ───────────────────────────────────────────

function renderAddressesSection(container, contract, deliveryMode = 'direct', warehouseSel = null) {
  clearChildren(container);

  const isWarehouse = deliveryMode === 'warehouse';
  const currentOrderProgramName = getCurrentOrderProgramName();
  const currentOrderProgramLabel = formatProgramValueLabel(currentOrderProgramName);
  const availableRecipients = currentOrderProgramName
    ? (state.recipients || []).filter(recipient => isRecipientAllowedForProgram(recipient, currentOrderProgramName))
    : (state.recipients || []);
  const header = el('div', { className: 'flex items-center justify-between mb-3 gap-3' });
  header.appendChild(el('h3', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400' },
    isWarehouse ? t('orders.warehouseAddressLabel') : t('orders.addressesTitle')));

  if (!isWarehouse) {
    const addBtn = el('button', {
      type: 'button',
      className: 'addr-add-btn inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-400/15 transition',
      'aria-label': t('orders.addAddress'),
    }, `＋ ${t('orders.addAddress')}`);
    addBtn.addEventListener('click', () => {
      addressRows.push({ id: makeAddrId(), address: '', recipientName: '', recipientId: null, warehouseId: null });
      renderAddressesSection(container, contract, deliveryMode, warehouseSel);
      renderItemsSection($('orderItemsWrap'), contract);
    });
    header.appendChild(addBtn);
  }

  container.appendChild(header);

  const hintText = isWarehouse ? t('orders.warehouseHint') : t('orders.directHint');
  container.appendChild(el('p', { className: 'mb-3 text-xs text-slate-500' }, hintText));

  if (!isWarehouse && currentOrderProgramName) {
    container.appendChild(el('p', { className: 'mb-3 text-[11px] text-cyan-300' },
      t('orders.recipientProgramHint', { program: currentOrderProgramLabel || currentOrderProgramName })));
    if (availableRecipients.length === 0) {
      container.appendChild(el('div', {
        className: 'rounded-xl border border-amber-400/20 bg-amber-400/5 p-4 text-xs text-amber-300',
      }, t('orders.noRecipientsForProgram', { program: currentOrderProgramLabel || currentOrderProgramName })));
    }
  }

  if (isWarehouse) {
    const warehouseId = warehouseSel?.value ? Number(warehouseSel.value) : null;
    const warehouse = (state.warehouses || []).find(wh => wh.id === warehouseId) || null;

    if (!warehouse) {
      container.appendChild(el('div', {
        className: 'rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-500',
      }, `🏭 ${t('orders.chooseWarehouseFirst')}`));
      return;
    }

    const options = getWarehouseAddressOptions(warehouse);
    if (addressRows.length === 0) {
      syncWarehouseAddressRows(warehouse.id, '');
    }
    const rowData = addressRows[0] || { id: makeAddrId(), address: '', recipientName: warehouse.name || '', recipientId: null };
    rowData.recipientName = warehouse.name || '';
    rowData.warehouseId = warehouse.id;
    addressRows = [rowData];

    const row = el('div', { className: 'rounded-xl border border-white/10 bg-white/5 p-4 space-y-3 order-delivery-card' });
    row.appendChild(el('div', { className: 'text-sm font-semibold text-white' }, warehouse.name || t('orders.fieldWarehouse')));

    if (options.length <= 1) {
      rowData.address = options[0] || warehouse.address || '';
      row.appendChild(el('div', {
        className: 'rounded-lg border border-white/10 bg-slate-900/40 px-3 py-2 text-sm text-slate-200',
      }, rowData.address || t('orders.noWarehouseAddress')));
    } else {
      const addrSelect = el('select', {
        className: 'w-full rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none',
        'aria-label': t('orders.warehouseAddressLabel'),
      });
      addrSelect.appendChild(el('option', { value: '' }, t('orders.selectWarehouseAddress')));
      options.forEach(option => {
        const opt = el('option', { value: option }, option);
        if (rowData.address === option) opt.selected = true;
        addrSelect.appendChild(opt);
      });
      addrSelect.addEventListener('change', () => {
        rowData.address = addrSelect.value;
        renderItemsSection($('orderItemsWrap'), contract);
      });
      if (!rowData.address && options[0]) {
        rowData.address = options[0];
        addrSelect.value = options[0];
      }
      row.appendChild(addrSelect);
    }

    container.appendChild(row);
    return;
  }

  if (addressRows.length === 0) {
    container.appendChild(
      el('div', { className: 'rounded-xl border border-dashed border-white/10 p-4 text-center text-xs text-slate-500' },
        `📍 ${t('orders.addressesHint')}`
      )
    );
    return;
  }

  const list = el('div', { className: 'space-y-2 overflow-y-auto pr-1' });
  list.style.maxHeight = '34vh';

  addressRows.forEach((addr, idx) => {
    const currentRecipient = findRecipientForAddressRow(addr);
    if (currentRecipient && !isRecipientAllowedForProgram(currentRecipient, currentOrderProgramName)) {
      addr.recipientId = null;
      addr.recipientName = '';
      addr.address = '';
    }

    if (!addr.recipientId && addr.recipientName) {
      const resolvedRecipient = (state.recipients || []).find(r =>
        String(r.name || '').trim().toLowerCase() === String(addr.recipientName || '').trim().toLowerCase()
      );
      if (resolvedRecipient) addr.recipientId = resolvedRecipient.id;
    }

    const row = el('div', { className: 'order-delivery-card' });
    const rowPreview = el('div', { className: 'text-[11px] text-slate-500 truncate' },
      addr.recipientName
        ? `${addr.recipientName}${addr.address ? ` — ${addr.address}` : ''}`
        : t('orders.addressPlaceholder'));

    const rowTop = el('div', { className: 'flex items-center justify-between gap-3 mb-3' });
    rowTop.appendChild(el('div', { className: 'flex items-center gap-2 min-w-0' },
      el('span', { className: 'inline-flex h-7 min-w-7 items-center justify-center rounded-full bg-cyan-400/10 px-2 text-[11px] font-bold text-cyan-300' }, String(idx + 1)),
      el('div', { className: 'min-w-0' },
        el('div', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400' }, t('orders.recipientNameLabel')),
        rowPreview,
      ),
    ));

    const recipientSel = el('select', {
      className: 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none',
      'aria-label': t('orders.recipientNameLabel'),
    });
    recipientSel.appendChild(el('option', { value: '' }, t('orders.chooseRecipient')));
    availableRecipients.forEach(recipient => {
      const opt = el('option', { value: String(recipient.id) }, recipient.name || '—');
      if (String(addr.recipientId ?? '') === String(recipient.id)) opt.selected = true;
      recipientSel.appendChild(opt);
    });

    const addressSel = el('select', {
      className: 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none',
      'aria-label': t('orders.addressLabel'),
    });

    const fieldsGrid = el('div', { className: 'order-delivery-grid' });
    const recipientField = el('div', { className: 'space-y-1.5' },
      el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-400' }, t('orders.recipientNameLabel')),
      recipientSel,
    );
    const addressField = el('div', { className: 'space-y-1.5' },
      el('div', { className: 'text-[11px] font-semibold uppercase tracking-wider text-slate-400' }, t('orders.addressLabel')),
      addressSel,
    );
    const addressOptionsHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 whitespace-normal' }, '');
    addressField.appendChild(addressOptionsHint);

    const refreshRecipientAddresses = () => {
      clearChildren(addressSel);
      const recipient = availableRecipients.find(r => String(r.id) === String(recipientSel.value)) || null;
      const options = getContractRelevantRecipientAddresses(contract, recipient);
      addressSel.appendChild(el('option', { value: '' }, options.length ? t('orders.chooseRecipientAddress') : t('orders.noRecipientAddresses')));
      options.forEach(option => {
        const opt = el('option', { value: option }, option);
        if (addr.address === option) opt.selected = true;
        addressSel.appendChild(opt);
      });
      if (!options.includes(addr.address)) {
        addr.address = options[0] || '';
      }
      addressSel.value = addr.address || '';
      rowPreview.textContent = addr.recipientName
        ? `${addr.recipientName}${addr.address ? ` — ${addr.address}` : ''}`
        : t('orders.addressPlaceholder');
      addressOptionsHint.textContent = recipient && options.length > 1
        ? `${t('orders.addressLabel')}: ${options.join(' • ')}`
        : '';
    };

    recipientSel.addEventListener('change', () => {
      const recipient = availableRecipients.find(r => String(r.id) === String(recipientSel.value)) || null;
      addr.recipientId = recipient ? recipient.id : null;
      addr.recipientName = recipient?.name || '';
      refreshRecipientAddresses();
      renderItemsSection($('orderItemsWrap'), contract);
    });

    addressSel.addEventListener('change', () => {
      addr.address = addressSel.value || '';
      rowPreview.textContent = addr.recipientName
        ? `${addr.recipientName}${addr.address ? ` — ${addr.address}` : ''}`
        : t('orders.addressPlaceholder');
      renderItemsSection($('orderItemsWrap'), contract);
    });

    refreshRecipientAddresses();

    const delBtn = el('button', {
      type: 'button',
      className: 'addr-del-btn rounded-lg p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition h-11 w-11 justify-self-end',
      'aria-label': t('orders.removeAddress'),
      title: t('orders.removeAddress'),
    }, '✕');
    delBtn.addEventListener('click', () => {
      const i = addressRows.findIndex(a => a.id === addr.id);
      if (i !== -1) addressRows.splice(i, 1);
      directAddressRowsDraft = cloneAddressRows(addressRows.filter(row => !row.warehouseId));
      renderAddressesSection(container, contract, deliveryMode, warehouseSel);
      renderItemsSection($('orderItemsWrap'), contract);
    });

    rowTop.appendChild(delBtn);
    fieldsGrid.append(recipientField, addressField);
    row.append(rowTop, fieldsGrid);
    list.appendChild(row);
  });

  container.appendChild(list);
}

// ─── Items section ───────────────────────────────────────────────

function renderItemsSection(wrap, contract) {
  clearChildren(wrap);
  ensureDeliveryScheduleState();
  if (deliveryModeState === 'direct') {
    syncDirectTotalsFromMatrix();
  }

  const currentOrderProgramName = getCurrentOrderProgramName();
  const summaryRefreshByItemId = new Map();
  const scheduleTotalEls = new Map();
  const isDirect = deliveryModeState === 'direct';

  if (!contract) {
    wrap.appendChild(el('p', { className: 'text-sm text-slate-500 py-4' }, t('orders.selectContractFirst')));
    return;
  }

  if (itemRows.length === 0) {
    wrap.appendChild(el('div', { className: 'rounded-xl border border-amber-400/20 bg-amber-400/5 p-4' },
      el('p', { className: 'text-sm text-amber-400' }, '⚠️ ' + t('orders.noApprovedItems')),
      el('p', { className: 'text-xs text-slate-500 mt-1' }, t('orders.noApprovedItemsHint')),
    ));
    return;
  }

  if (addressRows.length === 0) {
    wrap.appendChild(el('p', { className: 'text-xs text-slate-500 py-2 italic' },
      deliveryModeState === 'warehouse'
        ? t('orders.chooseWarehouseFirst')
        : t('orders.addressesFirstHint')));
    if (!isDirect) return;
  }

  if (isDirect) {
    const autofillPanel = el('div', { className: 'mb-4 rounded-xl border border-cyan-400/20 bg-cyan-400/[0.05] p-4' });
    const autofillRow = el('div', { className: 'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between' });
    const autofillInfo = el('div', { className: 'min-w-0' },
      el('div', { className: 'text-sm font-semibold text-cyan-200' }, tOrder('directMatrixAutofillButton')),
      el('div', { className: 'mt-1 text-xs text-slate-300' }, tOrder('directMatrixAutofillHint')),
    );
    const autofillBtn = el('button', {
      type: 'button',
      className: 'inline-flex items-center justify-center gap-2 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.1] px-4 py-2.5 text-sm font-semibold text-cyan-300 transition hover:bg-cyan-400/[0.18]',
    }, '⚡ ' + tOrder('directMatrixAutofillButton'));
    autofillBtn.addEventListener('click', () => {
      if (hasDirectOrderMatrixData() && !window.confirm(tOrder('directMatrixAutofillConfirm'))) {
        return;
      }
      const result = autofillDirectOrderMatrixByRemainingNeed();
      if (!result.ok) {
        showToast(result.reason === 'no-recipients'
          ? tOrder('directMatrixAutofillNoRecipients')
          : tOrder('directMatrixAutofillNoData'), 'warning', 5000);
        return;
      }
      renderAddressesSection($('orderAddrSection'), contract, deliveryModeState, $('orderWarehouseSel'));
      renderItemsSection(wrap, contract);
      requestValidationRefresh();
      showToast(tOrder('directMatrixAutofillDone', {
        recipients: result.recipients,
        rows: result.rows,
        qty: result.qty,
      }), 'success', 5000);
    });
    autofillRow.append(autofillInfo, autofillBtn);
    autofillPanel.appendChild(autofillRow);
    wrap.appendChild(autofillPanel);
  }

  const schedulesPanel = el('div', { className: 'mb-4 rounded-xl border border-white/10 bg-white/[0.04] p-4 space-y-3' });
  const schedulesHeader = el('div', { className: 'flex items-center justify-between gap-3' });
  schedulesHeader.appendChild(el('div', { className: 'text-xs font-semibold uppercase tracking-wider text-slate-400' }, t('orders.deliverySchedulesTitle')));
  const addScheduleBtn = el('button', {
    type: 'button',
    className: 'schedule-add-btn inline-flex items-center gap-1.5 rounded-xl border border-cyan-400/30 bg-cyan-400/[0.06] px-3 py-1.5 text-xs font-semibold text-cyan-400 hover:bg-cyan-400/15 transition',
  }, `＋ ${t('orders.addDelivery')}`);
  addScheduleBtn.addEventListener('click', () => {
    deliverySchedules.push({ id: makeScheduleId(), date: '' });
    syncScheduleQtyMaps();
    if (isDirect) syncDirectTotalsFromMatrix();
    renderItemsSection(wrap, contract);
    requestValidationRefresh();
  });
  schedulesHeader.appendChild(addScheduleBtn);
  schedulesPanel.appendChild(schedulesHeader);

  const schedulesList = el('div', { className: 'space-y-2' });
  deliverySchedules.forEach((schedule, index) => {
    const row = el('div', { className: 'flex items-center gap-3 rounded-xl border border-white/10 bg-slate-950/40 px-3 py-2.5' });
    row.appendChild(el('div', {
      className: 'inline-flex h-8 min-w-8 items-center justify-center rounded-full bg-cyan-400/10 px-2 text-[11px] font-bold text-cyan-300',
    }, String(index + 1)));
    row.appendChild(el('div', { className: 'min-w-[120px] text-xs text-slate-400' }, t('orders.deliveryDate')));
    const dateInput = el('input', {
      type: 'date',
      value: schedule.date || '',
      className: 'rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-white focus:border-cyan-400/50 focus:outline-none',
      'data-schedule': String(schedule.id),
      'aria-label': `${t('orders.deliveryDate')} ${index + 1}`,
    });
    dateInput.addEventListener('change', () => {
      schedule.date = dateInput.value || '';
      renderItemsSection(wrap, contract);
      requestValidationRefresh();
    });
    row.appendChild(dateInput);

    const totalForSchedule = itemRows.reduce((sum, item) => sum + (Number(item.scheduleQtys?.get?.(schedule.id)) || 0), 0);
    const scheduleTotalEl = el('div', { className: 'ml-auto text-[11px] text-slate-500 tabular-nums' }, `${t('orders.totalLabel')}: ${totalForSchedule} шт.`);
    scheduleTotalEls.set(schedule.id, scheduleTotalEl);
    row.appendChild(scheduleTotalEl);

    if (deliverySchedules.length > 1) {
      const removeBtn = el('button', {
        type: 'button',
        className: 'schedule-del-btn rounded-lg p-2 text-slate-500 hover:text-red-400 hover:bg-red-400/10 transition',
        title: t('orders.removeDelivery'),
        'aria-label': t('orders.removeDelivery'),
      }, '✕');
      removeBtn.addEventListener('click', () => {
        deliverySchedules = deliverySchedules.filter(entry => entry.id !== schedule.id);
        syncScheduleQtyMaps();
        if (isDirect) syncDirectTotalsFromMatrix();
        renderItemsSection(wrap, contract);
        requestValidationRefresh();
      });
      row.appendChild(removeBtn);
    }

    schedulesList.appendChild(row);
  });
  schedulesPanel.appendChild(schedulesList);
  wrap.appendChild(schedulesPanel);

  const tableWrap = el('div', { id: 'orderItemsWrap2', className: 'tbl-scroll sticky-thead rounded-xl border border-white/10 bg-slate-950/40' });
  tableWrap.style.overflowX = 'auto';
  tableWrap.style.overflowY = 'auto';
  tableWrap.style.maxHeight = '68vh';
  tableWrap.style.paddingBottom = '6rem';
  tableWrap.style.webkitOverflowScrolling = 'touch';

  const table = el('table', { className: 'w-full text-sm border-collapse' });
  table.style.width = 'max-content';
  const dynamicColumnCount = isDirect
    ? deliverySchedules.length * Math.max(1, addressRows.length)
    : deliverySchedules.length + addressRows.length;
  table.style.minWidth = `${Math.max(980, 860 + dynamicColumnCount * 110)}px`;

  const thead = el('thead', { className: 'bg-slate-900' });
  const fixedHeaders = [
    { label: t('orders.colNumber'), cls: 'w-8 text-center' },
    { label: t('orders.colProduct'), cls: 'min-w-[200px]' },
    { label: t('orders.colCode'), cls: 'min-w-[100px]' },
    { label: t('orders.colPrice'), cls: 'w-28 text-right' },
    { label: t('orders.colTotalQty'), cls: 'w-20 text-right' },
    { label: t('orders.colCost'), cls: 'w-32 text-right' },
    { label: t('orders.colDelivered'), cls: 'w-24 text-right' },
    { label: t('orders.colAssembled'), cls: 'w-24 text-right' },
  ];

  if (isDirect) {
    const row1 = el('tr', {});
    const row2 = el('tr', {});
    const row3 = el('tr', {});
    const recipientGroups = buildRecipientAddressGroups(addressRows);
    fixedHeaders.forEach(h => {
      const th = el('th', {
        className: `px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 ${h.cls}`,
        rowspan: '3',
      }, h.label);
      row1.appendChild(th);
    });

    deliverySchedules.forEach((schedule, scheduleIndex) => {
      const th = el('th', {
        className: 'px-2 py-1.5 text-[11px] font-semibold text-slate-300 text-center border-l border-white/10',
        colspan: String(addressRows.length),
      });
      th.innerHTML = `<div>${schedule.date ? fmtDate(schedule.date) : `${t('orders.deliveryDate')} ${scheduleIndex + 1}`}</div><div class="mt-1 text-[10px] text-slate-500">${t('orders.scheduleQtyLabel')}</div>`;
      row1.appendChild(th);
    });

    deliverySchedules.forEach((schedule, scheduleIndex) => {
      recipientGroups.forEach((group, groupIndex) => {
        const th = el('th', {
          className: 'px-2 py-1.5 text-[11px] font-semibold text-slate-300 text-center border-l border-white/10',
          colspan: String(group.rows.length),
          title: group.recipientName || `${t('orders.recipientNameLabel')} ${groupIndex + 1}`,
        }, group.recipientName || `${t('orders.recipientNameLabel')} ${groupIndex + 1}`);
        row2.appendChild(th);

        group.rows.forEach((addr, addrIndex) => {
          const addressLabel = addr.address || `${t('orders.addressLabel')} ${addrIndex + 1}`;
          const shortLabel = addressLabel.length > 26 ? `${addressLabel.slice(0, 24)}…` : addressLabel;
          const addrTh = el('th', {
            className: 'px-2 py-1.5 text-[11px] font-medium text-slate-400 text-center min-w-[120px] border-l border-white/10',
            title: `${schedule.date ? fmtDate(schedule.date) : `${t('orders.deliveryDate')} ${scheduleIndex + 1}`} · ${group.recipientName || t('orders.recipientNameLabel')} · ${addressLabel}`,
          }, shortLabel);
          row3.appendChild(addrTh);
        });
      });
    });

    thead.append(row1, row2, row3);
  } else {
    const row = el('tr', {});
    fixedHeaders.forEach(h => {
      const th = el('th', {
        className: `px-3 py-2 text-xs font-semibold uppercase tracking-wider text-slate-400 ${h.cls}`,
      }, h.label);
      row.appendChild(th);
    });

    deliverySchedules.forEach((schedule, index) => {
      const th = el('th', {
        className: 'px-2 py-1.5 text-[11px] font-semibold text-slate-300 text-center min-w-[110px] border-l border-white/10',
      });
      th.innerHTML = `<div>${schedule.date ? fmtDate(schedule.date) : `${t('orders.deliveryDate')} ${index + 1}`}</div><div class="mt-1 text-[10px] text-slate-500">${t('orders.scheduleQtyLabel')}</div>`;
      row.appendChild(th);
    });

    addressRows.forEach((addr, idx) => {
      const recipientLabel = addr.recipientName || `Получатель ${idx + 1}`;
      const addressLabel = addr.address || `Адрес ${idx + 1}`;
      const shortAddress = addressLabel.length > 24 ? `${addressLabel.slice(0, 22)}…` : addressLabel;
      const th = el('th', {
        className: 'px-2 py-1.5 text-[11px] font-semibold text-slate-300 text-center min-w-[90px] border-l border-white/10',
        title: `${recipientLabel} · ${addressLabel}`,
      });
      th.innerHTML = `<div>${recipientLabel}</div><div class="mt-1 text-[10px] font-medium text-slate-500">${shortAddress}</div>`;
      row.appendChild(th);
    });

    thead.appendChild(row);
  }

  table.appendChild(thead);
  const tbody = el('tbody', { className: 'divide-y divide-white/5 align-middle' });

  const displayEntries = buildOrderDisplayEntries(itemRows);
  const getEntryItems = (entry) => entry.kind === 'summary' ? (entry.items || []) : [entry.item];
  const getEntryScheduledQty = (entry) => getEntryItems(entry).reduce((sum, rowItem) => sum + getItemScheduledQty(rowItem), 0);
  const getEntryDistributedQty = (entry) => getEntryItems(entry).reduce((sum, rowItem) => sum + getItemDistributedQty(rowItem), 0);
  const getEntryEffectiveQty = (entry) => getEntryItems(entry).reduce((sum, rowItem) => sum + getItemEffectiveQty(rowItem, deliveryModeState), 0);
  const getEntryCost = (entry) => getEntryItems(entry).reduce((sum, rowItem) => sum + getItemEffectiveQty(rowItem, deliveryModeState) * (Number(rowItem.price) || 0), 0);
  const getEntryDeliveredQty = (entry, orderIdValue) => getEntryItems(entry).reduce((sum, rowItem) => sum + calcOrderDelivered(orderIdValue, rowItem.contractItemName, rowItem.contractItemCode), 0);
  const getEntryAssembledQty = (entry, contractIdValue, productIdValue) => getEntryItems(entry).reduce((sum, rowItem) => sum + calcOrderAssembled(contractIdValue, rowItem.contractItemName, rowItem.contractItemCode, productIdValue), 0);
  const getEntryProgramNeedQty = (entry) => getEntryItems(entry).reduce((sum, rowItem) => {
    const needMetrics = deliveryModeState === 'direct'
      ? getSelectedRecipientsNeedForOrderItem(rowItem)
      : getProgramNeedForOrderItem(rowItem, currentOrderProgramName);
    return sum + (Number(needMetrics.qty) || 0);
  }, 0);
  const getEntryScheduleAddrQty = (entry, scheduleId, addrId) => getEntryItems(entry).reduce((sum, rowItem) => sum + getItemScheduleAddrQty(rowItem, scheduleId, addrId), 0);

  let displayIndex = 0;

  displayEntries.forEach(entry => {
    const isSummary = entry.kind === 'summary';
    const isVariant = entry.kind === 'variant';
    const item = entry.item || entry.items?.[0] || null;
    if (!item && !isSummary) return;

    if (!isVariant) displayIndex += 1;
    const rowStateIndex = item ? itemRows.indexOf(item) : -1;
    const tr = el('tr', {
      className: isSummary ? 'bg-white/[0.035] align-middle' : 'hover:bg-white/[0.02] align-middle',
    });

    tr.appendChild(el('td', {
      className: `px-2 py-2.5 text-xs text-center tabular-nums ${isVariant ? 'text-slate-700' : 'text-slate-500'}`,
    }, isVariant ? '' : String(displayIndex)));

    const nameTd = el('td', {
      className: `px-3 py-2.5 text-sm ${isSummary ? 'text-cyan-100 font-semibold' : 'text-white'} ${isVariant ? 'pl-7' : ''}`,
    });
    if (isSummary) nameTd.textContent = entry.title || item?.contractItemName || '—';
    else if (isVariant) nameTd.textContent = `в т.ч. ${item?.colorCode || item?.displayName || item?.contractItemName || '—'}`;
    else nameTd.textContent = item.displayName || item.contractItemName;
    tr.appendChild(nameTd);

    tr.appendChild(el('td', {
      className: `px-3 py-2.5 text-xs font-mono whitespace-nowrap ${isSummary ? 'text-slate-500' : 'text-slate-400'}`,
    }, isSummary ? (entry.baseCode || '—') : item.contractItemCode));

    tr.appendChild(el('td', {
      className: `px-3 py-2.5 text-sm text-right tabular-nums whitespace-nowrap ${isSummary ? 'text-slate-500' : 'text-slate-400'}`,
    }, isSummary ? '—' : `${fmtMoney(item.price)} ₽`));

    const totalQtyTd = el('td', { className: 'px-3 py-2.5 text-right align-middle' });
    const totalQtyWrap = el('div', { className: 'flex flex-col items-end gap-1' });
    const totalQtyValue = el('div', { className: `text-sm font-semibold tabular-nums ${isSummary ? 'text-cyan-100' : 'text-white'}` });
    const totalQtyHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 text-right' });
    const programNeedHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 text-right' });
    const scheduleHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 text-right' });
    totalQtyHint.style.minHeight = '14px';
    programNeedHint.style.minHeight = '14px';
    scheduleHint.style.minHeight = '14px';
    totalQtyWrap.append(totalQtyValue, totalQtyHint, programNeedHint, scheduleHint);
    totalQtyTd.appendChild(totalQtyWrap);
    tr.appendChild(totalQtyTd);

    const totalCostTd = el('td', {
      className: `px-3 py-2.5 text-sm font-medium text-right tabular-nums whitespace-nowrap ${isSummary ? 'text-cyan-200/90' : 'text-cyan-400/80'}`,
    });
    tr.appendChild(totalCostTd);

    const contractId = contract ? contract.id : null;
    const orderId = editingOrderId ? ((state.orders || []).find(o => o.id === editingOrderId)?.id ?? null) : null;
    const deliveredTd = el('td', { className: 'px-3 py-2.5 text-sm text-right tabular-nums whitespace-nowrap' });
    const delivered = getEntryDeliveredQty(entry, orderId);
    const orderedQtyForStatus = getEntryEffectiveQty(entry);
    deliveredTd.appendChild(el('span', {
      className: delivered >= orderedQtyForStatus && orderedQtyForStatus > 0
        ? 'text-emerald-400 font-semibold'
        : delivered > 0 ? 'text-amber-400' : 'text-slate-500',
    }, delivered > 0 ? String(delivered) : '—'));
    tr.appendChild(deliveredTd);

    const assembledTd = el('td', { className: 'px-3 py-2.5 text-sm text-right tabular-nums whitespace-nowrap' });
    const contractItem = (contract.items || []).find(i =>
      (i.name || '').trim().toLowerCase() === ((item?.contractItemName || entry.title || '').trim().toLowerCase())
    );
    const catalogProduct = contractItem ? resolveProductByContractItem(contractItem) : null;
    if (productRequiresAssembly(catalogProduct)) {
      const assembled = getEntryAssembledQty(entry, contractId, catalogProduct?.id ?? null);
      assembledTd.appendChild(el('span', {
        className: assembled >= orderedQtyForStatus && orderedQtyForStatus > 0
          ? 'text-emerald-400 font-semibold'
          : assembled > 0 ? 'text-amber-400' : 'text-slate-500',
      }, assembled > 0 ? String(assembled) : '—'));
    } else {
      assembledTd.appendChild(el('span', { className: 'text-slate-700 text-xs' }, '—'));
    }
    tr.appendChild(assembledTd);

    const qtyInputsForRow = [];
    const recipientNeedIndicators = [];
    const summaryScheduleEls = new Map();
    const summaryAddressEls = new Map();
    const summaryMatrixEls = new Map();

    function refreshTotals() {
      if (isSummary) {
        if (isDirect) getEntryItems(entry).forEach(syncDirectTotalsForItem);
        const scheduledQty = getEntryScheduledQty(entry);
        const distributedQty = getEntryDistributedQty(entry);
        const effectiveQty = isDirect ? distributedQty : scheduledQty;
        totalQtyValue.textContent = effectiveQty > 0 ? String(effectiveQty) : '—';
        totalCostTd.textContent = effectiveQty > 0 ? `${fmtMoney(getEntryCost(entry))} ₽` : '—';
        totalQtyHint.textContent = '';
        totalQtyHint.className = 'text-[10px] leading-tight text-slate-500 text-right';

        const totalProgramNeedQty = getEntryProgramNeedQty(entry);
        const totalProgramNeedOver = Math.max(0, effectiveQty - totalProgramNeedQty);
        if (totalProgramNeedQty > 0) {
          programNeedHint.textContent = totalProgramNeedOver > 0
            ? tOrder('colorProgramNeedExceededHint', { need: totalProgramNeedQty, over: totalProgramNeedOver })
            : tOrder('colorProgramNeedHint', { need: totalProgramNeedQty });
          programNeedHint.className = totalProgramNeedOver > 0
            ? 'text-[10px] leading-tight text-red-400 text-right font-medium'
            : 'text-[10px] leading-tight text-cyan-300 text-right';
        } else {
          programNeedHint.textContent = currentOrderProgramName ? tOrder('colorProgramNeedHint', { need: 0 }) : '';
          programNeedHint.className = 'text-[10px] leading-tight text-slate-500 text-right';
        }

        scheduleHint.textContent = deliverySchedules.length > 1 || scheduledQty > 0
          ? `${t('orders.scheduleSummaryTitle')}: ${scheduledQty} шт.`
          : '';
        scheduleHint.className = 'text-[10px] leading-tight text-slate-500 text-right';

        deliverySchedules.forEach(schedule => {
          const scheduleEl = summaryScheduleEls.get(schedule.id);
          if (scheduleEl) {
            const qty = getEntryItems(entry).reduce((sum, rowItem) => sum + (Number(rowItem.scheduleQtys.get(schedule.id)) || 0), 0);
            scheduleEl.textContent = qty > 0 ? String(qty) : '—';
          }
        });

        addressRows.forEach(addr => {
          const addrEl = summaryAddressEls.get(addr.id);
          if (addrEl) {
            const qty = getEntryItems(entry).reduce((sum, rowItem) => sum + (Number(rowItem.qtys.get(addr.id)) || 0), 0);
            addrEl.textContent = qty > 0 ? String(qty) : '—';
          }
        });

        deliverySchedules.forEach(schedule => {
          addressRows.forEach(addr => {
            const matrixEl = summaryMatrixEls.get(getScheduleAddrKey(schedule.id, addr.id));
            if (!matrixEl) return;
            const qty = getEntryScheduleAddrQty(entry, schedule.id, addr.id);
            matrixEl.textContent = qty > 0 ? String(qty) : '—';
          });
        });

        refreshGrandTotals();
        return;
      }

      if (isDirect) syncDirectTotalsForItem(item);

      const scheduledQty = getItemScheduledQty(item);
      if (!isDirect && deliveryModeState === 'warehouse' && addressRows.length === 1) {
        item.qtys.set(addressRows[0].id, scheduledQty);
      }
      const distributedQty = getItemDistributedQty(item);
      const effectiveQty = isDirect ? distributedQty : scheduledQty;
      totalQtyValue.textContent = effectiveQty > 0 ? String(effectiveQty) : '—';
      totalCostTd.textContent = effectiveQty > 0 ? `${fmtMoney(effectiveQty * item.price)} ₽` : '—';

      const availableQty = getItemQtyLimit(item, contract.id);
      const hasLimit = Number.isFinite(availableQty) && availableQty !== Infinity;
      const overBy = hasLimit ? Math.max(0, effectiveQty - availableQty) : 0;
      if (hasLimit) {
        totalQtyHint.textContent = overBy > 0
          ? tOrder('availableQtyExceededHint', { available: availableQty, over: overBy })
          : tOrder('availableQtyHint', { available: availableQty });
        totalQtyHint.className = overBy > 0
          ? 'text-[10px] leading-tight text-red-400 text-right font-medium'
          : 'text-[10px] leading-tight text-slate-500 text-right';
      } else {
        totalQtyHint.textContent = '';
        totalQtyHint.className = 'text-[10px] leading-tight text-slate-500 text-right';
      }

      const programNeed = isDirect ? getSelectedRecipientsNeedForOrderItem(item) : getProgramNeedForOrderItem(item, currentOrderProgramName);
      const colorNeedQty = Number(programNeed.qty) || 0;
      const colorNeedOver = Math.max(0, effectiveQty - colorNeedQty);
      if (item.isColorVariant || item.colorCode) {
        if (colorNeedQty > 0) {
          programNeedHint.textContent = colorNeedOver > 0
            ? tOrder('colorProgramNeedExceededHint', { need: colorNeedQty, over: colorNeedOver })
            : tOrder('colorProgramNeedHint', { need: colorNeedQty });
          programNeedHint.className = colorNeedOver > 0
            ? 'text-[10px] leading-tight text-red-400 text-right font-medium'
            : 'text-[10px] leading-tight text-cyan-300 text-right';
        } else {
          programNeedHint.textContent = currentOrderProgramName ? tOrder('colorProgramNeedHint', { need: 0 }) : '';
          programNeedHint.className = 'text-[10px] leading-tight text-slate-500 text-right';
        }
      } else {
        programNeedHint.textContent = '';
        programNeedHint.className = 'text-[10px] leading-tight text-slate-500 text-right';
      }

      scheduleHint.textContent = deliverySchedules.length > 1 || scheduledQty > 0
        ? `${t('orders.scheduleSummaryTitle')}: ${scheduledQty} шт.`
        : '';
      scheduleHint.className = 'text-[10px] leading-tight text-slate-500 text-right';

      applyItemAvailabilityVisual(effectiveQty, availableQty, qtyInputsForRow, totalQtyTd, totalCostTd);

      recipientNeedIndicators.forEach(({ qtyInput, recipientNeedHint, recipientId, address, fillBtn }) => {
        const snapshot = buildRecipientNeedSnapshot(item, recipientId, address || '');

        if (snapshot.needQty > 0) {
          recipientNeedHint.textContent = snapshot.over > 0
            ? tOrder('directRecipientNeedExceededHint', {
                need: snapshot.needQty,
                ordered: snapshot.orderedOther,
                over: snapshot.over,
              })
            : tOrder('directRecipientNeedHint', {
                need: snapshot.needQty,
                ordered: snapshot.orderedOther,
                remaining: snapshot.remaining,
              });
          recipientNeedHint.className = snapshot.over > 0
            ? 'text-[10px] leading-tight text-red-400 text-center font-medium'
            : 'text-[10px] leading-tight text-cyan-300 text-center';
          qtyInput.title = snapshot.over > 0
            ? tOrder('directRecipientNeedExceededHint', {
                need: snapshot.needQty,
                ordered: snapshot.orderedOther,
                over: snapshot.over,
              })
            : tOrder('directRecipientNeedHint', {
                need: snapshot.needQty,
                ordered: snapshot.orderedOther,
                remaining: snapshot.remaining,
              });
          qtyInput.style.borderColor = snapshot.over > 0 ? 'rgb(239, 68, 68)' : '';
        } else {
          recipientNeedHint.textContent = tOrder('directRecipientNeedEmpty', {
            ordered: snapshot.orderedOther,
          });
          recipientNeedHint.className = 'text-[10px] leading-tight text-amber-300 text-center';
          qtyInput.title = tOrder('directRecipientNeedEmpty', {
            ordered: snapshot.orderedOther,
          });
          qtyInput.style.borderColor = '';
        }

        if (fillBtn) {
          if (snapshot.remaining > 0) {
            fillBtn.disabled = false;
            fillBtn.textContent = tOrder('directRecipientFillButton', { remaining: snapshot.remaining });
            fillBtn.className = 'rounded-md border border-cyan-400/20 bg-cyan-400/[0.08] px-2 py-1 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-400/[0.16]';
          } else {
            fillBtn.disabled = true;
            fillBtn.textContent = snapshot.needQty > 0
              ? tOrder('directRecipientFillDone')
              : tOrder('directRecipientFillUnavailable');
            fillBtn.className = 'rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-semibold text-slate-500 cursor-not-allowed';
          }
        }

        recipientNeedHint.style.whiteSpace = 'normal';
        recipientNeedHint.style.maxWidth = '96px';
      });

      if (item?.id != null) summaryRefreshByItemId.get(item.id)?.();
      refreshGrandTotals();
    }

    if (isSummary) {
      const refreshSummaryRow = () => refreshTotals();
      getEntryItems(entry).forEach(rowItem => {
        if (rowItem?.id != null) summaryRefreshByItemId.set(rowItem.id, refreshSummaryRow);
      });
    }

    if (isDirect) {
      deliverySchedules.forEach((schedule, scheduleIndex) => {
        addressRows.forEach((addr, addrIndex) => {
          const td = el('td', { className: 'px-2 py-2 text-center border-l border-white/10' });
          const wrapCell = el('div', { className: 'flex flex-col items-center gap-1' });
          const recipientNeedHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 text-center whitespace-nowrap' });
          if (isSummary) {
            const valueEl = el('div', {
              className: 'w-20 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-slate-300 text-right tabular-nums',
            }, '—');
            summaryMatrixEls.set(getScheduleAddrKey(schedule.id, addr.id), valueEl);
            wrapCell.appendChild(valueEl);
          } else {
            const input = el('input', {
              type: 'number',
              min: '0',
              step: '1',
              value: String(getItemScheduleAddrQty(item, schedule.id, addr.id) || 0),
              className: 'w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white text-right tabular-nums focus:border-cyan-400/50 focus:outline-none',
              'aria-label': `${schedule.date ? fmtDate(schedule.date) : `${t('orders.deliveryDate')} ${scheduleIndex + 1}`} · ${addr.recipientName || addr.address || `${t('orders.addressGeneric')} ${addrIndex + 1}`}`,
              'data-row': String(rowStateIndex),
              'data-schedule': String(schedule.id),
              'data-addr': String(addr.id),
            });
            const handleMatrixInput = () => {
              setItemScheduleAddrQty(item, schedule.id, addr.id, input.value);
              refreshTotals();
              requestValidationRefresh();
            };
            input.addEventListener('input', handleMatrixInput);
            input.addEventListener('change', handleMatrixInput);
            qtyInputsForRow.push(input);
            const fillBtn = el('button', {
              type: 'button',
              className: addr.recipientId
                ? 'rounded-md border border-cyan-400/20 bg-cyan-400/[0.08] px-2 py-1 text-[10px] font-semibold text-cyan-300 transition hover:bg-cyan-400/[0.16]'
                : 'rounded-md border border-white/10 bg-white/[0.04] px-2 py-1 text-[10px] font-semibold text-slate-500 cursor-not-allowed',
            }, tOrder('directRecipientFillUnavailable'));
            fillBtn.disabled = !addr.recipientId;
            fillBtn.addEventListener('click', () => {
              if (!addr.recipientId) return;
              const snapshot = buildRecipientNeedSnapshot(item, addr.recipientId, addr.address || '');
              if (snapshot.remaining <= 0) return;
              const nextQty = getItemScheduleAddrQty(item, schedule.id, addr.id) + snapshot.remaining;
              setItemScheduleAddrQty(item, schedule.id, addr.id, nextQty);
              input.value = String(nextQty);
              refreshTotals();
              requestValidationRefresh();
            });
            if (addr.recipientId) {
              recipientNeedIndicators.push({
                qtyInput: input,
                recipientNeedHint,
                recipientId: addr.recipientId,
                address: addr.address || '',
                fillBtn,
              });
            }
            wrapCell.append(input, recipientNeedHint, fillBtn);
          }
          td.appendChild(wrapCell);
          tr.appendChild(td);
        });
      });
    } else {
      deliverySchedules.forEach((schedule, scheduleIndex) => {
        const scheduleTd = el('td', { className: 'px-2 py-2 text-center border-l border-white/10' });
        if (isSummary) {
          const summaryScheduleEl = el('div', {
            className: 'rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-slate-300 text-right tabular-nums',
          }, '—');
          summaryScheduleEls.set(schedule.id, summaryScheduleEl);
          scheduleTd.appendChild(summaryScheduleEl);
        } else {
          const scheduleInput = el('input', {
            type: 'number', min: '0', step: '1',
            value: String(item.scheduleQtys.get(schedule.id) || 0),
            className: 'w-24 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white text-right tabular-nums focus:border-cyan-400/50 focus:outline-none',
            'aria-label': `${t('orders.deliveryDate')} ${scheduleIndex + 1}`,
            'data-row': String(rowStateIndex),
            'data-schedule': String(schedule.id),
          });
          const handleScheduleQtyInput = () => {
            item.scheduleQtys.set(schedule.id, Math.max(0, parseInt(scheduleInput.value, 10) || 0));
            refreshTotals();
            requestValidationRefresh();
          };
          scheduleInput.addEventListener('input', handleScheduleQtyInput);
          scheduleInput.addEventListener('change', handleScheduleQtyInput);
          scheduleTd.appendChild(scheduleInput);
        }
        tr.appendChild(scheduleTd);
      });

      addressRows.forEach((addr) => {
        const addrTd = el('td', { className: 'px-2 py-2 text-center border-l border-white/10' });
        const addrWrap = el('div', { className: 'flex flex-col items-center gap-1' });
        const recipientNeedHint = el('div', { className: 'text-[10px] leading-tight text-slate-500 text-center whitespace-nowrap' });
        recipientNeedHint.style.minHeight = '14px';
        if (isSummary) {
          const summaryAddressEl = el('div', {
            className: 'w-20 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1.5 text-sm text-slate-300 text-right tabular-nums',
          }, '—');
          summaryAddressEls.set(addr.id, summaryAddressEl);
          addrWrap.appendChild(summaryAddressEl);
        } else {
          const qtyInput = el('input', {
            type: 'number', min: '0', step: '1',
            value: String(item.qtys.get(addr.id) || 0),
            className: 'w-20 rounded-lg border border-white/10 bg-white/5 px-2 py-1.5 text-sm text-white text-right tabular-nums focus:border-cyan-400/50 focus:outline-none',
            'aria-label': `${t('orders.qtyForAddress')} ${addr.recipientName || addr.address || t('orders.addressGeneric')}`,
            'data-row': String(rowStateIndex),
            'data-addr': String(addr.id),
          });
          if (deliveryModeState === 'warehouse' && addressRows.length === 1) {
            qtyInput.disabled = true;
            qtyInput.title = t('orders.scheduleSummaryTitle');
            qtyInput.classList.add('opacity-70', 'cursor-not-allowed');
          }
          const handleQtyInput = () => {
            item.qtys.set(addr.id, Math.max(0, parseInt(qtyInput.value, 10) || 0));
            refreshTotals();
            requestValidationRefresh();
          };
          qtyInput.addEventListener('input', handleQtyInput);
          qtyInput.addEventListener('change', handleQtyInput);
          qtyInputsForRow.push(qtyInput);
          addrWrap.append(qtyInput, recipientNeedHint);
        }
        addrTd.appendChild(addrWrap);
        tr.appendChild(addrTd);
      });
    }

    refreshTotals();
    tbody.appendChild(tr);
  });

  table.appendChild(tbody);
  tableWrap.appendChild(table);
  wrap.appendChild(tableWrap);

  function refreshGrandTotals() {
    let gQty = 0;
    let gCost = 0;
    itemRows.forEach(item => {
      const qty = getItemEffectiveQty(item, deliveryModeState);
      gQty += qty;
      gCost += qty * item.price;
    });
    const tc = document.getElementById('orderTableTotalCost');
    if (tc) tc.textContent = `${fmtMoney(gCost)} ₽`;
    const tq = document.getElementById('orderTableTotalQty');
    if (tq) tq.textContent = `${gQty} шт.`;

    deliverySchedules.forEach(schedule => {
      const total = itemRows.reduce((sum, item) => sum + (Number(item.scheduleQtys?.get?.(schedule.id)) || 0), 0);
      const footerEl = document.getElementById(`orderTableScheduleTotal_${schedule.id}`);
      if (footerEl) footerEl.textContent = total > 0 ? String(total) : '—';
      const panelEl = scheduleTotalEls.get(schedule.id);
      if (panelEl) panelEl.textContent = `${t('orders.totalLabel')}: ${total} шт.`;
    });

    if (isDirect) {
      deliverySchedules.forEach(schedule => {
        addressRows.forEach(addr => {
          const total = itemRows.reduce((sum, item) => sum + getItemScheduleAddrQty(item, schedule.id, addr.id), 0);
          const footerEl = document.getElementById(`orderTableScheduleAddrTotal_${schedule.id}_${addr.id}`);
          if (footerEl) footerEl.textContent = total > 0 ? String(total) : '—';
        });
      });
    } else {
      addressRows.forEach(addr => {
        const total = itemRows.reduce((sum, item) => sum + (Number(item.qtys?.get?.(addr.id)) || 0), 0);
        const footerEl = document.getElementById(`orderTableAddressTotal_${addr.id}`);
        if (footerEl) footerEl.textContent = total > 0 ? String(total) : '—';
      });
    }

    const validation = buildCurrentOrderValidation();
    renderOrderMoneyHintLines(document.getElementById('orderTableMoneyHint'), validation);
    const activeContract = contract || (state.contracts || []).find(c => c.id === Number(document.getElementById('orderContractSel')?.value || 0)) || null;
    const advanceDisplay = document.getElementById('orderAdvanceAmountDisplay');
    const advanceHint = document.getElementById('orderAdvanceAmountHint');
    if (advanceDisplay && advanceHint) {
      const executionPlan = activeContract ? buildExecutionPlan(activeContract) : null;
      const snapshot = getOrderAdvanceSnapshot(activeContract, executionPlan);
      advanceDisplay.textContent = `${fmtMoney(snapshot.amount)} ₽`;
      advanceHint.textContent = snapshot.percent > 0
        ? t('orders.advanceIncluded', { percent: snapshot.percent })
        : t('orders.advanceNotUsed');
      advanceDisplay.className = snapshot.percent > 0
        ? 'w-full rounded-xl border border-amber-400/20 bg-amber-400/[0.06] px-4 py-2.5 text-sm font-bold text-amber-300'
        : 'w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-2.5 text-sm font-bold text-slate-300';
    }
  }

  const tfoot = el('tfoot', { className: 'border-t border-white/10 bg-slate-900' });
  const tfRow = el('tr', {});
  tfRow.appendChild(el('td', { colspan: '4', className: 'px-3 py-3 text-xs font-semibold uppercase tracking-wider text-slate-400 text-right' }, `${t('orders.totalLabel')}:`));
  tfRow.appendChild(el('td', { id: 'orderTableTotalQty', className: 'px-3 py-3 text-sm font-bold text-white tabular-nums text-right' }, '—'));
  const tcTd = el('td', { className: 'px-3 py-3 text-right whitespace-nowrap' });
  const tcWrap = el('div', { className: 'flex flex-col items-end gap-1' });
  tcWrap.append(
    el('div', { id: 'orderTableTotalCost', className: 'text-base font-bold text-cyan-400 tabular-nums whitespace-nowrap' }, '—'),
    el('div', { id: 'orderTableMoneyHint', className: 'flex flex-col items-end gap-0.5' }),
  );
  tcTd.appendChild(tcWrap);
  tfRow.appendChild(tcTd);
  tfRow.appendChild(el('td', { className: 'px-3 py-3 text-right text-xs text-slate-600' }, '—'));
  tfRow.appendChild(el('td', { className: 'px-3 py-3 text-right text-xs text-slate-600' }, '—'));

  if (isDirect) {
    deliverySchedules.forEach(schedule => {
      addressRows.forEach(addr => {
        tfRow.appendChild(el('td', {
          id: `orderTableScheduleAddrTotal_${schedule.id}_${addr.id}`,
          className: 'px-2 py-3 text-sm font-semibold text-slate-300 text-right tabular-nums border-l border-white/10',
        }, '—'));
      });
    });
  } else {
    deliverySchedules.forEach(schedule => {
      tfRow.appendChild(el('td', {
        id: `orderTableScheduleTotal_${schedule.id}`,
        className: 'px-2 py-3 text-sm font-semibold text-slate-300 text-right tabular-nums border-l border-white/10',
      }, '—'));
    });
    addressRows.forEach(addr => {
      tfRow.appendChild(el('td', {
        id: `orderTableAddressTotal_${addr.id}`,
        className: 'px-2 py-3 text-sm font-semibold text-slate-300 text-right tabular-nums border-l border-white/10',
      }, '—'));
    });
  }

  tfoot.appendChild(tfRow);
  table.appendChild(tfoot);
  refreshGrandTotals();
  makeColumnsResizable(table, 'orders-items');
  requestAnimationFrame(() => attachFrozenManager(table, 'orders-items'));
}

// ─── Validation ──────────────────────────────────────────────────

function validateCurrentOrder() {
  const container = $('orderValidationWarnings');
  if (!container) return {
    contract: null,
    itemOverages: [],
    contractOverage: 0,
    programOverage: 0,
    hasOverage: false,
  };

  if (!container.dataset.slotReady) {
    container.dataset.slotReady = 'true';
    const panel = el('div', {
      className: 'rounded-xl border border-amber-400/25 bg-amber-400/[0.06] p-4',
    });
    panel.style.minHeight = '132px';
    panel.style.visibility = 'hidden';
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';

    const titleEl = el('p', {
      id: 'orderValidationWarningsTitle',
      className: 'text-xs font-bold text-amber-400 mb-3',
    }, '');
    const listEl = el('ul', {
      id: 'orderValidationWarningsList',
      className: 'space-y-2',
    });

    panel.append(titleEl, listEl);
    container.appendChild(panel);
  }

  const panel = container.firstElementChild;
  const titleEl = $('orderValidationWarningsTitle');
  const list = $('orderValidationWarningsList');
  if (!panel || !titleEl || !list) return {
    contract: null,
    itemOverages: [],
    contractOverage: 0,
    programOverage: 0,
    hasOverage: false,
  };

  clearChildren(list);

  const validation = buildCurrentOrderValidation();
  const scheduleValidation = buildDeliveryScheduleValidation();
  validation.scheduleMissingDates = scheduleValidation.missingDates;
  validation.scheduleItemMismatches = scheduleValidation.itemMismatches;
  validation.hasScheduleIssues = scheduleValidation.hasIssues;

  if ((!validation.contract || !validation.hasOverage) && !validation.hasScheduleIssues) {
    titleEl.textContent = '';
    panel.style.visibility = 'hidden';
    panel.style.opacity = '0';
    panel.style.pointerEvents = 'none';
    panel.setAttribute('aria-hidden', 'true');
    return validation;
  }

  const warningTone = validation.hasScheduleIssues ? 'border-red-400/25 bg-red-400/[0.06]' : 'border-amber-400/25 bg-amber-400/[0.06]';
  const warningText = validation.hasScheduleIssues ? 'text-red-400' : 'text-amber-400';
  const listText = validation.hasScheduleIssues ? 'text-red-300/90' : 'text-amber-300/90';

  panel.className = `rounded-xl ${warningTone} p-4`;
  titleEl.className = `text-xs font-bold ${warningText} mb-3`;
  titleEl.textContent = validation.hasScheduleIssues ? '⚠️ Сроки поставки требуют проверки' : '⚠️ ' + tOrder('overageTitle');
  list.className = 'space-y-2';

  scheduleValidation.missingDates.forEach(entry => {
    list.appendChild(el('li', { className: `text-xs ${listText}` },
      `▸ ${t('orders.deliveryDate')} ${entry.index}: ${t('orders.scheduleDateRequired')}`));
  });

  scheduleValidation.itemMismatches.forEach(entry => {
    list.appendChild(el('li', { className: `text-xs ${listText}` },
      '▸ ' + t('orders.scheduleAddressMismatch', {
        name: entry.name,
        distributed: entry.distributed,
        total: entry.total,
      })));
  });

  validation.itemOverages.forEach(o => {
    list.appendChild(el('li', { className: `text-xs ${listText}` },
      '▸ ' + tOrder('overageItem', {
        current: o.current,
        remaining: o.remaining,
        over: o.over,
      }).replace(/^/, `${o.name}: `)));
  });

  if (validation.contractOverage > 0) {
    list.appendChild(el('li', { className: `text-xs ${listText}` },
      '▸ ' + tOrder('overageTotal', {
        ordered: fmtMoney(validation.totalWithCurrent),
        limit: fmtMoney(validation.contractTotalPrice),
        over: fmtMoney(validation.contractOverage),
      })));
  }

  if (validation.programOverage > 0) {
    list.appendChild(el('li', { className: `text-xs ${listText}` },
      '▸ ' + tOrder('overageProgram', {
        name: validation.programName || '—',
        ordered: fmtMoney(validation.programTotalWithCurrent),
        limit: fmtMoney(validation.programBudget),
        over: fmtMoney(validation.programOverage),
      })));
  }

  panel.style.visibility = 'visible';
  panel.style.opacity = '1';
  panel.style.pointerEvents = 'auto';
  panel.setAttribute('aria-hidden', 'false');
  return validation;
}

// ─── Save ────────────────────────────────────────────────────────

function syncOrderedToContract(contractId) {
  const contract = (state.contracts || []).find(c => c.id === contractId);
  if (!contract || !Array.isArray(contract.items)) return;
  const orderedMap = new Map();
  (state.orders || [])
    .filter(o => o.contractId === contractId)
    .forEach(order => {
      (Array.isArray(order.deliveryRows) ? order.deliveryRows : []).forEach(r => {
        const key = (r.contractItemName || '').trim().toLowerCase();
        if (!key) return;
        orderedMap.set(key, (orderedMap.get(key) || 0) + (Number(r.qty) || 0));
      });
    });
  contract.items.forEach(item => {
    const key = (item.name || '').trim().toLowerCase();
    item.ordered = orderedMap.get(key) || 0;
  });
}

function saveOrderCard() {
  const contractSel = $('orderContractSel');
  const programSel  = $('orderProgramSel');
  const numDisplay  = $('orderNumberDisplay');
  const deliveryModeSel = document.getElementById('orderDeliveryModeSel');
  const warehouseSelEl = document.getElementById('orderWarehouseSel');
  const sentCheck   = document.getElementById('orderSentCheck');
  const sentDateInp = document.getElementById('orderSentDate');

  if (!contractSel || !contractSel.value) {
    showToast(t('orders.contractRequired'), 'error');
    return;
  }
  if (!programSel || !programSel.value) {
    showToast(t('orders.programRequired'), 'error');
    programSel?.focus();
    return;
  }

  syncOrderCardFromDom();

  const deliveryMode = deliveryModeSel?.value || deliveryModeState || 'direct';
  if (!deliveryMode) {
    showToast(t('orders.chooseDeliveryMode'), 'error');
    return;
  }

  if (deliveryMode === 'warehouse') {
    if (!warehouseSelEl?.value) {
      showToast(t('orders.chooseWarehouse'), 'error');
      warehouseSelEl?.focus();
      return;
    }
    if (!addressRows[0]?.address) {
      showToast(t('orders.noWarehouseAddress'), 'error');
      return;
    }
  } else {
    const hasRecipientError = addressRows.some(row => !row.recipientId || !String(row.recipientName || '').trim());
    if (hasRecipientError) {
      showToast(t('orders.recipientRequired'), 'error');
      return;
    }
    const orderProgramName = resolveProgramNameByValue(programSel?.value || '');
    const orderProgramLabel = formatProgramValueLabel(orderProgramName || programSel?.value || '');
    const invalidProgramRecipient = addressRows.find(row => {
      const recipient = findRecipientForAddressRow(row);
      return !isRecipientAllowedForProgram(recipient, orderProgramName);
    });
    if (invalidProgramRecipient) {
      showToast(t('orders.recipientProgramMismatch', {
        recipient: invalidProgramRecipient.recipientName || '—',
        program: orderProgramLabel || orderProgramName || programSel?.value || '—',
      }), 'error', 5000);
      return;
    }
    const hasAddressError = addressRows.some(row => !String(row.address || '').trim());
    if (hasAddressError) {
      showToast(t('orders.recipientAddressRequired'), 'error');
      return;
    }
  }

  const contractId = Number(contractSel.value);
  const validation = validateCurrentOrder();
  const scheduleValidation = buildDeliveryScheduleValidation();
  if (scheduleValidation.missingDates.length > 0) {
    showToast(t('orders.scheduleDateRequired'), 'error', 5000);
    return;
  }
  if (scheduleValidation.itemMismatches.length > 0) {
    const firstMismatch = scheduleValidation.itemMismatches[0];
    showToast(t('orders.scheduleAddressMismatch', {
      name: firstMismatch.name,
      distributed: firstMismatch.distributed,
      total: firstMismatch.total,
    }), 'error', 6000);
    return;
  }
  if (validation?.hasOverage) {
    const lines = [];

    validation.itemOverages.forEach(o => {
      lines.push('• ' + o.name + ': ' + tOrder('overageItem', {
        current: o.current,
        remaining: o.remaining,
        over: o.over,
      }));
    });

    if (validation.contractOverage > 0) {
      lines.push('• ' + tOrder('overageTotal', {
        ordered: fmtMoney(validation.totalWithCurrent),
        limit: fmtMoney(validation.contractTotalPrice),
        over: fmtMoney(validation.contractOverage),
      }));
    }

    if (validation.programOverage > 0) {
      lines.push('• ' + tOrder('overageProgram', {
        name: validation.programName || '—',
        ordered: fmtMoney(validation.programTotalWithCurrent),
        limit: fmtMoney(validation.programBudget),
        over: fmtMoney(validation.programOverage),
      }));
    }

    const proceed = confirm(
      '⚠️ ' + tOrder('overageTitle') + '\n\n' + lines.join('\n') + '\n\n' + tOrder('overageConfirm')
    );
    if (!proceed) return;
  }

  const programCode     = programSel ? programSel.value : '';
  const selectedProgram = getProgramByIdentity(programCode);
  const programName = selectedProgram?.name || resolveProgramNameByValue(programCode);
  const contract        = (state.contracts || []).find(c => c.id === contractId);
  const executionPlan = contract ? buildExecutionPlan(contract) : null;
  const advanceSnapshot = getOrderAdvanceSnapshot(contract, executionPlan);
  const supplierId      = contract?.supplierId ?? null;
  const warehouseId     = deliveryMode === 'warehouse' && warehouseSelEl && warehouseSelEl.value
    ? Number(warehouseSelEl.value)
    : null;
  const sentStatus      = sentCheck ? sentCheck.checked : false;
  const sentDateVal     = sentDateInp ? sentDateInp.value : '';
  const status          = sentStatus ? 'sent' : 'draft';
  const rowsToSave      = buildDeliveryRowsForSave();

  // deliveryAddress — first address for backward compat
  const deliveryAddress = addressRows.length > 0 ? addressRows[0].address : '';

  let savedOrder = null;

  if (editingOrderId !== null) {
    const order = (state.orders || []).find(o => o.id === editingOrderId);
    if (order) {
      const programChanged = getOrderProgramValue(order) !== programCode;
      let finalOrderNumber;
      if (order.orderNumber && !programChanged) {
        finalOrderNumber = order.orderNumber;
      } else if (order.orderNumber && programChanged) {
        const seq = order.seqNum || 1;
        finalOrderNumber = generateOrderNumber(contract, seq, programCode);
      } else {
        const seq = getNextOrderSeq(contractId);
        finalOrderNumber = generateOrderNumber(contract, seq, programCode);
      }
      savedOrder = updateOrder(editingOrderId, {
        contractId, supplierId, programCode, programName, deliveryAddress, warehouseId, deliveryMode, status,
        orderNumber: finalOrderNumber,
        seqNum: order.seqNum || 1,
        readinessState: executionReadinessState,
        paymentScenario: executionPlan?.scenario || null,
        advancePercent: advanceSnapshot.percent,
        advanceAmount: advanceSnapshot.amount,
        paymentPlan: executionPlan ? {
          total: executionPlan.total,
          stage1Amount: executionPlan.stage1Amount,
          stage2Amount: executionPlan.stage2Amount,
          stage1Offset: executionPlan.stage1Offset,
          stage2Offset: executionPlan.stage2Offset,
          stage1Payable: executionPlan.stage1Payable,
          stage2Payable: executionPlan.stage2Payable,
          allocatedAdvance: executionPlan.allocatedAdvance,
          unallocatedAdvance: executionPlan.unallocatedAdvance,
          advanceAmount: executionPlan.advanceAmount,
          advanceOffsetMode: executionPlan.advanceOffsetMode,
          manualAdvanceOffsets: { ...executionPlan.manualAdvanceOffsets },
        } : null,
        executionActs: { ...executionActsState },
        deliveryRows: rowsToSave,
        deliverySchedules: cloneDeliverySchedules(deliverySchedules),
        scheduleItems: buildScheduleBreakdownForSave(),
        sent: sentStatus, sentDate: sentDateVal,
        items: [],
      });
      showToast(t('orders.saved'), 'success');
    }
  } else {
    const seq = getNextOrderSeq(contractId);
    const orderNumber = generateOrderNumber(contract, seq, programCode);
    savedOrder = addOrder({
      contractId, supplierId, programCode, programName, deliveryAddress, warehouseId, deliveryMode, status,
      orderNumber, seqNum: seq,
      readinessState: executionReadinessState,
      paymentScenario: executionPlan?.scenario || null,
      advancePercent: advanceSnapshot.percent,
      advanceAmount: advanceSnapshot.amount,
      paymentPlan: executionPlan ? {
        total: executionPlan.total,
        stage1Amount: executionPlan.stage1Amount,
        stage2Amount: executionPlan.stage2Amount,
        stage1Offset: executionPlan.stage1Offset,
        stage2Offset: executionPlan.stage2Offset,
        stage1Payable: executionPlan.stage1Payable,
        stage2Payable: executionPlan.stage2Payable,
        allocatedAdvance: executionPlan.allocatedAdvance,
        unallocatedAdvance: executionPlan.unallocatedAdvance,
        advanceAmount: executionPlan.advanceAmount,
        advanceOffsetMode: executionPlan.advanceOffsetMode,
        manualAdvanceOffsets: { ...executionPlan.manualAdvanceOffsets },
      } : null,
      executionActs: { ...executionActsState },
      deliveryRows: rowsToSave,
      deliverySchedules: cloneDeliverySchedules(deliverySchedules),
      scheduleItems: buildScheduleBreakdownForSave(),
      sent: sentStatus, sentDate: sentDateVal,
      items: [],
    });
    editingOrderId = savedOrder?.id ?? editingOrderId;
    showToast(t('orders.saved'), 'success');
  }

  syncOrderedToContract(contractId);
  refreshContractItemsOrdered(contractId);
  saveToStorage();
  updateOrdersBadge();
  renderRegistryList();
  if (savedOrder) {
    renderOrderCard();
    setOrderCardReadonly(false);
  }
}

// ─── Excel Export ─────────────────────────────────────────────────

async function exportOrderToExcel() {
  try {
    const { blob, fileName } = await buildOrderWordArtifact();
    downloadBlobFile(blob, fileName);
    showToast(t('orders.exportedFile', { name: fileName }), 'success');
  } catch (error) {
    console.error('[orders] export word failed', error);
    showToast(error?.message || 'Не удалось подготовить Word-файл заявки', 'error');
  }
}

// ─── Modal open/close ─────────────────────────────────────────────

export function openOrdersModal() {
  const overlay = $('ordersModal');
  if (!overlay) return;
  overlay.classList.add('open');
  registrySearchQuery = '';
  const searchInput = document.getElementById('ordersSearchInput');
  if (searchInput) searchInput.value = '';
  renderRegistryList();
  updateOrdersBadge();
}

export function closeOrdersModal() {
  const overlay = $('ordersModal');
  if (overlay) overlay.classList.remove('open');
}

// ─── Init ─────────────────────────────────────────────────────────

export function initOrdersView() {
  const overlay = $('ordersModal');
  if (overlay) {
    overlay.addEventListener('click', e => {
      if (e.target === overlay) closeOrdersModal();
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && overlay.classList.contains('open')) {
        const cardPanel = $('orderCardPanel');
        if (cardPanel && !cardPanel.classList.contains('hidden')) {
          closeOrderCard();
        } else {
          closeOrdersModal();
        }
      }
    });
  }

  const closeBtn = $('ordersCloseBtn');
  if (closeBtn) closeBtn.addEventListener('click', closeOrdersModal);

  const addBtn = $('addOrderBtn');
  if (addBtn) addBtn.addEventListener('click', () => openOrderCard(null));

  const cardBackBtn = $('orderCardBackBtn');
  if (cardBackBtn) cardBackBtn.addEventListener('click', closeOrderCard);

  const exportBtn = $('orderExportBtn');
  if (exportBtn) exportBtn.addEventListener('click', exportOrderToExcel);

  const templateBtn = $('orderTemplateBtn');
  if (templateBtn) templateBtn.addEventListener('click', downloadDispatchTemplate);

  const importBtn = $('orderImportBtn');
  const importInput = document.getElementById('orderImportFileInput');
  if (importBtn && importInput) {
    importBtn.addEventListener('click', () => importInput.click());
  }

  if (importInput) {
    importInput.addEventListener('change', async () => {
      const file = importInput.files?.[0];
      if (!file) return;
      await handleDispatchImportFile(file);
      importInput.value = '';
    });
  }

  const cardSaveBtn = $('orderCardSaveBtn');
  if (cardSaveBtn) cardSaveBtn.addEventListener('click', saveOrderCard);

  const cardEditBtn = $('orderCardEditBtn');
  if (cardEditBtn) cardEditBtn.addEventListener('click', () => setOrderCardReadonly(false));

  const searchInput = document.getElementById('ordersSearchInput');
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      registrySearchQuery = searchInput.value;
      renderRegistryList();
    });
  }
}
