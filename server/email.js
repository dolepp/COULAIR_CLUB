/* Письмо клиенту об оплаченном заказе.
   Вёрстка таблицами и инлайн-стилями — так письмо одинаково выглядит в Gmail, Яндексе, Mail.ru и Outlook. */
import { config } from './config.js';

const rub = n => Number(n).toLocaleString('ru-RU').replace(/\s/g, '&nbsp;') + '&nbsp;₽';
const rubText = n => Number(n).toLocaleString('ru-RU') + ' ₽';
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const TYPE = { PVZ: 'Пункт выдачи СДЭК', POSTAMAT: 'Постамат СДЭК' };
const days = d => (!d.daysMin ? '' : (d.daysMin === d.daysMax ? `${d.daysMin}` : `${d.daysMin}–${d.daysMax}`) + ' дн.');
const dateRu = iso => new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' });

const INK = '#0e0e10', SAND = '#ebe8e3', MUTED = '#6d6b68', LINE = '#e4e1dc';
const FONT = "'Manrope','Segoe UI',Roboto,Helvetica,Arial,sans-serif";

export function orderEmail(o) {
  const site = config.siteUrl;
  const d = o.delivery;
  const subject = `Заказ №${o.id} оплачен — ${config.shopName}`;

  const itemsHtml = o.items.map(i => `
    <tr>
      <td width="76" style="padding:14px 0;border-bottom:1px solid ${LINE};vertical-align:middle;">
        <img src="${esc(i.image)}" width="64" height="64" alt="" style="display:block;width:64px;height:64px;object-fit:contain;border-radius:10px;background:${SAND};">
      </td>
      <td style="padding:14px 12px;border-bottom:1px solid ${LINE};vertical-align:middle;font:600 15px/1.4 ${FONT};color:${INK};">
        ${esc(i.name)}
        <div style="margin-top:4px;font:500 13px/1.4 ${FONT};color:${MUTED};">${i.size ? 'Размер ' + esc(i.size) + ' · ' : ''}${i.qty} шт.</div>
      </td>
      <td align="right" style="padding:14px 0;border-bottom:1px solid ${LINE};vertical-align:middle;white-space:nowrap;font:700 15px/1.4 ${FONT};color:${INK};">${rub(i.price * i.qty)}</td>
    </tr>`).join('');

  const row = (label, value, strong) => `
    <tr>
      <td style="padding:5px 0;font:${strong ? 800 : 500} ${strong ? 18 : 15}px/1.4 ${FONT};color:${strong ? INK : MUTED};">${label}</td>
      <td align="right" style="padding:5px 0;font:${strong ? 800 : 600} ${strong ? 18 : 15}px/1.4 ${FONT};color:${INK};white-space:nowrap;">${value}</td>
    </tr>`;

  const deliveryValue = d.customerCost > 0 ? rub(d.customerCost)
    : `<span style="color:#2d7a3e;">Бесплатно</span>`;

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light only">
<title>${esc(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f4f2ee;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">Оплата прошла. Соберём и передадим заказ в СДЭК в ближайшее время.</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f2ee;">
  <tr><td align="center" style="padding:28px 12px;">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="width:100%;max-width:600px;">

      <!-- шапка -->
      <tr><td align="center" style="padding:30px 24px;background:${INK};border-radius:18px 18px 0 0;">
        <a href="${site}" style="text-decoration:none;"><img src="${site}/assets/logo-white.png" height="44" alt="${esc(config.shopName)}" style="display:block;height:44px;width:auto;border:0;"></a>
      </td></tr>

      <!-- приветствие -->
      <tr><td style="padding:36px 36px 8px;background:#ffffff;">
        <p style="margin:0 0 10px;font:700 12px/1 ${FONT};letter-spacing:.14em;text-transform:uppercase;color:${MUTED};">Заказ №${esc(o.id)} · ${dateRu(o.paidAt || o.createdAt)}</p>
        <h1 style="margin:0 0 14px;font:800 28px/1.2 ${FONT};color:${INK};">Спасибо за заказ!<br>Оплата прошла</h1>
        <p style="margin:0;font:500 15px/1.6 ${FONT};color:#45433f;">Мы получили оплату и уже собираем заказ. Как только передадим посылку в&nbsp;СДЭК, пришлём номер для отслеживания.</p>
      </td></tr>

      <!-- товары -->
      <tr><td style="padding:22px 36px 6px;background:#ffffff;">
        <p style="margin:0 0 4px;font:800 17px/1.3 ${FONT};color:${INK};">Состав заказа</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemsHtml}</table>
      </td></tr>

      <!-- итог -->
      <tr><td style="padding:12px 36px 28px;background:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${row('Товары', rub(o.goods))}
          ${row('Доставка СДЭК', deliveryValue)}
          <tr><td colspan="2" style="padding-top:8px;border-bottom:1px solid ${LINE};font-size:0;line-height:0;">&nbsp;</td></tr>
          <tr><td colspan="2" style="height:8px;font-size:0;line-height:0;">&nbsp;</td></tr>
          ${row('Оплачено', rub(o.total), true)}
        </table>
      </td></tr>

      <!-- доставка -->
      <tr><td style="padding:0 36px 28px;background:#ffffff;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SAND};border-radius:14px;">
          <tr><td style="padding:20px 22px;">
            <p style="margin:0 0 10px;font:800 15px/1.3 ${FONT};color:${INK};">🚚 ${TYPE[d.point.type] || 'СДЭК'}</p>
            <p style="margin:0 0 4px;font:600 15px/1.5 ${FONT};color:${INK};">${esc(d.cityName)}, ${esc(d.point.address)}</p>
            ${d.point.workTime ? `<p style="margin:0 0 4px;font:500 13px/1.5 ${FONT};color:${MUTED};">Режим работы: ${esc(d.point.workTime)}</p>` : ''}
            <p style="margin:0;font:500 13px/1.5 ${FONT};color:${MUTED};">${days(d) ? `Срок доставки после отправки: ${days(d)} · ` : ''}код пункта ${esc(d.point.code)}</p>
          </td></tr>
          <tr><td style="padding:0 22px 20px;">
            <p style="margin:0;font:500 13px/1.6 ${FONT};color:${MUTED};">Получатель: <span style="color:${INK};font-weight:600;">${esc(o.contact.name)}</span>, ${esc(o.contact.phone)}<br>Для получения понадобится паспорт или код из SMS от СДЭК.</p>
          </td></tr>
        </table>
      </td></tr>

      <!-- связь -->
      <tr><td align="center" style="padding:6px 36px 36px;background:#ffffff;border-radius:0 0 18px 18px;">
        <p style="margin:0 0 16px;font:500 14px/1.6 ${FONT};color:#45433f;">Остались вопросы по заказу или размеру? Напишите нам — ответим в течение часа.</p>
        <table role="presentation" cellpadding="0" cellspacing="0"><tr><td style="border-radius:10px;background:${INK};">
          <a href="${esc(config.contactTelegram)}" style="display:inline-block;padding:15px 30px;font:700 15px/1 ${FONT};color:#ffffff;text-decoration:none;">Написать в Telegram</a>
        </td></tr></table>
      </td></tr>

      <!-- подвал -->
      <tr><td align="center" style="padding:22px 24px 6px;font:500 12px/1.6 ${FONT};color:${MUTED};">
        ${esc(config.shopName)} · <a href="${site}" style="color:${MUTED};">${site.replace(/^https?:\/\//, '')}</a> · ${esc(config.seller)}<br>
        Вы получили это письмо, потому что оформили заказ на сайте.
        <a href="${site}/offer/" style="color:${MUTED};">Условия возврата и обмена</a>
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    `Спасибо! Заказ №${o.id} оплачен.`,
    '',
    ...o.items.map(i => `— ${i.name}${i.size ? ', размер ' + i.size : ''} × ${i.qty}: ${rubText(i.price * i.qty)}`),
    '',
    `Товары: ${rubText(o.goods)}`,
    `Доставка СДЭК: ${d.customerCost ? rubText(d.customerCost) : 'бесплатно'}`,
    `Оплачено: ${rubText(o.total)}`,
    '',
    `${TYPE[d.point.type] || 'СДЭК'}: ${d.cityName}, ${d.point.address}`,
    d.point.workTime ? `Режим работы: ${d.point.workTime}` : '',
    `Получатель: ${o.contact.name}, ${o.contact.phone}`,
    '',
    'Как только передадим посылку в СДЭК, пришлём номер для отслеживания.',
    `Вопросы: ${config.contactTelegram}`,
  ].filter(l => l !== null).join('\n');

  return { subject, html, text };
}
