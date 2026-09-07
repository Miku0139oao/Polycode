// Windows-native installer integration. Synthetic PE pager + real bundled Bun;
// no provider network, WSL, installed-user changes or PATH mutations.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, cpSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
const source = fileURLToPath(new URL('../..', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'polycode-native-'));
const assets = join(root, 'assets');
const sha = b => createHash('sha256').update(b).digest('hex');
const q = s => "'" + s.replaceAll("'", "''") + "'";
const ps = (script, runtime = 'powershell.exe') => run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script]);
function run(exe, args) {
  const result = spawnSync(exe, args, { encoding: 'utf8', timeout: 120000, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  return result;
}
function ok(r) { assert.equal(r.status, 0, r.stdout + r.stderr); return r.stdout; }
function install(destination, dir = assets, runtime = 'powershell.exe', more = []) {
  return run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'install.ps1'),
    '-ArtifactDirectory', dir, '-AllowCandidate', '-NoPath', '-InstallRoot', destination, ...more]);
}
function sums(dir) {
  writeFileSync(join(dir, 'SHA256SUMS'), ['install.ps1', 'polycode-windows-x64.gz', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'manifest.json']
    .map(p => sha(readFileSync(join(dir, p))) + '  ' + p).join('\n') + '\n');
}
function clone(name) { const dir = join(root, name); cpSync(assets, dir, { recursive: true }); return dir; }
function releases(dir) { return existsSync(join(dir, 'releases')) ? readdirSync(join(dir, 'releases')) : []; }
function userPath() { return ok(ps("[Environment]::GetEnvironmentVariable('Path', 'User')")); }
let originalPath;
before(() => {
  assert.equal(process.platform, 'win32');
  originalPath = userPath();
  const fixture = join(root, 'fixture.exe');
  const code = 'using System; using System.Text; public class Fixture { public static int Main(string[] args) { Console.WriteLine("--no-external-acp --polycode-native --polycode-provider"); foreach(var arg in args) Console.WriteLine("ARG:" + Convert.ToBase64String(Encoding.UTF8.GetBytes(arg))); return Array.IndexOf(args, "--fixture-exit") >= 0 ? 23 : 0; } }';
  const cs = join(root, 'fixture.cs'); writeFileSync(cs, code);
  ok(run(join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe'), ['/nologo', '/platform:x64', '/target:exe', '/out:' + fixture, cs]));
  const bun = ok(ps('(Get-Command bun.exe).Source')).trim();
  ok(run('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(source, 'integrations/package-release.ps1'),
    '-Binary', fixture, '-Runtime', bun, '-Output', assets]));
});
after(() => {
  assert.equal(userPath(), originalPath, 'Installer changed the real user PATH');
  rmSync(root, { recursive: true, force: true });
});
for (const runtime of ['powershell.exe', 'pwsh.exe']) test(runtime + ': install, relocate, preserve argv and roll back', () => {
  const dest = join(root, runtime + ' space 中文 [test]');
  ok(install(dest, assets, runtime));
  assert.equal(releases(dest).length, 1);
  const release = join(dest, 'releases', releases(dest)[0]);
  const config = JSON.parse(readFileSync(join(release, 'install-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.platform, 'windows');
  assert.equal(config.schemaVersion, 1);
  assert.equal(realpathSync.native(config.binary), realpathSync.native(join(release, 'polycode.exe')));
  const native = ['--help', '', 'space 中文', 'quote"inside', 'trail\\', '& $ ; literal', '--'];
  const r = run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(release, 'polycode.ps1'),
    '-Project', dest, '-Backend', 'CuRsOr', '--', ...native]);
  const forwarded = ok(r).split(/\r?\n/).filter(s => s.startsWith('ARG:')).map(s => Buffer.from(s.slice(4), 'base64').toString('utf8'));
  assert.deepEqual(forwarded.slice(-native.length), native);
  assert.ok(forwarded.includes('--polycode-native'));
  assert.ok(forwarded.includes('cursor'));
  const fail = run(runtime, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(release, 'polycode.ps1'), '--', '--fixture-exit']);
  assert.equal(fail.status, 23);
  const shim = readFileSync(join(dest, 'bin/polycode.cmd'));
  ok(install(dest, assets, runtime, ['-StageOnly']));
  assert.deepEqual(readFileSync(join(dest, 'bin/polycode.cmd')), shim);
  assert.equal(releases(dest).length, 2);
  const corrupt = clone(runtime + '-corrupt');
  writeFileSync(join(corrupt, 'polycode-windows-x64.gz'), gzipSync('not PE'));
  sums(corrupt);
  assert.notEqual(install(dest, corrupt, runtime).status, 0);
  assert.deepEqual(readFileSync(join(dest, 'bin/polycode.cmd')), shim);
  assert.equal(releases(dest).length, 2);
});
test('activation failure preserves previous files', () => {
  const dest = join(root, 'activation failure');
  mkdirSync(join(dest, 'bin/polycode.cmd'), { recursive: true });
  writeFileSync(join(dest, 'bin/polycode.cmd/sentinel'), 'keep');
  assert.notEqual(install(dest).status, 0);
  assert.equal(readFileSync(join(dest, 'bin/polycode.cmd/sentinel'), 'utf8'), 'keep');
  assert.deepEqual(releases(dest), []);
});
test('wrong platform and malformed JSON cannot be hidden by new transport checksums', () => {
  for (const [key, value] of [['platform', 'linux'], ['schemaVersion', 2], ['native', []], ['target', ['x86_64-pc-windows-msvc']]]) {
    const dir = clone('invalid-' + key);
    const file = join(dir, 'manifest.json');
    const m = JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    m[key] = value; writeFileSync(file, JSON.stringify(m)); sums(dir);
    const dest = join(root, 'reject-' + key);
    assert.notEqual(install(dest, dir).status, 0);
    assert.deepEqual(releases(dest), []);
  }
});
test('Windows PE validation rejects ELF and wrong machine headers', () => {
  const malformed = join(root, 'bad.exe');
  for (const data of [Buffer.from('\x7fELF'), (() => { const b = Buffer.alloc(128); b.writeUInt16LE(0x5a4d); b.writeUInt32LE(64,60); b.writeUInt32LE(0x4550,64); b.writeUInt16LE(0xaa64,68); b.writeUInt16LE(0x20b,88); return b; })()]) {
    writeFileSync(malformed, data);
    assert.notEqual(ps('. ' + q(join(source, 'integrations/windows-process.ps1')) + '; Assert-WindowsExecutable ' + q(malformed)).status, 0);
  }
});
test('legacy install configs are rejected without launching WSL', () => {
  const dest = join(root, 'legacy');
  mkdirSync(join(dest, 'integrations'), { recursive: true });
  cpSync(join(source, 'polycode.ps1'), join(dest, 'polycode.ps1'));
  cpSync(join(source, 'integrations/launch.ps1'), join(dest, 'integrations/launch.ps1'));
  writeFileSync(join(dest, 'install-config.json'), JSON.stringify({ binary: '/bin/old', runtime: '/bin/bun', distro: 'archlinux' }));
  const r = run('powershell.exe', ['-NoProfile', '-File', join(dest, 'polycode.ps1')]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /Legacy WSL/);
});
test('GitHub candidate transport installs the same local bytes on PS5.1 and PS7', () => {
  for (const runtime of ['powershell.exe', 'pwsh.exe']) {
    const dest = join(root, 'download-' + runtime);
    const stub = 'function Invoke-WebRequest { param($Uri,$OutFile,[switch]$UseBasicParsing) $name=([uri]$Uri).Segments[-1]; if($Uri -notlike "https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1/*"){throw "Unexpected URL"}; Copy-Item -LiteralPath (Join-Path ' + q(assets) + ' $name) -Destination $OutFile }; ';
    ok(ps(stub + '& ' + q(join(source, 'install.ps1')) + ' -GitHubCandidate -NoPath -InstallRoot ' + q(dest), runtime));
    assert.equal(releases(dest).length, 1);
  }
});
test('local candidates require explicit opt-in, including sibling auto-detection', () => {
  const dest = join(root, 'no opt in');
  const r = run('powershell.exe', ['-NoProfile', '-File', join(assets, 'install.ps1'), '-NoPath', '-InstallRoot', dest]);
  assert.notEqual(r.status, 0); assert.match(r.stderr, /explicit -AllowCandidate/);
  assert.deepEqual(releases(dest), []);
});
test('hosted one-command install stops before download while public acceptance is pending', () => {
  const r = ps('& ([scriptblock]::Create([IO.File]::ReadAllText(' + q(join(source,'install.ps1')) + ')))');
  assert.notEqual(r.status,0);
  assert.match(r.stderr,/Public one-command installation is not enabled/);
});
test('standalone installer embeds the same Windows process and PE checks as packaging', () => {
  const helper=readFileSync(join(source,'integrations/windows-process.ps1'),'utf8').replaceAll('\r\n','\n').trim();
  const installer=readFileSync(join(source,'install.ps1'),'utf8').replaceAll('\r\n','\n');
  assert.ok(installer.includes(helper),'Installer process checks drifted from packager');
});
test('ZIP traversal and runtime inventory mutations cannot escape staging', () => {
  const dir=clone('unsafe zip');
  ok(ps('Add-Type -AssemblyName System.IO.Compression.FileSystem; $z=[IO.Compression.ZipFile]::Open(' + q(join(dir,'polycode-runtime.zip')) + ', "Update"); try { $e=$z.CreateEntry("../escaped.txt"); $w=New-Object IO.StreamWriter($e.Open()); $w.Write("unsafe"); $w.Dispose() } finally { $z.Dispose() }'));
  sums(dir);
  const r=install(join(root,'unsafe dest'),dir);
  assert.notEqual(r.status,0); assert.match(r.stderr,/Unsafe archive path/);
  assert.equal(existsSync(join(root,'escaped.txt')),false);
  const inventory=clone('bad inventory');
  const path=join(inventory,'manifest.json');
  const m=JSON.parse(readFileSync(path,'utf8').replace(/^\uFEFF/,''));
  m.files[0].sha256='f'.repeat(64);writeFileSync(path,JSON.stringify(m));sums(inventory);
  const bad=install(join(root,'inventory dest'),inventory);
  assert.notEqual(bad.status,0);assert.match(bad.stderr,/Runtime file integrity mismatch/);
});
