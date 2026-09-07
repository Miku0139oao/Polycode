// Read Cargo's actual artifact/profile output; do not manufacture profile values.
import { readFileSync, writeFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
const [log, binary, output] = process.argv.slice(2);
if (!log || !binary || !output) throw new Error('Usage: node integrations/build-report.mjs CARGO_JSONL BINARY OUTPUT');
const logBytes = readFileSync(log);
const logText = logBytes.toString(logBytes[0] === 0xff && logBytes[1] === 0xfe ? 'utf16le' : 'utf8');
const events = logText.replace(/^\uFEFF/, '').split(/\r?\n/).flatMap(line => {
  try { return [JSON.parse(line)]; } catch { return []; }
});
const artifact = events.findLast(e => e.reason === 'compiler-artifact' && e.executable && resolve(e.executable) === resolve(binary) && e.profile?.test === false);
if (!events.some(e => e.reason === 'build-finished' && e.success === true) || !artifact) throw new Error('No successful Cargo build/artifact evidence.');
const sha = data => createHash('sha256').update(data).digest('hex');
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).trim().length > 0;
writeFileSync(output, JSON.stringify({
  revision, dirty, exit: 0, timeout: false, binary: resolve(binary),
  sha256: sha(readFileSync(binary)), bytes: statSync(binary).size,
  profile: artifact.profile, target: 'x86_64-pc-windows-msvc',
  cargoLogSha256: sha(readFileSync(log)),
  scope: 'Windows candidate build only; no live provider acceptance',
}, null, 2) + '\n', { flag: 'wx' });
