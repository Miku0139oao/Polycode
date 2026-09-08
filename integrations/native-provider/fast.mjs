// OpenAI Codex b090e901f8702f63a5fedbcdcf3f4d021d10a8a0:
// protocol/src/config_types.rs maps Fast to priority; core/src/client.rs sends service_tier.
export const FAST_HEADER = 'x-polycode-fast';
export function codexFastMetadata(model) {
  return { supportsFast: Array.isArray(model.service_tiers) && model.service_tiers.some(tier => tier?.id === 'priority') };
}
export function supportsFast(provider, model) {
  return provider === 'codex' && model?.supportsFast === true;
}
export function applyFast(provider, model, body, header) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (header != null && header !== 'on' && header !== 'off') fail('Invalid fast mode control.');
  if (body.service_tier != null && body.service_tier !== 'priority') fail('Unsupported service tier; only priority is supported.');
  if (header === 'off' && body.service_tier != null) fail('Conflicting fast mode controls.');
  if (header === 'on' || body.service_tier === 'priority') {
    if (!supportsFast(provider, model)) fail('Fast mode is unsupported by the selected provider/model catalog. Cursor fast models must be selected with /model.');
    body.service_tier = 'priority';
  }
}
