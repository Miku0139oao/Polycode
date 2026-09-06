import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCursorProvider } from './index.mjs';
import * as p from './protocol.mjs';

const A = { accessToken: 'OFFLINE_ACCOUNT_A', refreshToken: 'OFFLINE_REFRESH_A' };
const B = { accessToken: 'OFFLINE_ACCOUNT_B' };
const toolName = 'mcp__strange-server__read.path-with-dashes';
const args = JSON.parse('{"path":"/never/read/this","empty":"","nil":null,"no":false,"zero":0,"nested":[1,{"__proto__":{"safe":true},"":""}]}');
const tools = [{ type: 'function', function: { name: toolName, description: 'Native tool; NEVER execute in transport.', parameters: { type: 'object', properties: { path: { type: 'string' }, nested: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'object' }] } } }, required: ['path'], additionalProperties: false } } }];
const body = (extra = {}) => ({ model: 'exact-model-id', messages: [{ role: 'system', content: 'Native permissions stay here.', name: 'native' }, { role: 'user', content: [{ type: 'text', text: 'Use my tool.', annotations: { retain: true } }] }], tools, ...extra });
const textFrame = value => p.envelope(p.bytes(1, p.bytes(1, p.string(1, value))));
const doneFrame = () => Uint8Array.from([0, 0, 0, 0, 4, 10, 2, 114, 0]); // independent literal: interaction.turn_ended
const trailerFrame = status => p.envelope(new TextEncoder().encode(`grpc-status: ${status}\r\ngrpc-message: OFFLINE_SECRET_MUST_NOT_ESCAPE\r\n`), 128);
function execFrame({ id = 7, execId = 'original-exec-id', callId = 'call_Original-:/123', name = toolName, args: values = args, provider = p.MCP_PROVIDER } = {}) {
  const entries = Object.entries(values).map(([k, v]) => p.bytes(2, p.concat(p.string(1, k), p.bytes(2, p.encodeValue(v)))));
  const mcp = p.concat(p.string(1, `${provider}-${name}`), ...entries, p.string(3, callId), p.string(4, provider), p.string(5, name));
  return p.envelope(p.bytes(2, p.concat(p.uint(1, id), p.string(15, execId), p.bytes(11, mcp))));
}
function unaryData(options) {
  const data = options.body;
  assert.equal(data[0], 0);
  assert.equal(new DataView(data.buffer, data.byteOffset + 1, 4).getUint32(0), data.length - 5);
  return p.fields(data.slice(5));
}
function mockProtocol(onStart, onAppend = () => {}) {
  const connections = new Map(), requests = [], appends = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.equal(new URL(url).origin, 'https://api2.cursor.sh');
    assert.equal(options.redirect, 'error');
    if (url.endsWith('/RunSSE')) {
      const id = p.text(p.one(unaryData(options), 1));
      const connection = { id, cancelled: false, auth: options.headers.authorization };
      connection.stream = new ReadableStream({
        start(controller) { connection.controller = controller; },
        cancel() { connection.cancelled = true; },
      });
      connection.send = (...frames) => { for (const frame of frames) connection.controller.enqueue(frame); };
      connection.end = () => connection.controller.close();
      connections.set(id, connection);
      return new Response(connection.stream, { headers: { 'content-type': 'application/grpc-web+proto' } });
    }
    assert.ok(url.endsWith('/BidiAppend'));
    const fs = unaryData(options);
    const id = p.text(p.one(p.fields(p.one(fs, 2)), 1));
    const seq = Number(p.one(fs, 3, 0));
    const message = p.fields(Buffer.from(p.text(p.one(fs, 1)), 'hex'));
    const connection = connections.get(id);
    assert.ok(connection);
    const record = { id, seq, message, connection, auth: options.headers.authorization };
    appends.push(record);
    if (message.some(f => f.id === 1)) await onStart(connection, record);
    else await onAppend(connection, record);
    return new Response(p.envelope(new Uint8Array()));
  };
  return { fetchImpl, connections, requests, appends };
}
function provider(t, mock, options = {}) {
  const instance = createCursorProvider({ fetchImpl: mock.fetchImpl, ...options });
  t.after(() => instance.close());
  return instance;
}
function continuation(request, message, content = 'native result', extra = {}) {
  return { ...request, messages: [...request.messages, message, { role: 'tool', tool_call_id: message.tool_calls[0].id, content, ...extra }] };
}
function decodeResult(record) {
  const exec = p.fields(p.one(record.message, 2));
  const result = p.fields(p.one(exec, 11));
  const success = p.fields(p.one(result, 1));
  const item = p.fields(p.one(success, 1));
  const textContent = p.fields(p.one(item, 1));
  return { id: Number(p.one(exec, 1, 0)), execId: p.text(p.one(exec, 15)), content: p.text(p.one(textContent, 1)), isError: p.one(success, 2, 0) === 1n };
}
async function sse(response) {
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  const wire = await response.text();
  const events = wire.trim().split('\n\n').map(line => {
    assert.ok(line.startsWith('data: '));
    return line === 'data: [DONE]' ? '[DONE]' : JSON.parse(line.slice(6));
  });
  assert.equal(events.at(-1), '[DONE]');
  return events;
}

