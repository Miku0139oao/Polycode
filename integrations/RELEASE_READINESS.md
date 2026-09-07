# Unpublished candidate / fail-closed release procedure

**No publication is authorized.** Packaging, installation, mock PASS, or even this
readiness guard returning PASS does not authorize a release, draft, upload, push,
or tag. Only the parent may obtain/issue that authorization after all necessary
acceptance passes. No script here performs remote mutations.

## Current blockers

- Latest user clarification on the native launcher: **ChatGPT and native Grok
  work; only Cursor OAuth fails**. Cursor is **FAIL — user reported**, not merely
  an external blocker. ChatGPT's report is not a candidate-hash-bound formal gate
  PASS. The parent owns reproduction and official-browser interaction.
- Provider-aware `/usage` and TUI branding fixes are pending with other writers.
  The e8 development candidate is preparation only and will be old after those
  Rust changes: final rebuild, applicable retests and candidate hash update are
  mandatory. This packaging work does not modify Rust or `/usage`.
- Real-provider Task model inheritance/result/resume (both providers), tool
  reject/allow-once, real native billing deny/allow, official browser handoff and
  integrated installed-entrypoint acceptance are **not accepted**. Mock success
  is preflight only. Paid calls require a separately authorized test budget.
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
with glibc >=2.43, zlib/libgcc, Windows interop, and already-built native/Bun ELF
executables. There is no native Windows sandbox-parity claim. Bun is pinned to
1.3.14 here; Node >=20 is a maintainer-only prerequisite for the readiness/test
scripts, not the installed application.

```powershell
npm --prefix integrations/native-provider ci --ignore-scripts --offline
powershell -NoProfile -File integrations/package-release.ps1 -Binary /root/grok-build-target/debug/xai-grok-pager -BuildReport D:/ai-harness/native-app-build-18d/report.json -Output D:/ai-harness/native-release-candidate-18d
```

Output must not exist. Preparation verifies ELF architecture, source report
hash/size/profile/revision, native flags, Bun version/hash/revision, ldd closure,
and the real bundled model-bridge dependencies. It emits `polycode-runtime.zip`,
`polycode-wsl-x64.gz`, `polycode-bun-wsl-x64.gz`, `install.ps1`, `manifest.json`
and `SHA256SUMS`. Only explicitly selected runtime/license/provenance files enter
the ZIP, never existing user credential directories. `manifest.json` inventories
the exact ZIP files and assets; **candidate identity is its raw-byte SHA256**.
The native hash remains the exact build report hash, not a stripped derivative.
Without a build report the manifest is `fixture-unattested`; the guard rejects it.
Failure diagnostics are retained beside the requested output.

Local one-command install of that candidate, without PATH/registry changes:

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
node integrations/release-readiness.mjs --candidate D:/ai-harness/native-release-candidate-18d --acceptance D:/ai-harness/native-release-candidate-18d-acceptance.json --attestation D:/ai-harness/native-release-candidate-18d-parent.json --output D:/ai-harness/native-release-candidate-18d-readiness.json
```

Missing files, partial/duplicate records, FAIL/BLOCKED/MISSING gates, stale hashes,
changed evidence, wrong profile, old observations or absent parent review produce
exit 1. Output is exclusive-create; failures preserve diagnostics. Exit 0 means
only **prepublication evidence complete**, with `publicationAuthorized:false` and
`publicUrlGate:DEFERRED_UNTIL_PUBLICATION` still explicit.

After all necessary PASS, the parent must separately authorize any publication.
These scripts intentionally cannot mark a candidate as published. Converting to
final public assets or changing a manifest changes candidate identity and requires
fresh verification; never relabel accepted bytes silently. Once actual public
assets are available, the parent must review the version-pinned installer URL,
README command and immutable asset checksums, run the real downloaded one-command
flow in a new isolated root, then separately record the final public-URL gate.
Until then the README public command is a deferred plan, not a working-release
claim. SHA256 detects corruption, not a compromised publisher.
