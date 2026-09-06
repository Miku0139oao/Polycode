import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { run } from '../cli.mjs';
import { Rpc } from '../rpc.mjs';
import { sessionState, tick } from './helpers.mjs';

function fixture(shutdownTimeout = 2000) {
  const runtime = new EventEmitter();
  Object.assign(runtime, { env: {}, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exits: [] });
  runtime.exit = code => runtime.exits.push(code);
  const child = new EventEmitter();
  Object.assign(child, { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), kills: [] });
  child.kill = signal => { child.kills.push(signal ?? 'SIGTERM'); return true; };
  const upstream = new Rpc(child.stdin, child.stdout, { envelope: false });
  upstream.on('message', m => {
    if (m.method === 'account/read') upstream.reply(m.id, { account: { type: 'chatgpt' } });
    if (m.method === 'turn/start') upstream.reply(m.id, { turn: { id: 'turn-1' } });
  });
  const app = run(runtime, () => child, shutdownTimeout);
  app.adapter.initialized = true; app.adapter.sessions.set('t', sessionState());
  let output = ''; runtime.stdout.on('data', data => output += data);
  const messages = () => output.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  return { runtime, child, upstream, app, messages };
}
const prompt = JSON.stringify({ jsonrpc: '2.0', id: 'prompt', method: 'session/prompt', params: { sessionId: 't', prompt: [{ type: 'text', text: 'test' }] } }) + '\n';
for (const failure of ['invalid-json', 'oversized-frame', 'stdout-eof', 'stdin-error']) {
  test(`upstream ${failure} fails pending ACP prompt before idempotent shutdown`, async () => {
    const f = fixture(); f.runtime.stdin.write(prompt); await tick();
    assert.ok(f.app.adapter.session('t').active);
    if (failure === 'invalid-json') f.child.stdout.write('not-json\n');
    if (failure === 'oversized-frame') f.child.stdout.write('x'.repeat(8 * 1024 * 1024 + 1));
    if (failure === 'stdout-eof') f.child.stdout.end();
    if (failure === 'stdin-error') f.child.stdin.emit('error', new Error('broken pipe'));
    await tick(); await f.app.stop();
    assert.equal(f.app.server.closed, true); assert.equal(f.app.client.closed, true);
    assert.equal(f.runtime.stdin.destroyed, true); assert.deepEqual(f.child.kills, ['SIGTERM']);
    const result = f.messages().find(m => m.id === 'prompt');
    assert.equal(result.error.code, -32603); assert.match(result.error.message, /disconnected/);
    f.child.emit('exit', 1); f.child.emit('close'); await f.app.stop();
    assert.deepEqual(f.child.kills, ['SIGTERM']);
  });
}
test('synchronous upstream failure during dispatch still drains the registered ACP request', async () => {
  const f = fixture();
  f.upstream.removeAllListeners('message');
  f.upstream.on('message', () => f.child.stdout.write('invalid\n'));
  f.runtime.stdin.write(prompt); await tick(); await f.app.stop();
  assert.ok(f.messages().find(m => m.id === 'prompt')?.error);
  assert.equal(f.app.client.closed, true); f.child.emit('close');
});
test('shutdown escalates when the Codex child does not exit', async () => {
  const f = fixture(10); await f.app.stop();
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.child.kills, ['SIGTERM', 'SIGKILL']); assert.deepEqual(f.runtime.exits, [1]);
  f.child.emit('close');
});
test('normal child exit clears the forced-exit deadline', async () => {
  const f = fixture(10); await f.app.stop(); f.child.emit('exit', 0); f.child.emit('close');
  await new Promise(resolve => setTimeout(resolve, 25));
  assert.deepEqual(f.child.kills, ['SIGTERM']); assert.deepEqual(f.runtime.exits, []);
});
