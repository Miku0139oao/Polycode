import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { CursorProviderError, fail, safeError, checkSignal, onAbort, delay, errorBody } from './errors.mjs';
import { API, WEBSITE, Connection, headers, request, httpError, readJson } from './transport.mjs';
import { validateMessages } from './content.mjs';

export { CursorProviderError };
const invalid = () => fail('invalid_request', 'Invalid or unsupported Chat Completions request.', 400);
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function json(value, depth = 0) {
  if (depth > 64) throw invalid();
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(v => json(v, depth + 1)).join(',') + ']';
  if (object(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + json(value[k], depth + 1)).join(',') + '}';
  }
  throw invalid();
}
const hash = value => createHash('sha256').update(value).digest('hex');
function firstPositiveInt(...values) {
  for (const value of values) {
    if (Number.isSafeInteger(value) && value > 0) return value;
  }
  return null;
}
function token(value) {
  if (typeof value !== 'string' || !value.length || value.length > 65536 || /\s|[\x00-\x1f\x7f]/.test(value)) {
    throw fail('invalid_credential', 'Cursor credential is missing or malformed.', 401);
  }
  return value;
}
function expiryMillis(value) {
  if (!Number.isFinite(value) || value <= 0) throw fail('invalid_credential', 'Cursor expiry is malformed.', 401);
  // Poll/refresh may emit Unix seconds. Values below 1e12 cannot be millisecond
  // timestamps after 2001-09-09, so treat them as seconds rather than "already expired".
  return value < 1e12 ? value * 1000 : value;
}
function credential(value, now, allowExpired = false) {
  if (!object(value)) throw fail('invalid_credential', 'Cursor credential is missing or malformed.', 401);
  const result = { accessToken: token(value.accessToken) };
  if (value.refreshToken !== undefined) result.refreshToken = token(value.refreshToken);
  if (value.expiresAt !== undefined) {
    result.expiresAt = expiryMillis(value.expiresAt);
  } else {
    // exp is only an expiry hint, NOT signature/identity validation or an account-isolation key.
    try {
      const exp = JSON.parse(Buffer.from(result.accessToken.split('.')[1], 'base64url').toString()).exp;
      if (Number.isFinite(exp) && exp > 0) result.expiresAt = exp * 1000;
    } catch { /* Opaque access tokens are permitted by the reference protocol. */ }
  }
  if (!allowExpired && result.expiresAt !== undefined && result.expiresAt <= now) throw fail('expired_credential', 'Cursor credential has expired; refresh or sign in again.', 401);
  return result;
}
function validateBody(input) {
  const encoded = json(input);
  if (Buffer.byteLength(encoded) > 2 * 1024 * 1024) throw fail('size_limit', 'Chat request is too large.', 413);
  const body = JSON.parse(JSON.stringify(input)); // Isolate caller mutation without reordering user JSON.
  if (!object(body) || typeof body.model !== 'string' || !body.model.trim() || body.model.length > 512) throw invalid();
  const allowed = ['model', 'messages', 'tools', 'stream', 'stream_options', 'tool_choice', 'parallel_tool_calls'];
  if (Object.keys(body).some(k => !allowed.includes(k))) throw fail('unsupported_option', 'This experimental Cursor transport does not support that completion option.', 400);
  if (body.stream !== undefined && typeof body.stream !== 'boolean') throw invalid();
  if (body.stream_options !== undefined && (!object(body.stream_options) || Object.keys(body.stream_options).some(k => k !== 'include_usage') || ![true, false, undefined].includes(body.stream_options.include_usage))) throw invalid();
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean') throw invalid();
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 10000) throw invalid();
  validateMessages(body.messages);
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 512)) throw invalid();
  const names = new Set();
  for (const tool of body.tools ?? []) {
    const f = tool?.function;
    if (tool?.type !== 'function' || !object(f) || typeof f.name !== 'string' || !f.name || f.name.length > 512 || names.has(f.name)) throw invalid();
    if (f.description !== undefined && typeof f.description !== 'string') throw invalid();
    if (f.parameters !== undefined && !object(f.parameters)) throw invalid();
    if (f.strict !== undefined && f.strict !== false) throw fail('unsupported_option', 'Strict function schema enforcement is unavailable in Cursor MCP transport.', 400);
    names.add(f.name);
  }
  const choice = body.tool_choice;
  if (choice !== undefined && !['auto', 'none', 'required'].includes(choice)) {
    if (!object(choice) || Object.keys(choice).some(k => !['type', 'function'].includes(k)) || choice.type !== 'function' ||
        !object(choice.function) || Object.keys(choice.function).some(k => k !== 'name') ||
        typeof choice.function.name !== 'string' || !names.has(choice.function.name)) throw invalid();
  }
  if (choice === 'required' && !names.size) throw invalid();
  return body;
}
const requiresTool = body => body.tool_choice === 'required' || object(body.tool_choice);
function permittedTools(body) {
  if (body.tool_choice === 'none') return [];
  const tools = body.tools ?? [];
  return object(body.tool_choice) ? tools.filter(t => t.function.name === body.tool_choice.function.name) : tools;
}
function remoteBody(body) {
  // Local enforcement only: no proprietary tool_choice field or restricted headers.
  const { tool_choice, ...remote } = body;
  remote.tools = permittedTools(body);
  if (requiresTool(body)) {
    const selection = object(tool_choice)
      ? `request the supplied MCP tool with exact native name ${JSON.stringify(tool_choice.function.name)}`
      : 'request at least one of the supplied MCP tools';
    // Existing system/developer mapping encodes this as an ordinary USER rule, not a privileged prompt.
    // Leave the caller's transcript/config untouched for exact native continuation correlation.
    const rule = { role: 'system', content: `For each assistant response, including after a native tool result, ${selection} before completing. `
      + 'Text alone does not satisfy this request. Emit an MCP tool intent; Polycode alone handles execution and permissions.' };
    remote.messages = [...body.messages.slice(0, -1), rule, body.messages.at(-1)];
  }
  return remote;
}
function configKey(body) {
  const { messages, stream, stream_options, ...config } = body;
  return hash(json(config));
}
function assistantMatches(actual, expected, model) {
  // Native engines may omit content:null or use "". All actual tool fields must match.
  if (!actual || actual.role !== 'assistant' || (actual.content ?? '') !== (expected.content ?? '')) return false;
  // Native transcript storage annotates assistant messages with their source
  // model. Accept that exact identity only; it cannot select another session.
  if (Object.hasOwn(actual, 'model_id') && actual.model_id !== model) return false;
  if (Object.keys(actual).some(key => !['role', 'content', 'tool_calls', 'model_id'].includes(key))) return false;
  return json(actual.tool_calls ?? []) === json(expected.tool_calls ?? []);
}
const responseJSON = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** All state is per factory. Parent owns credential persistence/browser/agent/tools. */
export function createCursorProvider({
  fetchImpl = globalThis.fetch,
  uuid = randomUUID,
  randomBytesImpl = randomBytes,
  now = Date.now,
  sleepImpl = delay,
  pollIntervalMs = 1000,
  maxPollAttempts = 150,
  loginTimeoutMs = 10 * 60 * 1000,
  requestTimeoutMs = 30000,
  sessionTtlMs = 2 * 60 * 1000, // Remote-reader idle/backpressure timeout, not native execution time.
  parkedToolTimeoutMs = 10 * 60 * 60 * 1000 + 5 * 60 * 1000, // Native tools allow 10h; reserve 5m for result delivery.
  maxSessionMs = 24 * 60 * 60 * 1000, // Hard abandonment bound across all tool rounds.
  maxSessions = 16,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  if (typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') throw invalid();
  for (const n of [pollIntervalMs, maxPollAttempts, loginTimeoutMs, requestTimeoutMs, sessionTtlMs, parkedToolTimeoutMs, maxSessionMs, maxSessions]) {
    if (!Number.isSafeInteger(n) || n <= 0 || n > 2147483647) throw invalid();
  }
  let closed = false;
  const operations = new Set();
  const sessions = new Set();
  function live(signal) {
    if (closed) throw fail('provider_closed', 'Cursor provider is closed.', 503);
    checkSignal(signal);
  }
  function operation(signal, timeoutMs) {
    live(signal);
    const controller = new AbortController();
    const off = onAbort(signal, () => controller.abort());
    const timer = setTimeoutImpl(() => controller.abort(), timeoutMs);
    operations.add(controller);
    return { controller, signal: controller.signal, finish() { clearTimeoutImpl(timer); off(); operations.delete(controller); } };
  }
  function drop(session) {
    clearTimeoutImpl(session.timer);
    clearTimeoutImpl(session.maxTimer);
    session.off?.();
    sessions.delete(session);
    session.controller.abort();
    session.connection?.close();
    session.base = undefined;
    session.expected = undefined;
  }
  function touch(session, timeoutMs = sessionTtlMs) {
    clearTimeoutImpl(session.timer);
    session.timer = setTimeoutImpl(() => drop(session), timeoutMs);
    session.timer.unref?.();
  }
  async function authResult(response, signal, oldRefresh) {
    if (response.status !== 200) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
    const result = await readJson(response, signal);
    const valid = credential(result, now());
    if (!valid.refreshToken && oldRefresh) valid.refreshToken = oldRefresh;
    return valid;
  }
  async function startLogin({ signal } = {}) {
    const op = operation(signal, loginTimeoutMs);
    const verifier = Buffer.from(randomBytesImpl(32)).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    const id = uuid();
    const url = new URL('/loginDeepControl', WEBSITE);
    url.search = new URLSearchParams({ challenge, uuid: id, mode: 'login', redirectTarget: 'cli' }).toString();
    const wait = (async () => {
      try {
        for (let attempt = 0; attempt < maxPollAttempts; attempt++) {
          const poll = new URL('/auth/poll', API);
          poll.search = new URLSearchParams({ uuid: id, verifier }).toString();
          const response = await request(fetchImpl, poll.href, { headers: { 'content-type': 'application/json' }, signal: op.signal });
          if (response.status !== 404) return await authResult(response, op.signal);
          void response.body?.cancel().catch(() => {});
          if (attempt + 1 < maxPollAttempts) await sleepImpl(Math.min(pollIntervalMs * 1.2 ** attempt, 10000), op.signal);
        }
        throw fail('login_timeout', 'Cursor sign-in did not complete in time.', 408);
      } catch (e) { throw safeError(e); } finally { op.finish(); }
    })();
    void wait.catch(() => {}); // TUI may open URL before attaching to wait; preserve rejection for caller.
    return { url: url.href, instructions: 'Open this official Cursor URL and finish sign-in. Polycode will wait for authorization; cancel to stop.', wait };
  }
  async function refresh(input, { signal } = {}) {
    live(signal);
    const old = credential(input, now(), true);
    // A still-valid access token needs no refresh, including poll responses
    // without a refresh token. Unknown expiry must not rotate: a new
    // accessToken hash cannot resume a parked tool call (409).
    if (old.expiresAt === undefined || old.expiresAt > now() + 60000) return old;
    if (!old.refreshToken) throw fail('refresh_unavailable', 'No Cursor refresh token; sign in again.', 401);
    const op = operation(signal, requestTimeoutMs);
    try {
      const response = await request(fetchImpl, `${API}/auth/refresh`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${old.refreshToken}` }, body: '{}', signal: op.signal,
      });
      return await authResult(response, op.signal, old.refreshToken);
    } catch (e) { throw safeError(e); } finally { op.finish(); }
  }
  async function models(input, { signal } = {}) {
    live(signal);
    const c = credential(input, now());
    const op = operation(signal, requestTimeoutMs);
    try {
      const response = await request(fetchImpl, `${API}/aiserver.v1.AiService/GetUsableModels`, {
        method: 'POST', headers: { ...headers(c.accessToken, uuid(), now()), 'content-type': 'application/json', accept: 'application/json', 'connect-protocol-version': '1' }, body: '{}', signal: op.signal,
      });
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
      const result = await readJson(response, op.signal);
      if (!Array.isArray(result?.models)) throw fail('invalid_models', 'Cursor returned an invalid model catalog.');
      const catalog = new Map();
      for (const item of result.models) {
        if (typeof item?.modelId !== 'string' || !item.modelId) throw fail('invalid_models', 'Cursor model catalog is missing a canonical model ID.');
        const name = item.displayName ?? item.modelId;
        const contextWindow = firstPositiveInt(
          item.contextWindow, item.context_window, item.contextTokenLimit, item.context_token_limit,
        ); // Unknown means unknown: no guessed 200k/1M sizes.
        if (typeof name !== 'string' || !name || (contextWindow !== null && (!Number.isSafeInteger(contextWindow) || contextWindow <= 0))) throw fail('invalid_models', 'Cursor returned invalid model metadata.');
        const model = { id: item.modelId, name, contextWindow };
        if (catalog.has(model.id) && json(catalog.get(model.id)) !== json(model)) throw fail('invalid_models', 'Cursor returned conflicting model IDs.');
        catalog.set(model.id, model);
      }
      return [...catalog.values()];
    } catch (e) { throw safeError(e); } finally { op.finish(); }
  }

  async function prepare(body, c, signal) {
    const account = hash(c.accessToken), config = configKey(body), base = json(body.messages);
    const last = body.messages.at(-1);
    let session;
    if (last.role === 'tool') {
      const prefix = json(body.messages.slice(0, -2));
      // Establish unique ownership before configuration: a changed choice/model must not select
      // another parked connection whose backend happened to reuse the exact assistant call.
      const matches = [...sessions].filter(s => s.account === account && s.base === prefix && s.expected && assistantMatches(body.messages.at(-2), s.expected, body.model) && last.tool_call_id === s.pending.toolCallId);
      if (matches.length !== 1 || matches[0].config !== config) {
        // Diagnostic candidates never authorize submission or select a connection.
        const pending = [...sessions].filter(s => s.account === account && s.pending?.toolCallId === last.tool_call_id);
        const reason = matches.length > 1 || pending.length > 1 ? 'Multiple live Cursor calls match this result.'
          : pending.length === 0 ? 'No live Cursor call owns this result; the turn may have expired or been closed.'
          : pending[0].config !== config ? 'Cursor configuration changed while a native tool call was pending.'
          : pending[0].base !== prefix ? 'Cursor transcript changed while a native tool call was pending (for example, compaction or context injection).'
          : 'The native assistant message differs from the pending Cursor call.';
        throw fail('continuation_mismatch', `${reason} Do not replay; restart explicitly.`, 409);
      }
      session = matches[0];
      if (session.busy) throw fail('session_busy', 'Cursor continuation is already in progress.', 409);
      session.busy = true; // Reserve before the first await; duplicate results can never be submitted twice.
    } else {
      if (last.role !== 'user') throw invalid();
      if ([...sessions].some(s => s.account === account && s.config === config && s.base === base)) throw fail('session_busy', 'This Cursor transcript already has an active or pending turn.', 409);
      if (sessions.size >= maxSessions) throw fail('session_limit', 'Cursor session limit reached; finish or close existing sessions.', 429);
      session = { account, config, base, busy: true, controller: new AbortController(),
        seen: new Set(body.messages.flatMap(m => (m.tool_calls ?? []).map(c => c.id))) };
      sessions.add(session);
      session.maxTimer = setTimeoutImpl(() => drop(session), maxSessionMs);
      session.maxTimer.unref?.();
    }
    session.off = onAbort(signal, () => drop(session));
    touch(session);
    try {
      if (last.role === 'tool') {
        if (last.name !== undefined && last.name !== session.pending.toolName) throw fail('continuation_mismatch', 'Native tool result name does not match the pending Cursor call.', 409);
        await session.connection.submit(session.pending, last);
        session.base = base;
        session.pending = undefined;
        session.expected = undefined;
      } else {
        // Apply the same permitted subset at registration and at the incoming exec boundary.
        session.connection = new Connection({ fetchImpl, token: c.accessToken, body: remoteBody(body), uuid, now, controller: session.controller });
        await session.connection.open();
      }
      checkSignal(session.controller.signal);
      return session;
    } catch (e) { drop(session); throw safeError(e); }
  }
  async function* turn(session, body) {
    let content = '';
    const names = new Set(permittedTools(body).map(t => t.function.name));
    const mustCall = requiresTool(body); // Per completion request, not satisfied by a previous parked call.
    try {
      while (true) {
        checkSignal(session.controller.signal);
        const result = await session.connection.iterator.next();
        checkSignal(session.controller.signal);
        if (result.done) throw fail('unexpected_eof', 'Cursor stream ended unexpectedly.');
        const event = result.value;
        touch(session);
        if (event.type === 'text') {
          content += event.text;
          if (Buffer.byteLength(content) > 4 * 1024 * 1024) throw fail('size_limit', 'Cursor completion is too large.');
          // Mandatory choices cannot leak text-only success before a permitted intent is observed.
          if (!mustCall) yield { delta: { content: event.text } };
        } else if (event.type === 'tool') {
          const exec = event.exec;
          if (!names.has(exec.toolName)) throw fail('unregistered_tool', 'Cursor requested a tool not permitted by the native engine tool definitions/choice; denied.', 502);
          if (session.seen.has(exec.toolCallId)) throw fail('duplicate_tool_call', 'Cursor reused a tool call ID; denied.');
          if (session.seen.size >= 1024) throw fail('size_limit', 'Cursor tool call limit exceeded.');
          session.seen.add(exec.toolCallId);
          const call = { id: exec.toolCallId, type: 'function', function: { name: exec.toolName, arguments: JSON.stringify(exec.args) } };
          session.pending = exec;
          session.expected = { role: 'assistant', content: content || null, tool_calls: [call] };
          if (mustCall && content) yield { delta: { content } };
          // Each yield can suspend behind HTTP backpressure while cancellation/TTL drops the session.
          checkSignal(session.controller.signal);
          yield { delta: { tool_calls: [{ index: 0, ...call }] } };
          checkSignal(session.controller.signal);
          yield { finish_reason: 'tool_calls' };
          checkSignal(session.controller.signal);
          return; // Do not close/return the remote iterator. It remains parked on this exact exec.
        } else if (event.type === 'done') {
          if (mustCall) throw fail('tool_choice_unfulfilled', 'Cursor completed without the required native tool intent; denied.');
          // Normal cleanup waits for response release, so abort remains distinguishable from success.
          yield { finish_reason: 'stop', usage: event.usage };
          checkSignal(session.controller.signal);
          return;
        }
      }
    } catch (e) { drop(session); throw safeError(e); }
  }
  async function complete(input, inputCredential, { signal } = {}) {
    let session;
    try {
      live(signal);
      const body = validateBody(input);
      const c = credential(inputCredential, now());
      session = await prepare(body, c, signal);
      const id = `chatcmpl-${uuid()}`, created = Math.floor(now() / 1000);
      const iterator = turn(session, body);
      function release() {
        session.busy = false;
        // A completed HTTP response no longer owns cancellation of a parked remote turn.
        session.off?.(); session.off = undefined;
        if (sessions.has(session)) {
          if (session.pending) touch(session, parkedToolTimeoutMs);
          else drop(session); // A remote text completion no longer needs its connection.
        }
      }
      if (!body.stream) {
        let content = '', calls, finishReason, usage;
        for await (const part of iterator) {
          if (part.delta?.content) content += part.delta.content;
          if (part.delta?.tool_calls) calls = part.delta.tool_calls.map(({ index, ...call }) => call);
          if (part.finish_reason) finishReason = part.finish_reason;
          if (part.usage !== undefined) usage = part.usage;
        }
        checkSignal(session.controller.signal);
        release();
        return responseJSON({ id, object: 'chat.completion', created, model: body.model, choices: [{ index: 0, message: { role: 'assistant', content: content || null, ...(calls ? { tool_calls: calls } : {}) }, finish_reason: finishReason }], ...(usage === undefined ? {} : { usage }) });
      }
      const encoder = new TextEncoder();
      const includeUsage = body.stream_options?.include_usage === true;
      const chunk = (delta, finish_reason = null) => ({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [{ index: 0, delta, finish_reason }], ...(includeUsage ? { usage: null } : {}) });
      let started = false, terminal = false, usage;
      const stream = new ReadableStream({
        async pull(controller) {
          if (terminal) return;
          const emit = value => controller.enqueue(encoder.encode(`data: ${typeof value === 'string' ? value : JSON.stringify(value)}\n\n`));
          try {
            checkSignal(session.controller.signal);
            // Even the initial role chunk waits for a permitted intent when a tool is mandatory.
            if (!started && !requiresTool(body)) { started = true; emit(chunk({ role: 'assistant' })); return; }
            const { value, done } = await iterator.next();
            checkSignal(session.controller.signal); // Also guards successful usage/DONE after generator completion.
            if (!started) { started = true; emit(chunk({ role: 'assistant' })); }
            if (done) {
              terminal = true;
              if (includeUsage) emit({ ...chunk({}), choices: [], usage: usage ?? null });
              emit('[DONE]');
              controller.close();
              release();
            } else {
              if (value.usage !== undefined) usage = value.usage;
              emit(chunk(value.delta ?? {}, value.finish_reason ?? null));
            }
          } catch (e) {
            terminal = true;
            drop(session);
            try { emit(errorBody(e)); emit('[DONE]'); controller.close(); } catch { /* Response was cancelled. */ }
          }
        },
        cancel() {
          terminal = true;
          drop(session);
          void iterator.return().catch(() => {});
        },
      });
      return new Response(stream, { headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' } });
    } catch (e) {
      if (session) drop(session);
      const error = safeError(e);
      return responseJSON(errorBody(error), error.status);
    }
  }
  function close() {
    if (closed) return;
    closed = true;
    for (const op of operations) op.abort();
    operations.clear();
    for (const session of [...sessions]) drop(session);
  }
  return { startLogin, refresh, models, complete, close };
}
export default createCursorProvider;
