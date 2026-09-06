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

## Evidence limits

These are undocumented, third-party reverse-engineered layouts, not an official
Cursor SDK contract. Offline wire mocks establish local passthrough and
isolation; they do not establish that the current Cursor backend accepts the
handshake, honors the MCP-only instruction, or preserves native system-prompt
semantics. Specifically, `encodeUserMessage(text, messageId, mode)` has one text
field, and `AgentServiceClient.buildChatMessage` uses it. The reference provides
no demonstrated OpenAI-role-preserving AgentService request. This wrapper sends
the intact JSON transcript in that text field and does **not** claim equivalent
system/developer role enforcement. See README's integration gates.
