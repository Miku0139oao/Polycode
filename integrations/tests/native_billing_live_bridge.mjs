// Live permission lane only. Uses normal CredentialStore via runNative; never reads/copies auth files.
// No login/browser automation. All persisted evidence is fixed metadata, never credentials/bodies.
import { appendFileSync, readFileSync } from 'node:fs';
import { AsyncLocalStorage } from 'node:async_hooks';
import { runNative, parseArguments } from '../native-provider/launch.mjs';
import { createCodexProvider } from '../native-provider/codex.mjs';
import { createCursorProvider } from '../native-provider/cursor/index.mjs';

if (process.env.NATIVE_BILLING_LIVE_CONSENT !== 'yes') throw new Error('Explicit subscription consent required');
const providerId = process.env.NATIVE_BILLING_PROVIDER;
const testCase = process.env.NATIVE_BILLING_CASE;
if (!['codex', 'cursor'].includes(providerId) || !['tool_deny', 'tool_allow_once'].includes(testCase)) throw new Error('Invalid bounded live permission case');
const nonce = readFileSync(process.env.NATIVE_BILLING_NONCE_FILE, 'utf8').trim();
const record = value => appendFileSync(process.env.NATIVE_BILLING_EVENTS, JSON.stringify(value) + '\n', { mode: 0o600 });
const context = new AsyncLocalStorage();
let requestId = 0, wireRequests = 0;
const fetchImpl = async (url, options = {}) => {
  const parsed = new URL(url instanceof Request ? url.url : url);
  const state = context.getStore();
  // Exact official provider host; adapters own auth refresh/catalog protocol.
  const hosts = providerId === 'codex' ? ['chatgpt.com', 'auth.openai.com'] : ['api2.cursor.sh', 'api.cursor.com'];
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || !hosts.includes(parsed.hostname) || (parsed.port && parsed.port !== '443')) throw new Error('Non-official live endpoint refused');
  if (++wireRequests > 24) throw new Error('Bounded live HTTP request count exhausted');
  if (state) {
    const headers = new Headers(options.headers ?? (url instanceof Request ? url.headers : undefined));
    const matched = headers.get('authorization') === `Bearer ${state.accessToken}`;
    record({ kind: 'subscription_dispatch', request_id: state.id, provider: providerId, official_origin: parsed.origin,
             sent_credential_source: matched ? 'selected-provider-access-token' : 'unexpected' });
    if (!matched) throw new Error('Unexpected live dispatch credential');
  }
  // Redirect policy remains fail-closed; no alternate endpoints or fallback provider.
  const response = await fetch(url, { ...options, redirect: 'error' });
  if (state) record({ kind: 'subscription_http_response', request_id: state.id, provider: providerId, status: response.status });
  return response;
};
const base = providerId === 'codex' ? createCodexProvider({ fetchImpl }) : createCursorProvider({ fetchImpl });
let seenResult = false;
const provider = {
  ...base,
  async startLogin() { throw new Error('Parent owns OAuth; use a working normal store'); },
  async complete(body, credential, nativeContext) {
    const id = ++requestId;
    if (id > 12) throw new Error('Bounded live sampling count exhausted');
    const serialized = JSON.stringify(body);
    const credentialInPrompt = [credential.accessToken, credential.refreshToken].some(v => typeof v === 'string' && v.length > 16 && serialized.includes(v));
    const calls = (body.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []);
    const matched = (body.messages ?? []).filter(m => m.role === 'tool').flatMap(result => {
      const call = calls.find(c => c.id === result.tool_call_id && c.function?.name === 'use_tool');
      if (!call) return [];
      let input;
      try { input = JSON.parse(call.function.arguments); } catch { return []; }
      if (input.tool_name !== 'billing__probe' || Object.keys(input.tool_input ?? {}).length) return [];
      const text = JSON.stringify(result.content);
      const verified = testCase === 'tool_deny' ? /denied|rejected|not permitted|not allowed|declined/i.test(text) && !text.includes(nonce) : text.includes(nonce);
      return verified ? [result.tool_call_id] : [];
    });
    const verified = matched.length === 1;
    const interactive = (body.tools ?? []).length > 1;
    seenResult ||= verified;
    const nonceBefore = !seenResult && serialized.includes(nonce);
    record({ kind: 'subscription_request', request_id: id, provider: providerId,
             native_result_verified: interactive && verified, credential_in_prompt: credentialInPrompt, nonce_before_result: nonceBefore });
    if (credentialInPrompt || nonceBefore || matched.length > 1) throw new Error('Live evidence boundary failed');
    return context.run({ id, accessToken: credential.accessToken }, async () => {
      const response = await base.complete(body, credential, nativeContext);
      if (!interactive || !verified || !response.body) return response;
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '', stopped = false, doneFrame = false;
      const stream = new ReadableStream({
        async pull(controller) {
          try {
            const part = await context.run({ id, accessToken: credential.accessToken }, () => reader.read());
            buffer += part.done ? decoder.decode() : decoder.decode(part.value, { stream: true });
            if (buffer.length > 8 * 1024 * 1024) throw new Error('Oversized continuation frame');
            let end;
            while ((end = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
              for (const line of frame.split('\n').filter(s => s.startsWith('data:'))) {
                const raw = line.slice(5).trim();
                if (raw === '[DONE]') { doneFrame = true; continue; }
                const value = JSON.parse(raw);
                if (value.choices?.some(c => c.delta?.tool_calls?.length)) throw new Error('Provider retried after the single probe');
                stopped ||= value.choices?.some(c => c.finish_reason === 'stop') ?? false;
              }
            }
            if (part.done) {
              if (!stopped || !doneFrame || buffer.trim()) throw new Error('Incomplete live continuation');
              record({ kind: 'subscription_response', request_id: id, provider: providerId, continuation_response_completed: true });
              controller.close();
            } else controller.enqueue(part.value);
          } catch (error) { await reader.cancel().catch(() => {}); controller.error(error); }
        },
        async cancel() { await reader.cancel(); },
      });
      return new Response(stream, { status: response.status, headers: response.headers });
    });
  },
};
const { options, nativeArgs } = parseArguments(process.argv.slice(2));
runNative({ binary: options.binary, cwd: options.cwd, directory: options['auth-directory'], providers: { [providerId]: provider }, nativeArgs })
  .then(code => process.exit(code), () => { console.error('Live permission startup failed; details withheld'); process.exit(1); });