test('MCP definition, arbitrary names/JSON and exact model roundtrip; no local execution', async t => {
  const mock = mockProtocol(c => c.send(textFrame('Planning.'), execFrame()));
  const instance = provider(t, mock);
  const request = body();
  const response = await instance.complete(request, A);
  assert.equal(response.status, 200);
  const result = await response.json();
  const message = result.choices[0].message;
  assert.equal(result.model, 'exact-model-id');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assert.equal(message.content, 'Planning.');
  assert.equal(message.tool_calls[0].id, 'call_Original-:/123');
  assert.equal(message.tool_calls[0].function.name, toolName);
  assert.deepEqual(JSON.parse(message.tool_calls[0].function.arguments), args);
  assert.equal(mock.appends.length, 1, 'No tool result or local fallback was generated');
  assert.equal([...mock.connections.values()][0].cancelled, false, 'Remote stream stays open');
  const run = p.fields(p.one(mock.appends[0].message, 1));
  assert.equal(p.text(p.one(p.fields(p.one(run, 3)), 1)), request.model);
  assert.equal(p.one(run, 6, 2, false), undefined, 'No MCP filesystem mode');
  const registered = p.fields(p.one(p.fields(p.one(run, 4)), 1));
  assert.equal(p.text(p.one(registered, 5)), toolName);
  assert.deepEqual(p.decodeValue(p.one(registered, 3)), tools[0].function.parameters);
  const action = p.fields(p.one(run, 2));
  const userAction = p.fields(p.one(action, 1));
  const user = p.fields(p.one(userAction, 1));
  const prompt = p.text(p.one(user, 1));
  assert.deepEqual(JSON.parse(prompt.slice(prompt.indexOf('\n') + 1)), request);
});

test('native result resumes same connection and monotonically shared append seq with KV', async t => {
  const blob = new TextEncoder().encode('opaque-session-only');
  const kv = p.envelope(p.bytes(4, p.concat(p.uint(1, 50), p.bytes(3, p.concat(p.bytes(1, Uint8Array.of(1)), p.bytes(2, blob))))));
  const mock = mockProtocol(c => c.send(execFrame()), (c, record) => {
    if (record.message[0].id === 5) c.send(kv, textFrame('Native result accepted.'), doneFrame());
  });
  const instance = provider(t, mock);
  const request = body();
  const first = await (await instance.complete(request, A)).json();
  const toolMessage = first.choices[0].message;
  const payload = [{ type: 'text', text: '{"stdout":"kept intact"}', annotations: { priority: 1 } }];
  const second = await instance.complete(continuation(request, toolMessage, payload, { is_error: true }), A);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'Native result accepted.');
  assert.equal(mock.connections.size, 1);
  assert.deepEqual(mock.appends.map(a => a.seq), [0, 1, 2, 3]);
  assert.deepEqual(decodeResult(mock.appends[1]), { id: 7, execId: 'original-exec-id', content: JSON.stringify(payload), isError: true });
  assert.equal([...mock.connections.values()][0].cancelled, true);
});

