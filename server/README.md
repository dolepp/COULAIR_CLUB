# coulair-api

Node.js API магазина: города и пункты СДЭК, расчёт доставки (таблица «расстояние от Нижнего Тагила × вес»
или калькулятор СДЭК), оплата ЮKassa, заявки в Telegram, письма клиентам.

На сервере:
- код — `/opt/coulair-api` (`npm ci --omit=dev`), настройки — `/opt/coulair-api/.env` (образец `.env.example`, права 600);
- служба — `coulair-api.service` (порт 3100), заказы — `/var/lib/coulair-api/orders/*.json`;
- nginx — `nginx-coulair.conf`: сайт из `/var/www/coulair/current` (ссылка на `releases/<версия>`), `/api/` → 3100.

Уведомления ЮKassa: `https://coulair.ru/api/yookassa/webhook` (payment.succeeded, payment.canceled).
