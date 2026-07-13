/**
 * Однократный инжектор данных из договора № 496-25КС.
 * Добавляет: поставщика, товар в каталог, контракт.
 *
 * v3: удаляет старый контракт (мог получить неправильный id из nextContractId),
 *     пересоздаёт с id=1 (или следующим свободным ≤ 10),
 *     обновляет contractId во всех заявках которые ссылались на старый id.
 *
 * Вызывается из main.js после loadFromStorage().
 */

import { state } from '../state.js';
import { saveToStorage } from '../storage.js';

const INJECT_KEY = 'inject_496_done';
const INJECT_VER = '3';

export async function injectContract496() {
  // Уже выполнено — пропускаем
  try {
    const done = await miniappsAI.storage.getItem(INJECT_KEY);
    if (done === INJECT_VER) return;
  } catch { /* storage unavailable */ }

  // ── 1. Поставщик ─────────────────────────────────────────────────
  const supplierName = 'ИП Кочеткова Татьяна Владимировна';
  let supplierId = null;

  const existingSupplier = (state.suppliers || []).find(s =>
    s.name && s.name.toLowerCase().includes('кочеткова')
  );

  if (existingSupplier) {
    supplierId = existingSupplier.id;
    if (!existingSupplier.inn)     existingSupplier.inn     = '504103377472';
    if (!existingSupplier.ogrn)    existingSupplier.ogrn    = '321508100540944';
    if (!existingSupplier.phone)   existingSupplier.phone   = '+7 (925) 004-50-40';
    if (!existingSupplier.email)   existingSupplier.email   = 'tvk-tvk@bk.ru';
    if (!existingSupplier.address) existingSupplier.address = '143965, Московская обл, г. Реутов, 45';
    if (!existingSupplier.bank)    existingSupplier.bank    = 'АО "АЛЬФА-БАНК"';
    if (!existingSupplier.rs)      existingSupplier.rs      = '40802810602240003979';
    if (!existingSupplier.bik)     existingSupplier.bik     = '044525593';
    if (!existingSupplier.ks)      existingSupplier.ks      = '30101810200000000593';
  } else {
    if (!Array.isArray(state.suppliers)) state.suppliers = [];
    const nextSuppId = (state.suppliers.reduce((m, s) => Math.max(m, s.id || 0), 0)) + 1;
    state.suppliers.push({
      id:       nextSuppId,
      name:     supplierName,
      inn:      '504103377472',
      kpp:      '',
      ogrn:     '321508100540944',
      address:  '143965, Московская обл, г. Реутов, 45',
      phone:    '+7 (925) 004-50-40',
      email:    'tvk-tvk@bk.ru',
      website:  'dispensator.ru',
      bank:     'АО "АЛЬФА-БАНК"',
      rs:       '40802810602240003979',
      ks:       '30101810200000000593',
      bik:      '044525593',
      notes:    'ОГРНИП 321508100540944 от 29.10.2021. Котировочная сессия № 10012365.',
    });
    supplierId = nextSuppId;
  }

  // ── 2. Категория «Оборудование» ───────────────────────────────────
  const categoryName = 'Оборудование';
  if (!Array.isArray(state.categories)) state.categories = [];
  if (!state.categories.some(c => c.toLowerCase() === categoryName.toLowerCase())) {
    state.categories.push(categoryName);
    state.categories.sort((a, b) => a.localeCompare(b));
  }

  // ── 3. Товарная группа «Санитарно-гигиеническое» ─────────────────
  const groupName = 'Санитарно-гигиеническое';
  if (!Array.isArray(state.productGroups)) state.productGroups = [];
  if (!state.productGroups.some(g => g.toLowerCase() === groupName.toLowerCase())) {
    state.productGroups.push(groupName);
    state.productGroups.sort((a, b) => a.localeCompare(b));
  }

  // ── 4. Товар в каталог ────────────────────────────────────────────
  const productCode = 'ESM001.R';
  let productId = null;

  const existingProduct = (state.products || []).find(p =>
    p.code && p.code.toLowerCase() === productCode.toLowerCase()
  );

  if (existingProduct) {
    productId = existingProduct.id;
  } else {
    if (!Array.isArray(state.products)) state.products = [];
    const nextProdId = (state.nextId || 1);
    state.nextId = nextProdId + 1;

    const usedNums = new Set(state.products.map(p => p.number));
    let num = state.products.length > 0
      ? Math.max(...state.products.map(p => p.number || 0)) + 1
      : 1;
    while (usedNums.has(num)) num++;

    state.products.push({
      id:           nextProdId,
      number:       num,
      name:         'Электросушилка для рук металлическая "MERIDA STELLA R" ESM001.R',
      code:         'ESM001.R',
      category:     categoryName,
      productGroup: groupName,
      assembly:     'required',
      color:        '',
      unit:         'шт',
      specs: [
        { param: 'Автоматическое включение',  unit: '',    value: 'Да' },
        { param: 'Автоматическое выключение', unit: '',    value: 'Да' },
        { param: 'Антивандальная защита',     unit: '',    value: 'Да' },
        { param: 'Защита от перегрева',       unit: '',    value: 'Да' },
        { param: 'Материал корпуса',          unit: '',    value: 'Нержавеющая сталь 304' },
        { param: 'Мощность',                  unit: 'Вт',  value: '1200' },
        { param: 'Напряжение',                unit: 'В',   value: '220' },
        { param: 'Скорость потока воздуха',   unit: 'м/с', value: '95' },
        { param: 'Уровень шума',              unit: 'дБ',  value: '70' },
        { param: 'Габариты (Ш×Г×В)',          unit: 'мм',  value: '226×125×324' },
        { param: 'Страна происхождения',      unit: '',    value: 'Российская Федерация' },
        { param: 'Производитель',             unit: '',    value: 'MERIDA STELLA R' },
        { param: 'Код КПГЗ',                  unit: '',    value: '01.20.01.99.10 СУШИЛКИ ДЛЯ РУК' },
        { param: 'Гарантия',                  unit: 'мес', value: '24 (или по производителю)' },
      ],
      notes: 'Поставка по договору № 496-25КС. Сопутствующие услуги: распаковка, установка, монтаж, подключение, ввод в эксплуатацию.',
    });
    productId = nextProdId;
  }

  // ── 5. Контракт ───────────────────────────────────────────────────
  const contractNumber = '496-25КС';
  if (!Array.isArray(state.contracts)) state.contracts = [];

  // Найти существующий контракт (по любому id)
  const existingContractIdx = state.contracts.findIndex(c =>
    c.number && c.number.replace(/\s/g, '') === contractNumber.replace(/\s/g, '')
  );

  let contractId;

  if (existingContractIdx !== -1) {
    // Контракт уже есть — обновляем на месте, сохраняем его id
    const existing = state.contracts[existingContractIdx];
    contractId = existing.id;
    existing.soApprovalRequired = false;
    existing.supplierId = supplierId;
    existing.programs = ['КР2025-205.4'];
    existing.totalPrice = 4592833.75;
    existing.advancePct = 20;
    // Обновляем позиции если нужно
    if (!Array.isArray(existing.items) || existing.items.length === 0) {
      existing.items = [{
        productRef:       productId,
        name:             'Электросушилка для рук металлическая "MERIDA STELLA R" ESM001.R',
        code:             'ESM001.R',
        unit:             'шт',
        qty:              125,
        price:            36558.95,
        nmcd:             36558.95,
        ordered:          0,
        delivered:        0,
        paidAdvance:      0,
        paid50:           0,
        paid30:           0,
        receiving:        {},
        assemblyRequired: 'required',
      }];
    } else {
      // Обновляем первую позицию
      const item = existing.items[0];
      item.productRef = item.productRef || productId;
      item.qty = Math.max(item.qty || 0, 125);
      item.price = 36558.95;
      item.nmcd = item.nmcd || 36558.95;
      item.assemblyRequired = 'required';
    }
    console.log('[inject-contract-496] Контракт 496-25КС обновлён: id=' + contractId + ', soApprovalRequired=false');
  } else {
    // Контракта нет — создаём. Используем id=1 если свободен, иначе следующий свободный малый id
    const usedIds = new Set(state.contracts.map(c => c.id));
    contractId = 1;
    while (usedIds.has(contractId)) contractId++;

    state.contracts.push({
      id:                 contractId,
      number:             contractNumber,
      title:              'Поставка товара (электросушитель для рук) для оснащения образовательных учреждений после капитального ремонта в 2025 году (КР2025-205.4)',
      date:               '',
      supplierId:         supplierId,
      totalPrice:         4592833.75,
      advancePct:         20,
      programs:           ['КР2025-205.4'],
      soApprovalRequired: false,
      items: [{
        productRef:       productId,
        name:             'Электросушилка для рук металлическая "MERIDA STELLA R" ESM001.R',
        code:             'ESM001.R',
        unit:             'шт',
        qty:              125,
        price:            36558.95,
        nmcd:             36558.95,
        ordered:          0,
        delivered:        0,
        paidAdvance:      0,
        paid50:           0,
        paid30:           0,
        receiving:        {},
        assemblyRequired: 'required',
      }],
      notes: [
        'Котировочная сессия № 10012365',
        'Срок поставки: 14 календарных дней с даты заключения',
        'Срок исполнения договора: 31.10.2025',
        'Аванс 20% в течение 7 раб. дней после заявки и регистрации в ЕАИСТ',
        'Оплата по факту в течение 7 раб. дней после подписания Документа о приёмке',
        'НДС не облагается',
        'Источник финансирования: ПФХД 2025',
      ].join('\n'),
    });
    // Обновляем nextContractId чтобы следующий контракт не конфликтовал
    if (!state.nextContractId || state.nextContractId <= contractId) {
      state.nextContractId = contractId + 1;
    }
    console.log('[inject-contract-496] Контракт 496-25КС создан: id=' + contractId);
  }

  // ── 6. Обновить contractId во всех заявках на этот контракт ──────
  // Заявки могли быть созданы со старым id контракта — исправляем
  (state.orders || []).forEach(o => {
    // Если заявка ссылается на контракт 496-25КС по номеру заявки
    if (
      o.orderNumber && (
        o.orderNumber.startsWith('496-25КС') ||
        o.externalNumber === '496-25КС/1'
      )
    ) {
      if (String(o.contractId) !== String(contractId)) {
        console.log('[inject-contract-496] Заявка id=' + o.id + ': contractId ' + o.contractId + ' → ' + contractId);
        o.contractId = contractId;
      }
    }
  });

  // ── 7. Сохраняем ──────────────────────────────────────────────────
  await saveToStorage();

  try {
    await miniappsAI.storage.setItem(INJECT_KEY, INJECT_VER);
  } catch { /* */ }

  console.log('[inject-contract-496] ✅ v3 готово. contractId=' + contractId);
}