test('streaming fragments, tool intents and native-result continuation', async t => {
  const utf = textFrame('hello 中文');
  const mock = mockProtocol(c => c.send(utf.slice(0, 3), utf.slice(3, 10), utf.slice(10), execFrame()), (c, record) => {
    if (record.message[0].id === 5) c.send(textFrame('done'), doneFrame());
  });
  const instance = provider(t, mock);
  const request = body({ stream: true });
  const events = await sse(await instance.complete(request, A));
  assert.equal(events[1].choices[0].delta.content, 'hello 中文');
  const call = events.flatMap(e => e.choices?.[0]?.delta?.tool_calls ?? [])[0];
  const { index, ...cleanCall } = call;
  assert.equal(index, 0);
  assert.equal(cleanCall.function.name, toolName);
  assert.equal(events.at(-2).choices[0].finish_reason, 'tool_calls');
  const second = continuation(request, { role: 'assistant', content: 'hello 中文', tool_calls: [cleanCall] });
  const resumed = await sse(await instance.complete(second, A));
  assert.equal(resumed[1].choices[0].delta.content, 'done');
  assert.equal(mock.connections.size, 1);
});

test('stream errors are explicit and redacted, including quota for an explicitly selected auto', async t => {
  const mock = mockProtocol(c => c.send(textFrame('partial'), trailerFrame(8)));
  const instance = provider(t, mock);
  const events = await sse(await instance.complete(body({ stream: true, model: 'auto' }), A));
  assert.equal(events[1].choices[0].delta.content, 'partial');
  assert.equal(events.at(-2).error.code, 'quota_exceeded');
  assert.ok(!JSON.stringify(events).includes('OFFLINE_SECRET'));
  assert.equal(mock.connections.size, 1);
});

test('nonstream RPC quota is 429, never a fallback/default model', async t => {
  const mock = mockProtocol(c => c.send(trailerFrame(8)));
  const instance = provider(t, mock);
  const response = await instance.complete(body({ model: 'specific-unavailable-model' }), A);
  assert.equal(response.status, 429);
  assert.equal((await response.json()).error.code, 'quota_exceeded');
  assert.equal(mock.connections.size, 1);
  assert.equal(mock.appends.length, 1);
});

for (const [name, make] of [
  ['shell', () => p.envelope(p.bytes(2, p.concat(p.uint(1, 1), p.bytes(2, p.string(1, 'touch /never-executed')))))],
  ['read', () => p.envelope(p.bytes(2, p.concat(p.uint(1, 1), p.bytes(7, p.string(1, '/never-read')))))],
  ['context', () => p.envelope(p.bytes(2, p.concat(p.uint(1, 1), p.bytes(10, p.empty))))],
  ['unknown builtin', () => p.envelope(p.bytes(2, p.concat(p.uint(1, 1), p.bytes(90, p.empty))))],
  ['interaction query', () => p.envelope(p.bytes(7, p.concat(p.uint(1, 1), p.bytes(2, p.empty))))],
  ['unregistered MCP', () => execFrame({ name: 'unregistered-shell' })],
  ['wrong MCP provider', () => execFrame({ provider: 'someone-else' })],
]) test(`${name} fails closed without returning/executing a guessed native tool`, async t => {
  const mock = mockProtocol(c => c.send(make()));
  const instance = provider(t, mock);
  const response = await instance.complete(body(), A);
  assert.equal(response.status, 502);
  const result = await response.json();
  assert.ok(result.error);
  assert.equal(result.choices, undefined);
  assert.equal(mock.appends.length, 1);
  assert.equal([...mock.connections.values()][0].cancelled, true);
});

