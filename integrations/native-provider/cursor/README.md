# Experimental Cursor native-provider transport

**Offline implementation checkpoint, not a verified production provider.**
Undocumented Cursor compatibility can break and carries account/terms risk.
The user approved experimental work, but **no account credentials, login,
model discovery, or live completion have been exercised**. Obtain the separate
follow-up approval before making live calls.

This directory is standalone, dependency-free ESM for Node 22+ / Bun. It changes
no native Grok engine, tools, MCP configuration, permissions, session files,
Rust code, provider/model registrations, or TUI. It never launches Cursor CLI.

## API

```js
import { createCursorProvider } from './index.mjs';
const cursor = createCursorProvider(); // Construction performs no I/O.

// Call only after authorization to perform live authentication:
const { url, instructions, wait } = await cursor.startLogin({ signal });
// Parent TUI presents instructions and opens url itself.
const credential = await wait; // Parent alone persists this plain object.

const renewed = await cursor.refresh(credential, { signal });
const models = await cursor.models(credential, { signal });
const response = await cursor.complete(openAIChatBody, credential, { signal });
cursor.close(); // Idempotent; aborts login/HTTP operations and all remote sessions.
```

- `credential`: `{accessToken: string, refreshToken?: string, expiresAt?: number}`.
  `expiresAt` is Unix milliseconds. OAuth completion requires HTTP 200 and valid,
  nonempty token fields; known expired results are rejected. JWT `exp`, when
  available, is only an expiry hint, not signature/account identity validation.
  Refresh failure throws; it never returns a stale access token as a fallback.
- `models`: `[{id, name, contextWindow: number | null}]`. Canonical remote IDs
  only, no prefixing/aliases/defaults. `null` means the server did not supply a
  context size. Catalog errors throw, rather than produce fabricated models.
- `complete`: always resolves a standard `Response`. Success is Chat Completions
  JSON or SSE according to `body.stream`. Pre-response errors use HTTP 4xx/5xx
  with `{error:{type,code,message}}`; errors during SSE use a standalone `error`
  event followed by `[DONE]`, never an invented successful finish. Parent must
  handle these error events. Direct auth/catalog methods throw
  `CursorProviderError` with `code` and `status`.
- No default model. `body.model` must be an explicitly selected nonempty ID and
  is sent verbatim. The caller should use `models()` for selection. There is no
  implicit discovery, model/host retry, quota bypass or fallback in `complete()`.

Supported request controls: `model`, `messages`, function `tools`, `stream`,
`tool_choice: "auto" | "none"`, `parallel_tool_calls` (calls may be serialized),
`stream_options.include_usage: false`. Text/JSON messages retain their JSON
fields. Tool schemas use protobuf Value, including nested arrays, null, empty
strings, booleans, schema extensions and property names such as `__proto__`.
Names are not sanitized, renamed or guessed. Unknown completion controls,
sampling/length limits, forced tool selection, `strict:true`, usage requests,
and multimodal message parts return explicit unsupported errors, not ignored
settings. No usage counts, reasoning deltas or token limits are fabricated.

## Native tool continuation

1. A remote MCP exec produces one OpenAI `tool_calls` intent, **unexecuted**.
   The original MCP `toolCallId`, original `toolName` and complete JSON argument
   values are returned. Progress/partial notifications are not executable calls.
2. The local response ends with `finish_reason: "tool_calls"` and `[DONE]` for
   SSE, but the remote iterator/connection remains open, parked on that exec.
3. Native Grok performs its own permission check and executes (or denies) the
   call. Submit the identical original messages, the returned assistant message,
   then a native `{role:"tool", tool_call_id, content}` message. Keep the exact
   model/tool definitions/control settings and same credential. `stream` may
   change between requests. The assistant content may normalize null/omitted/"".
4. The provider validates the entire preceding transcript, assistant call
   name/ID/arguments, configuration and pending state. It submits only that
   correlated result via BidiAppend, then the exec stream-close control. It
   resumes the **same** remote iterator; no replay prompt, new remote run or
   synthetic resume/automatic retry is used for tool continuations.

String tool results are sent unchanged. Structured content is sent as JSON text
instead of dropping non-text fields. `is_error:true` sets the MCP error flag.
Additional tool-message fields are retained by serializing the entire native
tool message as the result text; an optional `name` must match the pending tool.
One intent per response is intentional; already-buffered additional remote
execs are returned in subsequent native rounds. This does not add a local agent
loop. Normal later user turns start a new remote stream with the full transcript
serialized as JSON; native session/history remain parent-owned.

