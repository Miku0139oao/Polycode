import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { createCursorProvider } from './index.mjs';
import { Connection } from './transport.mjs';
import * as p from './protocol.mjs';
import { gifBase64, gifHex, historyHex, userImageHex, usageFrameHex, userRuleHex } from './wire-fixtures.mjs';

const A = { accessToken: 'OFFLINE_ACCOUNT_A', refreshToken: 'OFFLINE_REFRESH_A' };
test('MCP exec metadata is not mistaken for a builtin and cannot authorize extra operations', () => {
  const raw = p.one(p.fields(execFrame().subarray(5)), 2);
  const expected = p.parseExec(raw);
  const metadata = p.concat(p.bytes(19, p.string(1, 'offline-trace')), p.uint(55, 1));
  assert.deepEqual(p.parseExec(p.concat(raw, metadata)), expected);
  const args = p.one(p.fields(raw), 11);
  const withServer = value => p.concat(p.uint(1, 7), p.string(15, 'original-exec-id'), p.bytes(11, p.concat(args, p.string(9, value))));
  assert.deepEqual(p.parseExec(withServer(p.MCP_PROVIDER)), expected);
  assert.throws(() => p.parseExec(withServer('another-server')), { code: 'invalid_protocol' });
  assert.throws(() => p.parseExec(p.bytes(11, p.concat(args, p.uint(8, 1)))), { code: 'unsupported_protocol' });
  assert.throws(() => p.parseExec(p.concat(raw, p.uint(19, 1))), { code: 'invalid_protocol' });
  assert.throws(() => p.parseExec(p.concat(raw, p.uint(55, 2))), { code: 'invalid_protocol' });
  assert.throws(() => p.parseExec(p.concat(raw, p.bytes(2, p.empty), metadata)), { code: 'unsupported_builtin' });
  assert.throws(() => p.parseExec(p.concat(raw, p.string(57, 'remote-machine'))), { code: 'unsupported_builtin' });
});
test('interaction timestamps accompany text without becoming content or permitting malformed fields', async () => {
  const collect = async data => {
    const connection = new Connection({ uuid: () => 'offline', controller: new AbortController() });
    connection.response = new Response(data);
    return Array.fromAsync(connection.events());
  };
  const update = p.bytes(1, p.string(1, 'actual text'));
  const timestamp = p.uint(25, 1788821700000);
  const progress = p.concat(p.envelope(p.bytes(1, p.bytes(8, p.uint(1, 100)))), p.envelope(p.bytes(1, p.bytes(5, p.uint(1, 250)))), ...[15, 16, 17].map(id => p.envelope(p.bytes(1, p.bytes(id, p.empty)))));
  const events = await collect(p.concat(p.envelope(p.bytes(8, p.empty)), progress, p.envelope(p.bytes(1, p.concat(update, timestamp))), doneFrame()));
  assert.deepEqual(events, [{ type: 'text', text: 'actual text' }, { type: 'done', usage: undefined }]);
  await assert.rejects(collect(p.envelope(p.bytes(1, p.concat(update, p.bytes(25, p.empty))))), /protocol/i);
  await assert.rejects(collect(p.envelope(p.bytes(1, p.concat(update, timestamp, timestamp)))), /protocol/i);
  await assert.rejects(collect(p.envelope(p.bytes(1, p.concat(update, p.uint(26, 1))))), { code: 'invalid_protocol' });
  await assert.rejects(collect(p.envelope(p.bytes(9, p.empty))), { code: 'unsupported_protocol' });
  await assert.rejects(collect(p.envelope(p.bytes(1, p.bytes(8, p.string(1, 'not token count'))))), { code: 'invalid_protocol' });
});
test('KV accepts optional span context without changing blob storage or accepting unknown requests', async () => {
  const connection = new Connection({ uuid: () => 'offline', controller: new AbortController() });
  const sent = [];
  connection.append = async value => { sent.push(value); };
  const key = Uint8Array.of(7), blob = new TextEncoder().encode('opaque payload');
  const span = p.bytes(4, p.string(1, 'offline-trace'));
  await connection.kv(p.concat(p.uint(1, 1), p.bytes(3, p.concat(p.bytes(1, key), p.bytes(2, blob))), span));
  await connection.kv(p.concat(p.uint(1, 2), p.bytes(2, p.bytes(1, key)), span));
  assert.deepEqual(sent[1], p.bytes(3, p.concat(p.uint(1, 2), p.bytes(2, p.bytes(1, blob)))));
  await assert.rejects(connection.kv(p.concat(p.uint(1, 3), p.bytes(2, p.bytes(1, key)), p.uint(4, 1))), /protocol/);
  await assert.rejects(connection.kv(p.concat(p.uint(1, 4), p.bytes(2, p.bytes(1, key)), p.bytes(5, p.empty))), /protocol/);
  assert.equal(sent.length, 2);
});
const B = { accessToken: 'OFFLINE_ACCOUNT_B' };
const toolName = 'mcp__strange-server__read.path-with-dashes';
const args = JSON.parse('{"path":"/never/read/this","empty":"","nil":null,"no":false,"zero":0,"nested":[1,{"__proto__":{"safe":true},"":""}]}');
const tools = [{ type: 'function', function: { name: toolName, description: 'Native tool; NEVER execute in transport.', parameters: { type: 'object', properties: { path: { type: 'string' }, nested: { type: 'array', items: { anyOf: [{ type: 'number' }, { type: 'object' }] } } }, required: ['path'], additionalProperties: false } } }];
const titleTool = { type: 'function', function: { name: 'session_title', description: 'Set the native session title.', parameters: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] } } };
const forcedChoice = name => ({ type: 'function', function: { name } });
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
  assert.equal(prompt, JSON.stringify(request.messages[1].content[0])); // Annotation is retained as typed text.
  const context = p.fields(p.one(userAction, 2));
  const serverInstructions = p.fields(p.one(context, 14));
  assert.equal(p.text(p.one(serverInstructions, 3)), p.MCP_PROVIDER);
  assert.match(p.text(p.one(serverInstructions, 2)), /Never prepend \/polycode-virtual to tool arguments/);
  const rule = p.fields(p.one(context, 2));
  assert.equal(p.text(p.one(rule, 2)), 'Native permissions stay here.\n' + JSON.stringify({ polycode_message_metadata: { name: 'native' } }));
  assert.equal(p.one(rule, 4, 0), 2n, 'Ordinary USER rule, not TEAM');
  assert.equal(p.one(run, 8, 2, false), undefined, 'No restricted custom system prompt');
  assert.equal(p.one(userAction, 7, 2, false), undefined, 'System text is a rule, not fake user history');
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