test('account, complete transcript, definitions and model isolation; no rewritten tool IDs', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), (c, record) => { if (record.message[0].id === 5) c.send(textFrame(c.auth), doneFrame()); });
  const instance = provider(t, mock);
  const request = body();
  const first = await (await instance.complete(request, A)).json();
  const message = first.choices[0].message;
  const follow = continuation(request, message);
  assert.equal((await instance.complete(follow, B)).status, 409);
  assert.equal((await instance.complete({ ...follow, model: 'different-model' }, A)).status, 409);
  assert.equal((await instance.complete({ ...follow, tools: [] }, A)).status, 409);
  const changed = structuredClone(follow); changed.messages[0].content = 'mutated permission context';
  assert.equal((await instance.complete(changed, A)).status, 409);
  assert.equal(mock.appends.length, 1);
  const accountB = await (await instance.complete(request, B)).json();
  assert.equal(accountB.choices[0].message.tool_calls[0].id, message.tool_calls[0].id);
  const resultB = await (await instance.complete(continuation(request, accountB.choices[0].message), B)).json();
  assert.equal(resultB.choices[0].message.content, 'Bearer OFFLINE_ACCOUNT_B');
  const resultA = await (await instance.complete(follow, A)).json();
  assert.equal(resultA.choices[0].message.content, 'Bearer OFFLINE_ACCOUNT_A');
  assert.equal(mock.connections.size, 2);
  assert.equal((await instance.complete(follow, A)).status, 409, 'No replay after completion');
});

test('sequential remote MCP requests across multiple native continuations retain one stream', async t => {
  let results = 0;
  const mock = mockProtocol(c => c.send(execFrame({ callId: 'first' }), execFrame({ id: 8, callId: 'second' })), (c, record) => {
    if (record.message[0].id === 5 && ++results === 2) c.send(doneFrame());
  });
  const instance = provider(t, mock);
  let request = body();
  for (const callId of ['first', 'second']) {
    const response = await (await instance.complete(request, A)).json();
    assert.equal(response.choices[0].message.tool_calls[0].id, callId);
    request = continuation(request, response.choices[0].message);
  }
  const final = await (await instance.complete(request, A)).json();
  assert.equal(final.choices[0].finish_reason, 'stop');
  assert.equal(mock.connections.size, 1);
  assert.deepEqual(mock.appends.map(a => a.seq), [0, 1, 2, 3, 4]);
});

test('concurrent duplicate initial requests and tool results cannot double submit', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), async (c, record) => {
    if (record.message[0].id === 2) await sleep(10);
    if (record.message[0].id === 5) c.send(doneFrame());
  });
  const instance = provider(t, mock);
  const request = body();
  const active = instance.complete(request, A);
  assert.equal((await instance.complete(request, A)).status, 409);
  const first = await (await active).json();
  const next = continuation(request, first.choices[0].message);
  const nextActive = instance.complete(next, A);
  assert.equal((await instance.complete(next, A)).status, 409);
  assert.equal((await nextActive).status, 200);
  assert.deepEqual(mock.appends.map(a => a.seq), [0, 1, 2]);
});

test('parked-session TTL closes remote reader and continuation fails explicitly', async t => {
  const mock = mockProtocol(c => c.send(execFrame()));
  const instance = provider(t, mock, { sessionTtlMs: 30 });
  const request = body();
  const first = await (await instance.complete(request, A)).json();
  await sleep(70);
  assert.equal([...mock.connections.values()][0].cancelled, true);
  assert.equal((await instance.complete(continuation(request, first.choices[0].message), A)).status, 409);
});

test('AbortSignal cancels active nonstream generation', async t => {
  const mock = mockProtocol(() => {});
  const instance = provider(t, mock);
  const abort = new AbortController();
  const pending = instance.complete(body(), A, { signal: abort.signal });
  await sleep(5);
  abort.abort('OFFLINE_SECRET_REASON');
  const response = await pending;
  assert.equal(response.status, 499);
  assert.equal((await response.json()).error.code, 'cancelled');
  assert.equal([...mock.connections.values()][0].cancelled, true);
});

test('SSE consumer cancellation and close() clean active/parked streams', async t => {
  const mock = mockProtocol(c => c.send(textFrame('start')));
  const instance = provider(t, mock);
  const response = await instance.complete(body({ stream: true }), A);
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  await sleep(0);
  assert.equal([...mock.connections.values()][0].cancelled, true);
  instance.close(); instance.close();
  assert.equal((await instance.complete(body(), A)).status, 503);
});

