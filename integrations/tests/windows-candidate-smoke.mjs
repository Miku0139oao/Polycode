// Actual installed native TUI through ConPTY, signed out. No live generation.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { WindowsTerminal, plain } from './windows-terminal.mjs';
const candidate = resolve(process.argv[2]);
const root = mkdtempSync(join(tmpdir(), 'polycode-windows-smoke-'));
const install = join(root, 'install');
const manifestBytes = readFileSync(join(candidate, 'manifest.json'));
const manifest = JSON.parse(manifestBytes.toString().replace(/^\uFEFF/, ''));
const result = { passed: false, candidateSha256: createHash('sha256').update(manifestBytes).digest('hex'),
  nativeSha256: manifest.native.sha256, scope: 'Windows ConPTY signed-out installed startup; no OAuth, generation or clean-OS claim', terminalTransport: 'node-pty 1.1.0 bundled ConPTY', observations: [], artifacts: root };
try {
  const installed = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', join(candidate, 'install.ps1'),
    '-AllowCandidate', '-NoPath', '-InstallRoot', install, '-Version', manifest.version],
  { encoding: 'utf8', timeout: 120000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(installed.status, 0, installed.stdout + installed.stderr);
  const release = join(install, 'releases', readdirSync(join(install, 'releases'))[0]);
  const config = JSON.parse(readFileSync(join(release, 'install-config.json'), 'utf8').replace(/^\uFEFF/, ''));
  assert.equal(config.platform, 'windows');
  assert.equal(createHash('sha256').update(readFileSync(config.binary)).digest('hex'), manifest.native.sha256);
  const searchEntry = manifest.files.find(file => file.path === 'vendor/rg.exe');
  assert.ok(searchEntry, 'Candidate omitted the Windows search dependency');
  result.searchExecutable = join(release,'vendor','rg.exe');
  result.ripgrepSha256 = createHash('sha256').update(readFileSync(result.searchExecutable)).digest('hex');
  assert.equal(result.ripgrepSha256, searchEntry.sha256);
  for (const provider of ['native', 'codex', 'cursor']) {
    const workspace = join(root, provider); mkdirSync(workspace);
    const home = join(workspace, 'home'); mkdirSync(home);
    const env = {};
    for (const key of ['SYSTEMROOT','WINDIR','COMSPEC','PATHEXT','PATH','TEMP','TMP']) if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: join(home,'AppData/Local'), APPDATA: join(home,'AppData/Roaming'),
      GROK_HOME: join(home,'grok'), TERM: 'xterm-256color', COLORTERM: 'truecolor', DISABLE_TELEMETRY:'1', DISABLE_ERROR_REPORTING:'1',
      GROK_TELEMETRY_ENABLED:'off', GROK_TEST_OPEN_URL_FILE:join(workspace,'browser.txt') });
    const terminal = new WindowsTerminal('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',join(release,'polycode.ps1'),
      '-Project',workspace,'-AuthDirectory',join(home,'auth'),'-Backend',provider,'--','--fullscreen','--trust'], workspace, env);
    try {
      await terminal.until(() => plain(terminal.output).includes('Choose a provider'), 90000);
      assert.match(plain(terminal.output), /OpenAI ChatGPT/);
      assert.match(plain(terminal.output), /Cursor/);
      assert.equal(existsSync(join(workspace,'browser.txt')),false,'Startup dispatched browser');
      assert.ok(terminal.output.includes('\x1b[?1049h'), 'No fullscreen alternate screen');
    } finally {
      await terminal.close();
      writeFileSync(join(workspace,'terminal.txt'),plain(terminal.output));
      // Signed-out startup never dispatches OAuth. Preserve raw VT evidence in
      // the workflow workspace even when a screen assertion fails.
      writeFileSync(`windows-smoke-terminal-${provider}.json`, JSON.stringify({ provider, output: terminal.output }));
      result.observations.push({provider,exitCode:terminal.exitCode,forcedExit:!!terminal.forcedExit});
    }
    assert.ok(!terminal.forcedExit,'Native terminal failed to exit normally');
    assert.equal(terminal.exitCode, 0, 'Native terminal exited with an error');
    assert.ok(terminal.output.includes('\x1b[?1049l'), 'Fullscreen alternate screen was not restored');
  }
  result.passed = true;
} catch (error) { result.failure = error.message; process.exitCode = 1; }
finally { writeFileSync('windows-smoke-report.json',JSON.stringify(result,null,2)+'\n'); console.log(JSON.stringify(result,null,2)); }
