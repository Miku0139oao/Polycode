# Security Policy

Polycode is an independent fork of Grok Build and is not covered by xAI's,
OpenAI's or Cursor's bug-bounty programmes.

## Reporting a vulnerability in Polycode

Do **not** open a public GitHub issue for security problems.

Use GitHub's private vulnerability reporting for this repository
(**Security → Report a vulnerability** on
https://github.com/Miku0139oao/Polycode). If that option is unavailable,
contact the repository owner directly through GitHub instead of posting
details publicly.

Include the affected version or commit, the provider(s) involved, reproduction
steps and impact. Never include tokens, credential files, OAuth callback URLs
or unredacted conversation logs in a report.

Areas of particular interest:

- Credential handling in the provider service and the local credential store
  (`integrations/native-provider/`), including the loopback bridge and its token.
- Anything that lets a model or provider bypass the native permission prompts,
  sandbox, or the `computer` tool's approval flow.
- Installer and update integrity (`install.ps1`, `install-preview.ps1`,
  asset hash verification).

## Vulnerabilities in upstream Grok Build

If the issue is in the inherited engine code under `crates/` and also affects
upstream, please report it to xAI as well through their program at
https://hackerone.com/x, and let us know here so the fork can pick up the fix.

## Supported versions

Only the latest published Preview and the current development branch receive
fixes. The withdrawn v0.2.0 WSL package is unsupported.
