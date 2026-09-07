# Windows native validation

Implementation/acceptance record, not a release announcement.
Target: x86_64-pc-windows-msvc, Windows 10 22H2 and Windows 11 x64.

## Build and package

Use a Visual Studio x64 developer terminal with Rust 1.94.0, protoc 29.3,
and Windows Bun 1.3.14. Install provider dependencies with
`npm ci --ignore-scripts --prefix integrations/native-provider`.

```powershell
cargo build --locked --release --target x86_64-pc-windows-msvc -p xai-grok-pager-bin --bin xai-grok-pager -j2 --message-format=json-render-diagnostics > cargo-build.jsonl
node integrations/build-report.mjs cargo-build.jsonl target/x86_64-pc-windows-msvc/release/xai-grok-pager.exe native-build.json
.\integrations\package-release.ps1 -Binary "$PWD\target\x86_64-pc-windows-msvc\release\xai-grok-pager.exe" -Runtime (Get-Command bun.exe).Source -BuildReport "$PWD\native-build.json" -Output "$PWD\candidate-out"
```

Stop after any nonzero exit. Build evidence uses Cargo's actual artifact profile.
Local dirty builds are identified in the report. All runtime files and executable
bytes are hashed in the candidate manifest.

Packaging fetches the pinned Windows ripgrep 15.0.0 archive into a build cache,
verifies its SHA256, and includes `vendor/rg.exe` plus its licenses in the runtime
ZIP. For offline packaging, supply `-RipgrepArchive` or
`POLYCODE_RIPGREP_ARCHIVE` pointing to that exact official archive. Installation
does not download search tools. The Windows launcher provides the installed
absolute path through `RG_BIN_PATH` to the native engine.

Windows manifests use schema 3, platform `windows`, target
`x86_64-pc-windows-msvc`, executableFormat `PE32+`. Windows installation rejects
legacy WSL manifests. The stable-readiness verifier can still inspect schema 2
Linux evidence; its acceptance gates are not relaxed.

## Offline verification

Run Node tests for native-provider/test, cursor/provider.test.mjs,
install-native.test.mjs, install-authorization.test.mjs,
release-readiness.test.mjs and candidate-readiness.test.mjs.

Installer integration uses a **synthetic x64 PE** and real Windows Bun to test
production packaging/install/launcher behavior on PS5.1/7. This is not native
TUI, OAuth, generation or billing acceptance.

`windows-candidate-smoke.mjs CANDIDATE_DIRECTORY` exercises an actual packaged
TUI through ConPTY. Set NODE_PTY_MODULE to the test-only node-pty module path.
It performs no real login or generation.

`windows-native-tools.mjs NATIVE_EXE` runs real native Read, Write and PowerShell
tools for both subscription routes using synthetic model responses. It approves
only individual operations, cancels a streaming response, checks the persisted
provider-qualified model ID, restarts the TUI and reads newly changed fixture
bytes from the resumed session. These are offline integration observations.

Add `--mcp --task` to exercise native MCP discovery/invocation and native Task
children for both subscription routes. MCP uses a local Node stdio fixture with
distinct unpredictable values, checks no invocation occurs before single-use
approval, and verifies the bridge token is absent from its process environment.
Task responses require an actual child model request on the parent's provider
and model, its generated value in the correlated result, and a typed child ID.
These flags still use synthetic model transport and do not satisfy live coding.

Use `--grep --clean-path --ripgrep INSTALLED_RG_EXE` alongside those flags to
verify native Grep with only Windows system paths available and the default
Windows shell selection. `windows-candidate-smoke.mjs` records the verified
installed path as `searchExecutable`; CI passes it to the native tools test.
This PATH restriction is not a replacement for a clean Windows VM.

## Interactive login

When the account owner is available, run each provider against the candidate:

```powershell
node integrations/tests/windows-live-login.mjs CANDIDATE_DIRECTORY codex --interactive-login
node integrations/tests/windows-live-login.mjs CANDIDATE_DIRECTORY cursor --interactive-login
```

Run sequentially. The harness installs into a fresh temporary directory without
changing PATH, prints the native TUI's authorization URL, and waits up to ten
minutes for the owner to complete browser login. A PASS requires the real model
picker and normal process exit. It does not send a generation request, inspect
credential files, or satisfy coding/generation acceptance. Reports and sanitized
terminal observations remain in the printed temporary directory. The browser
URL file and auth directory are private local artifacts and must not be uploaded.