test('malformed/truncated/oversized/compressed streams never become successful completions', async t => {
  for (const value of [Uint8Array.of(0, 0, 0), Uint8Array.of(0, 255, 255, 255, 255), p.envelope(p.empty, 1), p.envelope(Uint8Array.of(0))]) {
    const mock = mockProtocol(c => { c.send(value); c.end(); });
    const instance = provider(t, mock);
    const response = await instance.complete(body(), A);
    assert.equal(response.status, 502);
    assert.ok((await response.json()).error);
  }
});

test('no model defaults or ignored sampling/forced/strict/multimodal options', async t => {
  const mock = { fetchImpl: async () => { assert.fail('network must not be reached'); } };
  const instance = provider(t, mock);
  for (const input of [body({ model: '' }), body({ model: null }), body({ temperature: 0.1 }), body({ max_tokens: 10 }), body({ stream_options: { include_usage: true } }), body({ tool_choice: 'required' }), body({ tools: [{ type: 'function', function: { name: 'strict', strict: true } }] }), body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///never' } }] }] })]) {
    assert.equal((await instance.complete(input, A)).status, 400);
  }
});

test('tool_choice:none registers no tools and rejects remote MCP intents', async t => {
  const mock = mockProtocol(c => c.send(execFrame()));
  const instance = provider(t, mock);
  const result = await instance.complete(body({ tool_choice: 'none' }), A);
  assert.equal((await result.json()).error.code, 'unregistered_tool');
  const run = p.fields(p.one(mock.appends[0].message, 1));
  assert.equal(p.one(run, 4).length, 0);
});

test('PKCE browser URL only; poll wait validates 200 credentials and does not log', async t => {
  const requests = [], logs = [];
  const old = console.log;
  console.log = (...values) => logs.push(values);
  t.after(() => { console.log = old; });
  const mock = { fetchImpl: async (url, options) => {
    requests.push({ url: new URL(url), options });
    return requests.length === 1 ? new Response(null, { status: 404 }) : Response.json({ ...A, expiresAt: 9999999999999 });
  } };
  const instance = provider(t, mock, { uuid: () => 'offline-login-id', randomBytesImpl: () => Buffer.alloc(32, 1), sleepImpl: async () => {} });
  const login = await instance.startLogin();
  assert.deepEqual(await login.wait, { ...A, expiresAt: 9999999999999 });
  const url = new URL(login.url);
  assert.equal(url.origin, 'https://cursor.com');
  assert.equal(url.pathname, '/loginDeepControl');
  assert.equal(url.searchParams.get('redirectTarget'), 'cli');
  const verifier = Buffer.alloc(32, 1).toString('base64url');
  assert.equal(url.searchParams.get('challenge'), (await import('node:crypto')).createHash('sha256').update(verifier).digest('base64url'));
  assert.equal(url.searchParams.has('verifier'), false);
  assert.equal(requests[0].url.origin, 'https://api2.cursor.sh');
  assert.equal(requests[0].url.pathname, '/auth/poll');
  assert.equal(requests[0].url.searchParams.get('verifier'), verifier);
  assert.equal(requests[0].options.redirect, 'error');
  assert.equal(requests[0].options.headers.authorization, undefined);
  assert.deepEqual(logs, []);
});

test('auth rejects malformed/failed/expired success without token or raw error exposure', async t => {
  for (const response of [Response.json({ accessToken: 12, refreshToken: 'OFFLINE_SECRET' }), Response.json({ accessToken: '', refreshToken: 'OFFLINE_SECRET' }), Response.json({ accessToken: 'expired', expiresAt: 1 }), new Response('OFFLINE_SECRET', { status: 401 }), new Response('OFFLINE_SECRET', { status: 302, headers: { location: 'https://evil.example/' } })]) {
    const instance = provider(t, { fetchImpl: async () => response });
    const login = await instance.startLogin();
    await assert.rejects(login.wait, e => !e.message.includes('OFFLINE_SECRET'));
  }
  const throwing = provider(t, { fetchImpl: async () => { throw new Error('OFFLINE_SECRET'); } });
  await assert.rejects((await throwing.startLogin()).wait, e => e.code === 'transport_error' && !e.message.includes('OFFLINE_SECRET'));
});

test('auth polling cancels via signal and close; no further poll', async t => {
  for (const mode of ['abort', 'close']) {
    let polls = 0;
    const mock = { fetchImpl: async () => { polls++; return new Response(null, { status: 404 }); } };
    const instance = provider(t, mock, { pollIntervalMs: 10000 });
    const abort = new AbortController();
    const login = await instance.startLogin({ signal: abort.signal });
    await sleep(0);
    if (mode === 'abort') abort.abort('OFFLINE_SECRET'); else instance.close();
    await assert.rejects(login.wait, e => e.code === 'cancelled' && !e.message.includes('OFFLINE_SECRET'));
    assert.equal(polls, 1);
  }
});

test('refresh uses official bearer refresh endpoint; rotation is plain caller-owned data', async t => {
  const original = { ...A, expiresAt: 1 };
  const instance = provider(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api2.cursor.sh/auth/refresh');
    assert.equal(options.headers.authorization, `Bearer ${A.refreshToken}`);
    assert.equal(options.body, '{}');
    assert.equal(options.redirect, 'error');
    return Response.json({ accessToken: 'OFFLINE_NEW_ACCESS', refreshToken: 'OFFLINE_NEW_REFRESH', expiresAt: 9999999999999 });
  } });
  const result = await instance.refresh(original);
  assert.equal(result.accessToken, 'OFFLINE_NEW_ACCESS');
  assert.equal(result.refreshToken, 'OFFLINE_NEW_REFRESH');
  assert.equal(original.accessToken, A.accessToken);
  await assert.rejects(instance.refresh(B), e => e.code === 'refresh_unavailable');
});

