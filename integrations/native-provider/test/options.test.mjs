import test from 'node:test';
import assert from 'node:assert/strict';
import { toResponses } from '../codex.mjs';

const base = { model: 'fixture-model', messages: [{ role: 'user', content: 'hello' }] };
for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n']) {
  test(`Codex rejects explicit unsupported ${key} instead of dropping it`, () => {
    assert.throws(() => toResponses({ ...base, [key]: 0 }), error => error.status === 400 && error.message.includes(key));
  });
}
test('unsupported option names cannot reflect arbitrary secrets', () => {
  assert.throws(() => toResponses({ ...base, 'secret-unknown-field': true }), error => error.status === 400 && !error.message.includes('secret-unknown-field'));
});
test('unset controls stay absent; supported explicit reasoning is retained', () => {
  const { request } = toResponses({ ...base, temperature: null, max_tokens: null, reasoning: { effort: 'low', summary: 'concise' } });
  assert.equal(Object.hasOwn(request, 'temperature'), false);
  assert.equal(Object.hasOwn(request, 'max_output_tokens'), false);
  assert.deepEqual(request.reasoning, { effort: 'low', summary: 'concise' });
});
test('encrypted_content include is never sent without a reasoning object', () => {
  const { request } = toResponses(base);
  assert.deepEqual(request.include, ['reasoning.encrypted_content']);
  assert.deepEqual(request.reasoning, { summary: 'auto' });
});
test('conflicting reasoning and unknown nested controls fail clearly', () => {
  for (const fields of [{ reasoning: { unsupported: true } }, { stream_options: { unsupported: true } }, { reasoning_effort: 'high', reasoning: { effort: 'low' } }]) {
    assert.throws(() => toResponses({ ...base, ...fields }), error => error.status === 400);
  }
});
