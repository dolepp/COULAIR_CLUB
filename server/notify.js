/* Уведомления об оплаченном заказе: заявка в Telegram, письмо клиенту и письма админам */
import nodemailer from 'nodemailer';
import { config } from './config.js';
import { orderEmail, adminEmail } from './email.js';

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
    o.contact.telegram ? `Telegram: ${esc(o.contact.telegram.replace(/^(?=[A-Za-z])/, '@'))}`
      : o.contact.noTelegram ? 'Telegram: нет' : '',
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function sendTelegram(text, maxRetries = 3) {
  const { token, chatIds, apiBase } = config.telegram;
  if (!token || !chatIds.length) { console.info('[telegram] не настроен, сообщение:\n' + text); return false; }

  const endpoints = [apiBase];
  if (apiBase !== 'https://api.telegram.org') {
    endpoints.push('https://api.telegram.org');
  } else {
    endpoints.push('https://lainos.ru/telegram-proxy');
  }

  for (const chat_id of chatIds) {
    let sent = false;
    let lastError = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      for (const base of endpoints) {
        try {
          const url = `${base.replace(/\/+$/, '')}/bot${token}/sendMessage`;
          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true }),
            signal: AbortSignal.timeout(15000),
          });
          if (!res.ok) {
            const errBody = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${errBody.slice(0, 150)}`);
          }
          sent = true;
          break;
        } catch (err) {
          lastError = err;
          console.warn(`[telegram] попытка ${attempt} через ${base} для чата ${chat_id} не удалась: ${err.message}`);
        }
      }
      if (sent) break;
      if (attempt < maxRetries) {
        await sleep(attempt * 2000);
      }
    }

    if (!sent) {
      throw new Error(`Telegram error after ${maxRetries} attempts: ${lastError?.message || 'unknown error'}`);
    }
  }
  return true;
}

/* ---------- Почта ---------- */
/* Основной путь — email-api (Gmail API) на этом же сервере: EMAIL_API_URL + EMAIL_API_KEY.
   Запасной — SMTP (SMTP_*), если email-api не настроен.
   Ключ идемпотентности (order-<id>-…) не даёт отправить одно письмо дважды при повторах. */
let transport = null;
const smtpReady = () => !!(config.mail.host && config.mail.user && config.mail.pass);
export const mailReady = () => !!(config.emailApi.url && config.emailApi.key) || smtpReady();

async function sendMail({ to, subject, html, text, key }) {
  if (config.emailApi.url && config.emailApi.key) {
    const res = await fetch(`${config.emailApi.url}/api/v1/emails/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.emailApi.key}` },
      body: JSON.stringify({ to, subject, html, text, idempotency_key: key }),
      signal: AbortSignal.timeout(120000),
    });
    const body = await res.json().catch(() => ({}));
    // 201 — отправлено, 200 — уже было отправлено раньше (повтор),
    // 202 — Gmail ответил неоднозначно: письмо могло уйти, повторно не шлём.
    if (res.status === 201 || res.status === 200) return 'sent';
    if (res.status === 202) return 'uncertain';
    const err = body && body.error;
    throw new Error(`email-api ${res.status}: ${(err && (err.code + ' ' + err.message)) || 'ошибка'}`);
  }
  if (!smtpReady()) return false;
  transport ||= nodemailer.createTransport({
    host: config.mail.host, port: config.mail.port, secure: config.mail.secure,
    auth: { user: config.mail.user, pass: config.mail.pass },
  });
  await transport.sendMail({ from: { name: config.shopName, address: config.mail.from }, to, subject, html, text });
  return 'sent';
}

/* Письмо клиенту: «Вы оформили предзаказ». */
export async function sendOrderEmail(order) {
  if (!mailReady()) { console.info('[mail] почта не настроена — письмо по заказу', order.id, 'не отправлено'); return false; }
  const r = await sendMail({ to: order.contact.email, ...orderEmail(order), key: `order-${order.id}-client` });
  console.info('[mail] заказ', order.id, 'письмо клиенту:', r);
  return !!r;
}

/* Письма администраторам с данными заказа (как в Telegram). Каждому — отдельное письмо. */
export async function sendAdminEmails(order) {
  if (!mailReady() || !config.adminEmails.length) return false;
  const msg = adminEmail(order);
  const errors = [];
  for (const to of config.adminEmails) {
    try {
      const r = await sendMail({ to, ...msg, key: `order-${order.id}-admin-${to.toLowerCase()}` });
      console.info('[mail] заказ', order.id, 'письмо админу', to, r);
    } catch (e) { errors.push(`${to}: ${e.message}`); }
  }
  if (errors.length) throw new Error(errors.join('; '));
  return true;
}
