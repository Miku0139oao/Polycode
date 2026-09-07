// Minimal official-host HTTP + BidiSse transport. No retries, routing/model fallbacks or executors.
import { fail, safeError, checkSignal, interruptible, onAbort } from './errors.mjs';
import * as p from './protocol.mjs';

export const API = 'https://api2.cursor.sh';
export const WEBSITE = 'https://cursor.com';
export function headers(token, requestId, now) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/grpc-web+proto',
    'user-agent': 'connect-es/1.4.0',
    'x-cursor-checksum': p.checksum(token, now),
    'x-cursor-client-version': 'cli-2025.11.25-d5b3271',
    'x-cursor-client-type': 'cli',
    'x-cursor-timezone': 'UTC',
    'x-ghost-mode': 'true',
    'x-cursor-streaming': 'true',
    'x-request-id': requestId,
  };
}
export async function request(fetchImpl, url, options) {
  const parsed = new URL(url);
  if (parsed.origin !== API || parsed.username || parsed.password) throw fail('invalid_host', 'Only the official Cursor API host is allowed.', 400);
  checkSignal(options.signal);
  try {
    const pending = Promise.resolve(fetchImpl(url, { ...options, redirect: 'error' })).then(response => {
      if (options.signal?.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    const response = await interruptible(pending, options.signal);
    checkSignal(options.signal);
    return response;
  } catch (e) { throw safeError(e); }
}
export function httpError(status) {
  return fail(status === 401 || status === 403 ? 'authentication_error' : status === 429 ? 'quota_exceeded' : 'upstream_http_error',
    `Cursor returned HTTP ${Number.isInteger(status) ? status : 502}.`, status >= 400 && status <= 599 ? status : 502);
}
export function grpcStatus(status) {
  if (!/^\d+$/.test(status)) throw fail('invalid_protocol', 'Invalid Cursor RPC status.');
  if (Number(status) !== 0) throw fail(Number(status) === 8 ? 'quota_exceeded' : 'upstream_rpc_error',
    `Cursor returned RPC status ${Number(status)}.`, Number(status) === 8 ? 429 : 502);
}
export function trailer(payload) {
  const lines = p.text(payload).split(/\r?\n/);
  const statuses = lines.filter(s => /^grpc-status\s*:/i.test(s)).map(s => s.slice(s.indexOf(':') + 1).trim());
  if (statuses.length !== 1) throw fail('invalid_protocol', 'Missing or ambiguous Cursor RPC status.');
  grpcStatus(statuses[0]);
}
export async function* chunks(response, signal) {
  if (!response.body) throw fail('invalid_protocol', 'Cursor response has no body.');
  const reader = response.body.getReader();
  const off = onAbort(signal, () => { void reader.cancel().catch(() => {}); });
  try {
    while (true) {
      checkSignal(signal);
      const { value, done } = await interruptible(reader.read(), signal);
      checkSignal(signal);
      if (done) break;
      if (value.length) yield value;
    }
  } finally {
    off();
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export async function readJson(response, signal) {
  let data = p.empty;
  for await (const part of chunks(response, signal)) {
    if (data.length + part.length > 1024 * 1024) throw fail('size_limit', 'Cursor JSON response is too large.');
    data = p.concat(data, part);
  }
  try { return JSON.parse(p.text(data)); } catch { throw fail('invalid_response', 'Cursor returned invalid JSON.'); }
}
export async function* frames(response, signal) {
  const status = response.headers.get('grpc-status');
  if (status !== null) grpcStatus(status);
  let buffer = p.empty;
  for await (const part of chunks(response, signal)) {
    buffer = p.concat(buffer, part);
    let offset = 0;
    while (offset + 5 <= buffer.length) {
      const flags = buffer[offset];
      const length = new DataView(buffer.buffer, buffer.byteOffset + offset + 1, 4).getUint32(0);
      if (length > p.MAX_FRAME - 5) throw fail('size_limit', 'Cursor frame is too large.');
      if (offset + length + 5 > buffer.length) break;
      const data = buffer.slice(offset + 5, offset + 5 + length);
      offset += length + 5;
      if (flags === 128) { trailer(data); yield { end: true }; }
      else if (flags === 2) throw fail('upstream_rpc_error', 'Cursor returned a Connect error.');
      else if (flags !== 0) throw fail('unsupported_protocol', 'Compressed/unknown Cursor frames are unsupported.');
      else yield { data };
    }
    buffer = buffer.slice(offset);
  }
  if (buffer.length) throw fail('invalid_protocol', 'Truncated Cursor protocol frame.');
}

export class Connection {
  constructor({ fetchImpl, token, body, uuid, now, controller }) {
    this.fetchImpl = fetchImpl;
    this.token = token;
    this.body = body;
    this.uuid = uuid;
    this.now = now;
    this.controller = controller;
    this.id = uuid();
    this.seq = 0n;
    this.blobs = new Map();
    this.blobBytes = 0;
  }
  async append(data) {
    checkSignal(this.controller.signal);
    const response = await request(this.fetchImpl, `${API}/aiserver.v1.BidiService/BidiAppend`, {
      method: 'POST', headers: headers(this.token, this.id, this.now()),
      body: p.envelope(p.appendRequest(this.id, this.seq, data)), signal: this.controller.signal,
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
    for await (const frame of frames(response, this.controller.signal)) {
      if (frame.data?.length) p.fields(frame.data); // Only ack; never infer tool requests from unary responses.
    }
    this.seq++;
  }
  async open() {
    const signal = this.controller.signal;
    const responsePromise = request(this.fetchImpl, `${API}/agent.v1.AgentService/RunSSE`, {
      method: 'POST', headers: headers(this.token, this.id, this.now()), body: p.envelope(p.bidiRequest(this.id)), signal,
    }).then(response => {
      if (!response.ok) { void response.body?.cancel().catch(() => {}); throw httpError(response.status); }
      this.response = response;
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    try {
      await Promise.all([responsePromise, this.append(p.runMessage(this.body, this.uuid(), this.uuid()))]);
      this.iterator = this.events();
      this.body = undefined;
      return this;
    } catch (error) { this.close(); throw safeError(error); }
  }
  async kv(data) {
    const fs = p.fields(data);
    p.only(fs, [1, 2, 3, 4]);
    // KvServerMessage.span_context is optional tracing metadata in the
    // installed official schema. Validate its wire type/uniqueness without
    // forwarding or interpreting it as storage or executable instructions.
    p.one(fs, 4, 2, false);
    const id = p.number(p.one(fs, 1, 0, false) ?? 0n);
    const requests = fs.filter(f => [2, 3].includes(f.id));
    if (requests.length !== 1 || requests[0].wire !== 2) throw fail('unsupported_protocol', 'Unsupported Cursor KV request.');
    const f = requests[0], args = p.fields(f.value);
    p.only(args, f.id === 2 ? [1] : [1, 2]);
    const blobId = p.one(args, 1);
    if (!blobId.length || blobId.length > 512) throw fail('invalid_protocol', 'Invalid Cursor blob ID.');
    const key = Buffer.from(blobId).toString('hex');
    let result = p.empty;
    if (f.id === 2) {
      const blob = this.blobs.get(key);
      if (blob) result = p.bytes(1, blob);
    } else {
      const blob = p.one(args, 2);
      const total = this.blobBytes - (this.blobs.get(key)?.length ?? 0) + blob.length;
      if (total > 16 * 1024 * 1024 || (!this.blobs.has(key) && this.blobs.size >= 1024)) throw fail('size_limit', 'Cursor session blob limit exceeded.');
      this.blobs.set(key, blob);
      this.blobBytes = total;
    }
    await this.append(p.bytes(3, p.concat(p.uint(1, id), p.bytes(f.id, result))));
  }
  async *events() {
    for await (const frame of frames(this.response, this.controller.signal)) {
      if (frame.end) { yield { type: 'done' }; return; }
      for (const f of p.fields(frame.data)) {
        if (f.wire !== 2) throw fail('unsupported_protocol', 'Unsupported Cursor server message.');
        if (f.id === 1) {
          const updates = p.fields(f.value);
          // Optional uint64 timestamp added by the official 2026-09 schema.
          // It accompanies an update and does not carry text or tool intent.
          p.one(updates, 25, 0, false);
          for (const update of updates) {
            if (update.id === 25) continue;
            if (update.wire !== 2) throw fail('invalid_protocol', 'Invalid Cursor interaction update.');
            if (update.id === 1) {
              const delta = p.one(p.fields(update.value), 1, 2, false);
              if (delta) yield { type: 'text', text: p.text(delta) };
            } else if ([5, 8].includes(update.id)) {
              // Thinking duration / token delta are int32 progress counters,
              // not assistant text or authoritative billable usage.
              const counters = p.fields(update.value);
              p.only(counters, [1]);
              p.one(counters, 1, 0, false);
            } else if (update.id === 14) { yield { type: 'done', usage: p.turnUsage(update.value) }; return; }
            // Notifications only: never turn progress/partial calls into executable intents.
            // 15 is a partial tool delta; 16/17 delimit a step, not the turn.
            else if (![2, 3, 4, 7, 13, 15, 16, 17].includes(update.id)) throw fail('unsupported_protocol', 'Unsupported Cursor interaction update.');
          }
        } else if (f.id === 2) yield { type: 'tool', exec: p.parseExec(f.value) };
        else if (f.id === 3) { /* Checkpoint is NOT completion. */ }
        else if (f.id === 4) await this.kv(f.value);
        else if (f.id === 5) throw fail('remote_abort', 'Cursor aborted an execution stream.');
        else if (f.id === 7) throw fail('unsupported_builtin', 'Cursor requested a non-MCP interaction; denied without execution.');
        else if (f.id === 8) { /* Official TTFT breakdown telemetry; not an operation or completion. */ }
        else throw fail('unsupported_protocol', 'Unknown Cursor server request; denied without execution.');
      }
    }
    throw fail('unexpected_eof', 'Cursor stream closed without a completion signal.');
  }
  async submit(exec, message) {
    await this.append(p.toolResult(exec, message));
    await this.append(p.toolClose(exec));
  }
  close() {
    this.controller.abort();
    this.blobs.clear();
    this.blobBytes = 0;
    this.token = undefined;
    this.body = undefined;
    if (this.response?.body && !this.response.body.locked) void this.response.body.cancel().catch(() => {});
    // Abort cancels any pending read before attempting generator return (no deadlock).
    void this.iterator?.return?.().catch(() => {});
  }
}
