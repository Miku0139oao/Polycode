<# Native model bridge launcher. No external Codex/Cursor agent is started here.
Wrapper options: -Backend auto|native|codex|cursor, -Project, -Distro, -Binary,
-Runtime, -Resume. All other arguments (or everything after --) reach the native CLI.
The bridge owns URL/token export and lifecycle; forwarding requires its
-- <native args> CLI contract.
#>
$ErrorActionPreference = 'Stop'
$options = @{
    Backend = 'auto'; Project = (Get-Location).Path; Distro = 'archlinux'
    Binary = ''; Runtime = '/usr/sbin/bun'
}
$configPath = Join-Path (Split-Path $PSScriptRoot) 'install-config.json'
if (Test-Path -LiteralPath $configPath) {
    $installed = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    foreach ($key in @('Binary', 'Runtime', 'Distro')) {
        if (-not $installed.$key) { throw "Missing installed setting: $key" }
        $options[$key] = [string]$installed.$key
    }
}
$nativeArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq '--') { $nativeArgs += @($args | Select-Object -Skip ($i + 1)); break }
    if ($arg -match '^-(Backend|Project|Distro|Binary|Runtime|Resume|CodexExecutable|CursorDirectory)$') {
        $key = $Matches[1]
        if (++$i -ge $args.Count -or [string]::IsNullOrEmpty([string]$args[$i])) { throw "Missing value for $arg" }
        if ($key -in @('CodexExecutable', 'CursorDirectory')) { throw "$arg is obsolete: native Polycode does not launch Codex/Cursor CLI agents." }
        $options[$key] = [string]$args[$i]
    } else { $nativeArgs += $arg }
}
if ($options.Backend -notin @('auto', 'native', 'codex', 'cursor')) { throw 'Backend must be auto, native, codex or cursor.' }
$options.Backend = $options.Backend.ToLowerInvariant()
if ([string]::IsNullOrWhiteSpace($options.Distro)) { throw 'A WSL distribution is required.' }
foreach ($key in @('Binary', 'Runtime')) {
    if ([string]::IsNullOrEmpty($options[$key]) -or -not $options[$key].StartsWith('/') -or $options[$key].Contains("`n") -or $options[$key].Contains("`r")) { throw "$key must be an absolute WSL path." }
}
# ProcessStartInfo avoids Windows PowerShell 5.1's lossy native argument binding.
# These are Windows argv escaping rules, NOT a WSL shell command; always --exec.
function Quote-Argument([string]$Value) {
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
function Invoke-Wsl([string[]]$Arguments, [switch]$Capture) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command wsl.exe -ErrorAction Stop).Source
    $info.UseShellExecute = $false
    $info.Arguments = (@(@('-d', $options.Distro, '--exec') + $Arguments) | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.RedirectStandardOutput = [bool]$Capture
    $info.RedirectStandardError = [bool]$Capture
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Cannot start WSL.' }
        if ($Capture) { $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync() }
        $process.WaitForExit()
        if (-not $Capture) { return $process.ExitCode }
        $text = $stdout.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw ('WSL path conversion failed: ' + $stderr.GetAwaiter().GetResult()) }
        return $text.TrimEnd("`r", "`n")
    } finally { $process.Dispose() }
}
function To-LinuxPath([string]$Path) {
    $result = Invoke-Wsl -Arguments @('wslpath', '-u', $Path) -Capture
    if (-not $result.StartsWith('/') -or $result.Contains("`n") -or $result.Contains("`r")) { throw 'Invalid converted WSL path.' }
    return $result
}
$project = Get-Item -LiteralPath $options.Project -ErrorAction Stop
if (-not $project.PSIsContainer -or $project.PSProvider.Name -ne 'FileSystem') { throw 'Project must be an existing filesystem directory.' }
$entryPath = Join-Path $PSScriptRoot 'native-provider/launch.mjs'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Native bridge is missing. Reinstall the Polycode runtime.' }
$launchArgs = @($options.Runtime, (To-LinuxPath $entryPath), '--binary', $options.Binary, '--cwd', (To-LinuxPath $project.FullName), '--provider', $options.Backend)
if ($options.Resume) { $launchArgs += @('--resume', $options.Resume) }
if ($nativeArgs.Count) { $launchArgs += @('--') + $nativeArgs }
exit (Invoke-Wsl -Arguments $launchArgs)
