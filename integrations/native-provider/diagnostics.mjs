// Only allowlisted stages/codes cross the diagnostic boundary. Never stringify
// upstream errors: they can include tokens, callback URLs and response bodies.
const stages = new Set(['bridge startup', 'native process', 'model discovery', 'credential storage', 'provider authorization']);
const codes = new Set(['ENOENT', 'EACCES', 'EPERM', 'EADDRINUSE', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND',
  'authentication_error', 'invalid_credential', 'expired_credential', 'invalid_response', 'size_limit',
  'transport_error', 'login_timeout', 'cancelled', 'quota_exceeded', 'upstream_http_error', 'refresh_unavailable', 'invalid_models']);
export function diagnostic(cause, stage) {
  const safeStage = stages.has(stage) ? stage : 'provider operation';
  const code = codes.has(cause?.code) ? cause.code : codes.has(cause?.cause?.code) ? cause.cause.code : 'operation_failed';
  const status = Number.isInteger(cause?.status) && cause.status >= 400 && cause.status <= 599 ? ', HTTP ' + cause.status : '';
  return 'Polycode failed during ' + safeStage + ' (' + code + status + ').';
}
export function stagedError(cause, stage) {
  return Object.assign(new Error(diagnostic(cause, stage)), { cause, stage });
}
