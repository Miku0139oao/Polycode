// Local, fail-closed evidence verifier. NEVER publishes or grants permission to publish.
// Node >=20, no dependencies/network. Candidate identity = SHA256 of manifest.json bytes.
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { resolve, dirname, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
export const POLICY_VERSION = '2026-09-07.2';
export const REQUIRED_GATES = Object.freeze([
  'oauth-chatgpt', 'oauth-cursor',
  'task-inherit-chatgpt', 'task-result-chatgpt', 'task-resume-chatgpt',
  'task-inherit-cursor', 'task-result-cursor', 'task-resume-cursor',
  'session-resume-chatgpt', 'session-resume-cursor',
  'prompt-identity-native', 'prompt-identity-chatgpt', 'prompt-identity-cursor',
  'native-reasoning-effort-capability', 'native-reasoning-effort-ui',
  'native-reasoning-effort-wire', 'native-reasoning-effort-inheritance', 'native-reasoning-effort-resume',
  'busy-queued-model-switch-safe-commit',
  'tool-reject', 'tool-allow-once', 'native-billing-deny', 'native-billing-allow',
  'browser-handoff', 'installed-entrypoint', 'provider-aware-usage', 'tui-branding',
  'regression', 'hash-provenance', 'final-binary-profile',
]);
const OFFLINE_GATES = new Set(['regression', 'hash-provenance', 'final-binary-profile']);
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const requireThat = (value, message) => { if (!value) throw new Error(message); };
function fresh(time, now) {
  const stamp = Date.parse(time);
  return Number.isFinite(stamp) && stamp <= now + 60000 && now - stamp <= 7 * 24 * 60 * 60 * 1000;
}
function evidenceFiles(evidence, base) {
  requireThat(Array.isArray(evidence) && evidence.length > 0, 'Missing actual evidence files');
  for (const file of evidence) {
    requireThat(typeof file.path === 'string' && file.path.length > 0 && /^[a-f0-9]{64}$/.test(file.sha256), 'Malformed evidence reference');
    const path = isAbsolute(file.path) ? file.path : resolve(base, file.path);
    requireThat(statSync(path).isFile() && statSync(path).size > 0 && sha(readFileSync(path)) === file.sha256, `Evidence missing/changed: ${file.path}`);
  }
}
export function verifyReadiness({ candidate, acceptance, attestation, now = Date.now() }) {
  const output = { schemaVersion: 2, kind: 'polycode-readiness', policyVersion: POLICY_VERSION, checkedAt: new Date(now).toISOString(), status: 'BLOCKED', publicationAuthorized: false, publicUrlGate: 'DEFERRED_UNTIL_PUBLICATION', errors: [], gates: [] };
  try {
    requireThat(candidate && acceptance && attestation, 'Candidate, acceptance and parent attestation paths are all required');
    const manifestPath = resolve(candidate, 'manifest.json');
    const candidateSha256 = sha(readFileSync(manifestPath));
    output.candidateSha256 = candidateSha256;
    const manifest = json(manifestPath);
    requireThat([2, 3].includes(manifest.schemaVersion) && manifest.classification === 'immutable-candidate' && !Object.hasOwn(manifest, 'status') && manifest.provenance === 'build-report', 'Not a provenance-attested immutable candidate (legacy v1 preparation is not promotable)');
    output.nativeSha256 = manifest.native?.sha256;
    output.acceptanceSha256 = sha(readFileSync(acceptance));
    output.parentAttestationSha256 = sha(readFileSync(attestation));
    requireThat(/^[a-f0-9]{64}$/.test(manifest.native?.sha256) && /^[a-f0-9]{40}$/.test(manifest.native?.revision) && manifest.native?.transformed === false, 'Missing exact native provenance');
    if (manifest.schemaVersion === 3) requireThat(manifest.platform === 'windows' && manifest.target === 'x86_64-pc-windows-msvc' && manifest.executableFormat === 'PE32+', 'Invalid Windows candidate target');
    const assets = manifest.schemaVersion === 3 ? ['install.ps1', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'polycode-windows-x64.gz'] : ['install.ps1', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'polycode-wsl-x64.gz'];
    requireThat(Array.isArray(manifest.artifacts) && JSON.stringify(manifest.artifacts.map(a => a.path).sort()) === JSON.stringify(assets), 'Incomplete/duplicate/unsafe asset inventory');
    const sums = new Map();
    for (const line of readFileSync(resolve(candidate, 'SHA256SUMS'), 'ascii').trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
      requireThat(match && !sums.has(match[2]), 'Malformed/duplicate SHA256SUMS'); sums.set(match[2], match[1]);
    }
    requireThat(sums.size === 5 && sums.get('manifest.json') === candidateSha256, 'Manifest checksum mismatch');
    for (const asset of manifest.artifacts) {
      const path = resolve(candidate, asset.path);
      requireThat(statSync(path).size === asset.bytes && sha(readFileSync(path)) === asset.sha256 && sums.get(asset.path) === asset.sha256, `Asset checksum mismatch: ${asset.path}`);
    }
    const document = json(acceptance);
    requireThat(document.schemaVersion === 1 && document.candidateSha256 === candidateSha256 && document.nativeSha256 === manifest.native.sha256, 'Stale/missing candidate or native hash in acceptance');
    requireThat(Array.isArray(document.gates) && document.gates.length === REQUIRED_GATES.length && new Set(document.gates.map(g => g.id)).size === REQUIRED_GATES.length, 'Missing/partial/duplicate acceptance gates');
    for (const id of REQUIRED_GATES) {
      const gate = document.gates.find(g => g.id === id);
      const check = { id, status: gate?.status ?? 'MISSING' }; output.gates.push(check);
      try {
        requireThat(gate && gate.status === 'PASS', `${id}: ${gate?.status ?? 'MISSING'} (PASS required)`);
        requireThat(gate.candidateSha256 === candidateSha256 && gate.nativeSha256 === manifest.native.sha256, `${id}: stale candidate/native hash`);
        requireThat(fresh(gate.observedAt, now), `${id}: stale/invalid observation time`);
        requireThat(gate.mode === (OFFLINE_GATES.has(id) ? 'offline' : 'real'), `${id}: mocks/fixtures are not real acceptance`);
        evidenceFiles(gate.evidence, dirname(resolve(acceptance)));
        if (id === 'final-binary-profile') {
          const profile = manifest.native.profile;
          requireThat(profile && ['2', '3', 's', 'z'].includes(String(profile.opt_level)) && profile.debug_assertions === false && profile.test === false, 'Development binary is not release optimized; rebuild and reaccept a new candidate before release');
        }
        if (id === 'hash-provenance') requireThat(gate.evidence.some(e => e.sha256 === manifest.native.buildReportSha256), 'hash-provenance must include the exact original build report');
        check.verified = true;
      } catch (error) { check.verified = false; output.errors.push(error.message); }
    }
    const parent = json(attestation);
    requireThat(parent.schemaVersion === 1 && parent.role === 'parent' && typeof parent.reviewer === 'string' && parent.reviewer.trim().length > 0 && parent.candidateSha256 === candidateSha256 && parent.acceptanceSha256 === sha(readFileSync(acceptance)) && parent.reviewedAllRequiredGates === true && parent.publicationAuthorized === false && fresh(parent.reviewedAt, now), 'Missing/invalid/stale parent attestation (review does not authorize publication)');
    evidenceFiles(parent.evidence, dirname(resolve(attestation)));
    if (!output.errors.length) output.status = 'PASS';
  } catch (error) { output.errors.push(error.message); }
  return output;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), options = {};
  try {
    for (let i = 0; i < args.length; i += 2) {
      requireThat(['--candidate', '--acceptance', '--attestation', '--output'].includes(args[i]) && args[i + 1] && !options[args[i].slice(2)], 'Usage: node integrations/release-readiness.mjs --candidate DIR --acceptance FILE --attestation FILE [--output FILE]');
      options[args[i].slice(2)] = args[i + 1];
    }
    const result = verifyReadiness(options), text = JSON.stringify(result, null, 2) + '\n';
    if (options.output) writeFileSync(options.output, text, { flag: 'wx' });
    console.log(text); process.exitCode = result.status === 'PASS' ? 0 : 1;
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
