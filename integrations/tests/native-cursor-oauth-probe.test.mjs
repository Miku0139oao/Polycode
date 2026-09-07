import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const probe = fileURLToPath(new URL('./native_cursor_oauth_probe.mjs', import.meta.url));
for (const consent of [undefined, 'yes']) {
  test(`OAuth probe refuses incomplete invocation before service startup (consent=${consent ?? 'absent'})`, () => {
    const env = { ...process.env };
    delete env.POLYCODE_AUTH_PROBE_CONSENT;
    if (consent) env.POLYCODE_AUTH_PROBE_CONSENT = consent;
    const result = spawnSync(process.execPath, [probe], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Explicit auth-only probe consent and paths required/);
    assert.equal(result.stdout, '');
  });
}