test('native assistant model metadata resumes only the exact selected model', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), (c, record) => {
    if (record.message[0].id === 5) c.send(textFrame('native continuation'), doneFrame());
  });
  const instance = provider(t, mock), request = body();
  const first = await (await instance.complete(request, A)).json();
  const message = first.choices[0].message;
  assert.equal((await instance.complete(continuation(request, { ...message, model_id: 'foreign-model' }), A)).status, 409);
  assert.equal(mock.appends.length, 1);
  const response = await instance.complete(continuation(request, { ...message, model_id: request.model }), A);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'native continuation');
  assert.equal(mock.connections.size, 1);
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

for (const [label, otherConfig] of [
  ['choice', { tool_choice: 'auto' }],
  ['model', { tool_choice: 'required', model: 'different-model' }],
]) test(`same-ID parked ownership collision across ${label} configurations rejects every continuation before submit`, async t => {
  let submits = 0;
  const mock = mockProtocol(c => c.send(execFrame()), (c, r) => {
    if (r.message[0].id === 2) submits++;
    if (r.message[0].id === 5) c.send(execFrame({ callId: 'would-have-resumed-wrong-session' }));
  });
  const instance = provider(t, mock), first = body({ tool_choice: 'required' }), second = body(otherConfig);
  const firstMessage = (await (await instance.complete(first, A)).json()).choices[0].message;
  const secondMessage = (await (await instance.complete(second, A)).json()).choices[0].message;
  assert.deepEqual(firstMessage, secondMessage, 'Backend reused exact native call ID/name/JSON');
  assert.equal(mock.connections.size, 2);
  for (const next of [
    { ...continuation(first, firstMessage), ...otherConfig }, // Must not route the first result to the second connection.
    continuation(first, firstMessage), continuation(second, secondMessage),
    { ...continuation(second, secondMessage), tool_choice: first.tool_choice, model: first.model },
  ]) {
    const response = await instance.complete(next, A);
    assert.equal(response.status, 409);
    assert.equal((await response.json()).error.code, 'continuation_mismatch');
    assert.equal(submits, 0);
    assert.deepEqual(mock.appends.map(r => r.seq), [0, 0], 'Neither parked connection received a result or close');
    assert.ok([...mock.connections.values()].every(c => !c.cancelled), 'Ambiguity does not select/drop an arbitrary owner');
  }
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

test('no model defaults or ignored sampling/strict/external-image options', async t => {
  const mock = { fetchImpl: async () => { assert.fail('network must not be reached'); } };
  const instance = provider(t, mock);
  for (const input of [body({ model: '' }), body({ model: null }), body({ temperature: 0.1 }), body({ max_tokens: 10 }), body({ max_completion_tokens: 10 }), body({ top_p: 0.9 }), body({ tools: [{ type: 'function', function: { name: 'strict', strict: true } }] }), body({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'file:///never' } }] }] })]) {
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

function assertRegistered(record, expected) {
  const { run, action } = runAction(record);
  const context = p.fields(p.one(action, 2));
  const asHex = data => Buffer.from(data).toString('hex');
  const registered = p.fields(p.one(run, 4)).map(f => asHex(f.value));
  assert.deepEqual(registered, expected.map(tool => asHex(p.mcpDefinition(tool))));
  assert.deepEqual(context.filter(f => f.id === 7).map(f => asHex(f.value)), registered);
  assert.deepEqual(run.map(f => f.id), [1, 2, 3, 4, 5], 'No fabricated tool_choice or restricted run fields');
  assert.ok(context.every(f => [2, 4, 7, 14].includes(f.id)), 'Only existing context fields');
  const rules = context.filter(f => f.id === 2).map(f => p.fields(f.value));
  assert.ok(rules.every(rule => p.one(rule, 4, 0) === 2n), 'All rules are ordinary USER rules');
  return { action, rules };
}
async function choiceFailure(response, stream, code) {
  if (stream) {
    assert.equal(response.status, 200);
    const events = await sse(response);
    assert.equal(events.length, 2, 'Only error + DONE: no role, text, tool, finish or successful usage leak');
    assert.equal(events[0].error.code, code);
  } else {
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.error.code, code);
    assert.equal(result.choices, undefined);
    assert.equal(result.usage, undefined);
  }
}
function streamedMessage(events) {
  const deltas = events.flatMap(e => e.choices?.map(c => c.delta) ?? []);
  return { role: 'assistant', content: deltas.map(d => d.content ?? '').join('') || null,
    tool_calls: deltas.flatMap(d => d.tool_calls ?? []).map(({ index, ...call }) => { assert.equal(index, 0); return call; }) };
}

