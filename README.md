<div align="center">

<h1>
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://media.x.ai/v1/website/spacexai-symbol-white-transparent-0c31957f.png">
    <source media="(prefers-color-scheme: light)" srcset="https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png">
    <img alt="SpaceXAI logo" src="https://media.x.ai/v1/website/spacexai-symbol-black-transparent-6435cf42.png" width="96">
  </picture>
  <br>
  Polycode
</h1>

**Polycode** is an independent [Grok Build](https://github.com/xai-org/grok-build)
fork developing **Grok, ChatGPT subscription, and experimental Cursor subscription
selection in the same TUI**, while retaining Grok's native agent engine, tools,
MCP, permissions, sessions, and features. It is not an official xAI, OpenAI,
or Cursor release.

**Native integration is in progress; v0.2.0 is pending verification and release.**
The earlier external-ACP prototype (`d549db3`) replaced the agent and does **not**
meet this architecture. Its passing tests and live logins are historical evidence,
not proof of native completion.

[Install](#install-polycode-windows--wsl) ·
[Provider selection and limitations](integrations/README.md) ·
[Verification status](integrations/VERIFICATION.md)

**Upstream Grok Build** is SpaceXAI's terminal-based AI coding agent. It runs as a
full-screen TUI that understands your codebase, edits files, executes shell
commands, searches the web, and manages long-running tasks — interactively,
headlessly for scripting/CI, or embedded in editors via the Agent Client
Protocol (ACP).

[Install Polycode](#install-polycode-windows--wsl) ·
[Building from source](#building-from-source) ·
[Documentation](#documentation) ·
[Repository layout](#repository-layout) ·
[Development](#development) ·
[Contributing](#contributing) ·
[License](#license)

![Upstream Grok Build TUI; not evidence of native subscription integration](https://media.x.ai/v1/website/universe-tui-screenshot-6f7a0837.png)

**Learn more about Grok Build at [x.ai/cli](https://x.ai/cli)**

The upstream Rust CLI/TUI and agent runtime originate in the SpaceXAI monorepo.
`SOURCE_REV` records the imported upstream revision, not this fork's native
integration or release status.

</div>

---

## Install Polycode (Windows + WSL)

**Planned v0.2.0 installer — not yet verified as a published, working release.**
Wait for [verification](integrations/VERIFICATION.md) and the
[release](https://github.com/Miku0139oao/Polycode/releases) to be finalized before
using this command. It downloads and executes code from this project's repository;
review the script first if needed.

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/main/install.ps1))) -Version v0.2.0
```

Target: **Windows with an existing WSL Arch Linux x86_64 distribution**, glibc
2.43 or newer, zlib, libgcc, and Windows interop enabled; default distro name
`archlinux` (installer override: `-Distro NAME`). This is not an Ubuntu, macOS,
or native Windows binary support claim. The installer does not install WSL.
The planned package includes the native binary, Bun runtime, and provider service;
no Rust build, Codex CLI, Cursor CLI, or prior CLI login should be needed.

Intended workflow after the native release passes verification:

```powershell
polycode                                  # enter the native provider UI
polycode -Project D:\my-project
polycode -Backend codex -Project D:\my-project  # optional initial preference only
```

Choose Grok, ChatGPT subscription, or experimental Cursor **inside the TUI**.
Browser OAuth must start there, return to the same TUI, and allow model/provider
switching without restarting. `-Backend` does not select an external agent.
These are release requirements, **not yet demonstrated end to end**.

The draft installer uses per-user Windows files and WSL binaries, checks release
SHA-256 sums, and adds `polycode` to PATH. An already-open terminal may need its
PATH refreshed after installation; authentication and provider switching must
not require a TUI restart. Planned assets are `polycode-wsl-x64.gz`,
`polycode-bun-wsl-x64.gz`, `polycode-runtime.zip`, and `SHA256SUMS`.

Subscription quotas and provider billing rules still apply; there is no quota
bypass or automatic metered-API fallback. Cursor uses an undocumented protocol
with account/terms risks; parity remains unproven. See the
[security and compatibility boundaries](integrations/README.md).

Upstream installers at [x.ai/cli](https://x.ai/cli) install **Grok Build**, not
Polycode. Upstream changes are listed in the [Grok changelog](https://x.ai/build/changelog).

## Building from source

Requirements:

- **Rust** — the toolchain is pinned by [`rust-toolchain.toml`](rust-toolchain.toml);
  `rustup` installs it automatically on first build.
- **[DotSlash](https://dotslash-cli.com)** — required so hermetic tools under
  [`bin/`](bin/) (notably [`bin/protoc`](bin/protoc)) can download and run.
  Install it and ensure `dotslash` is on your `PATH` **before** building:

  ```sh
  cargo install dotslash
  # or: prebuilt packages — https://dotslash-cli.com/docs/installation/
  /usr/bin/env dotslash --help   # sanity check
  ```

- **protoc** — proto codegen resolves [`bin/protoc`](bin/protoc) via DotSlash,
  or falls back to a `protoc` on `PATH` / `$PROTOC`.
- For this fork, use the target WSL Arch x64 environment above. Upstream supports
  additional build hosts, but those are not verified Polycode release targets.

```sh
cargo run -p xai-grok-pager-bin              # build + launch the TUI
cargo build -p xai-grok-pager-bin --release  # release binary: target/release/xai-grok-pager
cargo check -p xai-grok-pager-bin            # fast validation
```

The binary artifact is named `xai-grok-pager`; upstream installs ship it as
`grok`. These Cargo commands alone do not initialize Polycode's native provider
service. The integrated launcher/build path is described in
[integrations/README.md](integrations/README.md); do not use an older ACP binary
as a native integration build. The upstream
[authentication guide](crates/codegen/xai-grok-pager/docs/user-guide/02-authentication.md)
describes Grok authentication, not proof of subscription OAuth support.

## Documentation

Upstream Grok Build documentation is available at
[docs.x.ai/build/overview](https://docs.x.ai/build/overview). For this fork's
subscription integration status, use [integrations/README.md](integrations/README.md).

The user guide ships with the pager crate:
[`crates/codegen/xai-grok-pager/docs/user-guide/`](crates/codegen/xai-grok-pager/docs/user-guide/)
— getting started, keyboard shortcuts, slash commands, configuration, theming,
MCP servers, skills, plugins, hooks, headless mode, sandboxing, and more.

## Repository layout

| Path | Contents |
|------|----------|
| `crates/codegen/xai-grok-pager-bin` | Composition-root package; builds the `xai-grok-pager` binary |
| `crates/codegen/xai-grok-pager` | The TUI: scrollback, prompt, modals, rendering |
| `crates/codegen/xai-grok-shell` | Agent runtime + leader/stdio/headless entry points |
| `crates/codegen/xai-grok-tools` | Tool implementations (terminal, file edit, search, ...) |
| `crates/codegen/xai-grok-workspace` | Host filesystem, VCS, execution, checkpoints |
| `crates/codegen/...` | The rest of the CLI crate closure (config, MCP, markdown, sandbox, ...) |
| `crates/common/`, `crates/build/`, `prod/mc/` | Small shared leaf crates pulled in by the closure |
| `third_party/` | Vendored upstream source (Mermaid diagram stack) — see below |
| `integrations/native-provider/` | In-progress subscription model transports and local OAuth service; not replacement agents |

> [!IMPORTANT]
> The root `Cargo.toml` (workspace members, dependency versions, lints,
> profiles) is **generated** — treat it as read-only. Prefer editing per-crate
> `Cargo.toml` files.

## Development

```sh
cargo check -p <crate>        # always target specific crates; full-workspace builds are slow
cargo test -p xai-grok-config # per-crate tests
cargo clippy -p <crate>       # lint config: clippy.toml at the repo root
cargo fmt --all               # rustfmt.toml at the repo root
```

## Contributing

> [!NOTE]
> External contributions are not accepted. See [`CONTRIBUTING.md`](CONTRIBUTING.md).

## License

First-party code in this repository is licensed under the **Apache License,
Version 2.0** — see [`LICENSE`](LICENSE).

Third-party and vendored code remains under its original licenses. See:

- [`THIRD-PARTY-NOTICES`](THIRD-PARTY-NOTICES) — crates.io / git dependencies,
  bundled UI themes, and **in-tree source ports** (including openai/codex and
  sst/opencode tool implementations)
- [`crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md`](crates/codegen/xai-grok-tools/THIRD_PARTY_NOTICES.md)
  — crate-local notice for the codex and opencode ports (license texts +
  Apache §4(b) change notice)
- [`third_party/NOTICE`](third_party/NOTICE) — vendored Mermaid-stack index
