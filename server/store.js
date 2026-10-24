/* Заказы хранятся JSON-файлами: DATA_DIR/orders/<номер>.json */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

const dir = path.join(config.dataDir, 'orders');
fs.mkdirSync(dir, { recursive: true });
const counterFile = path.join(config.dataDir, 'counter.txt');

function writeAtomic(file, text) {
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// Номер заказа: 1001, 1002, … (процесс один, поэтому синхронного счётчика достаточно)
function nextNumber() {
  let n = 1000;
  try { n = Number(fs.readFileSync(counterFile, 'utf8')) || 1000; } catch { /* первый заказ */ }
  n += 1;
  writeAtomic(counterFile, String(n));
  return String(n);
}

const fileOf = id => path.join(dir, String(id).replace(/[^0-9A-Za-z-]/g, '') + '.json');

export function createOrder(data) {
  const order = {
    id: nextNumber(),
    token: crypto.randomBytes(16).toString('hex'),
    createdAt: new Date().toISOString(),
    status: 'pending',
    ...data,
  };
  saveOrder(order);
  return order;
}

export function saveOrder(order) {
  order.updatedAt = new Date().toISOString();
  writeAtomic(fileOf(order.id), JSON.stringify(order, null, 2));
}

export function getOrder(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}
