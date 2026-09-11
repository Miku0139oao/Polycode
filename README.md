<div align="center">

# Polycode

**One native coding-agent TUI. Your choice of model provider.**

Polycode is an independent, provider-neutral fork of
[Grok Build](https://github.com/xai-org/grok-build). It keeps Grok Build's
native agent engine — the tool loop, MCP, permissions, sandbox, subagents,
sessions, hooks, skills and plugins — and lets you pick **Grok**, a
**ChatGPT subscription**, or an **experimental Cursor subscription** as the
model behind that engine, from inside the same TUI.

It is not an official xAI, OpenAI or Cursor release.

[Install (Windows Preview)](#install-windows-native-preview) ·
[What Polycode adds](#what-polycode-adds-on-top-of-grok-build) ·
[Building from source](#building-from-source) ·
[Configuration](#configuration) ·
[Documentation](#documentation) ·
[Repository layout](#repository-layout) ·
[Development](#development) ·
[Safety and costs](#credentials-safety-and-costs) ·
[Upstream](#relationship-to-upstream-grok-build) ·
[License](#license)

</div>

---

## Status

| Area | State |
| --- | --- |
| Windows x64 native package | **v0.2.1 Preview** — opt-in testing, not a stable release. Grok generation and clean Windows 10/11 installs are unverified. See the [release notes](integrations/acceptance/preview-v0.2.1/release-notes.md). |
| Linux / macOS | Build from source only; no packaged release yet. |
| v0.2.0 WSL package | **Withdrawn.** User-reported failures across all providers; do not install it. |
| Codex feature ports (`context_budget`, `computer_use`) | Experimental, off by default; enable per feature flag. |

The earlier external-ACP prototype (`d549db3`) replaced the agent with an
external Codex/Cursor process. That design is rejected; its historical test
and login records are not evidence for the native architecture described here.

## What Polycode adds on top of Grok Build

### Provider selection inside the native TUI

| Command | Purpose |
| --- | --- |
| `/provider [grok\|codex\|cursor\|refresh\|cancel]` | Choose a model provider or sign in to a subscription; refresh the account's model catalog; cancel a pending login. |
| `/login [grok\|codex\|cursor]` | Browser OAuth for the selected provider. The TUI stays open through authorization; no external CLI login is required or imported. |
| `/model <name> [effort]` | Pick a model the signed-in account actually offers. Logging in never switches models on its own. |
| `/usage [show\|manage]` | Provider usage; `manage` opens native xAI billing. |
| `/fast [on\|off\|status]` | Faster processing where the account's catalog supports it (may cost more): ChatGPT priority tier, or the Cursor `-fast` model variant at the current reasoning effort. |

A small loopback **provider service** (bundled Bun runtime, code in
[`integrations/native-provider/`](integrations/native-provider/)) handles
browser authorization, credential refresh, account-scoped model catalogs and
streaming-protocol translation. It never executes tools. Every provider's tool
calls flow back through Grok Build's native permission prompts, sandbox and
result correlation, so file edits, shell commands, MCP servers, subagents,
sessions and resume behave the same regardless of which model is answering.

Provider capability differences are reported, not hidden: unsupported
sampling/reasoning options, image inputs or roles fail explicitly instead of
being dropped, and an error never triggers a silent switch to another provider,
model or metered API. Details and known gaps:
[integrations/README.md](integrations/README.md) (ChatGPT `ultra` effort,
Cursor protocol limitations) and the
[Cursor checkpoint](integrations/native-provider/cursor/README.md).

### Model-agnostic ports of Codex features (experimental, opt-in)

Both features are ports of ideas from [openai/codex](https://github.com/openai/codex)
reworked to run inside the native engine for **any** provider or model, not
just the one they shipped with. Both default to **off**.

| Feature | Enable | What it does |
| --- | --- | --- |
| `context_budget` | `GROK_CONTEXT_BUDGET=1` or `[features] context_budget = true` | Appends a per-turn `<system-reminder>` with used/remaining context tokens and the distance to auto-compaction, so a model can pace a long task, finish sub-goals and write durable notes before its context is summarised. The reminder is ephemeral: it is attached to the outbound request only and never persisted into history. |
| `computer_use` | `GROK_COMPUTER_USE=1` or `[features] computer_use = true` | Exposes a first-party `computer` tool: screenshot plus `click`, `double_click`, `move`, `drag`, `scroll`, `keypress`, `type` and `wait` actions on the local desktop. Backends: Linux/X11 (`xdotool` + `scrot`/`maim`/`import`/…), macOS (`screencapture` + `osascript`; grant Screen Recording and Accessibility to your terminal), Windows (PowerShell; nothing to install). |

`computer` is deliberately conservative: every call goes through the native
permission prompt, it is never auto-approved by permission rules or auto mode,
the "allow for the rest of this session" grant is held in memory only, and
subagents never receive the tool. Tuning lives under `[toolset.computer_use]`
(`display`, `max_screenshot_dimension`, `max_actions_per_call`, `settle_ms`);
see the [configuration reference](crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md).

### Windows native packaging

[`install.ps1`](install.ps1), [`install-mainline.ps1`](install-mainline.ps1),
[`install-preview.ps1`](install-preview.ps1),
[`polycode.ps1`](polycode.ps1) and the
[`Windows candidate`](.github/workflows/candidate-release.yml) workflow build,
hash-verify and install a self-contained Windows x64 package (MSVC native TUI,
Windows Bun runtime and the provider service). No WSL, Rust, Node, separate
Bun or external provider CLI is required on the user's machine.

## Install (Windows native)

One command opens an interactive menu: **install, update, overwrite PATH,
switch, list, or uninstall**, then **Candidate, Preview, or Stable**. Channels
live in separate directories and cannot overwrite each other. Production
`%LOCALAPPDATA%\Polycode` is never replaced or uninstalled. `-NoPath` skips PATH
changes on install/update; overwrite and switch always move user `PATH`.

```powershell
irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1 | iex
```

| Menu choice | Package | Default directory |
| --- | --- | --- |
| Candidate | Unpublished CI artifact from run [34641299942](https://github.com/Miku0139oao/Polycode/actions/runs/34641299942) (`afddba2`), including ChatGPT/Cursor patches plus last-used model restore, Cursor AvailableModels context windows, conversation recap on any provider model switch, tool continuation after `/fast`, and no provider-picker overlay on `--resume`. **Not** an accepted stable release. Requires authenticated `gh` to download the Actions artifact. | `%LOCALAPPDATA%\Polycode-Candidate` |
| Preview | Published v0.2.1 Preview (2026-09-08). | `%LOCALAPPDATA%\Polycode-Preview-v0.2.1` |
| Stable | Current Windows package from CI run [34380813272](https://github.com/Miku0139oao/Polycode/actions/runs/34380813272) (`bcc4eaf5`), including experimental `context_budget` / `computer_use`. **Not** a fully accepted stable release. | `%LOCALAPPDATA%\Polycode-Mainline` |

The bootstrap pins the size and SHA-256 of all six package files for the chosen
channel, verifies them, then runs the original installer with `-AllowCandidate`.
Inspect [`install-mainline.ps1`](install-mainline.ps1) before `iex` if you prefer.
Official `install.ps1 | iex` stays disabled; choosing Stable or Candidate does
**not** open that installer. Uninstall deletes only that channel directory
(including its `auth`) and removes its `PATH` entry.

Scripted / non-interactive:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1))) -Action Install -Channel Candidate
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1))) -Action List
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1))) -Action Switch -Channel Candidate
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1))) -Action Uninstall -Channel Preview -Force
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-mainline.ps1))) -Action Update -Channel Preview -NoPath
```

The dedicated 2026-09-08 Preview one-liner still works if you want that package
only, without the menu:

```powershell
irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-preview.ps1 | iex
```

Read the [Preview scope and limitations](integrations/acceptance/preview-v0.2.1/release-notes.md)
first if you use that older package. The menu script also accepts
`-InstallRoot D:\Polycode-Mainline`. Preview-only options remain in
[Preview installation](integrations/PREVIEW_INSTALL.md).

Targets: Windows 10 22H2 / Windows 11 x64, PowerShell 5.1 or 7. ARM64 is not a
native target. Provider credentials live in `%LOCALAPPDATA%\Polycode\auth`
(or the `-AuthDirectory` you pass to the launcher), separate from any official
CLI's files; log in through the TUI.

What the Preview does **not** claim: Grok generation (OAuth passes; no paid
generation test was run), clean Windows 10/11 installs, Windows Server, and
stable Cursor session recovery after upstream timeouts. The generic
`install.ps1 | iex` stable installer stays disabled until full acceptance. See
[Preview policy](integrations/PREVIEW_POLICY.md),
[Windows validation](integrations/WINDOWS_VALIDATION.md) and the
[roadmap](integrations/POLYCODE_ROADMAP.md).

For developers verifying a locally built candidate:

```powershell
.\install.ps1 -ArtifactDirectory D:\candidate-out -AllowCandidate -InstallRoot D:\polycode-test -NoPath
D:\polycode-test\bin\polycode.cmd -Project D:\my-project
```

`-StageOnly` verifies a new version directory without activating it; `-NoPath`
leaves both process and user `PATH` untouched. Failed installs restore the
previous entrypoint.

## Building from source

Requirements:

- **Rust** — pinned by [`rust-toolchain.toml`](rust-toolchain.toml); `rustup`
  installs it on first build.
- **[DotSlash](https://dotslash-cli.com)** — hermetic tools under [`bin/`](bin/)
  (notably [`bin/protoc`](bin/protoc)) are DotSlash launchers. Install it and
  put `dotslash` on `PATH` **before** building:

  ```sh
  cargo install dotslash
  # or: prebuilt packages — https://dotslash-cli.com/docs/installation/
  /usr/bin/env dotslash --help   # sanity check
  ```

- **protoc** — resolved from [`bin/protoc`](bin/protoc) via DotSlash, or a
  `protoc` on `PATH` / `$PROTOC`.
- **Node 22 or Bun 1.3.x** (what CI uses) — only for the provider service and
  its tests; end users of the Windows package need neither.
- Windows-native builds: follow [Windows build and validation](integrations/WINDOWS_VALIDATION.md).
  `bin/protoc` must keep LF line endings.

```sh
cargo run -p xai-grok-pager-bin              # build + launch the TUI (Grok provider only)
cargo build -p xai-grok-pager-bin --release  # release binary: target/release/xai-grok-pager
cargo check -p xai-grok-pager-bin            # fast validation
```

The binary is still named `xai-grok-pager`. Running it directly gives you the
native engine with Grok authentication only; ChatGPT and Cursor selection need
the provider service, which the launcher starts alongside the binary:

```sh
npm ci --prefix integrations/native-provider
node integrations/native-provider/launch.mjs \
  --binary "$PWD/target/debug/xai-grok-pager" --cwd "$PWD/my-project" [--provider codex|cursor]
