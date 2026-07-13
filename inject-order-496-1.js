/**
 * Однократный инжектор данных заявки № 496-25КС/1
 * из документа 08-1634/26 от 08.05.2026.
 *
 * 5 адресов, итого 125 шт., 4 569 868,75 руб.
 *
 * v6: programCode берётся из строки contract.programs[0] (не .name).
 *     soApprovalRequired=false → заявка видна без прохождения СО.
 *
 * Вызывается из main.js после injectContract496().
 */

import { state } from '../state.js';
import { saveToStorage } from '../storage.js';

const INJECT_KEY = 'inject_order_496_1_done';
const INJECT_VER = '8';

export async function injectOrder496_1() {
  // ── Проверяем версию ──────────────────────────────────────────────
  try {
    const done = await miniappsAI.storage.getItem(INJECT_KEY);
    if (done === INJECT_VER) return;

    // Старая версия — удалить старую заявку
    if (done) {
      const idx = (state.orders || []).findIndex(o =>
        o.orderNumber === '496-25КС/1' || o.externalNumber === '496-25КС/1'
      );
      if (idx !== -1) {
        state.orders.splice(idx, 1);
        console.log('[inject-order-496-1] Старая заявка удалена, будет добавлена v6.');
      }
      await miniappsAI.storage.removeItem(INJECT_KEY);
    }
  } catch { /* storage unavailable */ }

  // ── 1. Найти контракт 496-25КС ────────────────────────────────────
  const contract = (state.contracts || []).find(c =>
    c.number && c.number.replace(/\s/g, '') === '496-25КС'
  );
  if (!contract) {
    console.warn('[inject-order-496-1] Контракт 496-25КС не найден. Пропускаем.');
    return;
  }

  // ── 2. Имя позиции из контракта ───────────────────────────────────
  const contractItem = contract.items && contract.items[0];
  const contractItemName = contractItem?.name
    ?? 'Электросушилка для рук металлическая "MERIDA STELLA R" ESM001.R';
  const contractItemCode = contractItem?.code ?? 'ESM001.R';
  const unitPrice = Number(contractItem?.price) || 36558.95;

  // ── 3. programCode — contract.programs это массив строк ───────────
  // Берём первую строку напрямую (не .name)
  const rawProgram = Array.isArray(contract.programs) && contract.programs.length > 0
    ? contract.programs[0]
    : null;
  // rawProgram может быть строкой 'КР2025-205.4' или объектом {name, code, ...}
  const programCode = rawProgram
    ? (typeof rawProgram === 'string' ? rawProgram : (rawProgram.code || rawProgram.name || ''))
    : 'КР2025-205.4';

  // ── 4. Строки заявки ─────────────────────────────────────────────
  const orderLines = [
    { address: 'г. Москва, Зеленоград, корп. 1469',                    recipientName: 'ГБОУ Школа № 1151', qty: 22 },
    { address: 'г. Москва, ул. Пырьева, д. 11',                        recipientName: 'ГБОУ Школа № 74',   qty: 25 },
    { address: 'г. Москва, пр-кт Федеративный, д. 27',                 recipientName: 'ГБОУ Школа № 1324', qty: 44 },
    { address: 'г. Москва, ул. Клинская, д. 24',                       recipientName: 'ГБОУ Школа № 1474', qty: 25 },
    { address: 'г. Москва, ул. Новопеределкинская, д. 9, корп. 1',     recipientName: 'ГБОУ Школа № 1596', qty:  9 },
  ];

  const totalQty   = orderLines.reduce((s, r) => s + r.qty, 0); // 125
  const totalPrice = Math.round(totalQty * unitPrice * 100) / 100;

  // ── 5. Проверить — нет ли уже такой заявки ───────────────────────
  const existingOrder = (state.orders || []).find(o =>
    o.contractId === contract.id &&
    (o.orderNumber === '496-25КС/1' || o.externalNumber === '496-25КС/1')
  );

  if (!existingOrder) {
    if (!Array.isArray(state.orders)) state.orders = [];
    if (!state.nextOrderId) state.nextOrderId = 1;

    const deliveryRows = orderLines.map(line => ({
      contractItemName,
      contractItemCode,
      price:         unitPrice,
      qty:           line.qty,
      date:          '2025-08-06',
      address:       line.address,
      recipientName: line.recipientName,
      recipientId:   (state.recipients || []).find(r =>
                       r.name && r.name.toLowerCase().includes(
                         line.recipientName.replace(/ГБОУ\s*/i, '').toLowerCase().trim()
                       )
                     )?.id ?? null,
    }));

    const newOrder = {
      id:             state.nextOrderId++,
      orderNumber:    '496-25КС/1',
      externalNumber: '496-25КС/1',
      seqNum:         1,
      contractId:     contract.id,
      supplierId:     contract.supplierId ?? null,
      programCode,
      date:           '2025-07-23',
      deadline:       '2025-08-06',
      status:         'sent',
      sent:           true,
      sentDate:       '2025-07-23',
      totalQty,
      totalPrice,
      deliveryRows,
      items: [],
      notes: [
        'Заявка № 496-25КС/1 на поставку товара.',
        'Срок поставки: по 06.08.2025.',
        'Итого: 125 шт., 4 569 868,75 руб.',
        '---',
        'Фактически поставлено (Сводный реестр накладных 11.11.2025): 82 шт., 2 997 833,90 руб.',
        'УПД № ЦБ-132/1 от 23.04.2026 — 60 шт., 2 193 537,00 руб.',
        'УПД № ЦБ-132/2 от 23.04.2026 — 22 шт., 804 296,90 руб.',
        'Аванс удержан: 913 973,75 руб.',
        'Претензия поставщику: № 04-3/26 от 12.01.2026.',
        'Документ: 08-1634/26 от 08.05.2026.',
      ].join('\n'),
      createdAt: new Date().toISOString(),
    };

    state.orders.push(newOrder);
    console.log('[inject-order-496-1] ✅ Заявка 496-25КС/1 добавлена v6, id=' + newOrder.id +
      ', programCode=' + programCode +
      ', строк: ' + deliveryRows.length + ', qty: ' + totalQty);
  } else {
    // Обновляем programCode у существующей заявки
    existingOrder.programCode = programCode;
    console.log('[inject-order-496-1] Заявка 496-25КС/1 уже существует (id=' + existingOrder.id + '), programCode обновлён.');
  }

  // ── 6. Обновить qty в позиции контракта ──────────────────────────
  if (contractItem) {
    contractItem.qty   = Math.max(contractItem.qty || 0, totalQty);
    contractItem.price = unitPrice;
    if (!contractItem.nmcd) contractItem.nmcd = unitPrice;
    if (!contract.date) contract.date = '2025-07-23';
  }

  // ── 7. Сохранить ──────────────────────────────────────────────────
  await saveToStorage();

  try {
    await miniappsAI.storage.setItem(INJECT_KEY, INJECT_VER);
  } catch { /* */ }

  console.log('[inject-order-496-1] ✅ Готово v6. programCode=' + programCode + ', qty=' + totalQty);
}
