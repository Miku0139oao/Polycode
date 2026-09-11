param(
    [string]$InstallRoot,
    [string]$Action,
    [string]$Channel,
    [switch]$NoPath,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
    $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
    throw 'Polycode requires Windows x64 and a 64-bit PowerShell session.'
}
if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 or newer is required.' }

$releaseBase = 'https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1'
$commitBase = 'https://raw.githubusercontent.com/Miku0139oao/Polycode/831e7375f88be4a346481c4b18d40cab8887f1d3'
$candidateRepo = 'Miku0139oao/Polycode'
$candidateRunId = '34525101732'
$candidateGitSha = 'ef6ec4a537d09cdf3ce692129afe22617a6baa55'
$candidateArtifact = 'polycode-windows-candidate'
$previewAssets = [ordered]@{
    'install.ps1' = @{ bytes = 34301; sha256 = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476'; uri = ($releaseBase + '/install.ps1') }
    'manifest.json' = @{ bytes = 6851; sha256 = '6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a'; uri = ($releaseBase + '/manifest.json') }
    'SHA256SUMS' = @{ bytes = 434; sha256 = '2cbc8617eeb3bf0b903a01bfada3f660d0357a952a4c501b9811fe077b229396'; uri = ($releaseBase + '/SHA256SUMS') }
    'polycode-windows-x64.gz' = @{ bytes = 59473371; sha256 = 'adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5'; uri = ($releaseBase + '/polycode-windows-x64.gz') }
    'polycode-bun-windows-x64.gz' = @{ bytes = 39647574; sha256 = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949'; uri = ($releaseBase + '/polycode-bun-windows-x64.gz') }
    'polycode-runtime.zip' = @{ bytes = 1961144; sha256 = '3b6e3ceb80907f1faf30720d47746399028e8c983a18db8e88539c1ba4d63814'; uri = ($releaseBase + '/polycode-runtime.zip') }
}
$stableAssets = [ordered]@{
    'install.ps1' = @{ bytes = 34301; sha256 = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476'; uri = ($releaseBase + '/install.ps1') }
    'manifest.json' = @{ bytes = 6851; sha256 = '11709e24c2f2d44eca53f2f2f06425a73670b4d807606543c9d50fb8fc4e291a'; uri = ($commitBase + '/manifest.json') }
    'SHA256SUMS' = @{ bytes = 434; sha256 = '45219a4f2a42655f582a5f8bd288d909ae2f1d47edbf416254ef74c083543895'; uri = ($commitBase + '/SHA256SUMS') }
    'polycode-windows-x64.gz' = @{ bytes = 59539339; sha256 = '536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a'; uri = ($commitBase + '/polycode-windows-x64.gz') }
    'polycode-bun-windows-x64.gz' = @{ bytes = 39647574; sha256 = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949'; uri = ($releaseBase + '/polycode-bun-windows-x64.gz') }
    'polycode-runtime.zip' = @{ bytes = 1961750; sha256 = 'ee8b18ca7be25d40bbff4463d40a3486c3c443cb73c3685191fd569b38eca86b'; uri = ($commitBase + '/polycode-runtime.zip') }
}
$candidateAssets = [ordered]@{
    'install.ps1' = @{ bytes = 34301; sha256 = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476' }
    'manifest.json' = @{ bytes = 6851; sha256 = '6140b133d41d27b76ecd25996393314d93e0a8169648b61ab141f987327477a5' }
    'SHA256SUMS' = @{ bytes = 434; sha256 = 'be12ff9e7e84e57e7ba895bafa725c790723bc372bc5f18d241fd2fae3a198a1' }
    'polycode-windows-x64.gz' = @{ bytes = 59545863; sha256 = 'edaf839aeacc0270ba06bfa367b8a556ca231393fda7056b886383ea9269c9e1' }
    'polycode-bun-windows-x64.gz' = @{ bytes = 39647574; sha256 = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949' }
    'polycode-runtime.zip' = @{ bytes = 1964001; sha256 = 'c5c3a612351a489fe126c0baf3c6ee0d8ddfcba5fbda47beb142ad3fdb218002' }
}

function Assert-ChannelAsset([string]$Path, [long]$Bytes, [string]$Sha256) {
    $stream = [IO.File]::OpenRead($Path)
    try {
        if ($stream.Length -ne $Bytes) { throw ('Unexpected file size: ' + [IO.Path]::GetFileName($Path)) }
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        if ($actual -cne $Sha256) { throw ('SHA256 mismatch: ' + [IO.Path]::GetFileName($Path)) }
    } finally { $stream.Dispose() }
}

function Read-MenuChoice([string]$Title, [string[]]$Labels) {
    Write-Host ''
    Write-Host $Title
    for ($i = 0; $i -lt $Labels.Count; $i++) {
        Write-Host ('  [{0}] {1}' -f ($i + 1), $Labels[$i])
    }
    while ($true) {
        $raw = Read-Host '請輸入數字'
        if ($raw -match '^(q|quit|cancel|取消)$') { throw 'Installation cancelled.' }
        $n = 0
        if ([int]::TryParse($raw, [ref]$n) -and $n -ge 1 -and $n -le $Labels.Count) { return $n }
        Write-Host '無效選項，請再選一次。'
    }
}

function Resolve-InstallAction([string]$Value) {
    switch -Regex ($Value.Trim()) {
        '^(install|安裝)$' { return 'Install' }
        '^(update|更新)$' { return 'Update' }
        '^(overwrite|replace|覆蓋|覆蓋安裝)$' { return 'Overwrite' }
        '^(switch|activate|切換|啟用)$' { return 'Switch' }
        '^(list|ls|列出|清單)$' { return 'List' }
        '^(uninstall|remove|卸載|移除)$' { return 'Uninstall' }
        default { return $null }
    }
}

function Resolve-InstallChannel([string]$Value) {
    switch -Regex ($Value.Trim()) {
        '^(stable|穩定|穩定版)$' { return 'Stable' }
        '^(preview|預覽|預覽版)$' { return 'Preview' }
        '^(candidate|patch|修補|修補版|候選)$' { return 'Candidate' }
        default { return $null }
    }
}

function Get-DefaultChannelRoot([string]$Name) {
    $leaf = switch ($Name) {
        'Preview' { 'Polycode-Preview-v0.2.1' }
        'Stable' { 'Polycode-Mainline' }
        'Candidate' { 'Polycode-Candidate' }
        default { throw ('Unknown channel: ' + $Name) }
    }
    return [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA $leaf))
}

function Test-SamePath([string]$Left, [string]$Right) {
    $left = $Left.TrimEnd('\', '/')
    $right = $Right.TrimEnd('\', '/')
    if ($left -ieq $right) { return $true }
    if (-not $left -or -not $right) { return $false }
    # PATH entries may use 8.3 short names (RUNNER~1) or unnormalized spellings; compare the resolved paths too.
    try { return ([IO.Path]::GetFullPath($left).TrimEnd('\', '/') -ieq [IO.Path]::GetFullPath($right).TrimEnd('\', '/')) } catch { return $false }
}

function Get-UserPathValue {
    return [string][Environment]::GetEnvironmentVariable('Path', 'User')
}

function Set-UserPathValue([string]$Value) {
    [Environment]::SetEnvironmentVariable('Path', $Value, 'User')
}

function Get-ChannelAssets([string]$Name) {
    switch ($Name) {
        'Preview' { return $previewAssets }
        'Stable' { return $stableAssets }
        'Candidate' { return $candidateAssets }
        default { throw ('Unknown channel: ' + $Name) }
    }
}

function Assert-CandidateTools {
    if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
        throw 'Candidate channel requires authenticated GitHub CLI (gh) to download the unpublished Actions artifact.'
    }
}

function Save-ChannelState([string]$Root, [string]$Name) {
    $state = [ordered]@{
        schemaVersion = 1
        channel = $Name
        version = 'v0.2.1'
        managedBy = 'install-mainline.ps1'
    }
    if ($Name -eq 'Preview') { $state.source = 'release-v0.2.1'; $state.gitSha = '39b25f39df9b1b7341ba7957c0ea54167ea80af8' }
    elseif ($Name -eq 'Stable') { $state.source = 'ci-mainline'; $state.runId = '34380813272'; $state.gitSha = 'bcc4eaf5da43b8920a1579b85abab07ded60fcdf' }
    else { $state.source = 'ci-candidate'; $state.runId = '34525101732'; $state.gitSha = 'ef6ec4a537d09cdf3ce692129afe22617a6baa55'; $state.artifact = 'polycode-windows-candidate' }
    $json = ($state | ConvertTo-Json)
    [IO.File]::WriteAllText((Join-Path $Root 'channel-state.json'), $json)
}

function Read-ChannelVersion([string]$Root) {
    $statePath = Join-Path $Root 'channel-state.json'
    if ([IO.File]::Exists($statePath)) {
        try {
            $state = Get-Content -LiteralPath $statePath -Raw -Encoding UTF8 | ConvertFrom-Json
            $sha = [string]$state.gitSha
            if ($sha.Length -gt 8) { $sha = $sha.Substring(0, 8) }
            $bits = @([string]$state.channel, [string]$state.version, $sha) | Where-Object { $_ }
            if ($bits) { return ($bits -join ' ') }
        } catch { }
    }
    $releases = Join-Path $Root 'releases'
    if ([IO.Directory]::Exists($releases)) {
        $latest = Get-ChildItem -LiteralPath $releases -Directory | Sort-Object LastWriteTime -Descending | Select-Object -First 1
        if ($latest) {
            foreach ($name in @('candidate-manifest.json', 'release-manifest.json')) {
                $manifestPath = Join-Path $latest.FullName $name
                if (-not [IO.File]::Exists($manifestPath)) { continue }
                try {
                    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
                    $rev = [string]$manifest.native.revision
                    if ($rev.Length -gt 8) { $rev = $rev.Substring(0, 8) }
                    return (@([string]$manifest.version, $rev) | Where-Object { $_ }) -join ' '
                } catch { }
            }
            return $latest.Name
        }
    }
    if ([IO.File]::Exists((Join-Path $Root 'bin\polycode.cmd'))) { return 'installed' }
    return $null
}

function Get-ActivePolycodeLauncher {
    foreach ($part in @($env:Path -split ';')) {
        $entry = $part.Trim()
        if (-not $entry) { continue }
        $launcher = Join-Path $entry.TrimEnd('\', '/') 'polycode.cmd'
        if ([IO.File]::Exists($launcher)) { return [IO.Path]::GetFullPath($launcher) }
    }
    foreach ($part in @((Get-UserPathValue) -split ';')) {
        $entry = $part.Trim()
        if (-not $entry) { continue }
        $launcher = Join-Path $entry.TrimEnd('\', '/') 'polycode.cmd'
        if ([IO.File]::Exists($launcher)) { return [IO.Path]::GetFullPath($launcher) }
    }
    return $null
}

function Get-PolycodeInventory {
    $rows = New-Object System.Collections.Generic.List[object]
    $production = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
    $known = [ordered]@{
        Preview = Get-DefaultChannelRoot 'Preview'
        Stable = Get-DefaultChannelRoot 'Stable'
        Candidate = Get-DefaultChannelRoot 'Candidate'
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    foreach ($name in $known.Keys) {
        $root = $known[$name]
        [void]$seen.Add($root.TrimEnd('\', '/'))
        $version = Read-ChannelVersion $root
        $rows.Add([pscustomobject]@{
            Channel = $name
            Root = $root
            Installed = [bool]$version
            Version = $(if ($version) { $version } else { 'not installed' })
            Managed = $true
        }) | Out-Null
    }
    if ([IO.Directory]::Exists($production)) {
        [void]$seen.Add($production.TrimEnd('\', '/'))
        $rows.Add([pscustomobject]@{
            Channel = 'Production'
            Root = $production
            Installed = $true
            Version = 'not managed by this script'
            Managed = $false
        }) | Out-Null
    }
    $local = $env:LOCALAPPDATA
    if ($local -and [IO.Directory]::Exists($local)) {
        foreach ($dir in @(Get-ChildItem -LiteralPath $local -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -like 'Polycode*' })) {
            $full = [IO.Path]::GetFullPath($dir.FullName)
            if ($seen.Contains($full.TrimEnd('\', '/'))) { continue }
            $version = Read-ChannelVersion $full
            if (-not $version) { continue }
            $rows.Add([pscustomobject]@{
                Channel = $dir.Name
                Root = $full
                Installed = $true
                Version = $version
                Managed = $false
            }) | Out-Null
        }
    }
    return $rows
}

function Write-PolycodeInventory {
    Write-Host 'Polycode versions on this machine'
    foreach ($row in @(Get-PolycodeInventory)) {
        $mark = if ($row.Installed) { 'installed' } else { 'absent   ' }
        Write-Host ('  {0,-12} {1}  {2}  {3}' -f $row.Channel, $mark, $row.Version, $row.Root)
    }
    $active = Get-ActivePolycodeLauncher
    Write-Host ('Active PATH launcher: ' + $(if ($active) { $active } else { '(none)' }))
}

function Set-PolycodePathOverwrite([string]$Bin) {
    $binFull = [IO.Path]::GetFullPath($Bin).TrimEnd('\', '/')
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($part in @((Get-UserPathValue) -split ';')) {
        $entry = $part.Trim()
        if (-not $entry) { continue }
        if (Test-SamePath $entry $binFull) { continue }
        $launcher = Join-Path $entry.TrimEnd('\', '/') 'polycode.cmd'
        if ([IO.File]::Exists($launcher)) { continue }
        $kept.Add($entry) | Out-Null
    }
    $next = (@($binFull) + $kept)
    Set-UserPathValue ($next -join ';')
    $processKept = @($env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object {
        $_ -and -not (Test-SamePath $_ $binFull) -and -not [IO.File]::Exists((Join-Path $_.TrimEnd('\', '/') 'polycode.cmd'))
    })
    $env:Path = (@($binFull) + $processKept) -join ';'
}

function Remove-PolycodePathEntry([string]$Bin) {
    $binFull = [IO.Path]::GetFullPath($Bin).TrimEnd('\', '/')
    $kept = New-Object System.Collections.Generic.List[string]
    $removed = $false
    foreach ($part in @((Get-UserPathValue) -split ';')) {
        $entry = $part.Trim()
        if (-not $entry) { continue }
        if (Test-SamePath $entry $binFull) { $removed = $true; continue }
        $kept.Add($entry) | Out-Null
    }
    # Leave the user's PATH bytes untouched when this launcher was never on it.
    if ($removed) { Set-UserPathValue ($kept -join ';') }
    $env:Path = (@($env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object {
        $_ -and -not (Test-SamePath $_ $binFull)
    }) -join ';')
}

function Uninstall-PolycodeChannel([string]$Root, [string]$Name) {
    $production = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
    if (Test-SamePath $Root $production) { throw 'Refusing to uninstall the default production installation.' }
    Remove-PolycodePathEntry (Join-Path $Root 'bin')
    if ([IO.Directory]::Exists($Root)) {
        Remove-Item -LiteralPath $Root -Recurse -Force
        if ([IO.Directory]::Exists($Root)) { throw ('Failed to remove ' + $Root) }
    }
    Write-Host ("Polycode {0} uninstalled. Other channels were left on disk." -f $Name.ToLowerInvariant())
}

$selectedAction = Resolve-InstallAction $(if ($Action) { $Action } else { '' })
$selectedChannel = Resolve-InstallChannel $(if ($Channel) { $Channel } else { '' })
$channelOptional = $selectedAction -eq 'List'
if ((-not $selectedAction -or (-not $selectedChannel -and -not $channelOptional))) {
    $canPrompt = $false
    try { $canPrompt = [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected } catch { $canPrompt = $false }
    if (-not $canPrompt) { throw 'Specify -Action Install|Update|Overwrite|Switch|List|Uninstall and -Channel Stable|Preview|Candidate (Channel optional for List).' }
    Write-Host 'Polycode Windows 安裝'
    Write-Host '官方穩定版尚未通過完整驗收。Candidate 含 ChatGPT/Cursor 修補，但不是已發布穩定版。'
    if (-not $selectedAction) {
        $pick = Read-MenuChoice '你要做什麼？' @(
            '安裝 — 寫入這個頻道自己的目錄',
            '更新 — 同一個頻道原地更新',
            '覆蓋 — 安裝這個頻道，並讓 PATH 上的 polycode 指向它',
            '切換 — 不重裝，只把 PATH 指到已安裝的頻道',
            '列出 — 顯示已安裝頻道與目前 PATH',
            '卸載 — 刪除這個頻道的目錄，並從 PATH 拿掉'
        )
        $selectedAction = @('Install', 'Update', 'Overwrite', 'Switch', 'List', 'Uninstall')[$pick - 1]
    }
    if ($selectedAction -ne 'List' -and -not $selectedChannel) {
        $pick = Read-MenuChoice '哪一個頻道？' @(
            'Candidate — ChatGPT/Cursor 修補（CI 34525101732 / ef6ec4a5，未發布）',
            'Preview — v0.2.1（2026-09-08 已發布）',
            '穩定版 — 目前 Windows 建議包（CI mainline，不是完整驗收穩定版）'
        )
        $selectedChannel = @('Candidate', 'Preview', 'Stable')[$pick - 1]
    }
}

if ($selectedAction -eq 'List') {
    Write-PolycodeInventory
    return
}

$productionRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
$previewRoot = Get-DefaultChannelRoot 'Preview'
$stableRoot = Get-DefaultChannelRoot 'Stable'
$candidateRoot = Get-DefaultChannelRoot 'Candidate'
$channelRoot = Get-DefaultChannelRoot $selectedChannel
$Root = if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } else { $channelRoot }
if ($Root -match '[;\r\n]') { throw 'InstallRoot cannot contain semicolons or newlines.' }
if (Test-SamePath $Root $productionRoot) {
    throw 'Choose a separate directory, not the default production installation.'
}
if ($selectedChannel -ne 'Preview' -and (Test-SamePath $Root $previewRoot)) {
    throw ($selectedChannel + ' cannot install into the v0.2.1 Preview directory.')
}
if ($selectedChannel -eq 'Preview' -and (Test-SamePath $Root $stableRoot)) {
    throw 'Preview cannot install into the mainline directory.'
}
if ($selectedChannel -eq 'Preview' -and (Test-SamePath $Root $candidateRoot)) {
    throw 'Preview cannot install into the candidate directory.'
}
if ($selectedChannel -eq 'Stable' -and (Test-SamePath $Root $candidateRoot)) {
    throw 'Stable/mainline cannot install into the candidate directory.'
}
if ($selectedChannel -eq 'Candidate' -and (Test-SamePath $Root $stableRoot)) {
    throw 'Candidate cannot install into the mainline directory.'
}

$launcher = Join-Path $Root 'bin\polycode.cmd'
$IncludePath = -not $NoPath
if (($selectedAction -eq 'Overwrite' -or $selectedAction -eq 'Switch') -and -not $IncludePath) {
    throw 'Overwrite requires PATH changes; omit -NoPath.'
}

if ($selectedAction -eq 'Switch') {
    if (-not [IO.File]::Exists($launcher)) { throw ('Channel is not installed: ' + $selectedChannel) }
    Set-PolycodePathOverwrite (Join-Path $Root 'bin')
    Write-Host ("Polycode {0} is now first on user PATH. Open a new terminal." -f $selectedChannel.ToLowerInvariant())
    Write-Host ("& '" + $launcher.Replace("'", "''") + "' -Project (Get-Location).Path -AuthDirectory '" + (Join-Path $Root 'auth').Replace("'", "''") + "'")
    return
}

if ($selectedAction -eq 'Uninstall') {
    $canPrompt = $false
    try { $canPrompt = [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected } catch { $canPrompt = $false }
    if ($canPrompt -and -not $Force) {
        $pick = Read-MenuChoice ('確定卸載 ' + $selectedChannel + '？會刪除該目錄（含 auth），其他頻道保留。') @(
            '取消',
            '確定卸載'
        )
        if ($pick -ne 2) { throw 'Uninstall cancelled.' }
    }
    Uninstall-PolycodeChannel $Root $selectedChannel
    return
}

$assets = Get-ChannelAssets $selectedChannel
$version = 'v0.2.1'
if ($selectedAction -eq 'Update' -and -not [IO.File]::Exists($launcher)) {
    Write-Warning '這個頻道還沒安裝，改為安裝。'
    $selectedAction = 'Install'
}

$downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('polycode-channel-download-' + [Guid]::NewGuid().ToString('N'))
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$created = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($selectedChannel -eq 'Preview') {
        Write-Warning 'Installing Polycode v0.2.1 PREVIEW, not a stable or fully accepted release. Grok generation and clean-OS acceptance remain unverified.'
    } elseif ($selectedChannel -eq 'Stable') {
        Write-Warning 'Installing Polycode current Windows package from CI run 34380813272 (bcc4eaf5). Official stable publication is not open. This is not the 2026-09-08 Preview attestation.'
    } else {
        Write-Warning 'Installing unpublished Candidate from CI run 34525101732 (ef6ec4a5) with ChatGPT/Cursor patches. This is not an accepted stable release.'
        Assert-CandidateTools
    }
    if ($selectedAction -eq 'Overwrite') {
        Write-Warning 'Overwrite will install this channel and make its launcher the first polycode on user PATH. Other polycode directories stay on disk but leave PATH.'
    } elseif ($IncludePath) { Write-Warning 'User PATH will include this launcher; it may take precedence over another polycode command. Pass -NoPath to skip.' }
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    $created = $true
    if ($selectedChannel -eq 'Candidate') {
        Write-Host ('Downloading and verifying ' + $candidateArtifact + ' from Actions run ' + $candidateRunId)
        & gh run download $candidateRunId -n $candidateArtifact -D $downloadRoot -R $candidateRepo
        if ($LASTEXITCODE -ne 0) { throw 'gh run download failed for polycode-windows-candidate.' }
        foreach ($name in $assets.Keys) {
            Assert-ChannelAsset (Join-Path $downloadRoot $name) $assets[$name].bytes $assets[$name].sha256
        }
    } else {
        foreach ($name in $assets.Keys) {
            Write-Host ('Downloading and verifying ' + $name)
            $destination = Join-Path $downloadRoot $name
            Invoke-WebRequest -Uri $assets[$name].uri -UseBasicParsing -OutFile $destination -TimeoutSec 180 -MaximumRedirection 5
            Assert-ChannelAsset $destination $assets[$name].bytes $assets[$name].sha256
        }
    }
    $installerRuntime = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $installerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $downloadRoot 'install.ps1'),
        '-Version', $version, '-ArtifactDirectory', $downloadRoot, '-AllowCandidate', '-InstallRoot', $Root)
    if ((-not $IncludePath) -or ($selectedAction -eq 'Overwrite')) { $installerArguments += '-NoPath' }
    & $installerRuntime @installerArguments
    if ($LASTEXITCODE -ne 0) { throw ('Installer failed with exit code ' + $LASTEXITCODE) }
    if (-not [IO.File]::Exists($launcher)) { throw 'Installer returned success without a launcher.' }
    Save-ChannelState $Root $selectedChannel
    if ($selectedAction -eq 'Overwrite') { Set-PolycodePathOverwrite (Join-Path $Root 'bin') }
    $done = if ($selectedAction -eq 'Overwrite') { 'installed and PATH overwritten' } elseif ($selectedAction -eq 'Update') { 'updated' } else { 'installed' }
    Write-Host ("Polycode {0} {1}. No login or model request was started." -f $selectedChannel.ToLowerInvariant(), $done)
    if ($selectedChannel -eq 'Stable') {
        Write-Host 'context_budget and computer_use stay off until you set GROK_CONTEXT_BUDGET=1 / GROK_COMPUTER_USE=1 or [features] in config.toml.'
    }
    if ($selectedAction -eq 'Overwrite') { Write-Host 'User PATH now prefers this launcher. Open a new terminal; other polycode installs remain on disk.' }
    elseif ($IncludePath) { Write-Host 'User PATH updated. Open a new terminal to use polycode, or use the explicit command below.' }
    else { Write-Host 'PATH unchanged. Start with:' }
    Write-Host ("& '" + $launcher.Replace("'", "''") + "' -Project (Get-Location).Path -AuthDirectory '" + (Join-Path $Root 'auth').Replace("'", "''") + "'")
} finally {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
    if ($created -and [IO.Directory]::Exists($downloadRoot)) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force }
}
