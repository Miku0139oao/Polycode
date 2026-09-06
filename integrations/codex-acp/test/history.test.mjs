import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, threadResponse, calls } from './helpers.mjs';

const message = (id, text = id) => ({ type: 'agentMessage', id, text });
const turn = (id, items = [], itemsView = 'full') => ({ id, items, itemsView, status: 'completed' });
const texts = f => calls(f.client, 'session/update').filter(x => x.params.update.sessionUpdate === 'agent_message_chunk').map(x => x.params.update.content.text);

test('paginated resume hydrates turns and item entries in chronological order without duplicate boundaries', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = async (m, p) => {
    if (m === 'thread/resume') return { ...threadResponse('t', [turn('recent', [], 'notLoaded')]), turnsBackwardsCursor: 'resume-turn-anchor', itemsBackwardsCursor: 'resume-item-anchor' };
    if (m === 'thread/turns/list') {
      assert.equal(p.sortDirection, 'asc'); assert.equal(p.itemsView, 'full');
      return p.cursor ? { data: [turn('old'), turn('recent', [], 'summary')] } : { data: [turn('old')], nextCursor: 'turn-page-2' };
    }
    if (m === 'thread/items/list') {
      assert.equal(p.sortDirection, 'asc');
      if (p.turnId === 'old') return p.cursor ? { data: [{ turnId: 'old', item: message('a', 'updated-a') }, { turnId: 'old', item: message('b') }] } : { data: [{ turnId: 'old', item: message('a') }], nextCursor: 'item-page-2' };
      return { data: [{ turnId: 'recent', item: message('c') }] };
    }
    return respond(m, p);
  };
  await f.adapter.dispatch('session/load', { sessionId: 't', cwd: '/repo' });
  assert.deepEqual(texts(f), ['updated-a', 'b', 'c']);
  assert.deepEqual(calls(f.server, 'thread/turns/list').map(x => x.params.cursor), [undefined, 'turn-page-2']);
  assert.equal(calls(f.server, 'thread/items/list').length, 3);
});
for (const hint of ['historyMode', 'itemsView', 'itemsBackwardsCursor', 'turnsBackwardsCursor']) {
  test(`resume detects partial history from ${hint} alone`, async () => {
    const f = fixture(); const respond = f.server.respond;
    const r = threadResponse('t', [turn('old', [], hint === 'itemsView' ? 'summary' : 'full')]);
    if (hint === 'historyMode') r.thread.historyMode = 'paginated';
    if (hint.endsWith('Cursor')) r[hint] = 'anchor';
    f.server.respond = (m, p) => {
      if (m === 'thread/resume') return r;
      if (m === 'thread/turns/list') return { data: [turn('old', [], 'notLoaded')] };
      if (m === 'thread/items/list') return { data: [{ turnId: 'old', item: message('restored') }] };
      return respond(m, p);
    };
    await f.adapter.dispatch('session/load', { sessionId: 't', cwd: '/repo' });
    assert.deepEqual(texts(f), ['restored']);
  });
}
for (const failure of ['request-error', 'repeated-cursor', 'missing-turn', 'missing-item', 'wrong-turn']) {
  test(`resume never silently succeeds with ${failure} during history hydration`, async () => {
    const f = fixture(); const respond = f.server.respond;
    f.server.respond = (m, p) => {
      if (m === 'thread/resume') return { ...threadResponse('t', [turn('old', [], 'summary')]), turnsBackwardsCursor: 'anchor' };
      if (m === 'thread/turns/list') {
        if (failure === 'request-error') throw new Error('history unavailable');
        if (failure === 'missing-turn') return { data: [] };
        return { data: [turn('old', failure === 'missing-item' ? [message('expected')] : [])], ...(failure === 'repeated-cursor' ? { nextCursor: 'same' } : {}) };
      }
      if (m === 'thread/items/list') return { data: failure === 'wrong-turn' ? [{ turnId: 'another-turn', item: message('a') }] : [] };
      return respond(m, p);
    };
    await assert.rejects(f.adapter.dispatch('session/load', { sessionId: 't', cwd: '/repo' }));
    assert.deepEqual(texts(f), []); assert.equal(f.server.closed, true); assert.equal(f.adapter.loading.size, 0);
  });
}
test('complete legacy history does not require pagination APIs', async () => {
  const f = fixture(); const respond = f.server.respond;
  f.server.respond = (m, p) => m === 'thread/resume' ? threadResponse('t', [turn('one', [message('a'), message('b')])]) : respond(m, p);
  await f.adapter.dispatch('session/load', { sessionId: 't', cwd: '/repo' });
  assert.deepEqual(texts(f), ['a', 'b']); assert.equal(calls(f.server, 'thread/turns/list').length, 0);
});

test('command output updates replace content with a cumulative snapshot and preserve it on null final aggregate', async () => {
  const f = fixture();
  const item = { type: 'commandExecution', id: 'cmd', command: 'echo test', aggregatedOutput: null, status: 'inProgress' };
  await f.adapter.fromCodex({ method: 'item/started', params: { threadId: 't', item } });
  for (const delta of ['first\n', 'second\n']) await f.adapter.fromCodex({ method: 'item/commandExecution/outputDelta', params: { threadId: 't', turnId: 'turn-1', itemId: 'cmd', delta } });
  await f.adapter.fromCodex({ method: 'item/completed', params: { threadId: 't', item: { ...item, status: 'completed' } } });
  const contents = calls(f.client, 'session/update').filter(x => x.params.update.content).map(x => x.params.update.content[0].content.text);
  assert.deepEqual(contents, ['first\n', 'first\nsecond\n', 'first\nsecond\n']);
});
test('authoritative final command aggregate replaces rather than duplicates streamed output', async () => {
  const f = fixture();
  await f.adapter.fromCodex({ method: 'item/commandExecution/outputDelta', params: { threadId: 't', turnId: 'turn-1', itemId: 'cmd', delta: 'partial' } });
  f.adapter.item('t', { type: 'commandExecution', id: 'cmd', command: 'test', aggregatedOutput: 'authoritative', status: 'completed' }, true);
  assert.equal(calls(f.client, 'session/update').at(-1).params.update.content[0].content.text, 'authoritative');
});
