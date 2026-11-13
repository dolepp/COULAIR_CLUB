import fs from 'node:fs';

// Файл ключей находится вне сайта и репозитория. Ошибка файла не ломает резервный расчёт.
export function resolveCdekSettings(env = process.env) {
  let file = {}, configurationError = null;
  const envId = env.CDEK_CLIENT_ID || env.CDEK_ACCOUNT || '';
  const envSecret = env.CDEK_CLIENT_SECRET || env.CDEK_SECURE || '';
  if (env.CDEK_CREDENTIALS_FILE && !(envId || envSecret)) {
    try {
      file = JSON.parse(fs.readFileSync(env.CDEK_CREDENTIALS_FILE, 'utf8'));
      if (!file || typeof file !== 'object' || Array.isArray(file)) throw new Error();
      for (const k of ['client_id', 'client_secret']) if (file[k] != null && typeof file[k] !== 'string') throw new Error();
    } catch { file = {}; configurationError = 'credentials_file_invalid_or_missing'; }
  }
  const account = String(envId || (!(envId || envSecret) && file.client_id) || '').trim();
  const secure = String(envSecret || (!(envId || envSecret) && file.client_secret) || '').trim();
  const environment = env.CDEK_ENV || 'production';
  if (!['production', 'sandbox'].includes(environment)) configurationError = 'invalid_environment';
  if (!!account !== !!secure) configurationError = 'incomplete_credentials';
  return { account, secure, environment, configurationError };
}
