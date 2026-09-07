import { createHash } from 'node:crypto';

// Canonical wire values the native sampler can represent. Never infer support from a model name.
const efforts = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export function codexReasoningMetadata(model) {
  const levels = model.supported_reasoning_levels;
  if (levels == null || (Array.isArray(levels) && !levels.length)) return {};
  if (!Array.isArray(levels)) throw new Error('Invalid ChatGPT reasoning capabilities');
  // The native sampler cannot encode Codex's ultra mode yet. Intersect the
  // advertised modes with native capabilities instead of dropping every model
  // when a catalog adds this optional mode. Never map ultra to a lower effort.
  const nativeLevels = levels.filter(level => (typeof level === 'string' ? level : level?.effort) !== 'ultra');
  if (!nativeLevels.length) throw new Error('Unsupported ChatGPT reasoning capability');
  const reasoningEfforts = nativeLevels.map(level => {
    const value = typeof level === 'string' ? level : level?.effort;
    if (!efforts.has(value)) throw new Error('Unsupported ChatGPT reasoning capability');
    return { id: value, value, label: value, ...(typeof level?.description === 'string' ? { description: level.description } : {}), default: value === model.default_reasoning_level };
  });
  const result = { reasoningEfforts, ...(model.default_reasoning_level != null ? { defaultReasoningEffort: model.default_reasoning_level } : {}) };
  validateReasoningMetadata(result);
  return result;
}
export function validateReasoningMetadata(model) {
  const options = model.reasoningEfforts ?? [];
  if (!Array.isArray(options) || options.length > efforts.size || options.some(o => !o || !efforts.has(o.value) || o.id !== o.value || o.label !== o.value || (o.description != null && (typeof o.description !== 'string' || o.description.length > 8192 || /[\x00-\x08\x0b-\x1f\x7f]/.test(o.description))) || typeof o.default !== 'boolean') || new Set(options.map(o => o.value)).size !== options.length || options.filter(o => o.default).length > 1) throw new Error('Invalid reasoning capabilities');
  if (model.defaultReasoningEffort != null && !options.some(o => o.value === model.defaultReasoningEffort)) throw new Error('Invalid default reasoning effort');
}
export function validateSelectedEffort(model, body) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (body.reasoning_effort != null && body.reasoning?.effort != null && body.reasoning_effort !== body.reasoning.effort) fail('Conflicting reasoning effort options');
  const effort = body.reasoning_effort ?? body.reasoning?.effort;
  if (effort == null) return;
  if (!model.reasoningEfforts?.length) fail('Selected model does not expose reasoning effort control');
  if (!model.reasoningEfforts.some(o => o.value === effort)) fail('Selected reasoning effort is not advertised by this model');
}
// Opaque, credential-free revision. Token rotation invalidates a pending selection conservatively.
export function catalogRevision(credentialRevision, models) {
  return createHash('sha256').update(JSON.stringify([credentialRevision, models])).digest('hex');
}
