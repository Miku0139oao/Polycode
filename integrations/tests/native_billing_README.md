# Native permission/billing lane: acceptance is NOT complete

Scope: branch `acceptance/permissions-billing`, base
`9dc748db7ee2899e46dcc4d9fb924ea18a513c45`. Only the new files named
`native_permission_billing*.py` and `native_billing_*` belong to this lane.
No shared harness, Rust, OAuth, usage/branding, installation or release edits.
No Rust compilation, resource/stack increases, agents, real paid requests or publishing.

## Verified results and exact evidence

Actual Linux binary: `/root/grok-build-target/debug/xai-grok-pager`,
SHA-256 `e8bc41336b6e40a4340a24cb37163c5448b31ab08aa790daf5c80ee09e3bde2e`
(parent identifies Rust source as `18dce86`). Every invocation checks this exact hash,
`--polycode-native` / `--no-external-acp` help gates, a real Linux PTY,
alternate screen and process identity. Default native leader and permissions remain enabled.
Only the disposable workspace is trusted; **no always-approve flag**.

Final evidence directories, relative to this worktree (kept untracked, no new ignores):

- `native-billing-artifacts-18d-final/`: ChatGPT-selected **mock subscription**.
- `native-billing-artifacts-18d-cursor-final/`: Cursor-selected **mock subscription**.
- `native-billing-artifacts-live-blocked/report.json`: live invocation rejected before
  launching any TUI/provider or reading any credential store (exit 2).

Each preflight directory contains `report.json`, `keys.json`, `screen.txt`, and
`terminal.bin`. Earlier `native-billing-artifacts-18d-*` directories preserve harness
bring-up failures, not acceptance passes. Final reports have no fixture contract errors
and no terminal credential leak. Temporary native homes/workspaces are removed.

| Requested case | ChatGPT-selected preflight | Cursor-selected preflight | Real vendor acceptance |
|---|---|---|---|
| Tool DENY | PASS: digit 4, pending/after rejection 0 MCP receipts | PASS: same | BLOCKED / not run |
| Tool allow ONCE | PASS: digit 3, pending 0, exactly 1 receipt + correlated private nonce | PASS: same | BLOCKED / not run |
| Native billing DENY | PASS: exact Deny option, 0 Responses dispatches, exact policy error in correlated tool result | PASS: same | BLOCKED / not run |
| Native billing ALLOW | **FAIL full TUI gate**: 1 attributed Responses request + correlated result, final reply not painted | **FAIL full TUI gate**: same | BLOCKED / not run |

**Tool DENY is not a model-continuation pass.** The authoritative PermissionView
`No, reject (type to add feedback)` row 4 produces `Turn cancelled by user` on this
binary. The runner records `user_cancelled: true`, `model_continued: false`, and zero
actual append-only MCP receipts. A subsequent fresh allow-once turn proves recovery.
The separate billing Deny question *does* produce a model continuation carrying
`explicit affirmative approval was not received`; missing authentication, offline,
unknown model and generic cancellation cannot satisfy that assertion.

**Unresolved rendering/integration failure:** for billing ALLOW the final reports
show `pending_dispatches: 0`, `native_dispatches: 1`, `model_continued: true`,
`rendered_continuation: false`. The sink received the configured model, expected
synthetic native bearer (equality comparison only), `tools: web_search`, `store:false`,
and `max_output_tokens:8192`, then returned a Responses output-message/output-text
nonce. The next subscription request contains that nonce in the correctly correlated
native `web_search` result. Nevertheless the TUI only displays `Worked for ...`;
`NATIVE_ACCEPTANCE_BILLING_ALLOW_CONTINUED` was not observed in the painted frames.
PageDown and incremental SSE delivery did not resolve it. Both providers reproduce it.
Do not remove the render assertion or call this full PASS. This is a TUI/harness
integration finding, **not yet an established Rust root cause**; no speculative Rust
rendering fix was applied or built.

## Run units (Linux standard library) and syntax check

From Windows Git Bash, keeping temporary writes in this worktree:

```sh
MSYS_NO_PATHCONV=1 wsl.exe -d archlinux --exec sh -c \
  'cd /mnt/d/ai-harness/polycode-accept-billing && TMPDIR="$PWD" python3 -B -m unittest discover -s integrations/tests -p native_permission_billing_test.py -v'
node --check D:/ai-harness/polycode-accept-billing/integrations/tests/native_billing_live_bridge.mjs
```

Final lane units: **13/13 PASS**. Node syntax check: PASS.
An additional isolated discovery of **all** `native_*test.py` ran 42 tests:
**41 PASS, 1 FAIL** in unchanged `native_test.McpFixtureTests.test_stdio_protocol_and_private_environment_evidence`.
Keeping TMPDIR inside this required `/mnt/d` worktree exposes DrvFS mode `0777`
where that existing test requires `0600`. No assertion, permission mechanism,
mount configuration or shared test was weakened; no out-of-worktree Linux temp
writes were used to hide it. Parent can rerun the full suite on an approved native
Linux filesystem. This full-suite failure remains separate from the ALLOW-render
failure and means there is no overall all-tests-green claim.