Session keys are hashes of the **actual access token**, exact transcript and
configuration, not unverified JWT claims or mutable account labels. Identical
concurrent requests/results are refused rather than double-submitted. Different
factory instances share no state. Missing/expired/ambiguous continuations return
409: **do not automatically replay tools or start a replacement remote run**.
Token rotation deliberately does not migrate pending sessions to a new token.
Finish the pending round with its original valid credential or explicitly close
and restart after informing the user; account equality is never guessed.

Active AbortSignals and SSE reader cancellation close remote connections.
Once an HTTP response successfully completes, its AbortSignal is detached; use
`close()` or TTL to abandon parked calls. Defaults: 2-minute idle TTL, 15-minute
absolute session lifetime, 16 sessions, 1024 calls/session, 16 MiB opaque KV
storage/session, 8 MiB frame/buffer, 2 MiB request JSON, 4 MiB completion text.
Closed/expired sessions are never silently restarted. There is no disk KV cache.

## Security boundary

Runtime imports only Node crypto and this directory's pure modules. No filesystem,
shell, process/environment inspection, arbitrary URL fetching, browser opening,
credential scraping, storage, logout, CLI execution, or logging. The only outbound
host is `https://api2.cursor.sh`; the only browser URL is on `https://cursor.com`.
HTTP redirects are forbidden, including same-origin redirects. Raw server errors,
URLs, OAuth verifier and tokens are never placed in errors/logs. Builtin execs,
unknown protocol requests and interaction queries abort with explicit denial;
no shell/read/write/list/grep tool is invented, remapped or executed.

Fetch/UUID/randomness/clock/sleep dependencies and timeout bounds can be injected
for offline tests. Treat these as trusted embedding dependencies, not settings
from remote input. No endpoint override exists. The parent must not log request
headers, OAuth polling URLs, credentials or raw model/tool payloads either.

## Integration gates / correctness gaps

- **Not proven to be semantically identical to changing only the model backend.**
  The reference AgentService exposes a text user message, not demonstrated
  OpenAI system/developer/history fields. JSON preserves data but does not prove
  system-role hierarchy. Cursor may add its own remote agent instructions. Grok
  remains the only local tool/permission engine, but backend prompt equivalence
  requires further protocol evidence. Do not advertise full role fidelity.
- Current live OAuth, refresh, dynamic catalog, client-version header, BidiSse
  endpoints, MCP registration without filesystem mode and paused-stream behavior
  are unverified. Remote builtins may occur; they fail closed and can make the
  turn unusable. No bypass is attempted.
- This is **not** a generic accept-and-ignore OpenAI shim. If native Grok sends
  unsupported options (`temperature`, `max_tokens`, usage, strict schemas, etc.),
  integration must surface the limitation; it must not silently strip user
  controls. Multimodal and blob-only assistant output are unsupported. KV data
  is opaque, never heuristically treated as assistant text.
- Only uncompressed grpc-web binary frames are supported, not arbitrary SSE
  encodings or unknown future messages. Fresh user turns serialize history;
  only tool-result continuations reuse the exact remote stream. Remote lifetime
  limits and token-refresh migration are not solved.
- Offline mocks prove local correlation/cancellation/denial, not backend
  acceptance or the reliability of reverse-engineered field numbers. An approved
  minimal live handshake/tool-intent test and native-engine integration review
  are still required. Do not consume account usage before that approval.

## Reproducibility and offline tests

No runtime or development packages are needed or installed. All adapted code
and its pinned provenance are checked in. Node's standard test runner is used;
Bun runs the same tests. `package.json` fixes Bun 1.3.14 as the reference runtime.

Bun 1.3.14's dependency-free install reports `No packages! Deleted empty
lockfile`; there is therefore no `bun.lock` to retain and no dependencies to
resolve. A fabricated empty lock was rejected by frozen-lockfile validation and
was removed. Do not add an unnecessary dependency merely to obtain a lockfile.
If dependencies are introduced later, pin them and commit a generated Bun lock.

Run from this directory (no network/credentials needed):

```sh
node --test provider.test.mjs
/usr/sbin/bun test provider.test.mjs
```

Tests cover exact model/schema/name/ID/argument transport, original native
results, same-stream multi-round continuation, fragmented Unicode text and SSE
errors, quota propagation, builtin/unknown denial, account/factory/transcript
isolation, duplicate submission, KV in-memory isolation, TTL/cancellation,
PKCE start/poll/validation/cancel, refresh/catalog validation and no fallbacks.

See [PROVENANCE.md](./PROVENANCE.md) for MIT notices, source anchors, excluded
unsafe reference-handler paths and the evidence behind the remaining gaps.
