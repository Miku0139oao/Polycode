// Real subscription transport instrumented with metadata-only native-tool evidence.
// No credential values, OAuth URLs, message bodies, or provider response bodies are logged.
import { readFileSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { runNative, parseArguments } from '../native-provider/launch.mjs';
import { createCodexProvider } from '../native-provider/codex.mjs';
import { createCursorProvider } from '../native-provider/cursor/index.mjs';

if (process.env.POLYCODE_LIVE_USAGE_CONSENT !== 'yes') throw new Error('Explicit live subscription usage consent required');
const { options, nativeArgs } = parseArguments(process.argv.slice(2));
const nonces = Object.fromEntries(['codex', 'cursor'].map(id => [id, readFileSync(join(process.env.POLYCODE_LIVE_FIXTURE, `native-live-${id}.txt`), 'utf8').trim()]));
const observedResult = new Set();
const events = process.env.POLYCODE_LIVE_EVENTS;
const record = data => appendFileSync(events, JSON.stringify(data) + '\n', { mode: 0o600 });
const providers = Object.fromEntries(Object.entries({ codex: createCodexProvider(), cursor: createCursorProvider() }).map(([id, provider]) => [id, {
  ...provider,
  async complete(body, credential, context) {
    const nonce = nonces[id];
    const results = (body.messages ?? []).filter(m => m.role === 'tool' && JSON.stringify(m.content).includes(nonce));
    const calls = (body.messages ?? []).filter(m => m.role === 'assistant').flatMap(m => m.tool_calls ?? []);
    const matched = results.map(result => calls.find(call => call.id === result.tool_call_id)).filter(Boolean);
    const verified = matched.some(call => /read/i.test(call.function?.name ?? ''));
    if (verified) observedResult.add(id);
    const serialized = JSON.stringify(body);
    const credentialInPrompt = [credential.accessToken, credential.refreshToken].some(value => typeof value === 'string' && value.length > 16 && serialized.includes(value));
    record({ provider: id, model: body.model, nativeResultVerified: verified, resultToolNames: matched.map(call => call.function?.name), nonceBeforeResult: !observedResult.has(id) && serialized.includes(nonce), credentialInPrompt });
    if (credentialInPrompt) throw new Error('Credential unexpectedly present in native prompt; live verification stopped');
    return provider.complete(body, credential, context);
  },
}]));
runNative({ binary: options.binary, cwd: options.cwd, directory: options['auth-directory'], providers, nativeArgs })
  .then(code => process.exit(code), () => { console.error('Live native startup failed (details intentionally withheld)'); process.exit(1); });
