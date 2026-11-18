(() => {
    const params = new URLSearchParams(location.search);
    const id = params.get('id'), token = params.get('t');
    const body = document.getElementById('orderBody');
    const rub = n => Number(n).toLocaleString('ru-RU') + ' ₽';
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const ICON = {
      ok: '<div class="order-card__icon"><svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></div>',
      wait: '<div class="order-card__icon is-wait"><svg viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 9 9"/></svg></div>',
      fail: '<div class="order-card__icon is-fail"><svg viewBox="0 0 24 24"><path d="M7 7l10 10M17 7 7 17"/></svg></div>',
    };
    const TYPE = { PVZ: 'Пункт выдачи СДЭК', POSTAMAT: 'Постамат СДЭК' };
    const store = {
      get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
      set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
      del(k) { try { localStorage.removeItem(k); } catch {} },
    };

    function details(o) {
      const d = o.delivery;
      const days = d.daysMin === d.daysMax ? d.daysMin : d.daysMin + '–' + d.daysMax;
      return `
        <ul class="co-items">${o.items.map(i => `
          <li class="co-item"><img src="${esc(i.image)}" alt="">
            <div><p class="co-item__name">${esc(i.name)}</p><p class="co-item__meta">${i.color ? esc(i.color === 'белый' ? 'Белый' : 'Чёрный') + ' · ' : ''}${i.size ? 'Размер ' + esc(i.size) + ' · ' : ''}${i.qty} шт.</p>${i.fulfillment?.length ? `<p class="co-item__meta">${i.fulfillment.map(f => esc(`${f.qty} шт. — ${f.preorder ? 'Предзаказ · ' : ''}Отправка ${f.dispatchLabel}`)).join('; ')}</p>` : ''}</div>
            <strong>${rub(i.price * i.qty)}</strong></li>`).join('')}</ul>
        <div class="co-total">
          <div class="co-total__row"><span>Товары</span><span>${rub(o.goods)}</span></div>
          <div class="co-total__row"><span>Доставка СДЭК${d.paymentMethod === 'on_receipt' ? ' — оплата при получении' : ''}${d.discountPercent ? ` · скидка ${d.discountPercent}%` : ''}</span><span>${d.cost ? rub(d.cost) : '<span class="co-free">Бесплатно</span>'}${d.discountPercent ? ` <s>${rub(d.originalCost)}</s>` : ''}</span></div>
          ${o.promo ? `<div class="co-total__row"><span>Промокод ${esc(o.promo.code)}</span><span>−${rub(o.promo.discount)}</span></div>` : ''}
          <div class="co-total__row co-total__sum"><span>${o.status === 'paid' ? 'Оплачено' : 'К оплате'}${d.paymentMethod === 'on_receipt' ? ' на сайте за товары' : ''}</span><span>${rub(o.total)}</span></div>
        </div>
        <p class="order-card__ship"><strong>${TYPE[d.type] || 'СДЭК'}</strong>${esc(d.city)}, ${esc(d.address)}<br>
          ${d.daysMin ? `<span class="co-muted">Срок после отправки: ${days} дн.</span>` : ''}</p>`;
    }

    function render(o) {
      if (o.status === 'paid') {
        const pending = store.get('coulair-pending');
        if (pending && pending.id === o.id) {
          if (pending.fromCart) store.set('coulair-cart', []);
          store.del('coulair-pending');
        }
        body.innerHTML = `${ICON.ok}<h1>Заказ №${esc(o.id)} оплачен</h1>
          <p class="order-card__lead">Спасибо! Соберём посылку и пришлём номер для отслеживания СДЭК.</p>
          ${details(o)}<a class="btn btn--dark btn--wide" href="./">Вернуться в магазин</a>`;
      } else if (o.status === 'pending') {
        body.innerHTML = `${ICON.wait}<h1>Ждём подтверждения оплаты</h1>
          <p class="order-card__lead">Обычно это занимает несколько секунд. Страница обновится сама.</p>
          ${details(o)}${o.paymentUrl ? `<a class="btn btn--dark btn--wide" href="${esc(o.paymentUrl)}">Вернуться к оплате</a>` : ''}
          <a class="btn btn--ghost btn--wide" href="./">В магазин</a>`;
      } else if (o.status === 'mismatch') {
        body.innerHTML = `${ICON.wait}<h1>Проверяем заказ №${esc(o.id)}</h1>
          <p class="order-card__lead">Оплата получена, но нам нужно проверить детали. Мы свяжемся с вами в ближайшее время.</p>
          <a class="btn btn--dark btn--wide" href="https://t.me/coulair" target="_blank" rel="noopener">Написать в Telegram</a>`;
      } else {
        body.innerHTML = `${ICON.fail}<h1>Ошибка платежа</h1>
          <p class="order-card__lead">Деньги не списаны. Напишите администратору в Telegram: <a href="https://t.me/coulair" target="_blank" rel="noopener">@coulair</a> — поможем оформить заказ.</p>
          <a class="btn btn--dark btn--wide" href="https://t.me/coulair" target="_blank" rel="noopener">Написать администратору в Telegram</a>
          <a class="btn btn--ghost btn--wide" href="./">Вернуться в магазин</a>`;
      }
    }

    function notFound() {
      body.innerHTML = `${ICON.fail}<h1>Заказ не найден</h1>
        <p class="order-card__lead">Проверьте ссылку или напишите нам в Telegram.</p>
        <a class="btn btn--dark btn--wide" href="./">В магазин</a>`;
    }

    let tries = 0;
    async function load() {
      if (!id || !token) return notFound();
      try {
        const res = await fetch(`/api/order?id=${encodeURIComponent(id)}&t=${encodeURIComponent(token)}`, { cache: 'no-store' });
        if (res.status === 404) return notFound();
        const { order } = await res.json();
        render(order);
        // ждём webhook ЮKassa: сначала часто, потом реже, максимум ~5 минут
        if (order.status === 'pending' && ++tries < 60) setTimeout(load, tries < 20 ? 3000 : 8000);
      } catch {
        if (++tries < 60) setTimeout(load, 5000);
      }
    }
    load();
  })();
