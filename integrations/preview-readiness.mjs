import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export const PREVIEW_POLICY = 'polycode-preview-2026-09-08.1';
export const PREVIEW_GATES = Object.freeze({
  'host-install': 'real',
  'oauth-native': 'real',
  'oauth-chatgpt': 'real',
  'oauth-cursor': 'real',
  'coding-chatgpt': 'real',
  'coding-cursor': 'real',
  'offline-regression': 'offline',
  'native-tools': 'offline',
});
export const PREVIEW_DEFERRED = Object.freeze(['generation-native', 'windows10-clean-install', 'windows11-clean-install']);
export const PREVIEW_LIMITATIONS = Object.freeze(['cursor-timeout-restart', 'server2025-incomplete']);
export const PREVIEW_ASSETS = Object.freeze(['SHA256SUMS', 'install.ps1', 'manifest.json', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'polycode-windows-x64.gz']);
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
function requireThat(value, message) { if (!value) throw new Error(message); }
function exactSet(actual, expected, label) {
  requireThat(Array.isArray(actual) && actual.length === expected.length && new Set(actual).size === expected.length &&
    actual.every(value => expected.includes(value)), 'Invalid ' + label);
}
function fresh(value, now) {
  const timestamp = Date.parse(value);
  requireThat(typeof value === 'string' && Number.isFinite(timestamp) && timestamp <= now + 60000 && now - timestamp <= 7 * 86400000, 'Stale or invalid observation');
}
function evidenceFile(root, entry) {
  requireThat(entry && typeof entry.path === 'string' && !isAbsolute(entry.path) && !entry.path.includes('\\') &&
    /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid evidence reference');
  const file = realpathSync(resolve(root, entry.path));
  const rel = relative(root, file);
  requireThat(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) && statSync(file).isFile(), 'Evidence escapes directory');
  requireThat(statSync(file).size > 0 && sha(readFileSync(file)) === entry.sha256, 'Evidence bytes changed');
  return file;
}
function checkFacts(id, facts) {
  requireThat(facts && typeof facts === 'object', 'Missing observed facts');
  if (id === 'host-install') {
    requireThat(facts.os === 'Windows 11' && Number.isInteger(facts.build) && facts.build >= 22000 && facts.cleanOS === false &&
      facts.nativeHashVerified === true && facts.bundleHashVerified === true, 'Host identity not verified');
    exactSet(facts.providers?.map(provider => provider.id), ['native', 'codex', 'cursor'], 'host providers');
    requireThat(facts.providers.every(provider => provider.exitCode === 0 && provider.forcedExit === false &&
      provider.menu === true && provider.alternateScreenRestored === true), 'Host lifecycle did not pass');
  } else if (id.startsWith('oauth-')) {
    requireThat(facts.loginCompleted === true && facts.exitCode === 0 && facts.forcedExit === false, 'OAuth did not pass');
    if (id !== 'oauth-native') requireThat(facts.catalogObserved === true, 'Catalog not observed');
    else requireThat(facts.generationRequests === 0, 'Preview native observation must be login only');
  } else if (id.startsWith('coding-')) {
    const prefix = id === 'coding-chatgpt' ? 'codex/' : 'cursor/';
    requireThat(typeof facts.model === 'string' && facts.model.startsWith(prefix) && facts.model.length > prefix.length &&
      facts.generationCompleted === true && facts.readObserved === true && facts.writeCalls === 1 && facts.shellCalls === 1 &&
      facts.shellExitCode === 0 && facts.exactFileBytes === true && facts.sameSessionResume === true &&
      facts.freshResumeRead === true && facts.normalExits === 2 && facts.forcedExit === false, 'Coding/resume did not pass');
  } else if (id === 'offline-regression') {
    requireThat(Number.isInteger(facts.nodePassed) && Number.isInteger(facts.bunPassed) &&
      facts.nodePassed >= 177 && facts.bunPassed >= 140 && facts.failed === 0 && facts.skipped === 0 &&
      facts.permissionRegression === true && facts.transport === 'synthetic', 'Offline regression did not pass');
  } else if (id === 'native-tools') {
    requireThat(facts.transport === 'synthetic' && facts.actualNativeTools === true && facts.mcpCalls === 2 &&
      facts.bridgeTokenLeaked === false && facts.cancelledStreams === 1 && facts.freshResumeRead === true &&
      facts.slowShell === true && facts.forcedExit === false && facts.fixtureErrors === 0, 'Native tools did not pass');
    for (const provider of ['codex', 'cursor']) {
      requireThat(facts.shellCalls?.[provider] === 1 && facts.tasks?.[provider]?.childCalls === 1 &&
        facts.tasks[provider].verified === true, 'Native shell/Task observations missing');
    }
  }
}

