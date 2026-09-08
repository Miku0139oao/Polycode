# v0.2.1 Preview publication record

Published at **2026-09-08T14:51:55Z**:
https://github.com/Miku0139oao/Polycode/releases/tag/v0.2.1

The release is public (`draft=false`), explicitly a prerelease, and was promoted
with `--latest=false`. This is Preview distribution only, not full acceptance or
stable authorization. Install instructions and all limitations are in its notes.

## Immutable identities

- Build run: [34213482617](https://github.com/Miku0139oao/Polycode/actions/runs/34213482617), successful.
- Product tag/source: `39b25f39df9b1b7341ba7957c0ea54167ea80af8`.
- Manifest SHA256: `6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a`.
- Native SHA256: `919fd8eb3ce146a594f04daa05a0819b6543fcf95479dbbed9510d16f0c78536`.
- Initial publication policy/evidence commit: `9d20e54ea7ed82cd53aa13e1f5accf9324e0c5f2`.
- Tested publisher draft-ID repair: `eca9b3f80e46fba413108794b33e6429415705c3`.
- Public release ID: `384821119`.

All six files came from the successful build unchanged. No rebuild, repack,
manifest relabeling, asset replacement or credential export occurred.

## Failed attempts and recovery

The Preview workflow run
[34240210179](https://github.com/Miku0139oao/Polycode/actions/runs/34240210179)
passed policy/publisher tests but failed when its Actions integration received
HTTP 403 creating the release. It created neither a draft nor a tag. That run
was a failure, not successful publishing CI. The owner subsequently requested
removal of failed Actions runs for dashboard cleanup. Historical run links may
therefore no longer resolve; the diagnostic records are retained privately and
their outcomes are not relabeled as PASS.

The owner-authorized local GitHub identity had repository administration access.
Running the same guarded publisher locally created the draft and uploaded the
six original assets. A subsequent draft lookup through the public tag endpoint
returned 404, stopping before public promotion. This publisher defect was
reproduced in tests and repaired to use authenticated inventory plus exact ID.

The repaired publisher explicitly continued only draft `384821119`, checked its
exact notes/title/tag/source and complete asset inventory, downloaded and compared
all files, then made it public as a non-Latest prerelease. It did not recreate the
release or upload/replace any asset during continuation. No personal credential
was copied into Actions or printed.

## Post-publication verification

- Downloaded all six public asset URLs without authentication, with curl config
  disabled and HTTPS-only redirects. Every SHA256 matched the original CI files.
- Ran the Preview validator against those publicly downloaded files: `PREVIEW_READY`.
- Installed those files in a fresh isolated local test directory with `-NoPath`.
  Native/Grok, ChatGPT and Cursor provider menus, alternate-screen restoration,
  exit code 0 and no forced exits all passed through actual ConPTY.
- Final full Node regression: **187 passed, 0 failed, 0 skipped**. The latest
  bundled-Bun provider regression passed **140 tests, 0 failures**.
- This public-download smoke did not repeat OAuth, send a model request, certify
  a clean OS or alter the owner's production installation/PATH.

Grok generation, clean Windows 10/11 and the recorded Cursor recovery limitation
remain as disclosed. The original full-candidate/stable gates remain unchanged;
Preview evidence does not make them PASS.