Units cover exact permission/consent labels, non-blanket selection, catalog-base pins,
correlated tool IDs, false denial controls (auth/network/cancel errors), nonce controls,
real stdio MCP side effects, native HTTP premature-dispatch positive control,
request-bound synthetic bearer attribution, non-billable catalog separation, and live
grant/observer guards. Unit success and JavaScript syntax success are not live tests.
`bun --check` is not a syntax-only command here; its attempted execution was stopped
by the explicit consent gate. Use Node's `--check` instead.

## Bounded actual-binary isolated preflight

```sh
MSYS_NO_PATHCONV=1 wsl.exe -d archlinux --exec unshare --net sh -c \
  'ip link set lo up && exec timeout --signal=TERM --kill-after=10s 180s python3 -B /mnt/d/ai-harness/polycode-accept-billing/integrations/tests/native_permission_billing.py /root/grok-build-target/debug/xai-grok-pager --artifacts /mnt/d/ai-harness/polycode-accept-billing/NEW-EMPTY-EVIDENCE-DIRECTORY'
```

Use `--preflight-provider cursor` to run Cursor independently; default `both` stops
at the first failed assertion and therefore currently does not reach Cursor after
ChatGPT's ALLOW-render failure. Both final independent runs exited 1, as required.
Keep network isolation; the runner independently requires that `lo` is the only
interface. The child environment is allowlisted, not inherited. HTTP and all key
material here are **synthetic preflight only**. The native sink does not forward
requests to xAI. MCP is a genuine stdio subprocess launched by native MCP management,
not a Python tool adapter. The private nonce lives outside the model workspace and
is returned only after the probe has fsynced one append-only receipt.

The stable `Terminal`, `permission_key`, environment and binary/isolation gates are
imported from `native_pty.py`; stable control/catalog/auxiliary behavior is imported
from `native_mock.py`. Those shared files and `native_live.py` were not edited.

Important fixture details:

- Wait for startup's own decision card before typing commands. With a native key,
  startup can show the *native* model list rather than the signed-out provider card.
- Explicitly refresh and await the authenticated subscription catalog, then require
  the expected mock model label. Do not infer that `/provider cursor` already worked.
- Exact native PermissionView labels use direct digit submission; row 1 is forbidden.
- Billing QuestionView options include aligned descriptions. Match the full label
  column and required order; navigate g/j and submit Enter. Navigation alone must
  still have zero service dispatches. Never grant by default highlight.
- Pin `[endpoints]` and the dedicated `[model.native-billing-acceptance]` entry's
  **both** `base_url` and `api_base_url`, plus `[models].web_search`. Verify the
  actual consent origin/model and sink path/model. An environment endpoint alone
  does not override every catalog entry.
- Authenticated `GET /models` discovery is reported separately. It is not a native
  billed `POST /responses` dispatch. Unexpected native routes/methods still fail.

## Live dependencies and procedure — not executed

Latest parent/user correction: **ChatGPT and native Grok are working** in the actual
new application with its normal store; **only Cursor OAuth is failing**, and parent
owns that fix. Working ChatGPT login is not evidence of these permission scenarios.
The reported normal store is `/root/.local/share/polycode/manual-test-auth`.
Do not inspect, print, copy, scrape or relocate its contents. Do not run `/login`
or browser automation from this lane. Usage/branding belongs to another owner.

The dedicated `native_billing_live_bridge.mjs` uses the normal `runNative` /
`CredentialStore` interfaces and actual ChatGPT/Cursor provider adapters. It only
loads the chosen provider; no alternate-provider fallback. It disables test-driven
login, not native permissions. It retains real model/tools/default leader behavior,
checks actual provider-bound Authorization headers against the adapter's in-memory
credential, logs fixed metadata only, caps adapter completions at 12 and actual HTTP
requests at 24, and requires a real completed continuation after allow-once.
It does not log real terminal output, prompts, response bodies, OAuth URLs, credential
values/fragments/hashes, or raw environment. The live adapter is **syntax checked,
not live-verified**. Its local tests cannot clear vendor gates.

Only after parent explicitly permits subscription test usage and confirms the chosen
provider's working normal store, parent may run **one tool-only case** like:

```sh
# Procedure only: do not run without parent authorization.
python3 -B /ABSOLUTE/WORKTREE/integrations/tests/native_permission_billing.py \
  /root/grok-build-target/debug/xai-grok-pager \
  --mode live --provider codex --case tool_allow_once \
  --auth-directory /root/.local/share/polycode/manual-test-auth \
  --credentials-ready --allow-subscription-usage \
  --artifacts /ABSOLUTE/WORKTREE/NEW-EMPTY-LIVE-EVIDENCE
```

