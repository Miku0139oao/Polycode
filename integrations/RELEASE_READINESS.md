# Unpublished candidate / fail-closed release procedure

**No publication is authorized.** Packaging, installation, mock PASS, or even this
readiness guard returning PASS does not authorize a release, draft, upload, push,
or tag. Only the parent may obtain/issue that authorization after all necessary
acceptance passes. No script here performs remote mutations.

## Current blockers

- Latest user clarification on the native launcher: **ChatGPT and native Grok
  work; only Cursor OAuth fails**. Cursor is **FAIL — user reported**, not merely
  an external blocker. ChatGPT's report is not a candidate-hash-bound formal gate
  PASS. Latest Cursor stage: official website reports success but the TUI login
  fails. Parent main `211debd` adds secret-safe OAuth failure stages; that is
  diagnostics, not a demonstrated fix. The parent owns browser interaction.
- Provider-aware `/usage` and TUI branding fixes are pending with other writers.
  The e8 development candidate is preparation only and will be old after those
  Rust changes: final rebuild, applicable retests and candidate hash update are
  mandatory. This packaging work does not modify Rust or `/usage`.
- Real-provider Task model inheritance/result/child-task resume, **separate parent
  session resume** (both providers), tool reject/allow-once, real native billing
  deny/allow, official browser handoff and integrated installed-entrypoint
  acceptance are **not accepted**. Prompt identity, native reasoning effort and
  busy queued model-switch safe commit also require distinct evidence below.
  Mock success is preflight only. Paid calls require an authorized test budget.
- The available 18d executable is **development opt0, line-table debuginfo,
  debug assertions enabled, 552923744 bytes**; not release optimized. Packaging
  preserves its bytes, does not strip it, and never invokes a Rust build.
- Regression report: parent-provided 20535 PASS, 0 FAIL, 11 upstream ignored at
  default stack. This is not a live-provider or installed-package result.
- Final public-URL README smoke: **DEFERRED_UNTIL_PUBLICATION**, never PASS before
  assets actually exist. It is distinct from prepublication readiness, avoiding
  the circular requirement to publish in order to authorize publication.

## Prepare and inspect (local only)

Requires Windows PowerShell 5.1+/7, an existing `archlinux` x64 WSL distribution
with glibc >=2.43, zlib/libgcc/libstdc++/ICU78, Windows interop, and already-built native/Bun ELF
executables. There is no native Windows sandbox-parity claim. Bun is pinned to
1.3.14 here; Node >=20 is a maintainer-only prerequisite for the readiness/test
scripts, not the installed application.

The old `D:/ai-harness/native-release-candidate-18d` from `c0371e3` is immutable
historical preparation, **schema1 and NOT promotable**. Do not overwrite it. No
new actual application package was built for this followup. After final Rust/JS
changes and a separately performed final build, use its actual report/binary and
another fresh output (replace the placeholders; these are not claimed artifacts):

```powershell
npm --prefix integrations/native-provider ci --ignore-scripts --offline
powershell -NoProfile -File integrations/package-release.ps1 -Binary /absolute/path/to/final-binary -BuildReport D:/evidence/final-build-report.json -Output D:/evidence/fresh-final-candidate
```

Output must not exist. Preparation verifies ELF architecture, source report
hash/size/profile/revision, native flags, Bun version/hash/revision, ldd closure,
and the real bundled model-bridge dependencies. It emits `polycode-runtime.zip`,
`polycode-wsl-x64.gz`, `polycode-bun-wsl-x64.gz`, `install.ps1`, `manifest.json`
and `SHA256SUMS`. Only explicitly selected runtime/license/provenance files enter
the ZIP, never existing user credential directories. `manifest.json` inventories
the exact ZIP files and assets; **candidate identity is its raw-byte SHA256**.
The native hash remains the exact build report hash, not a stripped derivative.
New inner/outer manifests use **schema2, `classification:"immutable-candidate"`**,
with **no publication `status` field**. This classification describes immutable
bytes, not whether they have been accepted, authorized or published. Neither
manifest, installer, ZIP, gzip nor SHA256SUMS may change at promotion.
Without a build report the manifest is `fixture-unattested`; the guard rejects it.
Failure diagnostics are retained beside the requested output.

Historical local one-command install of the unchanged c037/e8 preparation,
without PATH/registry changes (not final/live acceptance):

