# Contributing to Polycode

Polycode is an independent fork of [Grok Build](https://github.com/xai-org/grok-build).
Upstream does not accept external contributions; **this fork does**. Bug reports
and pull requests are welcome, and the maintainer decides what is merged.

## Before you open an issue

- Include OS build, provider/model, exact steps and the sanitized error text.
- Never attach auth files, tokens, OAuth callback URLs, private source or
  unredacted conversation logs.
- Security problems go through [`SECURITY.md`](SECURITY.md), not a public issue.

## Before you open a pull request

Build and test the crates you touched; full-workspace builds are slow:

```sh
cargo check -p <crate>
cargo test -p <crate>
cargo clippy -p <crate>
cargo fmt --all
node --test integrations/native-provider/test/*.test.mjs \
            integrations/native-provider/cursor/provider.test.mjs
```

Prerequisites (Rust toolchain, DotSlash, protoc, Node/Bun) are listed in the
[README](README.md#building-from-source). Windows-specific packaging changes
must also pass the `Windows candidate` workflow.

## Ground rules

These are the architectural constraints the fork is built on. Changes that
violate them are not merged, however well tested.

- **The native engine stays in charge.** Grok Build's tool loop, MCP,
  permissions, sandbox, subagents and sessions handle every provider. A
  provider transport returns text and unexecuted tool intents; it never runs
  tools, owns sessions or replaces the agent (the old external-ACP prototype
  is rejected).
- **No silent fallbacks.** Do not mask a failure by switching provider or
  model, lowering reasoning effort, skipping or auto-answering a permission
  prompt, replaying an already-executed tool call, faking usage, or dropping
  unsupported parameters. Report unsupported capabilities explicitly.
- **Credentials are off limits.** Never read, copy, log or print another
  CLI's tokens or Polycode's own auth files; never add token proxies.
- **Evidence over labels.** Add a failing regression before fixing a defect.
  Do not weaken assertions, widen timeouts arbitrarily or raise limits to
  obtain a pass. Offline/mock results are not live acceptance; say what was
  actually verified and on which artifact.
- **Stay mergeable with upstream.** The `crates/` tree is synced from
  upstream Grok Build. Keep fork changes small and additive, gate new
  behaviour behind feature flags (see `crates/codegen/xai-grok-config-types`),
  keep crate names, the `xai-grok-pager` binary and `GROK_*` environment
  variables, and never edit the generated root `Cargo.toml`.
- **Ported code carries its notices.** Code adapted from other projects
  (openai/codex, sst/opencode, the Cursor transport, …) must be recorded in
  [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) or the relevant
  crate-local notice with its license and change notice.

## Documentation

If a change adds a config key, feature flag or environment variable, update the
[configuration reference](crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md),
the [environment-variable reference](crates/codegen/xai-grok-pager/docs/internal/22-environment-variables.md)
and, for user-visible features, the root [README](README.md).

## Licensing

Contributions are accepted under the Apache License, Version 2.0
([`LICENSE`](LICENSE)). By submitting a change you agree it may be
distributed under that license. No separate contributor license agreement is
required.
