import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCodexProvider, toResponses } from '../codex.mjs';
import { NativeProviderService } from '../service.mjs';
import { codexReasoningMetadata, validateReasoningMetadata } from '../model-settings.mjs';

const metadata = () => codexReasoningMetadata({ supported_reasoning_levels: [{ effort: 'low', description: 'Faster' }, { effort: 'high', description: 'More reasoning' }], default_reasoning_level: 'high' });
test('actual Codex catalog capabilities reach native metadata and selected wire effort', async () => {
  const provider = createCodexProvider({ fetchImpl: async () => Response.json({ models: [{ slug: 'actual-model', display_name: 'Actual', context_window: 200000, supported_reasoning_levels: [{ effort: 'minimal', description: 'Fast' }, { effort: 'high', description: 'Deep' }], default_reasoning_level: 'minimal' }] }) });
  const [model] = await provider.models({ accessToken: 'fixture', accountId: 'fixture' });
  assert.deepEqual(model.reasoningEfforts.map(o => o.value), ['minimal', 'high']);
  assert.equal(model.defaultReasoningEffort, 'minimal');
  assert.equal(model.reasoningEfforts[0].default, true);
  for (const option of model.reasoningEfforts) {
    const { request } = toResponses({ model: model.id, messages: [], reasoning_effort: option.value });
    assert.equal(request.reasoning.effort, option.value);
  }
});
test('missing or unknown capabilities never invent standard levels/defaults', () => {
  assert.deepEqual(codexReasoningMetadata({}), {});
  const noDefault = codexReasoningMetadata({ supported_reasoning_levels: ['low', 'high'] });
  assert.equal(noDefault.defaultReasoningEffort, undefined);
  assert.ok(noDefault.reasoningEfforts.every(o => !o.default));
  assert.throws(() => codexReasoningMetadata({ supported_reasoning_levels: ['ultra'] }), /capability/);
  assert.throws(() => codexReasoningMetadata({ supported_reasoning_levels: ['low'], default_reasoning_level: 'xhigh' }), /default/);
  assert.throws(() => validateReasoningMetadata({ reasoningEfforts: [...metadata().reasoningEfforts, metadata().reasoningEfforts[0]] }), /capabilities/);
});
async function fixture(t) {
  let revision = 'account-one', credential = { accessToken: 'fixture-one' };
  const store = {
    get: async () => credential,
    snapshot: async () => ({ revision, credential }),
    update: async (_, updater) => ({ revision, credential: await updater(credential) }),
  };
  let models = [{ id: 'a', name: 'A', contextWindow: 64000, ...metadata() }];
  const sent = [];
  const provider = { refresh: async c => c, models: async () => models, complete: async (body, c) => { sent.push({ body, credential: c }); return Response.json(toResponses(body).request); }, close() {} };
  const service = new NativeProviderService({ codex: provider, cursor: provider }, store, { token: 'fixture-process-token' });
  await service.start();
  t.after(() => service.close());
  const call = (path, body) => fetch(service.url + path, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer fixture-process-token' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const catalog = () => call('/control/catalog').then(r => r.json());
  return { call, catalog, sent, setModels: value => { models = value; }, changeAccount: () => { revision = 'account-two'; credential = { accessToken: 'fixture-two' }; } };
}
test('safe commit revalidates exact catalog revision and credentials without inference', async t => {
  const f = await fixture(t);
  const catalog = await f.catalog(), revision = catalog.providers[0].catalogRevision;
  assert.match(revision, /^[a-f0-9]{64}$/);
  const target = { provider: 'codex', model: 'a', effort: 'low', catalogRevision: revision };
  assert.equal((await f.call('/control/validate-model', target)).status, 200);
  assert.equal(f.sent.length, 0);
  f.changeAccount();
  assert.equal((await f.call('/control/validate-model', target)).status, 409);
  assert.equal(f.sent.length, 0);
});
test('removed/changed model or effort fails commit, never substitutes another model', async t => {
  const f = await fixture(t), catalog = await f.catalog();
  const target = { provider: 'codex', model: 'a', effort: 'high', catalogRevision: catalog.providers[0].catalogRevision };
  f.setModels([{ id: 'replacement', name: 'Replacement', contextWindow: 64000 }]);
  assert.equal((await f.call('/control/validate-model', target)).status, 409);
  assert.equal(f.sent.length, 0);
});
test('effort is checked against selected provider/model at the actual inference boundary', async t => {
  const f = await fixture(t);
  const body = { model: 'codex/a', messages: [], reasoning_effort: 'low' };
  const result = await f.call('/codex/v1/chat/completions', body);
  assert.equal(result.status, 200);
  assert.equal((await result.json()).reasoning.effort, 'low');
  assert.equal((await f.call('/codex/v1/chat/completions', { ...body, reasoning_effort: 'xhigh' })).status, 400);
  assert.equal((await f.call('/codex/v1/chat/completions', { ...body, reasoning: { effort: 'high' } })).status, 400);
  f.setModels([{ id: 'a', name: 'A', contextWindow: 64000 }]);
  const noControl = await f.call('/cursor/v1/chat/completions', { ...body, model: 'cursor/a' });
  assert.equal(noControl.status, 400);
  assert.match((await noControl.json()).error.message, /does not expose/);
  assert.equal(f.sent.length, 1);
});
