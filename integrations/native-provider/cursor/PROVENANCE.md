# Cursor wire-protocol provenance

Reference: [Yukaii/yet-another-opencode-cursor-auth](https://github.com/Yukaii/yet-another-opencode-cursor-auth)

Pinned revision: `025955752cf821e4bb827ef9b8d74c763a71d57f`

License: MIT, copyright (c) 2025 Yukai Huang. Full notice retained in
[`LICENSE.reference`](./LICENSE.reference). Adaptations of its protocol layouts,
PKCE flow, and checksum algorithm are covered by this notice. The reference is
not a runtime dependency; no source is imported from its checkout.

## Sources read completely before adapting

All paths below are relative to the reference repository's `src/lib/`:

- `auth/login.ts`: `generateAuthParams` at line 60; browser-PKCE URL and
  `/auth/poll` status/credential shape. **Not copied:** browser opening,
  `child_process`, API-key exchange, or storage integration.
- `auth/helpers.ts`: `refreshAccessToken` at line 22, `/auth/refresh` and bearer
  refresh-token exchange. **Not copied:** credential-manager/storage/logout code.
- `api/cursor-client.ts`: `generateChecksum`, grpc-web envelopes and the fixed
  version header `cli-2025.11.25-d5b3271`. No legacy StreamChat implementation.
- `api/ai-service.ts` and `api/cursor-models.ts`: Connect JSON
  `GetUsableModels`, `modelId` and `displayName`. Unlike the reference, errors
  propagate, aliases do not become duplicate entries, and missing canonical IDs
  are not silently replaced by display IDs. No source-backed context-window
  mapping was present; absent context sizes return `null` rather than guesses.
- `api/proto/encoding.ts`, `decoding.ts`: protobuf wire fields and
  `google.protobuf.Value`. Reimplemented bounded parsing, varint validation,
  multibyte tags, null/empty-value preservation, and pollution-safe maps.
- `api/proto/agent-messages.ts`: `encodeMcpToolDefinition` at line 14,
  `encodeUserMessage` at line 77, `encodeAgentRunRequest` at line 183. MCP schema
  and identity fields retained; real environment discovery and MCP filesystem
  mode omitted. MCP provider identifier is `polycode-native`, **not a model
  provider registration/name/alias**.
- `api/proto/bidi.ts`: `encodeBidiAppendRequest` at line 28, hex payload,
  request ID wrapper, and append sequence number.
- `api/proto/exec.ts`: MCP arguments at line 116, exec dispatch at line 156,
  MCP result at line 261 and exec stream-close at line 516. Only MCP codecs
  adapted. No shell/read/write/grep/list/context executors or result fabrication.
- `api/proto/interaction.ts`, `kv.ts`, `types.ts`: streamed text/turn-ended,
  bounded per-connection opaque KV get/set and AgentMode=1. No heuristic
  extraction of supposed assistant messages from opaque blobs.
- `api/agent-service.ts`: `buildChatMessage` at line 339; `sendToolResult` at
  line 460 supplies exec result followed by stream-close. BidiSse orchestration
  was rewritten without installed-client discovery, logging, endpoint retries,
  privacy fallback, guessed model defaults, or quota suppression.
- `session-reuse.ts`: read for comparison, **not reused**. Lines 5–20 explicitly
  say the reference closes existing sessions and starts fresh on tool results.
  That HTTP/remote-stream coupling is unnecessary in this wrapper: an in-memory
  iterator outlives the local HTTP response and resumes at the same exec.

## Unsafe handler explicitly excluded

No part of `openai-compat/handler.ts` was copied/imported. Targeted inspection
found `Bun.file` at lines 351/625/794/840 and `Bun.spawn` shell execution at line
781, plus spawned `rg` at line 820. Those are not protocol transport operations.
No fallback executor, tool-name guessing, or automatic builtin-to-native
mapping exists in this provider.

## Delta: installed generated schema inspection (read-only)

Inspected source text only, **without loading/executing the CLI**, reading any
credentials/config/account files, opening a browser or calling an API:

`C:/Users/miku0139/AppData/Local/cursor-agent/versions/2026.08.11-e8db854/`

- `index.js` SHA-256: `fca169d7955d80a6e725f2beee2ffbbfe9642b288dcf0a877d6cb7a87d208706`
- `6201.index.js` SHA-256: `d65b56a0a993049415693c79301d11b809258f0ca878833efe971bbd327112c0`

Live Windows validation on 2026-09-08 reached OAuth/model discovery, then
generation failed at the KV parser. Reinspection of the same installed
`agent.v1.KvServerMessage` schema confirmed optional message field 4,
`span_context`, alongside ID 1 and get/set oneof 2/3. The adapter accepts that
tracing field with singular length-delimited validation; it is neither echoed
nor treated as an instruction. Unknown fields/operations remain rejected.

The live server also sent `InteractionUpdate` field 25 with wire type 0.
Read-only inspection of installed `2026.09.02-c22c1a3/index.js` confirmed this
as optional uint64 `message_started_at_ms`, outside the update oneof.
Source SHA-256: `7c1957bb82b2b31f4ba53d3a9c11404fa263b31f84076e87fcb83539ac8f09a6`.
The parser validates a singular varint timestamp and keeps it out of model
content and tool execution. Malformed, duplicate and unknown fields still fail.
The live stream's top-level field 8 matches `AgentServerMessage.ttft_breakdown`
in the installed schema; it is timing telemetry, not execution or turn completion.
`TokenDeltaUpdate` (interaction 8) and `ThinkingCompletedUpdate` (interaction 5)
carry int32 field 1 (`tokens` and `thinking_duration_ms`). The old reference
incorrectly treated token delta as text. These counters are validated as progress
metadata and never fabricated into assistant text or billable usage.
Interaction 15 (`tool_call_delta`) is a partial notification, and 16/17
(`step_started`/`step_completed`) delimit steps. They do not execute tools or
complete a turn; typed exec messages and `turn_ended` retain those responsibilities.
The observed MCP exec contained fields 11/15/19/55. Official `ExecServerMessage`
defines 19 as optional span context and 55 as optional bool
`accept_hook_additional_contexts`. Both are validated as metadata; the adapter
does not run hooks or return hook context. Actual builtin and remote-machine
requests still fail. The previous parser misclassified these genuine MCP intents.
The observed nested `McpArgs` additionally carries field 9 `server_identifier`.
When present it must match the explicitly registered Polycode MCP provider;
foreign identifiers and smart-mode/skip-approval flags are not accepted.

The following are schema facts, independently encoded here, not copied CLI
implementations/handlers. Anchors are generated `agent.v1` type names (searchable
in the minified bundle), not a public or stability-guaranteed SDK contract.

| Message | Fields used (all nested messages unless type stated) |
| --- | --- |
| `UserMessageAction` | 1 user_message, 2 request_context, **7 conversation_history (optional)** |
| `ConversationHistory` | 1 messages (repeated); replace_user_info field 2 is **not used** |
| `ConversationHistoryMessage` | oneof: 1 user, 2 assistant, 3 tool |
| `ConversationHistoryUserMessage`, `ConversationHistoryAssistantMessage` | 1 content (repeated) |
| `ConversationHistoryUserContent`, `ConversationHistoryToolResultContent` | oneof: 1 text, 2 image |
| `ConversationHistoryTextContent` | 1 text (string) |
| `ConversationHistoryImageContent` | 1 data (**string**, base64 payload), 2 mime_type (optional string) |
| `ConversationHistoryAssistantContent` | 1 text, 4 tool_call; reasoning/signature alternatives 2/3 are not invented |
| `ConversationHistoryToolCall` | 1 tool_call_id, 2 tool_name, 3 args_json (all strings) |
| `ConversationHistoryToolMessage` | 1 tool_call_id, 2 tool_name (strings), 3 content (repeated), 4 is_error (optional bool); no hook contexts |
| `UserMessage` | 1 text, 2 message_id (strings), **3 selected_context**, 4 mode (enum) |
| `SelectedContext` | **1 selected_images (repeated)** |
| `SelectedImage` | 2 uuid (string), **7 mime_type (string), 8 data (bytes oneof)**; no path/blob/reference resolution |
| `RequestContext` | **2 rules (repeated CursorRule)**; existing environment/MCP fields unchanged |
| `CursorRule` | 1 full_path, 2 content (strings), 3 type, 4 source (enum) |
| `CursorRuleType` | 1 global (empty message, oneof) |
| `CursorRuleSource` | UNSPECIFIED=0, TEAM=1 (**never sent**), USER=2 |
| `InteractionUpdate` | **14 turn_ended** |
| `TurnEndedUpdate` | **1 input_tokens, 2 output_tokens, 3 cache_read_tokens, 4 cache_write_tokens, 5 reasoning_tokens**, all optional **int64**, not int32/doubles |
| `McpToolResultContentItem` | oneof: 1 text, 2 image |
| `McpImageContent` | 1 data (**bytes**), 2 mime_type (string) |

Useful `index.js` JavaScript string-offset anchors for this exact build:
ConversationHistory ~5092964, UserMessageAction ~5100043, UserMessage ~5116793,
AgentRunRequest custom_system_prompt ~5148092, TurnEndedUpdate ~5156703,
CursorRule ~5276518, McpImageContent ~5348385, RequestContext ~5436581,
SelectedImage ~5451620, SelectedContext ~5478912.

Ordinary-rule evidence: local `.cursorrules`/`AGENTS.md` handlers construct
`CursorRule` with `type.global` (around 4309738 in `index.js`); the generated source
enum includes USER=2. We submit caller instructions as these ordinary user rules,
with clearly virtual labels; no real rule file is read. This proves a legitimate
ordinary-rule wire mapping, **not** system/developer hierarchy or temporal scope.

Restrictions: CLI option help around 411959 in `index.js` explicitly describes
`--system-prompt` as **Anysphere/OpenAI team only**, and allowed/excluded-tools as
**internal only**. `AgentRunRequest.custom_system_prompt` field 8, internal harness
and access-spoofing overrides are never sent. Non-MCP requests still fail closed
locally, independently of remote instructions; no internal header is trusted.

Consumer evidence: `6201.index.js` around 13953 imports typed ConversationHistory
and validates `argsJson` with JSON.parse. Around 565521 its turnEnded consumer
subtracts cache read/write from input to produce uncached input, showing that
wire input already includes caches. This provider retains input as OpenAI
prompt_tokens and never double-adds cache/reasoning. Unlike that CLI consumer,
missing counters remain missing, not zero. Optional int64 values and derived
totals must fit JavaScript safe nonnegative integers.

`wire-fixtures.mjs` contains hand-authored literal encodings independent of the
runtime codecs: typed history with raw JSON args/call correlation, ordinary
USER rule, current inline GIF image, and optional-int64 turn-ended usage. Tests
also distinguish history image string data from current/MCP image bytes.

## Evidence limits

These remain undocumented compatibility layouts, not an official Cursor SDK
contract. Offline fixtures establish local wire mapping, passthrough and
isolation, not current backend acceptance. Typed history replaces the previous
JSON-only transcript prompt; system/developer text is now ordinary user rules,
not privileged role-equivalent instructions. Exact current-image interleaving,
metadata semantics, remote prompt injection, live image/history acceptance,
usage availability and paused MCP behavior remain unverified. The provider does
not attempt account/terms/access bypass or trust the remote MCP-only instruction
as its execution boundary. See README's integration gates.
