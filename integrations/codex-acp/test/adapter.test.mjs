import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../adapter.mjs';
class Peer extends EventEmitter {
  sent = []; closed = false;
  request(method, params) { this.sent.push({ method, params }); return this.respond(method, params); }
  notify(method, params) { this.sent.push({ method, params }); }
  reply(id, result) { this.sent.push({ id, result }); }
  fail(id, code, message) { this.sent.push({ id, error: { code, message } }); }
  close() { if (!this.closed) { this.closed = true; this.emit('close'); } }
}
function fixture() {
  const client = new Peer(), server = new Peer();
  server.respond = async (method, p) => ({
    initialize: {}, 'account/read': { account: { type: 'chatgpt' } },
    'model/list': { data: [{ model: 'test-model', displayName: 'Test', description: '' }] },
    'thread/start': { thread: { id: 'thread-1' }, model: 'test-model', modelProvider: 'openai', approvalsReviewer: 'user', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite' } },
    'thread/resume': { thread: { id: p.threadId, turns: [{ id: 'old-turn', status: 'completed', items: [{ type: 'agentMessage', id: 'old', text: 'history' }] }] }, model: 'test-model', modelProvider: 'openai', approvalsReviewer: 'user', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite' } },
    'turn/start': { turn: { id: 'turn-1' } }, 'turn/interrupt': {},
  }[method] ?? {});
  const adapter = new CodexAdapter(client, server);
  return { client, server, adapter };
}
async function setup(f) { await f.adapter.dispatch('initialize', { protocolVersion: 1 }); await f.adapter.dispatch('session/new', { cwd: '/repo', mcpServers: [] }); }
const tick = () => new Promise(resolve => setImmediate(resolve));
test('initializes ACP without claiming Grok extensions', async () => {
  const f = fixture(); const result = await f.adapter.dispatch('initialize', { protocolVersion: 1 });
  assert.equal(result.agentCapabilities.loadSession, true); assert.equal(result._meta, undefined);
  assert.equal(f.server.sent[0].method, 'initialize'); assert.equal(f.server.sent[1].method, 'initialized');
});
test('rejects API-key authentication and never starts a thread', async () => {
  const f = fixture(); await f.adapter.dispatch('initialize', { protocolVersion: 1 });
  f.server.respond = async () => ({ account: { type: 'apiKey' } });
  await assert.rejects(f.adapter.dispatch('session/new', { cwd: '/repo' }), /ChatGPT login required/);
  assert.equal(f.server.sent.some(x => x.method === 'thread/start'), false);
});
test('streams message once and completes pending prompt', async () => {
  const f = fixture(); await setup(f);
  const done = f.adapter.dispatch('session/prompt', { sessionId: 'thread-1', prompt: [{ type: 'text', text: 'hi' }] }); await tick();
  await f.adapter.fromCodex({ method: 'item/agentMessage/delta', params: { threadId: 'thread-1', itemId: 'a', delta: 'hello' } });
  await f.adapter.fromCodex({ method: 'item/completed', params: { threadId: 'thread-1', item: { id: 'a', type: 'agentMessage', text: 'hello' } } });
  await f.adapter.fromCodex({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed' } } });
  assert.deepEqual(await done, { stopReason: 'end_turn' });
  assert.equal(f.client.sent.filter(x => x.params?.update?.sessionUpdate === 'agent_message_chunk').length, 1);
});
test('denied or malformed approval never grants permission', async () => {
  const f = fixture(); await setup(f); f.adapter.session('thread-1').active = { id: 'turn-1', cancel: false };
  f.client.respond = async () => ({ outcome: { outcome: 'selected', optionId: 'unknown' } });
  await f.adapter.fromCodex({ id: 7, method: 'item/commandExecution/requestApproval', params: { threadId: 'thread-1', turnId: 'turn-1', itemId: 'cmd', command: 'echo hi', startedAtMs: 0 } });
  assert.deepEqual(f.server.sent.at(-1), { id: 7, result: { decision: 'decline' } });
});
test('cancel interrupts and returns cancelled only after server confirmation', async () => {
  const f = fixture(); await setup(f);
  const done = f.adapter.dispatch('session/prompt', { sessionId: 'thread-1', prompt: [{ type: 'text', text: 'hi' }] }); await tick();
  await f.adapter.dispatch('session/cancel', { sessionId: 'thread-1' });
  assert.equal(f.server.sent.at(-1).method, 'turn/interrupt');
  await f.adapter.fromCodex({ method: 'turn/completed', params: { threadId: 'thread-1', turn: { id: 'turn-1', status: 'interrupted' } } });
  assert.deepEqual(await done, { stopReason: 'cancelled' });
});
test('resume emits persisted conversation and unsupported model fails', async () => {
  const f = fixture(); await setup(f); await f.adapter.dispatch('session/load', { sessionId: 'old-thread', cwd: '/repo' });
  assert.equal(f.client.sent.at(-1).params.update.content.text, 'history');
  await assert.rejects(f.adapter.dispatch('session/set_model', { sessionId: 'old-thread', modelId: 'invented' }), /Unknown model/);
});
test('unknown blocking server method receives error rather than hanging', async () => {
  const f = fixture(); await setup(f);
  await f.adapter.fromCodex({ id: 9, method: 'new/approval', params: {} }); assert.equal(f.server.sent.at(-1).error.code, -32601);
});
