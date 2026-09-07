// Prerelease gate, separate from stable distribution authorization.
// Never builds, repacks, installs, publishes or performs provider requests.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
export const CANDIDATE_GATES = Object.freeze([
  'windows10-clean-install', 'windows11-clean-install', 'windows-terminal-lifecycle',
  'oauth-native', 'oauth-chatgpt', 'oauth-cursor',
  'generation-native', 'generation-chatgpt', 'generation-cursor',
  'coding-chatgpt', 'coding-cursor', 'session-resume',
  'task-mcp-regression', 'billing-permission-regression',
]);
const offline = new Set(['task-mcp-regression', 'billing-permission-regression']);
const assets = ['install.ps1', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'polycode-windows-x64.gz'];
const sha = value => createHash('sha256').update(value).digest('hex');
const json = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
function requireThat(value, message) { if (!value) throw new Error(message); }
export function verifyCandidate(candidate, evidence, version, now = Date.now()) {
  try {
    requireThat(/^v[0-9]+\.[0-9]+\.[0-9]+$/.test(version), 'Invalid version');
    const manifestPath = resolve(candidate, 'manifest.json');
    const manifest = json(manifestPath), identity = sha(readFileSync(manifestPath));
    requireThat(manifest.schemaVersion === 3 && manifest.version === version && manifest.platform === 'windows' &&
      manifest.target === 'x86_64-pc-windows-msvc' && manifest.executableFormat === 'PE32+' &&
      manifest.classification === 'immutable-candidate' && manifest.provenance === 'build-report' &&
      manifest.native?.transformed === false && /^[a-f0-9]{40}$/.test(manifest.native?.revision) &&
      /^[a-f0-9]{64}$/.test(manifest.native?.sha256), 'Invalid Windows candidate identity/provenance');
    requireThat(['2', '3', 's', 'z'].includes(String(manifest.native.profile?.opt_level)) &&
      manifest.native.profile?.debug_assertions === false && manifest.native.profile?.test === false, 'Release profile required');
    const search = (Array.isArray(manifest.files) ? manifest.files : []).filter(file => file?.path === 'vendor/rg.exe');
    requireThat(search.length === 1 && search[0].bytes === 4265472 &&
      search[0].sha256 === 'a286ea6f4d0d8c1c6c2234728cf2d96afcf371c550086c11e1ea28730dcfb418',
      'Pinned Windows search dependency is missing or changed');
    requireThat(JSON.stringify(readdirSync(candidate).sort()) === JSON.stringify([...assets, 'manifest.json', 'SHA256SUMS'].sort()), 'Unexpected or missing candidate assets');
    requireThat(Array.isArray(manifest.artifacts) && JSON.stringify(manifest.artifacts.map(a => a.path).sort()) === JSON.stringify(assets), 'Invalid asset inventory');
    const sums = new Map();
    for (const line of readFileSync(resolve(candidate, 'SHA256SUMS'), 'utf8').trim().split(/\r?\n/)) {
      const m = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line);
      requireThat(m && !sums.has(m[2]), 'Invalid checksums');
      sums.set(m[2], m[1]);
    }
    requireThat(sums.size === 5 && sums.get('manifest.json') === identity, 'Manifest checksum mismatch');
    for (const asset of manifest.artifacts) {
      const file = resolve(candidate, asset.path);
      requireThat(statSync(file).size === asset.bytes && sha(readFileSync(file)) === asset.sha256 && sums.get(asset.path) === asset.sha256, 'Asset bytes changed');
    }
    const root = realpathSync(evidence);
    const acceptance = json(resolve(root, 'acceptance.json'));
    requireThat(acceptance.schemaVersion === 1 && acceptance.candidateSha256 === identity &&
      acceptance.nativeSha256 === manifest.native.sha256, 'Acceptance is missing or belongs to different bytes');
    requireThat(Array.isArray(acceptance.gates) && acceptance.gates.length === CANDIDATE_GATES.length &&
      new Set(acceptance.gates.map(g => g.id)).size === CANDIDATE_GATES.length, 'Missing or duplicate acceptance gates');
    for (const id of CANDIDATE_GATES) {
      const gate = acceptance.gates.find(g => g.id === id);
      requireThat(gate?.status === 'PASS' && gate.mode === (offline.has(id) ? 'offline' : 'real'), id + ': actual PASS evidence required');
      const time = Date.parse(gate.observedAt);
      requireThat(Number.isFinite(time) && time <= now + 60000 && now - time <= 7 * 86400000, id + ': stale observation');
      requireThat(Array.isArray(gate.evidence) && gate.evidence.length > 0, id + ': missing evidence');
      for (const entry of gate.evidence) {
        requireThat(typeof entry.path === 'string' && !isAbsolute(entry.path) && /^[a-f0-9]{64}$/.test(entry.sha256), 'Invalid evidence reference');
        const file = realpathSync(resolve(root, entry.path)), rel = relative(root, file);
        requireThat(rel !== '' && !rel.startsWith('..') && !isAbsolute(rel), 'Evidence escapes acceptance directory');
        requireThat(statSync(file).isFile() && statSync(file).size > 0 && sha(readFileSync(file)) === entry.sha256, id + ': evidence changed');
      }
    }
    return { status: 'PASS', candidateSha256: identity, nativeSha256: manifest.native.sha256, stableReleaseAuthorized: false };
  } catch (error) {
    return { status: 'BLOCKED', reason: error.code ? 'Required evidence or artifact is unavailable' : error.message, stableReleaseAuthorized: false };
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = verifyCandidate(...process.argv.slice(2, 5));
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.status === 'PASS' ? 0 : 1;
}
