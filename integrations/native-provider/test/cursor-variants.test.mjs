import test from 'node:test';
import assert from 'node:assert/strict';
import { foldCursorCatalog, parseVariant, resolveCursorVariant } from '../cursor/variants.mjs';
import { validateReasoningMetadata } from '../model-settings.mjs';

const m = (id, name = id, contextWindow = 272000) => ({ id, name, contextWindow });

test('parseVariant splits effort and fast suffixes without touching context-size suffixes', () => {
  assert.deepEqual(parseVariant('gpt-5.3-codex'), { family: 'gpt-5.3-codex', fast: false, effort: undefined });
  assert.deepEqual(parseVariant('gpt-5.3-codex-low'), { family: 'gpt-5.3-codex', fast: false, effort: 'low' });
  assert.deepEqual(parseVariant('gpt-5.3-codex-low-fast'), { family: 'gpt-5.3-codex', fast: true, effort: 'low' });
  assert.deepEqual(parseVariant('gpt-5.3-codex-fast'), { family: 'gpt-5.3-codex', fast: true, effort: undefined });
  assert.deepEqual(parseVariant('cursor-grok-4.6-xhigh-fast'), { family: 'cursor-grok-4.6', fast: true, effort: 'xhigh' });
  assert.deepEqual(parseVariant('claude-opus-5-1m'), { family: 'claude-opus-5-1m', fast: false, effort: undefined });
  assert.deepEqual(parseVariant('claude-opus-5-1m-high'), { family: 'claude-opus-5-1m', fast: false, effort: 'high' });
  assert.deepEqual(parseVariant('-fast'), { family: '-fast', fast: false, effort: undefined });
  assert.deepEqual(parseVariant('high'), { family: 'high', fast: false, effort: undefined });
  assert.equal(parseVariant(''), null);
});

test('effort and fast variants fold into one family with the unsuffixed entry as the implicit default', () => {
  const folded = foldCursorCatalog([
    m('gpt-5.3-codex', 'GPT-5.3 Codex'), m('gpt-5.3-codex-fast', 'GPT-5.3 Codex Fast'),
    m('gpt-5.3-codex-high', 'GPT-5.3 Codex High'), m('gpt-5.3-codex-high-fast', 'GPT-5.3 Codex High Fast'),
    m('gpt-5.3-codex-low', 'GPT-5.3 Codex Low'), m('gpt-5.3-codex-low-fast', 'GPT-5.3 Codex Low Fast'),
    m('gpt-5.3-codex-xhigh', 'GPT-5.3 Codex XHigh'), m('gpt-5.3-codex-xhigh-fast', 'GPT-5.3 Codex XHigh Fast'),
    m('gpt-5.3-codex-1m', 'GPT-5.3 Codex 1M', 1000000), m('gpt-5.3-codex-1m-high', 'GPT-5.3 Codex 1M High', 1000000),
    m('composer-2.5', 'Composer 2.5'), m('composer-2.5-fast', 'Composer 2.5 Fast'),
    m('gemini-3.8-flash-high', 'Gemini 3.8 Flash High'), m('gemini-3.8-flash-low', 'Gemini 3.8 Flash Low'), m('gemini-3.8-flash-medium', 'Gemini 3.8 Flash Medium'),
    m('claude-opus-5', 'Claude Opus 5'),
    m('muse-spark-1.3-minimal', 'Muse Spark 1.3 Minimal'),
  ]);
  assert.deepEqual(folded.map(model => model.id), ['gpt-5.3-codex', 'gpt-5.3-codex-1m', 'composer-2.5', 'gemini-3.8-flash', 'claude-opus-5', 'muse-spark-1.3-minimal']);
  for (const model of folded) validateReasoningMetadata(model);

  const codex = folded[0];
  assert.equal(codex.name, 'GPT-5.3 Codex');
  assert.equal(codex.contextWindow, 272000);
  assert.equal(codex.supportsFast, true);
  assert.equal(codex.defaultReasoningEffort, 'medium');
  assert.deepEqual(codex.reasoningEfforts.map(o => [o.value, o.default, o.description]), [
    ['low', false, undefined], ['medium', true, 'Cursor default (the unsuffixed model ID)'], ['high', false, undefined], ['xhigh', false, undefined],
  ]);
  assert.deepEqual(codex.variants, {
    'medium:std': 'gpt-5.3-codex', 'medium:fast': 'gpt-5.3-codex-fast',
    'high:std': 'gpt-5.3-codex-high', 'high:fast': 'gpt-5.3-codex-high-fast',
    'low:std': 'gpt-5.3-codex-low', 'low:fast': 'gpt-5.3-codex-low-fast',
    'xhigh:std': 'gpt-5.3-codex-xhigh', 'xhigh:fast': 'gpt-5.3-codex-xhigh-fast',
  });

  const million = folded[1];
  assert.equal(million.name, 'GPT-5.3 Codex 1M');
  assert.equal(million.contextWindow, 1000000);
  assert.equal(million.supportsFast, false);
  assert.deepEqual(million.reasoningEfforts.map(o => o.value), ['medium', 'high']);
  assert.deepEqual(million.variants, { 'medium:std': 'gpt-5.3-codex-1m', 'high:std': 'gpt-5.3-codex-1m-high' });

  const composer = folded[2];
  assert.equal(composer.name, 'Composer 2.5');
  assert.equal(composer.supportsFast, true);
  assert.equal(composer.reasoningEfforts, undefined);
  assert.equal(composer.defaultReasoningEffort, undefined);
  assert.deepEqual(composer.variants, { 'default:std': 'composer-2.5', 'default:fast': 'composer-2.5-fast' });

  const gemini = folded[3];
  assert.equal(gemini.name, 'Gemini 3.8 Flash');
  assert.equal(gemini.defaultReasoningEffort, 'medium');
  assert.equal(gemini.supportsFast, false);
  assert.deepEqual(gemini.reasoningEfforts.map(o => [o.value, o.default, o.description]), [['low', false, undefined], ['medium', true, undefined], ['high', false, undefined]]);

  assert.deepEqual(folded[4], m('claude-opus-5', 'Claude Opus 5'));
  assert.deepEqual(folded[5], m('muse-spark-1.3-minimal', 'Muse Spark 1.3 Minimal'));
});

