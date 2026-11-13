// Официальный API СДЭК v2: OAuth client_credentials, кеш токена и один повтор при 401.
// Общие учебные ключи из документации; они никогда не используются для боевого расчёта цены.
export const CDEK_SANDBOX = { clientId: 'wqGwiQx0gg8mLtiEKsUinjVSICCjtTEP', clientSecret: 'RmAmgvSgSl1yirlz9QupbzOJVqhCxcP5' };
const BASES = { production: 'https://api.cdek.ru/v2', sandbox: 'https://api.edu.cdek.ru/v2' };
export class CdekApiError extends Error {
  constructor(code, status = null) {
    const labels = { missing_credentials: 'не заполнены ключи API', invalid_configuration: 'проверьте настройки подключения API',
      unauthorized: 'API отклонил ключи', invalid_token: 'API вернул некорректный токен', rate_limited: 'лимит запросов, повторите позже',
      unavailable: 'API временно недоступен', api_error: 'API не выполнил запрос' };
    super('СДЭК: ' + (labels[code] || labels.api_error) + (status ? ` (${status})` : ''));
    this.code = code; this.status = status;
  }
}
export function createCdekClient({ environment = 'production', clientId = '', clientSecret = '', configurationError = null,
  fetchImpl = (...args) => fetch(...args), now = () => Date.now() } = {}) {
  let token = null, until = 0, inflight = null;
  const configured = !!(clientId && clientSecret && !configurationError && BASES[environment]);
  const status = () => ({ configured, environment, authenticated: !!(token && until > now()),
    state: configurationError || !BASES[environment] ? 'invalid_configuration' : configured ? 'configured' : 'awaiting_credentials' });
  function httpError(status) {
    return new CdekApiError(status === 401 || status === 403 ? 'unauthorized' : status === 429 ? 'rate_limited' : status >= 500 ? 'unavailable' : 'api_error', status);
  }
  async function request(url, options) {
    try { return await fetchImpl(url, { ...options, signal: AbortSignal.timeout(20000) }); }
    catch { throw new CdekApiError('unavailable'); }
  }
  async function accessToken() {
    if (!configured) throw new CdekApiError(status().state === 'invalid_configuration' ? 'invalid_configuration' : 'missing_credentials');
    if (token && until > now()) return token;
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await request(BASES[environment] + '/oauth/token', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret }),
      });
      if (!res.ok) throw httpError(res.status);
      const data = await res.json().catch(() => null);
      if (!data || typeof data.access_token !== 'string' || !data.access_token || !(Number(data.expires_in) > 0) || !Number.isFinite(Number(data.expires_in))) throw new CdekApiError('invalid_token');
      token = data.access_token;
      const ttl = Number(data.expires_in) * 1000;
      until = now() + ttl - Math.min(60000, ttl / 10);
      return token;
    })();
    try { return await inflight; } finally { inflight = null; }
  }
  async function api(method, route, body) {
    if (!route.startsWith('/') || route.startsWith('//')) throw new CdekApiError('invalid_configuration');
    for (let attempt = 0; attempt < 2; attempt++) {
      const usedToken = await accessToken();
      const res = await request(BASES[environment] + route, {
        method, headers: { Authorization: 'Bearer ' + usedToken, ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 401 && attempt === 0) {
        if (token === usedToken) { token = null; until = 0; }
        continue;
      }
      if (!res.ok) throw httpError(res.status);
      const data = await res.json().catch(() => null);
      if (data === null) throw new CdekApiError('api_error');
      return data;
    }
  }
  return { api, status, authenticate: async () => { await accessToken(); return status(); } };
}
