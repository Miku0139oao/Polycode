import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CredentialStore, NativeProviderService } from '../service.mjs';
const tick = () => new Promise(r => setImmediate(r));
async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'polycode-auth-test-')), store = new CredentialStore(folder);
  let finish, sent;
  const provider = { startLogin: async ({ signal }) => ({ url: 'https://auth.openai.com/oauth/authorize?state=test-state', instructions: 'Test authorization', wait: new Promise(resolve => finish = resolve) }), refresh: async c => c, models: async () => [{ id: 'model-a', name: 'Model A', contextWindow: 128000 }], complete: async body => { sent = body; return Response.json({ choices: [{ message: { role: 'assistant', content: 'native' } }] }); }, close() {} };
  const service = new NativeProviderService({ codex: provider }, store, { token: 'local-fixture-secret' }); await service.start();
  t.after(async () => { await service.close(); await rm(folder, { recursive: true, force: true }); });
  const call = (path, body, extra = {}) => fetch(service.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: 'Bearer local-fixture-secret', ...extra }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { service, store, call, provider, finish: value => finish(value), sent: () => sent };
}
test('local bridge rejects unauthenticated and browser-origin requests', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.service.url + '/control/catalog')).status, 401);
  assert.equal((await f.call('/control/catalog', undefined, { Origin: 'https://evil.example' })).status, 401);
  const r = await (await f.call('/control/catalog')).json();
  assert.equal(r.providers[0].loggedIn, false); assert.deepEqual(r.providers[0].models, []);
  assert.ok(!JSON.stringify(r).includes('local-fixture-secret'));
});
test('usage lists every signed-in account and never invents quota', async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.call('/control/usage')).json(), {
    providers: [{ id: 'codex', name: 'ChatGPT', loggedIn: false }],
  });
  await f.store.set('codex', { accessToken: 'secret-account-token' });
  const missing = await (await f.call('/control/usage')).json();
  assert.deepEqual(missing, {
    providers: [{ id: 'codex', name: 'ChatGPT', loggedIn: true, message: 'This account API did not return a usage quota.' }],
  });
  assert.ok(!JSON.stringify(missing).includes('secret-account-token'));
  f.provider.usage = async () => ({ windows: [{ id: 'primary', usedPercent: 22, windowSeconds: 18000 }], plan: 'plus', email: 'secret@example.com' });
  const ok = await (await f.call('/control/usage')).json();
  assert.deepEqual(ok, {
    providers: [{ id: 'codex', name: 'ChatGPT', loggedIn: true, usage: { plan: 'plus', windows: [{ id: 'primary', usedPercent: 22, windowSeconds: 18000 }] } }],
  });
  assert.ok(!JSON.stringify(ok).includes('secret'));
  f.provider.usage = async () => { throw Object.assign(new Error('secret-upstream-body'), { code: 'upstream_http_error', status: 502 }); };
  const failed = await (await f.call('/control/usage')).json();
  assert.deepEqual(failed, {
    providers: [{ id: 'codex', name: 'ChatGPT', loggedIn: true, message: 'Polycode failed during usage lookup (upstream_http_error, HTTP 502).' }],
  });
  assert.ok(!JSON.stringify(failed).includes('secret'));
});
test('signed-out model calls fail without attempting another provider', async t => {
  const f = await fixture(t), r = await f.call('/codex/v1/chat/completions', { model: 'model-a', messages: [] });
  assert.equal(r.status, 401); assert.equal(f.sent(), undefined);
});
test('login completion refreshes catalog and scopes native inference to exact model', async t => {
  const f = await fixture(t);
  const start = await (await f.call('/control/login/start', { provider: 'codex' })).json();
  assert.ok(start.attemptId); f.finish({ accessToken: 'test-account-token' });
  await f.service.attempts.get(start.attemptId).completion;
  assert.equal((await (await f.call('/control/login/status?attemptId=' + start.attemptId)).json()).state, 'completed');
  const catalog = await (await f.call('/control/refresh', {})).json(); assert.equal(catalog.providers[0].models[0].id, 'model-a'); assert.ok(!JSON.stringify(catalog).includes('test-account-token'));
  const body = { model: 'codex/model-a', messages: [{ role: 'user', content: 'native prompt' }], tools: [{ type: 'function', function: { name: 'native-tool' } }] };
  assert.equal((await f.call('/codex/v1/chat/completions', body)).status, 200);
  assert.equal(f.sent().model, 'model-a'); assert.deepEqual(f.sent().tools, body.tools);
  assert.equal((await f.call('/codex/v1/chat/completions', { ...body, model: 'not-advertised' })).status, 400);
});
test('cancelled OAuth cannot replace an existing account on late completion', async t => {
  const f = await fixture(t); await f.store.set('codex', { accessToken: 'original-account' });
  const start = await (await f.call('/control/login/start', { provider: 'codex' })).json();
  assert.equal((await f.call('/control/login/cancel', { attemptId: start.attemptId })).status, 200);
  f.finish({ accessToken: 'late-account' }); await tick(); await tick();
  assert.equal((await f.store.get('codex')).accessToken, 'original-account');
  assert.equal((await (await f.call('/control/login/status?attemptId=' + start.attemptId)).json()).state, 'cancelled');
});
test('credential store guards commit and rejects arbitrary provider paths', async t => {
  const f = await fixture(t); await assert.rejects(() => f.store.get('../elsewhere'), /Unknown/);
  assert.equal(await f.store.set('codex', { accessToken: 'not-committed' }, () => false), false);
  assert.equal(await f.store.get('codex'), null);
});
test('refresh and login commits are serialized across an account change', async t => {
  const f = await fixture(t); await f.store.set('codex', { accessToken: 'old-account' });
  let resolveRefresh;
  f.provider.refresh = () => new Promise(resolve => resolveRefresh = resolve);
  const refresh = f.service.credential('codex'); refresh.catch(() => {});
  while (!resolveRefresh) await tick();
  const start = await f.service.login('codex'); f.finish({ accessToken: 'new-account' });
  resolveRefresh({ accessToken: 'stale-refreshed-account' });
  await refresh;
  await f.service.attempts.get(start.attemptId).completion;
  assert.equal((await f.store.get('codex')).accessToken, 'new-account');
});
test('cancelling one refresh waiter cannot cancel another consumer', async t => {
  const f = await fixture(t); await f.store.set('codex', { accessToken: 'old' });
  let finish;
  f.provider.refresh = (_, { signal }) => new Promise((resolve, reject) => { finish = resolve; signal.addEventListener('abort', () => reject(new Error('upstream cancelled'))); });
  const controller = new AbortController();
  const a = f.service.credential('codex', controller.signal); a.catch(() => {});
  const b = f.service.credential('codex');
  while (!finish) await tick(); controller.abort();
  await assert.rejects(a, /cancelled/); finish({ accessToken: 'rotated' });
  assert.equal((await b).accessToken, 'rotated');
});
test('separate stores serialize refresh and login for the shared account', async t => {
  const f = await fixture(t), second = new CredentialStore(f.store.directory);
  await f.store.set('codex', { accessToken: 'old' });
  let release; const gate = new Promise(resolve => release = resolve); let entered;
  const refresh = f.store.update('codex', async value => { entered = true; await gate; return { accessToken: value.accessToken + '-rotated' }; });
  while (!entered) await tick();
  const login = second.set('codex', { accessToken: 'new' });
  release(); await Promise.all([refresh, login]);
  assert.equal((await second.get('codex')).accessToken, 'new');
});
test('late previous-account catalog cannot replace the current account catalog', async t => {
  const f = await fixture(t); await f.store.set('codex', { accessToken: 'old' });
  let finish;
  f.provider.models = c => c.accessToken === 'old' ? new Promise(resolve => finish = resolve) : Promise.resolve([{ id: 'new-model', name: 'New', contextWindow: 128000 }]);
  const old = f.service.catalog(true);
  while (!finish) await tick();
  await f.store.set('codex', { accessToken: 'new' });
  assert.equal((await f.service.catalog(true)).providers[0].models[0].id, 'new-model');
  finish([{ id: 'old-model', name: 'Old', contextWindow: 128000 }]); await old;
  assert.equal((await f.service.catalog()).providers[0].models[0].id, 'new-model');
});
for (const [code, expected] of [['transport_error', 'transport_error'], ['secret-verifier', 'provider_authorization_failed']]) {
  test(`OAuth failure exposes only whitelisted diagnostic code: ${expected}`, async t => {
    const f = await fixture(t);
    f.provider.startLogin = async () => ({ url: 'https://auth.openai.com/oauth/authorize',
      wait: Promise.reject(Object.assign(new Error('secret-token https://example.invalid/?verifier=secret'), { code, status: 502 })) });
    const start = await f.service.login('codex');
    await f.service.attempts.get(start.attemptId).completion;
    const result = await (await f.call('/control/login/status?attemptId=' + start.attemptId)).json();
    assert.deepEqual(result, { state: 'failed', message: `Authorization failed during provider authorization (${expected}, HTTP 502). Please retry.` });
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.equal(await f.store.get('codex'), null);
  });
}
for (const [code, expected] of [['EACCES', 'permission_denied'], ['private-storage-path', 'credential_store_failed']]) {
  test(`OAuth storage failure is distinct and secret-safe: ${expected}`, async t => {
    const f = await fixture(t);
    f.store.set = async () => { throw Object.assign(new Error('secret-token /private/account/path'), { code }); };
    const start = await f.service.login('codex');
    f.finish({ accessToken: 'secret-token' });
    await f.service.attempts.get(start.attemptId).completion;
    const result = await (await f.call('/control/login/status?attemptId=' + start.attemptId)).json();
    assert.deepEqual(result, { state: 'failed', message: `Authorization failed during credential storage (${expected}). Please retry.` });
    assert.ok(!JSON.stringify(result).includes('secret'));
    assert.ok(!JSON.stringify(result).includes('private'));
    assert.equal(await f.store.get('codex'), null);
  });
}
