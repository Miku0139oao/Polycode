<# Build native v0.2.0 assets locally. Never publishes, signs in or installs.
Run npm ci --ignore-scripts in native-provider first. Binary must explicitly name
an already-built native executable; the old ACP prototype is rejected.
Output must not exist, so a failed/repeated build cannot corrupt a previous release.
#>
param(
    [Parameter(Mandatory = $true)][string]$Binary,
    [string]$Distro = 'archlinux',
    [string]$Runtime = '/usr/sbin/bun',
    [string]$Output = (Join-Path $env:TEMP 'polycode-release'),
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version = 'v0.2.0'
)
$ErrorActionPreference = 'Stop'
$source = Split-Path $PSScriptRoot
$Output = [IO.Path]::GetFullPath($Output)
if (Test-Path -LiteralPath $Output) { throw 'Output already exists; select a fresh directory. Existing artifacts are never overwritten.' }
foreach ($path in @($Binary, $Runtime)) { if (-not $path.StartsWith('/') -or $path -match '[\r\n]') { throw 'Binary and Runtime must be absolute WSL paths.' } }
$work = Join-Path (Split-Path $Output) ('.polycode-package-' + [Guid]::NewGuid().ToString('N'))
$stage = Join-Path $work 'runtime'
$payload = Join-Path $work 'assets'
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
    if (-not $converted.StartsWith('/') -or $converted -match '[\r\n]') { throw 'Invalid WSL path.' }
    return $converted
}
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
    if ((Wsl @('uname', '-m')) -ne 'x86_64') { throw 'Only x86_64 WSL release assets are supported.' }
    $help = Wsl @('timeout', '30', $Binary, '--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) {
        if (-not $help.Contains($flag)) { throw "Not a native Polycode binary: missing $flag. Do not package the old prototype as v0.2.0." }
    }
    $bunVersion = Wsl @('timeout', '30', $Runtime, '--version')
    $bunRevision = Wsl @('timeout', '30', $Runtime, '--revision')
    New-Item -ItemType Directory -Force -Path $payload | Out-Null
    foreach ($file in @('polycode.ps1', 'integrations\launch.ps1', 'LICENSE', 'THIRD-PARTY-NOTICES')) { Copy-Staged (Join-Path $source $file) $file }
    $provider = Join-Path $PSScriptRoot 'native-provider'
    $bundle = Join-Path $stage 'integrations\native-provider\launch.mjs'
    New-Item -ItemType Directory -Force -Path (Split-Path $bundle) | Out-Null
    Wsl @($Runtime, 'build', (LinuxPath (Join-Path $provider 'launch.mjs')), '--target=bun', '--outfile', (LinuxPath $bundle)) | Out-Null
    Wsl @('timeout', '30', $Runtime, '-e', 'const entry=process.argv[1]; process.argv[1]="polycode-package-check"; await import(entry)', (LinuxPath $bundle)) | Out-Null
    # Keep upstream licenses and provenance; never flatten names that may collide.
    foreach ($file in @('LICENSE.reference', 'PROVENANCE.md', 'package.json')) { Copy-Staged (Join-Path $provider ('cursor\' + $file)) ('third-party\cursor\' + $file) }
    Copy-Staged (Join-Path $provider 'BUN-LICENSE.md') 'third-party\BUN-LICENSE.md'
    Copy-Staged (Join-Path $provider 'package-lock.json') 'third-party\package-lock.json'
    # Windows PowerShell 5.1 cannot ConvertFrom-Json npm's empty root package key.
    $lockPackages = Wsl @($Runtime, '-e', 'const lock=await Bun.file(process.argv[1]).json(); console.log(JSON.stringify(Object.entries(lock.packages).filter(([Name])=>Name).map(([Name,Value])=>({Name,Value}))))', (LinuxPath (Join-Path $provider 'package-lock.json'))) | ConvertFrom-Json
    $dependencies = @()
    foreach ($property in $lockPackages) {
        if (-not $property.Name.StartsWith('node_modules/') -or $property.Name -match '(^|/)\.\.(/|$)') { throw 'Unsafe dependency lock path.' }
        $module = Join-Path $provider $property.Name
        $package = Get-Content -LiteralPath (Join-Path $module 'package.json') -Raw | ConvertFrom-Json
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
    @{ version = $Version; architecture = 'x86_64'; minimumGlibc = '2.43'; platform = 'WSL Linux'; protocol = 'native-model-bridge'; binarySourceSha256 = (Wsl @('sha256sum', '--', $Binary)).Split(' ')[0] } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'release-manifest.json') -Encoding UTF8
    # .NET avoids Compress-Archive 5.1 wildcard bugs for literal [bracket] paths.
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [IO.Compression.ZipFile]::CreateFromDirectory($stage, (Join-Path $payload 'polycode-runtime.zip'))
    $stripped = Join-Path $work 'polycode'
    Wsl @('strip', '-o', (LinuxPath $stripped), '--', $Binary) | Out-Null
    # Recheck the actual stripped artifact, not only the source executable.
    $strippedHelp = Wsl @('timeout', '30', (LinuxPath $stripped), '--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) { if (-not $strippedHelp.Contains($flag)) { throw 'Stripped native binary failed validation.' } }
    Gzip $stripped (Join-Path $payload 'polycode-wsl-x64.gz')
    $bun = Join-Path $work 'bun'
    Wsl @('cp', '--', $Runtime, (LinuxPath $bun)) | Out-Null
    Gzip $bun (Join-Path $payload 'polycode-bun-wsl-x64.gz')
    $sums = foreach ($asset in @('polycode-wsl-x64.gz', 'polycode-bun-wsl-x64.gz', 'polycode-runtime.zip')) { (Get-Sha256 (Join-Path $payload $asset)) + '  ' + $asset }
    $sums | Set-Content -LiteralPath (Join-Path $payload 'SHA256SUMS') -Encoding ASCII
    [IO.Directory]::Move($payload, $Output)
    Write-Output "Native release assets prepared in $Output (not published; TUI/provider acceptance remains required)."
} finally {
    if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
}
