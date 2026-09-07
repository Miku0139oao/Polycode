# Native Polycode fullscreen acceptance (offline)

These files test the **original Grok engine**, not an external ACP adapter.
`pty_smoke.py`, `pty_live.py`, and `mock_acp.py` are not native acceptance evidence.
The current tested source/hash and remaining gates are recorded in
[native_CURRENT_VERIFICATION.md](native_CURRENT_VERIFICATION.md).
No Rust build is performed here. Python 3.11+ standard library, Linux PTYs,
`unshare` (util-linux), and `ip` (iproute2) are required.

## Run the mock/harness units now

From Git Bash on Windows:

```sh
MSYS_NO_PATHCONV=1 wsl -d archlinux --exec python3 -m unittest discover \
  -s /mnt/d/ai-harness/polycode-native/integrations/tests -p 'native_*test.py'
```

This covers authenticated control routes, pending/completed/failed/cancelled
login states, encoded attempt IDs, SSE framing/fragmented tool arguments,
fixture-result verification, a held-open stream, client disconnect detection,
redirect-trap positive controls, environment/network guards, incremental VT
painting, and an actual PTY terminal-discovery exchange. The tiny Python PTY
child tests mechanics only: **unit success is not native-binary success**.

## Run native mock acceptance

Use the actual newly built Linux executable. The old
`/root/grok-build-target/debug/xai-grok-pager` is not evidence unless replaced by
a build containing the native implementation. The harness rejects binaries
whose `--help` lacks `--polycode-native` or `--no-external-acp`, and records the
executable's SHA-256, path, PID, transcript, screen, and HTTP evidence.

```sh
MSYS_NO_PATHCONV=1 wsl -d archlinux --exec unshare --net sh -c \
  'ip link set lo up && exec python3 /mnt/d/ai-harness/polycode-native/integrations/tests/native_pty.py "$1"' \
  native-e2e /ABSOLUTE/PATH/TO/NEW/xai-grok-pager
```

Replace the final binary path. If cherry-picked into another worktree, also
replace `/mnt/d/ai-harness/polycode-native`. `unshare --net` needs root or suitable
namespace privileges (the available Arch WSL root environment supports it).
Never remove isolation to work around a failure. The harness refuses a network
namespace containing any interface other than `lo`. This also prevents real
account, model, update, and telemetry access independently of application flags.

Artifacts default to a fresh `/tmp/native-e2e-*` directory; optional
`--artifacts /tmp/a-new-empty-directory` selects one. Only a successful full
scenario prints `PASS`; assertions/timeouts fail nonzero and retain redacted
evidence. Temporary HOME, Grok config/state, workspace, and fixture are deleted.
The child environment is an allowlist: no real keys, OAuth caches, proxies,
DISPLAY, Wayland, WSL interop, or user browser configuration is inherited.
The restricted baseline uses `--always-approve --trust` only in the disposable
workspace; it is not permission-prompt acceptance. The default profile below
instead handles the actual MCP allow-once prompt.

## Acceptance sequence and exact UI wiring

The restricted baseline runs one native executable with:

```text
--polycode-native --no-external-acp --no-leader --fullscreen
--no-auto-update --trust --always-approve --disable-web-search --no-memory
--cwd <temporary workspace>
```

Add `--with-leader --default-features` to the **Python harness** arguments to
exercise the native leader without always-approve, disable-web-search, no-memory,
no-auto-update or the dashboard override. Workspace trust, telemetry suppression,
mock browser/accounts and network isolation remain explicit. This profile matches
the exact rendered single-use **Yes** permission label, verifies no MCP call while
pending, and verifies exactly one call after approval; it never selects blanket
approval. Denial, Task, billing and live/installed acceptance are separate gates.

It provides process-private `POLYCODE_BRIDGE_URL` and `POLYCODE_BRIDGE_TOKEN`.
Both providers initially return `loggedIn: false, models: []`; no dummy Grok
API key or pre-authenticated subscription is used.

1. Observe alternate-screen entry and the signed-out startup provider card;
   assert no login, browser attempt, or model request happened automatically.
2. Escape, type `/provider` + Enter; observe ChatGPT/Cursor options. Escape.
3. `/login` + Enter; select Cursor; observe pending UI and recorded browser URL;
   Escape; require the exact attempt's `/control/login/cancel` and signed-out state.
4. `/login`; select Codex; driver completes the mock attempt in memory; require
   the native model card; choose Mock Alpha. The model response is **held open**
   until its non-echoed marker is painted, then released to finish.
5. `/provider codex`; choose Mock Beta and require its exact model ID on the wire.
6. `/login cursor`; complete mock login; select Mock Cursor; require `/cursor/`
   routing, preserved earlier prompts/assistant replies, and identical native tools.
7. Emit fragmented standard SSE `tool_calls` for the **advertised native Read
   tool**. No Python tool adapter executes it. The next HTTP request must contain
   its matching assistant call ID and role=`tool` result containing random bytes
   present only in the temporary file. Only then emit the rendered success marker.
8. Cancel a fresh Codex login while Cursor is active; require another Cursor
   response (current model unchanged). Hold an endless response; Escape must
   close the native HTTP stream. Send a recovery prompt and require a new
   streamed reply in the same process/model.
9. Challenge control refresh and chat transport with HTTP 307 redirects to a
   **different loopback port**. No request may reach the trap. Require bearer auth
   only on bridge requests and no bearer in request bodies, terminal, or persisted
   temporary state. Also reject login instructions/attempt IDs in chat history.

Native local QuestionView keys are `g` (first row), `j` (next, clamped), Enter
(submit), Escape (cancel). No guessed numeric selection or external ACP RPCs.
`--polycode-provider` is deliberately not required; `g` makes menu selection
independent of the current highlight.

Source wiring inspected in the native worker worktree:

- `crates/codegen/xai-grok-pager/src/app/event_loop.rs`: native startup provider card.
- `.../app/dispatch/provider.rs`: menu/model titles, option order, login state machine.
- `.../app/agent_view/interactions.rs`: `g`, `j`, Enter question interactions.
- `.../slash/commands/{provider,login}.rs`: slash argument routing.
- `crates/codegen/xai-grok-pager-render/src/link_opener.rs`: existing
  **`GROK_TEST_OPEN_URL_FILE`** hook appends the URL and returns **before** any OS
  browser opener. The harness requires the recorded URL for every login.
  DISPLAY/Wayland/BROWSER are also absent as a secondary suppression mechanism.

The mock implements only the agreed control and Chat Completions contract;
unknown model/background-sampler prompts fail visibly rather than manufacturing
native acceptance. Its driver-only login completion is not an HTTP admin route.
Read schemas recognized: `Read`/`read_file` with `file_path`, `target_file`, or
`path`; unsupported required parameters fail closed. A native schema or UI change
may require a targeted harness update after the first real-binary run.

## Evidence boundary

The native build/run remains a separate merge gate. PID/executable continuity,
chat-history continuity, unchanged advertised tools, and actual file-result
round-trip are black-box evidence; internal session ID/channel preservation is
covered by the native worker's Rust tests, not inferred from HTTP session IDs.
Redirect checks establish local credential isolation for these two clients;
they do not claim a general audit of every native network path. No real OAuth,
account API, model subscription, or browser is used at any stage.
