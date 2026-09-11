import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFast, codexFastMetadata, FAST_HEADER } from '../fast.mjs';
import { toResponses, createCodexProvider } from '../codex.mjs';
import { NativeProviderService } from '../service.mjs';

const base = { model: 'a', messages: [] };
test('only authoritative priority catalog capability enables fast', () => {
  for (const model of [{}, { slug: 'a-fast' }, { additional_speed_tiers: ['fast'] }, { service_tiers: [{ id: 'fast' }] }]) {
    assert.equal(codexFastMetadata(model).supportsFast, false);
  }
  assert.equal(codexFastMetadata({ service_tiers: [{ id: 'priority' }] }).supportsFast, true);
});
test('wire priority is explicit, off/default omit it, invalid and conflicting controls fail closed', () => {
  const model = { supportsFast: true };
  for (const header of [undefined, 'off']) {
    const body = { ...base };
    applyFast('codex', model, body, header);
    assert.equal(toResponses(body).request.service_tier, undefined);
  }
  const body = { ...base };
  applyFast('codex', model, body, 'on');
  assert.equal(toResponses(body).request.service_tier, 'priority');
  assert.equal(body.model, 'a');
  for (const header of ['yes', 'priority', true]) assert.throws(() => applyFast('codex', model, { ...base }, header));
  assert.throws(() => applyFast('codex', model, { ...base, service_tier: 'priority' }, 'off'), /Conflicting/);
  for (const tier of ['fast', 'flex', 'auto', 'default', false, {}]) assert.throws(() => toResponses({ ...base, service_tier: tier }));
  assert.throws(() => applyFast('cursor', model, { ...base }, 'on'), /unsupported/);
  assert.throws(() => applyFast('codex', {}, { ...base, service_tier: 'priority' }), /unsupported/);
});
test('catalog discovery preserves capability and direct Responses receives priority without a model suffix', async () => {
  const requests = [];
  const provider = createCodexProvider({ fetchImpl: async (url, options) => {
    requests.push({ url, options });
    if (url.includes('/models?')) return Response.json({ models: [{ slug: 'a', display_name: 'A', service_tiers: [{ id: 'priority' }] }] });
    return new Response('data: {"type":"response.completed","response":{"status":"completed","output":[]}}\n\n', { headers: { 'Content-Type': 'text/event-stream' } });
  } });
  const credential = { accessToken: 'mock', accountId: 'mock' };
  assert.equal((await provider.models(credential))[0].supportsFast, true);
  const response = await provider.complete({ ...base, service_tier: 'priority' }, credential);
  await response.text();
  assert.equal(requests[1].url, 'https://chatgpt.com/backend-api/codex/responses');
  const wire = JSON.parse(requests[1].options.body);
  assert.equal(wire.service_tier, 'priority');
  assert.equal(wire.model, 'a');
  assert.equal(wire.reasoning.summary, 'auto');
  assert.match(requests[1].options.headers['session-id'], /^[0-9a-f-]{36}$/i);
  assert.equal(requests[1].options.headers['thread-id'], requests[1].options.headers['session-id']);
  assert.equal(requests[1].options.headers.originator, 'polycode');
});
test('bridge capability and per-request on/off are isolated and capability loss rejects before inference', async t => {
  let models = [{ id: 'a', name: 'A', contextWindow: 64000, supportsFast: true }];
  const sent = [];
  const credential = { accessToken: 'mock' };
  const store = { get: async () => credential, snapshot: async () => ({ revision: 'one', credential }), update: async (_, fn) => ({ revision: 'one', credential: await fn(credential) }) };
  const provider = { refresh: async c => c, models: async () => models, complete: async body => { sent.push(body); return Response.json(toResponses(body).request); }, close() {} };
  const service = new NativeProviderService({ codex: provider, cursor: provider }, store, { token: 'mock-process-token' });
  await service.start();
  t.after(() => service.close());
  const call = (path, body, fast) => fetch(service.url + path, { method: 'POST', headers: { Authorization: 'Bearer mock-process-token', ...(fast == null ? {} : { [FAST_HEADER]: fast }) }, body: JSON.stringify(body) });
  const capability = () => call('/control/fast-capability', { provider: 'codex', model: 'a' });
  assert.deepEqual(await (await capability()).json(), { supported: true });
  assert.equal(sent.length, 0);
  assert.equal((await (await call('/codex/v1/chat/completions', base, 'on')).json()).service_tier, 'priority');
  assert.equal((await (await call('/codex/v1/chat/completions', base)).json()).service_tier, undefined);
  assert.equal((await (await call('/codex/v1/chat/completions', base, 'off')).json()).service_tier, undefined);
  assert.equal((await call('/cursor/v1/chat/completions', base, 'on')).status, 400);
  models = [{ id: 'a', name: 'A', contextWindow: 64000 }];
  assert.equal((await call('/codex/v1/chat/completions', base, 'on')).status, 400);
  assert.deepEqual(await (await capability()).json(), { supported: false });
  assert.equal(sent.length, 3);
});
