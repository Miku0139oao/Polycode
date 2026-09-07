<# Windows x64 per-user installer. No WSL or developer runtime required.
Candidate installation is not live acceptance or official-release authorization.
-NoPath preserves PATH; -StageOnly leaves the active launcher unchanged.
#>
param(
    [ValidatePattern('^v[0-9]+\.[0-9]+\.[0-9]+$')][string]$Version = 'v0.2.1',
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Polycode'),
    [string]$ArtifactDirectory,
    [switch]$AllowCandidate,
    [switch]$GitHubCandidate,
    [switch]$NoPath,
    [switch]$StageOnly
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem
$assets = @('polycode-windows-x64.gz', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'manifest.json', 'install.ps1')
# One-key local install: running the accepted install.ps1 from a complete
# candidate folder does not require repeating -ArtifactDirectory.
if (-not $ArtifactDirectory -and $PSCommandPath) {
    $here = [IO.Path]::GetFullPath((Split-Path -Parent $PSCommandPath))
    $complete = $true
    foreach ($name in @('SHA256SUMS') + $assets) {
        if (-not (Test-Path -LiteralPath (Join-Path $here $name) -PathType Leaf)) { $complete = $false; break }
    }
    if ($complete) { $ArtifactDirectory = $here }
}
# Enable the hosted one-liner only after acceptance and public download checks.
# Local explicit candidate verification remains available while this is false.
$publicCandidateEnabled = $false
if (-not $PSCommandPath -and -not $ArtifactDirectory) {
    if (-not $publicCandidateEnabled) { throw 'Windows native acceptance is pending. Public one-command installation is not enabled. Use an isolated local candidate for development verification.' }
    $GitHubCandidate = $true
}
if ($GitHubCandidate -and $ArtifactDirectory) {
    throw 'This installer is already next to local candidate files. Omit -GitHubCandidate and pass -AllowCandidate.'
}
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
$releaseCreated = $false
$activated = $false; $pathTouched = $false; $committed = $false
$oldProcessPath = $env:Path
$oldUserPath = [Environment]::GetEnvironmentVariable('Path', 'User')
function Get-Sha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path); $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
# PS7 Invoke-WebRequest uses HTTP/2 against GitHub's CDN and often dies with
# "unexpected EOF or 0 bytes from the transport stream" on the 70MB+ native gzip.
# Tests stub Invoke-WebRequest as a Function; keep that path for local copies.
function Get-ReleaseFile([string]$Uri, [string]$OutFile) {
    $iwr = Get-Command Invoke-WebRequest
    if ($iwr.CommandType -eq 'Function') {
        Invoke-WebRequest -Uri $Uri -OutFile $OutFile -UseBasicParsing
        return
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        $attempt = 0
        while ($attempt -lt 4) {
            $attempt++
            if (Test-Path -LiteralPath $OutFile) { Remove-Item -LiteralPath $OutFile -Force }
            & curl.exe --location --fail --retry 3 --retry-delay 2 --output $OutFile -- $Uri
            if ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath $OutFile) -and (Get-Item -LiteralPath $OutFile).Length -gt 0) { return }
            Start-Sleep -Seconds (2 * $attempt)
        }
        throw "Failed to download $Uri"
    }
    $params = @{ Uri = $Uri; OutFile = $OutFile; UseBasicParsing = $true }
    if ($iwr.Parameters.ContainsKey('HttpVersion')) { $params.HttpVersion = '1.1' }
    Invoke-WebRequest @params
}
# Do not coerce untrusted JSON values or pipe them through an enumerating helper.
# PowerShell comparisons FILTER a collection on the left; [] can otherwise make
# a rejection condition false, and ["PASS"] can masquerade as a scalar.
function Assert-JsonObject($Value, [string]$Name) {
    if ($Value -isnot [PSCustomObject]) { throw "Invalid JSON shape: $Name must be an object." }
}
function Assert-JsonArray($Value, [string]$Name) {
    if ($Value -isnot [array]) { throw "Invalid JSON shape: $Name must be an array." }
}
function Assert-JsonString($Value, [string]$Name) {
    if ($Value -isnot [string]) { throw "Invalid JSON shape: $Name must be a string." }
}
function Assert-JsonBoolean($Value, [string]$Name) {
    if ($Value -isnot [bool]) { throw "Invalid JSON shape: $Name must be a boolean." }
}
function Assert-JsonInteger($Value, [string]$Name, [long]$Minimum = 0, [long]$Maximum = [long]::MaxValue) {
    # ConvertFrom-Json uses Int32/Int64 for JSON integers on both PS5.1 and PS7.
    # Reject null, bool, strings, floating point, huge integers and collections
    # BEFORE numeric comparisons (no truncation or implicit numeric conversion).
    if ($Value -isnot [int] -and $Value -isnot [long]) { throw "Invalid JSON shape: $Name must be an integer." }
    if ($Value -lt $Minimum -or $Value -gt $Maximum) { throw "Invalid JSON shape: $Name is outside its integer range." }
}
function Assert-JsonHash($Value, [string]$Name) {
    Assert-JsonString $Value $Name
    if ($Value -cnotmatch '^[a-f0-9]{64}\z') { throw "Invalid JSON shape: $Name must be a lowercase SHA256 string." }
}
function Convert-JsonToken($Token, [ref]$Result) {
    # Used only for PS7 before -DateKind existed. Newtonsoft ships with PS7.
    # A ref result preserves [] / [one] / nested arrays without pipeline unroll.
    switch ($Token.get_Type().ToString()) {
        'Object' {
            $object = [ordered]@{}
            foreach ($property in $Token.Properties()) {
                if ($object.Contains($property.Name)) { throw 'Invalid JSON shape: duplicate object property.' }
                $value = $null; Convert-JsonToken $property.Value ([ref]$value)
                $object[$property.Name] = $value
            }
            $Result.Value = [PSCustomObject]$object
        }
        'Array' {
            $array = [object[]]::new($Token.Count)
            for ($i = 0; $i -lt $Token.Count; $i++) {
                $value = $null; Convert-JsonToken $Token[$i] ([ref]$value)
                $array[$i] = $value
            }
            $Result.Value = $array
        }
        { $_ -in @('String', 'Integer', 'Float', 'Boolean', 'Null') } { $Result.Value = $Token.Value }
        default { throw 'Invalid JSON shape: unsupported JSON token.' }
    }
}
function Convert-JsonWithoutDateCoercion([string]$Text) {
    $inputText = New-Object IO.StringReader($Text)
    $reader = New-Object Newtonsoft.Json.JsonTextReader($inputText)
    try {
        $reader.DateParseHandling = 'None'; $reader.MaxDepth = 128
        $token = [Newtonsoft.Json.Linq.JToken]::ReadFrom($reader)
        if ($reader.Read()) { throw 'Invalid JSON shape: trailing JSON content.' }
        $document = $null; Convert-JsonToken $token ([ref]$document)
        Assert-JsonObject $document 'document'
        return $document
    } finally { $reader.Close(); $inputText.Dispose() }
}
function Read-JsonObject([string]$Path) {
    $text = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
    # PS5.1 lacks -NoEnumerate: reject a root array BEFORE ConvertFrom-Json can
    # unwrap a singleton (or discard an empty array). Nested properties are kept
    # as-is and checked directly, never returned through an enumerating pipeline.
    if ($text -isnot [string] -or $text -cnotmatch '^\s*\{') { throw "Invalid JSON shape: $Path must contain a root object." }
    # PS7 otherwise turns ISO JSON strings into DateTime values. Keep the actual
    # serialized string type, including on PS7 versions predating -DateKind.
    if ((Get-Command ConvertFrom-Json).Parameters.ContainsKey('DateKind')) {
        $document = ConvertFrom-Json -InputObject $text -DateKind String
    } elseif ($PSVersionTable.PSVersion.Major -ge 7) {
        $document = Convert-JsonWithoutDateCoercion $text
    } else { $document = ConvertFrom-Json -InputObject $text }
    Assert-JsonObject $document $Path
    return $document
}
function Assert-CandidateManifest($Manifest, [bool]$Outer) {
    Assert-JsonObject $Manifest 'manifest'
    Assert-JsonInteger $Manifest.schemaVersion 'manifest.schemaVersion' 3 3
    foreach ($field in @('version', 'architecture', 'platform', 'target', 'executableFormat', 'protocol', 'provenance')) { Assert-JsonString $Manifest.$field "manifest.$field" }
    if ($Manifest.platform -cne 'windows' -or $Manifest.target -cne 'x86_64-pc-windows-msvc' -or $Manifest.architecture -cne 'x86_64' -or $Manifest.executableFormat -cne 'PE32+') { throw 'Invalid Windows manifest target.' }
    if ($Manifest.schemaVersion -eq 3) { Assert-JsonString $Manifest.classification 'manifest.classification' }
    else { Assert-JsonString $Manifest.status 'manifest.status' }
    foreach ($field in @('classification', 'status')) {
        if ($Manifest.PSObject.Properties.Name -contains $field) { Assert-JsonString $Manifest.$field "manifest.$field" }
    }
    foreach ($name in @('native', 'bun')) {
        $executable = $Manifest.$name
        Assert-JsonObject $executable "manifest.$name"
        Assert-JsonHash $executable.sha256 "manifest.$name.sha256"
        Assert-JsonInteger $executable.bytes "manifest.$name.bytes" 1
    }
    Assert-JsonString $Manifest.bun.version 'manifest.bun.version'
    Assert-JsonBoolean $Manifest.native.transformed 'manifest.native.transformed'
    # The packager deliberately emits profile:null for fixture-unattested local
    # preparation. Build-report candidates must have the actual profile object.
    if ($Manifest.provenance -ceq 'build-report' -or $null -ne $Manifest.native.profile) {
        $profile = $Manifest.native.profile
        Assert-JsonObject $profile 'manifest.native.profile'
        if ($profile.opt_level -is [string]) {
            if ($profile.opt_level -cnotmatch '^[0-3sz]\z') { throw 'Invalid JSON shape: manifest.native.profile.opt_level is not a Rust optimization level.' }
        } else { Assert-JsonInteger $profile.opt_level 'manifest.native.profile.opt_level' 0 3 }
        Assert-JsonBoolean $profile.debug_assertions 'manifest.native.profile.debug_assertions'
        Assert-JsonBoolean $profile.test 'manifest.native.profile.test'
    }
    if ($Outer) {
        foreach ($name in @('files', 'artifacts')) {
            Assert-JsonArray $Manifest.$name "manifest.$name"
            foreach ($entry in $Manifest.$name) {
                Assert-JsonObject $entry "manifest.$name entry"
                Assert-JsonString $entry.path "manifest.$name.path"
                Assert-JsonHash $entry.sha256 "manifest.$name.sha256"
                Assert-JsonInteger $entry.bytes "manifest.$name.bytes" 0
            }
        }
    }
}
function Assert-DistributionAuthorization($Manifest, [string]$CandidateHash) {
    $authorization = Read-JsonObject (Join-Path $temp 'release-authorization.json')
    $ready = Read-JsonObject (Join-Path $temp 'release-readiness.json')
    # Validate the entire consumed shape first, including nested objects/arrays;
    # only then perform authorization, readiness, gate or manifest comparisons.
    Assert-CandidateManifest $Manifest $true
    Assert-JsonInteger $authorization.schemaVersion 'authorization.schemaVersion' 1 2
    foreach ($field in @('kind', 'decision', 'scope', 'version')) { Assert-JsonString $authorization.$field "authorization.$field" }
    foreach ($field in @('candidateSha256', 'nativeSha256', 'checksumsSha256', 'readinessSha256', 'acceptanceSha256', 'parentAttestationSha256')) { Assert-JsonHash $authorization.$field "authorization.$field" }
    Assert-JsonObject $authorization.parent 'authorization.parent'
    foreach ($field in @('role', 'reviewer', 'authorizedAt')) { Assert-JsonString $authorization.parent.$field "authorization.parent.$field" }
    Assert-JsonInteger $ready.schemaVersion 'readiness.schemaVersion' 1 2
    foreach ($field in @('kind', 'policyVersion', 'status', 'publicUrlGate', 'checkedAt')) { Assert-JsonString $ready.$field "readiness.$field" }
    foreach ($field in @('candidateSha256', 'nativeSha256', 'acceptanceSha256', 'parentAttestationSha256')) { Assert-JsonHash $ready.$field "readiness.$field" }
    Assert-JsonBoolean $ready.publicationAuthorized 'readiness.publicationAuthorized'
    Assert-JsonArray $ready.errors 'readiness.errors'
    foreach ($message in $ready.errors) { Assert-JsonString $message 'readiness.errors entry' }
    Assert-JsonArray $ready.gates 'readiness.gates'
    foreach ($gate in $ready.gates) {
        Assert-JsonObject $gate 'readiness.gates entry'
        Assert-JsonString $gate.id 'readiness.gates.id'
        Assert-JsonString $gate.status 'readiness.gates.status'
        Assert-JsonBoolean $gate.verified 'readiness.gates.verified'
    }
    if ($Manifest.schemaVersion -ne 3 -or $Manifest.classification -cne 'immutable-candidate' -or $Manifest.PSObject.Properties.Name -contains 'status' -or $Manifest.provenance -cne 'build-report') { throw 'Remote installation requires a provenance-attested immutable candidate; legacy or relabeled manifests cannot be promoted.' }
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
    $expectedAssets = @('install.ps1', 'polycode-bun-windows-x64.gz', 'polycode-runtime.zip', 'polycode-windows-x64.gz')
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
# Shared Windows process/PE validation helpers. Embedded verbatim in install.ps1.
function Quote-Argument([string]$Value) {
    if ($Value -and $Value -notmatch '[\s"]') { return $Value }
    return '"' + ([regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1')) + '"'
}
function Invoke-Native([string]$Executable, [string[]]$Arguments, [int]$TimeoutSeconds = 30) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Executable
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.Arguments = ($Arguments | ForEach-Object { Quote-Argument $_ }) -join ' '
    $info.RedirectStandardOutput = $true; $info.RedirectStandardError = $true
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw 'Cannot start native executable.' }
        $stdout = $process.StandardOutput.ReadToEndAsync(); $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill(); $process.WaitForExit(); throw 'Native executable check timed out.'
        }
        if ($process.ExitCode -ne 0) { throw ('Native executable check failed (' + [IO.Path]::GetFileName($Executable) + '): exit ' + $process.ExitCode) }
        return $stdout.GetAwaiter().GetResult().TrimEnd([char]13, [char]10)
    } finally { $process.Dispose() }
}
function Assert-WindowsExecutable([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($stream.Length -lt 64 -or $reader.ReadUInt16() -ne 0x5A4D) { throw 'Executable must be x64 PE32+.' }
        $stream.Position = 60; $offset = $reader.ReadUInt32()
        if ($offset -lt 64 -or $offset -gt $stream.Length - 26) { throw 'Invalid PE header offset.' }
        $stream.Position = $offset
        if ($reader.ReadUInt32() -ne 0x4550 -or $reader.ReadUInt16() -ne 0x8664) { throw 'Executable must be x64 PE32+.' }
        $stream.Position = $offset + 24
        if ($reader.ReadUInt16() -ne 0x20B) { throw 'Executable must be x64 PE32+.' }
    } finally { $reader.Dispose(); $stream.Dispose() }
}
function Remove-InstallTree([string]$Path, [string]$Parent) {
    $resolved = [IO.Path]::GetFullPath($Path)
    $base = [IO.Path]::GetFullPath($Parent).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
    if (-not $resolved.StartsWith($base, [StringComparison]::OrdinalIgnoreCase)) { throw 'Cleanup path escaped installation staging.' }
    Remove-Item -LiteralPath $resolved -Recurse -Force
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
        foreach ($required in @('polycode.ps1', 'integrations/launch.ps1', 'integrations/windows-process.ps1', 'integrations/native-provider/launch.mjs', 'LICENSE', 'THIRD-PARTY-NOTICES', 'third-party/BUN-LICENSE.md', 'third-party/dependencies.json', 'release-manifest.json')) {
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
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') { throw 'This release supports Windows x64 only.' }
    if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 or Windows 11 is required.' }
    New-Item -ItemType Directory -Path $temp | Out-Null
    $base = "https://github.com/Miku0139oao/Polycode/releases/download/$Version"
    if (-not $ArtifactDirectory) {
        if (-not $GitHubCandidate) {
            # Same version-specific trusted publisher origin as the assets. These are
            # separate metadata, never inserted into ZIP/SHA256SUMS after acceptance.
            foreach ($sidecar in @('release-readiness.json', 'release-authorization.json')) {
                Get-ReleaseFile "$base/$sidecar" (Join-Path $temp $sidecar)
            }
        }
    }
    foreach ($asset in @('SHA256SUMS') + $assets) {
        $destination = Join-Path $temp $asset
        if ($ArtifactDirectory) { Copy-Item -LiteralPath (Join-Path $ArtifactDirectory $asset) -Destination $destination }
        else { Get-ReleaseFile "$base/$asset" $destination }
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
    $manifest = Read-JsonObject (Join-Path $runtimeStage 'release-manifest.json')
    $outer = Read-JsonObject (Join-Path $temp 'manifest.json')
    Assert-CandidateManifest $manifest $false
    Assert-CandidateManifest $outer $true
    if ($manifest.version -ne $Version -or $manifest.architecture -ne 'x86_64' -or $manifest.platform -cne 'windows' -or $manifest.target -cne 'x86_64-pc-windows-msvc' -or $manifest.executableFormat -cne 'PE32+' -or $manifest.protocol -ne 'native-model-bridge') { throw 'Runtime release manifest does not match the requested native release.' }
    $immutable = $manifest.schemaVersion -eq 3 -and $manifest.classification -ceq 'immutable-candidate' -and $manifest.PSObject.Properties.Name -notcontains 'status'
    if (-not $immutable) { throw 'Unknown or relabeled candidate classification.' }
    if ($outer.version -cne $manifest.version -or $outer.target -cne $manifest.target -or $outer.platform -cne $manifest.platform -or $outer.executableFormat -cne $manifest.executableFormat -or $outer.architecture -cne $manifest.architecture -or $outer.protocol -cne $manifest.protocol -or $outer.schemaVersion -ne $manifest.schemaVersion -or
        ($manifest.schemaVersion -eq 3 -and ($outer.classification -cne $manifest.classification -or $outer.PSObject.Properties.Name -contains 'status')) -or
        ($manifest.schemaVersion -eq 1 -and $outer.status -cne $manifest.status) -or
        $outer.native.sha256 -cne $manifest.native.sha256 -or $outer.bun.sha256 -cne $manifest.bun.sha256) { throw 'Candidate manifest identity mismatch.' }
    if ($ArtifactDirectory -or $GitHubCandidate) {
        if ($ArtifactDirectory -and -not $AllowCandidate) { throw 'Local candidate requires explicit -AllowCandidate. Sidecars cannot bypass local opt-in; no release/live acceptance is implied.' }
        Write-Warning 'UNPUBLISHED CANDIDATE PREFLIGHT: publication and OAuth/live acceptance are not implied.'
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
    if (-not $ArtifactDirectory -and -not $GitHubCandidate) {
        foreach ($sidecar in @('release-readiness.json', 'release-authorization.json')) {
            if (Test-Path -LiteralPath (Join-Path $runtimeStage $sidecar)) { throw 'Distribution metadata must not be embedded inside the accepted runtime ZIP.' }
            Copy-Item -LiteralPath (Join-Path $temp $sidecar) -Destination (Join-Path $runtimeStage $sidecar)
        }
    }
    # Executables live with the runtime in one versioned Windows directory.
    foreach ($item in @(@{ name = 'polycode.exe'; archive = $assets[0] }, @{ name = 'bun.exe'; archive = $assets[1] })) {
        $file = Join-Path $runtimeStage $item.name
        if (Test-Path -LiteralPath $file) { throw 'Executable must not be embedded in runtime ZIP.' }
        Expand-Gzip (Join-Path $temp $item.archive) $file
        $expected = $(if ($item.name -eq 'polycode.exe') { $manifest.native } else { $manifest.bun })
        if ((Get-Sha256 $file) -cne $expected.sha256 -or (Get-Item -LiteralPath $file).Length -ne $expected.bytes) { throw 'Decompressed executable integrity mismatch.' }
        Assert-WindowsExecutable $file
    }
    $help = Invoke-Native (Join-Path $runtimeStage 'polycode.exe') @('--help')
    foreach ($flag in @('--no-external-acp', '--polycode-native', '--polycode-provider')) {
        if (-not $help.Contains($flag)) { throw "Not a native Polycode binary: missing $flag." }
    }
    if ((Invoke-Native (Join-Path $runtimeStage 'bun.exe') @('--version')) -cne $manifest.bun.version) { throw 'Installed Bun version mismatch.' }
    Invoke-Native (Join-Path $runtimeStage 'bun.exe') @('-e', 'const entry=process.argv[1]; process.argv[1]="polycode-install-check"; await import(entry)', (Join-Path $runtimeStage 'integrations/native-provider/launch.mjs')) | Out-Null
    if (Test-Path -LiteralPath (Join-Path $runtimeStage 'install-config.json')) { throw 'Install config must not be embedded in runtime ZIP.' }
    @{ schemaVersion = 1; platform = 'windows'; binary = (Join-Path $release 'polycode.exe'); runtime = (Join-Path $release 'bun.exe'); version = $Version } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtimeStage 'install-config.json') -Encoding UTF8
    New-Item -ItemType Directory -Force -Path (Split-Path $release) | Out-Null
    New-Item -ItemType Directory -Path $release | Out-Null
    $releaseCreated = $true
    Get-ChildItem -LiteralPath $runtimeStage -Force | Copy-Item -Destination $release -Recurse -Force
    # Check the relocated, installed entrypoint before replacing any launcher.
    $entryHelp = Invoke-Native (Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe') @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $release 'polycode.ps1'), '-Project', $release, '--', '--help')
    if (-not $entryHelp.Contains('--polycode-native')) { throw 'Installed entrypoint check failed.' }

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
            if ($releaseCreated) { try { Remove-InstallTree $release $root } catch { Write-Warning "Could not remove failed release: $_" } }
        }
    }
    $cleanup = @($newShim, $temp)
    if ($committed -or $launcherRestored) { $cleanup += $backup }
    foreach ($file in $cleanup) {
        try { if (Test-Path -LiteralPath $file) { Remove-InstallTree $file $(if ($file -eq $temp) { [IO.Path]::GetTempPath() } else { $root }) } }
        catch { Write-Warning "Could not remove installer temporary path ${file}: $_" }
    }
}
