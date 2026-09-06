import { EventEmitter } from 'node:events';

// Strict LF framing: Unicode line separators inside JSON strings are data.
export class Rpc extends EventEmitter {
  constructor(input, output, { envelope = true, timeout = 30000, maxBytes = 8 * 1024 * 1024 } = {}) {
    super(); Object.assign(this, { output, envelope, timeout, maxBytes });
    this.pending = new Map(); this.seq = 0; this.buffer = ''; this.closed = false;
    input.setEncoding('utf8');
    input.on('data', data => {
      if (this.closed) return;
      this.buffer += data;
      let end;
      while (!this.closed && (end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end); this.buffer = this.buffer.slice(end + 1);
        if (Buffer.byteLength(line) > maxBytes) return this.close(new Error('RPC frame too large'));
        if (!line.trim()) continue;
        try { this.receive(JSON.parse(line)); } catch { this.close(new Error('Invalid RPC JSON')); return; }
      }
      if (Buffer.byteLength(this.buffer) > maxBytes) this.close(new Error('RPC frame too large'));
    });
    input.on('end', () => this.close(new Error('RPC input closed')));
    input.on('error', () => this.close(new Error('RPC input failed')));
    output.on('error', () => this.close(new Error('RPC output failed')));
  }
  send(message) {
    if (this.closed) throw new Error('RPC closed');
    this.output.write(JSON.stringify(this.envelope ? { jsonrpc: '2.0', ...message } : message) + '\n');
  }
  receive(message) {
    if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid message');
    if (typeof message.method === 'string') { this.emit('message', message); return; }
    const call = this.pending.get(message.id);
    if (!call) return;
    clearTimeout(call.timer); this.pending.delete(message.id);
    if (message.error) call.reject(Object.assign(new Error(message.error.message ?? 'RPC error'), { code: message.error.code, rpcResponse: true }));
    else call.resolve(message.result);
  }
  request(method, params = {}, timeout = this.timeout) {
    const id = `grok-${++this.seq}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`RPC timeout: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (e) { clearTimeout(timer); this.pending.delete(id); reject(e); }
    });
  }
  notify(method, params) { this.send({ method, params }); }
  reply(id, result) { this.send({ id, result }); }
  fail(id, code, message) { this.send({ id, error: { code, message } }); }
  close(error = new Error('RPC closed')) {
    if (this.closed) return;
    this.closed = true; this.buffer = '';
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); }
    this.pending.clear(); this.emit('close', error);
  }
}
