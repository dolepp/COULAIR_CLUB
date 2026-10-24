/* ЮKassa API v3: создание платежа и проверка статуса */
import crypto from 'node:crypto';
import { config } from './config.js';

const BASE = 'https://api.yookassa.ru/v3';
const Y = config.yookassa;
export const yookassaReady = () => !!(Y.shopId && Y.secretKey);

async function api(method, path, body, idemKey) {
  if (!yookassaReady()) throw new Error('ЮKassa не настроена: нет YOOKASSA_SHOP_ID / YOOKASSA_SECRET_KEY');
  const res = await fetch(BASE + path, {
    method,
    headers: {
      Authorization: 'Basic ' + Buffer.from(Y.shopId + ':' + Y.secretKey).toString('base64'),
      ...(body ? { 'Content-Type': 'application/json', 'Idempotence-Key': idemKey || crypto.randomUUID() } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error('ЮKassa: ' + ((data && data.description) || 'HTTP ' + res.status));
  return data;
}

const money = n => ({ value: Number(n).toFixed(2), currency: 'RUB' });

function receipt(order) {
  const items = order.items.map(i => ({
    description: (i.name + (i.size ? ', размер ' + i.size : '')).slice(0, 128),
    quantity: i.qty.toFixed(2),
    amount: money(i.price),
    vat_code: Y.vatCode,
    payment_mode: Y.paymentMode,
    payment_subject: 'commodity',
  }));
  if (order.delivery.customerCost > 0) {
    items.push({
      description: 'Доставка СДЭК',
      quantity: '1.00',
      amount: money(order.delivery.customerCost),
      vat_code: Y.vatCode,
      payment_mode: Y.paymentMode,
      payment_subject: 'service',
    });
  }
  return { customer: { email: order.contact.email, phone: order.contact.phone.replace(/\D/g, '') }, items };
}

export async function createPayment(order) {
  const body = {
    amount: money(order.total),
    capture: true,
    confirmation: {
      type: 'redirect',
      return_url: `${config.siteUrl}/order/?id=${order.id}&t=${order.token}`,
    },
    description: `Заказ №${order.id} — ${config.shopName}`.slice(0, 128),
    metadata: { order_id: order.id },
  };
  if (Y.receipt) body.receipt = receipt(order);
  // один заказ — один платёж, даже если запрос повторится
  return api('POST', '/payments', body, 'order-' + order.id + '-' + order.token);
}

export const getPayment = id => api('GET', '/payments/' + encodeURIComponent(id));
