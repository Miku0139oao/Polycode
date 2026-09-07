<# Prepare UNPUBLISHED CANDIDATE assets locally. Never publishes, signs in or installs.
Preserves executable bytes/profile (no strip/rebuild). Missing build provenance is
explicitly fixture-only and can never satisfy the release-readiness guard.
Run npm ci --ignore-scripts in native-provider first. Binary must explicitly name
an already-built native executable; the old ACP prototype is rejected.
Output must not exist, so a failed/repeated build cannot corrupt a previous release.
#>
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [Parameter(Mandatory = $true)][string]$Runtime,
    [string]$BuildReport,
    [string]$Output = (Join-Path $env:TEMP ('polycode-candidate-' + [Guid]::NewGuid().ToString('N'))),
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version = 'v0.2.1'
)
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Output already exists; select a fresh directory. Existing artifacts are never overwritten.' }
$Binary = (Resolve-Path -LiteralPath $Binary).Path
$Runtime = (Resolve-Path -LiteralPath $Runtime).Path
$work = Join-Path (Split-Path $Output) ('.polycode-package-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'runtime'
$payload = Join-Path $work 'assets'
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
. (Join-Path $PSScriptRoot 'windows-process.ps1')
function Copy-Staged([string]$From, [string]$Relative) {
    $destination = Join-Path $stage $Relative
    New-Item -ItemType Directory -Force -Path (Split-Path $destination) | Out-Null
    Copy-Item -LiteralPath $From -Destination $destination
}
function Gzip([string]$InputPath, [string]$OutputPath) {
    $inputFile = [IO.File]::OpenRead($InputPath)
    try {
        $outputFile = [IO.File]::Create($OutputPath)
        try {
            $gzip = New-Object IO.Compression.GzipStream($outputFile, [IO.Compression.CompressionMode]::Compress)
            try { $inputFile.CopyTo($gzip) } finally { $gzip.Dispose() }
        } finally { $outputFile.Dispose() }
    } finally { $inputFile.Dispose() }
}
try {
    Assert-WindowsExecutable $Binary
    Assert-WindowsExecutable $Runtime
    $nativeHash = Get-Sha256 $Binary
    $bunHash = Get-Sha256 $Runtime
    $nativeBytes = (Get-Item -LiteralPath $Binary).Length
    $report = $null; $reportHash = $null
    if ($BuildReport) {
        $report = Get-Content -LiteralPath $BuildReport -Raw -Encoding UTF8 | ConvertFrom-Json
        $reportHash = Get-Sha256 $BuildReport
        if ($report.exit -ne 0 -or $report.timeout -ne $false -or $report.sha256 -ne $nativeHash -or $report.bytes -ne $nativeBytes -or $report.binary -ne $Binary -or
            $report.revision -notmatch '^[a-f0-9]{40}$' -or $null -eq $report.profile.opt_level -or $null -eq $report.profile.debug_assertions -or $report.profile.test -ne $false) { throw 'Build report does not attest these exact successful native executable bytes/profile.' }
    }
    $help = Invoke-Native $Binary @('--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) {
        if (-not $help.Contains($flag)) { throw "Not a native Polycode binary: missing $flag. Do not package the old prototype as v0.2.0." }
    }
    $bunVersion = Invoke-Native $Runtime @('--version')
    $bunRevision = Invoke-Native $Runtime @('--revision')
    if ($bunVersion -ne '1.3.14') { throw 'This candidate package is qualified for Bun 1.3.14 only.' }
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    foreach ($file in @('polycode.ps1', 'integrations\launch.ps1', 'integrations\windows-process.ps1', 'integrations\RELEASE_READINESS.md', 'LICENSE', 'THIRD-PARTY-NOTICES')) { Copy-Staged (Join-Path $source $file) $file }
    $provider = Join-Path $PSScriptRoot 'native-provider'
    $bundle = Join-Path $stage 'integrations\native-provider\launch.mjs'
    New-Item -ItemType Directory -Force -Path (Split-Path $bundle) | Out-Null
    Invoke-Native $Runtime @('build', (Join-Path $provider 'launch.mjs'), '--target=bun', '--outfile', $bundle) | Out-Null
    Invoke-Native $Runtime @('-e', 'const entry=process.argv[1]; process.argv[1]="polycode-package-check"; await import(entry)', $bundle) | Out-Null
    # Keep upstream licenses and provenance; never flatten names that may collide.
    foreach ($file in @('LICENSE.reference', 'PROVENANCE.md', 'package.json')) { Copy-Staged (Join-Path $provider ('cursor\' + $file)) ('third-party\cursor\' + $file) }
    Copy-Staged (Join-Path $provider 'BUN-LICENSE.md') 'third-party\BUN-LICENSE.md'
    Copy-Staged (Join-Path $provider 'package-lock.json') 'third-party\package-lock.json'
    # Windows PowerShell 5.1 cannot ConvertFrom-Json npm's empty root package key.
    $lockPackages = Invoke-Native $Runtime @('-e', 'const lock=await Bun.file(process.argv[1]).json(); console.log(JSON.stringify(Object.entries(lock.packages).filter(([Name])=>Name).map(([Name,Value])=>({Name,Value}))))', (Join-Path $provider 'package-lock.json')) | ConvertFrom-Json
    $dependencies = @()
    foreach ($property in $lockPackages) {
        if (-not $property.Name.StartsWith('node_modules/') -or $property.Name -match '(^|/)\.\.(/|$)') { throw 'Unsafe dependency lock path.' }
        $module = Join-Path $provider $property.Name
        $package = Get-Content -LiteralPath (Join-Path $module 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($package.version -ne $property.Value.version) { throw 'Installed dependencies differ from lockfile. Run npm ci --ignore-scripts.' }
        $licenses = @(Get-ChildItem -LiteralPath $module -File | Where-Object { $_.Name -match '^(licen[cs]e|copying|notice)(\.|$)' })
        if (-not $licenses.Count) { throw "Missing dependency license: $($package.name)" }
        $relative = 'third-party\npm\' + $property.Name.Substring('node_modules/'.Length)
        foreach ($file in $licenses) { Copy-Staged $file.FullName (Join-Path $relative $file.Name) }
        Copy-Staged (Join-Path $module 'package.json') (Join-Path $relative 'package.json')
        $dependencies += @{ name = $package.name; version = $package.version; license = $package.license }
    }
    if (-not $dependencies.Count) { throw 'Dependency inventory is empty.' }
    @{ dependencies = $dependencies; bun = @{ version = $bunVersion; revision = $bunRevision; licenseSource = 'https://github.com/oven-sh/bun/blob/main/LICENSE.md' } } | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $stage 'third-party\dependencies.json') -Encoding UTF8
    # Copy, never strip: acceptance must refer to the bytes that are installed.
    $nativeCopy = Join-Path $work 'polycode.exe'; $bun = Join-Path $work 'bun.exe'
    Copy-Item -LiteralPath $Binary -Destination $nativeCopy
    Copy-Item -LiteralPath $Runtime -Destination $bun
    if ((Get-Sha256 $nativeCopy) -ne $nativeHash -or (Get-Sha256 $bun) -ne $bunHash) { throw 'Executable changed during packaging.' }
    if ($BuildReport) { Copy-Staged $BuildReport 'provenance/build-report.json' }
    $manifest = [ordered]@{
        # Classification is immutable, not a publication state. Authorization is
        # a separate sidecar added ONLY by the parent after acceptance.
        schemaVersion = 3; classification = 'immutable-candidate'; version = $Version
        provenance = $(if ($BuildReport) { 'build-report' } else { 'fixture-unattested' })
        architecture = 'x86_64'; platform = 'windows'; target = 'x86_64-pc-windows-msvc'; executableFormat = 'PE32+'; protocol = 'native-model-bridge'
        binarySourceSha256 = $nativeHash
        native = @{ sha256 = $nativeHash; bytes = $nativeBytes; format = 'PE32+'; revision = $report.revision; profile = $report.profile; buildReportSha256 = $reportHash; transformed = $false }
        bun = @{ sha256 = $bunHash; bytes = (Get-Item -LiteralPath $bun).Length; version = $bunVersion; revision = $bunRevision; format = 'PE32+' }
        packagingScriptSha256 = (Get-Sha256 $PSCommandPath)
        acceptance = @{
            oauthChatGPT = 'NOT_ACCEPTED'
            oauthCursor = 'NOT_ACCEPTED'
            liveGates = 'NOT_ACCEPTED'; installedIntegrated = 'NOT_ACCEPTED'
            publicationAuthorized = $false; publicUrl = 'DEFERRED_UNTIL_PUBLICATION'
            pendingSourceChanges = 'Live Cursor OAuth, paid billing observer, real Task/resume and official publication remain open'
        }
    }
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding UTF8
    # .NET avoids Compress-Archive 5.1 wildcard bugs for literal [bracket] paths.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, (Join-Path $payload 'polycode-runtime.zip'))
    $copiedHelp = Invoke-Native $nativeCopy @('--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) { if (-not $copiedHelp.Contains($flag)) { throw 'Packaged native binary failed validation.' } }
    Gzip $nativeCopy (Join-Path $payload 'polycode-windows-x64.gz')
    Gzip $bun (Join-Path $payload 'polycode-bun-windows-x64.gz')
    Copy-Item -LiteralPath (Join-Path $source 'install.ps1') -Destination (Join-Path $payload 'install.ps1')
    $manifest.files = @(Get-ChildItem -LiteralPath $stage -Recurse -File | Sort-Object FullName | ForEach-Object {
        @{ path = $_.FullName.Substring($stage.Length + 1).Replace('\', '/'); sha256 = (Get-Sha256 $_.FullName); bytes = $_.Length }
    })
    $assetNames = @('polycode-windows-x64.gz', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'install.ps1')
    $manifest.artifacts = @($assetNames | ForEach-Object { @{ path = $_; sha256 = (Get-Sha256 (Join-Path $payload $_)); bytes = (Get-Item -LiteralPath (Join-Path $payload $_)).Length } })
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath (Join-Path $payload 'manifest.json') -Encoding UTF8
    $sums = foreach ($asset in $assetNames + @('manifest.json')) { (Get-Sha256 (Join-Path $payload $asset)) + '  ' + $asset }
    $sums | Set-Content -LiteralPath (Join-Path $payload 'SHA256SUMS') -Encoding ASCII
    [IO.Directory]::Move($payload, $Output)
    Write-Output "UNPUBLISHED CANDIDATE prepared in $Output; executable profile preserved, NOT release-optimized by this script. Readiness guard and parent authorization still required."
    Remove-InstallTree $work (Split-Path $Output)
} catch {
    if (Test-Path -LiteralPath $work) { $_ | Out-String | Set-Content -LiteralPath (Join-Path $work 'failure.txt') -Encoding UTF8; Write-Warning "Packaging failed; diagnostics retained at $work" }
    throw
}
