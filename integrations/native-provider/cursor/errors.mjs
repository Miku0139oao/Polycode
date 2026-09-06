// No server payloads, request bodies, tokens, or underlying exception messages in errors.
export class CursorProviderError extends Error {
  constructor(code, message, status = 502) {
    super(message);
    this.name = 'CursorProviderError';
    this.code = code;
    this.status = status;
  }
}
export const fail = (code, message, status) => new CursorProviderError(code, message, status);
export const aborted = () => fail('cancelled', 'Cursor request cancelled.', 499);
export function safeError(error) {
  return error instanceof CursorProviderError ? error : fail('transport_error', 'Cursor transport failed.');
}
export function checkSignal(signal) { if (signal?.aborted) throw aborted(); }
export function onAbort(signal, fn) {
  if (!signal) return () => {};
  if (signal.aborted) { fn(); return () => {}; }
  signal.addEventListener('abort', fn, { once: true });
  return () => signal.removeEventListener('abort', fn);
}
// Also cancels mocks/non-cooperative fetch implementations without leaking their errors.
export function interruptible(promise, signal) {
  return new Promise((resolve, reject) => {
    let off = () => {};
    off = onAbort(signal, () => reject(aborted()));
    Promise.resolve(promise).then(resolve, reject).finally(() => off());
  });
}
export function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    checkSignal(signal);
    const timer = setTimeout(() => { off(); resolve(); }, ms);
    const off = onAbort(signal, () => { clearTimeout(timer); reject(aborted()); });
  });
}
export const errorBody = error => {
  const e = safeError(error);
  return { error: { type: 'cursor_provider_error', code: e.code, message: e.message } };
};
