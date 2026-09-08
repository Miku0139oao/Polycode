import { createServer } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
export { CredentialStore } from './store.mjs';
import { catalogRevision, validateReasoningMetadata, validateSelectedEffort } from './model-settings.mjs';
import { diagnostic } from './diagnostics.mjs';

function waiter(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new Error('Request cancelled'));
  let stop;
  const aborted = new Promise((_, reject) => { stop = () => reject(new Error('Request cancelled')); signal.addEventListener('abort', stop, { once: true }); });
  return Promise.race([promise, aborted]).finally(() => signal.removeEventListener('abort', stop));
}
const error = (message, status = 400) => Object.assign(new Error(message), { status });
const json = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); };
const reply = data => Response.json(data, { headers: { 'Cache-Control': 'no-store' } });
const failure = cause => ({ error: { message: cause.status ? cause.message : 'Subscription provider operation failed. Check login, quota and provider availability.', type: 'polycode_provider_error' } });
const names = { codex: 'OpenAI / ChatGPT subscription', cursor: 'Cursor subscription (experimental)' };
const ALLOWED = new Set(['auth.openai.com', 'cursor.com']);
// Only fixed diagnostic codes cross the control boundary, never provider payloads or disk paths.
const LOGIN_FAILURE_CODES = new Set(['authentication_error', 'invalid_credential', 'expired_credential',
  'invalid_response', 'size_limit', 'transport_error', 'login_timeout', 'cancelled',
  'quota_exceeded', 'upstream_http_error']);
