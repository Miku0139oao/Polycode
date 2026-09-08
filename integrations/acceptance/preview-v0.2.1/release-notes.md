# Polycode v0.2.1 Preview (Windows x64)

**Opt-in Preview, not a stable release. Full acceptance is incomplete.**
This independent Grok Build fork is not an official xAI, OpenAI or Cursor release.

## Verified scope

- Windows 11 Pro build 26200 development host: native installation, three provider
  menus, normal TUI exit and terminal restoration.
- Grok, ChatGPT and Cursor actual OAuth succeeded on this exact candidate.
- ChatGPT GPT-5.4-Mini low and Cursor Auto: actual native file read/write,
  PowerShell execution and same-session resume reading a newly created file.
- Source Node suite: 177 passed; bundled Bun 1.3.14 provider suite: 140 passed.
- Real native tools, background shell result retrieval, search, Task children,
  MCP, approval and cancellation regressions passed with synthetic model responses.
  Those offline probes are not additional live-account or billing acceptance.

## Known limitations and unverified scope

- **generation-native:** Grok generation has not been tested. OAuth success does
  not prove generation. No paid Grok test was sent because a conditional US$1
  cap could not be reliably enforced. Normal provider charges/quotas still apply.
- **windows10-clean-install / windows11-clean-install:** clean-system testing
  is outstanding. Windows 10 22H2 is a target, not certified by this Preview.
  Native x64 only; ARM64 is not a supported native target.
- **cursor-timeout-restart:** one session encountered upstream 504 followed by
  a 409 live-tool-call continuation guard. The timeout cause is unknown. A new
  session passed; existing-session recovery is not established. Start a new
  session explicitly and inspect completed file/command effects before retrying.
- **server2025-incomplete:** the supplemental VM check did not finish all provider
  observations. It is not full Windows Server support certification.
- Cursor is experimental. Provider-specific controls, image/history semantics and
  unknown context sizes retain their documented restrictions; no silent fallback
  or replay-protection bypass is introduced.

## Install without replacing your existing installation

1. Download these **six assets** from this release into one new folder:
   `install.ps1`, `manifest.json`, `SHA256SUMS`, `polycode-windows-x64.gz`,
   `polycode-bun-windows-x64.gz`, and `polycode-runtime.zip`.
2. Open PowerShell in that folder and run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -Version v0.2.1 -AllowCandidate -NoPath -InstallRoot "$env:LOCALAPPDATA\Polycode-Preview-v0.2.1"
& "$env:LOCALAPPDATA\Polycode-Preview-v0.2.1\bin\polycode.cmd" -Project (Get-Location).Path -AuthDirectory "$env:LOCALAPPDATA\Polycode-Preview-v0.2.1\auth"
```

Choose a provider and log in inside the TUI. Do not copy credentials from another
CLI. No WSL, Rust, Node, separately installed Bun or external provider agent is
required. The installer verifies bundled hashes. `-NoPath` leaves PATH unchanged;
launch via the explicit command above. Use a disposable project for first tests.

The original immutable installer prints `UNPUBLISHED CANDIDATE PREFLIGHT`.
That preserved build-time warning does not grant full acceptance; these release
notes authorize only the disclosed Preview scope. The generic stable one-command
installer remains disabled. Do not use the withdrawn v0.2.0 WSL candidate.

Report issues at https://github.com/Miku0139oao/Polycode/issues with OS build,
provider/model, steps and sanitized error text. Never attach auth files, tokens,
OAuth URLs, private source or unredacted conversation logs.
