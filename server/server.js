/* Coulair API: /api/… за nginx.
   Корзина → расчёт СДЭК → заказ → платёж ЮKassa → (webhook) письмо клиенту + заявка в Telegram */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { normalizeItems, buildPackages, BadRequest } from './products.js';
import { suggestCities, deliveryPoints, quote, cdekMode } from './cdek.js';
import { createPayment, getPayment, yookassaReady } from './yookassa.js';
import { createOrder, getOrder, saveOrder } from './store.js';
import { telegramText, sendTelegram, sendOrderEmail } from './notify.js';

// Только для локальной проверки: заказ считается оплаченным без ЮKassa. На сервере не включать!
const FAKE_PAYMENT = process.env.DEV_FAKE_PAYMENT === '1';

/* ---------- утилиты ---------- */
function send(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(body);
}

function readJson(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new BadRequest('Слишком большой запрос')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new BadRequest('Неверный JSON')); }
    });
    req.on('error', reject);
  });
}

// Ограничение частоты запросов с одного IP
const hits = new Map();
function limited(req, bucket, perMinute) {
  const ip = req.headers['x-real-ip'] || req.socket.remoteAddress;
  const key = bucket + ':' + ip, now = Date.now();
  const h = hits.get(key) || { n: 0, reset: now + 60e3 };
  if (now > h.reset) { h.n = 0; h.reset = now + 60e3; }
  h.n += 1;
  hits.set(key, h);
  if (hits.size > 20000) hits.clear();
  return h.n > perMinute;
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/* ---------- проверка анкеты ---------- */
function cleanContact(c = {}) {
  const str = (v, max) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const name = str(c.name, 120);
  const email = str(c.email, 120).toLowerCase();
  const noTelegram = !!c.noTelegram;
  const telegram = noTelegram ? '' : str(c.telegram, 64).replace(/^(?:https?:\/\/)?t\.me\//i, '');
  let digits = String(c.phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits[0] === '8') digits = '7' + digits.slice(1);

  const errors = {};
  if (name.split(' ').filter(w => w.length > 1).length < 2) errors.name = 'Укажите фамилию и имя полностью';
  if (!/^7\d{10}$/.test(digits)) errors.phone = 'Проверьте номер телефона';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) errors.email = 'Проверьте email';
  if (!noTelegram && !/^(?:@?[A-Za-z0-9_]{4,32}|\+?[\d\s()-]{10,18})$/.test(telegram)) errors.telegram = 'Укажите Telegram или отметьте «Нет Telegram»';
  if (Object.keys(errors).length) { const e = new BadRequest('Проверьте выделенные поля'); e.fields = errors; throw e; }

  const phone = `+7 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7, 9)}-${digits.slice(9, 11)}`;
  return { name, phone, email, telegram, noTelegram };
}

/* ---------- расчёт корзины и доставки ---------- */
async function calc(items, cityCode) {
  const cart = normalizeItems(items);
  const packages = buildPackages(cart.items);
  const delivery = cityCode ? await quote(cityCode, packages) : null;
  return { ...cart, packages, delivery };
}

// Влезает ли каждое место в какую-нибудь ячейку постамата (размеры по убыванию)
const boxesOf = packages => packages.map(p => [p.length, p.width, p.height].sort((a, b) => b - a));
const fitsCells = (boxes, cells) => !cells || !cells.length
  || boxes.every(b => cells.some(c => b.every((v, i) => v <= c[i])));

/* ---------- оплата прошла / отменена ---------- */
const busy = new Set();
async function applyPayment(order, payment) {
  if (!payment || busy.has(order.id)) return order;
  busy.add(order.id);
  try {
    order = getOrder(order.id) || order;            // свежая версия с диска
    if (order.status === 'paid') return order;
    order.payment = { ...order.payment, id: payment.id, status: payment.status };

    if (payment.status === 'succeeded') {
      const paid = Number(payment.amount && payment.amount.value);
      if (Math.abs(paid - order.total) > 0.009 || String(payment.metadata && payment.metadata.order_id) !== order.id) {
        console.error('[order]', order.id, 'сумма или номер не совпадают с платежом', payment.id);
        order.status = 'mismatch';
        saveOrder(order);
        await sendTelegram(`⚠️ Заказ №${order.id}: платёж ${payment.id} не совпал по сумме (${paid} ≠ ${order.total}). Проверьте вручную.`).catch(() => {});
        return order;
      }
      order.status = 'paid';
      order.paidAt = payment.captured_at || new Date().toISOString();
      order.notified = order.notified || {};
      saveOrder(order);
      console.info('[order]', order.id, 'оплачен', order.total);

      try { order.notified.telegram = await sendTelegram(telegramText(order)); }
      catch (e) { console.error('[order]', order.id, e.message); order.notified.telegramError = e.message; }
      try { order.notified.email = await sendOrderEmail(order); }
      catch (e) {
        console.error('[order]', order.id, 'письмо:', e.message);
        order.notified.emailError = e.message;
        await sendTelegram(`⚠️ Заказ №${order.id}: не удалось отправить письмо клиенту (${e.message}).`).catch(() => {});
      }
      saveOrder(order);
    } else if (payment.status === 'canceled') {
      order.status = 'canceled';
      order.cancelReason = payment.cancellation_details && payment.cancellation_details.reason;
      saveOrder(order);
    }
    return order;
  } finally {
    busy.delete(order.id);
  }
}

function publicOrder(o) {
  return {
    id: o.id, status: o.status, createdAt: o.createdAt, paidAt: o.paidAt || null,
    items: o.items.map(({ name, size, qty, price, image }) => ({ name, size, qty, price, image })),
    goods: o.goods, total: o.total, fromCart: !!o.fromCart, email: o.contact.email,
    delivery: {
      type: o.delivery.point.type, city: o.delivery.cityName, address: o.delivery.point.address,
      cost: o.delivery.customerCost, daysMin: o.delivery.daysMin, daysMax: o.delivery.daysMax,
    },
    paymentUrl: o.status === 'pending' && o.payment ? o.payment.url : null,
  };
}

/* ---------- маршруты ---------- */
const routes = {
  'GET /api/health': async () => ({ ok: true, cdek: cdekMode, yookassa: yookassaReady() }),

  'GET /api/cdek/cities': async (req, url) => {
    if (limited(req, 'geo', 120)) return [429, { error: 'Слишком много запросов' }];
    return { cities: await suggestCities(url.searchParams.get('q')) };
  },

  'GET /api/cdek/points': async (req, url) => {
    if (limited(req, 'geo', 120)) return [429, { error: 'Слишком много запросов' }];
    return { points: await deliveryPoints(url.searchParams.get('city')) };
  },

  'POST /api/quote': async req => {
    if (limited(req, 'quote', 60)) return [429, { error: 'Слишком много запросов' }];
    const body = await readJson(req);
    const r = await calc(body.items, Number(body.cityCode) || null);
    return {
      items: r.items, count: r.count, goods: r.goods, freeShipping: r.freeShipping,
      weight: r.packages.reduce((s, p) => s + p.weight, 0),
      boxes: boxesOf(r.packages),
      delivery: r.delivery,
    };
  },

  'POST /api/orders': async req => {
    if (limited(req, 'order', 10)) return [429, { error: 'Слишком много попыток, подождите минуту' }];
    const body = await readJson(req);
    if (!body.agree) throw new BadRequest('Подтвердите согласие с политикой конфиденциальности и офертой');
    const contact = cleanContact(body.contact);
    const cityCode = Number(body.cityCode);
    if (!cityCode) throw new BadRequest('Выберите город доставки');

    const r = await calc(body.items, cityCode);
    const point = (await deliveryPoints(cityCode)).find(p => p.code === String(body.pointCode || ''));
    if (!point) throw new BadRequest('Выберите пункт выдачи или постамат на карте');
    const weight = r.packages.reduce((s, p) => s + p.weight, 0);
    if (point.weightMax && weight / 1000 > point.weightMax) throw new BadRequest('Посылка слишком тяжёлая для этого пункта — выберите другой');
    if (point.type === 'POSTAMAT' && !fitsCells(boxesOf(r.packages), point.cells)) throw new BadRequest('Посылка не помещается в этот постамат — выберите пункт выдачи');
    const q = r.delivery && r.delivery[point.type];
    if (!q) throw new BadRequest(point.type === 'POSTAMAT' ? 'В постамат этот заказ не доставить — выберите пункт выдачи' : 'СДЭК не доставляет в этот пункт — выберите другой');

    const customerCost = r.freeShipping ? 0 : q.cost;
    const order = createOrder({
      contact,
      comment: String(body.comment || '').trim().slice(0, 1000),
      items: r.items, goods: r.goods, count: r.count,
      packages: r.packages,
      delivery: {
        cityCode, cityName: point.city || String(body.cityName || '').slice(0, 100),
        point: { code: point.code, type: point.type, name: point.name, address: point.address, workTime: point.workTime },
        tariff: q.tariff, cdekCost: q.cost, fixed: !!q.fixed, daysMin: q.daysMin, daysMax: q.daysMax,
        free: r.freeShipping, customerCost,
      },
      total: r.goods + customerCost,
      fromCart: !!body.fromCart,
    });

    if (FAKE_PAYMENT) {
      await applyPayment(order, { id: 'fake-' + order.id, status: 'succeeded', amount: { value: order.total.toFixed(2) }, metadata: { order_id: order.id } });
      return { id: order.id, paymentUrl: `/order/?id=${order.id}&t=${order.token}` };
    }

    try {
      const payment = await createPayment(order);
      order.payment = { id: payment.id, status: payment.status, url: payment.confirmation && payment.confirmation.confirmation_url };
      saveOrder(order);
      return { id: order.id, paymentUrl: order.payment.url };
    } catch (e) {
      order.status = 'error'; order.error = e.message; saveOrder(order);
      console.error('[order]', order.id, e.message);
      return [502, { error: 'Не удалось создать платёж. Попробуйте ещё раз или напишите нам в Telegram.' }];
    }
  },

  'GET /api/order': async (req, url) => {
    let order = getOrder(url.searchParams.get('id'));
    if (!order || !safeEqual(order.token, url.searchParams.get('t') || '')) return [404, { error: 'Заказ не найден' }];
    // webhook мог ещё не дойти — спрашиваем ЮKassa напрямую (не чаще раза в 3 секунды)
    if (order.status === 'pending' && order.payment && order.payment.id && !limited(req, 'status:' + order.id, 20)) {
      try { order = await applyPayment(order, await getPayment(order.payment.id)); }
      catch (e) { console.warn('[order]', order.id, 'статус:', e.message); }
    }
    return { order: publicOrder(order) };
  },

  // ЮKassa → уведомления payment.succeeded / payment.canceled.
  // Телу не доверяем: статус платежа всегда перепроверяем запросом в API.
  'POST /api/yookassa/webhook': async req => {
    const body = await readJson(req);
    const id = body && body.object && body.object.id;
    if (!id || !String(body.event || '').startsWith('payment.')) return { ok: true };
    const payment = await getPayment(id);
    const order = getOrder(payment.metadata && payment.metadata.order_id);
    if (!order) { console.warn('[webhook] нет заказа для платежа', id); return { ok: true }; }
    await applyPayment(order, payment);
    return { ok: true };
  },
};

/* ---------- статика (только для локальной проверки, на сервере её отдаёт nginx) ---------- */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary', '.woff2': 'font/woff2' };
function serveStatic(res, pathname) {
  const root = fs.realpathSync(config.siteDir);
  let file = path.join(root, decodeURIComponent(pathname));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  if (!fs.existsSync(file)) { res.writeHead(404).end('Not found'); return; }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://local');
  const handler = routes[req.method + ' ' + url.pathname];
  if (!handler) {
    if (process.env.SERVE_STATIC === '1' && req.method === 'GET' && !url.pathname.startsWith('/api/')) return serveStatic(res, url.pathname);
    return send(res, 404, { error: 'Not found' });
  }
  try {
    const out = await handler(req, url);
    if (Array.isArray(out)) send(res, out[0], out[1]); else send(res, 200, out);
  } catch (e) {
    if (e instanceof BadRequest) return send(res, 400, { error: e.message, fields: e.fields });
    console.error(req.method, url.pathname, e);
    send(res, 502, { error: /СДЭК/.test(e.message) ? e.message : 'Ошибка сервера, попробуйте ещё раз' });
  }
});

server.listen(config.port, '127.0.0.1', () => {
  console.info(`coulair-api :${config.port} · СДЭК ${cdekMode} · ЮKassa ${yookassaReady() ? 'on' : 'нет ключей'}${FAKE_PAYMENT ? ' · ТЕСТОВАЯ ОПЛАТА' : ''}`);
});
