// Pure request validation/normalization. No URL resolution, filesystem access or image decoder.
import { fail } from './errors.mjs';
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const invalid = () => fail('invalid_request', 'Invalid or unsupported Chat Completions message.', 400);
const unsupported = () => fail('unsupported_content', 'Unsupported message content or image option; only inline PNG/JPEG/GIF/WebP data URLs are supported.', 400);
const textPart = text => ({ type: 'text', text });

export function inlineImage(part) {
  if (!object(part.image_url) || Object.keys(part).some(k => !['type', 'image_url'].includes(k)) ||
      Object.keys(part.image_url).some(k => !['url', 'detail'].includes(k)) ||
      ![undefined, 'auto'].includes(part.image_url.detail) || typeof part.image_url.url !== 'string') throw unsupported();
  const match = /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(part.image_url.url);
  if (!match || match[2].length % 4 !== 0) throw unsupported();
  const data = Buffer.from(match[2], 'base64');
  if (!data.length || data.toString('base64') !== match[2]) throw unsupported();
  // Check container signature/type, not just a caller-supplied MIME label. Do not execute codecs.
  const mimeType = match[1];
  const valid = mimeType === 'image/png' ? data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) && data.readUInt32BE(8) === 13 && data.toString('ascii', 12, 16) === 'IHDR' && data.readUInt32BE(16) > 0 && data.readUInt32BE(20) > 0
    : mimeType === 'image/jpeg' ? data.length >= 4 && data[0] === 255 && data[1] === 216 && data[2] === 255 && data.at(-2) === 255 && data.at(-1) === 217
    : mimeType === 'image/gif' ? data.length >= 14 && ['GIF87a', 'GIF89a'].includes(data.toString('ascii', 0, 6)) && data.readUInt16LE(6) > 0 && data.readUInt16LE(8) > 0 && data.at(-1) === 59
    : data.length >= 20 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP' && data.readUInt32LE(4) === data.length - 8;
  if (!valid) throw unsupported();
  return { type: 'image', data, mimeType };
}

export function messageParts(message) {
  const value = message.content;
  let parts;
  if (typeof value === 'string') parts = [textPart(value)];
  else if ((value === null || value === undefined) && message.role === 'assistant') parts = [];
  else if (Array.isArray(value)) parts = value.map(part => {
    if (message.role === 'tool' && (!object(part) || part.type === undefined)) return textPart(JSON.stringify(part));
    if (!object(part)) throw invalid();
    if (part.type === 'image_url') {
      if (!['user', 'tool'].includes(message.role)) throw unsupported();
      return inlineImage(part);
    }
    if (part.type !== 'text' || typeof part.text !== 'string') throw unsupported();
    // Annotations have no protocol slot: retain them as text, not silently discarded metadata.
    return textPart(Object.keys(part).some(k => !['type', 'text'].includes(k)) ? JSON.stringify(part) : part.text);
  });
  else if (message.role === 'tool' && value !== undefined) parts = [textPart(JSON.stringify(value))];
  else throw invalid();

  const standard = ['role', 'content', 'tool_calls', ...(message.role === 'tool' ? ['tool_call_id', 'is_error'] : [])];
  const metadata = Object.fromEntries(Object.entries(message).filter(([k]) => !standard.includes(k)));
  if (Object.keys(metadata).length) parts.push(textPart(JSON.stringify({ polycode_message_metadata: metadata })));
  return parts;
}

// Keep the previous lossless JSON envelope for structured/annotated native text tool results.
export function toolParts(message) {
  const parts = messageParts(message);
  if (parts.some(p => p.type === 'image')) return parts;
  const extra = Object.keys(message).some(k => !['role', 'tool_call_id', 'content', 'is_error'].includes(k));
  return [textPart(extra ? JSON.stringify(message) : typeof message.content === 'string' ? message.content : JSON.stringify(message.content))];
}

export function validateMessages(messages) {
  const calls = new Map(), pending = new Set();
  let images = 0;
  for (const message of messages) {
    if (!object(message) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) throw invalid();
    if (!Object.hasOwn(message, 'content') && !(message.role === 'assistant' && message.tool_calls)) throw invalid();
    if (message.is_error !== undefined && (message.role !== 'tool' || typeof message.is_error !== 'boolean')) throw invalid();
    images += messageParts(message).filter(p => p.type === 'image').length;
    if (images > 32) throw fail('size_limit', 'Too many inline images in this request.', 413);
    if (message.role === 'user' && pending.size) throw invalid();
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || !message.tool_calls.length) throw invalid();
      for (const call of message.tool_calls) {
        if (!object(call) || call.type !== 'function' || typeof call.id !== 'string' || !call.id || call.id.length > 512 || calls.has(call.id) ||
            !object(call.function) || typeof call.function.name !== 'string' || !call.function.name || call.function.name.length > 512 || typeof call.function.arguments !== 'string') throw invalid();
        if (Object.keys(call).some(k => !['id', 'type', 'function'].includes(k)) || Object.keys(call.function).some(k => !['name', 'arguments'].includes(k))) throw invalid();
        try { JSON.parse(call.function.arguments); } catch { throw invalid(); }
        calls.set(call.id, call.function.name);
        pending.add(call.id);
      }
    }
    if (message.role === 'tool') {
      if (typeof message.tool_call_id !== 'string' || !message.tool_call_id) throw invalid();
      // Live continuation errors remain 409, never turn an orphan result into a new remote run.
      if (!pending.delete(message.tool_call_id) || (message.name !== undefined && message.name !== calls.get(message.tool_call_id))) {
        throw fail('continuation_mismatch', 'Tool result does not match an earlier unresolved call in this transcript.', 409);
      }
    }
  }
}