test('families without a medium variant default to the lowest advertised effort and strip only matching name suffixes', () => {
  const [grok] = foldCursorCatalog([m('cursor-grok-4.6-high', 'Cursor Grok 4.6 (High)'), m('cursor-grok-4.6-xhigh-fast', 'Cursor Grok 4.6 XHigh Fast')]);
  assert.equal(grok.id, 'cursor-grok-4.6');
  assert.equal(grok.name, 'Cursor Grok 4.6 (High)');
  assert.equal(grok.defaultReasoningEffort, 'high');
  assert.deepEqual(grok.reasoningEfforts.map(o => o.value), ['high', 'xhigh']);
  assert.equal(grok.supportsFast, true);
  assert.equal(resolveCursorVariant(grok, 'xhigh', false), undefined);
  assert.equal(resolveCursorVariant(grok, 'xhigh', true), 'cursor-grok-4.6-xhigh-fast');
});

test('ambiguous groups are left unfolded', () => {
  const both = [m('a'), m('a-medium'), m('a-high')];
  assert.deepEqual(foldCursorCatalog(both), both);
  const fastOnly = [m('b-low-fast')];
  assert.deepEqual(foldCursorCatalog(fastOnly), fastOnly);
});

test('resolveCursorVariant honours the family default and reports missing variants', () => {
  const [codex] = foldCursorCatalog([m('c'), m('c-fast'), m('c-high')]);
  assert.equal(resolveCursorVariant(codex, undefined, false), 'c');
  assert.equal(resolveCursorVariant(codex, undefined, true), 'c-fast');
  assert.equal(resolveCursorVariant(codex, 'medium', false), 'c');
  assert.equal(resolveCursorVariant(codex, 'high', false), 'c-high');
  assert.equal(resolveCursorVariant(codex, 'high', true), undefined);
  const plain = m('solo');
  assert.equal(resolveCursorVariant(plain, undefined, false), 'solo');
  assert.equal(resolveCursorVariant(plain, undefined, true), undefined);
  assert.equal(resolveCursorVariant(plain, 'high', false), undefined);
});
