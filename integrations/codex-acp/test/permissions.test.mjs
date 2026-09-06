import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, deferred, tick, complete, calls, threadResponse } from './helpers.mjs';

const methods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval'];
const permissions = { network: { enabled: true }, fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/repo/output' } }] } };
const request = (method, overrides = {}) => ({ id: 'approval', method, params: { threadId: 't', turnId: 'turn-1', itemId: 'tool', startedAtMs: 0, cwd: '/repo', permissions: structuredClone(permissions), ...overrides } });
const response = f => f.server.sent.findLast(x => x.id === 'approval')?.result;

for (const method of ['session/new', 'session/load']) {
  test(`${method} explicitly pins user review and verifies effective security settings`, async () => {
    const f = fixture(); await f.adapter.dispatch(method, { cwd: '/repo', sessionId: 't' });
    const sent = calls(f.server, method === 'session/new' ? 'thread/start' : 'thread/resume')[0].params;
    assert.equal(sent.approvalsReviewer, 'user'); assert.equal(sent.approvalPolicy, 'untrusted'); assert.equal(sent.sandbox, 'workspace-write');
  });
  for (const reviewer of ['auto_review', 'guardian_subagent', undefined]) {
    test(`${method} refuses effective reviewer ${reviewer}`, async () => {
      const f = fixture(); const respond = f.server.respond;
      f.server.respond = (m, p) => m === 'thread/start' || m === 'thread/resume' ? { ...threadResponse(p.threadId ?? 'new'), approvalsReviewer: reviewer } : respond(m, p);
      await assert.rejects(f.adapter.dispatch(method, { cwd: '/repo', sessionId: 't' }), /did not apply/);
      assert.equal(f.server.closed, true);
    });
  }
}
for (const method of methods) {
  test(`${method}: old dialog cannot authorize after cancel, completion and next prompt`, async () => {
    const f = fixture(); const first = f.adapter.dispatch('session/prompt', f.prompt); await tick();
    const gate = deferred(); f.client.respond = () => gate.promise;
    const approval = f.adapter.fromCodex(request(method)); await tick();
    await f.adapter.dispatch('session/cancel', { sessionId: 't' }); await complete(f, 'turn-1', 'interrupted'); await first;
    const second = f.adapter.dispatch('session/prompt', f.prompt); await tick();
    gate.resolve({ outcome: { outcome: 'selected', optionId: 'accept' } }); await approval;
    assert.deepEqual(response(f), method.includes('/permissions/') ? { permissions: {}, scope: 'turn' } : { decision: 'cancel' });
    await complete(f, 'turn-2'); await second;
  });
  test(`${method}: wrong turn ID cannot open a permission dialog`, async () => {
    const f = fixture(); const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
    await f.adapter.fromCodex(request(method, { turnId: 'stale-turn' }));
    assert.equal(calls(f.client, 'session/request_permission').length, 0);
    await complete(f); await done;
  });
}
test('permissions acceptance grants exactly the captured request, only for this turn', async () => {
  const f = fixture(); const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
  const gate = deferred(); f.client.respond = () => gate.promise;
  const m = request('item/permissions/requestApproval'); const approval = f.adapter.fromCodex(m); await tick();
  m.params.permissions.fileSystem.entries[0].path.path = '/broader';
  gate.resolve({ outcome: { outcome: 'selected', optionId: 'accept' }, permissions: { network: { enabled: true }, extra: true }, scope: 'session' });
  await approval; assert.deepEqual(response(f), { permissions, scope: 'turn' });
  const dialog = calls(f.client, 'session/request_permission')[0].params;
  assert.deepEqual(dialog.options.map(x => x.kind), ['allow_once', 'reject_once']);
  await complete(f); await done;
});
for (const outcome of ['decline', 'unknown', 'cancelled', 'timeout']) {
  test(`permissions ${outcome} grants nothing`, async () => {
    const f = fixture(); const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
    f.client.respond = async () => {
      if (outcome === 'timeout') throw new Error('RPC timeout: session/request_permission');
      return { outcome: outcome === 'cancelled' ? { outcome } : { outcome: 'selected', optionId: outcome } };
    };
    await f.adapter.fromCodex(request('item/permissions/requestApproval'));
    assert.deepEqual(response(f), { permissions: {}, scope: 'turn' });
    assert.equal(calls(f.server, 'turn/interrupt').length, outcome === 'cancelled' ? 1 : 0);
    await complete(f, 'turn-1', outcome === 'cancelled' ? 'interrupted' : 'completed'); await done;
  });
}
test('completion invalidates dialogs immediately even before prompt cleanup', async () => {
  const f = fixture(); const done = f.adapter.dispatch('session/prompt', f.prompt); await tick();
  const gate = deferred(); f.client.respond = () => gate.promise;
  const approval = f.adapter.fromCodex(request('item/commandExecution/requestApproval')); await tick();
  const terminal = complete(f); gate.resolve({ outcome: { outcome: 'selected', optionId: 'accept' } });
  await Promise.all([terminal, approval, done]); assert.deepEqual(response(f), { decision: 'cancel' });
});
