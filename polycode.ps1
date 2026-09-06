<# Polycode Windows entrypoint. Wrapper options use one dash; native CLI arguments pass through.
Examples: polycode -Backend cursor --model MODEL; polycode -- --help
#>
# Deliberately no param block: PowerShell parameter binding otherwise consumes native
# --help/--version, abbreviations and positional prompts before they reach Polycode.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'integrations/launch.ps1') @args
exit $LASTEXITCODE