test('invalid choice shapes, unknown names and required without tools fail before network', async t => {
  const instance = provider(t, { fetchImpl: () => assert.fail('No network for invalid choice') });
  const choices = [null, true, 0, [], {}, 'unknown', { type: 'function' }, { type: 'function', function: null },
    { type: 'other', function: { name: toolName } }, { type: 'function', name: toolName },
    forcedChoice(''), forcedChoice(123), forcedChoice('unknown-native-tool'), forcedChoice(toolName.toUpperCase()),
    { ...forcedChoice(toolName), extra: true }, { type: 'function', function: { name: toolName, arguments: '{}' } }];
  for (const tool_choice of choices) {
    const response = await instance.complete(body({ tool_choice }), A);
    assert.equal(response.status, 400, JSON.stringify(tool_choice));
    assert.equal((await response.json()).error.code, 'invalid_request');
  }
  for (const tool_choice of ['required', forcedChoice(toolName)]) {
    for (const emptyTools of [{ tools: [] }, {}]) {
      const { tools: omitted, ...request } = body({ tool_choice });
      assert.equal((await instance.complete({ ...request, ...emptyTools }, A)).status, 400);
    }
  }
});

for (const chosen of [titleTool, tools[0]]) test(`forced named choice ${chosen.function.name} preserves native intent and typed history`, async t => {
  for (const stream of [false, true]) {
    const name = chosen.function.name, values = name === 'session_title' ? { title: 'Native title 中文' } : args;
    const mock = mockProtocol(c => c.send(textFrame('Before '), textFrame('中文.'), execFrame({ name, args: values })));
    const instance = provider(t, mock);
    const request = body({ stream, tools: [titleTool, ...tools], tool_choice: forcedChoice(name), messages: [
      { role: 'system', content: 'Policy' }, ...historical(), { role: 'developer', content: 'Instruction' }, { role: 'user', content: 'Next' },
    ] });
    const original = structuredClone(request), response = await instance.complete(request, A);
    assert.equal(response.status, 200);
    const events = stream ? await sse(response) : undefined;
    const completion = stream ? undefined : await response.json();
    const message = stream ? streamedMessage(events) : completion.choices[0].message;
    assert.deepEqual(message, { role: 'assistant', content: 'Before 中文.', tool_calls: [
      { id: 'call_Original-:/123', type: 'function', function: { name, arguments: JSON.stringify(values) } },
    ] });
    assert.equal(stream ? events.at(-2).choices[0].finish_reason : completion.choices[0].finish_reason, 'tool_calls');
    assert.deepEqual(request, original, 'No caller transcript, choice or definitions mutation');
    const { action, rules } = assertRegistered(mock.appends[0], [chosen]);
    assert.equal(hex(p.one(action, 7)), historyHex, 'Guidance never becomes fake native history');
    assert.equal(p.text(p.one(p.fields(p.one(action, 1)), 1)), 'Next', 'Current user is untouched');
    assert.equal(rules.length, 3);
    assert.deepEqual(rules.slice(0, 2).map(rule => p.text(p.one(rule, 2))), ['Policy', 'Instruction']);
    assert.ok(p.text(p.one(rules[2], 2)).includes(`exact native name ${JSON.stringify(name)}`));
    for (const { options } of mock.requests) assert.ok(!Object.keys(options.headers).some(k => /allowed-tools|exclude-tools|team|harness/i.test(k)));
    assert.equal(mock.appends.length, 1, 'Intent only: no transport execution, result or close');
    assert.equal([...mock.connections.values()][0].cancelled, false, 'Original remote exec stays parked');
  }
});

test('native initial session_title forced choice works with only its supplied tool', async t => {
  const mock = mockProtocol(c => c.send(execFrame({ name: 'session_title', args: { title: 'Native title' } })));
  const result = await (await provider(t, mock).complete(body({ tools: [titleTool], tool_choice: forcedChoice('session_title') }), A)).json();
  assert.equal(result.choices[0].message.tool_calls[0].function.name, 'session_title');
  assert.equal(result.choices[0].finish_reason, 'tool_calls');
  assertRegistered(mock.appends[0], [titleTool]);
  assert.equal(mock.appends.length, 1);
});

test('required registers every supplied tool and accepts any one unchanged', async t => {
  for (const chosen of [titleTool, tools[0]]) {
    for (const stream of [false, true]) {
      const mock = mockProtocol(c => c.send(textFrame('Preparing.'), execFrame({ name: chosen.function.name })));
      const response = await provider(t, mock).complete(body({ stream, tools: [titleTool, ...tools], tool_choice: 'required' }), A);
      const message = stream ? streamedMessage(await sse(response)) : (await response.json()).choices[0].message;
      assert.equal(message.tool_calls[0].function.name, chosen.function.name);
      assert.equal(message.tool_calls[0].id, 'call_Original-:/123');
      assert.equal(message.tool_calls[0].function.arguments, JSON.stringify(args));
      assert.equal(message.content, 'Preparing.');
      const { rules } = assertRegistered(mock.appends[0], [titleTool, ...tools]);
      assert.ok(p.text(p.one(rules.at(-1), 2)).includes('request at least one of the supplied MCP tools'));
      assert.equal(mock.appends.length, 1);
    }
  }
});

test('mandatory choice rejects wrong execs and builtins before releasing any buffered SSE output', async t => {
  const builtin = p.envelope(p.bytes(2, p.concat(p.uint(1, 1), p.bytes(2, p.string(1, 'never execute')))));
  for (const [tool_choice, frame, code] of [
    [forcedChoice('session_title'), execFrame(), 'unregistered_tool'], // Supplied, but not the chosen tool.
    [forcedChoice('session_title'), execFrame({ name: 'unknown' }), 'unregistered_tool'],
    ['required', execFrame({ name: 'unknown' }), 'unregistered_tool'],
    [forcedChoice('session_title'), builtin, 'unsupported_builtin'],
    ['required', builtin, 'unsupported_builtin'],
    ['required', execFrame({ provider: 'someone-else' }), 'invalid_protocol'],
  ]) {
    for (const stream of [false, true]) {
      const mock = mockProtocol(c => c.send(textFrame('Must not leak.'), frame));
      await choiceFailure(await provider(t, mock).complete(body({ stream, tools: [titleTool, ...tools], tool_choice }), A), stream, code);
      assert.equal(mock.appends.length, 1, 'No wrong tool result or fallback');
      assert.equal([...mock.connections.values()][0].cancelled, true);
    }
  }
});

