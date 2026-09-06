# Codex subscription → ACP adapter

Runs the official `codex app-server` as a child process and presents ACP over stdin/stdout. No third-party model gateway or copied OAuth tokens. Requires Node.js 22+ and Codex CLI (tested with 0.153.4).

## Authentication

Run `codex login` and select ChatGPT login. The adapter checks `account/read` and refuses API-key, Bedrock and signed-out accounts. It pins the OpenAI provider and ChatGPT login mode; it does not fall back to a metered API key. Subscription entitlement, account/workspace policies and any purchased credits remain controlled by OpenAI. This is not unlimited usage.

Set `GROK_CODEX_EXECUTABLE` if the official Codex binary is not on PATH. It must be an executable, not a shell command string.

```sh
node cli.mjs
```

This is a protocol server, not an interactive prompt: its stdout is exclusively ACP JSONL. Use the modified Grok Build external ACP connector to drive it.

## Validation

```sh
npm test
node smoke.mjs
# Explicitly consumes a small amount of subscription usage:
node live-test.mjs --allow-subscription-usage
```

`smoke.mjs` checks only protocol initialization and authentication; it does not send a model prompt or print account identity. The opt-in live test uses a temporary workspace, asks for one short answer, denies any unexpected permission requests, and verifies streamed output plus session replay.

Local generated Codex protocol schemas are in `schema/`, produced with:

```sh
codex app-server generate-json-schema --out ./schema
```

## Integration boundary

This backend runs **Codex's own agent/tools**, not Grok's tool loop. It adapts text/image prompts, model discovery/selection, persisted threads, streamed assistant/reasoning/tool events, command/file approvals and cancellation to ACP. Grok-only voice/cloud/rewind operations are not capabilities of this backend. Unknown blocking methods return an explicit unsupported-method error and never grant permissions automatically.

For a future direct-model backend retaining Grok's agent loop, OpenCode/Pi OAuth provider patterns are relevant, but that is a separate transport implementation rather than this adapter. Merely replacing a Responses API URL does not establish subscription compatibility.

Official references:
- https://developers.openai.com/codex/app-server
- https://developers.openai.com/codex/auth.md
