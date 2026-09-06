// Opt-in real agent/tool verification in a disposable workspace.
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Rpc } from './codex-acp/rpc.mjs';
import { isFixtureRead } from './tests/fixture-permission.mjs';
if (!process.argv.includes('--allow-subscription-usage')) throw new Error('Explicit --allow-subscription-usage required');
const command = process.env.ACP_TEST_EXECUTABLE;
if (!command) throw new Error('Set ACP_TEST_EXECUTABLE, ACP_TEST_ARGS (JSON), ACP_TEST_AUTH');
const args = JSON.parse(process.env.ACP_TEST_ARGS ?? '[]');
const cwd = await mkdtemp(join(tmpdir(), 'grok-real-tool-'));
const marker = 'READ_PROOF_' + randomBytes(12).toString('hex');
await writeFile(join(cwd, 'fixture.txt'), marker);
const p = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); p.stderr.resume();
const rpc = new Rpc(p.stdout, p.stdin, { timeout: 120000 });
p.on('error', () => rpc.close(new Error('Cannot start test agent')));
let output = '', tool = false;
rpc.on('message', m => {
  const u = m.params?.update;
  if (u?.sessionUpdate === 'agent_message_chunk') output += u.content?.text ?? '';
  if (u?.sessionUpdate === 'tool_call' || u?.sessionUpdate === 'tool_call_update') tool = true;
  if (m.id !== undefined) {
    const allow = m.method === 'session/request_permission' && isFixtureRead(m.params.toolCall, cwd) ? m.params.options.find(o => o.kind === 'allow_once') : null;
    if (!allow && m.method === 'session/request_permission') console.error('Rejected test tool:', m.params.toolCall?.rawInput?.command ?? m.params.toolCall?.title);
    rpc.reply(m.id, { outcome: allow ? { outcome: 'selected', optionId: allow.optionId } : { outcome: 'cancelled' } });
  }
});
try {
  await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-tool-test', version: '1.0' } });
  await rpc.request('authenticate', { methodId: process.env.ACP_TEST_AUTH });
  const s = await rpc.request('session/new', { cwd, mcpServers: [] });
  const result = await rpc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Read only fixture.txt in the current directory using the shell command Get-Content -Raw -LiteralPath .\\fixture.txt (on Windows) or cat fixture.txt (on Linux). Reply with its exact contents. Do not modify files or access other paths.' }] });
  assert.equal(result.stopReason, 'end_turn'); assert.ok(tool, 'no tool event observed'); assert.ok(output.includes(marker), 'fixture contents not read');
  console.log('PASS: real tool events and verified disposable fixture read');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  const exited = once(p, 'exit'); rpc.close(); p.stdin.end();
  const timer = setTimeout(() => p.kill(), 3000); await exited; clearTimeout(timer);
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