test('mandatory choice rejects text-only or empty remote completion without successful output or usage', async t => {
  for (const tool_choice of ['required', forcedChoice(toolName)]) {
    for (const stream of [false, true]) {
      for (const finish of [doneFrame(), trailerFrame(0), usageFrame()]) {
        for (const text of ['', 'NOT A TOOL: must not leak.']) {
          const mock = mockProtocol(c => c.send(textFrame(text), finish));
          await choiceFailure(await provider(t, mock).complete(body({ stream, stream_options: { include_usage: true }, tool_choice }), A), stream, 'tool_choice_unfulfilled');
          assert.equal(mock.appends.length, 1, 'No retry, synthetic intent or fabricated result');
          assert.equal([...mock.connections.values()][0].cancelled, true);
        }
      }
    }
  }
});

test('progress notifications and historical calls never satisfy a required current intent', async t => {
  const progress = p.envelope(p.bytes(1, p.concat(p.bytes(7, p.empty), p.bytes(13, p.empty))));
  const mock = mockProtocol(c => c.send(textFrame('Do not leak.'), progress, doneFrame()));
  await choiceFailure(await provider(t, mock).complete(body({ stream: true, tool_choice: 'required', messages: [
    ...historical(), { role: 'user', content: 'Next' },
  ] }), A), true, 'tool_choice_unfulfilled');
  assert.equal(mock.appends.length, 1);
});

test('mandatory choices reject reused historical IDs before releasing buffered text', async t => {
  for (const tool_choice of ['required', forcedChoice(toolName)]) {
    const mock = mockProtocol(c => c.send(textFrame('Do not leak.'), execFrame({ callId: 'c:1' })));
    await choiceFailure(await provider(t, mock).complete(body({ stream: true, tool_choice, messages: [
      ...historical(), { role: 'user', content: 'Next' },
    ] }), A), true, 'duplicate_tool_call');
    assert.equal(mock.appends.length, 1);
  }
});

test('mandatory continuations keep exact correlation and choice; a previous intent cannot authorize final text', async t => {
  for (const tool_choice of ['required', forcedChoice(toolName)]) {
    let results = 0;
    const secondName = tool_choice === 'required' ? 'session_title' : toolName;
    const mock = mockProtocol(c => c.send(textFrame('First.'), execFrame({ callId: 'native:1' })), (c, r) => {
      if (r.message[0].id !== 5) return;
      if (++results === 1) c.send(textFrame('Second.'), execFrame({ id: 8, execId: 'exact:second', callId: 'native:2', name: secondName }));
      else c.send(textFrame('Final text must not leak.'), usageFrame());
    });
    const instance = provider(t, mock), request = body({ tools: [titleTool, ...tools], tool_choice });
    const first = (await (await instance.complete(request, A)).json()).choices[0].message;
    const next = continuation(request, first, [{ type: 'text', text: 'Exact native result', annotations: { priority: 1 } }],
      { name: toolName, is_error: true, native_metadata: { exit_code: 3 } });
    for (const changedChoice of ['auto', 'none', tool_choice === 'required' ? forcedChoice(toolName) : 'required', forcedChoice('session_title')]) {
      assert.equal((await instance.complete({ ...next, tool_choice: changedChoice }, A)).status, 409);
    }
    const changedHistory = structuredClone(next); changedHistory.messages[0].content = 'changed';
    assert.equal((await instance.complete(changedHistory, A)).status, 409);
    assert.equal((await instance.complete(next, B)).status, 409);
    assert.equal(mock.appends.length, 1, 'Invalid continuation cannot submit a result or replace a session');
    const streamingNext = { ...next, stream: true, stream_options: { include_usage: true } };
    const events = await sse(await instance.complete(streamingNext, A));
    const second = streamedMessage(events);
    assert.equal(second.content, 'Second.');
    assert.deepEqual(second.tool_calls, [{ id: 'native:2', type: 'function', function: { name: secondName, arguments: JSON.stringify(args) } }]);
    assert.deepEqual(decodeResult(mock.appends[1]), { id: 7, execId: 'original-exec-id', content: JSON.stringify(next.messages.at(-1)), isError: true });
    const final = continuation(streamingNext, second, 'Second result');
    await choiceFailure(await instance.complete(final, A), true, 'tool_choice_unfulfilled');
    assert.deepEqual(decodeResult(mock.appends[3]), { id: 8, execId: 'exact:second', content: 'Second result', isError: false });
    assert.deepEqual(mock.appends.map(a => a.seq), [0, 1, 2, 3, 4]);
    assert.equal(mock.connections.size, 1, 'No synthetic continuation run or instruction/result rewriting');
    assert.equal([...mock.connections.values()][0].cancelled, true);
    assert.equal((await instance.complete(final, A)).status, 409, 'Failed continuation cannot be replayed');
  }
});

test('forced subset enforcement still rejects a different supplied tool after native continuation', async t => {
  const mock = mockProtocol(c => c.send(execFrame({ name: 'session_title' })), (c, r) => {
    if (r.message[0].id === 5) c.send(textFrame('Must not leak.'), execFrame({ callId: 'wrong:second' }));
  });
  const instance = provider(t, mock), request = body({ tools: [titleTool, ...tools], tool_choice: forcedChoice('session_title') });
  const message = (await (await instance.complete(request, A)).json()).choices[0].message;
  await choiceFailure(await instance.complete({ ...continuation(request, message), stream: true }, A), true, 'unregistered_tool');
  assert.equal(mock.connections.size, 1);
  assert.equal(mock.appends.length, 3, 'Only the permitted original native result and close were submitted');
  assert.equal(decodeResult(mock.appends[1]).execId, 'original-exec-id');
});

