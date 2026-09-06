# Polycode verification: native release still pending

**This is a status ledger, not a native-completion certificate.** The required
architecture retains Grok's native engine, tools, MCP, permissions, sessions and
features while selecting Grok / ChatGPT subscription / experimental Cursor in
the same TUI. External-agent replacement is rejected as the final architecture.

Target: Windows with existing WSL Arch x86_64, glibc 2.43 or newer. No broader
Ubuntu, macOS or native Windows release support is established.

## Current native checkpoint

The implementation snapshot supplied for this documentation pass reports **55
passing offline tests**, combining the parent native-provider service and Cursor
transport suites. This documentation-only pass did not rerun those tests or
perform account authentication. Native Rust/TUI work and installer/package drafts
are in progress; their presence is not evidence of successful integration.

| Area | Evidence scope / remaining gate |
| --- | --- |
| Local service, credential store, ChatGPT transport, launcher | Offline tests cover local control/OAuth state, locking/revisions, request/stream conversion and launch boundaries; no live subscription endpoint acceptance established |
| Experimental Cursor transport | Offline mocks cover protocol parsing, correlated native tool-intent/result continuation, cancellation, isolation and fail-closed behavior; real OAuth/catalog/remote stream behavior unverified |
| Native Rust integration | Active implementation; no completed native build/regression/TUI result claimed here |
| Browser authentication | No demonstrated TUI → Windows browser → WSL callback/poll → same TUI flow for the native release |
| Release and installer | v0.2.0 binary/Bun gzip, runtime ZIP and checksum manifest are planned; public assets, clean install and installed native launch not yet verified |

Offline tests exercise fixtures, not provider promises. The Cursor adapter's
role semantics, sampling/length controls, usage, image support, catalog metadata
(including unknown context size), and native-request compatibility still need
resolution. An explicit unsupported error prevents silent corruption but **does
not satisfy feature-preservation acceptance**.

## Required evidence before claiming native completion

All rows below are **pending**. Record the exact integrated source commit,
commands, environment, outcomes and redacted evidence when updating this ledger.

| Gate | Required acceptance evidence |
| --- | --- |
| Native build and regression | Build the integrated Rust binary; run relevant Rust, provider and transport suites; report counts, failures and ignored tests separately |
| Default entrypoint | On the target Windows/WSL setup, `polycode` enters the native provider UI while unauthenticated; no Codex/Cursor executable or prior CLI login required; `-Backend` changes only an optional initial preference |
| Same-TUI OAuth | Start each provider's browser login from the TUI, finish and refresh its catalog without restart; test denial, cancellation, timeout, stale completions and callback/poll failure without model/account changes |
| Provider/model selection | Discover real account models, explicitly select them, switch Grok ↔ ChatGPT ↔ Cursor in one native session; busy turns and pending approvals cannot be dropped or silently rerouted |
| Native tools, MCP and permissions | Verify actual Grok engine ownership, real tool-intent/result rounds and MCP calls, native approval/denial/sandbox handling and cancellation; do not substitute remote agent tools or display-only summaries |
| Sessions and features | Preserve native history/resume and configuration across switching; validate upstream hooks, skills/plugins, worktree, rewind, attachments, headless, cloud/sharing/voice and other feature paths under their normal prerequisites; no external-mode disable list |
| Protocol fidelity | Resolve role/history semantics, tool IDs/schemas/results, sampling/length settings, usage and image handling against actual native requests and live endpoints; no dropped controls, fabricated metadata or silently reduced requirements |
| Credential lifecycle | Verify local WSL XDG storage, permissions, cross-process refresh/rotation and account-revision behavior; account changes must not mix catalogs or pending tools; no credential scraping/proxy |
| Failure and billing boundary | Auth, model, transport, quota and continuation failures surface clearly; no replayed tool side effects, quota/billing bypass or automatic metered/model/provider fallback |
| Release artifacts | Publish the verified native binary as `polycode-wsl-x64.gz`, Bun as `polycode-bun-wsl-x64.gz`, plus `polycode-runtime.zip` and `SHA256SUMS`; verify hashes, bundle contents and third-party notices against the tested source |
| One-command install | Test the README PowerShell command against the actual Miku0139oao/Polycode release; verify dependencies, per-user PATH, default/native launch, browser interoperability and release-version identity |

Live authentication and account-consuming probes require explicit authorization;
this docs pass made none. Cursor experimentation and its undocumented-protocol,
account and terms risks are user-approved, not vendor-endorsed. Never include
credentials or raw sensitive request/response payloads in the evidence.

## Historical only: external ACP prototype `d549db3`

These results were previously reported for the **rejected external-agent
architecture**, based on upstream `72a61251fcffb464bcc687aeb5a998e5a98ec0c9`.
They are retained for traceability and **must not be relabeled as native results**.

Historical environment: Windows + WSL Arch, Rust 1.94.0, Node 22.14.0,
Codex 0.153.4, Cursor 2026.08.11-e8db854. Live tests used existing official CLI
account logins, unlike the required fresh in-TUI native OAuth workflow.

| Historical result | What it actually established |
| --- | --- |
| Pager library: **9071 passed, 0 failed, 4 ignored** | Regression results at the old prototype revision, not the current native Rust changes |
| Binary build and integration-test compilation passed | Old `xai-grok-pager` build and `cargo check --tests`; not all integration tests executed |
| **73 Codex adapter tests**, **5 Windows bridge tests** passed | External app-server/ACP lifecycle, permissions, history, path conversion and shutdown behavior |
| Mock PTY UI smoke passed | External ACP stream, question/plan and cancellation handling in the fullscreen UI |
| Real Codex/Cursor auth, responses, discovery, resume and fixture tools passed | Official external agents, including PowerShell/ConPTY → WSL → Windows bridge; not native provider OAuth, native tool execution or native session persistence |
| External isolation and no-fallback checks passed | Old external startup/config boundaries; not proof that new transports preserve those properties end to end |

In that prototype, the external agents owned tools, MCP, sandbox, rules and
memory. Grok-only controls were disabled, and some extensions were display-only.
Those limitations are why the prototype does not meet the native requirements;
they are **not** accepted limitations of a completed native release. The four
ignored upstream tests were not executed. No native xAI model call was established
by those historical results.

Old `codex-acp`, `wsl-host` and ACP live/PTY fixtures may remain as reference, but
passing them cannot close the native gates above. See [integration usage and
boundaries](README.md) and [native-provider notes](native-provider/README.md).
