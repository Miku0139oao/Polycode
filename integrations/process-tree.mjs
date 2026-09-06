import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

// Only targets the child PID we spawned. Kill the Windows tree before its root
// exits, otherwise persistent shell descendants can become unowned orphans.
export function stopChild(child, runtime = process, execute = spawnSync) {
  if (runtime.platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    const root = runtime.env.SystemRoot || 'C:\\Windows';
    execute(join(root, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
  }
  child.kill();
}
