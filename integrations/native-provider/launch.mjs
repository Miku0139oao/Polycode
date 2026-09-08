import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeProviderService, CredentialStore } from './service.mjs';
import { createCodexProvider } from './codex.mjs';
import { diagnostic, stagedError } from './diagnostics.mjs';

export function defaultAuthDirectory(platform = process.platform, env = process.env, home = homedir()) {
  return platform === 'win32'
    ? join(env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Polycode', 'auth')
    : join(env.XDG_DATA_HOME || join(home, '.local', 'share'), 'polycode', 'auth');
}

export async function runNative({ binary, cwd, provider = 'auto', resume, nativeArgs = [], providers, directory, spawnChild = spawn }) {
  if (!isAbsolute(binary) || !isAbsolute(cwd)) throw new Error('Absolute native binary and workspace paths are required');
  if (!['auto', 'native', 'codex', 'cursor'].includes(provider)) throw new Error('Unknown initial provider');
  if (!Array.isArray(nativeArgs) || nativeArgs.some(arg => typeof arg !== 'string' || arg.includes('\0'))) throw new Error('Invalid native arguments');
  const service = new NativeProviderService(providers, new CredentialStore(directory));
  let bridge;
  try { bridge = await service.start(); }
  catch (cause) { await service.close(); throw stagedError(cause, 'bridge startup'); }
  const args = ['--cwd', cwd, '--no-external-acp', '--polycode-native'];
  if (provider !== 'auto') args.push('--polycode-provider', provider);
  if (resume) args.push('--resume', resume);
  args.push(...nativeArgs);
  let child;
  const stop = () => child?.kill('SIGTERM');
  // The console delivers Ctrl+C to the TUI too. Keep Bun alive while the TUI
  // handles cancellation; its exit event owns bridge cleanup.
  const interrupt = () => {};
  try {
    child = spawnChild(binary, args, { cwd, stdio: 'inherit', env: { ...process.env, POLYCODE_BRIDGE_URL: bridge.url, POLYCODE_BRIDGE_TOKEN: bridge.token } });
    process.on('SIGTERM', stop); process.on('SIGINT', interrupt);
    if (process.platform !== 'win32') process.on('SIGHUP', stop);
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  } catch (cause) { throw stagedError(cause, 'native process'); }
  finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', interrupt); process.removeListener('SIGHUP', stop);
    await service.close();
  }
}
export function parseArguments(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (argv[i] === '--') return { options, nativeArgs: argv.slice(i + 1) };
    if (!['--binary', '--cwd', '--provider', '--resume', '--auth-directory'].includes(argv[i]) || !argv[i + 1] || argv[i + 1] === '--' || Object.hasOwn(options, argv[i].slice(2))) throw new Error('Invalid native launcher arguments');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  return { options, nativeArgs: [] };
}
export async function main(argv = process.argv.slice(2)) {
  const { options, nativeArgs } = parseArguments(argv);
  const { createCursorProvider } = await import('./cursor/index.mjs');
  const providers = { codex: createCodexProvider(), cursor: createCursorProvider() };
  return runNative({ binary: options.binary, cwd: options.cwd, provider: options.provider, resume: options.resume, nativeArgs, providers, directory: options['auth-directory'] ?? defaultAuthDirectory() });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), cause => { console.error(diagnostic(cause.cause ?? cause, cause.stage)); process.exit(1); });
}
