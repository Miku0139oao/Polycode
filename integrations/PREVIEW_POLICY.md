# Windows Preview policy

Policy: `polycode-preview-2026-09-08.1`.

This opt-in testing channel is distinct from full candidate acceptance and stable
distribution. The owner approved the reduced, explicitly disclosed Preview scope.
`preview-readiness.mjs` returns `PREVIEW_READY`, never a full-acceptance PASS.
The existing candidate and stable validators and installer authorization remain
unchanged. A Preview must not enable the stable one-command installer.

## Required evidence

Every observation is bound to the exact candidate manifest, native executable,
source revision and successful same-repository Windows build. Candidate assets
must match their original inventory and hashes, with release-profile provenance
and pinned Windows search dependency. Actual build status/source is rechecked
through GitHub before publication. Evidence must be no older than seven days;
verification time is not substituted for the original observation time.

| Gate | Evidence mode | Required scope |
| --- | --- | --- |
| host-install | real | Existing Windows 11 host, installed hash checks, all three menus, normal exit and terminal restoration |
| oauth-native | real | Actual Grok login; no generation claim |
| oauth-chatgpt | real | Actual ChatGPT login and model catalog |
| oauth-cursor | real | Actual Cursor login and model catalog |
| coding-chatgpt | real | Generation, native read/write, successful shell, exact file bytes and fresh-file same-session resume |
| coding-cursor | real | Same scope; Auto is persisted as cursor/default |
| offline-regression | offline | Node >=177 and Bun >=140 passing tests, no failures/skips; permissions and synthetic transport checks |
| native-tools | offline | Actual native shell/Task/MCP, approval, cancellation and resume using synthetic model responses |

Sanitized observations retain source evidence hashes and only necessary facts.
They are reviewed attestations derived from locally checked evidence, not public
raw transcripts or independently replayable proof of account behavior. The
validator checks their scope, structure, integrity and identity; it cannot
establish the truth of an arbitrary JSON claim. Private originals remain private.

## Explicit deferrals and limitations

- `generation-native`: Grok OAuth succeeded, but generation is untested. The
  owner's conditional US$1 limit could not be reliably enforced. No paid test
  request was sent. This is not a promise that end-user Grok usage is free.
- `windows10-clean-install` and `windows11-clean-install`: no clean-system
  acceptance. Local Windows 11 Pro build 26200 and Windows Server CI do not
  replace those gates. Windows 10 remains a target, not a certified Preview OS.
- `cursor-timeout-restart`: a rejected write was followed by upstream 504 and
  fail-closed 409 continuation rejection. The timeout cause is unknown. An
  explicitly new session passed; replay protection was not disabled. Restart
  explicitly after this error and check existing side effects before retrying.
- `server2025-incomplete`: supplementary VM installation/native startup passed,
  Codex exited normally without affirmative owner confirmation, and Cursor was
  not reached. Do not label the VM check PASS.

Provider-specific option, image, history and context-size limitations remain as
documented in the roadmap and provider documentation. Preview does not certify
full upstream feature parity, reliability under all failures or full billing
acceptance. None of these deferrals modifies the full release gate definitions.

## Publication and installation

The separate `publish-preview` workflow action checks the version-specific ledger
under `integrations/acceptance/preview-VERSION/`. Only a new tag/release is allowed.
API errors fail closed. Publication first creates a draft prerelease, downloads
and compares all six uploaded files, and only then promotes it to a public
prerelease with `--latest=false`. Failed draft verification does not publish.

Draft releases are resolved through the authenticated release inventory and exact
numeric release ID, not the public tag endpoint (which can return 404 for drafts).
After an interrupted authorized attempt, `publish-preview.mjs` accepts an explicit
`--finish-draft ID` only when the existing draft ID, tag, source, notes, title and
complete uploaded assets match. It rechecks all evidence and downloads/verifies
the bytes again; it never recreates a release or uploads/replaces assets in this
mode. A default invocation still rejects any existing release or tag.

If the Actions integration receives HTTP 403 creating a release, stop and retain
that failure. Do not weaken checks or export a personal credential into CI.
An owner-authorized operator with existing local GitHub permission may run the
same publisher locally; the CI failure must not be relabeled as success.

The tag points to the tested product source; release notes separately identify
the publication policy/evidence commit. Existing immutable files, manifests and
checksums are never rebuilt, relabeled or replaced. This means embedded package
documentation can retain the original pre-publication status. Current release
notes and this policy disclose the narrower distribution decision separately.

Use the version-specific release instructions and explicit `-AllowCandidate` or
`-GitHubCandidate` opt-in. Prefer a separate install/auth directory and `-NoPath`.
Do not import credentials or replace an existing production installation as part
of Preview verification. Stable/latest promotion needs separate full acceptance
and authorization.
