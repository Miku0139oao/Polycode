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

## Outstanding acceptance

- Old WSL package: binary help and shipped Bun execute; signed-out TUI observed.
  These checks do not resolve real provider failures.
- New Windows TUI and coding observations must bind to the resulting package hash.
- Clean Windows 10 and Windows 11 without WSL must be tested separately from CI.
- Grok/ChatGPT/Cursor real login and generation require user web authorization.
- Paid Grok generation remains unauthorized; wait for suitable test quota.
- Existing user installation and PATH remain unchanged until all gates pass.
