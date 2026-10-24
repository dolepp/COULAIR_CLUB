/* Товары и цены берутся прямо с сайта — единственный источник правды.
   Клиент присылает только id, размер и количество; цену сервер считает сам. */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { config, PACKAGING } from './config.js';

let cache = { key: '' };

export function loadProducts() {
  const dir = fs.realpathSync(config.siteDir);
  const catFile = path.join(dir, 'catalog/catalog.js');
  const mainFile = path.join(dir, 'js/main.js');
  const key = [dir, fs.statSync(catFile).mtimeMs, fs.statSync(mainFile).mtimeMs].join('|');
  if (cache.key === key) return cache;

  const sandbox = { window: {} };
  vm.runInNewContext(fs.readFileSync(catFile, 'utf8'), sandbox, { timeout: 1000 });

  // CONFIG в main.js — чистый литерал с данными: вырезаем и вычисляем отдельно
  const m = fs.readFileSync(mainFile, 'utf8').match(/const CONFIG = (\{[\s\S]*?\n\});/);
  if (!m) throw new Error('CONFIG не найден в js/main.js');
  const CONFIG = vm.runInNewContext('(' + m[1] + ')', {}, { timeout: 1000 });

  const list = [CONFIG.pants, ...(sandbox.window.CATALOG || [])].filter(Boolean);
  cache = { key, list, byId: new Map(list.map(p => [p.id, p])), freeShippingFrom: CONFIG.freeShippingFrom || 0 };
  return cache;
}

export class BadRequest extends Error {}

const absUrl = p => (p && /^https?:/.test(p) ? p : config.siteUrl + '/' + String(p || '').replace(/^\.?\//, ''));

// Проверяет корзину и возвращает строки заказа с ценами сервера
export function normalizeItems(raw) {
  const { byId, freeShippingFrom } = loadProducts();
  if (!Array.isArray(raw) || !raw.length) throw new BadRequest('Корзина пустая');
  if (raw.length > 30) throw new BadRequest('Слишком много позиций');

  const lines = new Map();
  for (const it of raw) {
    const p = byId.get(String(it && it.id));
    if (!p) throw new BadRequest('Товар не найден — обновите страницу');
    if (p.sold) throw new BadRequest(`«${p.name}» уже продан`);
    if (p.avito) throw new BadRequest(`«${p.name}» продаётся на Авито: ${p.avito}`);
    const qty = Math.floor(Number(it.qty) || 0);
    if (qty < 1 || qty > 20) throw new BadRequest('Неверное количество');

    let size = p.size || null;
    if (Array.isArray(p.sizes) && p.sizes.length) {
      size = String(it.size || '');
      if (!p.sizes.includes(size)) throw new BadRequest(`Выберите размер для «${p.name}»`);
    }
    const k = p.id + '|' + (size || '');
    const line = lines.get(k) || {
      id: p.id, type: p.type || 'other', name: p.name, size, price: p.price, qty: 0,
      image: absUrl((p.images && p.images[0]) || p.image), url: absUrl(p.url),
    };
    line.qty += qty;
    lines.set(k, line);
  }

  const items = [...lines.values()];
  for (const p of byId.values()) {
    if (!p.stock) continue;
    const n = items.filter(i => i.id === p.id).reduce((s, i) => s + i.qty, 0);
    if (n > p.stock) throw new BadRequest(`«${p.name}» — в наличии только ${p.stock} шт.`);
  }

  const count = items.reduce((s, i) => s + i.qty, 0);
  const goods = items.reduce((s, i) => s + i.price * i.qty, 0);
  return { items, count, goods, freeShipping: freeShippingFrom > 0 && count >= freeShippingFrom };
}

// Корзина → места для СДЭК по правилам из PACKAGING
export function buildPackages(items) {
  const P = PACKAGING;
  const w = type => P.itemWeight[type] ?? P.itemWeight.other;
  const pack = (box, weight, label) => ({
    name: box.name, length: box.length, width: box.width, height: box.height,
    weight: Math.round(box.weight + weight), contents: label,
  });

  const packages = [];
  const pants = items.filter(i => i.type === 'pants').reduce((s, i) => s + i.qty, 0);
  if (pants === 1) packages.push(pack(P.pantsSingle, w('pants'), 'Штаны × 1'));
  else if (pants > 1) {
    for (let left = pants; left > 0; left -= P.pantsBox.capacity) {
      const n = Math.min(left, P.pantsBox.capacity);
      packages.push(pack(P.pantsBox, w('pants') * n, `Штаны × ${n}`));
    }
  }
  for (const i of items) {
    if (i.type === 'pants') continue;
    const box = P.separate[i.type] || P.separate.other;
    for (let k = 0; k < i.qty; k++) packages.push(pack(box, w(i.type), i.name));
  }
  return packages;
}
