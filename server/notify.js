/* Уведомления об оплаченном заказе: заявка в Telegram и письмо клиенту */
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { orderEmail } from './email.js';

const rub = n => Number(n).toLocaleString('ru-RU') + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
export const TYPE_LABEL = { PVZ: 'Пункт выдачи', POSTAMAT: 'Постамат' };

/* ---------- Telegram ---------- */
export function telegramText(o) {
  const d = o.delivery;
  const lines = [
    `🧾 <b>Оплачен заказ №${o.id}</b>`,
    `💳 Сумма оплаты: <b>${rub(o.total)}</b>`,
    `Товары: ${rub(o.goods)} · доставка: ${d.customerCost ? rub(d.customerCost) : 'бесплатно'}`,
    '',
    '<b>Товары</b>',
    ...o.items.map(i => `• ${esc(i.name)}${i.size ? ', ' + esc(i.size) : ''} × ${i.qty} — ${rub(i.price * i.qty)}`),
    '',
    '<b>Получатель</b>',
    `ФИО: <code>${esc(o.contact.name)}</code>`,
    `Телефон: <code>${esc(o.contact.phone)}</code>`,
    `Email: <code>${esc(o.contact.email)}</code>`,
    o.contact.telegram ? `Telegram: ${esc(o.contact.telegram)}` : '',
    '',
    `<b>Доставка СДЭК — ${TYPE_LABEL[d.point.type] || d.point.type}</b>`,
    `Город: ${esc(d.cityName)} (код ${d.cityCode})`,
    `Пункт: <code>${esc(d.point.code)}</code>`,
    `Адрес: ${esc(d.point.address)}`,
    `Тариф: ${d.tariff}` + (d.daysMin ? ` · срок ${d.daysMin === d.daysMax ? d.daysMin : d.daysMin + '–' + d.daysMax} дн.` : ''),
    `${d.fixed ? 'Доставка по фикс. цене' : 'Стоимость по СДЭК'}: <b>${rub(d.cdekCost)}</b>${d.free ? ' (клиенту бесплатно — акция)' : ''}`,
    '',
    '<b>Места</b>',
    ...o.packages.map((p, k) => `${k + 1}) ${esc(p.name)} ${p.length}×${p.width}×${p.height} см, ${(p.weight / 1000).toFixed(2)} кг — ${esc(p.contents)}`),
    o.comment ? `\n💬 <b>Комментарий:</b> ${esc(o.comment)}` : '',
    '',
    `ЮKassa: <code>${esc(o.payment && o.payment.id)}</code>`,
  ];
  return lines.filter(l => l !== '').join('\n').replace(/\n(<b>)/g, '\n\n$1').slice(0, 4000);
}

export async function sendTelegram(text) {
  const { token, chatIds } = config.telegram;
  if (!token || !chatIds.length) { console.info('[telegram] не настроен, сообщение:\n' + text); return false; }
  for (const chat_id of chatIds) {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error('Telegram: ' + res.status + ' ' + (await res.text()).slice(0, 200));
  }
  return true;
}

/* ---------- Почта ---------- */
let transport = null;
const mailReady = () => !!(config.mail.host && config.mail.user && config.mail.pass);

export async function sendOrderEmail(order) {
  if (!mailReady()) { console.info('[mail] SMTP не настроен — письмо заказу', order.id, 'не отправлено'); return false; }
  transport ||= nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  const { subject, html, text } = orderEmail(order);
  await transport.sendMail({
    from: { name: config.shopName, address: config.mail.from },
    to: order.contact.email,
    bcc: config.mail.bcc || undefined,
    subject, html, text,
  });
  return true;
}
