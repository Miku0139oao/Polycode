# One-line Windows Preview installation

For Windows x64 with 64-bit PowerShell 5.1 or PowerShell 7, the interactive
install / update / switch / list / uninstall menu (Candidate, Preview or Stable)
is:

```powershell
irm https://raw.githubusercontent.com/Miku0139oao/Polycode/cursor/model-picker-ui-b060/install-mainline.ps1 | iex
```

This page documents the dedicated Preview-only one-liner, which still pins the
same v0.2.1 package:

```powershell
irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-preview.ps1 | iex
```

This is **v0.2.1 Preview**, not a stable or fully accepted release. Review the
[release limitations](acceptance/preview-v0.2.1/release-notes.md) first. Only run
downloaded scripts from a source you trust; you can download and inspect
`install-preview.ps1` before executing it instead of using `iex`.

The bootstrap installs into `%LOCALAPPDATA%\Polycode-Preview-v0.2.1` by default.
It does not modify PATH, replace the default production installation, log in,
import credentials or send model requests. It prints the full launch command:

```powershell
& "$env:LOCALAPPDATA\Polycode-Preview-v0.2.1\bin\polycode.cmd" -Project (Get-Location).Path -AuthDirectory "$env:LOCALAPPDATA\Polycode-Preview-v0.2.1\auth"
```

Choose and sign in to a provider in the TUI. Grok generation remains unverified
for this Preview; provider fees and quotas still apply.

## Optional PATH activation

If you explicitly want the Preview launcher added to user PATH:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/Miku0139oao/Polycode/fix/windows-terminal-ci/install-preview.ps1))) -AddToPath
```

Open a new terminal afterward to use `polycode`. This can take precedence over
another installed `polycode`; omit this option to leave PATH unchanged. For an
isolated provider login, still supply `-AuthDirectory` as shown above; PATH
activation does not change the launcher's default credential directory.

To select another separate installation directory, download the script and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install-preview.ps1 -InstallRoot D:\Polycode-Preview
```

The default production `%LOCALAPPDATA%\Polycode` directory is rejected by this
Preview bootstrap. Reinstalling into the same Preview root uses the original
installer's versioned activation and rollback behavior.

## Verification boundary

The small bootstrap is served from the existing development branch; its target
package is pinned to v0.2.1, not `latest`. It pins the size and SHA256 of all six
published assets, including the installer and manifest. It verifies every file
before launching the downloaded installer. The original installer then performs
its own manifest, runtime, PE and dependency checks.

Download or verification errors stop installation. Only the bootstrap's own
temporary download directory is cleaned. The original release files and stable
installer authorization are unchanged. The generic `install.ps1` piped directly
into `iex` remains intentionally disabled; use this named Preview entrypoint.

No WSL, Rust, Node, separate Bun installation or external provider agent is
required. Windows 10 22H2 is a target, not a clean-system acceptance claim.

## Verification record

The public raw URL above was exercised with the actual `irm | iex` pipeline in
both Windows PowerShell 5.1 and PowerShell 7 on 2026-09-08. Each run downloaded
the real release files, installed into an isolated default Preview directory,
retained caller execution, and left user PATH unchanged. All three provider
menus, normal exits and alternate-screen restoration passed in both runs.
The native hash remained
`919fd8eb3ce146a594f04daa05a0819b6543fcf95479dbbed9510d16f0c78536`.

The complete Node suite passed 202 tests with no failures or skips, including
15 bootstrap integrity/failure/cleanup/argument tests across both PowerShell
versions. `-AddToPath` argument construction is covered offline; actual user PATH
activation was intentionally not performed on the owner's machine. These checks
do not add OAuth, paid-generation or clean-OS acceptance claims.
