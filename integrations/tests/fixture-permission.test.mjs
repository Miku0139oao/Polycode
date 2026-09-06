import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { isFixtureRead } from './fixture-permission.mjs';
const cwd = process.cwd();
function tool(command = 'cat fixture.txt') { return { rawInput: { cwd, command, commandActions: [{ type: 'read', path: resolve(cwd, 'fixture.txt') }] } }; }
test('only the exact disposable fixture read is eligible for test approval', () => {
  assert.equal(isFixtureRead(tool(), cwd), true);
  assert.equal(isFixtureRead(tool('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command "Get-Content -Raw -LiteralPath .\\fixture.txt"'), cwd), true);
  for (const cmd of ['cat fixture.txt; rm -rf .', 'cat secret.txt', 'echo fixture.txt', 'powershell -Command "Remove-Item fixture.txt"']) assert.equal(isFixtureRead(tool(cmd), cwd), false);
  const outside = tool(); outside.rawInput.commandActions[0].path = resolve(cwd, '../fixture.txt');
  assert.equal(isFixtureRead(outside, cwd), false);
  const wrongCwd = tool(); wrongCwd.rawInput.cwd = resolve(cwd, '..');
  assert.equal(isFixtureRead(wrongCwd, cwd), false);
});
