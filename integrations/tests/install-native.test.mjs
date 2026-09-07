// Windows + existing archlinux WSL integration tests. No network/provider login,
// no real TUI binary and no writes to the installed Polycode or user PATH.
// Prerequisite: npm ci --ignore-scripts in integrations/native-provider.
// Run: node --test integrations/tests/install-native.test.mjs
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, cpSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import { verifyReadiness, REQUIRED_GATES } from '../release-readiness.mjs';
const source = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const ps = process.env.POLYCODE_TEST_POWERSHELL || 'powershell.exe';
const distro = process.env.POLYCODE_TEST_DISTRO || 'archlinux';
let temp, linux, assets, userPath, installedBefore;
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(exe, args, timeout = 180000) {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' } });
  if (result.error) throw result.error;
  return result;
}
function ok(result) { assert.equal(result.status, 0, result.stdout + result.stderr); return result.stdout.trim(); }
function wsl(...args) { return ok(run('wsl.exe', ['-d', distro, '--exec', ...args])); }
function linuxPath(path) { return wsl('wslpath', '-u', path); }
function powershell(script, ...args) { return run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...args]); }
function command(code) { return run(ps, ['-NoProfile', '-Command', code]); }
function psString(value) { return "'" + value.replaceAll("'", "''") + "'"; }
function installer(root, artifactDir = assets, ...args) {
  return powershell(join(source, 'install.ps1'), '-Distro', distro, '-InstallRoot', root, '-LinuxRoot', linux + '/installs', '-ArtifactDirectory', artifactDir, '-AllowCandidate', '-NoPath', ...args);
}
function checksum(dir) {
  writeFileSync(join(dir, 'SHA256SUMS'), ['polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'install.ps1', 'manifest.json'].map(name => sha(readFileSync(join(dir, name))) + '  ' + name).join('\n') + '\n');
}
function cloneAssets(name) { const dir = join(temp, name); cpSync(assets, dir, { recursive: true }); return dir; }
function snapshot(path) {
  if (!existsSync(path)) return null;
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? snapshot(join(path, e.name)) : sha(readFileSync(join(path, e.name)))]);
}
function releaseDirs(root) { const dir = join(root, 'releases'); return existsSync(dir) ? readdirSync(dir) : []; }
function assertNoRelease(root) { assert.deepEqual(releaseDirs(root), []); }
function linuxReleases() { return JSON.parse(wsl('/usr/sbin/bun', '-e', 'const fs=require("fs"); console.log(JSON.stringify(fs.existsSync(process.argv[1])?fs.readdirSync(process.argv[1]).sort():[]))', linux + '/installs')); }
const liveRoot = join(process.env.LOCALAPPDATA || '', 'Polycode');
before(() => {
  assert.equal(process.platform, 'win32', 'These tests require Windows + existing WSL; never provision a distro automatically.');
  userPath = ok(command('[Environment]::GetEnvironmentVariable("Path", "User")'));
  installedBefore = snapshot(liveRoot);
  temp = mkdtempSync(join(tmpdir(), 'polycode native 測試 [x] & $ '));
  linux = '/tmp/polycode-native-test-' + randomUUID();
  wsl('mkdir', '--', linux);
  const c = join(temp, 'fixture.c');
  writeFileSync(c, `#include <stdio.h>\n#include <stdlib.h>\n#include <string.h>\nint main(int argc, char** argv) {\n if (argc == 2 && strcmp(argv[1], "--help") == 0) { puts("TEST FIXTURE ONLY --no-external-acp --polycode-native --polycode-provider"); return 0; }\n for (int i = 1; i < argc; i++) { printf("ARG:"); for (unsigned char* c=(unsigned char*)argv[i]; *c; c++) printf("%02x", *c); puts(""); }\n const char* url = getenv("POLYCODE_BRIDGE_URL"); const char* token = getenv("POLYCODE_BRIDGE_TOKEN");\n printf("BRIDGE:%d:%d\\n", url && strncmp(url,"http://127.0.0.1:",17)==0, token && strlen(token)>=32);\n return 23;\n}\n`);
  wsl('cc', '-O2', '-DNDEBUG', linuxPath(c), '-o', linux + '/fixture');
  const report = join(temp, 'SYNTHETIC-C-FIXTURE-build-report.json');
  writeFileSync(report, JSON.stringify({ fixture: 'C compiler fixture only; NOT Rust/application acceptance', exit: 0, timeout: false,
    binary: linux + '/fixture', sha256: wsl('sha256sum', linux + '/fixture').split(' ')[0], bytes: Number(wsl('stat', '-c', '%s', linux + '/fixture')),
    revision: 'f'.repeat(40), profile: { opt_level: '2', debug_assertions: false, test: false } }));
  assets = join(temp, 'release assets');
  ok(powershell(join(source, 'integrations/package-release.ps1'), '-Distro', distro, '-Binary', linux + '/fixture', '-BuildReport', report, '-Output', assets));
});
after(() => {
  try {
    assert.equal(ok(command('[Environment]::GetEnvironmentVariable("Path", "User")')), userPath, 'User PATH was modified');
    assert.deepEqual(snapshot(liveRoot), installedBefore, 'Existing installed Polycode was modified');
  } finally {
    if (linux) wsl('rm', '-rf', '--', linux);
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
});

test('fixture package contains six assets, checksums, bundled dependencies and licenses', () => {
  assert.deepEqual(readdirSync(assets).sort(), ['SHA256SUMS', 'install.ps1', 'manifest.json', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'polycode-wsl-x64.gz']);
  for (const line of readFileSync(join(assets, 'SHA256SUMS'), 'ascii').trim().split(/\r?\n/)) {
    const [hash, file] = line.split(/\s+/); assert.equal(sha(readFileSync(join(assets, file))), hash);
  }
  assert.equal(gunzipSync(readFileSync(join(assets, 'polycode-wsl-x64.gz'))).subarray(0, 4).toString('hex'), '7f454c46');
  assert.equal(gunzipSync(readFileSync(join(assets, 'polycode-bun-wsl-x64.gz'))).subarray(0, 4).toString('hex'), '7f454c46');
  const unpack = join(temp, 'archive inspection');
  ok(command(`Add-Type -AssemblyName System.IO.Compression.FileSystem; [IO.Compression.ZipFile]::ExtractToDirectory(${psString(join(assets, 'polycode-runtime.zip'))}, ${psString(unpack)})`));
  for (const file of ['polycode.ps1', 'integrations/launch.ps1', 'integrations/native-provider/launch.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES', 'third-party/BUN-LICENSE.md', 'third-party/cursor/LICENSE.reference', 'third-party/cursor/PROVENANCE.md']) assert.ok(statSync(join(unpack, file)).size > 0, file);
  const inventory = JSON.parse(readFileSync(join(unpack, 'third-party/dependencies.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.deepEqual(inventory.dependencies.map(d => d.name).sort(), ['graceful-fs', 'proper-lockfile', 'retry', 'signal-exit']);
  for (const dep of inventory.dependencies) assert.ok(readdirSync(join(unpack, 'third-party/npm', dep.name)).some(name => /^license/i.test(name)), dep.name);
  assert.ok(inventory.bun.version); assert.ok(inventory.bun.revision);
  assert.equal(JSON.parse(readFileSync(join(unpack, 'release-manifest.json'), 'utf8').replace(/^\uFEFF/, '')).minimumGlibc, '2.43');
});

test('packaging never overwrites existing output and rejects an old binary', () => {
  const before = snapshot(assets);
  const existing = powershell(join(source, 'integrations/package-release.ps1'), '-Distro', distro, '-Binary', linux + '/fixture', '-Output', assets);
  assert.notEqual(existing.status, 0); assert.match(existing.stderr, /already exists/); assert.deepEqual(snapshot(assets), before);
  const output = join(temp, 'old binary output');
  const old = powershell(join(source, 'integrations/package-release.ps1'), '-Distro', distro, '-Binary', '/usr/bin/true', '-Output', output);
  assert.notEqual(old.status, 0); assert.match(old.stderr, /Not a native Polycode binary/); assert.equal(existsSync(output), false);
});

test('disposable install handles special paths; bridge exports credentials and native flags', () => {
  const root = join(temp, 'installed [native] & $');
  ok(installer(root));
  const releases = releaseDirs(root); assert.equal(releases.length, 1);
  const release = join(root, 'releases', releases[0]);
  const config = JSON.parse(readFileSync(join(release, 'install-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.distro, distro); assert.ok(config.binary.startsWith(linux + '/installs/'));
  const project = join(temp, "workspace ; ' & $ ` 中文"); mkdirSync(project);
  for (const provider of ['auto', 'native', 'codex', 'cursor']) {
    const result = powershell(join(release, 'polycode.ps1'), '-Project', project, '-Backend', provider);
    assert.equal(result.status, 23, result.stdout + result.stderr);
    const argv = result.stdout.split(/\r?\n/).filter(s => s.startsWith('ARG:')).map(s => Buffer.from(s.slice(4), 'hex').toString('utf8'));
    assert.deepEqual(argv, ['--cwd', linuxPath(project), '--no-external-acp', '--polycode-native', ...(provider === 'auto' ? [] : ['--polycode-provider', provider])]);
    assert.match(result.stdout, /BRIDGE:1:1/);
  }
  const cmd = spawnSync('cmd.exe', ['/d', '/s', '/c', `""${join(root, 'bin/polycode.cmd')}" -Project "${project}" -Backend native"`], { encoding: 'utf8', windowsVerbatimArguments: true, timeout: 30000 });
  assert.equal(cmd.status, 23, cmd.stdout + cmd.stderr);
  assert.match(cmd.stdout, /BRIDGE:1:1/);
  const first = snapshot(release);
  ok(installer(root)); // Same version gets a distinct immutable release.
  assert.equal(releaseDirs(root).length, 2); assert.deepEqual(snapshot(release), first);
});

test('StageOnly leaves an existing launcher and PATH unchanged', () => {
  const root = join(temp, 'staged only'); mkdirSync(join(root, 'bin'), { recursive: true });
  writeFileSync(join(root, 'bin/polycode.cmd'), 'existing launcher sentinel');
  ok(installer(root, assets, '-StageOnly'));
  assert.equal(releaseDirs(root).length, 1);
  assert.equal(readFileSync(join(root, 'bin/polycode.cmd'), 'utf8'), 'existing launcher sentinel');
});

test('checksum mismatch, missing entry and duplicate entry cannot install', () => {
  for (const scenario of ['mismatch', 'missing', 'duplicate']) {
    const artifacts = cloneAssets(scenario), root = join(temp, scenario + ' install');
    const sums = join(artifacts, 'SHA256SUMS');
    const lines = readFileSync(sums, 'ascii').trim().split(/\r?\n/);
    if (scenario === 'mismatch') writeFileSync(join(artifacts, 'polycode-wsl-x64.gz'), 'corrupted');
    if (scenario === 'missing') writeFileSync(sums, lines.slice(1).join('\n'));
    if (scenario === 'duplicate') writeFileSync(sums, [...lines, lines[0]].join('\n'));
    const before = linuxReleases();
    const result = installer(root, artifacts);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /[Cc]hecksum/);
    assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
  }
});

test('unsafe, duplicate and incomplete ZIPs are rejected even with valid checksums', () => {
  for (const [scenario, mutate, expected] of [
    ['traversal', "$zip.CreateEntry('../escaped.txt') | Out-Null", /Unsafe archive path/],
    ['duplicate zip', "$zip.CreateEntry('polycode.ps1') | Out-Null", /Duplicate archive path/],
    ['missing runtime', "$zip.GetEntry('polycode.ps1').Delete()", /Incomplete runtime archive/],
  ]) {
    const artifacts = cloneAssets(scenario), root = join(temp, scenario + ' install');
    const zip = join(artifacts, 'polycode-runtime.zip');
    ok(command(`Add-Type -AssemblyName System.IO.Compression; Add-Type -AssemblyName System.IO.Compression.FileSystem; $zip=[IO.Compression.ZipFile]::Open(${psString(zip)}, [IO.Compression.ZipArchiveMode]::Update); try { ${mutate} } finally { $zip.Dispose() }`));
    checksum(artifacts);
    const result = installer(root, artifacts);
    assert.notEqual(result.status, 0); assert.match(result.stderr, expected); assertNoRelease(root);
  }
  const wrongVersion = join(temp, 'wrong version');
  const result = installer(wrongVersion, assets, '-Version', 'v0.3.0');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /manifest does not match/); assertNoRelease(wrongVersion);
});

test('unsupported binary and corrupt gzip roll back Linux staging', () => {
  for (const scenario of ['old fixture', 'broken gzip']) {
    const artifacts = cloneAssets(scenario), root = join(temp, scenario + ' install');
    writeFileSync(join(artifacts, 'polycode-wsl-x64.gz'), scenario === 'old fixture' ? gzipSync('#!/bin/sh\nprintf "old prototype\\n"\n') : Buffer.from('not gzip'));
    checksum(artifacts);
    const before = linuxReleases();
    const result = installer(root, artifacts);
    assert.notEqual(result.status, 0);
    if (scenario === 'old fixture') assert.match(result.stderr, /Decompressed executable integrity mismatch/);
    assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
  }
});

test('activation failure rolls back both filesystems without replacing old installation', () => {
  const root = join(temp, 'rollback install');
  // An existing directory at the launcher path forces activation failure after
  // verification and release copy, without injecting production-only test hooks.
  mkdirSync(join(root, 'bin/polycode.cmd'), { recursive: true });
  writeFileSync(join(root, 'bin/polycode.cmd/sentinel'), 'old state');
  mkdirSync(join(root, 'releases/previous'), { recursive: true });
  writeFileSync(join(root, 'releases/previous/sentinel'), 'old release');
  const before = snapshot(root), beforeLinux = linuxReleases();
  const result = installer(root);
  assert.notEqual(result.status, 0);
  assert.deepEqual(snapshot(root), before); assert.deepEqual(linuxReleases(), beforeLinux);
});

test('wrapper forwards ordinary CLI arguments exactly through structured WSL exec (bridge contract)', () => {
  const root = join(temp, 'wrapper fixture');
  mkdirSync(join(root, 'integrations/native-provider'), { recursive: true });
  cpSync(join(source, 'polycode.ps1'), join(root, 'polycode.ps1'));
  cpSync(join(source, 'integrations/launch.ps1'), join(root, 'integrations/launch.ps1'));
  // Stub only the bridge's argv receiver. Actual bridge passthrough support is
  // separately owned; this test does not claim the seeded old bridge supports it.
  writeFileSync(join(root, 'integrations/native-provider/launch.mjs'), 'console.log(JSON.stringify(process.argv.slice(2)));');
  writeFileSync(join(root, 'install-config.json'), JSON.stringify({ binary: linux + '/fixture', runtime: '/usr/sbin/bun', distro }));
  const native = ['--help', '--version', '--model', 'grok-test', 'prompt with "quotes" & $ ; `', '-h', 'trailing\\', '', '--resume', 'native-session'];
  for (const runtime of [ps, 'pwsh.exe']) {
    const result = run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(root, 'polycode.ps1'), '-Project', temp, '-Backend', 'CuRsOr', '--', ...native]);
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), ['--binary', linux + '/fixture', '--cwd', linuxPath(temp), '--provider', 'cursor', '--', ...native]);
  }
  const unknown = powershell(join(root, 'polycode.ps1'), '--version', '-Project', temp);
  assert.deepEqual(JSON.parse(ok(unknown)).slice(-2), ['--', '--version']);
  const obsolete = powershell(join(root, 'polycode.ps1'), '-CodexExecutable', 'must-not-run.exe');
  assert.notEqual(obsolete.status, 0); assert.match(obsolete.stderr, /obsolete/);
});

test('candidate installation requires explicit local opt-in', () => {
  const root = join(temp, 'no candidate opt-in');
  const result = powershell(join(source, 'install.ps1'), '-Distro', distro, '-InstallRoot', root, '-LinuxRoot', linux + '/installs', '-ArtifactDirectory', assets, '-NoPath');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit -AllowCandidate/); assertNoRelease(root);
});

