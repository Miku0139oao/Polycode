// Actual candidate only, no compilation/accounts/network/publication. Keeps diagnostics.
// Runs real installed bridge/native help + doctor, NOT full TUI/live acceptance.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, statSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { createGunzip } from 'node:zlib';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Usage: node integrations/tests/install-candidate.mjs --candidate DIR');
assert.equal(args[0], '--candidate'); assert.equal(process.platform, 'win32');
const candidate = resolve(args[1]), id = randomUUID();
const root = resolve(candidate + '-install-' + id), linux = '/tmp/polycode-candidate-install-' + id;
mkdirSync(root); mkdirSync(join(root, 'diagnostics')); mkdirSync(join(root, 'workspace'));
const reportPath = join(root, 'report.json');
const report = { schemaVersion: 1, scope: 'Actual isolated installed entrypoint OFFLINE preflight; NOT OAuth/live/TUI acceptance', status: 'FAIL', candidate, root, linux, checks: [], commands: [], publicUrlGate: 'DEFERRED_UNTIL_PUBLICATION', oauthChatGPT: 'USER_REPORTED_WORKING_NOT_FORMALLY_ACCEPTED', oauthCursor: 'FAIL_USER_REPORTED_UNREPRODUCED', integratedInstalledGate: 'NOT_ACCEPTED' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const load = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
function save() { writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
function run(exe, argv, timeout = 180000, extra = {}) {
  const i = report.commands.length;
  const result = spawnSync(exe, argv, { encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, MSYS_NO_PATHCONV: '1' }, ...extra });
  writeFileSync(join(root, 'diagnostics', `${i}.stdout`), result.stdout || '');
  writeFileSync(join(root, 'diagnostics', `${i}.stderr`), result.stderr || '');
  report.commands.push({ exe, argv, exit: result.status, error: result.error?.message, stdout: `diagnostics/${i}.stdout`, stderr: `diagnostics/${i}.stderr` }); save();
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${exe} ${argv.join(' ')}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
const wsl = (...argv) => run('wsl.exe', ['-d', 'archlinux', '--exec', ...argv]);
const ps = (exe, ...argv) => run(exe, ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...argv]);
const check = (id, details) => { report.checks.push({ id, status: 'PASS', ...details }); save(); };
function snapshot(path) {
  if (!existsSync(path)) return null;
  return readdirSync(path, { withFileTypes: true }).sort((a,b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isDirectory() ? snapshot(join(path, e.name)) : sha(readFileSync(join(path, e.name)))]);
}
async function uncompressed(path) {
  const hash = createHash('sha256'); let bytes = 0, prefix = Buffer.alloc(0);
  for await (const chunk of createReadStream(path).pipe(createGunzip())) { hash.update(chunk); bytes += chunk.length; if (prefix.length < 20) prefix = Buffer.concat([prefix, chunk]).subarray(0,20); }
  assert.equal(prefix.subarray(0,6).toString('hex'), '7f454c460201'); assert.equal(prefix.readUInt16LE(18), 62);
  return { sha256: hash.digest('hex'), bytes };
}
let oldPath, oldWindows, oldLinux;
const protectedWindows = join(process.env.LOCALAPPDATA, 'Polycode');
const linuxSnapshot = () => wsl('/usr/sbin/python', '-c', 'import os,json,hashlib; p="/root/.local/bin/polycode"; print(json.dumps({"exists":os.path.lexists(p),"link":os.readlink(p) if os.path.islink(p) else None,"sha256":hashlib.file_digest(open(p,"rb"),"sha256").hexdigest() if os.path.isfile(p) else None}))');
try {
  oldPath = ps('powershell.exe', '-Command', '[Environment]::GetEnvironmentVariable("Path", "User")');
  oldWindows = snapshot(protectedWindows); oldLinux = linuxSnapshot();
  const manifest = load(join(candidate, 'manifest.json'));
  report.candidateSha256 = sha(readFileSync(join(candidate, 'manifest.json'))); report.nativeSha256 = manifest.native.sha256;
  assert.equal(manifest.provenance, 'build-report');
  assert.ok((manifest.schemaVersion === 2 && manifest.classification === 'immutable-candidate' && !Object.hasOwn(manifest, 'status')) || (manifest.schemaVersion === 1 && manifest.status === 'unpublished-candidate'), 'Only immutable or legacy local preparation candidates are accepted');
  const sums = new Map();
  for (const line of readFileSync(join(candidate, 'SHA256SUMS'), 'ascii').trim().split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._-]+)$/.exec(line); assert.ok(match); assert.ok(!sums.has(match[2])); sums.set(match[2], match[1]);
    assert.equal(sha(readFileSync(join(candidate, match[2]))), match[1]);
  }
  assert.equal(sums.size, 5); assert.equal(sums.get('manifest.json'), report.candidateSha256);
  for (const asset of manifest.artifacts) { assert.equal(sums.get(asset.path), asset.sha256); assert.equal(statSync(join(candidate, asset.path)).size, asset.bytes); }
  assert.deepEqual(await uncompressed(join(candidate, 'polycode-wsl-x64.gz')), { sha256: manifest.native.sha256, bytes: manifest.native.bytes });
  assert.deepEqual(await uncompressed(join(candidate, 'polycode-bun-wsl-x64.gz')), { sha256: manifest.bun.sha256, bytes: manifest.bun.bytes });
  check('hashes-native-and-bun-ELF', { native: manifest.native.sha256, bun: manifest.bun.sha256, nativeProfile: manifest.native.profile });
  for (const exe of ['powershell.exe', 'pwsh.exe']) {
    const name = exe === 'powershell.exe' ? 'ps51' : 'ps7', installRoot = join(root, name);
    ps(exe, '-File', join(candidate, 'install.ps1'), '-ArtifactDirectory', candidate, '-AllowCandidate', '-InstallRoot', installRoot, '-LinuxRoot', linux + '/' + name, '-NoPath');
    const releases = readdirSync(join(installRoot, 'releases')); assert.equal(releases.length, 1);
    const release = join(installRoot, 'releases', releases[0]), config = load(join(release, 'install-config.json'));
    assert.equal(wsl('sha256sum', config.binary).split(' ')[0], manifest.native.sha256);
    assert.equal(wsl('sha256sum', config.runtime).split(' ')[0], manifest.bun.sha256);
    const inventory = load(join(release, 'third-party/dependencies.json'));
    assert.deepEqual(inventory.dependencies.map(d => d.name).sort(), ['graceful-fs', 'proper-lockfile', 'retry', 'signal-exit']);
    for (const file of manifest.files) {
      assert.match(file.path, /^(polycode\.ps1|integrations\/(launch\.ps1|RELEASE_READINESS\.md|native-provider\/launch\.mjs)|LICENSE|THIRD-PARTY-NOTICES|release-manifest\.json|provenance\/build-report\.json|third-party\/.*)$/);
      assert.doesNotMatch(file.path, /(^|\/)(\.env|auth|credentials|tokens?)(\.|\/|$)/i);
      assert.equal(sha(readFileSync(join(release, file.path))), file.sha256);
    }
    check(name + '-real-install-inventory', { installRoot, release, config, dependencies: inventory.dependencies });
    const home = linux + '/' + name + '/offline-home', runtimeWrapper = linux + '/' + name + '/offline-runtime';
    wsl('mkdir', '-p', '--', home);
    const wrapper = join(root, name + '-offline-runtime.sh');
    // The wrapper only adds OS-level isolation, then executes the installed Bun.
    // No credentials, provider adapters, native flags or agent implementation are replaced.
    const sh = s => "'" + s.replaceAll("'", "'\\''") + "'";
    writeFileSync(wrapper, `#!/bin/sh\nexec /usr/sbin/unshare --net -- /bin/sh -c '\n/usr/sbin/ip link set lo up || exit 1\nhome=$1; bun=$2; shift 2\nexec /usr/sbin/env -i HOME="$home" XDG_CONFIG_HOME="$home/config" XDG_DATA_HOME="$home/data" XDG_CACHE_HOME="$home/cache" XDG_STATE_HOME="$home/state" GROK_HOME="$home/grok" PATH=/usr/sbin:/usr/bin:/bin TERM=xterm-256color LANG=C.UTF-8 /usr/sbin/timeout -k 3 30 "$bun" "$@"\n' isolated ${sh(home)} ${sh(config.runtime)} "$@"\n`);
    wsl('install', '-m', '755', '--', wsl('wslpath', '-u', wrapper), runtimeWrapper);
    const command = native => `""${join(installRoot, 'bin/polycode.cmd')}" -Project "${join(root, 'workspace')}" -Runtime ${runtimeWrapper} -- ${native}"`;
    const help = run('cmd.exe', ['/d', '/s', '/c', command('--help')], 45000, { windowsVerbatimArguments: true });
    for (const flag of ['--no-external-acp', '--polycode-native', '--polycode-provider']) assert.ok(help.includes(flag));
    const doctor = run('cmd.exe', ['/d', '/s', '/c', command('doctor')], 45000, { windowsVerbatimArguments: true });
    check(name + '-installed-cmd-help-and-doctor-offline', { isolatedHome: home, doctor, fullTuiAcceptance: false });
    const leftovers = wsl('/usr/sbin/python', '-c', 'import os,json; p=os.sys.argv[1]; print(json.dumps([os.path.join(d,n) for d,_,ns in os.walk(p) for n in ns if n in ("codex.json","cursor.json")]))', home);
    assert.deepEqual(JSON.parse(leftovers), []);
  }
  report.status = 'PASS';
} catch (error) { report.error = error.stack; process.exitCode = 1; }
finally {
  try {
    if (oldPath !== undefined) assert.equal(ps('powershell.exe', '-Command', '[Environment]::GetEnvironmentVariable("Path", "User")'), oldPath);
    if (oldWindows !== undefined) assert.deepEqual(snapshot(protectedWindows), oldWindows);
    if (oldLinux !== undefined) assert.equal(linuxSnapshot(), oldLinux);
    check('protected-installations-and-user-path-unchanged', {});
  } catch (error) { report.status = 'FAIL'; report.safetyError = error.stack; process.exitCode = 1; }
  save(); console.log(JSON.stringify({ status: report.status, report: reportPath, root, linux }, null, 2));
}
