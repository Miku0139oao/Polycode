import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../adapter.mjs';
class Peer extends EventEmitter {
  closed = false; sent = [];
  request(method, params) { this.sent.push({ method, params }); return this.respond(method, params); }
  notify(method, params) { this.sent.push({ method, params }); }
  reply(id, result) { this.sent.push({ id, result }); }
  fail(id, code, message) { this.sent.push({ id, error: { code, message } }); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
function setup() {
  const client = new Peer(), server = new Peer();
  const a = new CodexAdapter(client, server); a.initialized = true;
  a.sessions.set('t', { model: 'm', models: [{ model: 'm' }], active: null, streamed: new Set() });
  server.respond = async method => method === 'account/read' ? { account: { type: 'chatgpt' } } : { turn: { id: 'turn' } };
  return { a, client, server, prompt: { sessionId: 't', prompt: [{ type: 'text', text: 'test' }] } };
}
const tick = () => new Promise(r => setImmediate(r));
test('two concurrent prompts cannot pass the authentication await together', async () => {
  const f = setup(); const first = f.a.dispatch('session/prompt', f.prompt);
  await assert.rejects(f.a.dispatch('session/prompt', f.prompt), /already active/);
  await tick(); await f.a.fromCodex({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
  await first; assert.equal(f.server.sent.filter(x => x.method === 'turn/start').length, 1);
});
test('terminal event before turn/start response is not lost', async () => {
  const f = setup(); const respond = f.server.respond;
  f.server.respond = async (method, p) => {
    if (method === 'turn/start') await f.a.fromCodex({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'completed' } } });
    return respond(method, p);
  };
  assert.deepEqual(await f.a.dispatch('session/prompt', f.prompt), { stopReason: 'end_turn' });
});
test('upstream disconnect rejects prompt', async () => {
  const f = setup(); const done = f.a.dispatch('session/prompt', f.prompt); await tick();
  f.server.emit('close'); await assert.rejects(done, /disconnected/); assert.equal(f.a.session('t').active, null);
});
test('failed turn is error, not successful completion', async () => {
  const f = setup(); const done = f.a.dispatch('session/prompt', f.prompt); await tick();
  await f.a.fromCodex({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'failed', error: { message: 'Quota exhausted' } } } });
  await assert.rejects(done, /Quota exhausted/);
});
test('cancel arriving while approval dialog is open cannot later authorize', async () => {
  const f = setup(); const done = f.a.dispatch('session/prompt', f.prompt); await tick();
  let answer; f.client.respond = () => new Promise(r => answer = r);
  const approval = f.a.fromCodex({ id: 'approve', method: 'item/fileChange/requestApproval', params: { threadId: 't', turnId: 'turn', itemId: 'edit', startedAtMs: 0 } });
  await f.a.dispatch('session/cancel', { sessionId: 't' });
  answer({ outcome: { outcome: 'selected', optionId: 'accept' } }); await approval;
  assert.deepEqual(f.server.sent.at(-1).result, { decision: 'cancel' });
  await f.a.fromCodex({ method: 'turn/completed', params: { threadId: 't', turn: { id: 'turn', status: 'interrupted' } } });
  await done;
});