test('manifest identity and runtime file integrity cannot be bypassed by recomputing transport checksums', () => {
  for (const scenario of ['wrong native identity', 'unsafe inventory path', 'changed file hash']) {
    const artifacts = cloneAssets(scenario), root = join(temp, scenario + ' install');
    const manifestPath = join(artifacts, 'manifest.json'), manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''));
    if (scenario === 'wrong native identity') manifest.native.sha256 = 'f'.repeat(64);
    if (scenario === 'unsafe inventory path') manifest.files[0].path = '../escaped';
    if (scenario === 'changed file hash') manifest.files[0].sha256 = 'f'.repeat(64);
    writeFileSync(manifestPath, JSON.stringify(manifest)); checksum(artifacts);
    const before = linuxReleases(), result = installer(root, artifacts);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /identity mismatch|Unsafe or duplicate manifest|integrity mismatch/);
    assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
  }
});

test('build provenance hash mismatch is rejected before producing candidate output', () => {
  const output = join(temp, 'stale build report output'), report = join(temp, 'stale-build-report.json');
  writeFileSync(report, JSON.stringify({ exit: 0, timeout: false, binary: linux + '/fixture', sha256: 'f'.repeat(64), bytes: 1, revision: 'a'.repeat(40), profile: { opt_level: '0', debug_assertions: true, test: false } }));
  const result = powershell(join(source, 'integrations/package-release.ps1'), '-Distro', distro, '-Binary', linux + '/fixture', '-BuildReport', report, '-Output', output);
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Build report does not attest/); assert.equal(existsSync(output), false);
});

