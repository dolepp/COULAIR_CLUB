/* =====================================================================
   Coulair API — настройки.
   Секреты (ключи СДЭК, ЮKassa, почта, бот) — в файле .env, см. .env.example.
   Правила упаковки — ниже, в PACKAGING: их меняют руками.
   ===================================================================== */
const env = process.env;
const bool = v => /^(1|true|yes|on)$/i.test(String(v || '').trim());
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));

export const config = {
  port: num(env.PORT, 3100),
  siteUrl: (env.SITE_URL || 'https://coulair.ru').replace(/\/$/, ''),
  // Отсюда берутся товары и цены: catalog/catalog.js и CONFIG в js/main.js
  siteDir: env.SITE_DIR || '/var/www/coulair/current',
  dataDir: env.DATA_DIR || '/var/lib/coulair-api',
  shopName: env.SHOP_NAME || 'Coulair Club',

  cdek: {
    // Без ключей работает тестовый контур СДЭК (цены примерные)
    account: env.CDEK_ACCOUNT || '',
    secure: env.CDEK_SECURE || '',
    // Код города отправки в справочнике СДЭК (44 — Москва, 137 — Санкт-Петербург, 250 — Екатеринбург)
    fromCityCode: num(env.CDEK_FROM_CITY_CODE, 44),
    // 136 — Посылка склад-склад, 368 — Посылка склад-постамат.
    // Если сдаёте через курьера СДЭК от двери: 138 и 366.
    tariffs: {
      PVZ: num(env.CDEK_TARIFF_PVZ, 136),
      POSTAMAT: num(env.CDEK_TARIFF_POSTAMAT, 368),
    },
    // Наценка к расчёту СДЭК (например, на упаковку), ₽
    markup: num(env.CDEK_MARKUP, 0),
    // Фиксированная цена доставки, ₽ (0 — считать по СДЭК)
    flat: {
      PVZ: num(env.DELIVERY_FLAT_PVZ, 0),
      POSTAMAT: num(env.DELIVERY_FLAT_POSTAMAT, 0),
    },
    // table — своя таблица зон (расстояние от города отправки × вес), api — калькулятор СДЭК.
    // Без ключей СДЭК по умолчанию table: тестовый калькулятор даёт неверные цены и сроки.
    calc: env.CDEK_CALC || '',
    // Координаты города отправки (по умолчанию Нижний Тагил)
    fromLat: num(env.CDEK_FROM_LAT, 57.9076),
    fromLng: num(env.CDEK_FROM_LNG, 59.9722),
    // Зоны: до км → первый кг, каждый следующий кг, срок от, срок до (дней).
    // Переопределяется: TARIFF_ZONES=50:260:30:1:2,400:340:45:2:3,…
    zones: (env.TARIFF_ZONES || '50:260:30:1:2,400:340:45:2:3,1200:430:70:3:5,2500:520:95:4:7,4000:650:130:5:9,6000:800:170:7:12,99999:980:220:9:15')
      .split(',').map(z => z.split(':').map(Number)).filter(z => z.length === 5 && z.every(Number.isFinite))
      .map(([km, first, perKg, daysMin, daysMax]) => ({ km, first, perKg, daysMin, daysMax }))
      .sort((a, b) => a.km - b.km),
  },

  yookassa: {
    shopId: env.YOOKASSA_SHOP_ID || '',
    secretKey: env.YOOKASSA_SECRET_KEY || '',
    // Чеки 54-ФЗ через ЮKassa: 1 — передавать состав заказа в платёж
    receipt: bool(env.YOOKASSA_RECEIPT),
    // Ставка НДС в чеке: 1 — без НДС, 2 — 0%, 3 — 10%, 4 — 20%, 11 — 5% (УСН), 12 — 7% (УСН)
    vatCode: num(env.YOOKASSA_VAT_CODE, 1),
    // Признак способа расчёта в чеке: full_payment или full_prepayment
    paymentMode: env.YOOKASSA_PAYMENT_MODE || 'full_payment',
  },

  mail: {
    host: env.SMTP_HOST || '',
    port: num(env.SMTP_PORT, 465),
    secure: env.SMTP_SECURE === undefined ? true : bool(env.SMTP_SECURE),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || env.SMTP_USER || '',
    // Копия каждого письма клиенту — себе (необязательно)
    bcc: env.MAIL_BCC || '',
  },

  telegram: {
    token: env.TG_BOT_TOKEN || '',
    // Можно несколько через запятую: личка, группа
    chatIds: (env.TG_CHAT_ID || '').split(',').map(s => s.trim()).filter(Boolean),
  },

  // Поддержка — кнопка в письме клиенту
  contactTelegram: env.CONTACT_TELEGRAM || 'https://t.me/coulair',
  // Продавец — в подвале письма
  seller: env.SELLER || 'ИП Романов Александр Дмитриевич',
};

/* ---------------------------------------------------------------------
   Упаковка: как из корзины получаются места (посылки) для СДЭК.
   Размеры — сантиметры, вес — граммы.
   --------------------------------------------------------------------- */
export const PACKAGING = {
  // Вес одной вещи без упаковки
  itemWeight: { pants: 900, helmet: 900, boots: 2500, other: 1000 },

  // Одни штаны едут в своей упаковке
  pantsSingle: { name: 'Своя упаковка', length: 35, width: 30, height: 5, weight: 50 },

  // Двое и больше штанов — коробка СДЭК M; capacity — сколько штанов в неё влезает
  pantsBox: { name: 'Коробка M', length: 33, width: 25, height: 15, weight: 200, capacity: 3 },

  // Шлемы и ботинки — каждый отдельным местом в своей коробке
  separate: {
    helmet: { name: 'Коробка для шлема', length: 33, width: 25, height: 25, weight: 200 },
    boots:  { name: 'Коробка для ботинок', length: 40, width: 35, height: 25, weight: 300 },
    other:  { name: 'Коробка', length: 33, width: 25, height: 15, weight: 200 },
  },
};
