// Wire layouts adapted from Yukaii/yet-another-opencode-cursor-auth (MIT).
// See PROVENANCE.md and LICENSE.reference. No upstream executable/tool handler code.
import { createHash } from 'node:crypto';
import { fail } from './errors.mjs';

export const MAX_FRAME = 8 * 1024 * 1024;
export const MCP_PROVIDER = 'polycode-native';
export const empty = new Uint8Array();
const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const malformed = () => fail('invalid_protocol', 'Malformed or unsupported Cursor protocol data.');
export const text = bytes => { try { return decoder.decode(bytes); } catch { throw malformed(); } };
export function concat(...arrays) {
  const size = arrays.reduce((n, a) => n + a.length, 0);
  if (size > MAX_FRAME) throw fail('size_limit', 'Cursor protocol size limit exceeded.');
  const out = new Uint8Array(size);
  let offset = 0;
  for (const a of arrays) { out.set(a, offset); offset += a.length; }
  return out;
}
export function varint(value) {
  let n = BigInt(value);
  if (n < 0n || n > 0xffffffffffffffffn) throw malformed();
  const out = [];
  do { out.push(Number(n & 127n) | (n > 127n ? 128 : 0)); n >>= 7n; } while (n);
  return Uint8Array.from(out);
}
export const uint = (id, n) => concat(varint(id * 8), varint(n));
export const bytes = (id, data) => concat(varint(id * 8 + 2), varint(data.length), data);
export const string = (id, value) => bytes(id, encoder.encode(value));
export function fields(data) {
  let offset = 0;
  const readVarint = () => {
    let n = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) throw malformed();
      const b = data[offset++];
      if (i === 9 && b > 1) throw malformed();
      n |= BigInt(b & 127) << BigInt(i * 7);
      if (!(b & 128)) return n;
    }
    throw malformed();
  };
  const result = [];
  while (offset < data.length) {
    if (result.length >= 100000) throw malformed();
    const tag = readVarint();
    const id = Number(tag >> 3n), wire = Number(tag & 7n);
    if (!id || id > 536870911) throw malformed();
    let value;
    if (wire === 0) value = readVarint();
    else {
      const size = wire === 2 ? Number(readVarint()) : wire === 1 ? 8 : wire === 5 ? 4 : -1;
      if (size < 0 || !Number.isSafeInteger(size) || size > MAX_FRAME || offset + size > data.length) throw malformed();
      value = data.slice(offset, offset + size);
      offset += size;
    }
    result.push({ id, wire, value });
  }
  return result;
}
export function one(fs, id, wire = 2, required = true) {
  const matches = fs.filter(f => f.id === id);
  if (matches.length > 1 || (required && !matches.length) || (matches.length && matches[0].wire !== wire)) throw malformed();
  return matches[0]?.value;
}
export const number = value => {
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n < 0) throw malformed();
  return n;
};
export function only(fs, allowed) {
  if (fs.some(f => !allowed.includes(f.id))) throw fail('unsupported_protocol', 'Unsupported Cursor protocol request; nothing was executed.');
}
export function encodeValue(value, depth = 0) {
  if (depth > 64) throw malformed();
  if (value === null) return uint(1, 0);
  if (typeof value === 'boolean') return uint(4, value ? 1 : 0);
  if (typeof value === 'string') return string(3, value);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const data = new Uint8Array(8);
    new DataView(data.buffer).setFloat64(0, value, true);
    return concat(varint(17), data);
  }
  if (Array.isArray(value)) return bytes(6, concat(...value.map(v => bytes(1, encodeValue(v, depth + 1)))));
  if (value && typeof value === 'object') return bytes(5, concat(...Object.entries(value).map(([k, v]) =>
    bytes(1, concat(string(1, k), bytes(2, encodeValue(v, depth + 1)))))));
  throw malformed();
}
export function decodeMap(data, depth = 0, entryId = 1) {
  const fs = fields(data);
  only(fs, [entryId]);
  const result = {};
  for (const f of fs) {
    if (f.wire !== 2) throw malformed();
    const entry = fields(f.value);
    only(entry, [1, 2]);
    const key = text(one(entry, 1, 2, false) ?? empty);
    if (Object.hasOwn(result, key)) throw malformed();
    Object.defineProperty(result, key, { value: decodeValue(one(entry, 2), depth + 1), enumerable: true });
  }
  return result;
}
export function decodeValue(data, depth = 0) {
  if (depth > 64) throw malformed();
  const fs = fields(data);
  if (fs.length !== 1) throw malformed();
  const f = fs[0];
  if (f.id === 1 && f.wire === 0 && f.value === 0n) return null;
  if (f.id === 2 && f.wire === 1) {
    const n = new DataView(f.value.buffer, f.value.byteOffset, 8).getFloat64(0, true);
    if (!Number.isFinite(n)) throw malformed();
    return n;
  }
  if (f.id === 3 && f.wire === 2) return text(f.value);
  if (f.id === 4 && f.wire === 0 && (f.value === 0n || f.value === 1n)) return f.value === 1n;
  if (f.id === 5 && f.wire === 2) return decodeMap(f.value, depth);
  if (f.id === 6 && f.wire === 2) {
    const items = fields(f.value);
    only(items, [1]);
    return items.map(item => { if (item.wire !== 2) throw malformed(); return decodeValue(item.value, depth + 1); });
  }
  throw malformed();
}
export function envelope(data, flags = 0) {
  if (data.length > MAX_FRAME - 5) throw malformed();
  const header = new Uint8Array(5);
  header[0] = flags;
  new DataView(header.buffer).setUint32(1, data.length);
  return concat(header, data);
}
export function checksum(token, now = Date.now()) {
  const date = new Date(now);
  date.setMinutes(30 * Math.floor(date.getMinutes() / 30), 0, 0);
  let timestamp = Math.floor(date.getTime() / 1e6);
  const data = Buffer.alloc(6);
  for (let i = 5; i >= 0; i--) { data[i] = timestamp & 255; timestamp = Math.floor(timestamp / 256); }
  let t = 165;
  for (let i = 0; i < data.length; i++) { data[i] = ((data[i] ^ t) + i) & 255; t = data[i]; }
  const hash = s => createHash('sha256').update(s).digest('hex').slice(0, 8);
  const salt = token.split('.')[1];
  return `${data.toString('base64url')}${salt ? hash(salt) : '00000000'}/${hash(token)}`;
}
export function mcpDefinition(tool) {
  const f = tool.function;
  return concat(string(1, `${MCP_PROVIDER}-${f.name}`), string(2, f.description ?? ''),
    bytes(3, encodeValue(f.parameters ?? { type: 'object', properties: {} })),
    string(4, MCP_PROVIDER), string(5, f.name));
}
export function runMessage(body, conversationId, messageId) {
  const tools = (body.tools ?? []).map(mcpDefinition);
  const instructions = 'Only request the explicitly supplied MCP tools. Polycode owns all execution and permissions. '
    + 'No built-in tools, filesystem, shell, web, subagents, or mode switches are available. '
    + 'The user message contains a JSON Chat Completions transcript; preserve its roles, content and tool history.';
  // Virtual context only: no cwd/env/host filesystem discovery. MCP filesystem mode is not enabled.
  const context = concat(bytes(4, concat(string(1, 'Polycode model transport'), string(2, '/polycode-virtual'),
    string(10, 'UTC'), string(11, '/polycode-virtual'))), ...tools.map(t => bytes(7, t)),
    bytes(14, concat(string(1, MCP_PROVIDER), string(2, instructions))));
  // Upstream exposes UserMessage.text, not native OpenAI roles. Keep JSON intact, never flatten content.
  const prompt = 'Polycode Chat Completions request (JSON):\n' + JSON.stringify(body);
  const user = concat(string(1, prompt), string(2, messageId), uint(4, 1));
  const action = bytes(1, concat(bytes(1, user), bytes(2, context)));
  return bytes(1, concat(bytes(1, empty), bytes(2, action), bytes(3, string(1, body.model)),
    bytes(4, concat(...tools.map(t => bytes(1, t)))), string(5, conversationId)));
}
export const bidiRequest = id => string(1, id);
export const appendRequest = (id, seq, data) => concat(string(1, Buffer.from(data).toString('hex')), bytes(2, bidiRequest(id)), uint(3, seq));
export function parseExec(data) {
  const fs = fields(data);
  if (fs.some(f => ![1, 11, 15].includes(f.id)) || !fs.some(f => f.id === 11)) {
    throw fail('unsupported_builtin', 'Cursor requested a non-MCP/built-in operation; denied without execution.');
  }
  const id = number(one(fs, 1, 0, false) ?? 0n);
  const execId = one(fs, 15, 2, false);
  const args = fields(one(fs, 11));
  only(args, [1, 2, 3, 4, 5]);
  const name = text(one(args, 1));
  const toolCallId = text(one(args, 3));
  const providerIdentifier = text(one(args, 4));
  const toolName = text(one(args, 5));
  if (!toolCallId || toolCallId.length > 512 || !toolName || providerIdentifier !== MCP_PROVIDER || name !== `${MCP_PROVIDER}-${toolName}`) throw malformed();
  const argData = concat(...args.filter(f => f.id === 2).map(f => { if (f.wire !== 2) throw malformed(); return bytes(1, f.value); }));
  return { id, execId: execId ? text(execId) : undefined, name, toolCallId, providerIdentifier, toolName, args: decodeMap(argData) };
}
export function toolResult(exec, message) {
  // MCP text results have no metadata slots. Preserve extra JSON fields as a whole-message JSON envelope.
  const hasExtraFields = Object.keys(message).some(key => !['role', 'tool_call_id', 'content', 'is_error'].includes(key));
  const content = hasExtraFields ? JSON.stringify(message) : typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
  const success = concat(bytes(1, bytes(1, string(1, content))), uint(2, message.is_error === true ? 1 : 0));
  return bytes(2, concat(uint(1, exec.id), ...(exec.execId === undefined ? [] : [string(15, exec.execId)]), bytes(11, bytes(1, success))));
}
export const toolClose = exec => bytes(5, bytes(1, uint(1, exec.id)));
// No speculative resume: sendToolResult + stream-close is the reference's base MCP path.
