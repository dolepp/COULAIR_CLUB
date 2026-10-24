/* СДЭК API v2: города, пункты выдачи и постаматы, расчёт стоимости */
import { config } from './config.js';

// Публичные ключи тестового контура из документации СДЭК
const TEST = {
  base: 'https://api.edu.cdek.ru/v2',
  account: 'wqGwiQx0gg8mLtiEKsUinjVSICCjtTEP',
  secure: 'RmAmgvSgSl1yirlz9QupbzOJVqhCxcP5',
};
const live = !!(config.cdek.account && config.cdek.secure);
const API = live
  ? { base: 'https://api.cdek.ru/v2', account: config.cdek.account, secure: config.cdek.secure }
  : TEST;
const calc = config.cdek.calc || (live ? 'api' : 'table');
export const cdekMode = (live ? 'live' : 'test') + (calc === 'table' ? ' · таблица' : '');

let token = null, tokenUntil = 0;
async function auth() {
  if (token && Date.now() < tokenUntil) return token;
  const res = await fetch(API.base + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'client_credentials', client_id: API.account, client_secret: API.secure }),
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) throw new Error('СДЭК: авторизация ' + res.status);
  const d = await res.json();
  token = d.access_token;
  tokenUntil = Date.now() + (d.expires_in - 60) * 1000;
  return token;
}

