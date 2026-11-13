/* Google Sheets — остатки по партиям и оплаченные продажи.
   Один процесс API: очередь объединяет чтение, резерв и запись без гонок. */
import fs from 'node:fs';
import { BadRequest } from './products.js';
import { listOrders, getOrder, saveOrder } from './store.js';

const ID = process.env.SHEETS_ID || '';
const TOKEN = process.env.SHEETS_TOKEN_FILE || '';
export const sheetsEnabled = () => !!(ID && TOKEN);
let auth = { expires: 0 }, cache = null, tail = Promise.resolve();
const locked = fn => { const p = tail.then(fn); tail = p.catch(() => {}); return p; };

async function accessToken() {
  if (auth.expires > Date.now()) return auth.token;
  const c = JSON.parse(fs.readFileSync(TOKEN, 'utf8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', body: new URLSearchParams({ client_id: c.client_id, client_secret: c.client_secret,
      refresh_token: c.refresh_token, grant_type: 'refresh_token' }), signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) throw new Error('Google: не удалось обновить доступ (' + res.status + ')');
  auth = { token: data.access_token, expires: Date.now() + (data.expires_in - 120) * 1000 };
  return auth.token;
}

async function api(route, body) {
  const res = await fetch('https://sheets.googleapis.com/v4/spreadsheets/' + ID + route, {
    method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + await accessToken(),
      ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000),
  });
  const data = await res.json();
  if (!res.ok) throw new Error('Google Таблица: HTTP ' + res.status);
  return data;
}

export function parseBatches(rows) {
  const batches = [];
  for (const [i, r] of rows.entries()) {
    if (!String(r[0] || '').trim() || !String(r[1] || '').trim()) continue;
    const size = String(r[1]).trim().toUpperCase();
    if (!/^[A-Z0-9-]{1,8}$/.test(size)) throw new Error('Некорректный размер в строке ' + (i + 5));
    const remaining = Number(r[4]);
    if (r[4] === '' || r[4] == null || !Number.isFinite(remaining) || !Number.isInteger(remaining)) {
      throw new Error('Некорректный остаток в строке ' + (i + 5));
    }
    batches.push({ batch: String(r[0]).trim(), size, remaining, row: i + 5 });
  }
  if (!batches.length) throw new Error('В таблице нет партий');
  return batches;
}

async function snapshot(force = false) {
  if (!force && cache && Date.now() - cache.at < 15000) return cache;
  const params = new URLSearchParams({ valueRenderOption: 'UNFORMATTED_VALUE' });
  params.append('ranges', "'Партии'!A5:F"); params.append('ranges', "'Заказы'!A9:P");
  const r = await api('/values:batchGet?' + params);
  const rows = r.valueRanges[1].values || [];
  cache = { at: Date.now(), batches: parseBatches(r.valueRanges[0].values || []), rows,
    keys: new Set(rows.map(x => x[15]).filter(Boolean)) };
  return cache;
}

const unitKey = (order, itemIndex, unit) => `site:${order.id}:${itemIndex}:${unit}`;
function remainingBatches(s) {
  const batches = s.batches.map(b => ({ ...b }));
  for (const o of listOrders()) {
    if (!['pending', 'paid'].includes(o.status)) continue;
    for (const a of o.inventoryAllocations || []) {
      if (s.keys.has(a.key)) continue; // Таблица уже учла эту единицу.
      const b = batches.find(b => b.batch === a.batch && b.size === a.size);
      if (b) b.remaining -= 1;
    }
  }
  return batches;
}
function sizesFrom(batches) {
  const sizes = {};
  for (const b of batches) sizes[b.size] = (sizes[b.size] || 0) + Math.max(0, b.remaining);
  return sizes;
}
export async function availability() {
  if (!sheetsEnabled()) return { enabled: false };
  return locked(async () => {
    const s = await snapshot();
    return { enabled: true, checkedAt: new Date(s.at).toISOString(), sizes: sizesFrom(remainingBatches(s)) };
  });
}

