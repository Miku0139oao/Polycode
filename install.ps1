<# Per-user native Polycode installer: Windows PowerShell 5.1+ and existing WSL
x86_64 with glibc >= 2.43 (Arch Linux), zlib, libgcc, libstdc++, ICU78 and Windows interop.
No provider login, browser, external agent CLI, Rust compiler or administrator needed.
-ArtifactDirectory installs local UNPUBLISHED CANDIDATE assets (still hash checked).
Requires -AllowCandidate: local preflight never means release/live acceptance.
Without -ArtifactDirectory, an immutable candidate requires separate parent
release authorization + PASS readiness, both bound to the exact accepted bytes.
Classification never means published. Sidecars do not repack the runtime.
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
    [switch]$AllowCandidate,
    [switch]$NoPath,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$assets = @('polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'manifest.json', 'install.ps1')
# Kept in lockstep with release-readiness.mjs by a contract test. Self-contained
# installer: never trusts a downloaded policy to remove a necessary gate.
$releasePolicyVersion = '2026-09-07.2'
$requiredReleaseGates = @(
    'oauth-chatgpt', 'oauth-cursor',
    'task-inherit-chatgpt', 'task-result-chatgpt', 'task-resume-chatgpt',
    'task-inherit-cursor', 'task-result-cursor', 'task-resume-cursor',
    'session-resume-chatgpt', 'session-resume-cursor',
    'prompt-identity-native', 'prompt-identity-chatgpt', 'prompt-identity-cursor',
    'native-reasoning-effort-capability', 'native-reasoning-effort-ui',
    'native-reasoning-effort-wire', 'native-reasoning-effort-inheritance', 'native-reasoning-effort-resume',
    'busy-queued-model-switch-safe-commit',
    'tool-reject', 'tool-allow-once', 'native-billing-deny', 'native-billing-allow',
    'browser-handoff', 'installed-entrypoint', 'provider-aware-usage', 'tui-branding',
    'regression', 'hash-provenance', 'final-binary-profile'
)
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
function Assert-DistributionAuthorization($Manifest, [string]$CandidateHash) {
    $authorization = Get-Content -LiteralPath (Join-Path $temp 'release-authorization.json') -Raw | ConvertFrom-Json
    $ready = Get-Content -LiteralPath (Join-Path $temp 'release-readiness.json') -Raw | ConvertFrom-Json
    if ($Manifest.schemaVersion -ne 2 -or $Manifest.classification -cne 'immutable-candidate' -or $Manifest.PSObject.Properties.Name -contains 'status' -or $Manifest.provenance -cne 'build-report') { throw 'Remote installation requires a provenance-attested immutable candidate; legacy or relabeled manifests cannot be promoted.' }
    if ($authorization.schemaVersion -ne 1 -or $authorization.kind -cne 'polycode-distribution-authorization' -or $authorization.decision -cne 'AUTHORIZED' -or $authorization.scope -cne 'public-distribution' -or
        $authorization.parent.role -cne 'parent' -or [string]::IsNullOrWhiteSpace($authorization.parent.reviewer) -or $authorization.version -cne $Version -or
        $authorization.candidateSha256 -cne $CandidateHash -or $authorization.nativeSha256 -cne $Manifest.native.sha256 -or
        $authorization.checksumsSha256 -cne (Get-Sha256 (Join-Path $temp 'SHA256SUMS')) -or
        $authorization.readinessSha256 -cne (Get-Sha256 (Join-Path $temp 'release-readiness.json'))) { throw 'Missing, FAIL or stale release authorization; no installation is authorized.' }
    if ($ready.schemaVersion -ne 2 -or $ready.kind -cne 'polycode-readiness' -or $ready.policyVersion -cne $releasePolicyVersion -or $ready.status -cne 'PASS' -or @($ready.errors).Count -ne 0 -or
        $ready.publicationAuthorized -isnot [bool] -or $ready.publicationAuthorized -ne $false -or $ready.publicUrlGate -cne 'DEFERRED_UNTIL_PUBLICATION' -or
        $ready.candidateSha256 -cne $CandidateHash -or $ready.nativeSha256 -cne $Manifest.native.sha256 -or
        $ready.acceptanceSha256 -cnotmatch '^[a-f0-9]{64}$' -or $ready.parentAttestationSha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $authorization.acceptanceSha256 -cne $ready.acceptanceSha256 -or $authorization.parentAttestationSha256 -cne $ready.parentAttestationSha256) { throw 'Missing, FAIL or stale acceptance readiness in release authorization.' }
    $seenGates = @{}
    if (@($ready.gates).Count -ne $requiredReleaseGates.Count) { throw 'Incomplete required release acceptance gates.' }
    foreach ($gate in $ready.gates) {
        if ($requiredReleaseGates -cnotcontains $gate.id -or $seenGates.ContainsKey($gate.id) -or $gate.status -cne 'PASS' -or $gate.verified -isnot [bool] -or $gate.verified -ne $true) { throw 'Missing, FAIL or duplicate required release acceptance gate.' }
        $seenGates[$gate.id] = $true
    }
    $profile = $Manifest.native.profile
    if (@('2', '3', 's', 'z') -cnotcontains [string]$profile.opt_level -or $profile.debug_assertions -isnot [bool] -or $profile.debug_assertions -ne $false -or $profile.test -isnot [bool] -or $profile.test -ne $false -or $Manifest.native.transformed -isnot [bool] -or $Manifest.native.transformed -ne $false) { throw 'Development or transformed binary is not authorized for remote release installation.' }
    $checkedAt = [DateTimeOffset]::Parse($ready.checkedAt, [Globalization.CultureInfo]::InvariantCulture)
    $authorizedAt = [DateTimeOffset]::Parse($authorization.parent.authorizedAt, [Globalization.CultureInfo]::InvariantCulture)
    if ($checkedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $authorizedAt -gt [DateTimeOffset]::UtcNow.AddMinutes(1) -or $authorizedAt -lt $checkedAt -or $authorizedAt -gt $checkedAt.AddDays(7)) { throw 'Stale or invalid release authorization timeline.' }
    # Authorization must be timely at promotion; an already authorized immutable
    # release does not expire seven days after publication.
    $expectedAssets = @('install.ps1', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip', 'polycode-wsl-x64.gz')
    $seenAssets = @{}
    if (@($Manifest.artifacts).Count -ne $expectedAssets.Count) { throw 'Incomplete authorized asset inventory.' }
    foreach ($asset in $Manifest.artifacts) {
        if ($expectedAssets -cnotcontains $asset.path -or $seenAssets.ContainsKey($asset.path)) { throw 'Unsafe or duplicate authorized asset path.' }
        $seenAssets[$asset.path] = $true
        $file = Join-Path $temp $asset.path
        if ($asset.sha256 -cne (Get-Sha256 $file) -or $asset.bytes -ne (Get-Item -LiteralPath $file).Length) { throw 'Authorized asset bytes changed; repacking is forbidden.' }
    }
    if (-not $PSCommandPath -or (Get-Sha256 $PSCommandPath) -cne (Get-Sha256 (Join-Path $temp 'install.ps1'))) { throw 'Run the exact accepted install.ps1 file, not an inline or modified installer.' }
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
    if (-not $ArtifactDirectory) {
        # Same version-specific trusted publisher origin as the assets. These are
        # separate metadata, never inserted into ZIP/SHA256SUMS after acceptance.
        foreach ($sidecar in @('release-readiness.json', 'release-authorization.json')) {
            Invoke-WebRequest -UseBasicParsing "$base/$sidecar" -OutFile (Join-Path $temp $sidecar)
        }
    }
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
    $outer = Get-Content -LiteralPath (Join-Path $temp 'manifest.json') -Raw | ConvertFrom-Json
    $immutable = $manifest.schemaVersion -eq 2 -and $manifest.classification -ceq 'immutable-candidate' -and $manifest.PSObject.Properties.Name -notcontains 'status'
    $legacyLocal = $ArtifactDirectory -and $manifest.schemaVersion -eq 1 -and $manifest.status -ceq 'unpublished-candidate'
    if (-not $immutable -and -not $legacyLocal) { throw 'Unknown or relabeled candidate classification.' }
    if ($outer.schemaVersion -ne $manifest.schemaVersion -or $outer.classification -cne $manifest.classification -or $outer.status -cne $manifest.status -or $outer.native.sha256 -cne $manifest.native.sha256 -or $outer.bun.sha256 -cne $manifest.bun.sha256) { throw 'Candidate manifest identity mismatch.' }
    if ($ArtifactDirectory) {
        if (-not $AllowCandidate) { throw 'Local candidate requires explicit -AllowCandidate. Sidecars cannot bypass local opt-in; no release/live acceptance is implied.' }
        Write-Warning 'LOCAL CANDIDATE PREFLIGHT: publication and OAuth/live acceptance are not implied.'
    } else {
        Assert-DistributionAuthorization $outer (Get-Sha256 (Join-Path $temp 'manifest.json'))
    }
    $runtimeFiles = @(Get-ChildItem -LiteralPath $runtimeStage -Recurse -File)
    if ($runtimeFiles.Count -ne @($outer.files).Count) { throw 'Runtime file inventory mismatch.' }
    $inventorySeen = @{}
    foreach ($file in $outer.files) {
        if ($file.path -notmatch '^[A-Za-z0-9_./@-]+$' -or $file.path -match '(^|/)(\.|\.\.)(/|$)' -or $file.path.StartsWith('/') -or $inventorySeen.ContainsKey($file.path)) { throw 'Unsafe or duplicate manifest file path.' }
        $inventorySeen[$file.path] = $true
        $actual = Join-Path $runtimeStage $file.path
        if (-not (Test-Path -LiteralPath $actual -PathType Leaf) -or (Get-Sha256 $actual) -ne $file.sha256 -or (Get-Item -LiteralPath $actual).Length -ne $file.bytes) { throw "Runtime file integrity mismatch: $($file.path)" }
    }
    Copy-Item -LiteralPath (Join-Path $temp 'manifest.json') -Destination (Join-Path $runtimeStage 'candidate-manifest.json')
    if (-not $ArtifactDirectory) {
        foreach ($sidecar in @('release-readiness.json', 'release-authorization.json')) {
            if (Test-Path -LiteralPath (Join-Path $runtimeStage $sidecar)) { throw 'Distribution metadata must not be embedded inside the accepted runtime ZIP.' }
            Copy-Item -LiteralPath (Join-Path $temp $sidecar) -Destination (Join-Path $runtimeStage $sidecar)
        }
    }
    # Never overwrite even the same version: both filesystems use a fresh release ID.
    Wsl @('mkdir', '-p', '--', $LinuxRoot) | Out-Null
    Wsl @('mkdir', '--', $binaryDir) | Out-Null
    $linuxCreated = $true
    foreach ($item in @(@{ name = 'polycode'; archive = $assets[0] }, @{ name = 'bun'; archive = $assets[1] })) {
        $file = Join-Path $temp $item.name
        Expand-Gzip (Join-Path $temp $item.archive) $file
        $expected = $(if ($item.name -eq 'polycode') { $manifest.native } else { $manifest.bun })
        if ($expected.sha256 -notmatch '^[a-f0-9]{64}$' -or (Get-Sha256 $file) -ne $expected.sha256 -or (Get-Item -LiteralPath $file).Length -ne $expected.bytes) { throw "Decompressed executable integrity mismatch: $($item.name)" }
        $header = [IO.File]::OpenRead($file)
        try { $magic = New-Object byte[] 20; if ($header.Read($magic, 0, 20) -ne 20 -or [BitConverter]::ToString($magic[0..5]) -ne '7F-45-4C-46-02-01' -or [BitConverter]::ToUInt16($magic, 18) -ne 62) { throw 'Executable must be x86_64 little-endian ELF.' } } finally { $header.Dispose() }
        Wsl @('install', '-m', '755', '--', (LinuxPath $file), "$binaryDir/$($item.name)") | Out-Null
    }
    $help = Wsl @('timeout', '30', "$binaryDir/polycode", '--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) {
        if (-not $help.Contains($flag)) { throw "Not a native Polycode binary: missing $flag. The old prototype cannot be installed as v0.2.0." }
    }
    if ((Wsl @('timeout', '30', "$binaryDir/bun", '--version')) -ne $manifest.bun.version) { throw 'Installed Bun version mismatch.' }
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
    if ($NoPath -and -not $StageOnly) { Write-Host "PATH unchanged. Launcher: $shim" }
    if ($StageOnly) { Write-Host "Direct staged entrypoint: $(Join-Path $release 'polycode.ps1')" }
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
