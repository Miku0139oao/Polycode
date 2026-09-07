// Auth-only real-provider probe. No model inference, credential values, or OAuth URLs in evidence.
import { appendFileSync } from 'node:fs';
import { runNative } from '../native-provider/launch.mjs';
import { createCursorProvider } from '../native-provider/cursor/index.mjs';
const [binary, cwd, directory, events] = process.argv.slice(2);
if (process.env.POLYCODE_AUTH_PROBE_CONSENT !== 'yes' || ![binary, cwd, directory, events].every(Boolean)) {
  throw new Error('Explicit auth-only probe consent and paths required');
}
const emit = event => appendFileSync(events, JSON.stringify(event) + '\n', { mode: 0o600 });
const codes = new Set(['authentication_error', 'invalid_credential', 'expired_credential',
  'invalid_response', 'size_limit', 'transport_error', 'login_timeout', 'cancelled',
  'quota_exceeded', 'upstream_http_error']);
const safeCode = e => codes.has(e?.code) ? e.code : 'unclassified_error';
const provider = createCursorProvider({
  async fetchImpl(url, options) {
    const parsed = new URL(url);
    const path = ['/auth/poll', '/auth/refresh', '/aiserver.v1.AiService/GetUsableModels'].includes(parsed.pathname)
      ? parsed.pathname : 'other';
    try {
      const response = await fetch(url, options);
      emit({ phase: 'http', path, status: response.status });
      return response;
    } catch (error) {
      emit({ phase: 'http_failure', path });
      throw error;
    }
  },
});
const guarded = { ...provider,
  async startLogin(options) {
    emit({ phase: 'login_started' });
    const flow = await provider.startLogin(options);
    return { ...flow, wait: flow.wait.then(auth => {
      emit({ phase: 'credential_validated' });
      return auth;
    }, error => {
      emit({ phase: 'authorization_failed', code: safeCode(error) });
      throw error;
    }) };
  },
  async models(auth, options) {
    try {
      const models = await provider.models(auth, options);
      emit({ phase: 'catalog_received', count: models.length });
      return models;
    } catch (error) {
      emit({ phase: 'catalog_failed', code: safeCode(error) });
      throw error;
    }
  },
  async complete() {
    emit({ phase: 'unexpected_inference_prevented' });
    throw new Error('Inference is forbidden in this auth-only probe');
  },
};
runNative({ binary, cwd, directory, providers: { cursor: guarded },
  nativeArgs: ['--fullscreen', '--trust'] })
  .then(code => { process.exitCode = code; }, () => {
    emit({ phase: 'launcher_failed' }); process.exitCode = 1;
  });
