import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyPreview, PREVIEW_POLICY, PREVIEW_GATES, PREVIEW_DEFERRED, PREVIEW_LIMITATIONS, PREVIEW_ASSETS } from '../preview-readiness.mjs';
import { verifyCandidate } from '../candidate-readiness.mjs';
import { publishPreview } from '../publish-preview.mjs';

const root = mkdtempSync(join(tmpdir(), 'polycode-preview-policy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const source = 'a'.repeat(40), native = 'b'.repeat(64);
const facts = {
  'host-install': { os: 'Windows 11', build: 26200, cleanOS: false, nativeHashVerified: true, bundleHashVerified: true,
    providers: ['native', 'codex', 'cursor'].map(id => ({ id, exitCode: 0, forcedExit: false, menu: true, alternateScreenRestored: true })) },
  'oauth-native': { loginCompleted: true, exitCode: 0, forcedExit: false, generationRequests: 0 },
  'oauth-chatgpt': { loginCompleted: true, exitCode: 0, forcedExit: false, catalogObserved: true },
  'oauth-cursor': { loginCompleted: true, exitCode: 0, forcedExit: false, catalogObserved: true },
  'offline-regression': { nodePassed: 177, bunPassed: 140, failed: 0, skipped: 0, permissionRegression: true, transport: 'synthetic' },
  'native-tools': { transport: 'synthetic', actualNativeTools: true, mcpCalls: 2, bridgeTokenLeaked: false, cancelledStreams: 1,
    freshResumeRead: true, slowShell: true, forcedExit: false, fixtureErrors: 0, shellCalls: { codex: 1, cursor: 1 },
    tasks: { codex: { childCalls: 1, verified: true }, cursor: { childCalls: 1, verified: true } } },
};
for (const [id, model] of [['coding-chatgpt', 'codex/gpt-5.4-mini'], ['coding-cursor', 'cursor/default']]) {
  facts[id] = { model, generationCompleted: true, readObserved: true, writeCalls: 1, shellCalls: 1, shellExitCode: 0,
    exactFileBytes: true, sameSessionResume: true, freshResumeRead: true, normalExits: 2, forcedExit: false };
}
function fixture() {
  const directory = mkdtempSync(join(root, 'case-')), candidate = join(directory, 'candidate'), evidence = join(directory, 'evidence');
  mkdirSync(candidate); mkdirSync(evidence);
  const assets = PREVIEW_ASSETS.filter(path => !['manifest.json', 'SHA256SUMS'].includes(path));
  const manifest = { schemaVersion: 3, classification: 'immutable-candidate', provenance: 'build-report', version: 'v0.2.1',
    platform: 'windows', target: 'x86_64-pc-windows-msvc', executableFormat: 'PE32+',
    native: { transformed: false, revision: source, sha256: native, profile: { opt_level: '3', debug_assertions: false, test: false } },
    bun: { sha256: 'c'.repeat(64) }, files: [{ path: 'vendor/rg.exe', bytes: 4265472, sha256: 'a286ea6f4d0d8c1c6c2234728cf2d96afcf371c550086c11e1ea28730dcfb418' }],
    artifacts: assets.map(path => { const bytes = Buffer.from('SYNTHETIC POLICY FIXTURE ' + path); writeFileSync(join(candidate, path), bytes); return { path, bytes: bytes.length, sha256: sha(bytes) }; }) };
  const bytes = JSON.stringify(manifest), identity = sha(bytes);
  writeFileSync(join(candidate, 'manifest.json'), bytes);
  writeFileSync(join(candidate, 'SHA256SUMS'), manifest.artifacts.map(asset => asset.sha256 + '  ' + asset.path).concat(identity + '  manifest.json').join('\n'));
  const ledger = { schemaVersion: 1, kind: 'polycode-preview-evidence', policy: PREVIEW_POLICY, version: 'v0.2.1',
    fullAcceptance: false, stableReleaseAuthorized: false, candidateSha256: identity, nativeSha256: native, sourceRevision: source,
    ci: { repository: 'Miku0139oao/Polycode', runId: '123', conclusion: 'success', sourceRevision: source },
    deferred: PREVIEW_DEFERRED.map(id => ({ id, status: 'NOT_VERIFIED', reason: 'Explicit unverified scope for policy fixture' })),
    limitations: PREVIEW_LIMITATIONS.map(id => ({ id, status: 'OPEN', description: 'Explicit known limitation for policy fixture' })), gates: [] };
  const notes = ['Preview; not a stable release', ...PREVIEW_DEFERRED, ...PREVIEW_LIMITATIONS].join('\n');
  writeFileSync(join(evidence, 'release-notes.md'), notes);
  ledger.releaseNotes = { path: 'release-notes.md', sha256: sha(notes) };
  const records = {};
  function saveRecord(id) {
    const text = JSON.stringify(records[id]);
    writeFileSync(join(evidence, id + '.json'), text);
    ledger.gates.find(gate => gate.id === id).evidence.sha256 = sha(text);
  }
  for (const [id, mode] of Object.entries(PREVIEW_GATES)) {
    const observedAt = new Date().toISOString();
    records[id] = { kind: 'sanitized-observation', gate: id, mode, observedAt, candidateSha256: identity,
      nativeSha256: native, sourceRevision: source, sourceEvidenceSha256: ['d'.repeat(64)], facts: structuredClone(facts[id]) };
    ledger.gates.push({ id, status: 'PASS', mode, observedAt, evidence: { path: id + '.json', sha256: '' } });
    saveRecord(id);
  }
  const save = () => writeFileSync(join(evidence, 'preview.json'), JSON.stringify(ledger)); save();
  return { candidate, evidence, directory, ledger, records, save, saveRecord, check: () => verifyPreview(candidate, evidence, 'v0.2.1') };
}
test('explicit Preview fixture cannot authorize full candidate or stable distribution', () => {
  const sample = fixture(), result = sample.check();
  assert.equal(result.status, 'PREVIEW_READY'); assert.equal(result.fullAcceptance, false); assert.equal(result.stableReleaseAuthorized, false);
  copyFileSync(join(sample.evidence, 'preview.json'), join(sample.evidence, 'acceptance.json'));
  assert.equal(verifyCandidate(sample.candidate, sample.evidence, 'v0.2.1').status, 'BLOCKED');
});
test('each required Preview gate rejects missing, duplicate, non-PASS and wrong mode', () => {
  for (const id of Object.keys(PREVIEW_GATES)) for (const action of ['missing', 'duplicate', 'status', 'mode']) {
    const sample = fixture(), gate = sample.ledger.gates.find(entry => entry.id === id);
    if (action === 'missing') sample.ledger.gates = sample.ledger.gates.filter(entry => entry !== gate);
    if (action === 'duplicate') sample.ledger.gates.push(gate);
    if (action === 'status') gate.status = 'SKIPPED';
    if (action === 'mode') gate.mode = gate.mode === 'real' ? 'offline' : 'real';
    sample.save(); assert.equal(sample.check().status, 'BLOCKED', id + '/' + action);
  }
});
test('Preview fails closed for stale, forged scope, provenance, source, and omitted limitations', () => {
  for (const change of [
    sample => { sample.ledger.fullAcceptance = true; },
    sample => { sample.ledger.stableReleaseAuthorized = true; },
    sample => { sample.ledger.policy = 'skip-all'; },
    sample => { sample.ledger.sourceRevision = 'f'.repeat(40); },
    sample => { sample.ledger.ci.conclusion = 'failure'; },
    sample => { sample.ledger.ci.repository = 'other/repo'; },
    sample => { sample.ledger.candidateSha256 = 'f'.repeat(64); },
    sample => { sample.ledger.gates[0].observedAt = '2000-01-01T00:00:00Z'; },
    sample => { sample.ledger.gates[0].observedAt = '2099-01-01T00:00:00Z'; },
    sample => { sample.ledger.deferred.pop(); },
    sample => { sample.ledger.deferred[0].status = 'PASS'; },
    sample => { sample.ledger.limitations.pop(); },
    sample => { sample.ledger.limitations[0].status = 'CLOSED'; },
  ]) { const sample = fixture(); change(sample); sample.save(); assert.equal(sample.check().status, 'BLOCKED'); }
});
test('altered candidate, evidence, release notes and escaping paths cannot publish', () => {
  for (const change of [
    sample => writeFileSync(join(sample.candidate, 'polycode-runtime.zip'), 'altered'),
    sample => writeFileSync(join(sample.candidate, 'unexpected.txt'), 'extra'),
    sample => writeFileSync(join(sample.evidence, 'oauth-native.json'), '{}'),
    sample => { sample.ledger.gates[0].evidence.path = '../outside.json'; writeFileSync(join(sample.directory, 'outside.json'), '{}'); },
    sample => { const notes = 'Preview'; writeFileSync(join(sample.evidence, 'release-notes.md'), notes); sample.ledger.releaseNotes.sha256 = sha(notes); },
  ]) { const sample = fixture(); change(sample); sample.save(); assert.equal(sample.check().status, 'BLOCKED'); }
});
test('correct hashes cannot hide wrong actual observation facts', () => {
  for (const [id, key, value] of [
    ['host-install', 'cleanOS', true], ['oauth-native', 'loginCompleted', false], ['oauth-cursor', 'catalogObserved', false],
    ['coding-chatgpt', 'sameSessionResume', false], ['coding-cursor', 'shellExitCode', 1],
    ['offline-regression', 'failed', 1], ['native-tools', 'bridgeTokenLeaked', true], ['native-tools', 'fixtureErrors', 1],
  ]) { const sample = fixture(); sample.records[id].facts[key] = value; sample.saveRecord(id); sample.save(); assert.equal(sample.check().status, 'BLOCKED'); }
});

function publicationFixture() {
  const sample = fixture(), calls = [];
  const options = { candidate: sample.candidate, evidence: sample.evidence, version: 'v0.2.1', runId: '123',
    repository: 'Miku0139oao/Polycode', policyRevision: 'e'.repeat(40), output: join(sample.directory, 'publication') };
  let published = false;
  const invoke = args => {
    calls.push(args);
    if (args[0] === 'api') {
      const endpoint = args.at(-1);
      if (endpoint.includes('/actions/runs/')) return JSON.stringify({ id: 123, status: 'completed', conclusion: 'success', head_sha: source,
        head_repository: { full_name: options.repository }, path: '.github/workflows/candidate-release.yml', event: 'workflow_dispatch' });
      if (endpoint.includes('matching-refs')) return '[]';
      if (endpoint.includes('per_page')) return '[[]]';
      if (endpoint.includes('/git/ref/')) return JSON.stringify({ object: { type: 'commit', sha: source } });
      return JSON.stringify({ draft: !published, prerelease: true, tag_name: options.version, target_commitish: source,
        assets: PREVIEW_ASSETS.map(name => ({ name })), html_url: 'https://github.com/test/preview', published_at: new Date().toISOString() });
    }
    if (args[1] === 'download') for (const asset of PREVIEW_ASSETS) copyFileSync(join(sample.candidate, asset), join(args.at(-1), asset));
    if (args[1] === 'edit') published = true;
    return '';
  };
  return { sample, calls, options, invoke };
}
test('publisher verifies draft bytes before explicit non-Latest prerelease promotion', () => {
  const state = publicationFixture(), receipt = publishPreview(state.options, state.invoke);
  assert.equal(receipt.status, 'PREVIEW_READY');
  const mutations = state.calls.filter(args => args[0] === 'release');
  assert.deepEqual(mutations.map(args => args[1]), ['create', 'download', 'edit']);
  assert.ok(mutations[0].includes('--draft') && mutations[0].includes('--prerelease') && mutations[0].includes('--latest=false'));
  assert.ok(mutations[2].includes('--draft=false') && mutations[2].includes('--latest=false'));
});
test('publisher stops before mutations on API failures, existing tag/release, or wrong build', () => {
  for (const failure of ['api', 'tag', 'release', 'build']) {
    const state = publicationFixture();
    assert.throws(() => publishPreview(state.options, args => {
      if (failure === 'api') throw new Error('API unavailable');
      if (failure === 'tag' && args.at(-1).includes('matching-refs')) return '[{"ref":"refs/tags/v0.2.1"}]';
      if (failure === 'release' && args.at(-1).includes('per_page')) return '[[{"tag_name":"v0.2.1"}]]';
      if (failure === 'build' && args.at(-1).includes('/actions/runs/')) return '{}';
      return state.invoke(args);
    }));
    assert.ok(state.calls.every(args => args[0] !== 'release'));
  }
});
test('publisher leaves draft unpublished when downloaded assets differ', () => {
  const state = publicationFixture();
  assert.throws(() => publishPreview(state.options, args => {
    const response = state.invoke(args);
    if (args[0] === 'release' && args[1] === 'download') writeFileSync(join(args.at(-1), 'polycode-runtime.zip'), 'corrupt');
    return response;
  }), /draft bytes/);
  assert.ok(!state.calls.some(args => args[0] === 'release' && args[1] === 'edit'));
});
