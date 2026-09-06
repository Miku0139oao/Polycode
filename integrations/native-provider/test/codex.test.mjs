import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createCodexProvider, toResponses, translateResponses } from '../codex.mjs';
const schema = { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] };
const body = { model: 'test-model', stream: false, messages: [{ role: 'system', content: 'Native Grok engine' }, { role: 'user', content: 'test' }], tools: [{ type: 'function', function: { name: 'native.shell/tool', parameters: schema } }] };
const sse = events => new Response(events.map(e => 'data: ' + JSON.stringify(e) + '\n\n').join(''), { headers: { 'Content-Type': 'text/event-stream' } });
test('native tools and tool results survive Chat Completions to Responses mapping', () => {
  const b = structuredClone(body);
  b.messages.push({ role: 'assistant', content: null, tool_calls: [{ id: 'native-call', type: 'function', function: { name: 'native.shell/tool', arguments: '{"command":"pwd"}' } }] }, { role: 'tool', tool_call_id: 'native-call', content: '/workspace' });
  const { request, originals } = toResponses(b);
  assert.equal(request.instructions, 'Native Grok engine'); assert.equal(request.store, false);
  assert.deepEqual(request.tools[0].parameters, schema);
  assert.equal(originals.get(request.tools[0].name), 'native.shell/tool');
  assert.equal(request.input[1].name, request.tools[0].name);
  assert.deepEqual(request.input[2], { type: 'function_call_output', call_id: 'native-call', output: '/workspace' });
  assert.equal(request.input[1].call_id, 'native-call');
});
test('streamed tool intent is returned to native Grok with original name, never executed', async () => {
  const { request, originals } = toResponses(body);
  const events = [{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', call_id: 'call-a', name: request.tools[0].name } }, { type: 'response.function_call_arguments.delta', output_index: 0, delta: '{"command":"pwd"}' }, { type: 'response.completed', response: { output: [], usage: { input_tokens: 10, output_tokens: 5 } } }];
  const response = await translateResponses(sse(events), body, originals), data = await response.json();
  assert.equal(data.choices[0].finish_reason, 'tool_calls');
  assert.deepEqual(data.choices[0].message.tool_calls, [{ id: 'call-a', type: 'function', function: { name: 'native.shell/tool', arguments: '{"command":"pwd"}' } }]);
  assert.equal(data.usage.total_tokens, 15);
});
test('provider failures and undeclared functions never become successful completions', async () => {
  await assert.rejects(() => translateResponses(sse([{ type: 'response.output_text.delta', delta: 'partial' }]), body, new Map()), /without completion/);
  await assert.rejects(() => translateResponses(sse([{ type: 'response.output_item.added', output_index: 0, item: { type: 'function_call', name: 'unknown', call_id: 'x' } }]), body, new Map()), /undeclared/);
  await assert.rejects(() => translateResponses(new Response('private upstream details', { status: 429 }), body, new Map()), /HTTP 429/);
});
test('stream preserves text, reasoning and stop marker', async () => {
  const response = await translateResponses(sse([{ type: 'response.reasoning_summary_text.delta', delta: 'summary' }, { type: 'response.output_text.delta', delta: 'answer' }, { type: 'response.completed', response: { output: [] } }]), { ...body, stream: true }, new Map());
  const output = await response.text(); assert.match(output, /answer/); assert.match(output, /reasoning_content/); assert.match(output, /\[DONE\]/);
});
test('browser OAuth validates state and stores only successful own-flow credentials', async () => {
  let server, exchanged = false;
  const payload = Buffer.from(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'test-account' } })).toString('base64url');
  const provider = createCodexProvider({ httpFactory: handler => {
    server = createServer(handler); const listen = server.listen.bind(server); server.listen = (_port, host, cb) => listen(0, host, cb); return server;
  }, fetchImpl: async (url, opts) => {
    assert.equal(url, 'https://auth.openai.com/oauth/token'); assert.equal(opts.body.get('code'), 'fixture-code'); assert.ok(opts.body.get('code_verifier')); exchanged = true;
    return Response.json({ access_token: 'header.' + payload + '.test', refresh_token: 'test-refresh', expires_in: 3600 });
  } });
  const controller = new AbortController();
  const flow = await provider.startLogin({ signal: controller.signal }); const url = new URL(flow.url);
  const callback = `http://127.0.0.1:${server.address().port}/auth/callback`;
  assert.equal((await fetch(callback + '?state=wrong&code=fixture-code')).status, 400); assert.equal(exchanged, false);
  assert.equal((await fetch(callback + '?state=' + url.searchParams.get('state') + '&code=fixture-code')).status, 200);
  assert.equal((await flow.wait).accountId, 'test-account');
});
test('OAuth cancellation closes callback without token exchange', async () => {
  let server;
  const provider = createCodexProvider({ httpFactory: handler => { server = createServer(handler); const listen = server.listen.bind(server); server.listen = (_port, host, cb) => listen(0, host, cb); return server; }, fetchImpl: () => assert.fail('Must not exchange') });
  const controller = new AbortController(), flow = await provider.startLogin({ signal: controller.signal }); controller.abort();
  await assert.rejects(flow.wait, /cancelled/);
});
test('OAuth denial terminates only a matching-state attempt', async () => {
  let server;
  const provider = createCodexProvider({ httpFactory: handler => { server = createServer(handler); const listen = server.listen.bind(server); server.listen = (_port, host, cb) => listen(0, host, cb); return server; }, fetchImpl: () => assert.fail('Must not exchange a denied authorization') });
  const flow = await provider.startLogin({ signal: new AbortController().signal });
  const root = 'http://127.0.0.1:' + server.address().port + '/auth/callback?error=access_denied&state=';
  await fetch(root + 'wrong'); assert.equal(server.listening, true);
  await fetch(root + new URL(flow.url).searchParams.get('state'));
  await assert.rejects(flow.wait, /denied/); assert.equal(server.listening, false);
});
test('unread translation bounds upstream consumption and cancels before first event', async () => {
  let pulls = 0, cancelled = false;
  const upstream = new ReadableStream({ pull(controller) { pulls++; controller.enqueue(new TextEncoder().encode('data: {"type":"response.output_text.delta","delta":"x"}\n\n')); }, cancel() { cancelled = true; } });
  const result = await translateResponses(new Response(upstream), { model: 'test', stream: true }, new Map());
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(pulls <= 2, 'must not eagerly read the generation');
  await result.body.cancel(); assert.equal(cancelled, true); assert.equal(upstream.locked, false);
});
test('translation cancellation unblocks and releases its owned upstream reader', { timeout: 2000 }, async () => {
  let cancelled = false;
  const upstream = new ReadableStream({ cancel() { cancelled = true; } });
  const result = await translateResponses(new Response(upstream), { model: 'test', stream: true }, new Map());
  const reader = result.body.getReader(); await reader.read();
  const pending = reader.read(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(upstream.locked, true);
  await reader.cancel(); await pending;
  assert.equal(cancelled, true); assert.equal(upstream.locked, false);
});