test('models are dynamic canonical IDs only, deduplicated; unknown context stays null', async t => {
  const instance = provider(t, { fetchImpl: async (url, options) => {
    assert.equal(url, 'https://api2.cursor.sh/aiserver.v1.AiService/GetUsableModels');
    assert.equal(options.headers.authorization, `Bearer ${A.accessToken}`);
    assert.equal(options.headers['connect-protocol-version'], '1');
    return Response.json({ models: [{ modelId: 'canonical', displayModelId: 'alias', aliases: ['other'], displayName: 'Exact name' }, { modelId: 'canonical', displayName: 'Exact name' }, { modelId: 'another', contextWindow: 12345 }] });
  } });
  assert.deepEqual(await instance.models(A), [{ id: 'canonical', name: 'Exact name', contextWindow: null }, { id: 'another', name: 'another', contextWindow: 12345 }]);
});

test('model failures are not hidden as a catalog/default/fallback', async t => {
  for (const response of [new Response('OFFLINE_SECRET', { status: 403 }), Response.json({ models: [{ displayModelId: 'no-canonical-id' }] }), Response.json({ models: [{ modelId: 'same', displayName: 'one' }, { modelId: 'same', displayName: 'two' }] })]) {
    const instance = provider(t, { fetchImpl: async () => response });
    await assert.rejects(instance.models(A), e => !e.message.includes('OFFLINE_SECRET'));
  }
});

test('extra native tool JSON fields are retained in the MCP result envelope', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), (c, record) => { if (record.message[0].id === 5) c.send(doneFrame()); });
  const instance = provider(t, mock);
  const request = body();
  const first = await (await instance.complete(request, A)).json();
  const next = continuation(request, first.choices[0].message, 'unchanged content', { name: toolName, native_metadata: { exit_code: 3, approved: false } });
  assert.equal((await instance.complete(next, A)).status, 200);
  assert.deepEqual(JSON.parse(decodeResult(mock.appends[1]).content), next.messages.at(-1));
});

