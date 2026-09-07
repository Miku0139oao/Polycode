// Source-contract checks only. These do NOT execute or validate the Rust TUI.
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';

const pager = new URL('../../crates/codegen/xai-grok-pager/', import.meta.url);
const source = (path) => readFileSync(new URL(path, pager), 'utf8');

test('usage identity adapter uses the active model and shared registration authority', () => {
  const adapter = source('src/views/usage_modal/provider.rs');
  assert.match(adapter, /models\.current_model_id_str\(\)/);
  assert.match(adapter, /polycode::registered_model_provider\(id\)/);
  assert.match(adapter, /None => Self::Unavailable/);
  assert.doesNotMatch(adapter, /starts_with\(|base_url|\.selected|reqwest|\.request\(|\.refresh\(/);
});

test('subscription render branches before any native billing mirror', () => {
  const modal = source('src/views/usage_modal.rs');
  const body = modal.slice(modal.indexOf('fn usage_limit_lines('), modal.indexOf('fn allowance_lines('));
  const guard = body.indexOf('!state.ctx.provider.permits_native_billing()');
  const nativeBalance = body.indexOf('else if let Some(bal) = balance');
  assert.ok(guard >= 0, 'provider guard must exist');
  assert.ok(nativeBalance > guard, 'native balance must be behind the provider guard');
  const policy = source('src/views/usage_modal/provider.rs');
  assert.match(policy, /Subscription quota: unavailable/);
  assert.match(policy, /Remaining balance: unavailable/);
  assert.match(policy, /Not provided by a supported provider API\./);
  assert.match(policy, /Native xAI billing is separate; not queried\./);
});

test('reviewed usage goldens preserve reported money and unknown cost', () => {
  const full = source('src/app/snapshots/xai_grok_pager__app__status_blocks__tests__session_usage_block_full.snap');
  const absent = source('src/app/snapshots/xai_grok_pager__app__status_blocks__tests__session_usage_block_absent_cost.snap');
  assert.match(full, /Reported cost:  \$1\.2345/);
  assert.match(absent, /Reported cost:  not available \(not reported\)/);
  for (const snapshot of [full, absent]) {
    assert.match(snapshot, /Model API costs, not subscription balances\./);
    assert.match(snapshot, /Model attribution: unavailable \(not reported\)\./);
  }
  assert.doesNotMatch(absent, /\$0/);
});

test('embedded tutorial chrome is Polycode and native compatibility paths remain', () => {
  for (const name of readdirSync(new URL('docs/tutorial/', pager))) {
    if (!name.endsWith('.md')) continue;
    assert.doesNotMatch(source(`docs/tutorial/${name}`), /Grok Build/);
  }
  assert.match(source('docs/tutorial/01-coming-from-another-tool.md'), /`\.grok` config/);
  assert.match(source('docs/tutorial/05-slash-commands.md'), /ChatGPT, Cursor, or native Grok/);
  assert.match(source('docs/tutorial/05-slash-commands.md'), /Subscription usage pages do not query native xAI billing/);
});