// The transport is replaced with local byte copies, NOT an HTTP fixture server.
// No request ever reaches GitHub (or any network). Production installer code and
// the full remote authorization branch run unchanged on PS5.1/7.
function remoteInstaller(root, directory, runtime = ps, extra = '') {
  const stub = `function Invoke-WebRequest {
    param([string]$Uri, [string]$OutFile, [switch]$UseBasicParsing)
    if ($Uri -notmatch '^https://github\\.com/Miku0139oao/Polycode/releases/download/v0\\.2\\.0/([A-Za-z0-9._-]+)$') { throw 'Unexpected fixture URL; network is forbidden' }
    $asset = Join-Path ${psString(directory)} $Matches[1]
    if (-not (Test-Path -LiteralPath $asset -PathType Leaf)) { throw 'Missing fixture release authorization or asset' }
    Copy-Item -LiteralPath $asset -Destination $OutFile
  }
  & ${psString(join(source, 'install.ps1'))} -Distro ${psString(distro)} -InstallRoot ${psString(root)} -LinuxRoot ${psString(linux + '/installs')} -NoPath ${extra}`;
  return run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', stub]);
}
function authorizedFixture(name) {
  const directory = cloneAssets(name), manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const review = join(temp, name + '-SYNTHETIC-review'); mkdirSync(review);
  const original = join(temp, 'SYNTHETIC-C-FIXTURE-build-report.json');
  const observation = join(review, 'SYNTHETIC-NOT-LIVE.txt'); writeFileSync(observation, 'Synthetic policy/transport fixture only. Not parent authorization for any Polycode candidate.');
  const ref = path => ({ path, sha256: sha(readFileSync(path)) });
  const candidateSha256 = sha(readFileSync(join(directory, 'manifest.json'))), nativeSha256 = manifest.native.sha256;
  const observedAt = new Date().toISOString(), acceptance = join(review, 'acceptance.json'), attestation = join(review, 'parent.json');
  writeFileSync(acceptance, JSON.stringify({ schemaVersion: 1, candidateSha256, nativeSha256, gates: REQUIRED_GATES.map(id => ({
    id, status: 'PASS', candidateSha256, nativeSha256, observedAt,
    mode: ['regression', 'hash-provenance', 'final-binary-profile'].includes(id) ? 'offline' : 'real',
    evidence: [ref(id === 'hash-provenance' ? original : observation)],
  })) }));
  writeFileSync(attestation, JSON.stringify({ schemaVersion: 1, role: 'parent', reviewer: 'SYNTHETIC TEST PARENT; NOT LIVE AUTHORIZATION',
    candidateSha256, acceptanceSha256: sha(readFileSync(acceptance)), reviewedAt: observedAt, reviewedAllRequiredGates: true, publicationAuthorized: false, evidence: [ref(observation)] }));
  const readiness = verifyReadiness({ candidate: directory, acceptance, attestation });
  assert.equal(readiness.status, 'PASS', readiness.errors.join('\n'));
  const readinessPath = join(directory, 'release-readiness.json'), authorizationPath = join(directory, 'release-authorization.json');
  writeFileSync(readinessPath, JSON.stringify(readiness));
  const authorization = { schemaVersion: 1, kind: 'polycode-distribution-authorization', scope: 'public-distribution', decision: 'AUTHORIZED',
    version: 'v0.2.0', candidateSha256, nativeSha256, checksumsSha256: sha(readFileSync(join(directory, 'SHA256SUMS'))),
    readinessSha256: sha(readFileSync(readinessPath)), acceptanceSha256: readiness.acceptanceSha256, parentAttestationSha256: readiness.parentAttestationSha256,
    parent: { role: 'parent', reviewer: 'SYNTHETIC TEST PARENT; NOT LIVE AUTHORIZATION', authorizedAt: new Date().toISOString() } };
  const save = () => { writeFileSync(readinessPath, JSON.stringify(readiness)); authorization.readinessSha256 = sha(readFileSync(readinessPath)); writeFileSync(authorizationPath, JSON.stringify(authorization)); };
  save(); return { directory, readiness, authorization, save, readinessPath, authorizationPath, manifest };
}