```powershell
$id=[guid]::NewGuid().ToString('N'); & D:/ai-harness/native-release-candidate-18d/install.ps1 -ArtifactDirectory D:/ai-harness/native-release-candidate-18d -AllowCandidate -InstallRoot "D:/ai-harness/polycode-candidate-install-$id" -LinuxRoot "/tmp/polycode-candidate-install-$id" -NoPath
```

Add `-StageOnly` to avoid activation even inside the isolated root. Never use
`%LOCALAPPDATA%/Polycode` or `/root/.local/bin/polycode` for acceptance. Use the
printed isolated launcher, not a PATH-resolved `polycode`. Production credentials
must not be inherited during offline preflight. The actual-package validator uses
an isolated home/environment and a per-process Linux network namespace with no
external network, retains its diagnostics/install tree, and runs only help/doctor
through the installed bridge/native executable. This is **not** full TUI, OAuth,
browser, Task, billing, or live installed acceptance.

```powershell
node integrations/tests/install-candidate.mjs --candidate D:/ai-harness/native-release-candidate-18d
node --test integrations/tests/install-native.test.mjs integrations/tests/release-readiness.test.mjs
```

## Required evidence: policy `2026-09-07.2` (30 gates)

`REQUIRED_GATES` in `release-readiness.mjs` is authoritative; the standalone
installer embeds the same list/version, checked by a drift test. Besides the
existing OAuth, tool/billing, browser/installed, usage/branding, regression,
hash/provenance and final-profile gates, these must not be collapsed:

| Required IDs | Distinct acceptance boundary |
|---|---|
| `task-inherit-{chatgpt,cursor}`, `task-result-{chatgpt,cursor}`, `task-resume-{chatgpt,cursor}` | Native child Task inheritance, correlated result and child-task resume |
| `session-resume-{chatgpt,cursor}` | Resume the parent/conversation session using the real provider; child-task resume is not this gate |
| `prompt-identity-{native,chatgpt,cursor}` | Actual provider-appropriate prompt/system identity, not merely TUI branding |
| `native-reasoning-effort-capability` | Supported values/capability and unsupported-model behavior |
| `native-reasoning-effort-ui` | Native UI selection/display and retained selected effort |
| `native-reasoning-effort-wire` | Exact effort applied to the actual provider request |
| `native-reasoning-effort-inheritance` | Native child Task receives the intended effort |
| `native-reasoning-effort-resume` | Effort survives the relevant native session resume |
| `busy-queued-model-switch-safe-commit` | While busy, queue a model switch and observe its actual safe commit; no premature/stale-provider request or merely changed highlight |

These behavioral gates require `mode:real`, candidate/native hashes and actual
redacted evidence files. Missing/partial records, mock-only evidence or a PASS
on another gate cannot substitute. All remain unaccepted by this packaging work.

## Evidence and parent review

Do not fill PASS from a fixture or fabricate a parent signature. Start an
acceptance document with `schemaVersion:1`, `candidateSha256`, `nativeSha256`, and
one record per exported `REQUIRED_GATES` in `release-readiness.mjs`. Each record:

```json
{
  "id": "oauth-cursor",
  "status": "FAIL",
  "reason": "User reports Cursor OAuth unusable; candidate reproduction pending",
  "candidateSha256": "<SHA256 of manifest.json>",
  "nativeSha256": "<SHA256 of actual uncompressed native executable>",
  "observedAt": "<actual ISO8601 observation time>",
  "mode": "real",
  "evidence": [{"path": "<actual redacted evidence file>", "sha256": "<SHA256>"}]
}
```

Every gate must be PASS, tied to both current hashes, with nonempty actual evidence
files whose hashes still match. Mock/fixture mode is rejected for all live gates.
Observations and review expire after seven days; new binary/bundle/installer bytes
change candidate identity and invalidate previous attestation. Regression,
hash-provenance and final-binary-profile use `mode:offline`. Hash-provenance must
reference the original build report. Final-binary-profile rejects opt0/debug
assertions even if a record says PASS. The exact development candidate therefore
cannot be approved for release by merely changing status text. A final binary
requires a fresh package and applicable regression/live acceptance again.

The parent independently reviews raw evidence, then alone writes attestation:
`schemaVersion:1`, `role:"parent"`, nonempty `reviewer`, `candidateSha256`,
`acceptanceSha256` (raw bytes), `reviewedAllRequiredGates:true`, actual `reviewedAt`,
`publicationAuthorized:false`, plus nonempty hashed `evidence` of its review.
This is a local human-review attestation, **not a cryptographic identity signature**;
it is not safe to run against attacker-authored evidence as a publishing robot.

