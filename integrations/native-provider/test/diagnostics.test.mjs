import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve, join } from 'node:path';
import { diagnostic } from '../diagnostics.mjs';
import { defaultAuthDirectory, runNative } from '../launch.mjs';
import { NativeProviderService } from '../service.mjs';
import { createCursorProvider } from '../cursor/index.mjs';

test('diagnostics never interpolate payloads, paths or arbitrary error fields', () => {
  const secret = 'TOKEN_DO_NOT_PRINT';
  assert.equal(diagnostic({ message: secret, code: secret, status: secret }, secret),
    'Polycode failed during provider operation (operation_failed).');
  assert.equal(diagnostic({ cause: { code: 'ECONNREFUSED', message: secret }, status: 503 }, 'model discovery'),
    'Polycode failed during model discovery (ECONNREFUSED, HTTP 503).');
});
test('Windows credentials survive release-directory changes and Linux retains XDG', () => {
  assert.equal(defaultAuthDirectory('win32', { LOCALAPPDATA: resolve('local') }, resolve('home')), join(resolve('local'), 'Polycode', 'auth'));
  assert.equal(defaultAuthDirectory('linux', { XDG_DATA_HOME: '/data' }, '/home'), join('/data', 'polycode', 'auth'));
});
test('one corrupt credential store does not hide other providers', async () => {
  const service = new NativeProviderService({ codex: {}, cursor: {} }, {
    async get(id) { if (id === 'codex') throw Object.assign(new Error('SECRET'), { code: 'EACCES' }); return null; },
  });
  const catalog = await service.catalog();
  assert.equal(catalog.providers.length, 2);
  assert.match(catalog.providers[0].message, /credential storage \(EACCES\)/);
  assert.equal(catalog.providers[1].message, undefined);
  assert.ok(!JSON.stringify(catalog).includes('SECRET'));
});
test('spawn failures are staged and leave no signal listeners behind', async () => {
  const before = ['SIGTERM', 'SIGINT', 'SIGHUP'].map(s => process.listenerCount(s));
  await assert.rejects(runNative({ binary: resolve('missing.exe'), cwd: process.cwd(), providers: {}, directory: resolve('unused'), spawnChild() {
    const child = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('error', Object.assign(new Error('SECRET'), { code: 'ENOENT' })));
    return child;
  }}), /native process \(ENOENT\)/);
  assert.deepEqual(['SIGTERM', 'SIGINT', 'SIGHUP'].map(s => process.listenerCount(s)), before);
});
test('fresh Cursor access tokens can discover unknown-context models without refresh', async () => {
  const future = Date.now() + 3600000;
  const provider = createCursorProvider({ fetchImpl: async url => {
    assert.ok(url.endsWith('/GetUsableModels'), 'Fresh token attempted refresh');
    return Response.json({ models: [{ modelId: 'from-upstream', displayName: 'Actual upstream name' }] });
  }});
  let current = {accessToken:'SYNTHETIC_FRESH',expiresAt:future};
  const service = new NativeProviderService({cursor:provider}, {
    async get() { return current; },
    async snapshot() { return {revision:'fixed',credential:current}; },
    async update(id, update) { current=await update(current); return {revision:'fixed',credential:current}; },
  });
  try {
    const result=await service.catalog();
    assert.equal(result.providers[0].message,undefined);
    assert.equal(result.providers[0].models[0].contextWindow,null);
    assert.equal(result.providers[0].models[0].id,'from-upstream');
  } finally { provider.close(); }
});
test('callback port errors explain the failed authorization stage without raw errors', async () => {
  const service = new NativeProviderService({codex:{async startLogin(){
    throw Object.assign(new Error('SECRET CALLBACK CONTENT'),{code:'EADDRINUSE'});
  }}},{});
  await assert.rejects(service.login('codex'), error => {
    assert.equal(error.message,'Polycode failed during provider authorization (EADDRINUSE).');
    return true;
  });
  assert.ok([...service.attempts.values()].every(a=>a.state==='cancelled'));
});
