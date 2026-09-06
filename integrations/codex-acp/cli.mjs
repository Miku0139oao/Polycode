#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Rpc } from './rpc.mjs';
import { CodexAdapter } from './adapter.mjs';
import { stopChild } from '../process-tree.mjs';

// Injectable streams/process factory keep shutdown tests independent of credentials.
export function run(runtime = process, spawnChild = spawn, shutdownTimeout = 2000) {
  const args = runtime.argv?.slice(2) ?? [];
  if (args.length && (args.length !== 2 || args[0] !== '--codex-executable' || !args[1])) throw new Error('Usage: cli.mjs [--codex-executable PATH]');
  const command = args[1] || runtime.env.GROK_CODEX_EXECUTABLE || 'codex';
  const child = spawnChild(command, ['-c', 'forced_login_method="chatgpt"', '-c', 'model_provider="openai"', 'app-server'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  // Do not forward upstream diagnostics which can contain paths, prompts or credentials.
  child.stderr.resume();
  const client = new Rpc(runtime.stdin, runtime.stdout);
  const server = new Rpc(child.stdout, child.stdin, { envelope: false });
  const adapter = new CodexAdapter(client, server);
  let closing = false; let shutdown; let timer;
  function stop(error = new Error('Codex adapter stopped')) {
    if (closing) return shutdown;
    closing = true;
    runtime.stdin.pause();
    server.close(error);
    timer = setTimeout(() => { child.kill('SIGKILL'); runtime.exit(1); }, shutdownTimeout); timer.unref();
    stopChild(child, runtime); child.stdin.end();
    shutdown = (async () => {
      // Let failed upstream calls/prompt promises produce their ACP errors before
      // closing stdout's RPC peer. Killing Codex must not strand a pending prompt.
      await adapter.drain();
      client.close(); runtime.stdin.destroy();
    })();
    return shutdown;
  }
  client.on('close', error => { void stop(error); });
  server.on('close', error => { if (!closing) runtime.exitCode = 1; void stop(error); });
  child.on('error', () => {
    runtime.stderr.write('Unable to start Codex. Set GROK_CODEX_EXECUTABLE to the official binary.\n');
    runtime.exitCode = 1; void stop();
  });
  child.on('exit', code => { if (!closing) runtime.exitCode = code || 1; void stop(); });
  child.on('close', () => { clearTimeout(timer); });
  runtime.on('SIGINT', () => { void stop(); }); runtime.on('SIGTERM', () => { void stop(); });
  return { client, server, child, adapter, stop };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