async function api(method, path, body) {
  const send = async () => fetch(API.base + path, {
    method,
    headers: { Authorization: 'Bearer ' + (await auth()), ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  let res = await send();
  if (res.status === 401) { token = null; res = await send(); }
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = data && data.errors ? data.errors.map(e => e.message).join('; ') : 'HTTP ' + res.status;
    const err = new Error('СДЭК: ' + msg);
    err.cdek = data;
    throw err;
  }
  return data;
}

// Простой кэш в памяти
const cache = new Map();
async function cached(key, ttlMs, fn) {
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  const value = await fn();
  cache.set(key, { value, until: Date.now() + ttlMs });
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return value;
}

export async function suggestCities(q) {
  q = String(q || '').trim().slice(0, 60);
  if (q.length < 2) return [];
  return cached('city:' + q.toLowerCase(), 24 * 3600e3, async () => {
    const list = await api('GET', '/location/suggest/cities?' + new URLSearchParams({ name: q, country_code: 'RU' }));
    return (list || []).slice(0, 10).map(c => {
      const parts = String(c.full_name || '').split(',').map(s => s.trim()).filter(Boolean);
      if (parts[parts.length - 1] === 'Россия') parts.pop();
      return { code: c.code, name: parts[0] || c.full_name, region: parts.length > 1 ? parts[parts.length - 1] : '' };
    });
  });
}

// Без ключей — публичный справочник СДЭК: те же реальные пункты, что на cdek.ru
async function publicPoints(cityCode) {
  const res = await fetch('https://integration.cdek.ru/pvzlist/v1/json?' + new URLSearchParams({ cityid: cityCode, type: 'ALL' }), {
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error('СДЭК: справочник пунктов недоступен (' + res.status + ')');
  const { pvz = [] } = await res.json();
  return pvz
    .filter(p => p.coordX && p.coordY && (p.type === 'PVZ' || p.type === 'POSTAMAT') && p.isHandout !== false && p.status !== 'INACTIVE')
    .map(p => ({
      code: p.code,
      type: p.type,
      name: p.name,
      address: p.address || p.fullAddress,
      addressFull: p.fullAddress,
      city: p.city,
      lat: Number(p.coordY),
      lng: Number(p.coordX),
      workTime: p.workTime || '',
      note: p.addressComment || '',
      metro: p.nearestStation || p.metroStation || '',
      weightMax: p.weightLimit ? Number(p.weightLimit.WeightMax) || null : null,
      cells: (p.dimensions || []).map(d => [d.width, d.height, d.depth].map(Number).sort((a, b) => b - a)),
      dressing: !!p.isDressingRoom,
    }));
}

export async function deliveryPoints(cityCode) {
  cityCode = Number(cityCode);
  if (!Number.isInteger(cityCode) || cityCode <= 0) return [];
  return cached('points:' + cityCode, 6 * 3600e3, async () => {
    if (!live) return publicPoints(cityCode);
    const list = await api('GET', '/deliverypoints?' + new URLSearchParams({
      city_code: cityCode, country_code: 'RU', type: 'ALL', is_handout: 'true',
    }));
    return (list || [])
      .filter(p => p.location && p.location.latitude && (p.type === 'PVZ' || p.type === 'POSTAMAT') && p.status !== 'INACTIVE')
      .map(p => ({
        code: p.code,
        type: p.type,
        name: p.name,
        address: p.location.address || p.location.address_full,
        addressFull: p.location.address_full,
        city: p.location.city,
        lat: p.location.latitude,
        lng: p.location.longitude,
        workTime: p.work_time || '',
        note: p.address_comment || '',
        metro: p.nearest_metro_station || p.nearest_station || '',
        weightMax: p.weight_max || null,
        cells: (p.dimensions || []).map(d => [d.width, d.height, d.depth].map(Number).sort((a, b) => b - a)),
        dressing: !!p.is_dressing_room,
      }));
  });
}

async function tariff(code, cityCode, packages) {
  const d = await api('POST', '/calculator/tariff', {
    tariff_code: code,
    from_location: { code: config.cdek.fromCityCode },
    to_location: { code: Number(cityCode) },
    packages: packages.map(p => ({ weight: p.weight, length: p.length, width: p.width, height: p.height })),
  });
  return {
    tariff: code,
    cost: Math.ceil((d.total_sum ?? d.delivery_sum) + config.cdek.markup),
    daysMin: d.calendar_min ?? d.period_min,
    daysMax: d.calendar_max ?? d.period_max,
  };
}

/* ---------- своя таблица: расстояние от города отправки и вес ---------- */
const rad = d => d * Math.PI / 180;
function km(lat1, lng1, lat2, lng2) {
  const a = Math.sin(rad(lat2 - lat1) / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(rad(lng2 - lng1) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(a));
}

// Координаты города: середина его пунктов выдачи, иначе справочник городов СДЭК
async function cityGeo(cityCode) {
  return cached('geo:' + cityCode, 7 * 24 * 3600e3, async () => {
    const pts = await deliveryPoints(cityCode).catch(() => []);
    if (pts.length) {
      const lats = pts.map(p => p.lat).sort((a, b) => a - b), lngs = pts.map(p => p.lng).sort((a, b) => a - b);
      return { lat: lats[lats.length >> 1], lng: lngs[lngs.length >> 1] };
    }
    const [c] = await api('GET', '/location/cities?' + new URLSearchParams({ code: cityCode }));
    if (!c || !c.latitude) throw new Error('СДЭК: не знаю, где этот город');
    return { lat: c.latitude, lng: c.longitude };
  });
}

// Вес к оплате: больший из фактического и объёмного (Д×Ш×В/5000), вверх до целого кг
const billableKg = packages => Math.max(1, Math.ceil(packages.reduce((s, p) =>
  s + Math.max(p.weight / 1000, p.length * p.width * p.height / 5000), 0) - 1e-9));

async function tableTariffs(cityCode, packages) {
  const to = await cityGeo(cityCode);
  const dist = Math.round(km(config.cdek.fromLat, config.cdek.fromLng, to.lat, to.lng));
  const zones = config.cdek.zones;
  const z = zones.find(z => dist <= z.km) || zones[zones.length - 1];
  const kg = billableKg(packages);
  const cost = Math.ceil(z.first + z.perKg * (kg - 1) + config.cdek.markup);
  const out = {};
  for (const [type, code] of Object.entries(config.cdek.tariffs))
    out[type] = { tariff: code, cost, daysMin: z.daysMin, daysMax: z.daysMax, table: { km: dist, kg } };
  return out;
}

// Стоимость до ПВЗ и до постамата для города; null — этот вариант недоступен
export async function quote(cityCode, packages) {
  const key = 'quote:' + cityCode + ':' + JSON.stringify(packages.map(p => [p.weight, p.length, p.width, p.height]));
  return cached(key, 30 * 60e3, async () => {
    if (calc === 'table') {
      const out = await tableTariffs(cityCode, packages);
      for (const [type, price] of Object.entries(config.cdek.flat))
        if (price > 0) out[type] = { ...out[type], cost: price, fixed: true };
      return out;
    }
    const out = {};
    const flatOnly = !live && Object.values(config.cdek.flat).every(p => p > 0);
    // без ключей и с фиксированной ценой тестовый калькулятор не нужен — его сроки и цены неверны
    if (!flatOnly) await Promise.all(Object.entries(config.cdek.tariffs).map(async ([type, code]) => {
      try { out[type] = await tariff(code, cityCode, packages); }
      catch (e) { out[type] = null; if (live) console.warn('[cdek] тариф', code, 'город', cityCode, '—', e.message); }
    }));
    // тестовый контур не знает постаматов — без ключей считаем постамат по цене пункта выдачи
    if (!live && !out.POSTAMAT && out.PVZ) out.POSTAMAT = { ...out.PVZ, tariff: config.cdek.tariffs.POSTAMAT };
    // фиксированная цена доставки из .env перекрывает расчёт
    for (const [type, price] of Object.entries(config.cdek.flat)) {
      if (price <= 0) continue;
      // срок оставляем только из настоящего расчёта по ключам
      out[type] = live && out[type] ? { ...out[type], cost: price, fixed: true }
        : { tariff: config.cdek.tariffs[type], daysMin: null, daysMax: null, cost: price, fixed: true };
    }
    // ни один тариф не посчитался — не кэшируем, вдруг это временный сбой
    if (!Object.values(out).some(Boolean)) throw new Error('СДЭК не смог рассчитать доставку в этот город');
    return out;
  });
}
