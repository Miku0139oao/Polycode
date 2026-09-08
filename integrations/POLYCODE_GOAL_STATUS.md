# Polycode goal execution status

**INCOMPLETE / BLOCKED** — matching CI, candidate-bound native probes, all three
OAuth flows and real ChatGPT/Cursor coding/resume checks pass. Grok generation
and clean OS gates still prevent full acceptance. Current host verification is
authorized on Windows 11 Pro build 26200; it is not clean-OS acceptance.

The owner has now authorized an opt-in v0.2.1 Preview under the separate
[Preview policy](PREVIEW_POLICY.md). Its exact candidate and sanitized observations
pass `PREVIEW_READY`; this does not close the original full-acceptance gates.
The Preview is now publicly released; its
[publication record](PREVIEW_PUBLICATION.md) preserves the failed CI 403 attempt,
guarded local publication and successful anonymous-download/install verification.
Publication is separate from this historical full-acceptance goal checklist.

## Owner-authorized continuation

The owner subsequently authorized pushing exactly the four tested commits to
`fix/windows-terminal-ci` and build-only CI, and agreed to participate in
ChatGPT/Cursor browser login. The four commits are now pushed. Matching run
[34200363453](https://github.com/Miku0139oao/Polycode/actions/runs/34200363453)
targets `8447e98d35c8acd5e93af3d3f79f3ce7ecda3ca4` and failed the native shell
fixture after passing compilation, native unit tests, packaging and installed
startup. No candidate asset was uploaded; only diagnostic evidence is available.
The owner separately authorized the tested fixture-only repair `39b25f3` and a
new build-only run [34213482617](https://github.com/Miku0139oao/Polycode/actions/runs/34213482617),
targeting `39b25f39df9b1b7341ba7957c0ea54167ea80af8`, now successful.
The owner later authorized one short Grok generation capped at US$1, conditional
on reliably enforcing that limit. No monetary hard cap was established, so no
Grok generation was sent. The owner also authorized local host validation and a
pre-test snapshot/start of an existing Server 2025 VM. Those permissions do not
substitute for clean Windows 10/11 evidence. A subsequent explicit Preview plan
authorizes the policy/docs/test commits, push on the existing branch, and only
the new non-Latest prerelease; stable publication remains unauthorized.

## Scope and changes

Open Grok remains read-only at
`3ac589afb9b156e7105ba889c0564ea526c8e281` in
`D:\ai-harness\open-grok-reference`. Its working tree was clean at inspection.
No upstream merge, ChatGPT rewrite, external agent replacement or Rust changes
were made. Provider interpretation still returns tool intents to the native engine.

## Matching GitHub candidate

Run 34213482617 completed successfully, including compilation, native unit tests,
packaging, installed startup and both native Node/Bun probes. The transient local
watcher's `unexpected EOF` was not a workflow failure; reconnecting confirmed the
actual final successful verdict. The failed runs and watcher log remain retained.

- Source: `39b25f39df9b1b7341ba7957c0ea54167ea80af8`, build report clean.
- Manifest SHA256: `6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a`.
- Native SHA256: `919fd8eb3ce146a594f04daa05a0819b6543fcf95479dbbed9510d16f0c78536`.
- Scratch `ci-34213482617-candidate/` is the unchanged downloaded candidate.
- `ci-34213482617-identity.log` verifies source/build-report/Cargo-log linkage,
  every compressed asset checksum, both decompressed x64 PE binaries and all
  27 runtime inventory files. No CI build-report path was rewritten.
- `ci-smoke-1/` and `ci-smoke-2/` pass actual isolated installation and all three
  provider menus, alternate-screen entry/restoration and normal exits.
- `ci-native-node/` and `ci-native-bun/` pass native tools, MCP/Task, cancellation,
  provider routing and fresh-file resume against the installed candidate native
  hash. Bun also exercises actual 20-second background commands and native output
  retrieval; both providers execute their shell command exactly once.
- `ci-observation-verification.log` and `ci-verified-observations.json` independently
  check installed native/bundle bytes, six raw terminal captures, real fixture
  file contents, task routes, shell output/exit codes and cancellation records.
  Remote model responses remain synthetic; this does not certify live accounts.

Committed and pushed to the authorized existing branch:

- `707d91d`: fix accumulating HTTP backpressure listeners (33 observed before the
  fix), and use Bun's native Request cancellation with the same auth/catalog/
  routing dispatcher. Bun 1.3.14's Node HTTP compatibility server did not emit
  the disconnect needed to cancel ongoing generation. Both provider routes have
  real loopback HTTP disconnect tests.
- `ab50b8d`: preserve header isolation for empty Bun responses; the regression
  caught and prevents forwarding provider cookies/private headers on status 204.
- `27ad4fd`: keep ConPTY in Node and run the production bridge service in a Bun
  child fixture, extending the native-tool probe and CI wiring. Upstream model
  responses remain synthetic and cannot count as live-provider acceptance.
- `8447e98`: preserve fixture task selection across asynchronous native MCP
  connection notices, with four direct regression tests and CI coverage.
- `39b25f3`: follow actual native background shell handles through the advertised
  output tool instead of assuming synchronous output. CI's Bun probe deliberately
  uses a 20-second command, requires background result retrieval, and still checks
  the fresh nonce and exactly one shell invocation per provider. Preserve shell
  result diagnostics and fail before launching if the supplied ripgrep is absent.

Further fixture work handles a native MCP connection notice arriving after a
tool result. Only mock task selection changes; real tool-result, approval,
route and side-effect assertions remain intact. Unknown reminders and actual
new user requests are not discarded. See `tests/windows-native-prompts.test.mjs`.

## Evidence and commands

Captured outputs are under the goal's private scratch evidence directory.
This location is evidence only, never an execution dependency or configured home.
Tests retain their existing isolated project/system test-home defaults.

- `bridge-stream-before.log`: original relay failed with 33 accumulated listeners.
- `cancel-diagnostic-node.log`, `cancel-diagnostic-bun.log`: actual disconnect
  reached the Node upstream signal but not the Bun compatibility-server signal.
- `bun-native-cancel-bounded.log`: native Bun Request abort and stream cancel observed.
- `bodyless-before.log`: empty-response header-isolation regression reproduced
  during development, then repaired; failed evidence is retained.
- `final-full-offline.log`: Node **173 PASS**, Bun **140 PASS**, no failures or skips.
  Node includes provider, installer, release-readiness and candidate-readiness tests.
  `native-prompt-regression.log` adds four actual fixture-selector tests.
- `matching-source-node-full.log`: the full pushed-source Node command, including
  those four fixture tests, passed **177 tests**, with zero failures or skips.
- `final-smoke-1/` and `final-smoke-2/`: two actual installed-entry runs of the same
  final supplemental package, each checking all three provider menus, no automatic
  browser dispatch, alternate-screen entry/restoration, exit 0 and no forced cleanup.
- `final-native-node/`: actual installed native executable with read/write,
  PowerShell/Grep, MCP/Task, provider switch, cancellation and fresh-file resume,
  using synthetic model responses.
- `native-bun-bridge/`: initial successful actual-native run through Bun 1.3.14;
  both providers owned one Task child, two approved MCP calls had no leaked bridge
  token, stream cancellation and provider-qualified resume were observed.
- `local-native-bun/`: unsupported node-pty-under-Bun attempt failed before model
  execution. The final harness keeps node-pty in its supported Node runtime.
- `final-native-bun/`: repeated run caught the fixture's MCP-notification task
  selection defect and required cleanup. This is retained, not relabeled PASS.
- `verified-native-node/` and `verified-native-bun/`: after the fixture correction,
  both full probes passed against the final package's installed native binary.
  Both observed real read/write/PowerShell/Grep, one child per provider, two MCP
  calls, no bridge-token leak, one stream cancellation and fresh-file resume,
  with normal exits and no fixture errors. The Bun variant records native server
  use and version 1.3.14. Provider responses are still simulated.
- `verified-local-observations.json`, `evidence-verification.log` and
  `evidence-index.json`: programmatic checks match both installed native/bundle
  hashes, both sets of terminal mode transitions, the actual generated fixture
  bytes, Task/MCP results and the intentionally BLOCKED readiness verdict.
- `ci-structural-check.log`: the actual workflow invokes the Bun fixture and
  retains distinct Node output. This does not mean the updated CI has run.

Reproduction from repository root:

```powershell
node --test integrations/native-provider/test/*.test.mjs integrations/native-provider/cursor/provider.test.mjs integrations/tests/install-native.test.mjs integrations/tests/install-authorization.test.mjs integrations/tests/release-readiness.test.mjs integrations/tests/candidate-readiness.test.mjs integrations/tests/windows-native-prompts.test.mjs
bun test integrations/native-provider/test integrations/native-provider/cursor/provider.test.mjs
node integrations/tests/windows-candidate-smoke.mjs CANDIDATE_DIRECTORY
node integrations/tests/windows-native-tools.mjs INSTALLED_NATIVE_EXE --mcp --task --grep --clean-path --ripgrep INSTALLED_RG_EXE
node integrations/tests/windows-native-tools.mjs INSTALLED_NATIVE_EXE --bun-bridge --mcp --task --grep --clean-path --ripgrep INSTALLED_RG_EXE
```

Use the existing pinned node-pty through `NODE_PTY_MODULE`. The native probes
must use the binary from the verified installation. Login-only probes do not
establish generation. No large Rust build was repeated: the c802eea and current
`crates` tree identities are both `022a2dbf1c21ff4fa536f547f073484572064727`.

## Supplemental package identity

The final package is local, not a GitHub artifact. It combines the attested
unchanged c802eea Rust executable with the repaired bridge source from ab50b8d.

- Manifest SHA256: `b46179b066cdac24a98e98efe7f481d1e74919816d88f050b14e16f8b06ebfb3`.
- Native SHA256: `37c460cb54cc7ae53a40f990f4ae82182d6990fd045c9eadc1c5052c273d66ee`.
- Package directory in scratch: `local-final-candidate`.
- Previous packages remain unchanged and are not interchangeable evidence.

## Current live and host observations

All observations below refer to the matching GitHub candidate identified above.
No real credential files were read, imported or copied.

### Latest authorized local regression run

On the current Windows 11 Pro build 26200 host, the source Node suite passed
177 tests with zero failures/skips; the installed candidate's Bun 1.3.14 passed
140 provider tests with zero failures. Logs are `local-validation-node-177.log`
and `local-validation-bundled-bun-140.log` in the evidence directory.

The fresh installed-native probe in `local-native-bun-20260908-221811/` passed
both provider routes with actual file read/write, clean-PATH Grep, 20-second
PowerShell commands and background-output retrieval, two once-approved MCP calls,
no bridge-token leak, one stream cancellation and fresh-file session resume.
Each provider issued its shell command exactly once. No forced exit or fixture
errors occurred. Installed native identity and actual written bytes were checked
independently after the run. The bridge uses the host Bun executable, whose
SHA256 matches the installed candidate Bun exactly. This run used synthetic
upstream responses and did not exercise Task children or real paid generation.

### Account and environment evidence

- ChatGPT: owner-assisted OAuth/catalog, GPT-5.4-Mini low, native read/write and
  PowerShell execution, then same-session resume reading a newly created file.
  Both coding exits were normal. `ci-codex-live-verified.json` checks the actual
  history, model identity, file bytes and installed hashes.
- Cursor: owner-assisted OAuth/catalog and Auto (`cursor/default`). The first
  coding session was stopped after a rejected write, upstream 504 and subsequent
  409 live-tool-call guard failure. The cause of the timeout is not established.
  Failed evidence remains in `ci-cursor-coding-failed/`; no replay guard was
  bypassed. An explicitly authorized new session passed native read/write,
  PowerShell and fresh-file resume, with normal exits. The separate successful
  evidence is checked by `ci-cursor-live-verified.json`.
- Grok: actual installed `login --oauth` completed successfully with exit 0 and
  no forced exit. `ci-grok-login-success/` contains the login report and sanitized
  terminal only. This proves login, not generation; generation requests were 0.
- Current Windows 11 host: the latest actual installed signed-out smoke passed
  all three provider menus, alternate-screen entry/restoration and normal exits.
  The host is a development machine, not a clean VM. Rechecking previous live
  histories is evidence verification, not another model request.
- Server 2025: owner-supplied report records installation/native hash checks,
  native menu/restoration and exit 0. Codex exited 0 but its owner confirmation
  was false; Cursor was not reached. The VM report remains incomplete, not PASS.
  The disposable test script's read-only `$HOME` collision was repaired without
  changing Polycode. WSL feature inspection lacked elevation; its state is unknown.

## Unclosed acceptance gates

1. **Matching CI artifact:** runs 34195838203 and 34200363453 failed the same
   `Native shell did not return fixture bytes` assertion. Their reports do not
   retain the original shell result, so the exact CI cause is not yet proven.
   A real delayed native command reproduces that assertion by returning a valid
   background task; the fixture repair passes locally. Run 34213482617
   established successful CI closure. Download/hash checks and two local installed
   runs plus both native probes passed on its unchanged candidate. This gate is
   now closed; no workflow was cancelled and historical packages stay separate.
2. **Real ChatGPT/Cursor:** candidate-bound OAuth, coding and resume now pass as
   described above. The earlier failed Cursor session remains a recovery-path
   limitation; successful new-session evidence does not erase it.
3. **Real Grok:** OAuth passes. Generation remains untested because the owner's
   conditional US$1 limit cannot currently be reliably enforced. No paid Grok
   call was made; login is not relabeled as generation evidence.
4. **Clean Windows 10/11:** available host is Windows 11 development build 26200,
   not a clean acceptance VM. No clean Windows 10 22H2 or Windows 11 no-WSL evidence
   was supplied or produced. Restricted PATH and Server 2022 CI do not substitute.
5. **Full 14-gate readiness:** no acceptance.json was manufactured. The unchanged
   `candidate-readiness.mjs` was rerun against the unchanged matching GitHub
   candidate without a fabricated complete acceptance ledger: **BLOCKED**, exit
   **1**, reason `Required evidence or artifact is unavailable`. See
   `local-readiness-current/readiness-result.json` in scratch. This reports
   incomplete acceptance evidence, not a product runtime failure. Publication
   of a stable release remains unauthorized; the separate Preview scope is now
   owner-authorized.

Capability/long-history findings remain in [the roadmap](POLYCODE_ROADMAP.md):
Cursor role semantics, strict/explicit-option restrictions, limited inline images,
unknown context sizes, Codex opaque-history parity and its legacy context fallback
are not silently converted into unsupported-feature claims of completion.

No production installation/PATH replacement, secret export, stable publication
or paid Grok request occurred. Completing the full goal requires bounded real
Grok generation, clean-machine evidence and a complete verified acceptance ledger;
the checklist's matching-artifact task is complete.