## Prerelease evidence

The build action creates the `polycode-windows-candidate` Actions artifact.
The publish action downloads the selected build run without rebuilding or
overwriting a release, then runs:

```powershell
node integrations/candidate-readiness.mjs candidate-out integrations/acceptance/windows v0.2.1
```

The evidence directory contains acceptance.json: schemaVersion 1,
candidateSha256 (manifest.json hash), nativeSha256, and exactly CANDIDATE_GATES.
Each gate includes id, status PASS, observedAt, mode and evidence (relative path
plus SHA256). Observations must be within seven days; evidence must be nonempty
and inside that directory. Only Task/MCP and billing/permission regression allow
offline mode; other gates require real observations. Include only sanitized logs.

The candidate workflow never generates stable authorization sidecars.

## Local observations (2026-09-08)

Runtime revision `813a2137a2a5f4cde2d102e737c90574d2242b7e` built successfully
as a Windows MSVC release executable. Native SHA256:
`266065995bf3dc0d275bf75b7ff3b7557db4681ba6b869c0662379127e79419e`.
The local development package manifest SHA256 is
`8b3dfb67edaba0d401c1bb22f326bdb2f722936ad214446310164cb2007c5404`.
This package is not a published or accepted GitHub artifact.

- Packaged installation and signed-out ConPTY startup passed for native Grok,
  ChatGPT and Cursor, each with normal exit code 0.
- Actual native Read, Write and PowerShell execution passed for both subscription
  routes using synthetic transport and individual permission approvals.
- Cancellation reached the model stream. A subsequent restart preserved the
  canonical `cursor/mock-cursor` model identity and read fresh fixture bytes.
  No forced terminal exit or fixture error occurred.
- The resume defect was a persisted unqualified model ID. The fix preserves
  provider identity using the authenticated catalog and exact registered route;
  it does not relax native authentication checks.
- Extended `--mcp --task` regression passed on that same native executable:
  two MCP calls with individual approvals, no bridge token in the MCP child,
  and one native Task child per provider with the expected provider/model.
  Cancellation and session restart also passed in this run.
- A preceding extended run observed leader disconnection during Read and failed
  session reload. The IPC loop could cancel a partially consumed input frame
  when an outbound message arrived. It now retains the same read future until
  the frame completes. An isolated compilation of the production functions and
  regression test fails with the original loop and passes with the fix, covering
  interruptions in both the length prefix and body plus a subsequent frame.
  The full Windows shell test binary subsequently passed this regression and
  all 11 bridge tests. The rebuilt native executable also passed the complete
  Read/Write/PowerShell/MCP/Task/cancel/resume integration run.
- The old installed WSL package started ChatGPT/Cursor browser authorization and
  displayed Grok's browser approval screen. These observations do not reproduce
  or resolve the user's real account/generation failures.

### Search dependency correction

The native `5d75902` executable SHA256 is
`6e89915c6f30e62b4b18681d0e818073022b0ad71c3f2c1728f64b6addc85760`.
Its initial package lacked ripgrep: native Grep passed with developer tools on
PATH and failed with Windows system paths alone. That package is superseded.

With the same native engine and the corrected runtime package, installed startup
and the complete native integration run passed, including Grep for both providers
under the restricted PATH. The bundled executable SHA256 is
`a286ea6f4d0d8c1c6c2234728cf2d96afcf371c550086c11e1ea28730dcfb418`.
Installer tests cover forwarding its absolute path, executing the packaged search
tool, and rejecting a different archive. Publication now rejects an inventory
without this pinned dependency. A fresh clean-source candidate and GitHub artifact
are still required before live acceptance.

## Remaining acceptance

- Old WSL package: binary help and shipped Bun execute; signed-out TUI observed.
  These checks do not resolve real provider failures.
- New Windows TUI and coding observations must bind to the resulting package hash.
- Clean Windows 10 and Windows 11 without WSL must be tested separately from CI.
- Grok/ChatGPT/Cursor real login and generation require user web authorization.
- Paid Grok generation remains unauthorized; wait for suitable test quota.
- Existing user installation and PATH remain unchanged until all gates pass.
