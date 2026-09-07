import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { CANDIDATE_GATES, verifyCandidate } from '../candidate-readiness.mjs';
const root = mkdtempSync(join(tmpdir(), 'windows-candidate-gates-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = b => createHash('sha256').update(b).digest('hex');
function fixture() {
  const candidate = mkdtempSync(join(root, 'candidate-')), evidence = mkdtempSync(join(root, 'evidence-'));
  const paths = ['install.ps1', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'polycode-windows-x64.gz'];
  const manifest = { schemaVersion: 3, version: 'v0.2.1', platform: 'windows', target: 'x86_64-pc-windows-msvc',
    executableFormat: 'PE32+', classification: 'immutable-candidate', provenance: 'build-report',
    native: { transformed: false, revision: 'a'.repeat(40), sha256: 'b'.repeat(64), profile: { opt_level: '3', debug_assertions: false, test: false } },
    artifacts: paths.map(path => { const bytes = Buffer.from('SYNTHETIC POLICY FIXTURE ' + path); writeFileSync(join(candidate,path), bytes); return { path, bytes: bytes.length, sha256: sha(bytes) }; }),
  };
  const text = JSON.stringify(manifest);
  writeFileSync(join(candidate,'manifest.json'), text);
  writeFileSync(join(candidate,'SHA256SUMS'), manifest.artifacts.map(a => a.sha256 + '  ' + a.path).concat(sha(text) + '  manifest.json').join('\n'));
  const observation = 'SYNTHETIC POLICY TEST. NOT LIVE ACCEPTANCE.';
  writeFileSync(join(evidence,'observation.txt'), observation);
  const acceptance = { schemaVersion: 1, candidateSha256: sha(text), nativeSha256: manifest.native.sha256,
    gates: CANDIDATE_GATES.map(id => ({ id, status: 'PASS', mode: ['task-mcp-regression','billing-permission-regression'].includes(id) ? 'offline' : 'real',
      observedAt: new Date().toISOString(), evidence: [{path:'observation.txt',sha256:sha(observation)}] })),
  };
  const save = () => writeFileSync(join(evidence,'acceptance.json'),JSON.stringify(acceptance)); save();
  return { candidate, evidence, acceptance, save, check: () => verifyCandidate(candidate,evidence,'v0.2.1') };
}
test('prerelease policy passes a complete synthetic fixture without stable authorization', () => {
  const result = fixture().check(); assert.equal(result.status,'PASS'); assert.equal(result.stableReleaseAuthorized,false);
});
test('every gate requires its actual mode and PASS, including native generation', () => {
  for (const id of CANDIDATE_GATES) for (const state of ['BLOCKED','SKIPPED','FAIL']) {
    const f=fixture(); f.acceptance.gates.find(g=>g.id===id).status=state; f.save(); assert.equal(f.check().status,'BLOCKED');
  }
  const f=fixture(); f.acceptance.gates.find(g=>g.id==='generation-native').mode='offline'; f.save(); assert.equal(f.check().status,'BLOCKED');
});
test('stale, missing, replaced and escaped evidence cannot publish', () => {
  for (const change of [
    f => { f.acceptance.candidateSha256='f'.repeat(64); f.save(); },
    f => { f.acceptance.gates.pop(); f.save(); },
    f => { f.acceptance.gates[0].observedAt='2000-01-01T00:00:00Z'; f.save(); },
    f => { writeFileSync(join(f.evidence,'observation.txt'),'changed'); },
    f => { writeFileSync(join(f.candidate,'polycode-windows-x64.gz'),'changed'); },
    f => { f.acceptance.gates[0].evidence[0].path='../outside.txt'; writeFileSync(join(root,'outside.txt'),'outside'); f.save(); },
  ]) { const f=fixture(); change(f); assert.equal(f.check().status,'BLOCKED'); }
});
