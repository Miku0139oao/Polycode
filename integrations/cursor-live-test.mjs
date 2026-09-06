// Official Cursor ACP integration. Opt-in: consumes Cursor account usage.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import assert from 'node:assert/strict';
import { Rpc } from './codex-acp/rpc.mjs';
const command = process.env.GROK_CURSOR_EXECUTABLE;
const args = JSON.parse(process.env.GROK_CURSOR_ARGS ?? '["acp"]');
if (!command) throw new Error('Set GROK_CURSOR_EXECUTABLE to the official Cursor executable');
if (!process.argv.includes('--allow-subscription-usage')) throw new Error('Pass --allow-subscription-usage explicitly');
const cwd = await mkdtemp(join(tmpdir(), 'grok-cursor-test-'));
const proc = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] }); proc.stderr.resume();
const rpc = new Rpc(proc.stdout, proc.stdin, { timeout: 120000 });
proc.on('error', () => rpc.close(new Error('Cursor failed to start')));
let output = '';
rpc.on('message', m => {
  if (m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk') output += m.params.update.content.text;
  if (m.id !== undefined) rpc.reply(m.id, { outcome: { outcome: 'cancelled' } });
});
try {
  const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: 'grok-cursor-test', version: '0.1.0' } });
  assert.ok(init.authMethods.some(a => a.id === 'cursor_login'));
  await rpc.request('authenticate', { methodId: 'cursor_login' });
  const s = await rpc.request('session/new', { cwd, mcpServers: [] });
  assert.ok(s.sessionId);
  const result = await rpc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Reply exactly GROK_CURSOR_OK. Do not use tools or inspect files.' }] });
  assert.equal(result.stopReason, 'end_turn'); assert.match(output, /GROK_CURSOR_OK/);
  output = '';
  await rpc.request('session/load', { sessionId: s.sessionId, cwd, mcpServers: [] });
  assert.match(output, /GROK_CURSOR_OK/);
  console.log('PASS: official Cursor ACP login, streamed prompt, completion and session replay');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  const exited = once(proc, 'exit'); rpc.close(); proc.stdin.end(); proc.kill();
  const timer = setTimeout(() => proc.kill('SIGKILL'), 3000); await exited; clearTimeout(timer);
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
