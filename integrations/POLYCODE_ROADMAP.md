# Polycode completion roadmap

This is the current planning index, not a completion or release certificate.
The owner subsequently authorized a separately scoped Windows v0.2.1 Preview;
see [Preview policy](PREVIEW_POLICY.md) and the
[version-specific notes](acceptance/preview-v0.2.1/release-notes.md). The original
full-acceptance goal remains incomplete; Preview approval does not waive it.
Snapshot: 2026-09-08, Polycode `b0adcea8b182a623f1b85ad880e72119a5fe177f`.
Historical verification documents remain evidence for their recorded bytes only.

Local execution has since repaired the bridge and added actual Bun/native-tool
regressions. See [the goal status report](POLYCODE_GOAL_STATUS.md) for tested
commits, captured evidence and external blockers. The original baseline below
is historical; no current GitHub candidate or full acceptance is implied.

Current continuation: five tested commits through `39b25f3` were pushed to the
existing branch with owner authorization. Run 34200363453 passed compilation,
native unit tests, packaging and installed startup but failed the native shell
fixture. A real background-command reproduction now has a tested fixture fix;
new build-only run [34213482617](https://github.com/Miku0139oao/Polycode/actions/runs/34213482617)
completed successfully. Its downloaded candidate passed source/asset/native hash
checks, two actual installed-entry runs and both complete native Node/Bun probes.
Owner-assisted ChatGPT/Cursor OAuth, coding and resume now pass on this candidate;
Grok OAuth also passes. The owner authorizes continued testing on the current
Windows 11 host instead of repeating VM OAuth. This is host functional validation,
not clean-OS acceptance. Grok generation remains blocked by the conditional US$1
limit, and clean Windows 10/11 evidence remains absent. See the goal status report
for exact hashes, the retained failed Cursor session and subsequent new-session
success, and the incomplete Server 2025 supplemental check.

## Product goal and non-goals

Deliver native Windows Polycode with Grok, ChatGPT subscription and experimental
Cursor selection in one TUI. Preserve the native agent, tools, MCP, permissions,
Task children and sessions. No WSL or external Codex/Cursor agent is required.

Keep working provider code. Open Grok is an independent read-only reference,
not a replacement repository or permission to rewrite ChatGPT. Do not wholesale
merge it, replace the bridge, or change the product base without a separate
design decision. Cursor protocol behavior must have Cursor-specific evidence;
Codex transport semantics cannot simply be copied into Cursor.

## Pinned references

| Source | Revision | Purpose |
| --- | --- | --- |
| https://github.com/mweinbach/open-grok | `3ac589afb9b156e7105ba889c0564ea526c8e281` | Provider/auth/protocol separation and existing Codex design |
| https://github.com/Yukaii/yet-another-opencode-cursor-auth | `025955752cf821e4bb827ef9b8d74c763a71d57f` | Existing Cursor protocol provenance; not an external executor |

Local Open Grok reference destination: `D:\ai-harness\open-grok-reference`,
detached at the pinned revision. Reference documents:
`docs/provider-architecture.md`, `docs/codex-provider-port.md` and `LICENSE`.
Open Grok first-party licensing is Apache-2.0; review third-party notices before
porting source. Cursor's existing MIT attribution and exact adapted sources are
in [PROVENANCE.md](native-provider/cursor/PROVENANCE.md).

## Verified baseline and limits

- Current Node run: 135 provider tests plus four candidate-readiness tests,
  **139 PASS, zero failures/skips**. No real credentials or paid calls were used.
- Local `c802eea` candidate has prior real ChatGPT/Cursor login, native tool and
  resumed fresh-file evidence. Local manifest SHA256:
  `fa800447d1c8c1ad8477adf460b5cc26f90a4bfb3331a719d61d039ca7899d58`;
  native SHA256:
  `37c460cb54cc7ae53a40f990f4ae82182d6990fd045c9eadc1c5052c273d66ee`.
  Local records: `D:\ai-harness\POLYCODE_LIVE_CHECKPOINT.md`,
  `D:\ai-harness\live-codex-c802-evidence.json` and
  `D:\ai-harness\live-cursor-c802-evidence.json`.
  These are historical local observations, not current GitHub artifact acceptance.
- GitHub run [34195838203](https://github.com/Miku0139oao/Polycode/actions/runs/34195838203)
  was still building at inspection. Bridge/installer tests and terminal transport
  preflight passed; downstream build/package/install acceptance remained pending.
  Run 34195555822 establishes the terminal probe only, not full candidate success.
- No runtime code changes are needed merely because older documents still call
  completed local work unverified. Refresh the evidence scope first.

## Prioritized work and acceptance

| Priority / item | Current status | Implementation / reference | Required closure |
| --- | --- | --- | --- |
| P0 fixed source and baseline | Reference pinned; offline baseline PASS | References above; `native-provider/test/`, `cursor/provider.test.mjs` | Confirm reference checkout HEAD and clean status; retain test command/results |
| P0 native Windows candidate | Implemented; latest CI pending | `install.ps1`, `launch.ps1`, `.github/workflows/candidate-release.yml`, `tests/WINDOWS_TERMINAL.md` | Complete latest CI; download artifact and verify source, manifest and native hashes |
| P0 Cursor login/catalog/generation/tools | Historical local live PASS; target artifact unverified | `native-provider/cursor/`, `service.mjs`, shell `src/polycode.rs`; Cursor provenance | Same TUI login, model selection, read/write/PowerShell and multiple correlated tool-result rounds on target package |
| P0 ChatGPT preservation | Historical local live PASS; offline regression PASS | `native-provider/codex.mjs`, `service.mjs`, Open Grok Codex contract | No rewrite; repeat affected tests and target-package coding/resume without regressions |
| P0 cancellation/session/provider isolation | Offline coverage and local observations; full target acceptance open | Cursor continuation, store/service, Rust model switch and session persistence | Cancel stream, normal quit, fresh-file resume, switch providers, no duplicate side effects or credential/history crossover |
| P0 clean Windows 10/11 | BLOCKED until clean environments available | `WINDOWS_VALIDATION.md`, candidate gates | Separate no-WSL Windows 10 22H2 and Windows 11 x64 runs; CI/restricted PATH cannot substitute |
| P0 real Grok | BLOCKED on owner authorization and quota | Native authentication/sampler; `candidate-readiness.mjs` | Real OAuth and generation with explicit bounded paid-test permission |
| P1 MCP/Task/permission/billing | Offline observations; candidate-bound evidence open | `tests/windows-native-tools.mjs`, native permission/billing tests | Exact approvals and denials, child route inheritance, result correlation; honor gate-specific permitted offline scope |
| P1 Cursor capability fidelity | Known limitations; live compatibility incomplete | Cursor `index.mjs` request validation and `content.mjs`; provenance | Record supported/unsupported/unknown controls, roles, images, usage and context behavior; reproduce actual failures before patching |
| P1 model switching and reasoning | Implemented controls; parity not claimed | `model-settings.mjs`, shell model switch; Open Grok catalog policy | Validate busy-turn scheduling, cancellation and resume; preserve explicit unsupported Ultra behavior until an evidenced design exists |
| P1 long history and auxiliary routing | Comparison/verification pending | Codex conversion, Rust history/compaction and helper routes; Open Grok continuity contract | Inspect opaque reasoning, compaction and helper routing; no cross-provider data export; separate optional parity from essential fixes |
| P1 documentation | Updated index; older detailed ledgers historical | Root README, `VERIFICATION.md`, native-provider README | Current links lead here; historical counts and WSL assumptions never become current acceptance |
| Release | BLOCKED | `candidate-readiness.mjs`, `release-readiness.mjs` | All required gates tied to one unchanged package; publishing/activation authorized separately |

Unsupported errors are safeguards, not proof of feature parity. In particular,
Cursor currently rejects unlisted request options and strict function schemas;
Polycode filters Ultra because its native sampler cannot represent it. These
are comparison items, not authorization to drop validation or silently downgrade.
Open Grok's optional advanced Codex features are not all mandatory for this scope.

## Execution milestones

### Architecture findings from the pinned comparison

- **Supported:** `service.mjs:144` resolves the selected provider's credential
  snapshot and exact advertised model before calling its transport. Rust
  `polycode.rs:487` registers Chat Completions routes with fail-closed auth.
  Cursor `index.mjs:293` returns unexecuted MCP intents; native engine ownership
  is retained rather than delegated to the reference's remote executors.
- **Supported with offline coverage:** Cursor continuation requires account,
  full transcript, configuration and exact pending tool identity (`index.mjs:235`).
  This protects parked tool results; it does not establish live cross-provider
  session acceptance on a new package.
- **Known limitations:** Cursor `protocol.mjs:177` represents system/developer
  content as ordinary USER rules, not privileged roles. `content.mjs:8` accepts
  bounded inline PNG/JPEG/GIF/WebP with auto detail, not arbitrary remote images.
  Unknown context size is retained as null. Strict schemas and explicit unsupported
  sampling/length/reasoning options remain rejected rather than silently removed.
- **Known Codex parity gaps, not permission to rewrite:** `codex.mjs:74` requests
  encrypted reasoning but its Chat Completions translation has no durable opaque
  item replay contract equivalent to Open Grok's Responses history. It also uses
  a 128000 context fallback when the catalog omits context (`codex.mjs:236`).
  Native long-history/compaction and auxiliary routing need their own validation;
  basic coding success does not establish these advanced contracts.
- **Demonstrated shared defects, repaired locally:** the HTTP relay accumulated
  33 close listeners across 32 backpressured writes. Bun 1.3.14's Node HTTP
  compatibility server also failed to propagate a real socket disconnect to the
  upstream AbortSignal. The Node adapter now removes both competing listeners;
  the Bun launch path uses native `Bun.serve` Request cancellation with the same
  shared authentication, catalog and routing dispatcher. Actual loopback HTTP
  regressions live in `native-provider/test/bridge-stream.test.mjs`. This runtime
  change requires a matching new CI artifact; the existing b0adcea build cannot
  be relabeled as acceptance of the repair.

Inspection evidence: private goal scratch `architecture-inspection.log` and
`initial-inspection.log`; these contain source matches and CI metadata, not tokens.

1. **Reference and inventory:** finish fixed checkout, inspect scoped instructions,
   map provider/auth/transport boundaries, and classify each difference as already
   satisfied, known limitation, demonstrated defect, or unverified.
2. **Minimal fixes:** prioritize demonstrated Cursor and shared P0 defects. Add a
   failing regression first, patch only the responsible layer, then rerun affected
   suites. Keep ChatGPT and native engine ownership intact. No speculative rewrite.
3. **Exact-package regression:** after latest CI succeeds, download its artifact to
   an isolated directory. Verify manifest/native hashes and bundled search/runtime
   dependencies. Test startup, tools, MCP/Task, cancellation and resume on those bytes.
4. **Owner-assisted acceptance:** sequential real logins and bounded generation,
   clean OS runs, sanitized evidence and candidate gates. Missing accounts, quota,
   VM or pending CI remain explicit BLOCKED/pending, not fabricated PASS.
5. **Handoff:** report changes, commands, source/package hashes and remaining gates.
   Request release/installation authorization separately after acceptance.

## Reproduction and evidence

From the Polycode root, offline baseline:

```powershell
node --test integrations/native-provider/test/*.test.mjs integrations/native-provider/cursor/provider.test.mjs integrations/tests/candidate-readiness.test.mjs
```

Repeat provider suites with Windows Bun. Use existing installer/readiness suites
listed in [Windows validation](WINDOWS_VALIDATION.md). If Rust changes, run focused
crate tests and one release build at a time; never increase stack limits or weaken
assertions to obtain PASS.

For an actual downloaded candidate, set `NODE_PTY_MODULE` to the test-only pinned
node-pty installation and follow the existing scripts:

```powershell
node integrations/tests/windows-candidate-smoke.mjs CANDIDATE_DIRECTORY
node integrations/tests/windows-native-tools.mjs NATIVE_EXE --mcp --task --grep --clean-path --ripgrep INSTALLED_RG_EXE
node integrations/tests/windows-live-login.mjs CANDIDATE_DIRECTORY codex --interactive-login
node integrations/tests/windows-live-login.mjs CANDIDATE_DIRECTORY cursor --interactive-login
node integrations/candidate-readiness.mjs CANDIDATE_DIRECTORY EVIDENCE_DIRECTORY v0.2.1
```

Replace placeholders with verified paths; the tools executable must match the
candidate native hash. Login probes do not send generation or prove coding.
Run browser flows sequentially with the owner. Candidate acceptance requires
all 14 gates, exact manifest/native identities and nonempty hashed evidence
within seven days. Only Task/MCP and billing/permission gates permit offline mode.

Never read or print credential files, import another CLI's tokens, call paid Grok
without a stated allowance, overwrite the user's installation/PATH, kill existing
TUI sessions, or publish/push as part of this planning work.