function allocate(items, batches) {
  const allocations = [];
  items.forEach((it, itemIndex) => {
    if (it.id !== 'pants') return;
    const size = String(it.size || '').toUpperCase();
    for (let unit = 0; unit < it.qty; unit++) {
      const b = batches.find(b => b.size === size && b.remaining > 0);
      if (!b) throw new BadRequest(`Размер ${size} закончился или уже зарезервирован — обновите корзину`);
      b.remaining -= 1;
      allocations.push({ itemIndex, unit, batch: b.batch, size });
    }
  });
  return allocations;
}
export async function checkStock(items) {
  if (!sheetsEnabled() || !items.some(i => i.id === 'pants')) return;
  return locked(async () => allocate(items, remainingBatches(await snapshot())));
}
export async function reserveOrder(items, create) {
  if (!sheetsEnabled() || !items.some(i => i.id === 'pants')) return create([]);
  return locked(async () => {
    const allocations = allocate(items, remainingBatches(await snapshot(true)));
    // create() сохраняет заказ и резерв синхронно до освобождения очереди.
    return create(allocations);
  });
}
export function identifyAllocations(order, allocations) {
  return allocations.map(a => ({ ...a, key: unitKey(order, a.itemIndex, a.unit) }));
}

const splitCents = (total, n, i) => (Math.floor(Math.round(total * 100) / n) + (i < Math.round(total * 100) % n ? 1 : 0)) / 100;
export function saleRows(order, firstRow, existingKeys) {
  const units = order.items.flatMap((it, itemIndex) => Array.from({ length: it.qty }, (_, unit) => ({ it, itemIndex, unit })));
  const date = new Intl.DateTimeFormat('ru-RU', { timeZone: 'Europe/Moscow' }).format(new Date(order.paidAt));
  let row = firstRow;
  return units.flatMap(({ it, itemIndex, unit }, i) => {
    const key = unitKey(order, itemIndex, unit);
    if (existingKeys.has(key)) return [];
    const a = (order.inventoryAllocations || []).find(a => a.key === key);
    if (it.id === 'pants' && !a) throw new Error('Нет партии для оплаченного заказа ' + order.id);
    const n = row++;
    // Оплата распределяется поштучно: сумма строк точно равна сумме платежа.
    return [{ range: `'Заказы'!A${n}:P${n}`, values: [[
      `=IF(C${n}="","",COUNTA($C$9:C${n}))`, date, splitCents(order.total, units.length, i),
      splitCents(order.delivery.cdekCost || 0, units.length, i), 'ЮKassa', 'Ждёт',
      `=IF(OR(C${n}="",E${n}<>"ЮKassa"),"",C${n}*$C$5)`,
      it.id === 'pants' ? `=IF(C${n}="","",C${n}-$C$4-N(D${n})-N(G${n}))` : '',
      `Сайт, заказ №${order.id}; ${it.name}`, order.delivery.cityName || '', it.size || '',
      a?.batch || '', order.delivery.customerCost > 0 ? 'Оплачена' : 'Не оплачена',
      it.id === 'pants' ? 'штаны' : it.name, it.id === 'pants' ? 'черный' : '', key,
    ]] }];
  });
}
export async function syncSale(order) {
  if (!sheetsEnabled() || !order.inventoryTracked || order.status !== 'paid') return;
  return locked(async () => {
    const s = await snapshot(true);
    // Формулы и оформление ниже таблицы не считаются заполненными заказами.
    const last = s.rows.reduce((last, r, i) => r[2] !== '' && r[2] != null ? i + 9 : last, 8);
    const data = saleRows(order, last + 1, s.keys);
    if (data.length) {
      const separator = process.env.SHEETS_FORMULA_SEPARATOR || ',';
      const formatted = data.map(r => ({ ...r, values: r.values.map(row => row.map(v =>
        typeof v === 'string' && v.startsWith('=') ? v.replaceAll(',', separator) : v)) }));
      await api('/values:batchUpdate', { valueInputOption: 'USER_ENTERED', data: formatted });
      cache = null;
    }
    // Берём свежий объект: запись в таблицу не должна затирать статусы уведомлений.
    const fresh = getOrder(order.id);
    if (fresh) { fresh.sheetSyncedAt = new Date().toISOString(); delete fresh.sheetSyncError; saveOrder(fresh); }
  });
}
