import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCdekClient } from '../cdek-client.js';
import { resolveCdekSettings } from '../cdek-settings.js';
const response = (data, status=200) => ({ ok: status >=200 && status<300, status, json:async()=>data });

test('OAuth: один токен для параллельных запросов, обновление до истечения срока',async()=>{
  let tokens=0, now=0; const calls=[];
  const c=createCdekClient({clientId:'test-id',clientSecret:'private-test-secret',now:()=>now,fetchImpl:async(url,o)=>{
    calls.push({url,...o});
    if(url.endsWith('/oauth/token')) return response({access_token:'token-'+(++tokens),expires_in:3600});
    assert.equal(o.headers.Authorization,'Bearer token-'+tokens);return response([{code:251}]);
  }});
  await Promise.all([c.api('GET','/location/cities?code=251'),c.api('GET','/deliverypoints?city_code=251')]);
  assert.equal(tokens,1);assert.equal(c.status().authenticated,true);
  assert.equal(calls[0].url,'https://api.cdek.ru/v2/oauth/token');
  assert.equal(calls[0].body.get('grant_type'),'client_credentials');
  now=3_550_000;await c.api('GET','/location/cities?code=251');assert.equal(tokens,2);
  assert.ok(!JSON.stringify(c.status()).includes('private-test-secret'));
  assert.ok(!JSON.stringify(c.status()).includes('token-'));
});

test('401 обновляет токен один раз, ошибки не раскрывают ключи',async()=>{
  let tokens=0, requests=0;
  const c=createCdekClient({clientId:'id',clientSecret:'private-test-secret',fetchImpl:async(url)=>{
    if(url.endsWith('/oauth/token')) return response({access_token:'t'+(++tokens),expires_in:3600});
    requests++;return response({},401);
  }});
  await assert.rejects(c.api('GET','/location/cities'),e=>e.code==='unauthorized' && !e.message.includes('private-test-secret'));
  assert.equal(tokens,2);assert.equal(requests,2);
  const broken=createCdekClient({clientId:'id',clientSecret:'private-test-secret',fetchImpl:async()=>{throw new Error('private-test-secret');}});
  await assert.rejects(broken.authenticate(),e=>e.code==='unavailable'&&!e.message.includes('private-test-secret'));
  const invalid=createCdekClient({clientId:'id',clientSecret:'secret',fetchImpl:async()=>response({access_token:'x'})});
  await assert.rejects(invalid.authenticate(),e=>e.code==='invalid_token');
});

test('Контуры разделены, пустые ключи не приводят к запросу учебных цен',async()=>{
  let called=false;
  const empty=createCdekClient({fetchImpl:async()=>{called=true;}});
  assert.equal(empty.status().state,'awaiting_credentials');
  await assert.rejects(empty.authenticate(),e=>e.code==='missing_credentials');assert.equal(called,false);
  const sandbox=createCdekClient({environment:'sandbox',clientId:'id',clientSecret:'secret',fetchImpl:async(url)=>{
    assert.ok(url.startsWith('https://api.edu.cdek.ru/v2/'));return response({access_token:'sandbox',expires_in:3600});
  }});await sandbox.authenticate();assert.equal(sandbox.status().environment,'sandbox');
});

test('Файл ключей: закрытая конфигурация, неполная пара, ошибочный JSON, старые имена',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'coulair-cdek-')),file=path.join(dir,'credentials.json');
  fs.writeFileSync(file,JSON.stringify({client_id:'file-id',client_secret:'file-secret'}),{mode:0o600});
  const fromFile=resolveCdekSettings({CDEK_CREDENTIALS_FILE:file});assert.equal(fromFile.account,'file-id');assert.equal(fromFile.configurationError,null);
  const fromEnv=resolveCdekSettings({CDEK_CREDENTIALS_FILE:file,CDEK_ACCOUNT:'old-id',CDEK_SECURE:'old-secret'});assert.equal(fromEnv.account,'old-id');assert.equal(fromEnv.secure,'old-secret');
  const partial=resolveCdekSettings({CDEK_CREDENTIALS_FILE:file,CDEK_CLIENT_ID:'only-id'});assert.equal(partial.configurationError,'incomplete_credentials');
  fs.writeFileSync(file,'bad json with private-test-secret');
  const bad=resolveCdekSettings({CDEK_CREDENTIALS_FILE:file});assert.equal(bad.configurationError,'credentials_file_invalid_or_missing');assert.equal(bad.secure,'');
  assert.equal(resolveCdekSettings({CDEK_ENV:'invalid'}).configurationError,'invalid_environment');
});

test('Боевой расчёт API без ключей блокируется до обращения к учебному серверу',async()=>{
  process.env.CDEK_CALC='api';process.env.CDEK_ENV='production';
  for(const k of ['CDEK_CLIENT_ID','CDEK_CLIENT_SECRET','CDEK_ACCOUNT','CDEK_SECURE','CDEK_CREDENTIALS_FILE']) delete process.env[k];
  let called=false;globalThis.fetch=async()=>{called=true;throw new Error('must not call sandbox');};
  const {quote}=await import('../cdek.js');
  await assert.rejects(quote(250,[{weight:950,length:35,width:30,height:5}]),/боевого API/);
  assert.equal(called,false);
});