test('remote path rejects absent/FAIL/stale authorization even with AllowCandidate', () => {
  for (const scenario of ['absent', 'FAIL', 'stale candidate', 'stale checksums', 'stale readiness', 'stale acceptance', 'stale parent', 'stale native', 'stale timeline', 'late authorization', 'wrong version', 'wrong parent']) {
    const f = authorizedFixture('remote rejection ' + scenario), root = join(temp, 'remote reject install ' + scenario);
    if (scenario === 'FAIL') f.authorization.decision = 'FAIL';
    if (scenario === 'stale candidate') f.authorization.candidateSha256 = 'e'.repeat(64);
    if (scenario === 'stale checksums') f.authorization.checksumsSha256 = 'e'.repeat(64);
    if (scenario === 'stale acceptance') f.authorization.acceptanceSha256 = 'e'.repeat(64);
    if (scenario === 'stale parent') f.authorization.parentAttestationSha256 = 'e'.repeat(64);
    if (scenario === 'stale native') f.authorization.nativeSha256 = 'e'.repeat(64);
    if (scenario === 'stale timeline') f.authorization.parent.authorizedAt = '2000-01-01T00:00:00Z';
    if (scenario === 'late authorization') f.readiness.checkedAt = new Date(Date.now() - 8 * 86400000).toISOString();
    if (scenario === 'wrong version') f.authorization.version = 'v0.3.0';
    if (scenario === 'wrong parent') f.authorization.parent.role = 'child';
    f.save();
    if (scenario === 'absent') rmSync(f.authorizationPath);
    if (scenario === 'stale readiness') writeFileSync(f.readinessPath, readFileSync(f.readinessPath, 'utf8') + ' ');
    for (const runtime of ['powershell.exe', 'pwsh.exe']) {
      const before = linuxReleases(), result = remoteInstaller(root, f.directory, runtime, '-AllowCandidate');
      assert.notEqual(result.status, 0, scenario); assert.match(result.stderr, /authorization/); assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
    }
  }
});