```powershell
node integrations/release-readiness.mjs --candidate D:/evidence/fresh-final-candidate --acceptance D:/evidence/final-acceptance.json --attestation D:/evidence/final-parent-review.json --output D:/evidence/release-readiness.json
```

Missing files, partial/duplicate records, FAIL/BLOCKED/MISSING gates, stale hashes,
changed evidence, wrong profile, old observations or absent parent review produce
exit 1. Output is exclusive-create; failures preserve diagnostics. Exit 0 means
only **prepublication evidence complete**, with `publicationAuthorized:false` and
`publicUrlGate:DEFERRED_UNTIL_PUBLICATION` still explicit.

## Immutable promotion contract (no publication performed here)

1. Prepare the **final** schema2 package once. Run all necessary actual acceptance
   on that exact candidate hash. Parent reviews the evidence and writes the local
   review attestation above; it still does not authorize publication.
2. Run the guard. Its schema2 `polycode-readiness` output includes policy version,
   `checkedAt`, candidate/native hashes, acceptance-document hash, parent-review
   hash, and every verified gate. It has `status:PASS` **only if all checks pass**,
   and retains `publicationAuthorized:false` / deferred public-URL status.
3. Only after reviewing that exact output and obtaining publication permission,
   **the parent alone** may separately create `release-authorization.json` with
   the following contract. This is a schema illustration with placeholders, NOT
   an authorization for the existing candidate; no production issuer script or
   live parent authorization has been created by this work.

```json
{
  "schemaVersion": 1,
  "kind": "polycode-distribution-authorization",
  "scope": "public-distribution",
  "decision": "AUTHORIZED",
  "version": "<exact package version>",
  "candidateSha256": "<raw manifest.json SHA256>",
  "nativeSha256": "<actual uncompressed native SHA256>",
  "checksumsSha256": "<raw original SHA256SUMS SHA256>",
  "readinessSha256": "<raw PASS release-readiness.json SHA256>",
  "acceptanceSha256": "<same value as checked readiness>",
  "parentAttestationSha256": "<same value as checked readiness>",
  "parent": {
    "role": "parent",
    "reviewer": "<actual authorized parent identity>",
    "authorizedAt": "<actual ISO8601 authorization time>"
  }
}
```

4. The distribution consists of the **exact six accepted package files**, plus
   `release-readiness.json` and `release-authorization.json` as separate sidecars.
   Do **not** append them to SHA256SUMS or put them in the ZIP. Do not change an
   inner/outer manifest to `published-release`. The readiness hash is bound by
   authorization; authorization binds the original sums and manifest. This avoids
   self-referential hashes and preserves every accepted asset byte.
5. Remote-mode installation fetches both sidecars from the same version-specific
   trusted GitHub release origin. It rejects missing/FAIL/stale authorization,
   wrong candidate/native/version/sums/readiness/evidence hashes, incomplete or
   failed required gates, old policy, development/transformed binaries and any
   asset repack. It must run the exact accepted `install.ps1` file, not an inline
   scriptblock. Authorization must be issued within seven days after readiness
   and not in the future; once timely authorized, immutable release installation
   does not expire merely because seven days have elapsed.
6. **Local** `-ArtifactDirectory` always still requires `-AllowCandidate`, even if
   sidecars are present. `-AllowCandidate` never bypasses remote authorization.
   The installed tree retains the exact candidate manifest and the two sidecars
   outside the runtime ZIP inventory for traceability. Legacy schema1 is local
   preparation only and cannot be relabeled/promoted with this guard/installer.

Authorization/readiness files rely on the same **trusted publisher + HTTPS**
boundary as the installer itself; a `role:"parent"` field is not a cryptographic
signature or independent proof of who wrote it. Checksums do not protect against
a compromised publisher who replaces both executable installer and metadata.
Do not deploy this as an autonomous publisher for attacker-supplied evidence.
Revocation/key management is not claimed by this contract. Private/raw evidence
and credential paths do not need to be included in public sidecars, only hashes.

No manifest/sidecar claims that publication has already happened. Only after
separate parent authorization and actual public assets exist may the final README
one-command URL flow be tested in another isolated root. Record that final
public-URL result separately; do not rewrite accepted metadata to turn its
prepublication `DEFERRED_UNTIL_PUBLICATION` into PASS. Until that external step,
the public command is deferred, not a working-release claim.
