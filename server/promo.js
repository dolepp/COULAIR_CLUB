/* Промокоды: DATA_DIR/promocodes.json
 *
 * {
 *   "TEST10": { "kind": "total", "value": 10, "maxUses": 1, "used": 0, "expires": null, "note": "проверка оплаты" }
 * }
 *
 * kind:
 *   percent — скидка value % на товары (доставка без скидки)
 *   amount  — скидка value ₽ со всего заказа
 *   total   — к оплате ровно value ₽ за весь заказ (для проверок)
 * maxUses — сколько раз можно оплатить (null — без ограничений); used растёт только после успешной оплаты.
 * expires — последний день действия, YYYY-MM-DD (по Москве), null — бессрочно.
 *
 * Управление: node promo.js list | add КОД total|percent|amount ЗНАЧЕНИЕ [--uses N] [--until ГГГГ-ММ-ДД] [--note "..."] | del КОД
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';

const FILE = path.join(config.dataDir, 'promocodes.json');
const KINDS = ['percent', 'amount', 'total'];

export const normCode = c => String(c || '').trim().toUpperCase().replace(/\s+/g, '');

function load() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

function save(all) {
  const tmp = FILE + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2) + '\n');
  fs.renameSync(tmp, FILE);
}

const today = () => new Date(Date.now() + 3 * 3600e3).toISOString().slice(0, 10); // Москва

export function promoLabel(p) {
  return p.kind === 'percent' ? `−${p.value}% на товары`
    : p.kind === 'amount' ? `−${p.value.toLocaleString('ru-RU')} ₽`
    : `к оплате ${p.value.toLocaleString('ru-RU')} ₽`;
}

/** Проверяет код. Возвращает { code, kind, value, label } или { error } */
export function findPromo(raw) {
  const code = normCode(raw);
  if (!code) return null;
  const p = load()[code];
  if (!p || !KINDS.includes(p.kind)) return { error: 'Такого промокода нет' };
  if (p.expires && today() > p.expires) return { error: 'Срок действия промокода закончился' };
  if (p.maxUses != null && (p.used || 0) >= p.maxUses) return { error: 'Промокод уже использован' };
  return { code, kind: p.kind, value: p.value, label: promoLabel(p) };
}

/** Итог с промокодом: { discount, total }. Минимум к оплате — 1 ₽ (ограничение ЮKassa). */
export function applyPromo(promo, goods, shipping) {
  const full = goods + shipping;
  if (!promo || promo.error) return { discount: 0, total: full };
  let total = promo.kind === 'percent' ? full - Math.round(goods * promo.value / 100)
    : promo.kind === 'amount' ? full - promo.value
    : promo.value;
  total = Math.min(full, Math.max(1, Math.round(total)));
  return { discount: full - total, total };
}

/** Отметить использование после успешной оплаты */
export function markPromoUsed(raw) {
  const code = normCode(raw);
  const all = load();
  if (!all[code]) return;
  all[code].used = (all[code].used || 0) + 1;
  all[code].lastUsedAt = new Date().toISOString();
  save(all);
}

/* ---------- командная строка ---------- */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, ...a] = process.argv.slice(2);
  const opt = n => { const i = a.indexOf(n); return i >= 0 ? a[i + 1] : undefined; };
  const all = load();
  if (cmd === 'add') {
    const [code, kind, value] = [normCode(a[0]), a[1], Number(a[2])];
    if (!code || !/^[A-Z0-9_-]{3,32}$/.test(code) || !KINDS.includes(kind) || !(value > 0)
        || (kind === 'percent' && value >= 100)) {
      console.error('Пример: node promo.js add TEST10 total 10 --uses 1 --until 2026-12-31 --note "проверка"\nkind: ' + KINDS.join(' | '));
      process.exit(1);
    }
    const uses = opt('--uses');
    all[code] = { kind, value, maxUses: uses ? Number(uses) : null, used: 0, expires: opt('--until') || null,
      note: opt('--note') || '', createdAt: new Date().toISOString() };
    save(all);
    console.log('OK', code, promoLabel(all[code]));
  } else if (cmd === 'del') {
    delete all[normCode(a[0])]; save(all); console.log('OK удалён');
  } else {
    for (const [c, p] of Object.entries(all)) {
      console.log(`${c}\t${promoLabel(p)}\tиспользован ${p.used || 0}/${p.maxUses ?? '∞'}\t${p.expires ? 'до ' + p.expires : 'бессрочно'}\t${p.note || ''}`);
    }
    if (!Object.keys(all).length) console.log('Промокодов нет');
  }
}