test('remote authorization cannot hide missing/FAIL/new gates or an old policy', () => {
  for (const scenario of ['missing session', 'FAIL effort', 'unverified queued switch', 'old policy', 'BLOCKED readiness']) {
    const f = authorizedFixture('remote policy ' + scenario), root = join(temp, 'remote policy install ' + scenario);
    if (scenario === 'missing session') f.readiness.gates = f.readiness.gates.filter(g => g.id !== 'session-resume-chatgpt');
    if (scenario === 'FAIL effort') f.readiness.gates.find(g => g.id === 'native-reasoning-effort-wire').status = 'FAIL';
    if (scenario === 'unverified queued switch') f.readiness.gates.find(g => g.id === 'busy-queued-model-switch-safe-commit').verified = false;
    if (scenario === 'old policy') f.readiness.policyVersion = 'old';
    if (scenario === 'BLOCKED readiness') f.readiness.status = 'BLOCKED';
    f.save();
    for (const runtime of ['powershell.exe', 'pwsh.exe']) {
      const before = linuxReleases(), result = remoteInstaller(root, f.directory, runtime);
      assert.notEqual(result.status, 0); assert.match(result.stderr, /acceptance/); assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
    }
  }
});

test('post-acceptance asset mutations are rejected even if transport sums and their authorization hash are updated', () => {
  const f = authorizedFixture('changed accepted gzip'), root = join(temp, 'changed gzip remote install');
  const path = join(f.directory, 'polycode-wsl-x64.gz');
  writeFileSync(path, Buffer.concat([readFileSync(path), Buffer.from('not accepted bytes')]));
  checksum(f.directory); f.authorization.checksumsSha256 = sha(readFileSync(join(f.directory, 'SHA256SUMS'))); f.save();
  for (const runtime of ['powershell.exe', 'pwsh.exe']) {
    const before = linuxReleases(), result = remoteInstaller(root, f.directory, runtime);
    assert.notEqual(result.status, 0); assert.match(result.stderr, /Authorized asset bytes changed/);
    assertNoRelease(root); assert.deepEqual(linuxReleases(), before);
  }
});

