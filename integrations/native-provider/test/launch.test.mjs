import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { runNative } from '../launch.mjs';
test('launcher keeps native engine and enables provider UI without ACP replacement', async () => {
  let captured;
  const code = await runNative({ binary: resolve('native-pager'), cwd: process.cwd(), provider: 'cursor', providers: {}, directory: resolve('unused-test-auth'), spawnChild(binary, args, options) {
    captured = { binary, args, options }; const child = new EventEmitter(); child.kill = () => {};
    queueMicrotask(() => child.emit('exit', 0)); return child;
  } });
  assert.equal(code, 0);
  assert.ok(captured.args.includes('--no-external-acp'));
  assert.ok(captured.args.includes('--polycode-native'));
  assert.ok(!captured.args.includes('--acp-executable'));
  assert.ok(captured.options.env.POLYCODE_BRIDGE_URL.startsWith('http://127.0.0.1:'));
  assert.equal(captured.options.env.POLYCODE_BRIDGE_TOKEN.length, 64);
  assert.equal(captured.options.stdio, 'inherit');
});
