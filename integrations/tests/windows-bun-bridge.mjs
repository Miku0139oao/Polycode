import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { NativeProviderService } from '../native-provider/service.mjs';

export async function startBunFixtureBridge(upstream) {
  const child = spawn('bun', [fileURLToPath(import.meta.url), '--child'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  child.stderr.resume();
  let exited = false;
  const exit = new Promise(resolve => child.once('exit', code => { exited = true; resolve(code); }));
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Bun fixture bridge startup timed out')), 15000);
    const clear = () => clearTimeout(timer);
    child.once('error', () => { clear(); reject(new Error('Bun fixture bridge could not start')); });
    child.once('exit', () => { clear(); reject(new Error('Bun fixture bridge exited before readiness')); });
    lines.once('line', line => {
      clear();
      try {
        const value = JSON.parse(line);
        assert.equal(value.runtime, 'bun');
        assert.equal(value.nativeServer, true);
        assert.match(value.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
        assert.match(value.token, /^[a-f0-9]{64}$/);
        resolve(value);
      } catch { reject(new Error('Invalid Bun fixture bridge readiness')); }
    });
  });
  child.stdin.write(JSON.stringify(upstream) + '\n');
  try {
    const bridge = await ready;
    return {
      ...bridge,
      async close() {
        child.stdin.end();
        const timer = setTimeout(() => { if (!exited) child.kill(); }, 10000);
        try { assert.equal(await exit, 0, 'Bun fixture bridge did not stop normally'); }
        finally { clearTimeout(timer); lines.close(); }
      },
    };
  } catch (cause) { child.kill(); lines.close(); throw cause; }
}

async function main() {
  assert.ok(globalThis.Bun, 'This fixture must run in Bun');
  const lines = createInterface({ input: process.stdin });
  let service;
  try {
    for await (const line of lines) {
      assert.equal(service, undefined, 'Only one fixture configuration is accepted');
      const upstream = JSON.parse(line);
      assert.match(upstream.url, /^http:\/\/127\.0\.0\.1:[0-9]+$/);
      assert.equal(typeof upstream.token, 'string');
      const headers = { Authorization: 'Bearer ' + upstream.token, 'Content-Type': 'application/json' };
      const providers = Object.fromEntries(['codex', 'cursor'].map(provider => [provider, {
        refresh: async credential => credential,
        async models(_credential, { signal }) {
          const response = await fetch(upstream.url + '/control/catalog', { headers, signal });
          assert.equal(response.status, 200);
          const catalog = await response.json();
          const entry = catalog.providers.find(entry => entry.id === provider);
          assert.ok(entry?.loggedIn);
          return entry.models;
        },
        complete: (body, _credential, { signal }) => fetch(upstream.url + `/${provider}/v1/chat/completions`, { method: 'POST', headers, body: JSON.stringify(body), signal }),
        close() {},
      }]));
      const credential = { accessToken: 'SYNTHETIC_ONLY' };
      const store = {
        get: async () => credential,
        snapshot: async () => ({ revision: 'offline-fixture', credential }),
        update: async (_provider, updater) => ({ revision: 'offline-fixture', credential: await updater(credential) }),
      };
      service = new NativeProviderService(providers, store);
      const bridge = await service.start();
      console.log(JSON.stringify({ ...bridge, runtime: 'bun', version: Bun.version, nativeServer: Boolean(service.bunServer) }));
    }
  } finally { if (service) await service.close(); }
}

if (process.argv[2] === '--child') {
  main().catch(() => { console.error('Bun fixture bridge failed'); process.exitCode = 1; });
}
