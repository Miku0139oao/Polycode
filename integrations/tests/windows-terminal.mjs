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
    this.write('\x11'); await delay(250); this.write('\x11');
    const deadline = Date.now() + 10000;
    while (!this.exited && Date.now() < deadline) await delay(100);
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