test('remote production branch rejects collection/null/object authorization bypasses on PS5.1/7', () => {
  // Reuse accepted fixture bytes; only synthetic sidecars change. The exhaustive
  // all-field shape/container/numeric matrix lives in install-authorization.test.
  const f = authorizedFixture('remote JSON shape matrix'), acceptedBefore = snapshot(assets), beforeLinux = linuxReleases();
  let count = 0;
  for (const runtime of ['powershell.exe', 'pwsh.exe']) for (const field of ['decision', 'readinessSha256', 'readiness status', 'gate status']) {
    const original = field === 'decision' ? 'AUTHORIZED' : field === 'readinessSha256' ? f.authorization.readinessSha256 : 'PASS';
    for (const value of [[], [original], [original, original], {}, null]) {
      const ready = structuredClone(f.readiness), auth = structuredClone(f.authorization);
      if (field === 'readiness status') ready.status = value;
      if (field === 'gate status') ready.gates[0].status = value;
      writeFileSync(f.readinessPath, JSON.stringify(ready)); auth.readinessSha256 = sha(readFileSync(f.readinessPath));
      if (field === 'decision' || field === 'readinessSha256') auth[field] = value;
      writeFileSync(f.authorizationPath, JSON.stringify(auth));
      const root = join(temp, 'remote JSON rejection ' + count++), result = remoteInstaller(root, f.directory, runtime, '-AllowCandidate');
      assert.notEqual(result.status, 0, `${runtime} ${field} ${JSON.stringify(value)}`);
      assert.match(result.stderr, /Invalid JSON shape/); assertNoRelease(root);
    }
  }
  assert.deepEqual(linuxReleases(), beforeLinux);
  assert.deepEqual(snapshot(assets), acceptedBefore);
  for (const name of readdirSync(assets)) assert.deepEqual(readFileSync(join(f.directory, name)), readFileSync(join(assets, name)), name);
  console.log(`${count} production remote JSON-shape rejections PASS on PS5.1/7; accepted fixture bytes unchanged`);
});

