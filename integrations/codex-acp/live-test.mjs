// Opt-in integration test: consumes a small amount of ChatGPT subscription usage.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Rpc } from './rpc.mjs';
if (!process.argv.includes('--allow-subscription-usage')) throw new Error('Pass --allow-subscription-usage explicitly');
const cwd = await mkdtemp(join(tmpdir(), 'grok-codex-test-'));
const proc = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url))], { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
const rpc = new Rpc(proc.stdout, proc.stdin, { timeout: 120000 });
let output = ''; let chunks = 0;
rpc.on('message', m => {
  if (m.method === 'session/update' && m.params.update.sessionUpdate === 'agent_message_chunk') { output += m.params.update.content.text; chunks++; }
  if (m.id !== undefined) rpc.reply(m.id, { outcome: { outcome: 'cancelled' } });
});
try {
  await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-live-test', version: '0.1.0' } });
  await rpc.request('authenticate', { methodId: 'codex_chatgpt' });
  const s = await rpc.request('session/new', { cwd, mcpServers: [] });
  assert.ok(s.models.availableModels.length > 0);
  const result = await rpc.request('session/prompt', { sessionId: s.sessionId, prompt: [{ type: 'text', text: 'Reply exactly GROK_CODEX_OK. Do not use tools or inspect files.' }] });
  assert.equal(result.stopReason, 'end_turn'); assert.match(output, /GROK_CODEX_OK/); assert.ok(chunks > 0);
  output = '';
  await rpc.request('session/load', { sessionId: s.sessionId, cwd, mcpServers: [] });
  assert.match(output, /GROK_CODEX_OK/);
  console.log('PASS: subscription auth, model discovery, real streamed prompt, completion, session replay');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  const exited = once(proc, 'exit');
  rpc.close(); proc.stdin.end();
  const timer = setTimeout(() => proc.kill(), 3000);
  await exited; clearTimeout(timer);
  await rm(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
