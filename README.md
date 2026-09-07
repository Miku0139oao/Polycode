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

**Unpublished development candidate only; v0.2.0 is NOT released.**
Latest user report: **ChatGPT and native Grok work; Cursor OAuth still fails**.
This is not candidate-hash-bound formal acceptance. Provider-aware `/usage` and
TUI branding fixes are pending separately; this preparation candidate must be
rebuilt/retested with a new hash after those native changes.
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

**Unpublished candidate.** Cursor live OAuth, real-provider Task/resume, paid
billing and authorized public distribution remain open. GitHub Actions can
build and attach candidate assets; that is not live acceptance. See the
[fail-closed procedure](integrations/RELEASE_READINESS.md).

### One-command from GitHub (candidate)

Windows PowerShell 5.1 or 7, with an existing WSL Arch distro. This downloads
the versioned `install.ps1` and the six hash-checked assets. It does **not**
require authorization sidecars and does **not** claim a finished release:

```powershell
& { $ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP ('polycode-install-'+[guid]::NewGuid().ToString('N')+'.ps1'); iwr -UseBasicParsing https://github.com/Miku0139oao/Polycode/releases/download/v0.2.0/install.ps1 -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Version v0.2.0 -GitHubCandidate }
```

Add `-NoPath` to leave user PATH unchanged, or `-InstallRoot`/`-LinuxRoot` for
an isolated copy. Review the downloaded `install.ps1` before executing it.
Rebuilds are published by [the candidate-release workflow](.github/workflows/candidate-release.yml)
(`workflow_dispatch` or a `vX.Y.Z` tag).

### Local candidate folder

If `install.ps1` already sits next to the six candidate files, run that file
with `-AllowCandidate`. `-ArtifactDirectory` is optional in that case:

```powershell
$id=[guid]::NewGuid().ToString('N'); & D:/ai-harness/native-release-candidate-18d/install.ps1 -AllowCandidate -InstallRoot "D:/ai-harness/polycode-candidate-install-$id" -LinuxRoot "/tmp/polycode-candidate-install-$id" -NoPath
```

That historical schema1 18d/e8 folder remains untouched and is not promotable.

**Authorized public command (sidecars required, not enabled yet):**

```powershell
& { $ErrorActionPreference='Stop'; $p=Join-Path $env:TEMP ('polycode-install-'+[guid]::NewGuid().ToString('N')+'.ps1'); iwr -UseBasicParsing https://github.com/Miku0139oao/Polycode/releases/download/v0.2.0/install.ps1 -OutFile $p; powershell.exe -NoProfile -ExecutionPolicy Bypass -File $p -Version v0.2.0 }
```

That path still needs matching parent authorization and complete PASS
readiness sidecars. Its public-URL gate is **DEFERRED_UNTIL_PUBLICATION**.

Target: **Windows with an existing WSL Arch Linux x86_64 distribution**, glibc
2.43 or newer, zlib, libgcc, libstdc++, ICU 78 and Windows interop enabled; default distro name
`archlinux` (installer override: `-Distro NAME`). This is not an Ubuntu, macOS,
or native Windows binary support claim. The installer does not install WSL.
The local package includes the native binary, Bun runtime, and provider service;
no Rust build, Codex CLI, Cursor CLI, or prior CLI login should be needed.
The copied Arch Bun reports `1.3.14` / revision `1.3.14-canary.1+0d9b296af`;
its system-library dependencies are recorded in `manifest.json`, not bundled as
portable Linux libraries. See the [actual candidate report](integrations/PACKAGE_CANDIDATE_REPORT.md).

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

The installer uses per-user Windows files and WSL binaries and verifies SHA-256,
archive paths, inventory, uncompressed ELF hashes and native flags. Normal future
public installation adds `polycode` to PATH; `-NoPath` does not. An already-open
terminal may need its PATH refreshed after installation; authentication/provider
switching must not require a TUI restart. Candidate assets are
`polycode-wsl-x64.gz`, `polycode-bun-wsl-x64.gz`, `polycode-runtime.zip`,
`install.ps1`, `manifest.json`, and `SHA256SUMS`. New schema2 packages have immutable
classification, not publication status. After all actual acceptance and separate
parent permission, promotion may add `release-readiness.json` and
`release-authorization.json` **without changing any of those six accepted files**.
Nothing has been promoted or published here. Parent session resume (distinct from
child Task resume), prompt identity for all three providers, native reasoning
effort capability/UI/wire/inheritance/resume and busy queued model-switch safe
commit are now explicit required gates in the [procedure](integrations/RELEASE_READINESS.md).
The bundled service is a model transport for the native engine, not an external
replacement agent. Checksums
protect against corruption, not a compromised publisher. This WSL package does
not establish native Windows sandbox parity.

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
