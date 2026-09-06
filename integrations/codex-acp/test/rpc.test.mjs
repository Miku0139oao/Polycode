import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { Rpc } from '../rpc.mjs';
test('LF framing preserves Unicode and fragmented UTF-8', () => {
  const input = new PassThrough(), output = new PassThrough(); const rpc = new Rpc(input, output);
  const received = []; rpc.on('message', m => received.push(m));
  const bytes = Buffer.from(JSON.stringify({ method: 'test', params: { text: '中\u2028文' } }) + '\n');
  for (const b of bytes) input.write(Buffer.from([b]));
  assert.equal(received[0].params.text, '中\u2028文'); rpc.close();
});
test('oversized and invalid frames close transport', () => {
  for (const data of ['this is not json\n', 'x'.repeat(25)]) {
    const input = new PassThrough(); const rpc = new Rpc(input, new PassThrough(), { maxBytes: 20 });
    input.write(data); assert.equal(rpc.closed, true);
  }
});
test('disconnect rejects outstanding calls and cleans pending map', async () => {
  const input = new PassThrough(); const rpc = new Rpc(input, new PassThrough());
  const result = rpc.request('test'); rpc.close(); await assert.rejects(result, /closed/); assert.equal(rpc.pending.size, 0);
});
test('request timeout is bounded and distinguishable from a definitive server error', async () => {
  const rpc = new Rpc(new PassThrough(), new PassThrough(), { timeout: 10 });
  await assert.rejects(rpc.request('test'), e => /timeout/.test(e.message) && e.rpcResponse !== true);
  assert.equal(rpc.pending.size, 0); rpc.close();
});
test('remote JSON-RPC errors are marked as definitive responses', async () => {
  const input = new PassThrough(); const rpc = new Rpc(input, new PassThrough());
  const done = rpc.request('test');
  input.write(JSON.stringify({ id: 'grok-1', error: { code: -32602, message: 'invalid' } }) + '\n');
  await assert.rejects(done, e => e.rpcResponse === true && e.code === -32602); rpc.close();
});
test('closed RPC never dispatches buffered or subsequent frames', () => {
  const input = new PassThrough(); const rpc = new Rpc(input, new PassThrough());
  const seen = []; rpc.on('message', m => { seen.push(m.method); rpc.close(); });
  input.write('{"method":"first"}\n{"method":"buffered"}\n');
  input.write('{"method":"later"}\n');
  assert.deepEqual(seen, ['first']); assert.equal(rpc.buffer, '');
});