test('mandatory buffered streams cancel without invalidating a previous independent auto session', async t => {
  for (const mode of ['signal', 'reader']) {
    const mock = mockProtocol((c, r) => {
      const run = p.fields(p.one(r.message, 1));
      c.send(p.text(p.one(p.fields(p.one(run, 3)), 1)) === 'parked-auto' ? execFrame() : textFrame('Buffered, not released.'));
    }, (c, r) => { if (r.message[0].id === 5) c.send(textFrame('Previous session retained.'), doneFrame()); });
    const instance = provider(t, mock), previous = body({ model: 'parked-auto', tool_choice: 'auto' });
    const message = (await (await instance.complete(previous, A)).json()).choices[0].message;
    const abort = new AbortController();
    const response = await instance.complete(body({ stream: true, tool_choice: mode === 'signal' ? 'required' : forcedChoice(toolName) }), A, { signal: abort.signal });
    if (mode === 'signal') {
      const pending = choiceFailure(response, true, 'cancelled');
      await sleep(0);
      abort.abort('OFFLINE_SECRET_REASON');
      await pending;
    } else {
      const reader = response.body.getReader(), pending = reader.read();
      await sleep(0);
      await reader.cancel();
      assert.equal((await pending).done, true);
    }
    await sleep(0);
    const [parked, cancelled] = [...mock.connections.values()];
    assert.equal(cancelled.cancelled, true);
    assert.equal(parked.cancelled, false);
    const resumed = await (await instance.complete(continuation(previous, message), A)).json();
    assert.equal(resumed.choices[0].message.content, 'Previous session retained.');
    assert.equal(resumed.choices[0].finish_reason, 'stop');
    assert.equal(mock.connections.size, 2);
  }
});

async function readSseEvent(reader) {
  const { value, done } = await reader.read();
  if (done) return undefined;
  const wire = new TextDecoder().decode(value).trim();
  assert.ok(wire.startsWith('data: '));
  return wire === 'data: [DONE]' ? '[DONE]' : JSON.parse(wire.slice(6));
}

for (const mode of ['abort', 'idle expiry']) {
  for (const [queued, consumedCount] of [['text', 1], ['tool', 2], ['finish', 3]]) {
    test(`${mode} after backpressured mandatory ${queued} suppresses all subsequent successful output`, async t => {
      const mock = mockProtocol(c => c.send(textFrame('Buffered native text.'), execFrame()));
      const instance = provider(t, mock, { sessionTtlMs: mode === 'idle expiry' ? 100 : 10000 });
      const abort = new AbortController();
      const request = body({ stream: true, tool_choice: 'required', stream_options: { include_usage: true } });
      const response = await instance.complete(request, A, { signal: abort.signal });
      const reader = response.body.getReader(), consumed = [];
      for (let i = 0; i < consumedCount; i++) consumed.push(await readSseEvent(reader));
      assert.equal(consumed[0].choices[0].delta.role, 'assistant');
      // One queued chunk fills the stream: the generator is suspended at this yield.
      await sleep(0);
      const connection = [...mock.connections.values()][0];
      assert.equal(connection.cancelled, false);
      if (mode === 'abort') abort.abort('OFFLINE_SECRET_REASON');
      else await sleep(150);
      await sleep(0);
      assert.equal(connection.cancelled, true);
      const remaining = [];
      for (let event; (event = await readSseEvent(reader)) !== undefined;) remaining.push(event);
      // Already-enqueued output cannot be retracted; nothing successful may be newly emitted.
      assert.equal(remaining.length, 3, 'Only the prior queued chunk, explicit cancellation error and DONE');
      const prior = remaining[0].choices[0];
      if (queued === 'text') assert.equal(prior.delta.content, 'Buffered native text.');
      else if (queued === 'tool') assert.equal(prior.delta.tool_calls[0].id, 'call_Original-:/123');
      else assert.equal(prior.finish_reason, 'tool_calls');
      assert.equal(remaining[1].error.code, 'cancelled');
      assert.equal(remaining[2], '[DONE]', 'DONE follows an error, not successful usage/finish');
      assert.ok(!remaining.slice(1).some(e => e.choices), 'No newly emitted executable intent, finish or usage');
      const message = { role: 'assistant', content: 'Buffered native text.', tool_calls: [
        { id: 'call_Original-:/123', type: 'function', function: { name: toolName, arguments: JSON.stringify(args) } },
      ] };
      assert.equal((await instance.complete(continuation(request, message), A)).status, 409);
      assert.equal(mock.appends.length, 1);
      assert.equal(mock.connections.size, 1);
    });
  }
}

test('auto/none remote completion remains cancellable until successful SSE terminal release', async t => {
  for (const tool_choice of ['auto', 'none']) {
    for (const mode of ['abort', 'idle expiry']) {
      const mock = mockProtocol(c => c.send(textFrame('Ordinary text.'), usageFrame()));
      const instance = provider(t, mock, { sessionTtlMs: mode === 'idle expiry' ? 100 : 10000 });
      const abort = new AbortController();
      const response = await instance.complete(body({ stream: true, tool_choice, stream_options: { include_usage: true } }), A, { signal: abort.signal });
      const reader = response.body.getReader();
      assert.equal((await readSseEvent(reader)).choices[0].delta.role, 'assistant');
      assert.equal((await readSseEvent(reader)).choices[0].delta.content, 'Ordinary text.');
      await sleep(0); // The stop chunk is queued, but usage/DONE have not been emitted.
      const connection = [...mock.connections.values()][0];
      assert.equal(connection.cancelled, false, 'Normal remote completion does not prematurely detach the response signal');
      if (mode === 'abort') abort.abort();
      else await sleep(150);
      assert.equal((await readSseEvent(reader)).choices[0].finish_reason, 'stop', 'Previously queued stop cannot be retracted');
      assert.equal((await readSseEvent(reader)).error.code, 'cancelled', 'No successful usage chunk after invalidation');
      assert.equal(await readSseEvent(reader), '[DONE]');
      assert.equal(await readSseEvent(reader), undefined);
      assert.equal(connection.cancelled, true);
    }
  }
});