Run `tool_deny` separately, then Cursor only after parent fixes and verifies its OAuth.
No xAI key is inherited/provisioned by the tool-only live runner. Parent owns any
external wall-clock watchdog and cleanup; every runner TUI wait is also bounded.

**Native paid ALLOW is still not authorized.** Billing live modes intentionally exit
BLOCKED even if usage/budget flags are supplied: the current binary lacks the
request-bound native metadata observer needed to prove zero dispatch while
pending/denied and attribute a genuine official response after allow. The supplied
live billing backend path is deliberately incomplete, not a mock substituted for
live evidence. No flag bypasses this missing-observer gate.

### Exact minimal native observer proposal for parent approval (not implemented)

Do not change endpoint routing or consent/redirect/retry enforcement. Proposed scope:

1. `xai-grok-tools/src/types/native_service_consent.rs` only: add an **opt-in,
   metadata-only observer** to the existing policy/call state, initially absent.
   Emit a continuous per-process sequence (`observer_ready`, `pending`, exact UI
   `decision`, `dispatch`, `http_response`, `observer_end`). Include only generation,
   selected-provider label, service enum, opaque per-run request/target/credential
   slot IDs and status; never headers, keys, hashes of keys, URLs with paths/query,
   prompt strings or arbitrary errors. Reuse the in-memory equality slot already
   displayed as configured credential #N. Emit Deny at the existing non-affirmative
   return, not on a 401 or generic cancellation.
2. At `NativeServiceCall::send`, **after** `build_split`, header application and
   `check_current`, immediately before `http.execute(request)`, compare the actual
   built request headers with `ApprovedHeaders`. Emit the matched opaque approved
   credential slot and safe official-origin boolean; record `http_response` only
   from that same returned response. Never perform a new credential resolution
   for attribution. A detached auth-status snapshot is not sufficient.
3. `xai-grok-tools/src/implementations/web_search/client.rs`: after successful
   Responses deserialization and `check_current`, emit the same request's
   `response_parsed` with status and nonempty-output boolean. Correlate to the tool
   result delivered to the selected subscription, without logging body contents.
4. Supply the opt-in observer through a parent-owned private file/pipe, mode 0600,
   never model history. Require start/end plus contiguous sequence/call correlation
   to prove **zero** dispatch, not just absence of a log line. Observer I/O errors
   invalidate acceptance. Production default must be no observer and unchanged
   mechanisms. Parent owns exact code review and any build.

This is the minimal *evidence* addition proposed, not an implemented interface.
The Python live billing gate must then be extended/tested against that actual
approved interface; do not just remove its `Blocked` exception. Root-cause the
separate ALLOW rendering failure before considering a full native acceptance pass.

### Safe native configuration and spending limits

Parent must provision native authentication through the application's normal supported
flow/environment, **not token chat/argv/logs**, before a new session is spawned.
Use a clean native home if testing static-key attribution; an existing valid native
session can override a configured static key. Native Grok login working does not
prove which bearer a later selected-subscription native service actually sends.
Do not infer native auth or quota from the subscription URL.

For live native service testing, the effective catalog entry's `base_url` and
`api_base_url` must both remain `https://api.x.ai/v1`, with a parent-confirmed real
web-search-capable model. `[models].web_search` must resolve to that entry. The runner's
fixture model is deliberately not a live model. Verify effective values at consent
and at the request-bound observer. **No local proxy, custom endpoint, TLS interception,
synthetic key or subscription fallback is live evidence.**

Current WebSearch client hardcodes `max_output_tokens = 8192`, temperature .1, top_p
.95 and store false. One native tool call is not a hard dollar cap: server-side search
can involve multiple billable searches and input tokens, and cancellation does not
refund already consumed work. No reliable live dollar estimate is available until
parent selects an accessible model and current official rates. Planning formula:

`estimated USD = input_tokens * input_USD_per_M / 1e6 + 8192 * output_USD_per_M / 1e6 + search_count * search_USD_per_call`.

For two provider ALLOW tests, add both requests plus subscription usage. Parent must
approve a **finite** budget, current-rate estimate and the lack of a hard dollar cap;
a provider/account-enforced spending ceiling is preferable. After the observer exists,
plan one native dispatch per fresh provider session, one short public IANA query,
no explicit retries, no extra tools, and stop after its one response. This bounds
client-initiated requests, not provider-internal search charges. Do not advertise
`--budget-usd` as enforcing spend; currently it is only a consent precondition and
live billing remains blocked. Reducing the 8192 limit would require a separately
reviewed native configuration change; none was made here.
