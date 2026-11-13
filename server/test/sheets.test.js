import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coulair-stock-'));
process.env.DATA_DIR = tmp;
process.env.SITE_DIR = path.join(tmp, 'site');
fs.mkdirSync(path.join(tmp,'site/catalog'),{recursive:true});
fs.mkdirSync(path.join(tmp,'site/js'),{recursive:true});
fs.writeFileSync(path.join(tmp,'site/catalog/catalog.js'),'window.CATALOG = [];');
fs.writeFileSync(path.join(tmp,'site/js/main.js'), 'const CONFIG = {\npants: {id:"pants",type:"pants",name:"Штаны",price:7890,colorImages:{черный:"black.jpg",белый:"white-front.jpg"},sizes:["S","M","L","XL"]}\n};');
process.env.SHEETS_ID = 'test';
process.env.SHEETS_TOKEN_FILE = path.join(tmp, 'token.json');
fs.writeFileSync(process.env.SHEETS_TOKEN_FILE, JSON.stringify({ client_id: 'test', client_secret: 'test', refresh_token: 'test' }));
const rows = [];
let writes = 0, secondBatch = false;
globalThis.fetch = async (url, options) => {
  if (url.includes('oauth2.')) return { ok: true, json: async () => ({ access_token: 'test', expires_in: 3600 }) };
  if (url.includes('batchGet')) return { ok: true, json: async () => ({ valueRanges: [
    { values: [['Партия 1','S',3,3,0], ['Партия 1','M',9,7,2 - rows.filter(r => r[10] === 'M').length], ['Партия 1','L',9,7,2], ...(secondBatch ? [
      ['Партия 2','S',5,0,5,'','черный','12–16 рабочих дней',true],
      ['Партия 2','M',5,0,5,'','черный','12–16 рабочих дней',true],
      ['Партия 2','L',5,0,5,'','черный','12–16 рабочих дней',true],
      ['Партия 2','M',3,0,3,'','белый','12–16 рабочих дней',true],
    ] : [])] }, { values: rows },
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


test('Приоритет первой партии, переход ко второй и раздельный учёт цветов', async () => {
  secondBatch = true;
  // reserveOrder читает таблицу заново; белый M не расходует чёрный M.
  const items = [
    {id:'pants',type:'pants',name:'Штаны',size:'L',color:'черный',qty:3,price:7890},
    {id:'pants',type:'pants',name:'Штаны',size:'M',color:'белый',qty:3,price:7890},
  ];
  let selected;
  const order = await sheets.reserveOrder(items, a => {
    selected=a;
    const o=store.createOrder({items,inventoryTracked:true,total:47340,delivery:{cdekCost:0,customerCost:0}});
    o.inventoryAllocations=sheets.identifyAllocations(o,a);store.saveOrder(o);return o;
  });
  assert.deepEqual(selected.slice(0,3).map(a=>a.batch),['Партия 1','Партия 1','Партия 2']);
  assert.equal(selected[0].preorder,false);
  assert.equal(selected[0].dispatchLabel,'в течение 10 рабочих дней');
  assert.equal(selected[2].preorder,true);
  assert.equal(selected[2].dispatchLabel,'12–16 рабочих дней');
  assert.ok(selected.slice(3).every(a=>a.color==='белый' && a.batch==='Партия 2'));
  const stock=await sheets.availability();
  assert.equal(stock.colors['белый'].sizes.M,0);
  assert.equal(stock.colors['черный'].sizes.M,5);
  assert.equal(stock.colors['черный'].sizes.L,4);
  await assert.rejects(sheets.checkStock([{id:'pants',size:'M',color:'белый',qty:1}]), /закончился/);
  const {attachFulfillment}=await import('../fulfillment.js');
  attachFulfillment(items,selected);
  assert.deepEqual(items[0].fulfillment.map(f=>f.qty),[2,1]);
  order.paidAt=new Date().toISOString();
  const sales=sheets.saleRows(order,34,new Set());
  assert.equal(sales.length,6);
  assert.equal(sales[3].values[0][14],'белый');
  assert.equal(sales[3].values[0][11],'Партия 2');
  assert.equal(sales[3].values[0][16],'Предзаказ · Отправка 12–16 рабочих дней');
  assert.equal(sales[0].values[0][16],'Отправка в течение 10 рабочих дней');
  // Строки цветов не сливаются при нормализации корзины.
  const {normalizeItems}=await import('../products.js');
  const normalized=normalizeItems([{id:'pants',size:'M',color:'черный',qty:1},{id:'pants',size:'M',color:'белый',qty:1}],{managedPants:true});
  assert.equal(normalized.items.length,2);
  assert.deepEqual(normalized.items.map(i=>i.color),['черный','белый']);
  assert.ok(normalized.items[1].image.endsWith('/white-front.jpg'));
  const {orderEmail}=await import('../email.js');
  const mailOrder={...order,contact:{name:'Тест',email:'test@example.com',phone:'+79000000000'},delivery:{...order.delivery,point:{type:'PVZ',code:'test',address:'Тест'},cityName:'Пермь'}};
  const firstMail=orderEmail({...mailOrder,items:[{...items[0],qty:1,fulfillment:[{...items[0].fulfillment[0],qty:1}]}]});
  assert.match(firstMail.subject,/^Заказ/);
  assert.match(firstMail.text,/10 рабочих дней/);
  assert.doesNotMatch(firstMail.text,/12–16/);
  const secondMail=orderEmail({...mailOrder,items:[items[1]]});
  assert.match(secondMail.subject,/^Предзаказ/);
  assert.match(secondMail.text,/12–16 рабочих дней/);
  assert.match(secondMail.text,/Белый/);
});
