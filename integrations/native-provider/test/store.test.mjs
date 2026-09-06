import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CredentialStore } from '../store.mjs';
test('real processes cannot rotate an old credential over a new login', { timeout: 15000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), 'polycode-process-lock-'));
  const children = [];
  t.after(async () => { for (const child of children) if (child.exitCode === null) child.kill(); await rm(directory, { recursive: true, force: true }); });
  const store = new CredentialStore(directory); await store.set('codex', { accessToken: 'original' });
  function worker(mode) {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/credential-worker.mjs', import.meta.url)), directory, mode], { stdio: ['pipe', 'pipe', 'pipe'] }); children.push(child);
    let output = ''; const waiters = [];
    child.stdout.on('data', data => { output += data; for (const [marker, resolve] of waiters) if (output.includes(marker)) resolve(); });
    const done = new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => code === 0 ? resolve() : reject(new Error('Credential worker failed'))); });
    return { child, done, wait: marker => output.includes(marker) ? Promise.resolve() : new Promise(resolve => waiters.push([marker, resolve])) };
  }
  const refresh = worker('refresh'); await refresh.wait('locked');
  const login = worker('login'); await login.wait('started');
  refresh.child.stdin.end('commit\n');
  await Promise.all([refresh.done, login.done]);
  assert.equal((await store.get('codex')).accessToken, 'new-account');
});
