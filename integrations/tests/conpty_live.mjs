// Windows end-to-end launcher test. Requires node-pty (test-only dependency).
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
if (!process.argv.includes('--allow-subscription-usage')) throw new Error('Explicit --allow-subscription-usage required');
const pty = createRequire(import.meta.url)(process.env.NODE_PTY_MODULE || 'node-pty');
const backend = process.argv.find(x => ['codex', 'cursor'].includes(x)) || 'codex';
const launcher = fileURLToPath(new URL('../../polycode.ps1', import.meta.url));
const terminal = pty.spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, '-Backend', backend, '-Project', process.cwd()], { name: 'xterm-256color', cols: 120, rows: 40, cwd: process.cwd(), env: { ...process.env, TERM: 'xterm-256color' } });
let output = '', exited = false;
terminal.onData(text => {
  output += text;
  if (text.includes('\x1b[6n')) terminal.write('\x1b[1;1R');
  if (text.includes('\x1b[c')) terminal.write('\x1b[?1;2c');
});
terminal.onExit(() => exited = true);
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(predicate, seconds) {
  const end = Date.now() + seconds * 1000;
  while (!predicate()) { if (exited) throw new Error('Launcher exited early'); if (Date.now() > end) throw new Error('Timed out waiting for terminal'); await sleep(100); }
}
try {
  await until(() => output.includes('Thanks for trying Polycode'), 60);
  await sleep(1000);
  terminal.write('Reply only with the three words REAL TUI PASS joined with underscores.');
  await sleep(700); terminal.write('\r');
  await until(() => output.includes('REAL_TUI_PASS'), 120);
  console.log(`PASS: PowerShell launcher + WSL fullscreen TUI + real ${backend}`);
} catch (e) { console.error(e.message); process.exitCode = 1; }
finally {
  writeFileSync(join(tmpdir(), `grok-conpty-${backend}.txt`), output);
  terminal.write('\x03'); await sleep(400); terminal.write('\x11'); await sleep(1500);
  if (!exited) {
    try { process.kill(terminal.pid); } catch { /* Console root already exited. */ }
  }
  // Avoid node-pty's console-list kill helper racing WSL console teardown. Bound only
  // this test process; never taskkill /T a WSL launcher (its host is shared).
  await sleep(1000);
  process.exit(process.exitCode ?? 0);
}
