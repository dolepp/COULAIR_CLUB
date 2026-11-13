import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coulair-stock-'));
process.env.DATA_DIR = tmp;
process.env.SHEETS_ID = 'test';
process.env.SHEETS_TOKEN_FILE = path.join(tmp, 'token.json');
fs.writeFileSync(process.env.SHEETS_TOKEN_FILE, JSON.stringify({ client_id: 'test', client_secret: 'test', refresh_token: 'test' }));
const rows = [];
let writes = 0;
globalThis.fetch = async (url, options) => {
  if (url.includes('oauth2.')) return { ok: true, json: async () => ({ access_token: 'test', expires_in: 3600 }) };
  if (url.includes('batchGet')) return { ok: true, json: async () => ({ valueRanges: [
    { values: [['Партия 1','S',3,3,0], ['Партия 1','M',9,7,2 - rows.filter(r => r[10] === 'M').length], ['Партия 1','L',9,7,2]] }, { values: rows },
  ] }) };
  if (url.includes('batchUpdate')) {
    writes++;
    for (const r of JSON.parse(options.body).data) {
      const n = Number(r.range.match(/!A(\d+)/)[1]); rows[n - 9] = r.values[0];
    }
    return { ok: true, json: async () => ({}) };
  }
  throw new Error('Unexpected endpoint');
};
const sheets = await import('../sheets.js');
const store = await import('../store.js');

test('Остатки, параллельные резервы и повтор оплаченной продажи', async () => {
  assert.throws(() => sheets.parseBatches([['Партия 1','M',9,7,'#ERROR!']]), /Некорректный/);
  assert.equal((await sheets.availability()).sizes.S, 0);
  await assert.rejects(sheets.checkStock([{id:'pants',size:'S',qty:1}]), /закончился/);
  const items = [{id:'pants',type:'pants',name:'Штаны',size:'M',qty:2,price:7890}];
  function create(allocations) {
    const o = store.createOrder({ items, inventoryTracked:true, total:16000.01,
      delivery:{cdekCost:1000,customerCost:220.01,cityName:'Пермь'} });
    o.inventoryAllocations = sheets.identifyAllocations(o, allocations); store.saveOrder(o); return o;
  }
  const results = await Promise.allSettled([sheets.reserveOrder(items,create),sheets.reserveOrder(items,create)]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  assert.equal((await sheets.availability()).sizes.M, 0);
  const order = results.find(x => x.status === 'fulfilled').value;
  order.status='paid';order.paidAt=new Date().toISOString();store.saveOrder(order);
  await sheets.syncSale(order);
  await sheets.syncSale(store.getOrder(order.id));
  assert.equal(writes,1);
  assert.equal(rows.length,2);
  assert.equal(Math.round(rows.reduce((sum,r)=>sum+r[2],0)*100),1600001);
  assert.equal(rows[0][11],'Партия 1');
  assert.equal((await sheets.availability()).sizes.M,0); // нет двойного списания таблица+резерв
  assert.ok(store.getOrder(order.id).sheetSyncedAt);
  const o = await sheets.reserveOrder([{id:'pants',size:'L',qty:1}], a => {
    const o=store.createOrder({items:[{id:'pants',size:'L',qty:1}],inventoryTracked:true});
    o.inventoryAllocations=sheets.identifyAllocations(o,a);store.saveOrder(o);return o;
  });
  assert.equal((await sheets.availability()).sizes.L,1);
  o.status='canceled';store.saveOrder(o);
  assert.equal((await sheets.availability()).sizes.L,2);
});
