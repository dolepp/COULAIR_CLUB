import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'coulair-shipping-'));
process.env.DATA_DIR=tmp;process.env.SITE_DIR=path.join(tmp,'site');
process.env.YOOKASSA_SHOP_ID='test';process.env.YOOKASSA_SECRET_KEY='test';process.env.YOOKASSA_RECEIPT='1';
fs.mkdirSync(path.join(tmp,'site/js'),{recursive:true});fs.mkdirSync(path.join(tmp,'site/catalog'),{recursive:true});
fs.writeFileSync(path.join(tmp,'site/catalog/catalog.js'),'window.CATALOG=[];');
fs.writeFileSync(path.join(tmp,'site/js/main.js'),'const CONFIG = {\npants: {id:"pants",type:"pants",name:"Штаны",price:7890,sizes:["M"]}, deliveryDiscountFrom:2, deliveryDiscountPercent:50\n};');
const {normalizeItems}=await import('../products.js');
const {deliveryPrice}=await import('../shipping.js');
const {applyPromo}=await import('../promo.js');
const {createPayment}=await import('../yookassa.js');

test('Одна пара: полная доставка; от двух: половина, сумма платежа и чек совпадают',async()=>{
  const one=normalizeItems([{id:'pants',size:'M',qty:1}],{managedPants:true});
  const two=normalizeItems([{id:'pants',size:'M',qty:2}],{managedPants:true});
  const mixed=normalizeItems([{id:'pants',size:'M',color:'черный',qty:1},{id:'pants',size:'M',color:'белый',qty:1}],{managedPants:true});
  assert.equal(one.deliveryDiscountPercent,0);assert.equal(two.deliveryDiscountPercent,50);assert.equal(mixed.deliveryDiscountPercent,50);
  assert.equal(two.freeShipping,false);
  assert.equal(deliveryPrice(1000,one.deliveryDiscountPercent),1000);
  assert.equal(deliveryPrice(1000,two.deliveryDiscountPercent),500);
  assert.equal(deliveryPrice(1000.01,50),500.01);
  assert.throws(()=>deliveryPrice(-1,50));
  const shipping=deliveryPrice(1000,50),sum=applyPromo(null,two.goods,shipping);
  assert.equal(sum.total,16280);
  const withPromo=applyPromo({kind:'percent',value:10},two.goods,shipping);
  assert.equal(withPromo.total,14702);
  let body;
  globalThis.fetch=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({id:'test',status:'pending'})};};
  await createPayment({id:'test',token:'test',total:sum.total,items:two.items,contact:{email:'test@example.com',phone:'+79000000000'},delivery:{customerCost:shipping}});
  assert.equal(body.amount.value,'16280.00');
  const delivery=body.receipt.items.find(i=>i.description==='Доставка СДЭК');
  assert.equal(delivery.amount.value,'500.00');
  assert.equal(body.receipt.items.reduce((s,i)=>s+Number(i.amount.value)*Number(i.quantity),0),16280);
});

test('Новый заказ: доставка при получении, онлайн-платёж и чек только за товары',async()=>{
  const {deliveryPaymentPlan,deliveryOnlineCharge,deliveryStoreExpense}=await import('../shipping.js');
  const cart=normalizeItems([{id:'pants',size:'M',qty:2}],{managedPants:true});
  const plan=deliveryPaymentPlan(1000,cart.deliveryDiscountPercent);
  assert.equal(plan.customerCost,500);assert.equal(deliveryOnlineCharge(plan),0);
  assert.equal(deliveryStoreExpense({...plan,cdekCost:1000}),500);
  assert.equal(deliveryStoreExpense({...deliveryPaymentPlan(1000,0),cdekCost:1000}),0);
  const sum=applyPromo(null,cart.goods,deliveryOnlineCharge(plan));assert.equal(sum.total,15780);
  assert.equal(applyPromo({kind:'percent',value:10},cart.goods,deliveryOnlineCharge(plan)).total,14202);
  const order={id:'cod',token:'test',total:sum.total,goods:cart.goods,paidAt:new Date().toISOString(),items:cart.items,
    contact:{name:'Тест',email:'test@example.com',phone:'+79000000000'},
    delivery:{...plan,cdekCost:1000,cityName:'Тест',point:{type:'PVZ',address:'Тест',code:'test'}},
    inventoryAllocations:[0,1].map(unit=>({itemIndex:0,unit,key:`site:cod:0:${unit}`,batch:'Партия 1',size:'M',color:'черный',dispatchLabel:'в течение 10 рабочих дней',preorder:false}))};
  let body;globalThis.fetch=async(url,options)=>{body=JSON.parse(options.body);return {ok:true,json:async()=>({id:'test',status:'pending'})};};
  await createPayment(order);
  assert.equal(body.amount.value,'15780.00');
  assert.ok(body.receipt.items.every(i=>i.description!=='Доставка СДЭК'));
  assert.equal(body.receipt.items.reduce((s,i)=>s+Number(i.amount.value)*Number(i.quantity),0),15780);
  const {saleRows}=await import('../sheets.js');const rows=saleRows(order,40,new Set()).map(r=>r.values[0]);
  assert.equal(rows.reduce((s,r)=>s+r[2],0),15780);
  assert.equal(rows.reduce((s,r)=>s+r[3],0),500);
  assert.ok(rows.every(r=>r[12]==='Не оплачена' && r[8].includes('при получении')));
  const {orderEmail}=await import('../email.js');const mail=orderEmail(order);
  assert.match(mail.text,/оплата при получении/);assert.match(mail.html,/Оплачено на сайте за товары/);
});