test('matching fixture authorization installs exact accepted bytes on PS5.1/7 without repack or reclassification', () => {
  const f = authorizedFixture('immutable promotion'), before = snapshot(assets);
  for (const runtime of [ps, 'pwsh.exe']) {
    const root = join(temp, 'authorized immutable install ' + runtime);
    ok(remoteInstaller(root, f.directory, runtime));
    const release = join(root, 'releases', releaseDirs(root)[0]);
    const config = JSON.parse(readFileSync(join(release, 'install-config.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(wsl('sha256sum', config.binary).split(' ')[0], f.manifest.native.sha256);
    assert.equal(wsl('sha256sum', config.runtime).split(' ')[0], f.manifest.bun.sha256);
    assert.equal(sha(readFileSync(join(release, 'candidate-manifest.json'))), f.authorization.candidateSha256);
    const inner = JSON.parse(readFileSync(join(release, 'release-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(inner.classification, 'immutable-candidate'); assert.equal(Object.hasOwn(inner, 'status'), false);
    for (const file of f.manifest.files) assert.equal(sha(readFileSync(join(release, file.path))), file.sha256);
    for (const sidecar of ['release-readiness.json', 'release-authorization.json']) assert.deepEqual(readFileSync(join(release, sidecar)), readFileSync(join(f.directory, sidecar)));
  }
  // Every one of the six original package files, including ZIP, manifest, sums
  // and installer, is identical before/after the ONLY change: two added sidecars.
  assert.deepEqual(snapshot(assets), before);
  for (const name of readdirSync(assets)) assert.deepEqual(readFileSync(join(f.directory, name)), readFileSync(join(assets, name)), name);
  const local = join(temp, 'authorized but local still requires opt in');
  const result = powershell(join(source, 'install.ps1'), '-Distro', distro, '-InstallRoot', local, '-LinuxRoot', linux + '/installs', '-ArtifactDirectory', f.directory, '-NoPath');
  assert.notEqual(result.status, 0); assert.match(result.stderr, /explicit -AllowCandidate/); assertNoRelease(local);
});
