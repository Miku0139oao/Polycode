#!/usr/bin/env node
// Launch with Windows node.exe from WSL; shares official Windows CLI login.
import { spawn } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { Transform } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { mapPaths } from './wsl-paths.mjs';
import { stopChild } from './process-tree.mjs';

function mapper(direction) {
  const decoder = new StringDecoder('utf8'); let buffer = '';
  const max = 8 * 1024 * 1024;
  return new Transform({
    transform(chunk, encoding, callback) {
      try {
        buffer += decoder.write(chunk); let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (Buffer.byteLength(line) > max) throw new Error('Frame too large');
          if (!line.trim()) continue;
          const message = JSON.parse(line);
          if (trace) appendFileSync(trace, JSON.stringify({ direction, method: message.method, id: message.id, errorCode: message.error?.code, resultKeys: message.result ? Object.keys(message.result) : undefined }) + '\n');
          if (direction === 'windows' && typeof message.params?.cwd === 'string' && !/^\/mnt\/[a-zA-Z](\/|$)/.test(message.params.cwd)) throw new Error('Windows agents require a project under /mnt/<drive>/');
          this.push(JSON.stringify(mapPaths(message, direction)) + '\n');
        }
        if (Buffer.byteLength(buffer) > max) throw new Error('Frame too large');
        callback();
      } catch (e) { callback(e); }
    },
    flush(callback) { callback(buffer.trim() ? new Error('Truncated ACP frame') : undefined); },
  });
}
const cliArgs = process.argv.slice(2);
const trace = cliArgs[0] === '--trace-events' ? cliArgs.splice(0, 2)[1] : null;
const [command, ...args] = cliArgs;
if (process.platform !== 'win32' || !command) throw new Error('Use Windows node.exe wsl-host.mjs ABSOLUTE_WINDOWS_EXECUTABLE [args...]');
const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
child.stderr.resume();
let stopping = false;
function stop(error) {
  if (stopping) return; stopping = true;
  if (error) { process.stderr.write('Windows ACP bridge failed; verify executable and mounted-drive project path.\n'); process.exitCode = 1; }
  stopChild(child); child.stdin.end(); process.stdin.destroy();
  setTimeout(() => child.kill('SIGKILL'), 2000).unref();
}
const inbound = mapper('windows'), outbound = mapper('wsl');
for (const stream of [process.stdin, process.stdout, inbound, outbound, child.stdin, child.stdout]) stream.on('error', stop);
process.stdin.pipe(inbound).pipe(child.stdin);
child.stdout.pipe(outbound).pipe(process.stdout);
process.stdin.on('end', () => stop());
child.on('error', stop);
child.on('exit', code => { if (!stopping) process.exitCode = code || 0; stop(); });
process.on('SIGINT', () => stop()); process.on('SIGTERM', () => stop());
