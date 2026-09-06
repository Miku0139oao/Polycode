import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import lockfile from 'proper-lockfile';

// The lock covers remote token rotation AND commit across all Polycode processes.
export class CredentialStore {
  constructor(directory) { this.directory = resolve(directory); }
  path(provider) { if (!['codex', 'cursor'].includes(provider)) throw new Error('Unknown subscription provider'); return join(this.directory, provider + '.json'); }
  async snapshot(provider) {
    try {
      const data = await readFile(this.path(provider), 'utf8'); if (data.length > 65536) throw new Error('Invalid credential store');
      const value = JSON.parse(data);
      if (value.version !== 1 || typeof value.revision !== 'string' || !value.credential) throw new Error('Invalid credential revision');
      return value;
    } catch (e) { if (e.code === 'ENOENT') return { credential: null, revision: null }; throw e; }
  }
  async get(provider) { return (await this.snapshot(provider)).credential; }
  async set(provider, value, guard = () => true) { return (await this.update(provider, () => value, guard)).committed; }
  async update(provider, updater, guard = () => true) {
    const file = this.path(provider);
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let compromised = false;
    const release = await lockfile.lock(file, { realpath: false, stale: 60000, update: 10000, retries: { retries: 100, minTimeout: 100, maxTimeout: 1000 }, onCompromised: () => { compromised = true; } });
    let tmp;
    try {
      const before = await this.snapshot(provider);
      const next = await updater(before.credential);
      if (compromised) throw new Error('Credential lock was lost');
      if (!guard()) return { ...before, committed: false };
      if (JSON.stringify(next) === JSON.stringify(before.credential)) return { ...before, committed: true };
      const after = { version: 1, revision: randomUUID(), credential: next };
      tmp = file + '.' + randomUUID() + '.tmp';
      await writeFile(tmp, JSON.stringify(after), { mode: 0o600 });
      if (compromised) throw new Error('Credential lock was lost');
      if (!guard()) return { ...before, committed: false };
      // No event-loop gap between guard and commit.
      renameSync(tmp, file); tmp = null;
      return { ...after, committed: true };
    } finally {
      if (tmp) await unlink(tmp).catch(() => {});
      await release().catch(() => {});
    }
  }
}
