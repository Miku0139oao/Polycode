import { execFileSync } from 'node:child_process';
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { verifyPreview, PREVIEW_ASSETS } from './preview-readiness.mjs';

function gh(args) { return execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }); }
function requireThat(value, message) { if (!value) throw new Error(message); }
export function publishPreview({ candidate, evidence, version, runId, repository, policyRevision, output, resumeDraftId }, invoke = gh) {
  requireThat(repository === 'Miku0139oao/Polycode' && /^[a-f0-9]{40}$/.test(policyRevision), 'Invalid publication identity');
  requireThat(resumeDraftId === undefined || /^[0-9]+$/.test(resumeDraftId), 'Invalid explicit draft ID');
  const ready = verifyPreview(candidate, evidence, version);
  requireThat(ready.status === 'PREVIEW_READY', ready.reason || 'Preview evidence is not ready');
  requireThat(ready.candidateRunId === runId && ready.repository === repository, 'Build run mismatch');
  const api = path => JSON.parse(invoke(['api', path]));
  const build = api(`repos/${repository}/actions/runs/${runId}`);
  requireThat(String(build.id) === runId && build.status === 'completed' && build.conclusion === 'success' &&
    build.head_sha === ready.sourceRevision && build.head_repository?.full_name === repository &&
    build.path === '.github/workflows/candidate-release.yml' && build.event === 'workflow_dispatch', 'Build provenance mismatch');
  const refs = api(`repos/${repository}/git/matching-refs/tags/${version}`);
  requireThat(Array.isArray(refs) && !refs.some(ref => ref.ref === 'refs/tags/' + version), 'Tag already exists');
  const releasesForTag = () => {
    const pages = JSON.parse(invoke(['api', '--paginate', '--slurp', `repos/${repository}/releases?per_page=100`]));
    requireThat(Array.isArray(pages) && pages.every(page => Array.isArray(page)), 'Invalid release inventory');
    return pages.flat().filter(release => release.tag_name === version);
  };
  const existing = releasesForTag();
  if (resumeDraftId === undefined) requireThat(existing.length === 0, 'Release already exists');
  else requireThat(existing.length === 1 && String(existing[0].id) === resumeDraftId &&
    existing[0].draft === true, 'Explicit draft identity mismatch');
  mkdirSync(output, { recursive: true });
  const ledger = JSON.parse(readFileSync(join(evidence, 'preview.json'), 'utf8'));
  const notes = readFileSync(join(evidence, ledger.releaseNotes.path), 'utf8') +
    `\n\nPublication policy/evidence commit: \`${policyRevision}\`.\n` +
    `Evidence: https://github.com/${repository}/tree/${policyRevision}/integrations/acceptance/preview-${version}\n` +
    `Candidate build: https://github.com/${repository}/actions/runs/${runId}\n` +
    `Manifest SHA256: \`${ready.candidateSha256}\`.\n`;
  const notesFile = join(output, 'release-notes.md');
  writeFileSync(notesFile, notes);
  const title = `Polycode ${version} Preview (Windows x64)`;
  if (resumeDraftId === undefined) {
    invoke(['release', 'create', version, ...PREVIEW_ASSETS.map(asset => resolve(candidate, asset)), '--repo', repository,
      '--target', ready.sourceRevision, '--draft', '--prerelease', '--latest=false', '--title', title, '--notes-file', notesFile]);
  }
  const matches = releasesForTag();
  requireThat(matches.length === 1 && Number.isSafeInteger(matches[0].id), 'Exact draft ID not found');
  const draft = api(`repos/${repository}/releases/${matches[0].id}`);
  requireThat(draft.id === matches[0].id && (resumeDraftId === undefined || String(draft.id) === resumeDraftId) &&
    draft.draft === true && draft.prerelease === true && draft.tag_name === version && draft.name === title &&
    draft.target_commitish === ready.sourceRevision && draft.body === notes && Array.isArray(draft.assets) &&
    draft.assets.length === PREVIEW_ASSETS.length && new Set(draft.assets.map(asset => asset.name)).size === PREVIEW_ASSETS.length &&
    draft.assets.every(asset => PREVIEW_ASSETS.includes(asset.name) && asset.state === 'uploaded'), 'Unexpected draft metadata; left as draft');
  const downloaded = join(output, 'draft-download');
  mkdirSync(downloaded);
  invoke(['release', 'download', version, '--repo', repository, '--dir', downloaded]);
  const checked = verifyPreview(downloaded, evidence, version);
  requireThat(checked.status === 'PREVIEW_READY' && checked.candidateSha256 === ready.candidateSha256, 'Uploaded draft bytes failed verification; left as draft');
  for (const asset of PREVIEW_ASSETS) {
    requireThat(readFileSync(resolve(candidate, asset)).equals(readFileSync(join(downloaded, asset))), 'Uploaded draft differs; left as draft');
  }
  invoke(['release', 'edit', version, '--repo', repository, '--draft=false', '--prerelease', '--latest=false']);
  const published = api(`repos/${repository}/releases/${draft.id}`);
  requireThat(published.draft === false && published.prerelease === true && published.tag_name === version, 'Public release state mismatch');
  const tag = api(`repos/${repository}/git/ref/tags/${version}`);
  requireThat(tag.object?.type === 'commit' && tag.object.sha === ready.sourceRevision, 'Published tag source mismatch');
  const receipt = { ...ready, url: published.html_url, policyRevision, publishedAt: published.published_at,
    assets: PREVIEW_ASSETS.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(resolve(candidate, path))).digest('hex') })) };
  writeFileSync(join(output, 'publication-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [candidate, evidence, version, runId, repository, policyRevision, output, flag, resumeDraftId] = process.argv.slice(2);
    requireThat((flag === undefined && resumeDraftId === undefined) || (flag === '--finish-draft' && /^[0-9]+$/.test(resumeDraftId)), 'Invalid draft continuation arguments');
    console.log(JSON.stringify(publishPreview({ candidate, evidence, version, runId, repository, policyRevision, output, resumeDraftId }), null, 2));
  } catch (error) {
    console.error('Preview publication stopped: ' + error.message);
    process.exitCode = 1;
  }
}
