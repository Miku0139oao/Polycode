<# Polycode Windows entrypoint. Requires the WSL build; see integrations/README.md. #>
param(
    [ValidateSet('codex', 'cursor', 'native')][string]$Backend = 'codex',
    [string]$Project = (Get-Location).Path,
    [string]$Distro = 'archlinux',
    [string]$Binary = '/root/grok-build-target/debug/xai-grok-pager',
    [string]$CodexExecutable,
    [string]$CursorDirectory,
    [string]$Resume
)
& (Join-Path $PSScriptRoot 'integrations/launch.ps1') @PSBoundParameters
exit $LASTEXITCODE
