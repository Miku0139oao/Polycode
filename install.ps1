<# Per-user native Polycode installer: Windows PowerShell 5.1+ and existing WSL
x86_64 with glibc >= 2.43 (currently Arch Linux), zlib, libgcc and Windows interop.
No provider login, browser, external agent CLI, Rust compiler or administrator needed.
-ArtifactDirectory installs previously downloaded release assets (still hash checked).
-InstallRoot/-LinuxRoot allow isolated installs; -NoPath never changes either PATH.
-StageOnly verifies/stages a release without changing the active launcher or PATH.
Checksums detect corruption, not a compromised release publisher.
#>
param(
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version = 'v0.2.0',
    [ValidateNotNullOrEmpty()][string]$Distro = 'archlinux',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Polycode'),
    [string]$LinuxRoot,
    [string]$ArtifactDirectory,
    [switch]$NoPath,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$assets = @('polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip')
$id = $Version + '-' + [Guid]::NewGuid().ToString('N')
$temp = Join-Path ([IO.Path]::GetTempPath()) ('polycode-install-' + $id)
$root = [IO.Path]::GetFullPath($InstallRoot)
$release = Join-Path $root ('releases\' + $id)
$bin = Join-Path $root 'bin'
$shim = Join-Path $bin 'polycode.cmd'
$newShim = Join-Path $bin ($id + '.cmd')
$backup = Join-Path $bin ($id + '.backup')
$binaryDir = $null; $linuxCreated = $false; $releaseCreated = $false
$activated = $false; $pathTouched = $false; $committed = $false
$oldProcessPath = $env:Path
$oldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Quote-Argument([string]$Value) {
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
function Wsl([string[]]$Arguments) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = (Get-Command wsl.exe -ErrorAction Stop).Source
    $info.UseShellExecute = $false
    $info.Arguments = (@(@('-d', $Distro, '--exec') + $Arguments) | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process; $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Cannot start WSL.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        $process.WaitForExit()
        if ($process.ExitCode -ne 0) { throw ('WSL command failed (' + $Arguments[0] + '): ' + $stderr.GetAwaiter().GetResult()) }
        return $stdout.GetAwaiter().GetResult().TrimEnd("`r", "`n")
    } finally { $process.Dispose() }
}
function LinuxPath([string]$Path) {
    $converted = Wsl @('wslpath', '-u', $Path)
    if (-not $converted.StartsWith('/') -or $converted.Contains("`n") -or $converted.Contains("`r")) { throw 'Invalid WSL path.' }
    return $converted
}
function Expand-SafeZip([string]$Path, [string]$Destination) {
    $zip = [IO.Compression.ZipFile]::OpenRead($Path)
    try {
        $seen = @{}
        foreach ($entry in $zip.Entries) {
            $name = $entry.FullName.Replace('\', '/')
            $parts = $name.TrimEnd('/').Split('/')
            if (-not $name -or $name.StartsWith('/') -or $name -match '[:\x00-\x1f]' -or
                @($parts | Where-Object { $_ -in @('', '.', '..') -or $_ -match '[. ]$|^(?i:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)' }).Count -gt 0 -or
                (($entry.ExternalAttributes -shr 16) -band 0xF000) -eq 0xA000) { throw "Unsafe archive path: $name" }
            $key = $name.TrimEnd('/')
            if ($seen.ContainsKey($key)) { throw "Duplicate archive path: $name" }
            $seen[$key] = $true
        }
        foreach ($required in @('polycode.ps1', 'integrations/launch.ps1', 'integrations/native-provider/launch.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES', 'third-party/BUN-LICENSE.md', 'third-party/dependencies.json', 'release-manifest.json')) {
            if (-not $seen.ContainsKey($required)) { throw "Incomplete runtime archive: $required" }
        }
    } finally { $zip.Dispose() }
    [IO.Compression.ZipFile]::ExtractToDirectory($Path, $Destination)
}
function Expand-Gzip([string]$Path, [string]$Destination) {
    $inputFile = [IO.File]::OpenRead($Path)
    try {
        $outputFile = [IO.File]::Create($Destination)
        try {
            $gzip = New-Object IO.Compression.GzipStream($inputFile, [IO.Compression.CompressionMode]::Decompress)
            try { $gzip.CopyTo($outputFile) } finally { $gzip.Dispose() }
        } finally { $outputFile.Dispose() }
    } finally { $inputFile.Dispose() }
}
try {
    if ($root -match '[;\r\n]') { throw 'InstallRoot cannot contain semicolons or newlines (PATH safety).' }
    if ((Wsl @('uname', '-m')) -ne 'x86_64') { throw 'This release supports WSL x86_64 only.' }
    $glibc = Wsl @('getconf', 'GNU_LIBC_VERSION')
    if ($glibc -notmatch '^glibc (\d+\.\d+)(?:\D|$)' -or [version]$Matches[1] -lt [version]'2.43') { throw 'This binary requires glibc >= 2.43. Older Ubuntu distros are not supported by this release.' }
    if (-not $LinuxRoot) {
        $homePath = Wsl @('printenv', 'HOME')
        $LinuxRoot = "$homePath/.local/share/polycode"
    }
    if (-not $LinuxRoot.StartsWith('/') -or $LinuxRoot -match '[\r\n]' -or $LinuxRoot.TrimEnd('/') -eq '') { throw 'LinuxRoot must be a non-root absolute WSL directory.' }
    $binaryDir = $LinuxRoot.TrimEnd('/') + '/' + $id
    New-Item -ItemType Directory -Path $temp | Out-Null
    $base = "https://github.com/Miku0139oao/Polycode/releases/download/$Version"
    foreach ($asset in @('SHA256SUMS') + $assets) {
        $destination = Join-Path $temp $asset
        if ($ArtifactDirectory) { Copy-Item -LiteralPath (Join-Path $ArtifactDirectory $asset) -Destination $destination }
        else { Invoke-WebRequest -UseBasicParsing "$base/$asset" -OutFile $destination }
    }
    $sums = @{}
    foreach ($line in Get-Content -LiteralPath (Join-Path $temp 'SHA256SUMS')) {
        if (-not $line.Trim()) { continue }
        if ($line -notmatch '^([a-fA-F0-9]{64})\s+\*?([A-Za-z0-9._-]+)$') { throw 'Malformed SHA256SUMS.' }
        $name = $Matches[2]; $hash = $Matches[1]
        if ($sums.ContainsKey($name)) { throw "Ambiguous checksum: $name" }
        $sums[$name] = $hash
    }
    foreach ($asset in $assets) {
        if (-not $sums.ContainsKey($asset)) { throw "Missing checksum: $asset" }
        if ((Get-Sha256 (Join-Path $temp $asset)) -ne $sums[$asset]) { throw "Checksum mismatch: $asset" }
    }
    $runtimeStage = Join-Path $temp 'runtime'
    Expand-SafeZip (Join-Path $temp 'polycode-runtime.zip') $runtimeStage
    $manifest = Get-Content -LiteralPath (Join-Path $runtimeStage 'release-manifest.json') -Raw | ConvertFrom-Json
    if ($manifest.version -ne $Version -or $manifest.architecture -ne 'x86_64' -or $manifest.minimumGlibc -ne '2.43' -or $manifest.protocol -ne 'native-model-bridge') { throw 'Runtime release manifest does not match the requested native release.' }
    # Never overwrite even the same version: both filesystems use a fresh release ID.
    Wsl @('mkdir', '-p', '--', $LinuxRoot) | Out-Null
    Wsl @('mkdir', '--', $binaryDir) | Out-Null
    $linuxCreated = $true
    foreach ($item in @(@{ name = 'polycode'; archive = $assets[0] }, @{ name = 'bun'; archive = $assets[1] })) {
        $file = Join-Path $temp $item.name
        Expand-Gzip (Join-Path $temp $item.archive) $file
        Wsl @('install', '-m', '755', '--', (LinuxPath $file), "$binaryDir/$($item.name)") | Out-Null
    }
    $help = Wsl @('timeout', '30', "$binaryDir/polycode", '--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) {
        if (-not $help.Contains($flag)) { throw "Not a native Polycode binary: missing $flag. The old prototype cannot be installed as v0.2.0." }
    }
    Wsl @('timeout', '30', "$binaryDir/bun", '--version') | Out-Null
    # Load the complete bundle with the shipped Bun without starting the service,
    # signing in, launching a browser, or executing the TUI.
    Wsl @('timeout', '30', "$binaryDir/bun", '-e', 'const entry=process.argv[1]; process.argv[1]="polycode-install-check"; await import(entry)', (LinuxPath (Join-Path $runtimeStage 'integrations/native-provider/launch.mjs'))) | Out-Null
    @{ binary = "$binaryDir/polycode"; runtime = "$binaryDir/bun"; distro = $Distro; version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeStage 'install-config.json') -Encoding UTF8
    New-Item -ItemType Directory -Force -Path (Split-Path $release) | Out-Null
    New-Item -ItemType Directory -Path $release | Out-Null
    $releaseCreated = $true
    Get-ChildItem -LiteralPath $runtimeStage -Force | Copy-Item -Destination $release -Recurse -Force
    if (-not $StageOnly) {
        New-Item -ItemType Directory -Force -Path $bin | Out-Null
        @('@echo off', 'setlocal DisableDelayedExpansion', ('powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0..\releases\' + $id + '\polycode.ps1" %*'), 'exit /b %errorlevel%') | Set-Content -LiteralPath $newShim -Encoding ASCII
        if (Test-Path -LiteralPath $shim -PathType Leaf) { [IO.File]::Replace($newShim, $shim, $backup) }
        else { [IO.File]::Move($newShim, $shim) }
        $activated = $true
        if (-not $NoPath) {
            if (@([string]$oldUserPath -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -eq 0) {
                $pathTouched = $true
                [Environment]::SetEnvironmentVariable('Path', (([string]$oldUserPath).TrimEnd(';') + ';' + $bin).TrimStart(';'), 'User')
            }
            if (@($env:Path -split ';' | Where-Object { $_.Trim().TrimEnd('\') -ieq $bin.TrimEnd('\') }).Count -eq 0) { $env:Path = "$bin;$env:Path" }
        }
    }
    $committed = $true
    if ($StageOnly) { Write-Host "Verified/staged $Version at $release; active launcher and PATH unchanged." }
    else { Write-Host "Installed $Version at $release. Run polycode; select Grok/ChatGPT/Cursor inside the TUI." }
    if ($NoPath) { Write-Host "PATH unchanged. Launcher: $shim" }
} finally {
    $launcherRestored = $true
    if (-not $committed) {
        # Attempt every rollback even if, for example, registry access is denied.
        if ($pathTouched) {
            try { [Environment]::SetEnvironmentVariable('Path', $oldUserPath, 'User') }
            catch { Write-Warning "Could not restore user PATH: $_" }
        }
        $env:Path = $oldProcessPath
        if ($activated) {
            try {
                if (Test-Path -LiteralPath $backup -PathType Leaf) { [IO.File]::Replace($backup, $shim, $null) }
                elseif (Test-Path -LiteralPath $shim -PathType Leaf) { Remove-Item -LiteralPath $shim -Force }
            } catch {
                $launcherRestored = $false
                Write-Warning "Could not restore launcher; retaining release and backup for recovery: $backup. $_"
            }
        }
        if ($launcherRestored) {
            if ($releaseCreated) { try { Remove-Item -LiteralPath $release -Recurse -Force } catch { Write-Warning "Could not remove failed release: $_" } }
            if ($linuxCreated) { try { Wsl @('rm', '-rf', '--', $binaryDir) | Out-Null } catch { Write-Warning "Could not remove failed WSL release: $_" } }
        }
    }
    $cleanup = @($newShim, $temp)
    if ($committed -or $launcherRestored) { $cleanup += $backup }
    foreach ($file in $cleanup) {
        try { if (Test-Path -LiteralPath $file) { Remove-Item -LiteralPath $file -Recurse -Force } }
        catch { Write-Warning "Could not remove installer temporary path ${file}: $_" }
    }
}
