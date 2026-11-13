#!/usr/bin/env node
// Только чтение API: авторизация, справочник и необязательный расчёт. Отправления не создаёт.
import { createCdekClient, CDEK_SANDBOX, CdekApiError } from './cdek-client.js';
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node --env-file=.env cdek-check.js [--configuration] [--sandbox] [--tariffs] [--city 250]');
    return;
  }
  const { config } = await import('./config.js');
  const c = config.cdek, sandbox = args.includes('--sandbox');
  const client = createCdekClient(sandbox ? { environment: 'sandbox', ...CDEK_SANDBOX } : {
    environment: c.environment, clientId: c.account, clientSecret: c.secure, configurationError: c.configurationError,
  });
  const report = { ok: false, ...client.status(), checks: {} };
  if (args.includes('--configuration') || !report.configured) {
    report.ok = report.configured;
    console.log(JSON.stringify(report, null, 2));
    if (!report.configured) process.exitCode = 2;
    return;
  }
  await client.authenticate(); report.checks.authorization = 'ok';
  const cities = await client.api('GET', '/location/cities?' + new URLSearchParams({ code: c.fromCityCode, size: 1 }));
  if (!Array.isArray(cities) || !cities.length) throw new CdekApiError('api_error');
  report.checks.originCity = { code: c.fromCityCode, status: 'ok' };
  if (args.includes('--tariffs')) {
    const i = args.indexOf('--city'), city = i >= 0 ? Number(args[i + 1]) : 250;
    if (!Number.isInteger(city) || city <= 0) throw new CdekApiError('invalid_configuration');
    report.checks.tariffs = {};
    for (const [type, tariffCode] of Object.entries(c.tariffs)) {
      try {
        const d = await client.api('POST', '/calculator/tariff', { tariff_code: tariffCode,
          from_location: { code: c.fromCityCode }, to_location: { code: city },
          packages: [{ weight: 950, length: 35, width: 30, height: 5 }] });
        report.checks.tariffs[type] = { ok: true, tariffCode, cost: d.total_sum ?? d.delivery_sum };
      } catch (e) { report.checks.tariffs[type] = { ok: false, code: e.code || 'api_error' }; }
    }
    if (!Object.values(report.checks.tariffs).some(t => t.ok)) process.exitCode = 1;
  }
  report.ok = !process.exitCode; report.authenticated = client.status().authenticated;
  console.log(JSON.stringify(report, null, 2));
}
main().catch(e => {
  console.log(JSON.stringify({ ok: false, code: e instanceof CdekApiError ? e.code : 'check_failed',
    message: e instanceof CdekApiError ? e.message : 'Не удалось проверить подключение СДЭК' }, null, 2));
  process.exitCode = 1;
});
