import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toResponses } from '../codex.mjs';
test('native strict tools and structured response requirements are not silently discarded', () => {
  const schema = { type: 'object', properties: {}, additionalProperties: false };
  const { request } = toResponses({ model: 'test', messages: [{ role: 'user', content: 'Return JSON' }], tools: [{ type: 'function', function: { name: 'native_tool', strict: true, parameters: schema } }], response_format: { type: 'json_schema', json_schema: { name: 'native_result', schema, strict: true } } });
  assert.equal(request.tools[0].strict, true);
  assert.deepEqual(request.text.format, { type: 'json_schema', name: 'native_result', schema, strict: true });
  assert.throws(() => toResponses({ model: 'test', messages: [], response_format: { type: 'unknown' } }), /Unsupported/);
});
