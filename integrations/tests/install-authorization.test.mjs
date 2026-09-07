// Offline synthetic JSON-shape regression matrix, no WSL/build/network/install.
// Executes the production functions extracted with PowerShell's AST, unchanged.
// Full remote-mode exact-byte installs are covered by install-native.test.mjs.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { REQUIRED_GATES, POLICY_VERSION } from '../release-readiness.mjs';
const source = fileURLToPath(new URL('../../install.ps1', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polycode-json-shape-'));
after(() => rmSync(root, { recursive: true, force: true }));
const sha = value => createHash('sha256').update(value).digest('hex');
const put = (name, value) => writeFileSync(join(root, name), value);
const runner = join(root, 'validator.ps1');
writeFileSync(runner, `param([string]$Source, [string]$Root, [switch]$LegacyDateParser)
$ErrorActionPreference = 'Stop'
if ($LegacyDateParser) {
    # Force the pre-7.5 feature-detection branch on the installed PS7. Production
    # parsing/type/auth functions remain byte-identical; no validator is mocked.
    function Get-Command([string]$Name) {
        if ($Name -cne 'ConvertFrom-Json') { throw 'Unexpected feature probe' }
        return [PSCustomObject]@{ Parameters = @{} }
    }
}
$tokens = $null; $parseErrors = $null
$ast = [Management.Automation.Language.Parser]::ParseFile($Source, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$helper = Join-Path $Root 'install.ps1'
$helperAst = [Management.Automation.Language.Parser]::ParseFile($helper, [ref]$tokens, [ref]$parseErrors)
if ($parseErrors.Count) { throw ($parseErrors | Out-String) }
$names = @('Get-Sha256', 'Convert-JsonToken', 'Convert-JsonWithoutDateCoercion', 'Read-JsonObject', 'Assert-CandidateManifest', 'Assert-DistributionAuthorization', 'Assert-JsonObject', 'Assert-JsonArray', 'Assert-JsonString', 'Assert-JsonBoolean', 'Assert-JsonInteger', 'Assert-JsonHash')
foreach ($name in $names) {
    $nodes = @($ast.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $false))
    if ($nodes.Count -ne 1) { throw "Missing/duplicate production function: $name" }
    $copy = @($helperAst.FindAll({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name }, $false))
    if ($copy.Count -ne 1 -or $copy[0].Extent.Text -cne $nodes[0].Extent.Text) { throw "Modified extracted production function: $name" }
}
. $helper
foreach ($name in @('releasePolicyVersion', 'requiredReleaseGates')) {
    $node = $ast.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -ceq ('$' + $name) }, $false)
    if (-not $node) { throw "Missing production policy: $name" }
    Invoke-Expression $node.Extent.Text
}
$Version = 'v0.2.0'; $temp = $Root
$cases = (Read-JsonObject (Join-Path $Root 'cases.json')).cases
$passed = 0
foreach ($case in $cases) {
    [IO.File]::WriteAllText((Join-Path $Root 'manifest.json'), $case.manifest)
    [IO.File]::WriteAllText((Join-Path $Root 'release-readiness.json'), $case.readiness)
    [IO.File]::WriteAllText((Join-Path $Root 'release-authorization.json'), $case.authorization)
    $failure = $null
    try {
        $manifest = Read-JsonObject (Join-Path $Root 'manifest.json')
        if ($case.inner) { Assert-CandidateManifest $manifest $false }
        else { Assert-DistributionAuthorization $manifest (Get-Sha256 (Join-Path $Root 'manifest.json')) }
    } catch { $failure = $_.Exception.Message }
    if ($case.error) {
        if (-not $failure -or $failure -notmatch $case.error) { throw "Case $($case.id) expected $($case.error); got: $failure" }
    } elseif ($failure) { throw "Valid control $($case.id) failed: $failure" }
    $passed++
}
Write-Output ("PS " + $PSVersionTable.PSVersion + " legacyDateParser=" + $LegacyDateParser + ": " + $passed + " JSON-shape/control cases PASS; no install/network/build")
`);
// Put verbatim production functions in a real file, not inline scriptblocks, so
// their real PSCommandPath/self-hash check executes too. The runner verifies each
// function against the production AST before dot-sourcing this synthetic asset.
const installerSource = readFileSync(source, 'utf8');
put('install.ps1', installerSource.slice(installerSource.indexOf('function Get-Sha256('), installerSource.indexOf('function Quote-Argument(')));
put('SHA256SUMS', 'SYNTHETIC validator-only checksum bytes, not a distributable package\n');
const paths = ['install.ps1', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'polycode-wsl-x64.gz'];
for (const path of paths.slice(1)) put(path, 'SYNTHETIC validator-only asset ' + path);
const manifest = { schemaVersion: 2, classification: 'immutable-candidate', provenance: 'build-report', version: 'v0.2.0',
  architecture: 'x86_64', minimumGlibc: '2.43', protocol: 'native-model-bridge',
  native: { sha256: 'a'.repeat(64), bytes: 42, transformed: false, profile: { opt_level: '2', debug_assertions: false, test: false } },
  bun: { sha256: 'b'.repeat(64), bytes: 42, version: '1.3.14' },
  files: [{ path: 'release-manifest.json', sha256: 'c'.repeat(64), bytes: 0 }],
  artifacts: paths.map(path => { const bytes = readFileSync(join(root, path)); return { path, sha256: sha(bytes), bytes: bytes.length }; }),
};
const now = new Date().toISOString();
const ready = { schemaVersion: 2, kind: 'polycode-readiness', policyVersion: POLICY_VERSION, checkedAt: now, status: 'PASS',
  publicationAuthorized: false, publicUrlGate: 'DEFERRED_UNTIL_PUBLICATION', errors: [], gates: REQUIRED_GATES.map(id => ({ id, status: 'PASS', verified: true })),
  candidateSha256: '', nativeSha256: manifest.native.sha256, acceptanceSha256: 'd'.repeat(64), parentAttestationSha256: 'e'.repeat(64),
};
const authorization = { schemaVersion: 1, kind: 'polycode-distribution-authorization', scope: 'public-distribution', decision: 'AUTHORIZED', version: 'v0.2.0',
  candidateSha256: '', nativeSha256: manifest.native.sha256, checksumsSha256: sha(readFileSync(join(root, 'SHA256SUMS'))), readinessSha256: '',
  acceptanceSha256: ready.acceptanceSha256, parentAttestationSha256: ready.parentAttestationSha256,
  parent: { role: 'parent', reviewer: 'SYNTHETIC TEST ONLY; NOT PARENT AUTHORITY', authorizedAt: now },
};
const get = (value, path) => path.reduce((object, key) => object[key], value);
function set(value, path, replacement) {
  if (!path.length) return replacement;
  const parent = get(value, path.slice(0, -1));
  if (replacement === undefined) delete parent[path.at(-1)];
  else parent[path.at(-1)] = replacement;
  return value;
}
const cases = [];
function add(id, target, path, value, error = '^Invalid JSON shape:', inner = false) {
  let m = structuredClone(manifest), r = structuredClone(ready), a = structuredClone(authorization);
  if (target === 'manifest') m = set(m, path, value);
  const manifestText = JSON.stringify(m);
  r.candidateSha256 = a.candidateSha256 = sha(manifestText);
  if (target === 'readiness') r = set(r, path, value);
  let readinessText = JSON.stringify(r);
  a.readinessSha256 = sha(readinessText);
  if (target === 'authorization') a = set(a, path, value);
  if (target === 'stale readiness') readinessText += ' ';
  cases.push({ id, manifest: manifestText, readiness: readinessText, authorization: JSON.stringify(a), error, inner });
}
const documents = { manifest, readiness: ready, authorization };
const scalarPaths = {
  authorization: ['schemaVersion', 'kind', 'decision', 'scope', 'version', 'candidateSha256', 'nativeSha256', 'checksumsSha256', 'readinessSha256', 'acceptanceSha256', 'parentAttestationSha256', 'parent.role', 'parent.reviewer', 'parent.authorizedAt'],
  readiness: ['schemaVersion', 'kind', 'policyVersion', 'status', 'publicUrlGate', 'checkedAt', 'candidateSha256', 'nativeSha256', 'acceptanceSha256', 'parentAttestationSha256', 'publicationAuthorized', 'gates.0.id', 'gates.0.status', 'gates.0.verified'],
  manifest: ['schemaVersion', 'classification', 'provenance', 'version', 'architecture', 'minimumGlibc', 'protocol', 'native.sha256', 'native.bytes', 'native.transformed', 'native.profile.opt_level', 'native.profile.debug_assertions', 'native.profile.test', 'bun.sha256', 'bun.bytes', 'bun.version', 'files.0.path', 'files.0.sha256', 'files.0.bytes', 'artifacts.0.path', 'artifacts.0.sha256', 'artifacts.0.bytes'],
};
for (const [target, fields] of Object.entries(scalarPaths)) for (const field of fields) {
  const path = field.split('.'), original = get(documents[target], path);
  const invalid = [[], [original], [original, original], {}, null, undefined];
  if (typeof original === 'string') invalid.push(false, field === 'native.profile.opt_level' ? 4 : 0);
  else if (typeof original === 'boolean') invalid.push(String(original), Number(original));
  else invalid.push(String(original), false, -1, 0.5, 1e30);
  for (const [i, value] of invalid.entries()) {
    add(`${target}.${field} invalid ${i}`, target, path, value);
    // Inner manifest is validated before any identity comparisons too.
    if (target === 'manifest' && !/^(files|artifacts)\./.test(field)) add(`inner.${field} invalid ${i}`, target, path, value, '^Invalid JSON shape:', true);
  }
}
const objectPaths = { authorization: ['', 'parent'], readiness: ['', 'gates.0'], manifest: ['', 'native', 'bun', 'native.profile', 'files.0', 'artifacts.0'] };
for (const [target, fields] of Object.entries(objectPaths)) for (const field of fields) {
  const path = field ? field.split('.') : [], original = get(documents[target], path);
  for (const [i, value] of [[], [original], [original, original], {}, null, 'object', false, 1].entries()) {
    add(`${target}.${field || 'root'} container ${i}`, target, path, value);
    if (target === 'manifest' && !/^(files|artifacts)\./.test(field)) add(`inner.${field || 'root'} container ${i}`, target, path, value, '^Invalid JSON shape:', true);
  }
}
for (const [target, fields] of Object.entries({ readiness: ['gates', 'errors'], manifest: ['files', 'artifacts'] })) for (const field of fields) {
  for (const [i, value] of [{}, null, false, 1, '[]', get(documents[target], [field])[0] ?? 'error'].entries()) add(`${target}.${field} array container ${i}`, target, [field], value);
}
for (const field of ['status', 'classification']) {
  for (const value of [[], ['unpublished-candidate'], ['unpublished-candidate', 'unpublished-candidate'], {}, null]) {
    const m = { ...structuredClone(manifest), schemaVersion: 1, status: 'unpublished-candidate', [field]: value };
    add(`legacy.${field} ${JSON.stringify(value)}`, 'manifest', [], m, '^Invalid JSON shape:', true);
  }
}
for (const value of [[], ['error'], {}, null, false, 1]) add('readiness.errors invalid entry ' + JSON.stringify(value), 'readiness', ['errors'], [value]);
// Additional explicit integer bounds/shape and optimization-level controls.
for (const [field, values] of [['schemaVersion', [0, 3]], ['native.bytes', [0]], ['bun.bytes', [0]], ['native.profile.opt_level', [4, -1, 0.5, true, '02', '2.0', '4', 'TRUE', {}]]]) {
  for (const value of values) add(`manifest.${field} range ${JSON.stringify(value)}`, 'manifest', field.split('.'), value);
}
for (const target of ['authorization', 'readiness']) for (const value of [0, 3]) add(`${target}.schema range ${value}`, target, ['schemaVersion'], value);
add('valid original', '', [], null, null);
for (const level of [2, 3, '2', '3', 's', 'z']) add(`valid Rust opt_level ${JSON.stringify(level)}`, 'manifest', ['native', 'profile', 'opt_level'], level, null);
for (const level of [0, 1, '0', '1']) {
  add(`local development opt_level ${JSON.stringify(level)}`, 'manifest', ['native', 'profile', 'opt_level'], level, null, true);
  add(`remote development opt_level ${JSON.stringify(level)}`, 'manifest', ['native', 'profile', 'opt_level'], level, 'Development or transformed');
}
add('local unattested profile null', 'manifest', [], { ...manifest, provenance: 'fixture-unattested', native: { ...manifest.native, profile: null } }, null, true);
const legacy = { ...manifest, schemaVersion: 1, status: 'unpublished-candidate' }; delete legacy.classification;
add('local historical schema1 shape', 'manifest', [], legacy, null, true);
for (const [target, field, value, error] of [
  ['authorization', 'decision', 'FAIL', 'authorization'], ['authorization', 'schemaVersion', 2, 'authorization'],
  ['authorization', 'parent.role', 'child', 'authorization'], ['authorization', 'version', 'v0.3.0', 'authorization'],
  ['authorization', 'parent.authorizedAt', '2000-01-01T00:00:00Z', 'timeline'],
  ['readiness', 'status', 'FAIL', 'acceptance'], ['readiness', 'schemaVersion', 1, 'acceptance'],
  ['readiness', 'gates.0.status', 'FAIL', 'acceptance'], ['readiness', 'gates.0.verified', false, 'acceptance'],
  ['readiness', 'policyVersion', 'old', 'acceptance'], ['readiness', 'publicationAuthorized', true, 'acceptance'],
  ['readiness', 'gates', [], 'Incomplete'], ['readiness', 'gates', [ready.gates[0]], 'Incomplete'],
  ['readiness', 'gates.1', ready.gates[0], 'duplicate'], ['readiness', 'errors', ['FAIL'], 'acceptance'],
  ['manifest', 'artifacts', [], 'Incomplete'], ['manifest', 'artifacts.0.sha256', 'f'.repeat(64), 'asset bytes changed'],
  ['manifest', 'artifacts.0.bytes', 1, 'asset bytes changed'], ['manifest', 'native.transformed', true, 'Development or transformed'],
]) add(`${target}.${field} semantic rejection`, target, field.split('.'), value, error);
for (const target of ['authorization', 'readiness']) for (const field of scalarPaths[target].filter(p => p.endsWith('Sha256'))) add(`${target}.${field} stale hash`, target, [field], 'f'.repeat(64), 'authorization|acceptance');
add('readiness wire hash mutation', 'stale readiness', [], null, 'authorization');
for (const value of ['d'.repeat(64) + '\n', 'D'.repeat(64), 'd'.repeat(63)]) add('strict SHA format ' + JSON.stringify(value), 'readiness', ['acceptanceSha256'], value);
for (const number of ['2.0', '2e0', '9223372036854775808']) {
  add('JSON numeric spelling ' + number, '', [], null);
  cases.at(-1).manifest = cases.at(-1).manifest.replace('"schemaVersion":2', '"schemaVersion":' + number);
}
put('cases.json', JSON.stringify({ cases }));
for (const [runtime, legacy] of [['powershell.exe', false], ['pwsh.exe', false], ['pwsh.exe', true]]) test(`${runtime}${legacy ? ' pre-DateKind fallback' : ''}: strict scalar/container matrix and valid/FAIL/stale/hash controls`, () => {
  assert.equal(process.platform, 'win32', 'Requires installed PS5.1/7, never installs a shell');
  const result = spawnSync(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', runner, '-Source', resolve(source), '-Root', root, ...(legacy ? ['-LegacyDateParser'] : [])], { encoding: 'utf8', timeout: 180000, maxBuffer: 8 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, new RegExp(`${cases.length} JSON-shape/control cases PASS`));
  console.log(result.stdout.trim());
});