export function verifyPreview(candidate, evidence, version, now = Date.now()) {
  try {
    requireThat(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version), 'Invalid version');
    exactSet(readdirSync(candidate), PREVIEW_ASSETS, 'candidate inventory');
    const manifestFile = resolve(candidate, 'manifest.json');
    const manifest = json(manifestFile), identity = sha(readFileSync(manifestFile));
    requireThat(manifest.schemaVersion === 3 && manifest.classification === 'immutable-candidate' &&
      manifest.provenance === 'build-report' && manifest.version === version && manifest.platform === 'windows' &&
      manifest.target === 'x86_64-pc-windows-msvc' && manifest.executableFormat === 'PE32+' &&
      manifest.native?.transformed === false && /^[a-f0-9]{40}$/.test(manifest.native.revision) &&
      /^[a-f0-9]{64}$/.test(manifest.native.sha256) && /^[a-f0-9]{64}$/.test(manifest.bun?.sha256), 'Invalid candidate provenance');
    requireThat(['2', '3', 's', 'z'].includes(String(manifest.native.profile?.opt_level)) &&
      manifest.native.profile.debug_assertions === false && manifest.native.profile.test === false, 'Release profile required');
    const search = manifest.files?.filter(file => file.path === 'vendor/rg.exe');
    requireThat(search?.length === 1 && search[0].bytes === 4265472 &&
      search[0].sha256 === 'a286ea6f4d0d8c1c6c2234728cf2d96afcf371c550086c11e1ea28730dcfb418', 'Pinned search dependency required');
    const assets = PREVIEW_ASSETS.filter(name => !['manifest.json', 'SHA256SUMS'].includes(name));
    exactSet(manifest.artifacts?.map(asset => asset.path), assets, 'artifact inventory');
    const sums = new Map();
    for (const line of readFileSync(resolve(candidate, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
      const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
      requireThat(match && !sums.has(match[2]), 'Invalid checksums');
      sums.set(match[2], match[1]);
    }
    exactSet([...sums.keys()], [...assets, 'manifest.json'], 'checksum inventory');
    requireThat(sums.get('manifest.json') === identity, 'Manifest checksum mismatch');
    for (const asset of manifest.artifacts) {
      const file = resolve(candidate, asset.path);
      requireThat(statSync(file).isFile() && statSync(file).size === asset.bytes && sha(readFileSync(file)) === asset.sha256 &&
        sums.get(asset.path) === asset.sha256, 'Candidate bytes changed');
    }
    const root = realpathSync(evidence), ledger = json(resolve(root, 'preview.json'));
    requireThat(ledger.schemaVersion === 1 && ledger.kind === 'polycode-preview-evidence' && ledger.policy === PREVIEW_POLICY &&
      ledger.version === version && ledger.fullAcceptance === false && ledger.stableReleaseAuthorized === false &&
      ledger.candidateSha256 === identity && ledger.nativeSha256 === manifest.native.sha256 &&
      ledger.sourceRevision === manifest.native.revision, 'Preview identity/scope mismatch');
    requireThat(ledger.ci?.repository === 'Miku0139oao/Polycode' && /^[0-9]+$/.test(ledger.ci.runId) &&
      ledger.ci.conclusion === 'success' && ledger.ci.sourceRevision === manifest.native.revision, 'Successful source-bound CI required');
    exactSet(ledger.deferred?.map(gate => gate.id), PREVIEW_DEFERRED, 'deferred gates');
    requireThat(ledger.deferred.every(gate => gate.status === 'NOT_VERIFIED' && typeof gate.reason === 'string' && gate.reason.trim().length > 15), 'Deferred gates cannot become PASS');
    exactSet(ledger.limitations?.map(issue => issue.id), PREVIEW_LIMITATIONS, 'known limitations');
    requireThat(ledger.limitations.every(issue => issue.status === 'OPEN' && typeof issue.description === 'string' && issue.description.trim().length > 15), 'Known limitations must remain disclosed');
    const notes = readFileSync(evidenceFile(root, ledger.releaseNotes), 'utf8');
    for (const phrase of ['Preview', 'not a stable release', ...PREVIEW_DEFERRED, ...PREVIEW_LIMITATIONS]) {
      requireThat(notes.includes(phrase), 'Release notes omit scope or limitation');
    }
    exactSet(ledger.gates?.map(gate => gate.id), Object.keys(PREVIEW_GATES), 'preview gates');
    for (const gate of ledger.gates) {
      requireThat(gate.status === 'PASS' && gate.mode === PREVIEW_GATES[gate.id], 'Actual gate mode and PASS required');
      fresh(gate.observedAt, now);
      const record = json(evidenceFile(root, gate.evidence));
      requireThat(record.kind === 'sanitized-observation' && record.gate === gate.id && record.mode === gate.mode &&
        record.observedAt === gate.observedAt && record.candidateSha256 === identity &&
        record.nativeSha256 === manifest.native.sha256 && record.sourceRevision === manifest.native.revision, 'Observation identity mismatch');
      requireThat(Array.isArray(record.sourceEvidenceSha256) && record.sourceEvidenceSha256.length > 0 &&
        record.sourceEvidenceSha256.every(hash => /^[a-f0-9]{64}$/.test(hash)), 'Source evidence hashes required');
      checkFacts(gate.id, record.facts);
    }
    return { status: 'PREVIEW_READY', policy: PREVIEW_POLICY, fullAcceptance: false, stableReleaseAuthorized: false,
      candidateSha256: identity, nativeSha256: manifest.native.sha256, sourceRevision: manifest.native.revision,
      candidateRunId: ledger.ci.runId, repository: ledger.ci.repository, evidenceSha256: sha(readFileSync(resolve(root, 'preview.json'))) };
  } catch (error) {
    return { status: 'BLOCKED', reason: error.code ? 'Required evidence or artifact is unavailable' : error.message,
      fullAcceptance: false, stableReleaseAuthorized: false };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyPreview(...process.argv.slice(2, 5));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PREVIEW_READY' ? 0 : 1;
}
