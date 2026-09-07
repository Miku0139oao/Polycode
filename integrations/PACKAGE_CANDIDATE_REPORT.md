# Actual 18d preparation candidate — NOT a release

**Historical c0371e3/schema1 evidence below, not current final acceptance.** The
candidate directory and its six files remain untouched. The followup adds required
behavioral gates and a schema2 immutable-promotion contract; schema1 cannot be
promoted by relabeling. See [current procedure](RELEASE_READINESS.md) and
[followup report](PACKAGE_PROMOTION_FOLLOWUP.md). No new actual application package
or 552MB binary rebuild/recompression was performed for the followup.

Local packaging/installation evidence only. No release, draft, upload, push, tag,
remote mutation, Rust compilation, agent delegation, PATH/registry change or
existing-install replacement was performed by this work.

## Candidate identity / artifacts

Directory: `D:/ai-harness/native-release-candidate-18d` (fresh, not an old release).
Candidate identity (SHA256 of raw `manifest.json`):
`7819c5c7cffede5fd4524a3444c1acf74553dfa976c6a471912a1b526fe32e76`.

| Asset | Bytes | SHA256 |
|---|---:|---|
| `polycode-wsl-x64.gz` | 128414579 | `f850cafebd1472d275970569c32bb090e4ce0fe6d4bdb23315a668963787695b` |
| `polycode-bun-wsl-x64.gz` | 24453723 | `5b47f2eabef63fc9245abdd9d8a37d68742bf510f56c7c1ddbc663ab2672d3d1` |
| `polycode-runtime.zip` | 138919 | `0d5c9199113d21eb3ce05a97ad81f8d61d595619c269e32d6fefb02b2800e656` |
| `install.ps1` | 14969 | `b0a6f06ce43e167770e2768bf53101bafc7d7989f923e9777f102ee2c780ab0e` |

Also emitted `manifest.json` and `SHA256SUMS`. The manifest inventories every ZIP
file and preserves source build report/profile/hash and ELF/ldd observations.
The ZIP contains the actual bundled native model bridge, not an external agent.
Dependencies and licenses included: proper-lockfile 4.1.2, graceful-fs 4.2.11,
retry 0.12.0, signal-exit 3.0.7, vendored Cursor provenance and Bun notices. Only
explicit runtime/license/provenance files are selected, no inherited auth files.

- Actual composition-root executable source:
  `/root/grok-build-target/debug/xai-grok-pager`, source revision
  `18dce8670c9767944e2a225a75dd10580a27e985`.
- Uncompressed native SHA256:
  `e8bc41336b6e40a4340a24cb37163c5448b31ab08aa790daf5c80ee09e3bde2e`,
  **552923744 bytes, dev opt0, line-tables-only, debug assertions/overflow checks**.
  Copied byte-for-byte, never stripped/rebuilt; **not release optimized**.
- Bun `/usr/sbin/bun`: SHA256
  `87246797aad9dfb50056faae8cd7e7708b88837378d07964e972480d953b19e6`,
  69228264 bytes. `--version`: `1.3.14`; actual `--revision`:
  **`1.3.14-canary.1+0d9b296af`**. Do not imply official portable release provenance.
- Both are verified actual Linux x86_64 ELF. Native ldd closure uses glibc,
  libz, libgcc, libm. **This Arch Bun additionally uses libstdc++ and ICU 78**
  (`libicui18n.so.78`, `libicuuc.so.78`, `libicudata.so.78`). Those OS libraries
  are prerequisites, not bundled. The packaged installer's header/general
  prerequisites paragraph is not an exhaustive ldd list; use the manifest and
  the corrected root README. No missing libraries on the tested Arch glibc2.43.

## Commands and outcomes

Executed from Windows; Git Bash invocations of PowerShell/WSL must set
`MSYS_NO_PATHCONV=1`. The first ad hoc hash/help probes and first packaging attempt
without it failed because Git Bash rewrote Linux absolute paths. No candidate
output/install was created by that rejected packaging attempt. Corrected commands:

```text
npm --prefix D:/ai-harness/polycode-accept-package/integrations/native-provider ci --ignore-scripts --offline
MSYS_NO_PATHCONV=1 wsl.exe -d archlinux --exec sha256sum /root/grok-build-target/debug/xai-grok-pager /usr/sbin/bun
MSYS_NO_PATHCONV=1 wsl.exe -d archlinux --exec file /root/grok-build-target/debug/xai-grok-pager /usr/sbin/bun
MSYS_NO_PATHCONV=1 wsl.exe -d archlinux --exec getconf GNU_LIBC_VERSION
MSYS_NO_PATHCONV=1 powershell.exe -NoProfile -ExecutionPolicy Bypass -File D:/ai-harness/polycode-accept-package/integrations/package-release.ps1 -Binary /root/grok-build-target/debug/xai-grok-pager -BuildReport D:/ai-harness/native-app-build-18d/report.json -Output D:/ai-harness/native-release-candidate-18d
node D:/ai-harness/polycode-accept-package/integrations/tests/install-candidate.mjs --candidate D:/ai-harness/native-release-candidate-18d
node --test D:/ai-harness/polycode-accept-package/integrations/tests/install-native.test.mjs D:/ai-harness/polycode-accept-package/integrations/tests/release-readiness.test.mjs
node --test D:/ai-harness/polycode-accept-package/integrations/tests/release-readiness.test.mjs
node D:/ai-harness/polycode-accept-package/integrations/release-readiness.mjs --candidate D:/ai-harness/native-release-candidate-18d --acceptance D:/ai-harness/native-release-candidate-18d-acceptance.json --attestation D:/ai-harness/native-release-candidate-18d-parent.json --output D:/ai-harness/native-release-candidate-18d-readiness.json
```

