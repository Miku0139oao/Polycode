# Native checkpoint: tested core, release still pending

## Later parent checkpoint (2026-09-07, not a release)

Source **`8e44bf2`** (Rust contents of `041f1a2` plus a JS-only Cursor expiry fix).
Development binary SHA-256
**`2fbf2c63edd6371e0e76116bec9b02b5610f322d4547117c572a40dce679c029`**,
553,893,040 bytes, same unoptimized profile as below. Build
`native-app-build-041/report.json`, 636s, `--offline --locked`.

Mock-network permission/billing preflight on that exact hash:
**8/8 PASS** (ChatGPT-selected and Cursor-selected tool deny, allow-once,
billing deny, billing allow including painted continuation
`NATIVE_ACCEPTANCE_BILLING_ALLOW_CONTINUED`). Evidence
`native-billing-artifacts-041-1/report.json`.

Default-feature leader PTY plus native Task inheritance/result/child resume
also **PASS** on the same hash (`native-artifacts-041-default-tasks`; mock
endpoints only). Real vendor/paid paths remain **BLOCKED**. Live Cursor OAuth
is unproven; the JS fix only stops Unix-second `expiresAt` from being rejected
as already elapsed. No GitHub release.

The 18d unit-regression numbers below are unchanged and were not re-run on this
binary.

## Source and executable

- Rust source: `18dce8670c9767944e2a225a75dd10580a27e985`.
- Actual composition-root package: `xai-grok-pager-bin`, binary `xai-grok-pager`.
- SHA-256: `e8bc41336b6e40a4340a24cb37163c5448b31ab08aa790daf5c80ee09e3bde2e`.
- Size: 552,923,744 bytes. Development profile, opt-level 0, line-table debug info,
  debug assertions and overflow checks enabled. **Not release-optimized.**
- Build exit 0, 892.592s; Cargo JSON identifies a newly built non-test executable.

## Complete selected-package unit regression

Rust 1.94.0, offline/locked, seven selected packages, `--lib --bins -j2`.
Cases ran serially in their shared test processes with the **default stack**;
case-internal async/concurrency tests remained intact. No filters, new ignores,
stack inflation or snapshot updates. HOME/XDG, network and PID namespace isolated.
`TERM=xterm-256color`, no `NO_COLOR`, explicit `INSTA_WORKSPACE_ROOT`.

| Executed target | Passed | Failed | Existing ignored |
| --- | ---: | ---: | ---: |
| Pager library | 9,089 | 0 | 4 |
| Pager main | 41 | 0 | 0 |
| Pager render | 1,147 | 0 | 0 |
| Sampler | 235 | 0 | 0 |
| Shell library | 6,835 | 0 | 5 |
| Chat-history downgrade binary | 15 | 0 | 0 |
| Tools | 3,170 | 0 | 2 |
| Proto build | 3 | 0 | 0 |
| **Total** | **20,535** | **0** | **11** |

Exit 0, no timeout/abort, 1,750.270s total; compilation 18m11s.
The seven selected packages include the composition root, but Cargo reports no
additional separately executed harness beyond the targets above.
This does not establish every workspace integration/PTY/live test.

The six-package Windows MSVC all-targets check also passed at this revision
(308.934s). **Typecheck only**, not executed Windows unit suites or sandbox parity.

## Actual fullscreen native leader runs

The same executable passed both the restricted baseline and `--default-features`
profile. The latter omits always-approve, disable-web-search, no-memory,
no-auto-update and the dashboard override. Both still explicitly trust the
throwaway workspace, disable telemetry, suppress OS browser dispatch and use
mock account endpoints inside a loopback-only namespace.

Verified by the actual native engine:

- Signed-out fullscreen startup and mock TUI login/cancel.
- Same-process provider/model changes with preserved conversation.
- Streaming before HTTP completion; cancellation and recovery.
- Native file-tool result containing a fixture-only random value.
- `/new` preserving Cursor and native title/helper routing.
- Actual stdio MCP initialize/discovery/tool call/result.
- Under defaults: real MCP permission card; zero calls while pending; exact
  single-use **Yes** selection; exactly one call after approval. The highlighted
  blanket-approval option was not selected.
- Redirect traps untouched; no bridge bearer in terminal, persistence or MCP
  child environment.

The integrated harness/profile tests also passed **29/29**. A first default run
stopped at MCP approval; this was repaired by explicit single-use UI selection,
not by reintroducing automatic approval or relaxing assertions.

## Evidence locations in the development workspace

Under `D:/ai-harness/`:

- `native-full-regression-6/{report.json,cargo.stdout,cargo.stderr}`.
- `native-windows-integrated-check-6.{timing.json,stdout.log,stderr.log}`.
- `native-app-build-18d/{report.json,cargo.stdout,cargo.stderr}`.
- `native-artifacts-18d-baseline/` and `native-artifacts-18d-default-2/`.
- `native-default-draft-tests-4.{stdout,stderr}`.

These paths identify local evidence, not published release assets. The tested
profile script and its unit tests were copied byte-identically into this repo.

## Still open

Native Task runtime, denial/billing scenarios, resume and remaining feature-path
acceptance, actual packaged WSL browser/login, live native Grok/ChatGPT/Cursor
protocol/account acceptance, release packaging, clean installation, README
one-command verification and publication. See the full gates in
[VERIFICATION.md](../VERIFICATION.md). No native completion or release claim yet.
