import { EventEmitter } from 'node:events';
import { CodexAdapter } from '../adapter.mjs';

export class Peer extends EventEmitter {
  sent = []; closed = false; pending = new Set();
  request(method, params) {
    if (this.closed) return Promise.reject(new Error('RPC closed'));
    this.sent.push({ method, params });
    return new Promise((resolve, reject) => {
      this.pending.add(reject);
      Promise.resolve().then(() => this.respond(method, params)).then(
        value => { this.pending.delete(reject); resolve(value); },
        error => { this.pending.delete(reject); reject(error); },
      );
    });
  }
  notify(method, params) { this.sent.push({ method, params }); }
  reply(id, result) { this.sent.push({ id, result }); }
  fail(id, code, message) { this.sent.push({ id, error: { code, message } }); }
  close(error = new Error('RPC closed')) {
    if (this.closed) return;
    this.closed = true;
    for (const reject of this.pending) reject(error);
    this.pending.clear(); this.emit('close', error);
  }
}
export const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
export const tick = () => new Promise(resolve => setImmediate(resolve));
export const sessionState = () => ({ model: 'm', models: [{ model: 'm' }], active: null, streamed: new Set(), output: new Map() });
export const threadResponse = (id, turns = []) => ({ thread: { id, turns }, model: 'm', modelProvider: 'openai', approvalsReviewer: 'user', approvalPolicy: 'untrusted', sandbox: { type: 'workspaceWrite' } });
export function fixture(options) {
  const client = new Peer(), server = new Peer();
  const adapter = new CodexAdapter(client, server, options); adapter.initialized = true;
  adapter.sessions.set('t', sessionState());
  let turn = 0, thread = 0;
  server.respond = async (method, p) => {
    if (method === 'account/read') return { account: { type: 'chatgpt' } };
    if (method === 'model/list') return { data: [{ model: 'm', displayName: 'M', description: '' }] };
    if (method === 'thread/start') return threadResponse(`new-${++thread}`);
    if (method === 'thread/resume') return threadResponse(p.threadId);
    if (method === 'turn/start') return { turn: { id: `turn-${++turn}` } };
    if (method === 'turn/interrupt') return {};
    throw Object.assign(new Error(`Unexpected method ${method}`), { rpcResponse: true });
  };
  const prompt = { sessionId: 't', prompt: [{ type: 'text', text: 'test' }] };
  return { adapter, client, server, prompt };
}
export const complete = (f, id = 'turn-1', status = 'completed') => f.adapter.fromCodex({ method: 'turn/completed', params: { threadId: 't', turn: { id, items: [], status } } });
export const calls = (peer, method) => peer.sent.filter(x => x.method === method);
