<# Windows native launcher. Wrapper options use one dash.
-Backend auto|native|codex|cursor, -Project, -Binary, -Runtime, -Resume,
-AuthDirectory. Arguments after -- are forwarded unchanged to the native TUI.
#>
$ErrorActionPreference = 'Stop'
$options = @{ Backend = 'auto'; Project = (Get-Location).Path; Binary = ''; Runtime = '' }
$configPath = Join-Path (Split-Path $PSScriptRoot) 'install-config.json'
if (Test-Path -LiteralPath $configPath) {
    $installed = Get-Content -LiteralPath $configPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($installed.schemaVersion -ne 1 -or $installed.platform -cne 'windows') { throw 'Legacy WSL or unsupported install config. Install the Windows native candidate.' }
    foreach ($key in @('Binary', 'Runtime')) {
        if ($installed.$key -isnot [string] -or -not $installed.$key) { throw "Missing installed setting: $key" }
        $options[$key] = $installed.$key
    }
}
$nativeArgs = @()
for ($i = 0; $i -lt $args.Count; $i++) {
    $arg = [string]$args[$i]
    if ($arg -eq '--') { $nativeArgs += @($args | Select-Object -Skip ($i + 1)); break }
    if ($arg -match '^-(Backend|Project|Binary|Runtime|Resume|AuthDirectory|Distro|CodexExecutable|CursorDirectory)$') {
        $key = $Matches[1]
        if (++$i -ge $args.Count -or [string]::IsNullOrEmpty([string]$args[$i])) { throw "Missing value for $arg" }
        if ($key -in @('Distro', 'CodexExecutable', 'CursorDirectory')) { throw "$arg is obsolete: this launcher uses Windows native processes." }
        $options[$key] = [string]$args[$i]
    } else { $nativeArgs += $arg }
}
if ($options.Backend -notin @('auto', 'native', 'codex', 'cursor')) { throw 'Backend must be auto, native, codex or cursor.' }
$options.Backend = $options.Backend.ToLowerInvariant()
foreach ($key in @('Binary', 'Runtime')) {
    $path = $options[$key]
    if ($path -notmatch '^(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+\\)' -or $path -match '[\r\n]' -or -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw "$key must name an existing absolute Windows executable path." }
}
. (Join-Path $PSScriptRoot 'windows-process.ps1')
$project = Get-Item -LiteralPath $options.Project -ErrorAction Stop
if (-not $project.PSIsContainer -or $project.PSProvider.Name -ne 'FileSystem') { throw 'Project must be an existing filesystem directory.' }
$entryPath = Join-Path $PSScriptRoot 'native-provider/launch.mjs'
if (-not (Test-Path -LiteralPath $entryPath -PathType Leaf)) { throw 'Native bridge is missing. Reinstall the Polycode runtime.' }
$launchArgs = @($entryPath, '--binary', $options.Binary, '--cwd', $project.FullName, '--provider', $options.Backend)
if ($options.Resume) { $launchArgs += @('--resume', $options.Resume) }
if ($options.AuthDirectory) { $launchArgs += @('--auth-directory', [IO.Path]::GetFullPath($options.AuthDirectory)) }
if ($nativeArgs.Count) { $launchArgs += @('--') + $nativeArgs }
$info = New-Object Diagnostics.ProcessStartInfo
$info.FileName = $options.Runtime
$info.UseShellExecute = $false
$info.WorkingDirectory = $project.FullName
$info.Arguments = ($launchArgs | ForEach-Object { Quote-Argument $_ }) -join ' '
$ripgrep = Join-Path (Split-Path $PSScriptRoot) 'vendor\rg.exe'
if (Test-Path -LiteralPath $ripgrep -PathType Leaf) {
    Assert-WindowsExecutable $ripgrep
    $info.EnvironmentVariables['RG_BIN_PATH'] = [IO.Path]::GetFullPath($ripgrep)
} elseif ($installed) {
    throw 'Bundled search executable is missing. Reinstall the Polycode Windows runtime.'
}
$process = New-Object Diagnostics.Process
$process.StartInfo = $info
try {
    if (-not $process.Start()) { throw 'Cannot start the installed Windows runtime.' }
    $process.WaitForExit()
    exit $process.ExitCode
} finally { $process.Dispose() }