- **PASS** offline dependency install and candidate preparation (exit0).
- **PASS** actual package hashes, safe archive extraction/inventory, decompressed
  ELF/native flags, shipped Bun and real bundle import.
- **PASS** real install using **both Windows PowerShell5.1 and PowerShell7**, each
  in a different disposable root, with `-ArtifactDirectory -AllowCandidate -NoPath`.
- **PASS** each installed `bin/polycode.cmd` forwarded `--help` and `doctor` through
  the real shipped bridge and native binary, bounded at30s (45s outer timeout),
  isolated HOME/XDG/environment and `unshare --net` (loopback only).
- **NOT full terminal health PASS**: `doctor` exits0 but reports missing clipboard,
  microphone and limited color in this noninteractive isolated environment;
  fullscreen/Kitty running-session checks are unavailable. No full TUI/live claim.
- **PASS** protected `%LOCALAPPDATA%/Polycode`, `/root/.local/bin/polycode` and user
  PATH snapshots unchanged. No account network/auth or credential files created.
- **PASS** current fixture/policy suite: **23 tests, 0fail, 0skip** (12 installer
  fixtures +11 release-policy tests). These are not the actual-package install
  result above. After adding usage/branding to the required gate set, reran the
  11 policy tests: **11pass, 0fail, 0skip**, including every required gate's
  FAIL/BLOCKED/MISSING rejection. No resource/stack inflation or assertion weakening.
- **EXPECTED BLOCKED / exit1** actual readiness: 19required gates, only local
  hash/provenance verified; all live/final prerequisites remain closed. No parent
  attestation was fabricated. `publicationAuthorized:false`.

## Preserved installation / evidence paths

Installed validation root:
`D:/ai-harness/native-release-candidate-18d-install-9dbaeba0-9f8f-4c93-813c-7d1891f050fa`.

Its `report.json` contains each exact command, exit code, install config, hash and
check result; `diagnostics/*.stdout` / `*.stderr` preserve raw command output.
Installed Windows launchers are `ps51/bin/polycode.cmd` and `ps7/bin/polycode.cmd`.
Linux validation root:
`/tmp/polycode-candidate-install-9dbaeba0-9f8f-4c93-813c-7d1891f050fa`.
Both trees remain for parent inspection, including isolated runtime wrappers that
only add OS isolation and then exec installed Bun; they do not replace providers.

Sibling evidence files under `D:/ai-harness/`:

- `native-release-candidate-18d-package.log`
- `native-release-candidate-18d-install.log`
- `native-release-candidate-18d-fixtures.log`
- `native-release-candidate-18d-readiness-tests.log`
- `native-release-candidate-18d-acceptance.json` (honest incomplete current state)
- `native-release-candidate-18d-readiness.json` / `.log` (expected rejection)
- Original build: `native-app-build-18d/report.json`.

## Remaining gates / limits

| Subcheck | Current status |
|---|---|
| Candidate package + PS5.1/7 offline installed preflight | PASS, exact hashes above |
| Current policy/installer tests | PASS, not live application evidence |
| ChatGPT and native Grok login | User reports working; candidate-bound formal gate still unaccepted |
| Cursor OAuth | FAIL, user-reported; parent owns reproduction/fix |
| Task inherit/result/resume on both real providers | BLOCKED / not accepted here |
| Tool reject/allow-once and real native billing deny/allow | BLOCKED / not accepted here; paid calls require authorized budget |
| Actual browser / integrated installed TUI workflow | BLOCKED / not accepted here |
| Provider-aware `/usage`, TUI branding | BLOCKED, separate writers; now explicit required gates |
| Full regression | Parent-provided20535/0/11upstream-ignored; not rerun here, final candidate binding/review needed |
| Final binary profile | FAIL for release: dev opt0/debug assertions |
| Parent attestation / publication permission | Missing / NOT authorized |
| Final README public URL command | DEFERRED_UNTIL_PUBLICATION, not tested and cannot PASS yet |

The e8 candidate is preparation only. Once OAuth/usage/branding changes merge,
**new final binary + candidate manifest hash, applicable full regression/live
retests and parent review are mandatory**. Existing e8 results cannot silently
accept new bytes. Readiness uses exact asset/evidence hashes, freshness and parent
review; it never invokes publication. Local attestation is not a cryptographic
identity proof and is not a safe autonomous publisher for untrusted evidence.
The public installer intentionally rejects these unpublished assets; no published
manifest or public-URL result has been manufactured. WSL acceptance does not imply
native Windows sandbox parity or portable Linux compatibility.
