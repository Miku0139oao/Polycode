# Polycode integration verification

Base: xai-org/grok-build `72a61251fcffb464bcc687aeb5a998e5a98ec0c9`.
Environment: Windows + WSL Arch, Rust 1.94.0, Node 22.14.0, Codex 0.153.4,
Cursor 2026.08.11-e8db854. Live tests use existing official account logins.

## Verified

| Requirement | Evidence |
| --- | --- |
| Original fullscreen TUI, native regressions | Pager library suite: **9071 passed, 0 failed, 4 ignored** |
| Build | `cargo +1.94.0 build -p xai-grok-pager-bin` passed; executable `/root/grok-build-target/debug/xai-grok-pager` |
| Integration-test compilation | `cargo +1.94.0 check -p xai-grok-pager --tests` passed |
| Registered feature documentation | Dedicated documentation test passed; missing upstream internal tables restored from `FEATURES` |
| Codex adapter lifecycle/security | **73 Node tests passed**: malformed transports, shutdown, stale approvals, scoped grants, API-key rejection, reviewer enforcement, history pagination, tool output and questions |
| Windows bridge | **5 Node tests passed**: structured paths, tree shutdown and narrow fixture-read permission policy |
| Actual fullscreen protocol/UI | `pty_smoke.py`: streamed output, exact question/option IDs, explicit plan acceptance, cancellation, no outbound Grok extension RPCs |
| Windows user entrypoint | `conpty_live.mjs`: PowerShell launcher → WSL fullscreen TUI → real Codex and real Cursor responses; both passed |
| Real model discovery and resume | Both provider live tests passed authentication, streamed prompt and same-session history replay |
| Real tools, not just chat | Both providers read a random marker from a disposable fixture; actual tool events and exact returned contents verified |
| Explicit native selection | `--no-external-acp` ignores configured external ACP; CLI help and config override unit test verified |
| No silent paid-API fallback | External startup/transport failures return errors; subscription-only Codex rejects API-key accounts and non-OpenAI provider/effective unsafe settings |
| Isolation | External feature/effect allowlists, environment filtering, session ownership, cancellation and child reaping covered by Rust tests |

The four ignored upstream library tests remain ignored by their original test
attributes; this is not a claim that every upstream live/network integration test
was executed. Full integration tests compile; account-consuming tests run only
with explicit opt-in. Native model calls were not made with an xAI API key.

## Fixes discovered during verification

- PowerShell launcher uses `wsl --exec`, preventing backslash loss through an
  implicit shell and preserving executable/argument boundaries.
- PTY startup waits for the ready welcome view instead of sending input during
  authentication. Windows launch is tested with native ConPTY, not nested WSL
  terminal emulation.
- Windows Codex shutdown reaps its spawned tree before the root exits, including
  persistent shell children. Test cleanup never tree-kills a shared WSL launcher.
- WSL Arch interop registration was made persistent in the local environment.
- Native test fixtures no longer depend on a real microphone, an instantaneous
  status-line refresh, or two filesystem writes receiving different clock ticks.
- Child-reaping test waits for a complete PID, not merely an empty file's creation.

## Explicit boundaries

External agents own their tools, MCP, sandbox, rules and memory. Grok-only cloud,
voice, worktree, rewind and native session-list controls are disabled in external
mode. Cursor task/image extensions are display-only; unsupported secret or
free-text-only Codex questions fail explicitly. Standard model selection and
explicit session-ID resume are supported; provider modes/configOptions are not
silently mapped onto Grok plan/yolo settings.

ChatGPT/Cursor subscription usage is subject to provider quotas and account-level
extra-usage settings. This integration does not guarantee zero overage charges,
change billing settings, extract credentials, or bypass provider limits.
