// Synthetic policy fixtures ONLY: these PASS results are never application acceptance.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { verifyReadiness, REQUIRED_GATES } from '../release-readiness.mjs';
const root = mkdtempSync(join(tmpdir(), 'polycode-readiness-policy-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = value => createHash('sha256').update(value).digest('hex');
const put = (path, value) => writeFileSync(path, JSON.stringify(value));
let index = 0;
function fixture() {
  const candidate = mkdtempSync(join(root, 'candidate-'));
  const report = join(candidate, 'build-report.json'); put(report, { fixture: true });
  const raw = join(candidate, 'observation.txt'); writeFileSync(raw, 'SYNTHETIC POLICY FIXTURE, NOT LIVE EVIDENCE');
  const evidence = [{ path: raw, sha256: sha(readFileSync(raw)) }];
  const manifest = { schemaVersion: 1, status: 'unpublished-candidate', provenance: 'build-report', native: { sha256: 'a'.repeat(64), revision: 'b'.repeat(40), transformed: false, buildReportSha256: sha(readFileSync(report)), profile: { opt_level: '3', debug_assertions: false, test: false } }, artifacts: [] };
  for (const path of ['polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'install.ps1']) {
    const bytes = Buffer.from('synthetic ' + path); writeFileSync(join(candidate, path), bytes);
    manifest.artifacts.push({ path, bytes: bytes.length, sha256: sha(bytes) });
  }
  const manifestPath = join(candidate, 'manifest.json'); put(manifestPath, manifest);
  const candidateSha256 = sha(readFileSync(manifestPath));
  const acceptance = join(candidate, 'acceptance.json'), attestation = join(candidate, 'parent.json');
  const document = { schemaVersion: 1, candidateSha256, nativeSha256: manifest.native.sha256, gates: REQUIRED_GATES.map(id => ({ id, status: 'PASS', candidateSha256, nativeSha256: manifest.native.sha256, observedAt: new Date().toISOString(), mode: ['regression', 'hash-provenance', 'final-binary-profile'].includes(id) ? 'offline' : 'real', evidence: id === 'hash-provenance' ? [{ path: report, sha256: manifest.native.buildReportSha256 }] : evidence })) };
  const parent = { schemaVersion: 1, role: 'parent', reviewer: 'synthetic test parent', candidateSha256, reviewedAt: new Date().toISOString(), reviewedAllRequiredGates: true, publicationAuthorized: false, evidence };
  function save() {
    put(manifestPath, manifest);
    writeFileSync(join(candidate, 'SHA256SUMS'), [...manifest.artifacts.map(a => `${a.sha256}  ${a.path}`), `${sha(readFileSync(manifestPath))}  manifest.json`].join('\n') + '\n');
    put(acceptance, document); parent.acceptanceSha256 = sha(readFileSync(acceptance)); put(attestation, parent);
  }
  save(); index++;
  return { candidate, acceptance, attestation, manifest, document, parent, evidence, save };
}
function blocked(f, pattern) {
  const result = verifyReadiness(f); assert.equal(result.status, 'BLOCKED'); assert.equal(result.publicationAuthorized, false);
  assert.match(result.errors.join('\n'), pattern); return result;
}
test('complete synthetic policy fixture passes readiness only, never publication/public URL', () => {
  const result = verifyReadiness(fixture()); assert.equal(result.status, 'PASS', result.errors.join('\n'));
  assert.equal(result.publicationAuthorized, false); assert.equal(result.publicUrlGate, 'DEFERRED_UNTIL_PUBLICATION'); assert.equal(result.gates.length, REQUIRED_GATES.length);
});
test('missing candidate/acceptance/parent cannot pass', () => {
  blocked({}, /required/);
  for (const key of ['acceptance', 'attestation']) { const f = fixture(); rmSync(f[key]); blocked(f, /ENOENT/); }
});
test('partial or duplicated gate list cannot pass', () => {
  const f = fixture(); f.document.gates.pop(); f.save(); blocked(f, /partial/);
  const g = fixture(); g.document.gates[1] = g.document.gates[0]; g.save(); blocked(g, /duplicate/);
});
test('every required gate fails closed for FAIL, BLOCKED, MISSING, skipped and wrong case', () => {
  for (const id of REQUIRED_GATES) for (const status of ['FAIL', 'BLOCKED', 'MISSING', 'SKIPPED', 'pass']) {
    const f = fixture(); f.document.gates.find(g => g.id === id).status = status; f.save(); blocked(f, /PASS required/);
  }
});
test('stale candidate/native hashes rejected on document, each gate and parent', () => {
  for (const scope of ['document', 'gate', 'parent']) for (const field of scope === 'parent' ? ['candidateSha256'] : ['candidateSha256', 'nativeSha256']) {
    const f = fixture(); (scope === 'gate' ? f.document.gates[0] : f[scope])[field] = 'c'.repeat(64); f.save(); blocked(f, /[Ss]tale/);
  }
});
test('mock or fixture evidence never counts as real OAuth/Task/billing/browser/installed acceptance', () => {
  for (const mode of ['mock', 'fixture', 'offline']) { const f = fixture(); f.document.gates[0].mode = mode; f.save(); blocked(f, /mocks\/fixtures/); }
});
test('missing, empty, changed evidence and stale observations fail', () => {
  for (const change of ['missing', 'empty', 'changed', 'stale']) {
    const f = fixture(), gate = f.document.gates[0];
    if (change === 'missing') gate.evidence = [];
    if (change === 'empty') writeFileSync(f.evidence[0].path, '');
    if (change === 'changed') writeFileSync(f.evidence[0].path, 'changed');
    if (change === 'stale') gate.observedAt = '2000-01-01T00:00:00Z';
    f.save(); blocked(f, /[Ee]vidence|stale/);
  }
});
test('manifest or asset byte changes invalidate acceptance', () => {
  const f = fixture(); writeFileSync(join(f.candidate, 'polycode-runtime.zip'), 'tampered'); blocked(f, /checksum/);
  const g = fixture(); g.manifest.changed = true; g.save(); blocked(g, /Stale/);
});
test('parent must review exact acceptance and cannot turn review into authorization', () => {
  const f = fixture(); f.parent.publicationAuthorized = true; f.save(); blocked(f, /attestation/);
  const g = fixture(); put(g.attestation, { ...g.parent, acceptanceSha256: 'd'.repeat(64) }); blocked(g, /attestation/);
});
test('development profile is rejected even when a claimed gate says PASS', () => {
  const f = fixture(); f.manifest.native.profile = { opt_level: '0', debug_assertions: true, test: false }; f.save();
  const current = sha(readFileSync(join(f.candidate, 'manifest.json')));
  f.document.candidateSha256 = current; f.parent.candidateSha256 = current;
  f.document.gates.forEach(g => { g.candidateSha256 = current; }); f.save(); blocked(f, /Development binary/);
});
test('fixture-unattested manifests cannot pass', () => {
  const f = fixture(); f.manifest.provenance = 'fixture-unattested'; f.save(); blocked(f, /provenance-attested/);
});
