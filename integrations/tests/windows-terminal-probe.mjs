// Diagnose the transport independently of the pager. No login or model calls.
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { writeFileSync } from 'node:fs';
import { release } from 'node:os';
const pty = createRequire(import.meta.url)(process.env.NODE_PTY_MODULE || 'node-pty');
const script = `
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class ConsoleProbe { [DllImport("kernel32.dll")] public static extern IntPtr GetStdHandle(int n); [DllImport("kernel32.dll")] public static extern bool GetConsoleMode(IntPtr h, out uint m); [DllImport("kernel32.dll")] public static extern bool SetConsoleMode(IntPtr h, uint m); }'
$h = [ConsoleProbe]::GetStdHandle(-11)
[uint32]$mode = 0
if (-not [ConsoleProbe]::GetConsoleMode($h, [ref]$mode)) { exit 2 }
if (-not [ConsoleProbe]::SetConsoleMode($h, ($mode -bor 5))) { exit 3 }
$esc = [char]27
[Console]::Write("PROBE_MAIN$esc[?1049h$esc[2J$esc[HPROBE_ALT")
Start-Sleep -Milliseconds 1000
[Console]::Write("$esc[?1049l PROBE_DONE")
Start-Sleep -Milliseconds 1000
`;
const observations = [];
for (const useConptyDll of [false, true]) {
  const terminal = pty.spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')],
    { cols: 140, rows: 45, cwd: process.cwd(), env: process.env, useConpty: true, useConptyDll });
  let output = '';
  terminal.onData(text => { output += text; });
  let timer;
  try {
    const exitCode = await new Promise((resolve, reject) => {
      timer = setTimeout(() => { terminal.kill(); reject(new Error('Probe timed out')); }, 30000);
      terminal.onExit(event => resolve(event.exitCode));
    });
    observations.push({ os: release(), useConptyDll, exitCode,
      enterAlternate: output.includes('\x1b[?1049h'), leaveAlternate: output.includes('\x1b[?1049l'), output });
    assert.equal(exitCode, 0);
    assert.ok(output.includes('PROBE_ALT') && output.includes('PROBE_DONE'));
    if (useConptyDll) {
      assert.ok(output.includes('\x1b[?1049h'), 'Bundled ConPTY lost alternate-screen entry');
      assert.ok(output.includes('\x1b[?1049l'), 'Bundled ConPTY lost alternate-screen restoration');
    }
  } finally {
    clearTimeout(timer);
    terminal._agent.inSocket.destroy();
    terminal._agent._conoutSocketWorker.dispose();
    writeFileSync('windows-terminal-probe.json', JSON.stringify(observations, null, 2));
  }
}
console.log(JSON.stringify(observations, null, 2));
