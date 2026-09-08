import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import { NativeProviderService } from '../service.mjs';

test('HTTP relay releases losing close listeners on every backpressured write', { timeout: 15000 }, async context => {
  const credential = { accessToken: 'offline-relay-fixture' };
  const store = {
    get: async () => credential,
    snapshot: async () => ({ revision: 'fixture', credential }),
    update: async (_provider, updater) => ({ revision: 'fixture', credential: await updater(credential) }),
  };
  const payload = randomBytes(256 * 1024);
  const chunkCount = 32;
  const provider = {
    refresh: async value => value,
    models: async () => [{ id: 'relay-fixture', name: 'Relay fixture', contextWindow: null }],
    complete: async () => {
      let emitted = 0;
      return new Response(new ReadableStream({
        pull(controller) {
          if (emitted++ < chunkCount) controller.enqueue(payload);
          else controller.close();
        },
      }));
    },
    close() {},
  };
  const service = new NativeProviderService({ cursor: provider }, store, { serve: null });
  await service.start();
  context.after(() => service.close());
  let drains = 0;
  let peakCloseListeners = 0;
  service.server.on('request', (_request, response) => {
    response.on('drain', () => {
      drains++;
      peakCloseListeners = Math.max(peakCloseListeners, response.listenerCount('close'));
    });
  });
  const response = await fetch(service.url + '/cursor/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + service.token },
    body: JSON.stringify({ model: 'cursor/relay-fixture', messages: [{ role: 'user', content: 'Relay fixture' }], stream: true }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const received = Buffer.from(await response.arrayBuffer());
  assert.equal(received.length, payload.length * chunkCount);
  for (let index = 0; index < chunkCount; index++) {
    assert.deepEqual(received.subarray(index * payload.length, (index + 1) * payload.length), payload);
  }
  assert.ok(drains >= 10, 'The real HTTP relay did not exercise repeated backpressure');
  assert.ok(peakCloseListeners <= 2, `HTTP relay accumulated ${peakCloseListeners} close listeners`);
});

for (const providerId of ['codex', 'cursor']) test(`${providerId} HTTP disconnect aborts upstream on the shipped runtime`, { timeout: 15000 }, async context => {
  const credential = { accessToken: 'offline-cancel-fixture' };
  const store = {
    get: async () => credential,
    snapshot: async () => ({ revision: 'fixture', credential }),
    update: async (_provider, updater) => ({ revision: 'fixture', credential: await updater(credential) }),
  };
  let upstreamSignal;
  let streamCancelled = false;
  let resolveCancelled;
  const cancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const payload = randomBytes(256 * 1024);
  const provider = {
    refresh: async value => value,
    models: async () => [{ id: 'cancel-fixture', name: 'Cancel fixture', contextWindow: null }],
    complete: async (_body, _credential, { signal }) => {
      upstreamSignal = signal;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (!streamCancelled) controller.enqueue(payload);
        },
        cancel() { streamCancelled = true; resolveCancelled(); },
      }));
    },
    close() {},
  };
  const service = new NativeProviderService({ [providerId]: provider }, store);
  await service.start();
  context.after(() => service.close());
  if (globalThis.Bun) assert.ok(service.bunServer, 'The shipped Bun entry path was not exercised');
  await new Promise((resolve, reject) => {
    const client = request(service.url + `/${providerId}/v1/chat/completions`, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + service.token },
    }, response => {
      response.once('data', chunk => {
        try {
          assert.equal(response.statusCode, 200);
          assert.ok(chunk.byteLength > 0);
          response.destroy();
          client.destroy();
          resolve();
        } catch (error) { reject(error); }
      });
      response.once('error', reject);
    });
    client.once('error', reject);
    client.setTimeout(10000, () => client.destroy(new Error('HTTP cancellation fixture timed out')));
    context.after(() => client.destroy());
    client.end(JSON.stringify({ model: `${providerId}/cancel-fixture`, messages: [{ role: 'user', content: 'Cancel fixture' }], stream: true }));
  });
  await cancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstreamSignal.aborted, true);
  assert.equal(streamCancelled, true);
  assert.equal(service.active.size, 0);
});

test('closing the service cancels an attached stream on the shipped runtime', { timeout: 15000 }, async context => {
  const credential = { accessToken: 'offline-shutdown-fixture' };
  const store = {
    get: async () => credential,
    snapshot: async () => ({ revision: 'fixture', credential }),
    update: async (_provider, updater) => ({ revision: 'fixture', credential: await updater(credential) }),
  };
  let signal;
  let cancelled = false;
  let resolveCancelled;
  const streamCancelled = new Promise(resolve => { resolveCancelled = resolve; });
  const provider = {
    refresh: async value => value,
    models: async () => [{ id: 'shutdown-fixture', name: 'Shutdown fixture', contextWindow: null }],
    complete: async (_body, _credential, options) => {
      signal = options.signal;
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 5));
          if (!cancelled) controller.enqueue(new TextEncoder().encode('offline stream'));
        },
        cancel() { cancelled = true; resolveCancelled(); },
      }));
    },
    close() {},
  };
  const service = new NativeProviderService({ cursor: provider }, store);
  await service.start();
  context.after(() => service.close());
  const response = await fetch(service.url + '/cursor/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + service.token },
    body: JSON.stringify({ model: 'cursor/shutdown-fixture', messages: [{ role: 'user', content: 'Shutdown fixture' }], stream: true }),
    signal: AbortSignal.timeout(10000),
  });
  assert.equal(response.status, 200);
  const reader = response.body.getReader();
  assert.equal((await reader.read()).done, false);
  await service.close();
  await reader.cancel().catch(() => {});
  await streamCancelled;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.equal(cancelled, true);
  assert.equal(service.active.size, 0);
});

test('bodyless provider responses preserve the bridge header isolation boundary', async context => {
  const credential = { accessToken: 'offline-header-fixture' };
  const store = {
    get: async () => credential,
    snapshot: async () => ({ revision: 'fixture', credential }),
    update: async (_provider, updater) => ({ revision: 'fixture', credential: await updater(credential) }),
  };
  const provider = {
    refresh: async value => value,
    models: async () => [{ id: 'header-fixture', name: 'Header fixture', contextWindow: null }],
    complete: async () => new Response(null, { status: 204, headers: { 'Set-Cookie': 'private-fixture=value', 'X-Provider-Private': 'private-value' } }),
    close() {},
  };
  const service = new NativeProviderService({ cursor: provider }, store);
  await service.start();
  context.after(() => service.close());
  const response = await fetch(service.url + '/cursor/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + service.token },
    body: JSON.stringify({ model: 'cursor/header-fixture', messages: [{ role: 'user', content: 'Header fixture' }] }),
  });
  assert.equal(response.status, 204);
  assert.equal(response.headers.get('Set-Cookie'), null);
  assert.equal(response.headers.get('X-Provider-Private'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.equal(service.active.size, 0);
});
