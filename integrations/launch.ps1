param(
    [ValidateSet('codex', 'cursor', 'native')][string]$Backend = 'codex',
    [string]$Project = (Get-Location).Path,
    [string]$Distro = 'archlinux',
    [string]$Binary = '/root/grok-build-target/debug/xai-grok-pager',
    [string]$CodexExecutable,
    [string]$CursorDirectory,
    [string]$Resume
)
$ErrorActionPreference = 'Stop'
$Project = (Resolve-Path -LiteralPath $Project).Path
function To-LinuxPath([string]$Path) {
    $converted = & wsl.exe -d $Distro --exec wslpath -u $Path
    if ($LASTEXITCODE -ne 0) { throw 'Cannot convert path with WSL. Check -Distro.' }
    return ($converted | Out-String).Trim()
}
$linuxProject = To-LinuxPath $Project
if ($linuxProject -notmatch '^/mnt/[a-zA-Z]/') { throw 'Use a project on a mounted Windows drive.' }
$pagerArgs = @('--cwd', $linuxProject)
if ($Resume) { $pagerArgs += @('--resume', $Resume) }
if ($Backend -eq 'native') { $pagerArgs += '--no-external-acp' }
try {
    if ($Backend -ne 'native') {
        $windowsNode = (Get-Command node.exe -ErrorAction Stop).Source
        $hostScript = Join-Path $PSScriptRoot 'wsl-host.mjs'
        $externalArgs = @($hostScript)
        if ($Backend -eq 'codex') {
            if (-not $CodexExecutable) {
                $CodexExecutable = Join-Path $env:LOCALAPPDATA 'Programs/OpenAI/Codex/bin/codex.exe'
            }
            if (-not (Test-Path -LiteralPath $CodexExecutable)) { throw 'Official Codex executable not found; pass -CodexExecutable.' }
            $CodexExecutable = (Resolve-Path -LiteralPath $CodexExecutable).Path
            $externalArgs += @($windowsNode, (Join-Path $PSScriptRoot 'codex-acp/cli.mjs'), '--codex-executable', $CodexExecutable)
            $auth = 'codex_chatgpt'
        } else {
            if (-not $CursorDirectory) {
                $versions = Join-Path $env:LOCALAPPDATA 'cursor-agent/versions'
                $latest = Get-ChildItem -LiteralPath $versions -Directory | Where-Object { $_.Name -match '^\d{4}\.\d{2}\.\d{2}-' } | Sort-Object Name -Descending | Select-Object -First 1
                if (-not $latest) { throw 'Official Cursor CLI not found; install it or pass -CursorDirectory.' }
                $CursorDirectory = $latest.FullName
            }
            $cursorNode = Join-Path $CursorDirectory 'node.exe'
            $cursorScript = Join-Path $CursorDirectory 'index.js'
            if (-not (Test-Path $cursorNode) -or -not (Test-Path $cursorScript)) { throw 'CursorDirectory must contain node.exe and index.js.' }
            $externalArgs += @($cursorNode, $cursorScript, 'acp')
            $auth = 'cursor_login'
        }
        $pagerArgs += @('--acp-executable', (To-LinuxPath $windowsNode), '--acp-auth-method', $auth)
        foreach ($arg in $externalArgs) { $pagerArgs += "--acp-arg=$arg" }
    }
    & wsl.exe -d $Distro --exec $Binary @pagerArgs
    $result = $LASTEXITCODE
} catch {
    Write-Error $_
    exit 1
}
exit $result