test('factory state is isolated, altered assistant metadata and wrong call IDs cannot resume', async t => {
  const mock = mockProtocol(c => c.send(execFrame()));
  const one = provider(t, mock), two = provider(t, mock);
  const request = body();
  const first = await (await one.complete(request, A)).json();
  const next = continuation(request, first.choices[0].message);
  assert.equal((await two.complete(next, A)).status, 409);
  const changed = structuredClone(next); changed.messages.at(-2).native_metadata = 'changed';
  assert.equal((await one.complete(changed, A)).status, 409);
  const wrong = structuredClone(next); wrong.messages.at(-1).tool_call_id = 'made-up-id';
  assert.equal((await one.complete(wrong, A)).status, 409);
  assert.equal(mock.appends.length, 1);
});

test('KV get returns only the same connection in-memory blob, never reads any path', async t => {
  const data = new TextEncoder().encode('opaque data'), id = new TextEncoder().encode('/never-read-path');
  const set = p.envelope(p.bytes(4, p.concat(p.uint(1, 1), p.bytes(3, p.concat(p.bytes(1, id), p.bytes(2, data))))));
  const get = p.envelope(p.bytes(4, p.concat(p.uint(1, 2), p.bytes(2, p.bytes(1, id)))));
  const mock = mockProtocol(c => c.send(set, get, doneFrame()));
  const instance = provider(t, mock);
  assert.equal((await instance.complete(body(), A)).status, 200);
  const kvClient = p.fields(p.one(mock.appends[2].message, 3));
  assert.deepEqual(Uint8Array.from(p.one(p.fields(p.one(kvClient, 2)), 1)), data);
  assert.deepEqual(mock.appends.map(a => a.seq), [0, 1, 2]);
});

test('unary BidiAppend RPC failure is not ignored, retried or exposed raw', async t => {
  const mock = mockProtocol(() => {});
  const instance = provider(t, { fetchImpl: async (url, options) => {
    if (url.endsWith('/BidiAppend')) return new Response(trailerFrame(8));
    return mock.fetchImpl(url, options);
  } });
  const response = await instance.complete(body(), A);
  assert.equal(response.status, 429);
  assert.ok(!(await response.text()).includes('OFFLINE_SECRET'));
  assert.equal(mock.connections.size, 1);
  assert.equal([...mock.connections.values()][0].cancelled, true);
});

test('refresh/models cancellation interrupts noncooperative injected fetch without raw errors', async t => {
  const instance = provider(t, { fetchImpl: () => new Promise(() => {}) });
  for (const method of ['models', 'refresh']) {
    const abort = new AbortController();
    const pending = instance[method](A, { signal: abort.signal });
    abort.abort('OFFLINE_SECRET_REASON');
    await assert.rejects(pending, e => e.code === 'cancelled' && !e.message.includes('OFFLINE_SECRET'));
  }
});

test('login poll budget ends explicitly instead of returning unvalidated credentials', async t => {
  let polls = 0;
  const instance = provider(t, { fetchImpl: async () => { polls++; return new Response(null, { status: 404 }); } }, { maxPollAttempts: 2, sleepImpl: async () => {} });
  await assert.rejects((await instance.startLogin()).wait, e => e.code === 'login_timeout');
  assert.equal(polls, 2);
});

test('closed parked session is cancelled, and limits never evict another account', async t => {
  const mock = mockProtocol(c => c.send(execFrame()));
  const instance = provider(t, mock, { maxSessions: 1 });
  const first = await instance.complete(body(), A);
  assert.equal(first.status, 200);
  assert.equal((await instance.complete(body(), B)).status, 429);
  assert.equal([...mock.connections.values()][0].cancelled, false);
  instance.close();
  await sleep(0);
  assert.equal([...mock.connections.values()][0].cancelled, true);
});

test('protobuf Value preserves empty/null/false/numbers/maps, rejects malformed and pollution', () => {
  assert.deepEqual(p.decodeValue(p.encodeValue(args)), args);
  assert.equal({}.safe, undefined);
  assert.throws(() => p.fields(Uint8Array.of(0x80)));
  assert.throws(() => p.fields(Uint8Array.of(0x0a, 9, 1)));
  assert.throws(() => p.decodeValue(p.empty));
  assert.throws(() => p.fields(Uint8Array.of(0x08, ...Array(10).fill(255))));
});
