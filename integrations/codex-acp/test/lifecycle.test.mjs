import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, tick, complete, calls, threadResponse } from './helpers.mjs';

const load = { sessionId: 't', cwd: '/repo', mcpServers: [] };
test('active session load is rejected before any upstream mutation and original prompt remains reachable', async () => {
  const f = fixture(); const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
  const original = f.adapter.session('t'); const before = f.server.sent.length;
  await assert.rejects(f.adapter.dispatch('session/load', load), /active session/);
  assert.equal(f.server.sent.length, before); assert.equal(f.adapter.session('t'), original);
  await complete(f); assert.equal((await done).stopReason, 'end_turn');
});
test('load locks precede authentication, reject concurrent load/prompt/model changes, and preserve session identity', async () => {
  const f = fixture(); const gate = deferred(); const respond = f.server.respond;
  f.server.respond = (m, p) => m === 'account/read' ? gate.promise : respond(m, p);
  const original = f.adapter.session('t'); const loading = f.adapter.dispatch('session/load', load);
  for (const [m, p] of [['session/load', load], ['session/prompt', f.prompt], ['session/set_model', { sessionId: 't', modelId: 'm' }]]) {
    await assert.rejects(f.adapter.dispatch(m, p), /loading/);
  }
  gate.resolve({ account: { type: 'chatgpt' } }); await loading;
  assert.equal(calls(f.server, 'thread/resume').length, 1);
  assert.equal(f.adapter.session('t'), original); assert.equal(f.adapter.loading.size, 0);
});
test('new session remains locked through model setup and cannot race a resume', async () => {
  const f = fixture(); const gate = deferred(); const respond = f.server.respond;
  f.server.respond = (m, p) => m === 'model/list' ? gate.promise : respond(m, p);
  const creating = f.adapter.dispatch('session/new', { cwd: '/repo' }); await tick();
  await assert.rejects(f.adapter.dispatch('session/load', { ...load, sessionId: 'new-1' }), /loading/);
  await assert.rejects(f.adapter.dispatch('session/prompt', { ...f.prompt, sessionId: 'new-1' }), /loading/);
  gate.resolve({ data: [{ model: 'm', displayName: 'M', description: '' }] });
  assert.equal((await creating).sessionId, 'new-1'); assert.equal(f.adapter.loading.size, 0);
});
test('independent session loads may proceed while another session is loading', async () => {
  const f = fixture(); const gate = deferred(); const respond = f.server.respond;
  f.server.respond = (m, p) => m === 'thread/resume' && p.threadId === 't' ? gate.promise : respond(m, p);
  const first = f.adapter.dispatch('session/load', load); await tick();
  await f.adapter.dispatch('session/load', { ...load, sessionId: 'other' });
  gate.resolve(threadResponse('t')); await first;
});
test('load timeout closes ambiguous upstream state and releases its local lock', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = (m, p) => { if (m === 'thread/resume') throw new Error('RPC timeout: thread/resume'); return respond(m, p); };
  await assert.rejects(f.adapter.dispatch('session/load', load), /timeout/);
  assert.equal(f.server.closed, true); assert.equal(f.adapter.loading.size, 0);
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /disconnected/);
});
test('known start timeout interrupts and retains ownership until terminal confirmation', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = async (m, p) => {
    if (m === 'turn/start') {
      await f.adapter.fromCodex({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
      throw new Error('RPC timeout: turn/start');
    }
    return respond(m, p);
  };
  const done = f.adapter.dispatch('session/prompt', f.prompt); const rejected = assert.rejects(done, /timeout: turn\/start/);
  await tick(); assert.equal(calls(f.server, 'turn/interrupt').length, 1);
  assert.ok(f.adapter.session('t').active); assert.equal(f.server.closed, false);
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /already active/);
  await assert.rejects(f.adapter.dispatch('session/load', load), /active session/);
  await complete(f, 'turn-1', 'interrupted'); await rejected;
  assert.equal(f.adapter.session('t').active, null);
});
test('unknown start timeout closes upstream rather than allowing another turn', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = (m, p) => { if (m === 'turn/start') throw new Error('RPC timeout: turn/start'); return respond(m, p); };
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /disconnected/);
  assert.equal(f.server.closed, true);
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /disconnected/);
  assert.equal(calls(f.server, 'turn/start').length, 1);
});
test('failed interrupt after ambiguous start closes upstream and rejects the prompt', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = async (m, p) => {
    if (m === 'turn/start') {
      await f.adapter.fromCodex({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
      throw new Error('RPC timeout: turn/start');
    }
    if (m === 'turn/interrupt') throw new Error('interrupt failed');
    return respond(m, p);
  };
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /disconnected/);
  assert.equal(f.server.closed, true); assert.equal(f.adapter.session('t').active, null);
});
test('an unconfirmed interrupt has a bounded shutdown deadline', async () => {
  const f = fixture({ interruptTimeout: 10 });
  const done = f.adapter.dispatch('session/prompt', f.prompt); const rejected = assert.rejects(done, /disconnected/); await tick();
  await f.adapter.dispatch('session/cancel', { sessionId: 't' }); await rejected;
  assert.equal(f.server.closed, true);
});
test('definitive start rejection without an observed turn does not kill upstream', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = (m, p) => { if (m === 'turn/start') throw Object.assign(new Error('model unavailable'), { rpcResponse: true }); return respond(m, p); };
  await assert.rejects(f.adapter.dispatch('session/prompt', f.prompt), /model unavailable/);
  assert.equal(f.server.closed, false); assert.equal(f.adapter.session('t').active, null);
});
test('cancel during authentication never submits a new turn', async () => {
  const f = fixture(); const gate = deferred(); f.server.respond = () => gate.promise;
  const done = f.adapter.dispatch('session/prompt', f.prompt);
  await f.adapter.dispatch('session/cancel', { sessionId: 't' }); gate.resolve({ account: { type: 'chatgpt' } });
  assert.equal((await done).stopReason, 'cancelled'); assert.equal(calls(f.server, 'turn/start').length, 0);
});
test('deferred cancellation interrupts at turn/started before the start response', async () => {
  const f = fixture(); const gate = deferred(); const respond = f.server.respond;
  f.server.respond = (m, p) => m === 'turn/start' ? gate.promise : respond(m, p);
  const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
  await f.adapter.dispatch('session/cancel', { sessionId: 't' });
  await f.adapter.fromCodex({ method: 'turn/started', params: { threadId: 't', turn: { id: 'turn-1', items: [], status: 'inProgress' } } });
  assert.equal(calls(f.server, 'turn/interrupt').length, 1);
  gate.resolve({ turn: { id: 'turn-1' } }); await complete(f, 'turn-1', 'interrupted');
  assert.equal((await done).stopReason, 'cancelled'); assert.equal(calls(f.server, 'turn/interrupt').length, 1);
});
