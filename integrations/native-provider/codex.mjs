import { createServer } from 'node:http';
import { codexReasoningMetadata } from './model-settings.mjs';
import { codexFastMetadata } from './fast.mjs';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

// Public Codex OAuth flow, also used by OpenCode/Pi. No CLI credential extraction.
const CLIENT = 'app_EMoamEEZ73f0CkXaXp7hrann';
const ISSUER = 'https://auth.openai.com';
const CALLBACK = 'http://localhost:1455/auth/callback';
const API = 'https://chatgpt.com/backend-api/codex';
const cancelled = () => Object.assign(new Error('Login cancelled'), { name: 'AbortError' });
function credential(data) {
  if (typeof data.access_token !== 'string' || typeof data.refresh_token !== 'string' || !Number.isFinite(data.expires_in) || data.expires_in <= 0) throw new Error('Invalid OpenAI token response');
  let payload;
  try { payload = JSON.parse(Buffer.from(data.access_token.split('.')[1], 'base64url').toString()); } catch { throw new Error('Invalid OpenAI access token'); }
  const accountId = payload['https://api.openai.com/auth']?.chatgpt_account_id;
  if (typeof accountId !== 'string' || !accountId) throw new Error('ChatGPT subscription account is required');
  return { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + data.expires_in * 1000, accountId };
}
const headers = c => ({ Authorization: `Bearer ${c.accessToken}`, 'ChatGPT-Account-Id': c.accountId, originator: 'polycode', 'Content-Type': 'application/json' });
const text = content => typeof content === 'string' ? content : (content ?? []).filter(x => x.type === 'text').map(x => x.text).join('\n');
function contentParts(content, output = false) {
  if (typeof content === 'string') return [{ type: output ? 'output_text' : 'input_text', text: content }];
  return (content ?? []).map(part => {
    if (part.type === 'text') return { type: output ? 'output_text' : 'input_text', text: part.text };
    if (!output && part.type === 'image_url' && typeof part.image_url?.url === 'string') return { type: 'input_image', image_url: part.image_url.url, ...(part.image_url.detail ? { detail: part.image_url.detail } : {}) };
    throw new Error('Unsupported OpenAI message content');
  });
}
export function toResponses(body) {
  // The subscription endpoint does not implement the full public API option set.
  // Never silently discard explicit controls (notably output/spend limits).
  const unsupported = message => Object.assign(new Error(message), { status: 400 });
  for (const key of ['temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'max_output_tokens', 'stop', 'seed', 'frequency_penalty', 'presence_penalty', 'logit_bias', 'logprobs', 'top_logprobs', 'n']) {
    if (body[key] !== undefined && body[key] !== null) throw unsupported(`ChatGPT subscription transport does not support ${key}; remove this explicit option.`);
  }
  const allowed = new Set(['model', 'messages', 'tools', 'stream', 'stream_options', 'tool_choice', 'parallel_tool_calls', 'response_format', 'reasoning_effort', 'reasoning', 'service_tier']);
  if (body.service_tier != null && body.service_tier !== 'priority') throw unsupported('Unsupported ChatGPT service tier.');
  if (Object.keys(body).some(key => !allowed.has(key) && body[key] != null)) throw unsupported('Unsupported ChatGPT subscription request option.');
  if (body.reasoning_effort != null && body.reasoning?.effort != null && body.reasoning_effort !== body.reasoning.effort) throw unsupported('Conflicting ChatGPT reasoning effort options.');
  if (body.reasoning && Object.keys(body.reasoning).some(key => !['effort', 'summary'].includes(key))) throw unsupported('Unsupported ChatGPT reasoning option.');
  if (body.stream_options && Object.keys(body.stream_options).some(key => key !== 'include_usage')) throw unsupported('Unsupported ChatGPT stream option.');
  if (!Array.isArray(body.messages) || typeof body.model !== 'string' || !body.model) throw new Error('Model and messages are required');
  const names = new Map(), originals = new Map();
  for (const tool of body.tools ?? []) {
    const name = tool.function?.name;
    if (tool.type !== 'function' || typeof name !== 'string' || !name || names.has(name)) throw new Error('Invalid or duplicate function definition');
    const encoded = /^[a-zA-Z0-9_-]{1,64}$/.test(name) ? name : 'polycode_' + createHash('sha256').update(name).digest('hex').slice(0, 40);
    if (originals.has(encoded)) throw new Error('Conflicting function names');
    names.set(name, encoded); originals.set(encoded, name);
  }
  const input = [], instructions = [];
  for (const message of body.messages) {
    if (['system', 'developer'].includes(message.role)) { instructions.push(text(message.content)); continue; }
    if (message.role === 'tool') {
      if (!message.tool_call_id) throw new Error('Missing native tool call ID');
      input.push({ type: 'function_call_output', call_id: message.tool_call_id, output: typeof message.content === 'string' ? message.content : contentParts(message.content) });
    } else if (['user', 'assistant'].includes(message.role)) {
      if (message.content && (typeof message.content !== 'string' || message.content.length)) input.push({ type: 'message', role: message.role, content: contentParts(message.content, message.role === 'assistant') });
      for (const call of message.tool_calls ?? []) {
        if (!call.id || typeof call.function?.name !== 'string' || typeof call.function.arguments !== 'string') throw new Error('Invalid native tool history');
        input.push({ type: 'function_call', call_id: call.id, name: names.get(call.function.name) ?? call.function.name, arguments: call.function.arguments });
      }
    } else throw new Error('Unsupported conversation role');
  }
  let choice = body.tool_choice;
  if (choice && typeof choice === 'object') {
    const mapped = names.get(choice.function?.name); if (!mapped) throw new Error('Unknown requested tool');
    choice = { type: 'function', name: mapped };
  }
  const request = {
    model: body.model, input, instructions: instructions.join('\n\n'), stream: true, store: false,
    tools: (body.tools ?? []).map(t => ({ type: 'function', name: names.get(t.function.name), description: t.function.description ?? '', parameters: t.function.parameters ?? { type: 'object', properties: {} }, strict: t.function.strict ?? false })),
    ...(choice ? { tool_choice: choice } : {}),
    parallel_tool_calls: body.parallel_tool_calls ?? true,
    include: ['reasoning.encrypted_content'],
  };
  if (body.response_format) {
    const format = body.response_format;
    if (['text', 'json_object'].includes(format.type)) request.text = { format: { type: format.type } };
    else if (format.type === 'json_schema' && format.json_schema?.name && format.json_schema?.schema) request.text = { format: { ...format.json_schema, type: 'json_schema' } };
    else throw new Error('Unsupported structured response format');
  }
  if (body.service_tier === 'priority') request.service_tier = 'priority';
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  if (effort || body.reasoning?.summary) request.reasoning = { ...(effort ? { effort } : {}), summary: body.reasoning?.summary ?? 'auto' };
  return { request, originals };
}
async function* events(stream, signal) {
  const reader = stream.getReader(), decoder = new TextDecoder(); let buffer = '';
  const cancel = () => { reader.cancel().catch(() => {}); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  try {
    while (true) {
      const { value, done } = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
      buffer = buffer.replace(/\r\n/g, '\n');
      if (buffer.length > 8 * 1024 * 1024) throw new Error('Oversized provider frame');
      let end;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
        const data = frame.split('\n').filter(x => x.startsWith('data:')).map(x => x.slice(5).trimStart()).join('\n');
        if (data && data !== '[DONE]') yield JSON.parse(data);
      }
      if (done) break;
    }
    if (buffer.trim()) throw new Error('Truncated provider event');
  } finally { signal.removeEventListener('abort', cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
export async function translateResponses(response, body, originals) {
  if (!response.ok) {
    // Never include upstream auth response bodies in logs or errors.
    throw Object.assign(new Error(`ChatGPT request failed (HTTP ${response.status}); check login, quota and model access.`), { status: response.status });
  }
  if (!response.body) throw new Error('Missing provider stream');
  const id = 'chatcmpl-' + randomUUID(), created = Math.floor(Date.now() / 1000);
  const tools = new Map(); let content = '', reasoning = '', terminal = false, usage;
  let finishReason, textSeen = false, emittedBytes = 0;
  const abort = new AbortController();
  const base = { id, object: 'chat.completion.chunk', created, model: body.model };
  const chunk = (delta, finish_reason = null) => ({ ...base, choices: [{ index: 0, delta, finish_reason }] });
  async function* frames() {
      const queue = [];
      const emit = data => {
        const encoded = new TextEncoder().encode('data: ' + JSON.stringify(data) + '\n\n');
        emittedBytes += encoded.length;
        if (emittedBytes > 32 * 1024 * 1024) throw new Error('Provider output exceeded the response limit');
        finishReason = data.choices?.[0]?.finish_reason ?? finishReason;
        if (body.stream) queue.push(encoded);
      };
      const tool = (index, item) => {
        if (tools.has(index)) {
          const existing = tools.get(index);
          if (existing.id !== item.call_id || existing.name !== originals.get(item.name)) throw new Error('Provider changed a native tool identity');
          return existing;
        }
        const name = originals.get(item.name);
        if (!name || !item.call_id) throw new Error('Provider returned an undeclared native tool');
        const entry = { index: tools.size, id: item.call_id, name, arguments: '', argumentLength: 0, outputIndex: index };
        tools.set(index, entry);
        emit(chunk({ tool_calls: [{ index: entry.index, id: entry.id, type: 'function', function: { name, arguments: '' } }] }));
        return entry;
      };
      try {
        emit(chunk({ role: 'assistant' }));
        while (queue.length) yield queue.shift();
        for await (const event of events(response.body, abort.signal)) {
          if (event.type === 'response.output_text.delta') { textSeen ||= Boolean(event.delta); if (!body.stream) content += event.delta; emit(chunk({ content: event.delta })); }
          if (event.type === 'response.reasoning_summary_text.delta') { if (!body.stream) reasoning += event.delta; emit(chunk({ reasoning_content: event.delta })); }
          if (event.type === 'response.output_item.added' && event.item?.type === 'function_call') tool(event.output_index, event.item);
          if (event.type === 'response.function_call_arguments.delta') {
            const t = tools.get(event.output_index); if (!t) throw new Error('Tool arguments arrived without a declared call');
            t.argumentLength += event.delta.length; if (!body.stream) t.arguments += event.delta; emit(chunk({ tool_calls: [{ index: t.index, function: { arguments: event.delta } }] }));
          }
          if (event.type === 'response.output_item.done' && event.item?.type === 'function_call') {
            const t = tool(event.output_index, event.item);
            if (!t.argumentLength && event.item.arguments) { t.argumentLength = event.item.arguments.length; if (!body.stream) t.arguments = event.item.arguments; emit(chunk({ tool_calls: [{ index: t.index, function: { arguments: event.item.arguments } }] })); }
          }
          if (event.type === 'error' || event.type === 'response.failed') throw new Error('ChatGPT generation failed');
          if (['response.completed', 'response.incomplete', 'response.done'].includes(event.type)) {
            if (event.response?.status === 'failed') throw new Error('ChatGPT generation failed');
            for (const [index, item] of (event.response?.output ?? []).entries()) {
              if (item.type === 'function_call') {
                const t = tool(index, item);
                if (!t.argumentLength && item.arguments) { t.argumentLength = item.arguments.length; if (!body.stream) t.arguments = item.arguments; emit(chunk({ tool_calls: [{ index: t.index, function: { arguments: item.arguments } }] })); }
              }
            }
            if (!textSeen) {
              const finalText = (event.response?.output ?? []).filter(x => x.type === 'message').flatMap(x => x.content ?? []).filter(x => x.type === 'output_text').map(x => x.text).join('');
              if (finalText) { content = finalText; emit(chunk({ content })); }
            }
            const u = event.response?.usage;
            usage = u ? { prompt_tokens: u.input_tokens ?? 0, completion_tokens: u.output_tokens ?? 0, total_tokens: u.total_tokens ?? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) } : undefined;
            const finish = event.type === 'response.incomplete' ? 'length' : tools.size ? 'tool_calls' : 'stop';
            emit({ ...chunk({}, finish), ...(usage ? { usage } : {}) }); terminal = true; break;
          }
          while (queue.length) yield queue.shift();
        }
        if (!terminal) throw new Error('Provider stream ended without completion');
        while (queue.length) yield queue.shift();
        if (body.stream) yield new TextEncoder().encode('data: [DONE]\n\n');
      } finally { abort.abort(); }
  }
  const iterator = frames();
  const stream = new ReadableStream({
    async pull(controller) {
      try { const result = await iterator.next(); if (result.done) controller.close(); else controller.enqueue(result.value); }
      catch (e) { controller.error(e); }
    },
    async cancel() { abort.abort(); await iterator.return().catch(() => {}); if (!response.body.locked) await response.body.cancel().catch(() => {}); },
  });
  if (body.stream) return new Response(stream, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' } });
  // Drain even non-streaming completions so generation errors cannot become success.
  await new Response(stream).arrayBuffer();
  return Response.json({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(tools.size ? { tool_calls: [...tools.values()].map(t => ({ id: t.id, type: 'function', function: { name: t.name, arguments: t.arguments } })) } : {}) }, finish_reason: finishReason }], ...(usage ? { usage } : {}) });
}
export function createCodexProvider({ fetchImpl = fetch, httpFactory = createServer } = {}) {
  async function token(fields, signal) {
    const response = await fetchImpl(ISSUER + '/oauth/token', { redirect: 'error', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: CLIENT, ...fields }), signal });
    if (!response.ok) throw Object.assign(new Error(`OpenAI authorization failed (HTTP ${response.status})`), { code: 'upstream_http_error', status: response.status });
    return credential(await response.json());
  }
  return {
    async startLogin({ signal }) {
      const verifier = randomBytes(32).toString('base64url'), state = randomBytes(32).toString('hex');
      const challenge = createHash('sha256').update(verifier).digest('base64url');
      let accept, reject, settled = false;
      const wait = new Promise((a, b) => { accept = a; reject = b; }); wait.catch(() => {});
      const server = httpFactory(async (req, res) => {
        const url = new URL(req.url ?? '/', CALLBACK);
        if (req.method !== 'GET' || url.pathname !== '/auth/callback' || url.searchParams.get('state') !== state || settled) { res.writeHead(400); res.end('Invalid authorization callback.'); return; }
        if (url.searchParams.has('error')) { settled = true; res.writeHead(400); res.end('Authorization was denied. Return to Polycode to retry.'); reject(new Error('OpenAI authorization was denied')); server.close(); return; }
        if (!url.searchParams.get('code')) { res.writeHead(400); res.end('Authorization was not completed.'); return; }
        settled = true;
        try {
          const auth = await token({ grant_type: 'authorization_code', code: url.searchParams.get('code'), code_verifier: verifier, redirect_uri: CALLBACK }, signal);
          res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Polycode login completed. Return to the terminal.'); accept(auth);
        } catch (e) { res.writeHead(400); res.end('Authorization failed. Return to Polycode to retry.'); reject(e); }
        finally { server.close(); }
      });
      await new Promise((a, b) => { server.once('error', b); server.listen(1455, '127.0.0.1', a); });
      const abort = () => { settled = true; server.close(); reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
      wait.finally(() => signal.removeEventListener('abort', abort)).catch(() => {});
      const url = new URL(ISSUER + '/oauth/authorize');
      url.search = new URLSearchParams({ response_type: 'code', client_id: CLIENT, redirect_uri: CALLBACK, scope: 'openid profile email offline_access', code_challenge: challenge, code_challenge_method: 'S256', state, id_token_add_organizations: 'true', codex_cli_simplified_flow: 'true', originator: 'polycode' }).toString();
      return { url: url.href, instructions: 'Complete ChatGPT subscription authorization in your browser, then return to Polycode.', wait };
    },
    async refresh(c, { signal } = {}) {
      if (c.expiresAt > Date.now() + 60000) return c;
      return token({ grant_type: 'refresh_token', refresh_token: c.refreshToken }, signal);
    },
    async models(c, { signal } = {}) {
      const r = await fetchImpl(API + '/models?client_version=0.153.4', { redirect: 'error', headers: headers(c), signal });
      if (!r.ok) throw Object.assign(new Error(`ChatGPT model discovery failed (HTTP ${r.status})`), { code: 'upstream_http_error', status: r.status });
      const data = await r.json(), models = data.models ?? data.data;
      if (!Array.isArray(models)) throw new Error('Invalid ChatGPT model catalog');
      return models.filter(m => m.visibility !== 'hide').map(m => ({ id: m.slug ?? m.id ?? m.model, name: m.display_name ?? m.displayName ?? m.slug ?? m.id, contextWindow: m.context_window ?? m.contextWindow ?? 128000, ...codexReasoningMetadata(m), ...codexFastMetadata(m) }));
    },
    async complete(body, c, { signal } = {}) {
      const { request, originals } = toResponses(body);
      const response = await fetchImpl(API + '/responses', { redirect: 'error', method: 'POST', headers: { ...headers(c), Accept: 'text/event-stream' }, body: JSON.stringify(request), signal });
      return translateResponses(response, body, originals);
    },
    close() {},
  };
}
