/* =====================================================================
   Оформление заказа: получатель → СДЭК (пункт выдачи или постамат на карте) → оплата ЮKassa.
   Подгружается из main.js при первом нажатии «Оформить заказ»; пользуется его утилитами
   ($, $$, rub, escapeHtml, findProduct, imgOf, openLayer, closeLayer, store).
   ===================================================================== */
(() => {
  const API = '/api';
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
  const TYPES = {
    PVZ:      { label: 'Пункт выдачи', many: 'Пункты выдачи', color: '#1a9e46' },
    POSTAMAT: { label: 'Постамат',     many: 'Постаматы',     color: '#e0701a' },
  };
  const LIST_LIMIT = 40;

  const st = {
    items: [], fromCart: false,
    quote: null,            // ответ /api/quote: цены сервера, доставка по типам
    city: null,             // { code, name, region }
    points: [], filter: 'ALL', point: null,
    map: null, layer: null, markers: new Map(), pickerOpen: true,
  };

  /* ---------- сеть ---------- */
  async function api(path, body) {
    const res = await fetch(API + path, body
      ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
      : {});
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const e = new Error(data.error || 'Нет связи с сервером, попробуйте ещё раз');
      e.fields = data.fields;
      throw e;
    }
    return data;
  }

  let leaflet = null;
  function loadLeaflet() {
    return leaflet || (leaflet = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet'; css.href = LEAFLET + 'leaflet.css';
      document.head.appendChild(css);
      const s = document.createElement('script');
      s.src = LEAFLET + 'leaflet.js';
      s.onload = () => resolve(window.L);
      s.onerror = () => { leaflet = null; s.remove(); reject(new Error('Карта не загрузилась')); };
      document.head.appendChild(s);
    }));
  }

  /* ---------- разметка ---------- */
  const CLOSE = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>';
  function build() {
    const el = document.createElement('div');
    el.className = 'modal checkout';
    el.id = 'checkoutModal';
    el.hidden = true;
    el.innerHTML = `
      <div class="modal__backdrop" data-close></div>
      <div class="modal__box checkout__box" role="dialog" aria-modal="true" aria-labelledby="coTitle">
        <button class="icon-btn modal__close" type="button" data-close aria-label="Закрыть">${CLOSE}</button>
        <form class="checkout__form" id="coForm" novalidate>
          <h3 class="modal__title" id="coTitle">Оформление заказа</h3>
          <ul class="co-items" id="coItems"></ul>

          <section class="co-sec">
            <h4 class="co-sec__title"><span>1</span>Получатель</h4>
            <div class="co-grid">
              <label class="field co-grid__full"><span>ФИО</span>
                <input name="name" type="text" autocomplete="name" placeholder="Иванов Иван Иванович"></label>
              <label class="field"><span>Телефон</span>
                <input name="phone" type="tel" autocomplete="tel" inputmode="tel" placeholder="+7 (___) ___-__-__"></label>
              <label class="field"><span>Email</span>
                <input name="email" type="email" autocomplete="email" inputmode="email" placeholder="name@mail.ru"></label>
              <label class="field co-grid__full"><span>Telegram <em>(необязательно)</em></span>
                <input name="telegram" type="text" autocomplete="off" placeholder="@username"></label>
            </div>
            <p class="co-note">На email придёт чек и письмо с составом заказа.</p>
          </section>

          <section class="co-sec">
            <h4 class="co-sec__title"><span>2</span>Доставка СДЭК</h4>
            <label class="field"><span>Город</span>
              <span class="suggest">
                <input name="city" type="text" autocomplete="off" placeholder="Начните вводить: Екатеринбург"
                       role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="coCityList">
                <ul class="suggest__list" id="coCityList" role="listbox" hidden></ul>
              </span>
            </label>
            <div class="co-delivery" id="coDelivery" hidden>
              <div class="co-tabs" id="coTabs" role="tablist"></div>
              <div class="co-picker" id="coPicker">
                <div class="co-map" id="coMap"><p class="co-map__msg">Загружаем карту…</p></div>
                <input class="co-search" id="coSearch" type="search" placeholder="Поиск по адресу, улице или метро" aria-label="Поиск пункта">
                <ul class="co-points" id="coPoints"></ul>
              </div>
              <div class="co-chosen" id="coChosen" hidden></div>
            </div>
            <p class="co-hint" id="coHint" hidden></p>
          </section>

          <section class="co-sec">
            <h4 class="co-sec__title"><span>3</span>Комментарий <em>(необязательно)</em></h4>
            <label class="field"><textarea name="comment" rows="2" placeholder="Пожелания к заказу" aria-label="Комментарий"></textarea></label>
          </section>

          <div class="co-total" id="coTotal"></div>
          <label class="check"><input type="checkbox" name="agree">
            <span>Я подтверждаю согласие с условиями <a href="privacy/" target="_blank">политики конфиденциальности</a>
              и <a href="offer/" target="_blank">договора оферты</a></span></label>
          <p class="form__error" id="coError" hidden></p>
          <button class="btn btn--dark btn--wide co-pay" type="submit" id="coPay">Перейти к оплате</button>
          <p class="co-secure"><svg viewBox="0 0 24 24"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
            Оплата картой, через СБП или SberPay на защищённой странице ЮKassa</p>
        </form>
      </div>`;
    document.body.appendChild(el);
    el.addEventListener('click', e => { if (e.target.closest('[data-close]')) closeLayer(el); });
    return el;
  }

  let modal = null;
  const form = () => $('#coForm');

  /* ---------- товары и итог ---------- */
  function localItems() {
    // пока сервер не ответил — показываем по ценам из каталога
    return st.items.map(i => { const p = findProduct(i.id); return { ...i, name: p.name, price: p.price, image: imgOf(p) }; });
  }

  function renderItems() {
    const items = st.quote ? st.quote.items : localItems();
    $('#coItems').innerHTML = items.map(i => `
      <li class="co-item">
        <img src="${escapeHtml(i.image)}" alt="">
        <div><p class="co-item__name">${escapeHtml(i.name)}</p>
          <p class="co-item__meta">${i.size ? 'Размер ' + escapeHtml(i.size) + ' · ' : ''}${i.qty} шт.</p></div>
        <strong>${rub(i.price * i.qty)}</strong>
      </li>`).join('');
  }

  const deliveryOf = type => st.quote && st.quote.delivery && st.quote.delivery[type];
  // срок может быть неизвестен (фиксированная цена без расчёта СДЭК) — тогда пусто
  const days = q => (!q.daysMin ? '' : (q.daysMin === q.daysMax ? q.daysMin : `${q.daysMin}–${q.daysMax}`) + ' дн.');
  const withDays = (text, q) => (days(q) ? `${text} · ${days(q)}` : text);

  function totals() {
    const goods = st.quote ? st.quote.goods : localItems().reduce((s, i) => s + i.price * i.qty, 0);
    const free = st.quote ? st.quote.freeShipping : false;
    const q = st.point && deliveryOf(st.point.type);
    const ship = q ? (free ? 0 : q.cost) : null;
    return { goods, free, ship, total: goods + (ship || 0), q };
  }

  function renderTotal() {
    const t = totals();
    const shipText = t.ship === null ? (t.free ? '<span class="co-free">Бесплатно</span>' : '<span class="co-muted">выберите пункт</span>')
      : t.ship === 0 ? `<span class="co-free">Бесплатно</span>${t.q ? ` <s>${rub(t.q.cost)}</s>` : ''}` : rub(t.ship);
    $('#coTotal').innerHTML = `
      <div class="co-total__row"><span>Товары</span><span>${rub(t.goods)}</span></div>
      <div class="co-total__row"><span>${t.q ? withDays('Доставка СДЭК', t.q) : 'Доставка СДЭК'}</span><span>${shipText}</span></div>
      ${t.free ? '<div class="co-total__promo">От 2 позиций — доставка по России бесплатно</div>' : ''}
      <div class="co-total__row co-total__sum"><span>Итого</span><span>${rub(t.total)}</span></div>`;
    $('#coPay').textContent = st.point ? `Перейти к оплате · ${rub(t.total)}` : 'Перейти к оплате';
  }

  async function refreshQuote() {
    try {
      st.quote = await api('/quote', { items: st.items, cityCode: st.city ? st.city.code : null });
      hint('');
    } catch (e) {
      if (st.city) hint(e.message);
      else showError(e.message);
    }
    renderItems();
    renderTotal();
  }

  /* ---------- город ---------- */
  function initCity() {
    const input = form().elements.city, list = $('#coCityList');
    let found = [], active = -1, timer = 0, seq = 0;
    const open = show => { list.hidden = !show; input.setAttribute('aria-expanded', String(show)); };
    const render = () => {
      list.innerHTML = found.length
        ? found.map((c, i) => `<li class="suggest__item" role="option" data-i="${i}" aria-selected="${i === active}">
            <span>${escapeHtml(c.name)}</span><span class="suggest__region">${escapeHtml(c.region)}</span></li>`).join('')
        : '<li class="suggest__empty">Город не найден в справочнике СДЭК</li>';
      open(true);
    };
    const choose = i => {
      const c = found[i];
      if (!c) return;
      input.value = c.name;
      open(false);
      input.closest('.field').classList.remove('is-invalid');
      setCity(c);
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      if (st.city && input.value !== st.city.name) resetCity();
      const q = input.value.trim();
      if (q.length < 2) { open(false); return; }
      timer = setTimeout(async () => {
        const my = ++seq;
        try {
          const { cities } = await api('/cdek/cities?q=' + encodeURIComponent(q));
          if (my !== seq) return;
          found = cities; active = cities.length ? 0 : -1; render();
        } catch { /* сеть — молча, пользователь может ввести ещё раз */ }
      }, 220);
    });
    input.addEventListener('keydown', e => {
      if (list.hidden || !found.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        active = (active + (e.key === 'ArrowDown' ? 1 : -1) + found.length) % found.length;
        render();
      } else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
      else if (e.key === 'Escape') { e.stopPropagation(); open(false); }
    });
    list.addEventListener('mousedown', e => {
      const li = e.target.closest('.suggest__item');
      if (li) { e.preventDefault(); choose(Number(li.dataset.i)); }
    });
    input.addEventListener('blur', () => setTimeout(() => open(false), 150));
  }

  function resetCity() {
    st.city = null; st.points = []; st.point = null;
    $('#coDelivery').hidden = true;
    hint('');
    if (st.quote) st.quote.delivery = null;
    renderTotal();
  }

  async function setCity(city, keepPointCode) {
    st.city = city; st.point = null; st.points = []; st.pickerOpen = true;
    store.set('coulair-city', city);
    if (st.quote) st.quote.delivery = null;           // цены прошлого города больше не годятся
    $('#coDelivery').hidden = false;
    $('#coChosen').hidden = true;
    $('#coPicker').hidden = false;
    $('#coTabs').hidden = false;
    $('#coPoints').innerHTML = '<li class="co-points__empty">Ищем пункты СДЭК…</li>';
    $('#coTabs').innerHTML = '';
    renderTotal();

    let pointsError = null;
    const [points] = await Promise.all([
      api('/cdek/points?city=' + city.code).then(d => d.points).catch(e => { pointsError = e.message; return []; }),
      refreshQuote(),
    ]);
    if (st.city !== city) return;                     // пока ждали, выбрали другой город
    if (pointsError || !st.quote || !st.quote.delivery) {
      $('#coDelivery').hidden = true;
      if (pointsError) hint(pointsError);             // ошибку расчёта refreshQuote уже показал
      return;
    }
    const weight = st.quote.weight || 0, boxes = st.quote.boxes || [];
    // постамат — только если каждое место влезает в какую-нибудь ячейку
    const fits = p => !p.cells || !p.cells.length || boxes.every(b => p.cells.some(c => b.every((v, i) => v <= c[i])));
    st.points = points.filter(p => deliveryOf(p.type) && (!p.weightMax || weight / 1000 <= p.weightMax) && (p.type !== 'POSTAMAT' || fits(p)));
    if (!st.points.length) {
      $('#coDelivery').hidden = true;
      hint(points.length ? 'В этом городе СДЭК не может доставить заказ — напишите нам в Telegram, подберём вариант.'
        : 'В этом городе нет пунктов выдачи СДЭК. Выберите ближайший город или напишите нам в Telegram.');
      return;
    }
    if (!st.points.some(p => p.type === st.filter)) st.filter = 'ALL';
    renderTabs();
    const keep = keepPointCode && st.points.find(p => p.code === keepPointCode);
    await showMap();
    if (keep) choosePoint(keep, false);
  }

  /* ---------- пункты: вкладки, карта, список ---------- */
  function renderTabs() {
    const free = st.quote && st.quote.freeShipping;
    const tab = (type, label, n, q) => `<button type="button" class="co-tab" role="tab" data-type="${type}" aria-selected="${st.filter === type}">
      ${type !== 'ALL' ? `<i style="background:${TYPES[type].color}"></i>` : ''}${label}
      <small>${q ? (free ? 'бесплатно' : rub(q.cost)) : n}</small></button>`;
    const html = [tab('ALL', 'Все', st.points.length)];
    for (const type of Object.keys(TYPES)) {
      const n = st.points.filter(p => p.type === type).length;
      if (n) html.push(tab(type, TYPES[type].many, n, deliveryOf(type)));
    }
    $('#coTabs').innerHTML = html.join('');
  }

  const visiblePoints = () => st.points.filter(p => st.filter === 'ALL' || p.type === st.filter);

  async function showMap() {
    let L;
    try { L = await loadLeaflet(); }
    catch { $('#coMap').innerHTML = '<p class="co-map__msg">Карта не загрузилась — выберите пункт из списка ниже</p>'; renderList(); return; }
    if (!st.map) {
      $('#coMap').innerHTML = '';
      st.map = L.map('coMap', { preferCanvas: true, zoomControl: true, attributionControl: true });
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19, attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
      }).addTo(st.map);
      st.layer = L.layerGroup().addTo(st.map);
      st.map.on('moveend', () => { if (!$('#coSearch').value.trim()) renderList(); });
    }
    drawMarkers(true);
  }

  function drawMarkers(fit) {
    if (!st.map) { renderList(); return; }
    const L = window.L;
    st.layer.clearLayers();
    st.markers.clear();
    const list = visiblePoints();
    for (const p of list) {
      const sel = st.point && st.point.code === p.code;
      const m = L.circleMarker([p.lat, p.lng], {
        radius: sel ? 10 : 7, weight: sel ? 3 : 2, color: sel ? '#0e0e10' : '#fff',
        fillColor: TYPES[p.type].color, fillOpacity: 1,
      }).addTo(st.layer);
      m.bindTooltip(`<b>${TYPES[p.type].label}</b><br>${escapeHtml(p.address)}`, { direction: 'top', offset: [0, -6] });
      m.on('click', () => choosePoint(p));
      st.markers.set(p.code, m);
    }
    setTimeout(() => {
      st.map.invalidateSize();
      if (fit && list.length) st.map.fitBounds(L.latLngBounds(list.map(p => [p.lat, p.lng])).pad(0.05), { maxZoom: 14 });
      renderList();
    }, 0);
  }

  function renderList() {
    const q = $('#coSearch').value.trim().toLowerCase().replace(/ё/g, 'е');
    let list = visiblePoints();
    if (q) {
      const words = q.split(/\s+/);
      list = list.filter(p => {
        const hay = (p.address + ' ' + p.name + ' ' + p.metro + ' ' + p.note).toLowerCase().replace(/ё/g, 'е');
        return words.every(w => hay.includes(w));
      });
    } else if (st.map) {
      // без поиска — пункты в видимой части карты, ближние к центру первыми
      const b = st.map.getBounds(), c = st.map.getCenter();
      list = list.filter(p => b.contains([p.lat, p.lng]))
        .sort((a, z) => ((a.lat - c.lat) ** 2 + (a.lng - c.lng) ** 2) - ((z.lat - c.lat) ** 2 + (z.lng - c.lng) ** 2));
    }
    const shown = list.slice(0, LIST_LIMIT);
    $('#coPoints').innerHTML = shown.length ? shown.map(p => {
      const q2 = deliveryOf(p.type);
      return `<li><button type="button" class="co-point${st.point && st.point.code === p.code ? ' is-active' : ''}" data-code="${escapeHtml(p.code)}">
        <span class="co-point__type" style="--c:${TYPES[p.type].color}">${TYPES[p.type].label}</span>
        <span class="co-point__addr">${escapeHtml(p.address)}</span>
        <span class="co-point__meta">${escapeHtml(p.workTime)}${p.metro ? ' · м. ' + escapeHtml(p.metro) : ''}</span>
        ${q2 ? `<span class="co-point__price">${withDays(st.quote.freeShipping ? 'Бесплатно' : rub(q2.cost), q2)}</span>` : ''}
      </button></li>`;
    }).join('') + (list.length > LIST_LIMIT ? `<li class="co-points__empty">И ещё ${list.length - LIST_LIMIT} — приблизьте карту или воспользуйтесь поиском</li>` : '')
      : `<li class="co-points__empty">${q ? 'Ничего не нашли — попробуйте другой адрес' : 'В этой части карты пунктов нет — отдалите карту'}</li>`;
  }

  function choosePoint(p, scroll = true) {
    st.point = p;
    st.pickerOpen = false;
    store.set('coulair-point', { city: st.city.code, code: p.code });
    const q = deliveryOf(p.type);
    const free = st.quote && st.quote.freeShipping;
    $('#coChosen').innerHTML = `
      <div class="co-chosen__head">
        <span class="co-point__type" style="--c:${TYPES[p.type].color}">${TYPES[p.type].label} СДЭК</span>
        <button type="button" class="co-link" data-change>Изменить</button>
      </div>
      <p class="co-chosen__addr">${escapeHtml(st.city.name)}, ${escapeHtml(p.address)}</p>
      ${p.workTime ? `<p class="co-chosen__meta">${escapeHtml(p.workTime)}</p>` : ''}
      ${p.note ? `<p class="co-chosen__meta">${escapeHtml(p.note)}</p>` : ''}
      ${q ? `<p class="co-chosen__price">${withDays(free ? 'Бесплатно' : rub(q.cost), q)}${days(q) ? ' после отправки' : ''}</p>` : ''}`;
    $('#coChosen').hidden = false;
    $('#coPicker').hidden = true;
    $('#coTabs').hidden = true;
    hint('');
    renderTotal();
    if (scroll) $('#coChosen').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function reopenPicker() {
    st.pickerOpen = true;
    $('#coChosen').hidden = true;
    $('#coPicker').hidden = false;
    $('#coTabs').hidden = false;
    drawMarkers(false);
    if (st.map && st.point) st.map.setView([st.point.lat, st.point.lng], Math.max(st.map.getZoom(), 14));
  }

  function initPicker() {
    $('#coTabs').addEventListener('click', e => {
      const b = e.target.closest('.co-tab');
      if (!b) return;
      st.filter = b.dataset.type;
      $$('.co-tab').forEach(t => t.setAttribute('aria-selected', String(t === b)));
      drawMarkers(true);
    });
    $('#coPoints').addEventListener('click', e => {
      const b = e.target.closest('.co-point');
      if (!b) return;
      const p = st.points.find(x => x.code === b.dataset.code);
      if (p) choosePoint(p);
    });
    let t = 0;
    $('#coSearch').addEventListener('input', () => { clearTimeout(t); t = setTimeout(renderList, 120); });
    $('#coSearch').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
    $('#coChosen').addEventListener('click', e => { if (e.target.closest('[data-change]')) reopenPicker(); });
  }

  /* ---------- анкета ---------- */
  function formatPhone(value) {
    // всё после «+7» — местный номер; иначе ведущие 8/7 считаем кодом страны
    let d;
    if (value.startsWith('+7')) {
      d = value.slice(2).replace(/\D/g, '');
      if (d.length === 11 && /^[78]/.test(d)) d = d.slice(1);
    } else { d = value.replace(/\D/g, ''); if (d.length > 10 || d[0] === '8' || d[0] === '7') d = d.replace(/^[78]/, ''); }
    d = d.slice(0, 10);
    if (!d) return value.startsWith('+') ? '+7' : '';
    const p = [d.slice(0, 3), d.slice(3, 6), d.slice(6, 8), d.slice(8, 10)];
    let out = '+7 (' + p[0];
    if (p[0].length === 3) out += ')';
    if (p[1]) out += ' ' + p[1];
    if (p[2]) out += '-' + p[2];
    if (p[3]) out += '-' + p[3];
    return out;
  }

  function hint(text) { const h = $('#coHint'); h.textContent = text; h.hidden = !text; }
  function showError(text) { const e = $('#coError'); e.textContent = text; e.hidden = !text; }

  const CONTACT_FIELDS = ['name', 'phone', 'email', 'telegram'];
  function initForm() {
    const f = form();
    const phone = f.elements.phone;
    phone.addEventListener('input', () => { phone.value = formatPhone(phone.value); });
    phone.addEventListener('focus', () => { if (!phone.value) phone.value = '+7'; });

    // черновик контактов — чтобы не вводить заново при следующем заказе
    const saved = store.get('coulair-contact', {});
    CONTACT_FIELDS.forEach(n => { if (saved[n]) f.elements[n].value = saved[n]; });
    f.addEventListener('input', e => {
      const n = e.target.name;
      if (CONTACT_FIELDS.includes(n)) {
        store.set('coulair-contact', Object.fromEntries(CONTACT_FIELDS.map(k => [k, f.elements[k].value.trim()])));
      }
      const field = e.target.closest('.field');
      if (field) field.classList.remove('is-invalid');
      if (n === 'agree' && e.target.checked) showError('');
    });

    f.addEventListener('submit', async e => {
      e.preventDefault();
      showError('');
      $$('.field', f).forEach(x => x.classList.remove('is-invalid'));
      let bad = null;
      const mark = n => { f.elements[n].closest('.field').classList.add('is-invalid'); bad = bad || f.elements[n]; };
      if (f.elements.name.value.trim().split(/\s+/).filter(w => w.length > 1).length < 2) mark('name');
      if (phone.value.replace(/\D/g, '').length !== 11) mark('phone');
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(f.elements.email.value.trim())) mark('email');
      if (!st.city) mark('city');
      if (bad) { showError('Проверьте выделенные поля'); bad.focus(); return; }
      if (!st.point) { showError('Выберите пункт выдачи или постамат'); $('#coDelivery').scrollIntoView({ block: 'center', behavior: 'smooth' }); return; }
      if (!f.elements.agree.checked) { showError('Подтвердите согласие с политикой конфиденциальности и офертой'); return; }

      const btn = $('#coPay');
      btn.disabled = true; btn.textContent = 'Создаём платёж…';
      try {
        const res = await api('/orders', {
          items: st.items, fromCart: st.fromCart, agree: true,
          contact: Object.fromEntries(CONTACT_FIELDS.map(k => [k, f.elements[k].value.trim()])),
          comment: f.elements.comment.value.trim(),
          cityCode: st.city.code, cityName: st.city.name, pointCode: st.point.code,
        });
        store.set('coulair-pending', { id: res.id, fromCart: st.fromCart });
        location.href = res.paymentUrl;
      } catch (err) {
        if (err.fields) Object.keys(err.fields).forEach(n => f.elements[n] && mark(n));
        showError(err.fields ? Object.values(err.fields)[0] : err.message);
        btn.disabled = false;
        renderTotal();
      }
    });
  }

  /* ---------- открытие ---------- */
  function open(items, fromCart) {
    if (!modal) { modal = build(); initCity(); initPicker(); initForm(); }
    st.items = items.map(i => ({ id: i.id, size: i.size || null, qty: i.qty || 1 }));
    st.fromCart = fromCart;
    st.quote = null;
    showError('');
    $('#coPay').disabled = false;
    renderItems();
    renderTotal();
    openLayer('#checkoutModal');

    // город и пункт с прошлого раза
    const city = store.get('coulair-city', null), last = store.get('coulair-point', null);
    if (city && city.code) {
      form().elements.city.value = city.name;
      setCity(city, last && last.city === city.code ? last.code : null);
    } else {
      resetCity();
      refreshQuote();
    }
    loadLeaflet().catch(() => {});
  }

  window.CoulairCheckout = { open };
})();