test('auto, none and omitted choice keep ordinary text streaming and original registration/rules', async t => {
  for (const choice of [{}, { tool_choice: 'auto' }, { tool_choice: 'none' }]) {
    const mock = mockProtocol(c => c.send(textFrame('Still '), textFrame('streaming.'), doneFrame()));
    const events = await sse(await provider(t, mock).complete(body({ stream: true, ...choice }), A));
    assert.equal(events[0].choices[0].delta.role, 'assistant');
    assert.equal(events[1].choices[0].delta.content, 'Still ');
    assert.equal(events[2].choices[0].delta.content, 'streaming.');
    assert.equal(events.at(-2).choices[0].finish_reason, 'stop');
    const { rules } = assertRegistered(mock.appends[0], choice.tool_choice === 'none' ? [] : tools);
    assert.equal(rules.length, 1, 'No mandatory guidance for auto or none');
  }
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

test('login poll accepts unix-second expiry instead of treating it as already elapsed milliseconds', async t => {
  const futureSeconds = Math.floor(Date.now() / 1000) + 3600;
  const pastSeconds = Math.floor(Date.now() / 1000) - 60;
  const ok = provider(t, { fetchImpl: async () => Response.json({ ...A, expiresAt: futureSeconds }) });
  assert.deepEqual(await (await ok.startLogin()).wait, { ...A, expiresAt: futureSeconds * 1000 });
  const expired = provider(t, { fetchImpl: async () => Response.json({ ...A, expiresAt: pastSeconds }) });
  await assert.rejects((await expired.startLogin()).wait, e => e.code === 'expired_credential' && !e.message.includes(String(pastSeconds)));
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

const image = (url = `data:image/gif;base64,${gifBase64}`, extra = {}) => ({ type: 'image_url', image_url: { url, ...extra } });
const historical = () => [
  { role: 'user', content: 'Hi' },
  { role: 'assistant', content: 'OK', tool_calls: [{ id: 'c:1', type: 'function', function: { name: 'read', arguments: '{ "p":1 }' } }] },
  { role: 'tool', tool_call_id: 'c:1', content: 'yes', is_error: true },
];
const hex = bytes => Buffer.from(bytes).toString('hex');
function runAction(record) {
  const run = p.fields(p.one(record.message, 1));
  return { run, action: p.fields(p.one(p.fields(p.one(run, 2)), 1)) };
}

test('exact typed history wire fixture preserves native roles, call IDs, raw argument JSON and tool errors', async t => {
  const mock = mockProtocol(c => c.send(doneFrame()));
  const instance = provider(t, mock);
  const messages = [{ role: 'system', content: 'Policy' }, ...historical(), { role: 'developer', content: 'Instruction' }, { role: 'user', content: 'Next' }];
  assert.equal((await instance.complete(body({ messages }), A)).status, 200);
  const { run, action } = runAction(mock.appends[0]);
  assert.equal(hex(p.one(action, 7)), historyHex);
  assert.equal(p.text(p.one(p.fields(p.one(action, 1)), 1)), 'Next', 'Current user is not duplicated into history');
  const context = p.fields(p.one(action, 2)), rules = context.filter(f => f.id === 2);
  assert.equal(rules.length, 2);
  assert.equal(hex(rules[0].value), userRuleHex);
  assert.equal(p.text(p.one(p.fields(rules[1].value), 2)), 'Instruction');
  assert.equal(p.one(run, 8, 2, false), undefined);
  assert.deepEqual(run.map(f => f.id), [1, 2, 3, 4, 5], 'No internal harness/access fields');
  for (const { options } of mock.requests) {
    assert.ok(!Object.keys(options.headers).some(k => /allowed-tools|exclude-tools|team|harness/i.test(k)));
  }
});

test('fresh typed history supports multiple call IDs/results and keeps Unicode/raw JSON', async t => {
  const mock = mockProtocol(c => c.send(doneFrame()));
  const instance = provider(t, mock);
  const messages = historical();
  messages[1].tool_calls.push({ id: 'second:/中文', type: 'function', function: { name: toolName, arguments: JSON.stringify(args, null, 2) } });
  messages.push({ role: 'tool', tool_call_id: 'second:/中文', content: { result: '中文', zero: 0, nil: null } }, { role: 'user', content: 'Continue' });
  assert.equal((await instance.complete(body({ messages }), A)).status, 200);
  const history = p.fields(p.one(runAction(mock.appends[0]).action, 7));
  const assistant = p.fields(p.one(p.fields(history[1].value), 2));
  const call = p.fields(p.one(p.fields(assistant[2].value), 4));
  assert.equal(p.text(p.one(call, 1)), 'second:/中文');
  assert.equal(p.text(p.one(call, 3)), JSON.stringify(args, null, 2));
  const result = p.fields(p.one(p.fields(history[3].value), 3));
  assert.equal(p.text(p.one(result, 1)), 'second:/中文');
  assert.equal(p.text(p.one(result, 2)), toolName);
  assert.equal(p.text(p.one(p.fields(p.one(p.fields(p.one(result, 3)), 1)), 1)), JSON.stringify(messages[3].content));
});

test('malformed or ambiguous historical tool correlation fails before network', async t => {
  const instance = provider(t, { fetchImpl: () => assert.fail('No network') });
  const cases = [
    m => { m[1].tool_calls[0].function.arguments = '{invalid'; },
    m => { m[1].tool_calls.push(structuredClone(m[1].tool_calls[0])); },
    m => { m[2].tool_call_id = 'missing'; },
    m => { m[2].name = 'different'; },
    m => { m.splice(2, 1); },
    m => { m.splice(3, 0, structuredClone(m[2])); },
  ];
  for (const mutate of cases) {
    const messages = [...historical(), { role: 'user', content: 'Next' }];
    mutate(messages);
    assert.ok([400, 409].includes((await instance.complete(body({ messages }), A)).status));
  }
});

test('current inline image is exact SelectedContext/SelectedImage wire bytes, never fetched', async t => {
  const mock = mockProtocol(c => c.send(doneFrame()));
  const instance = provider(t, mock, { uuid: () => 'u' });
  const messages = [{ role: 'user', content: [{ type: 'text', text: 'Look' }, image()] }];
  assert.equal((await instance.complete(body({ messages }), A)).status, 200);
  const { action } = runAction(mock.appends[0]);
  assert.equal(hex(p.one(action, 1)), userImageHex);
  assert.equal(mock.requests.length, 2, 'Only RunSSE and BidiAppend');
});

test('historical user and tool images use typed base64 STRING and MIME, not URLs or blob references', async t => {
  const mock = mockProtocol(c => c.send(doneFrame()));
  const instance = provider(t, mock);
  const messages = historical();
  messages[0].content = [image()];
  messages[2].content = [image()];
  messages.push({ role: 'user', content: 'Next' });
  assert.equal((await instance.complete(body({ messages }), A)).status, 200);
  const history = p.fields(p.one(runAction(mock.appends[0]).action, 7));
  for (const [index, role, contentId] of [[0, 1, 1], [2, 3, 3]]) {
    const contents = p.fields(p.one(p.fields(history[index].value), role)).filter(f => f.id === contentId);
    const data = p.fields(p.one(p.fields(contents[0].value), 2));
    assert.equal(p.text(p.one(data, 1)), gifBase64);
    assert.equal(p.text(p.one(data, 2)), 'image/gif');
  }
});

test('inline image native result resumes original MCP exec with BYTES image data', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), (c, r) => { if (r.message[0].id === 5) c.send(doneFrame()); });
  const instance = provider(t, mock);
  const request = body(), first = await (await instance.complete(request, A)).json();
  assert.equal((await instance.complete(continuation(request, first.choices[0].message, [image()]), A)).status, 200);
  const exec = p.fields(p.one(mock.appends[1].message, 2));
  assert.equal(p.text(p.one(exec, 15)), 'original-exec-id');
  const success = p.fields(p.one(p.fields(p.one(exec, 11)), 1));
  const data = p.fields(p.one(p.fields(p.one(success, 1)), 2));
  assert.equal(hex(p.one(data, 1)), gifHex);
  assert.equal(p.text(p.one(data, 2)), 'image/gif');
  assert.equal(mock.connections.size, 1);
});

test('invalid image URLs/base64/signatures/unsupported detail and roles fail before network', async t => {
  const instance = provider(t, { fetchImpl: () => assert.fail('No fetch, including image fetch') });
  const bad = [image('https://example.invalid/image.png'), image('file:///never'), image('data:image/svg+xml;base64,PHN2Zz4='),
    image('data:image/gif;base64,%%%%'), image(`data:image/gif;base64,${gifBase64.slice(0, -1)}`),
    image('data:image/gif;base64,SGVsbG8='), image(`data:image/png;base64,${gifBase64}`),
    image(undefined, { detail: 'high' }), image(undefined, { detail: 'low' }), image(undefined, { crop: true }),
    { type: 'input_audio', input_audio: { data: 'AA==' } }];
  for (const part of bad) assert.equal((await instance.complete(body({ messages: [{ role: 'user', content: [part] }] }), A)).status, 400);
  for (const role of ['system', 'developer', 'assistant']) {
    assert.equal((await instance.complete(body({ messages: [{ role, content: [image()] }, { role: 'user', content: 'Next' }] }), A)).status, 400);
  }
  assert.equal((await instance.complete(body({ messages: [{ role: 'user', content: Array.from({ length: 33 }, () => image()) }] }), A)).status, 413);
  assert.equal((await instance.complete(body({ messages: [{ role: 'user', content: [image('data:image/gif;base64,' + 'A'.repeat(3 * 1024 * 1024))] }] }), A)).status, 413);
});

test('changing inline bytes cannot resume another transcript/account pending call', async t => {
  const mock = mockProtocol(c => c.send(execFrame()));
  const instance = provider(t, mock), request = body({ messages: [{ role: 'user', content: [image()] }] });
  const first = await (await instance.complete(request, A)).json(), next = continuation(request, first.choices[0].message);
  assert.equal((await instance.complete(next, B)).status, 409);
  const altered = structuredClone(next), data = Buffer.from(gifBase64, 'base64');
  data[13] = 17; // Another valid color table, same dimensions/MIME.
  altered.messages[0].content[0] = image('data:image/gif;base64,' + data.toString('base64'));
  assert.equal((await instance.complete(altered, A)).status, 409);
  assert.equal(mock.appends.length, 1);
});

const actualUsage = { prompt_tokens: 150, completion_tokens: 20, total_tokens: 170,
  prompt_tokens_details: { cached_tokens: 30, cache_write_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 5 } };
const usageFrame = () => Buffer.from(usageFrameHex, 'hex');
test('literal TurnEndedUpdate int64 usage fixture maps actual input/output/cache/reasoning once', async t => {
  const mock = mockProtocol(c => c.send(textFrame('ok'), usageFrame()));
  const result = await (await provider(t, mock).complete(body(), A)).json();
  assert.deepEqual(result.usage, actualUsage, 'Cache/reasoning counters are subsets, not added to totals');
});

test('include_usage SSE adds a choices-empty usage chunk before DONE; ordinary chunks are null', async t => {
  const wire = usageFrame(), mock = mockProtocol(c => c.send(textFrame('ok'), wire.slice(0, 8), wire.slice(8)));
  const events = await sse(await provider(t, mock).complete(body({ stream: true, stream_options: { include_usage: true } }), A));
  assert.deepEqual(events.at(-2).choices, []);
  assert.deepEqual(events.at(-2).usage, actualUsage);
  assert.equal(events.at(-3).choices[0].finish_reason, 'stop');
  assert.ok(events.slice(0, -2).every(e => e.usage === null));
});

test('usage is not sent on SSE unless include_usage is true', async t => {
  for (const stream_options of [undefined, { include_usage: false }]) {
    const mock = mockProtocol(c => c.send(usageFrame()));
    const events = await sse(await provider(t, mock).complete(body({ stream: true, ...(stream_options ? { stream_options } : {}) }), A));
    assert.ok(events.slice(0, -1).every(e => !Object.hasOwn(e, 'usage')));
  }
});

test('absent usage is unknown, including trailer completion and parked MCP intents', async t => {
  for (const frame of [doneFrame(), trailerFrame(0), execFrame()]) {
    const mock = mockProtocol(c => c.send(frame)), instance = provider(t, mock);
    const result = await (await instance.complete(body(), A)).json();
    assert.ok(!Object.hasOwn(result, 'usage'));
    const events = await sse(await instance.complete(body({ stream: true, model: 'another', stream_options: { include_usage: true } }), A));
    assert.deepEqual(events.at(-2).choices, []);
    assert.equal(events.at(-2).usage, null, 'Never fabricate zero counters');
  }
});

test('usage appears only when remote turn ends, not on tool pause, and may change include_usage on continuation', async t => {
  const mock = mockProtocol(c => c.send(execFrame()), (c, r) => { if (r.message[0].id === 5) c.send(usageFrame()); });
  const instance = provider(t, mock), request = body();
  const first = await (await instance.complete(request, A)).json();
  assert.equal(first.usage, undefined);
  const next = { ...continuation(request, first.choices[0].message), stream: true, stream_options: { include_usage: true } };
  const events = await sse(await instance.complete(next, A));
  assert.deepEqual(events.at(-2).usage, actualUsage);
  assert.equal(mock.connections.size, 1);
});

test('partial usage preserves field presence and explicit zero without invented totals/details', () => {
  assert.equal(p.turnUsage(p.empty), undefined);
  assert.deepEqual(p.turnUsage(Buffer.from('0800', 'hex')), { prompt_tokens: 0 });
  assert.deepEqual(p.turnUsage(Buffer.from('18002800', 'hex')), { prompt_tokens_details: { cached_tokens: 0 }, completion_tokens_details: { reasoning_tokens: 0 } });
  assert.deepEqual(p.turnUsage(Buffer.from('08001000', 'hex')), { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
});

test('malformed, negative, duplicate, unsafe or unknown usage never becomes success', async t => {
  const bad = ['08010802', '0a00', '08ffffffffffffffffff01', '088080808080808010', '08ffffffffffffff0f1001', '08', '3001'];
  for (const data of bad) {
    const mock = mockProtocol(c => c.send(p.envelope(p.bytes(1, p.bytes(14, Buffer.from(data, 'hex'))))));
    const response = await provider(t, mock).complete(body(), A);
    assert.equal(response.status, 502, data);
  }
});

test('include_usage does not convert an RPC failure into successful usage or finish', async t => {
  const mock = mockProtocol(c => c.send(textFrame('partial'), trailerFrame(8)));
  const events = await sse(await provider(t, mock).complete(body({ stream: true, stream_options: { include_usage: true } }), A));
  assert.equal(events.at(-2).error.code, 'quota_exceeded');
  assert.ok(!events.some(e => e.choices?.length === 0));
});

test('remote call cannot reuse a historical call ID', async t => {
  const mock = mockProtocol(c => c.send(execFrame({ callId: 'c:1' })));
  const response = await provider(t, mock).complete(body({ messages: [...historical(), { role: 'user', content: 'Next' }] }), A);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'duplicate_tool_call');
  assert.equal(mock.appends.length, 1, 'No historical tool is replayed');
});

test('arbitrary native structured tool arrays retain the prior JSON envelope in typed history', async t => {
  const mock = mockProtocol(c => c.send(doneFrame())), messages = historical();
  messages[2].content = [null, false, 0, 'text', { result: [1, 2] }];
  messages.push({ role: 'user', content: 'Next' });
  assert.equal((await provider(t, mock).complete(body({ messages }), A)).status, 200);
  const history = p.fields(p.one(runAction(mock.appends[0]).action, 7));
  const result = p.fields(p.one(p.fields(history[2].value), 3));
  const contents = p.fields(p.one(result, 3));
  assert.equal(p.text(p.one(p.fields(p.one(contents, 1)), 1)), JSON.stringify(messages[2].content));
});

test('multiple current PNG/GIF selections retain ordered raw bytes and distinct UUIDs', async t => {
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
  const mock = mockProtocol(c => c.send(doneFrame())), messages = [{ role: 'user', content: [image(`data:image/png;base64,${png}`, { detail: 'auto' }), image()] }];
  assert.equal((await provider(t, mock).complete(body({ messages }), A)).status, 200);
  const user = p.fields(p.one(runAction(mock.appends[0]).action, 1));
  const selections = p.fields(p.one(user, 3)).map(f => p.fields(f.value));
  assert.equal(selections.length, 2);
  assert.equal(p.text(p.one(selections[0], 7)), 'image/png');
  assert.equal(Buffer.from(p.one(selections[0], 8)).toString('base64'), png);
  assert.equal(hex(p.one(selections[1], 8)), gifHex);
  assert.notEqual(p.text(p.one(selections[0], 2)), p.text(p.one(selections[1], 2)));
});
