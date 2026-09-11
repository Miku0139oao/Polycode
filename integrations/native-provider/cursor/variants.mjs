// Cursor publishes reasoning effort and fast mode as separate catalog entries
// (`gpt-5.3-codex-low`, `gpt-5.3-codex-low-fast`, `cursor-grok-4.6-high-fast`, ...).
// Polycode folds such a group into one model family so the native effort
// selector and /fast drive the variant choice, then resolves the concrete
// Cursor model ID at request time. Context-size variants (for example `-1m`)
// stay separate entries: they are a different context window, not a sampling knob.
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const EFFORT_SUFFIX = new RegExp(`-(${EFFORTS.join('|')})$`);
const FAST_SUFFIX = '-fast';
// The unsuffixed Cursor entry is Cursor's default effort. Cursor does not name
// it, so the option is labelled `medium` and documents where it comes from.
export const IMPLICIT_EFFORT = 'medium';
const IMPLICIT_DESCRIPTION = 'Cursor default (the unsuffixed model ID)';

export function parseVariant(id) {
  if (typeof id !== 'string' || !id) return null;
  let rest = id, fast = false;
  if (rest.endsWith(FAST_SUFFIX)) { fast = true; rest = rest.slice(0, -FAST_SUFFIX.length); }
  const match = EFFORT_SUFFIX.exec(rest);
  const effort = match ? match[1] : undefined;
  const family = match ? rest.slice(0, match.index) : rest;
  if (!family) return { family: id, fast: false, effort: undefined };
  return { family, fast, effort };
}
export const variantKey = (effort, fast) => `${effort ?? 'default'}:${fast ? 'fast' : 'std'}`;

function stripSuffixWords(name, variant) {
  let result = name;
  if (variant.fast && /\sfast$/i.test(result)) result = result.replace(/\sfast$/i, '');
  if (variant.effort && new RegExp(`\\s${variant.effort}$`, 'i').test(result)) result = result.replace(new RegExp(`\\s${variant.effort}$`, 'i'), '');
  return result.trim() || name;
}
function pickDefault(members) {
  return members.find(m => !m.variant.fast && m.variant.effort === undefined)
    ?? members.find(m => !m.variant.fast && m.variant.effort === IMPLICIT_EFFORT)
    ?? EFFORTS.map(effort => members.find(m => !m.variant.fast && m.variant.effort === effort)).find(Boolean)
    ?? members[0];
}
function foldGroup(members) {
  if (members.length < 2) return null;
  const explicitEfforts = members.some(m => m.variant.effort !== undefined);
  const unsuffixed = members.filter(m => m.variant.effort === undefined);
  // Unsuffixed entries stand in for the implicit default effort. That mapping is
  // ambiguous when Cursor also publishes an explicit variant for the same level.
  if (explicitEfforts && unsuffixed.length && members.some(m => m.variant.effort === IMPLICIT_EFFORT)) return null;
  const resolved = members.map(m => ({ ...m, effort: explicitEfforts ? (m.variant.effort ?? IMPLICIT_EFFORT) : undefined, implicit: explicitEfforts && m.variant.effort === undefined }));
  const variants = {};
  for (const m of resolved) {
    const key = variantKey(m.effort, m.variant.fast);
    if (variants[key] !== undefined) return null; // Two IDs for one (effort, fast) pair: leave the group alone.
    variants[key] = m.model.id;
  }
  const primary = pickDefault(members);
  const primaryEffort = resolved.find(m => m.model.id === primary.model.id).effort;
  const family = { id: primary.variant.family, name: stripSuffixWords(primary.model.name, primary.variant), contextWindow: primary.model.contextWindow };
  if (explicitEfforts) {
    const levels = new Map();
    for (const m of resolved) if (!levels.has(m.effort) || (levels.get(m.effort).implicit && !m.implicit)) levels.set(m.effort, m);
    family.reasoningEfforts = EFFORTS.filter(effort => levels.has(effort)).map(effort => ({
      id: effort, value: effort, label: effort, default: effort === primaryEffort,
      ...(levels.get(effort).implicit ? { description: IMPLICIT_DESCRIPTION } : {}),
    }));
    family.defaultReasoningEffort = primaryEffort;
  }
  family.supportsFast = members.some(m => m.variant.fast);
  family.variants = variants;
  return family;
}
/** Folds a Cursor catalog (array of `{ id, name, contextWindow }`) into families; order follows the first member of each group. */
export function foldCursorCatalog(models) {
  const groups = new Map();
  for (const model of models) {
    const variant = parseVariant(model.id);
    if (!groups.has(variant.family)) groups.set(variant.family, []);
    groups.get(variant.family).push({ model, variant });
  }
  const folded = [];
  for (const members of groups.values()) {
    const family = foldGroup(members);
    if (family) folded.push(family);
    else folded.push(...members.map(m => m.model));
  }
  return folded;
}
/** Returns the concrete Cursor model ID for a family selection, or undefined when Cursor publishes no such variant. */
export function resolveCursorVariant(model, effort, fast) {
  if (!model?.variants || typeof model.variants !== 'object') return fast || effort != null ? undefined : model?.id;
  const wanted = effort ?? model.defaultReasoningEffort;
  return model.variants[variantKey(model.reasoningEfforts?.length ? wanted : undefined, Boolean(fast))];
}
