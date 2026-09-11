import { createRequire } from 'node:module';
const pty = createRequire(import.meta.url)(process.env.NODE_PTY_MODULE || 'node-pty');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
export const plain = text => text.replace(/\x1b\][\s\S]*?(?:\x07|\x1b\\)/g, '')
  .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r/g, '');
export class WindowsTerminal {
  constructor(executable, args, cwd, env) {
    this.output = ''; this.exited = false; this.executable = executable;
    // Server 2022's inbox ConPTY renders alternate-screen switches as redraws,
    // losing the mode transitions at this observation boundary. Use node-pty's
    // pinned modern ConPTY for native VT assertions. Keep the historical WSL
    // diagnostic on its original host/cleanup path.
    this.terminal = pty.spawn(executable, args, { name: 'xterm-256color', cols: 140, rows: 45, cwd, env,
      useConpty: true, useConptyDll: !/wsl\.exe$/i.test(executable) });
    this.terminal.onData(text => {
      this.output += text;
      if (text.includes('\x1b[6n')) this.write('\x1b[1;1R');
      if (text.includes('\x1b[c')) this.write('\x1b[?1;2c');
    });
    this.terminal.onExit(event => { this.exited = true; this.exitCode = event.exitCode; });
  }
  write(text) { if (!this.exited) this.terminal.write(text); }
  async until(predicate, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (this.exited) throw new Error('Terminal exited: ' + this.exitCode);
      if (Date.now() > deadline) throw new Error('Terminal observation timed out');
      await delay(100);
    }
  }
  async close() {
    this.write('\x1b'); await delay(500);
    const quitRequestedAt = Date.now();
    const deadline = quitRequestedAt + 10000;
    this.quitPresses = 0;
    const press = () => { if (!this.exited) { this.write('\x11'); this.quitPresses++; } };
    press();
    // The TUI confirms quitting on a second Ctrl+Q. Wait for that prompt rather
    // than a fixed delay: a keypress that lands while the welcome panel is still
    // redrawing has been dropped on CI, leaving "press again to quit" on screen.
    const armed = this.output.length;
    const promptDeadline = Date.now() + 2000;
    while (!this.exited && Date.now() < promptDeadline && !plain(this.output.slice(armed)).includes('press again to quit')) await delay(50);
    press();
    let retryAt = Date.now() + 3000;
    while (!this.exited && Date.now() < deadline) {
      await delay(100);
      if (!this.exited && Date.now() >= retryAt) { press(); await delay(250); press(); retryAt = Date.now() + 3000; }
    }
    // Milliseconds from the first Ctrl+Q until the process exited (or until the
    // harness gave up), so a report can tell a slow teardown from a lost keypress.
    // A repeated close() on an already-exited terminal must not overwrite it.
    this.closeMs ??= Date.now() - quitRequestedAt;
    if (!this.exited) {
      this.forcedExit = true;
      // A WSL console can contain shared hosts. Never use node-pty's
      // console-wide kill helper for the historical WSL diagnostic.
      if (/wsl\.exe$/i.test(this.executable)) {
        try { process.kill(this.terminal.pid); } catch {}
      } else this.terminal.kill();
      await delay(500);
    }
    // node-pty 1.1.0 leaves input/worker references after natural exit or
    // termination of only the WSL host. Release owned harness resources;
    // calling kill() again could enumerate a now-detached console.
    this.terminal._agent.inSocket.destroy();
    this.terminal._agent._conoutSocketWorker.dispose();
  }
}
