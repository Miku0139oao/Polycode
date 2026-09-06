import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, tick } from './helpers.mjs';
const request = () => ({ id: 'q', method: 'item/tool/requestUserInput', params: { threadId: 't', turnId: 'turn', itemId: 'question', isBlocking: true, questions: [{ id: 'choice', header: 'Choice', question: 'Which?', options: [{ label: 'A', description: 'First' }, { label: 'B', description: 'Second' }] }] } });
function setup() { const f = fixture(); f.adapter.session('t').active = { id: 'turn', submitted: true, cancel: false, terminal: false }; return f; }
test('Codex choices map through Cursor-style UI extension to original labels', async () => {
  const f = setup(); f.client.respond = async () => ({ outcome: { outcome: 'answered', answers: [{ questionId: 'choice', selectedOptionIds: ['1'] }] } });
  await f.adapter.fromCodex(request());
  assert.equal(f.client.sent[0].method, '_cursor/ask_question');
  assert.deepEqual(f.server.sent.at(-1).result, { answers: { choice: { answers: ['B'] } } });
});
test('stale question cannot answer a newer turn', async () => {
  const f = setup(), answer = deferred(); f.client.respond = () => answer.promise;
  const done = f.adapter.fromCodex(request()); await tick();
  f.adapter.session('t').active = { id: 'new-turn', submitted: true, cancel: false, terminal: false };
  answer.resolve({ outcome: { outcome: 'answered', answers: [{ questionId: 'choice', selectedOptionIds: ['0'] }] } });
  await done; assert.deepEqual(f.server.sent.at(-1).result, { answers: {} });
});
test('unknown choice ID is not fabricated and secret input is not displayed', async () => {
  const f = setup(); f.client.respond = async () => ({ outcome: { outcome: 'answered', answers: [{ questionId: 'choice', selectedOptionIds: ['999'] }] } });
  await f.adapter.fromCodex(request()); assert.deepEqual(f.server.sent.at(-1).result, { answers: {} });
  f.client.sent = []; const r = request(); r.params.questions[0].isSecret = true;
  await f.adapter.fromCodex(r); assert.equal(f.client.sent.length, 0); assert.equal(f.server.sent.at(-1).error.code, -32601);
});
