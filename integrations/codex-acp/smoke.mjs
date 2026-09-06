// Local handshake only: no model prompt or billable request.
import { spawn } from 'node:child_process';
import { Rpc } from './rpc.mjs';
import { fileURLToPath } from 'node:url';
const proc = spawn(process.execPath, [fileURLToPath(new URL('./cli.mjs', import.meta.url))], { stdio: ['pipe', 'pipe', 'inherit'] });
const rpc = new Rpc(proc.stdout, proc.stdin, { timeout: 15000 });
try {
  const init = await rpc.request('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'grok-smoke', version: '0.1.0' } });
  console.log('initialize:', init.agentInfo.name);
  await rpc.request('authenticate', { methodId: 'codex_chatgpt' });
  console.log('authentication: ChatGPT subscription (account identity not logged)');
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally { rpc.close(); proc.stdin.end(); setTimeout(() => proc.kill(), 2000).unref(); }
