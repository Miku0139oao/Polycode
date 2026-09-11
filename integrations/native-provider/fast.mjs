// OpenAI Codex b090e901f8702f63a5fedbcdcf3f4d021d10a8a0:
// protocol/src/config_types.rs maps Fast to priority; core/src/client.rs sends service_tier.
// Cursor has no service tier: a family advertises supportsFast when its catalog
// carries a `-fast` variant, and the service swaps in that concrete model ID.
export const FAST_HEADER = 'x-polycode-fast';
export function codexFastMetadata(model) {
  return { supportsFast: Array.isArray(model.service_tiers) && model.service_tiers.some(tier => tier?.id === 'priority') };
}
export function supportsFast(provider, model) {
  return ['codex', 'cursor'].includes(provider) && model?.supportsFast === true;
}
export function applyFast(provider, model, body, header) {
  const fail = message => { throw Object.assign(new Error(message), { status: 400 }); };
  if (header != null && header !== 'on' && header !== 'off') fail('Invalid fast mode control.');
  if (body.service_tier != null && body.service_tier !== 'priority') fail('Unsupported service tier; only priority is supported.');
  if (header === 'off' && body.service_tier != null) fail('Conflicting fast mode controls.');
  if (header === 'on' || body.service_tier === 'priority') {
    if (!supportsFast(provider, model)) {
      fail(provider === 'cursor'
        ? 'Fast mode is unsupported: this Cursor model has no fast variant in your catalog.'
        : 'Fast mode is unsupported by the selected provider/model catalog.');
    }
    body.service_tier = 'priority';
  }
}