function loginFailure(cause, stage) {
  const code = stage === 'credential storage'
    ? (['EACCES', 'EPERM'].includes(cause?.code) ? 'permission_denied' : 'credential_store_failed')
    : (LOGIN_FAILURE_CODES.has(cause?.code) ? cause.code : 'provider_authorization_failed');
  const status = stage === 'provider authorization' && Number.isInteger(cause?.status)
    && cause.status >= 400 && cause.status <= 599 ? `, HTTP ${cause.status}` : '';
  return `Authorization failed during ${stage} (${code}${status}). Please retry.`;
}
export class NativeProviderService {
  constructor(providers, store, { token = randomBytes(32).toString('hex'), loginTimeout = 600000, serve = globalThis.Bun?.serve } = {}) {
    this.providers = providers; this.store = store; this.token = token; this.loginTimeout = loginTimeout;
    this.serve = serve;
    this.attempts = new Map(); this.catalogs = new Map(); this.refreshes = new Map(); this.active = new Set();
    this.server = createServer((req, res) => this.handle(req, res));
  }
  async start() {
    if (this.serve) {
      this.bunServer = this.serve({ hostname: '127.0.0.1', port: 0, idleTimeout: 0, fetch: request => this.handleFetch(request) });
      this.url = `http://127.0.0.1:${this.bunServer.port}`;
      return { url: this.url, token: this.token };
    }
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    this.url = `http://127.0.0.1:${this.server.address().port}`;
    return { url: this.url, token: this.token };
  }
  async credentialSnapshot(provider, signal) {
    if (!this.providers[provider]) throw error('Unknown subscription provider');
    if (!this.refreshes.has(provider)) {
      // Token rotation is shared work, not owned by the first HTTP request.
      const pending = this.store.update(provider, async existing => {
        if (!existing) throw error('Sign in using /provider or /login inside Polycode.', 401);
        return this.providers[provider].refresh(existing, { signal: AbortSignal.timeout(60000) });
      });
      this.refreshes.set(provider, pending);
      pending.finally(() => this.refreshes.delete(provider)).catch(() => {});
    }
    return waiter(this.refreshes.get(provider), signal);
  }
  async credential(provider, signal) { return (await this.credentialSnapshot(provider, signal)).credential; }
  async modelsFor(provider, snapshot, refresh, signal) {
    const cached = this.catalogs.get(provider);
    if (!refresh && cached?.revision === snapshot.revision) return cached.models;
    const models = await this.providers[provider].models(snapshot.credential, { signal });
    if (!Array.isArray(models) || models.length > 500 || models.some(m => typeof m.id !== 'string' || !m.id || m.id.length > 512 || typeof m.name !== 'string' || m.name.length > 512 || /[\x00-\x1f\x7f]/.test(m.id + m.name) || (m.contextWindow !== null && (!Number.isSafeInteger(m.contextWindow) || m.contextWindow <= 0))) || new Set(models.map(m => m.id)).size !== models.length) throw new Error('Invalid catalog');
    for (const model of models) validateReasoningMetadata(model);
    if ((await this.store.snapshot(provider)).revision !== snapshot.revision) throw error('Account changed while loading models; refresh the catalog.', 409);
    this.catalogs.set(provider, { revision: snapshot.revision, models });
    return models;
  }
  async catalog(refresh = false, signal) {
    const providers = [];
    for (const id of Object.keys(this.providers)) {
      let loggedIn = false;
      let models = [], message, revision;
      try { loggedIn = Boolean(await this.store.get(id)); }
      catch (cause) { message = diagnostic(cause, 'credential storage'); }
      if (loggedIn) {
        try {
          const snapshot = await this.credentialSnapshot(id, signal);
          models = await this.modelsFor(id, snapshot, refresh, signal);
          revision = catalogRevision(snapshot.revision, models);
        }
        catch (cause) { message = diagnostic(cause, 'model discovery'); }
      }
      providers.push({ id, name: names[id], loggedIn, models, ...(revision ? { catalogRevision: revision } : {}), ...(message ? { message } : {}) });
    }
    return { providers };
  }
  async login(provider) {
    if (!this.providers[provider]) throw error('Unknown subscription provider');
    for (const old of this.attempts.values()) if (old.provider === provider && old.state === 'pending') this.cancel(old);
    // Keep terminal attempt records bounded without evicting pending attempts.
    if (this.attempts.size > 100) for (const [id, a] of this.attempts) if (a.state !== 'pending') this.attempts.delete(id);
    const attempt = { id: randomUUID(), provider, state: 'pending', stage: 'provider authorization', controller: new AbortController() };
    this.attempts.set(attempt.id, attempt);
    attempt.timer = setTimeout(() => this.cancel(attempt, 'Authorization timed out.'), this.loginTimeout);
    try {
      const flow = await this.providers[provider].startLogin({ signal: attempt.controller.signal });
      const url = new URL(flow.url);
      if (url.protocol !== 'https:' || (url.port && url.port !== '443') || !ALLOWED.has(url.hostname) || url.username || url.password || url.hash || (provider === 'codex' && url.hostname !== 'auth.openai.com') || (provider === 'cursor' && url.hostname !== 'cursor.com')) throw error('Invalid authorization URL');
      attempt.completion = flow.wait.then(async auth => {
        if (attempt.state !== 'pending' || attempt.controller.signal.aborted) return;
        if (!auth || typeof auth.accessToken !== 'string' || !auth.accessToken) throw new Error('Invalid authorization credential');
        attempt.stage = 'credential storage';
        const stored = await this.store.set(provider, auth, () => attempt.state === 'pending' && !attempt.controller.signal.aborted);
        if (stored === false || attempt.state !== 'pending' || attempt.controller.signal.aborted) return;
        this.catalogs.delete(provider); attempt.state = 'completed'; clearTimeout(attempt.timer);
      }).catch(cause => { if (attempt.state === 'pending') { attempt.state = 'failed'; attempt.message = loginFailure(cause, attempt.stage); clearTimeout(attempt.timer); } });
      return { attemptId: attempt.id, url: flow.url, instructions: flow.instructions, ...(flow.userCode ? { userCode: flow.userCode } : {}) };
    } catch (e) {
      this.cancel(attempt);
      throw Object.assign(new Error(diagnostic(e, 'provider authorization')), { status: 500 });
    }
  }
  cancel(a, message) { if (a.state !== 'pending') return; a.state = 'cancelled'; a.message = message; clearTimeout(a.timer); a.controller.abort(); }
  async body(req) {
    let size = 0; const parts = [];
    for await (const part of req) { size += part.length; if (size > 8 * 1024 * 1024) throw error('Request too large', 413); parts.push(part); }
    try { return JSON.parse(Buffer.concat(parts).toString() || '{}'); } catch { throw error('Invalid JSON'); }
  }
  async dispatch(req, readBody, signal) {
      const auth = req.headers.authorization ?? '', expected = `Bearer ${this.token}`;
      if (req.headers.origin || req.headers.host !== new URL(this.url).host || !req.url?.startsWith('/') || Buffer.byteLength(auth) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(auth), Buffer.from(expected))) throw error('Unauthorized local bridge request', 401);
      const url = new URL(req.url, this.url);
      if (req.method === 'GET' && url.pathname === '/control/catalog') return reply(await this.catalog(false, signal));
      if (req.method === 'POST' && url.pathname === '/control/refresh') { await readBody(); return reply(await this.catalog(true, signal)); }
      if (req.method === 'POST' && url.pathname === '/control/validate-model') {
        const b = await readBody();
        const snapshot = await this.credentialSnapshot(b.provider, signal);
        const models = await this.modelsFor(b.provider, snapshot, true, signal);
        if (typeof b.catalogRevision !== 'string' || b.catalogRevision !== catalogRevision(snapshot.revision, models)) throw error('Queued model catalog or credentials changed; select the model again.', 409);
        const model = models.find(m => m.id === b.model);
        if (!model) throw error('Queued model is no longer available', 409);
        validateSelectedEffort(model, { reasoning_effort: b.effort });
        return reply({});
      }
      if (req.method === 'POST' && url.pathname === '/control/login/start') { const b = await readBody(); return reply(await this.login(b.provider)); }
      if (url.pathname === '/control/login/status' && req.method === 'GET') {
        const a = this.attempts.get(url.searchParams.get('attemptId')); if (!a) throw error('Unknown login attempt', 404);
        return reply({ state: a.state, ...(a.message ? { message: a.message } : {}) });
      }
      if (url.pathname === '/control/login/cancel' && req.method === 'POST') {
        const b = await readBody(), a = this.attempts.get(b.attemptId); if (!a) throw error('Unknown login attempt', 404);
        this.cancel(a); return reply({});
      }
      const route = /^\/(codex|cursor)\/v1\/chat\/completions$/.exec(url.pathname);
      if (req.method === 'POST' && route) {
        const provider = route[1], body = await readBody();
        // UI-qualified IDs are accepted only for their matching endpoint.
        if (typeof body.model !== 'string') throw error('Model is required');
        if (body.model.startsWith(provider + '/')) body.model = body.model.slice(provider.length + 1);
        const snapshot = await this.credentialSnapshot(provider, signal);
        const models = await this.modelsFor(provider, snapshot, false, signal);
        const model = models.find(m => m.id === body.model);
        if (!model) throw error('Model is not advertised by the selected provider');
        validateSelectedEffort(model, body);
        return this.providers[provider].complete(body, snapshot.credential, { signal });
      }
      throw error('Unknown bridge endpoint', 404);
  }
  async handleFetch(request) {
    const controller = new AbortController(); this.active.add(controller);
    let reader;
    const finish = () => {
      this.active.delete(controller);
      request.signal.removeEventListener('abort', abort);
      controller.signal.removeEventListener('abort', cancel);
    };
    const cancel = () => { void reader?.cancel().catch(() => {}); finish(); };
    const abort = () => controller.abort();
    request.signal.addEventListener('abort', abort, { once: true });
    controller.signal.addEventListener('abort', cancel, { once: true });
    if (request.signal.aborted) abort();
    try {
      const url = new URL(request.url);
      const response = await this.dispatch({ method: request.method, url: url.pathname + url.search, headers: Object.fromEntries(request.headers) }, () => this.body(request.body ?? []), controller.signal);
      reader = response.body?.getReader();
      if (controller.signal.aborted) { await reader?.cancel(); finish(); return new Response(null, { status: 499 }); }
      if (!reader) { finish(); return response; }
      const body = new ReadableStream({
        async pull(output) {
          try {
            const result = await reader.read();
            if (result.done || controller.signal.aborted) { output.close(); finish(); }
            else output.enqueue(result.value);
          } catch (cause) { output.error(cause); finish(); }
        },
        cancel() { controller.abort(); finish(); },
      });
      return new Response(body, { status: response.status, headers: { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' } });
    } catch (cause) {
      finish();
      return Response.json(failure(cause), { status: cause.status ?? 500, headers: { 'Cache-Control': 'no-store' } });
    }
  }
  async handle(req, res) {
    const controller = new AbortController(); this.active.add(controller);
    req.on('aborted', () => controller.abort()); res.on('close', () => { if (!res.writableFinished) controller.abort(); });
    try {
        const response = await this.dispatch(req, () => this.body(req), controller.signal);
        res.writeHead(response.status, { 'Content-Type': response.headers.get('Content-Type') ?? 'application/json', 'Cache-Control': 'no-store' });
        if (response.body) for await (const chunk of response.body) {
          if (controller.signal.aborted) break;
          if (!res.write(chunk)) await new Promise(resolve => {
            const settled = () => {
              res.off('drain', settled);
              res.off('close', settled);
              resolve();
            };
            res.once('drain', settled);
            res.once('close', settled);
          });
        }
        return res.end();
    } catch (e) {
      if (res.headersSent) res.destroy();
      else json(res, e.status ?? 500, failure(e));
    } finally { this.active.delete(controller); }
  }
  async close() {
    for (const a of this.attempts.values()) this.cancel(a);
    for (const c of this.active) c.abort();
    await Promise.allSettled([...this.refreshes.values()]);
    for (const p of Object.values(this.providers)) p.close();
    if (this.bunServer) { await this.bunServer.stop(true); return; }
    this.server.closeAllConnections?.();
    await new Promise(resolve => this.server.close(resolve));
  }
}
