import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stopChild } from '../process-tree.mjs';
test('Windows tree termination uses only spawned numeric PID before killing root', () => {
  const events = [];
  stopChild({ pid: 123, kill: () => events.push('root') }, { platform: 'win32', env: { SystemRoot: 'C:/Windows' } }, (command, args, options) => { events.push('tree'); assert.match(command, /taskkill\.exe$/); assert.deepEqual(args, ['/PID', '123', '/T', '/F']); assert.equal(options.stdio, 'ignore'); });
  assert.deepEqual(events, ['tree', 'root']);
});
test('invalid PID and non-Windows runtimes never invoke taskkill', () => {
  for (const [platform, pid] of [['win32', undefined], ['linux', 123], ['win32', -1]]) {
    let killed = false;
    stopChild({ pid, kill: () => killed = true }, { platform, env: {} }, () => assert.fail('Unexpected tree command'));
    assert.equal(killed, true);
  }
});
