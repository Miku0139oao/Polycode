# Native subscription provider service (in progress)

This is the model/OAuth layer for the **native Grok engine**, not a Codex or
Cursor CLI agent launcher. The integrated native TUI, live endpoints and v0.2.0
release remain unverified. See [acceptance gates](../VERIFICATION.md).

## Ownership

- **Grok:** TUI, agent loop, tools, MCP, approval/sandbox policy, session/history,
  hooks and existing feature execution. Model switching must not replace these.
- **Local service:** browser authorization coordination, credential refresh,
  account-scoped model catalogs and conversion between native model requests and
  subscription transports. It must never execute tools on behalf of Grok.
- **Transport:** return text and unexecuted tool intents; accept the native
  engine's correlated results. Errors cannot trigger another model, provider or
  metered API.

The launcher draft starts a token-protected loopback service and invokes the
Rust binary with `--polycode-native --no-external-acp`. These flags disable the
old **external-agent replacement**, not Grok's internal protocol/runtime. An
optional initial provider preference must not change engine ownership.

## Authentication and local data

The TUI must initiate browser OAuth and remain open through completion, model
selection and later provider switches. Neither `codex login` nor Cursor CLI
installation/login is a prerequisite. Fresh native OAuth remains a live-test
gate; old successful ACP authentication is unrelated evidence.

Polycode owns WSL credentials at
`${XDG_DATA_HOME:-$HOME/.local/share}/polycode/auth/` (`codex.json` and
`cursor.json`). The store implementation uses cross-process provider locks,
revisioned snapshots and atomic commits; new directories/files use `0700`/`0600`.
These are sensitive plaintext local files, not an encrypted vault. Never import
browser/CLI tokens, use third-party token proxies, log secrets or expose the
loopback service publicly. Locking tests do not prove live rotation behavior.

## Provider status

**ChatGPT:** OAuth/Responses conversion is implemented at the offline-checkpoint
level. Real browser callback reachability from Windows to WSL, model discovery,
request fidelity and native tool rounds still require integrated/live evidence.
It is subscription transport, not the official Codex agent.

**Cursor:** experimental undocumented transport; account/terms risks were
explicitly accepted for investigation, not waived or vendor-approved. The
[Cursor checkpoint](cursor/README.md) and [provenance](cursor/PROVENANCE.md)
describe its mocked same-stream tool continuation and fail-closed protocol.
Remote role/instruction semantics, sampling, usage, image support, model metadata
and native-request compatibility remain unresolved. Unsupported errors are
honest safeguards, not feature parity or permission to remove requirements.

No transport may bypass quotas or billing, invent usage/model capabilities,
silently discard native settings, replay denied tools or select a paid fallback.
Provider-side extra-usage billing can still apply under the user's account rules.

## Offline checkpoint and reproduction

The parent reports **55 passing offline tests** across the service/ChatGPT/store/
launcher and Cursor suites. This is not a native Rust/TUI or production test
result. On a checkout containing the integrated implementation, from the root:

```sh
npm ci --prefix integrations/native-provider
node --test integrations/native-provider/test/*.test.mjs integrations/native-provider/cursor/provider.test.mjs
```

Node is a development test tool here; the planned release bundles Bun and its
licenses, so users should not need Node, npm, Rust or official provider CLIs.
Keep upstream, adapted Cursor, npm dependency and Bun notices in the runtime
package. Only the [verification ledger](../VERIFICATION.md), updated with actual
integrated/live/release evidence, should promote this checkpoint to completion.
