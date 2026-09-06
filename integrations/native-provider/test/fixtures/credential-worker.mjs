import { CredentialStore } from '../../store.mjs';
const [directory, mode] = process.argv.slice(2), store = new CredentialStore(directory);
if (mode === 'refresh') {
  await store.update('codex', async existing => {
    process.stdout.write('locked\n');
    await new Promise(resolve => process.stdin.once('data', resolve));
    return { accessToken: existing.accessToken + '-rotated' };
  });
} else {
  process.stdout.write('started\n');
  await store.set('codex', { accessToken: 'new-account' });
}
process.stdout.write('committed\n'); process.stdin.destroy();