```

`--binary` and `--cwd` must be absolute. On Linux/macOS this is a development
path: the source layout is tested, but packaged releases and full provider
acceptance currently exist for Windows only. Do not use an old external-ACP
binary as a "native" build.

## Configuration

Polycode reads the same layered configuration as Grok Build
(`~/.grok/config.toml`, `managed_config.toml`, `requirements.toml`,
`GROK_CONFIG` overlay, environment variables). Fork-specific keys:

```toml
[features]
context_budget = false                 # per-turn context-budget reminder (experimental)
computer_use = false                   # expose the permission-gated `computer` tool

[toolset.computer_use]                 # only read when features.computer_use = true
display = ":0"                         # Linux/X11 DISPLAY to drive (default: process DISPLAY)
max_screenshot_dimension = 1280        # longest screenshot side in px; larger screens are downscaled
max_actions_per_call = 20              # cap on actions per `computer` call
settle_ms = 500                        # pause before the screenshot after input actions
```

Full field list: [configuration reference](crates/codegen/xai-grok-pager/docs/user-guide/26-config-reference.md);
environment variables: [internal reference](crates/codegen/xai-grok-pager/docs/internal/22-environment-variables.md).

## Documentation

Fork documentation (start here for anything provider- or Windows-related):

| Document | Contents |
| --- | --- |
| [integrations/README.md](integrations/README.md) | Architecture, provider flow, ChatGPT/Cursor limitations, credentials and cost rules (Traditional Chinese) |
| [integrations/POLYCODE_ROADMAP.md](integrations/POLYCODE_ROADMAP.md) | Current goals, acceptance gates and what is still blocked |
| [integrations/acceptance/preview-v0.2.1/release-notes.md](integrations/acceptance/preview-v0.2.1/release-notes.md) | Exactly what the published Preview was verified to do |
| [integrations/PREVIEW_INSTALL.md](integrations/PREVIEW_INSTALL.md) · [PREVIEW_POLICY.md](integrations/PREVIEW_POLICY.md) · [PREVIEW_PUBLICATION.md](integrations/PREVIEW_PUBLICATION.md) | Preview installation, policy and publication record |
| [integrations/WINDOWS_VALIDATION.md](integrations/WINDOWS_VALIDATION.md) | Windows build, packaging and validation procedure |
| [integrations/native-provider/README.md](integrations/native-provider/README.md) · [cursor/README.md](integrations/native-provider/cursor/README.md) | Provider service ownership and the Cursor transport checkpoint |
| [integrations/VERIFICATION.md](integrations/VERIFICATION.md) | Historical verification ledger (older WSL/ACP evidence; not current acceptance) |

Engine documentation is inherited from upstream and applies unchanged to the
native engine (the `grok` command name in those pages maps to the
`xai-grok-pager` binary / `polycode` launcher):
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
— getting started, keyboard shortcuts, slash commands, configuration, theming,
MCP servers, skills, plugins, hooks, headless mode, subagents, sessions,
sandboxing, permissions and more. Upstream's hosted docs are at
[docs.x.ai/build/overview](https://docs.x.ai/build/overview).

## Repository layout

| Path | Contents |
| --- | --- |
| `crates/codegen/xai-grok-pager-bin` | Composition-root package; builds the `xai-grok-pager` binary |
| `crates/codegen/xai-grok-pager` | The TUI: scrollback, prompt, modals, rendering, slash commands (`/provider`, `/login`, `/usage`, `/fast`) |
| `crates/codegen/xai-grok-shell` | Agent runtime, leader/stdio/headless entry points, provider bridge (`polycode.rs`), context-budget reminder |
| `crates/codegen/xai-grok-agent` | Turn loop, compaction, tool registration |
| `crates/codegen/xai-grok-tools` | Tool implementations (terminal, file edit, search, web fetch, `computer`, …) |
| `crates/codegen/xai-grok-workspace` | Host filesystem, VCS, execution, checkpoints, permission manager |
| `crates/codegen/xai-grok-config-types` | Feature-flag registry and remote settings |
| `crates/codegen/...` | The rest of the CLI crate closure (config, MCP, markdown, sandbox, …) |
| `crates/common/`, `crates/build/`, `prod/mc/` | Small shared leaf crates pulled in by the closure |
| `integrations/native-provider/` | Provider service: OAuth, credential store, ChatGPT and Cursor transports, launcher (Node/Bun) |
| `integrations/tests/`, `integrations/*.mjs` | Installer, candidate-readiness and Windows smoke/probe suites |
| `integrations/*.md`, `integrations/acceptance/` | Fork documentation and per-release acceptance records |
| `install.ps1`, `install-mainline.ps1`, `install-preview.ps1`, `polycode.ps1` | Windows installer, interactive Candidate/Preview/Stable bootstrap with list/switch/uninstall, Preview-only bootstrap and source-checkout launcher |
| `.github/workflows/candidate-release.yml` | `Windows candidate` CI: build, package, install and smoke-test the Windows artifact |
| `third_party/` | Vendored upstream source (Mermaid diagram stack) |

> [!IMPORTANT]
> The root `Cargo.toml` (workspace members, dependency versions, lints,
> profiles) is **generated** upstream — treat it as read-only and edit
> per-crate `Cargo.toml` files instead.

## Development

```sh
cargo check -p <crate>        # always target specific crates; full-workspace builds are slow
cargo test -p xai-grok-shell  # per-crate tests
cargo clippy -p <crate>       # lint config: clippy.toml at the repo root
cargo fmt --all               # rustfmt.toml at the repo root

# provider service + installer suites (offline; no accounts or paid calls)
node --test integrations/native-provider/test/*.test.mjs \
            integrations/native-provider/cursor/provider.test.mjs \
            integrations/tests/candidate-readiness.test.mjs
```

Rules that keep the fork coherent:

- Keep the native engine in charge. Providers return text and unexecuted tool
  intents; Grok Build's permission flow decides what runs.
- Never mask a failure by switching provider/model, lowering reasoning effort,
  skipping a permission prompt, replaying an already-executed tool call or
  reusing another CLI's credentials.
- Add a failing regression before patching a demonstrated defect; do not weaken
  assertions or raise limits to obtain a pass.
- Offline/mock passes are not live acceptance. Record what was actually
  verified, on which bytes, and leave everything else marked blocked or pending.

## Credentials, safety and costs

- Credentials come from each vendor's own browser authorization flow and are
  stored by Polycode (`%LOCALAPPDATA%\Polycode\auth` on Windows,
  `${XDG_DATA_HOME:-$HOME/.local/share}/polycode/auth/` elsewhere) with
  `0700`/`0600` permissions. They are sensitive plaintext files, not an
  encrypted vault. Never commit, share or attach them.
- Polycode does not read browser or other CLIs' tokens, does not use
  third-party token proxies, and its loopback service must not be exposed
  publicly.
- No transport bypasses quotas, billing or account limits. A **subscription is
  not unlimited or free**: eligibility, quotas, on-demand credits and
  organisation policy stay with the vendor. Set spending limits in your account
  if that matters to you.
- Cursor is an undocumented protocol used at your own account/terms risk;
  ChatGPT access is a subscription transport, not the official Codex agent.
- The `computer` tool controls your real desktop. Keep `features.computer_use`
  off unless you want that, and answer its prompts deliberately.

## Relationship to upstream Grok Build

Grok Build is SpaceXAI's terminal AI coding agent; its Rust source is
published at [xai-org/grok-build](https://github.com/xai-org/grok-build) and
synced from the SpaceXAI monorepo. Polycode tracks that tree: `SOURCE_REV`
records the imported upstream monorepo revision (not a Polycode release),
crate names, the `xai-grok-pager` binary, the `grok` command name in inherited
docs and the `GROK_*` environment variables are all retained so upstream
changes keep merging cleanly. Grok's own login, usage and telemetry rules
still apply when Grok is the selected provider. xAI, OpenAI and Cursor neither
endorse nor support this fork.

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md). Upstream Grok Build does not accept
external contributions; changes to this fork are discussed here.

## Security

See [`SECURITY.md`](SECURITY.md). Do not open public issues for
vulnerabilities and never include tokens, auth files or OAuth URLs in reports.

## License

First-party code is licensed under the **Apache License, Version 2.0** — see
[`LICENSE`](LICENSE).

Third-party and vendored code remains under its original licenses:

- [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) — crates.io / git dependencies,
  bundled UI themes and **in-tree source ports** (including openai/codex and
  sst/opencode tool implementations)
- [`crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md`](crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md)
  — crate-local notice for the codex and opencode ports (license texts +
  Apache §4(b) change notice)
- [`integrations/native-provider/BUN-LICENSE.md`](integrations/native-provider/BUN-LICENSE.md)
  and [`integrations/native-provider/cursor/PROVENANCE.md`](integrations/native-provider/cursor/PROVENANCE.md)
  — bundled Bun runtime and the adapted Cursor transport
- [`third_party/NOTICE`](third_party/NOTICE) — vendored Mermaid-stack index
