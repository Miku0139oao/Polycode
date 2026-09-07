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

**Windows native candidate under validation; no usable public installer is advertised yet.**
**The v0.2.0 WSL installation recommendation is withdrawn.**
The published v0.2.0 WSL candidate has user-reported failures across all providers.
Historical development-binary results do not establish that package or the new Windows build.

The earlier external-ACP prototype (`d549db3`) replaced the agent and does **not**
meet this architecture. Its passing tests and live logins are historical evidence,
not proof of native completion.

[Install](#install-polycode-windows-native) ·
[Provider selection and limitations](integrations/README.md) ·
[Verification status](integrations/VERIFICATION.md)

**Upstream Grok Build** is SpaceXAI's terminal-based AI coding agent. It runs as a
full-screen TUI that understands your codebase, edits files, executes shell
commands, searches the web, and manages long-running tasks — interactively,
headlessly for scripting/CI, or embedded in editors via the Agent Client
Protocol (ACP).

[Install Polycode](#install-polycode-windows-native) ·
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

## Install Polycode (Windows native)

**Not ready for public installation.** Do not use the old v0.2.0 WSL candidate as
the Windows installation target. Its reported provider failures remain under
investigation; Linux development tests are not acceptance of that package.

The Windows candidate targets Windows 10 22H2 / Windows 11 x64 and PowerShell
5.1 / 7. It bundles the MSVC native TUI and Windows Bun and directly starts Windows
processes. WSL, Rust, Node, a separate Bun installation and external provider CLIs
are not required. ARM64 is not a supported native target for this candidate.

For developer verification of a locally built candidate:

```powershell
.\install.ps1 -ArtifactDirectory D:\candidate-out -AllowCandidate -InstallRoot D:\polycode-test -NoPath
D:\polycode-test\bin\polycode.cmd -Project D:\my-project
```

`-StageOnly` verifies a new version directory without replacing the active
launcher or changing PATH. `-NoPath` preserves both process and user PATH.
Installation failures restore the previous entrypoint; successful upgrades
retain old version directories.

Windows provider credentials live in `%LOCALAPPDATA%\Polycode\auth`, outside
version directories. Use launcher option `-AuthDirectory D:\isolated-auth` for
isolated verification. Log in through the TUI; WSL tokens/sessions are not imported.

The Windows workflow builds downloadable Actions artifacts first. Publishing
uses the same accepted bytes and requires evidence for clean Windows 10/11
installs, all three real provider logins/generations, coding, resume, and targeted
Task/MCP/billing regression. Mock Grok responses cannot satisfy real generation.

No real paid Grok requests are currently authorized. Until test quota becomes
available and every gate passes, no new prerelease or local activation occurs.
Stable release authorization remains separate.

See [Windows validation](integrations/WINDOWS_VALIDATION.md). Linux/WSL source
development can use the explicit Bun bridge CLI; it is not the default Windows
installation path.

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
