import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { NativeProviderService, CredentialStore } from './service.mjs';
import { createCodexProvider } from './codex.mjs';

export async function runNative({ binary, cwd, provider = 'auto', resume, providers, directory, spawnChild = spawn }) {
  if (!isAbsolute(binary) || !isAbsolute(cwd)) throw new Error('Absolute native binary and workspace paths are required');
  if (!['auto', 'native', 'codex', 'cursor'].includes(provider)) throw new Error('Unknown initial provider');
  const service = new NativeProviderService(providers, new CredentialStore(directory));
  const bridge = await service.start();
  const args = ['--cwd', cwd, '--no-external-acp', '--polycode-native'];
  if (provider !== 'auto') args.push('--polycode-provider', provider);
  if (resume) args.push('--resume', resume);
  const child = spawnChild(binary, args, { cwd, stdio: 'inherit', env: { ...process.env, POLYCODE_BRIDGE_URL: bridge.url, POLYCODE_BRIDGE_TOKEN: bridge.token } });
  const stop = () => child.kill('SIGTERM');
  process.on('SIGTERM', stop); process.on('SIGHUP', stop);
  try {
    return await new Promise((resolve, reject) => { child.once('error', reject); child.once('exit', code => resolve(code ?? 1)); });
  } finally {
    process.removeListener('SIGTERM', stop); process.removeListener('SIGHUP', stop);
    await service.close();
  }
}
export async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    if (!['--binary', '--cwd', '--provider', '--resume', '--auth-directory'].includes(argv[i]) || !argv[i + 1]) throw new Error('Invalid native launcher arguments');
    options[argv[i].slice(2)] = argv[i + 1];
  }
  const { createCursorProvider } = await import('./cursor/index.mjs');
  const providers = { codex: createCodexProvider(), cursor: createCursorProvider() };
  return runNative({ binary: options.binary, cwd: options.cwd, provider: options.provider, resume: options.resume, providers, directory: options['auth-directory'] ?? join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'polycode', 'auth') });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(code => process.exit(code), () => { console.error('Polycode native startup failed. Check the installed runtime and workspace.'); process.exit(1); });
}
