param(
    [string]$InstallRoot,
    [string]$Action,
    [string]$Channel,
    [switch]$NoPath
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
        default { return $null }
    }
}

function Resolve-InstallChannel([string]$Value) {
    switch -Regex ($Value.Trim()) {
        '^(stable|穩定|穩定版)$' { return 'Stable' }
        '^(preview|預覽|預覽版)$' { return 'Preview' }
        default { return $null }
    }
}

function Set-PolycodePathOverwrite([string]$Bin) {
    $binFull = [IO.Path]::GetFullPath($Bin).TrimEnd('\', '/')
    $userPath = [string][Environment]::GetEnvironmentVariable('Path', 'User')
    $kept = New-Object System.Collections.Generic.List[string]
    foreach ($part in @($userPath -split ';')) {
        $entry = $part.Trim()
        if (-not $entry) { continue }
        $normalized = $entry.TrimEnd('\', '/')
        if ($normalized -ieq $binFull) { continue }
        $launcher = Join-Path $normalized 'polycode.cmd'
        if ([IO.File]::Exists($launcher)) { continue }
        $kept.Add($entry) | Out-Null
    }
    $next = (@($binFull) + $kept)
    [Environment]::SetEnvironmentVariable('Path', ($next -join ';'), 'User')
    $processKept = @($env:Path -split ';' | ForEach-Object { $_.Trim() } | Where-Object {
        $_ -and $_.TrimEnd('\', '/') -ine $binFull -and -not [IO.File]::Exists((Join-Path $_.TrimEnd('\', '/') 'polycode.cmd'))
    })
    $env:Path = (@($binFull) + $processKept) -join ';'
}

$selectedAction = Resolve-InstallAction $(if ($Action) { $Action } else { '' })
$selectedChannel = Resolve-InstallChannel $(if ($Channel) { $Channel } else { '' })
if (-not $selectedAction -or -not $selectedChannel) {
    $canPrompt = $false
    try { $canPrompt = [Environment]::UserInteractive -and $Host.Name -eq 'ConsoleHost' -and -not [Console]::IsInputRedirected } catch { $canPrompt = $false }
    if (-not $canPrompt) { throw 'Specify -Action Install|Update|Overwrite and -Channel Stable|Preview.' }
    Write-Host 'Polycode Windows 安裝'
    Write-Host '官方穩定版尚未通過完整驗收；選「穩定版」會安裝目前建議的 Windows 包（CI mainline）。'
    if (-not $selectedAction) {
        $pick = Read-MenuChoice '你要做什麼？' @(
            '安裝 — 寫入這個頻道自己的目錄',
            '更新 — 同一個頻道原地更新',
            '覆蓋 — 安裝這個頻道，並讓 PATH 上的 polycode 指向它'
        )
        $selectedAction = @('Install', 'Update', 'Overwrite')[$pick - 1]
    }
    if (-not $selectedChannel) {
        $pick = Read-MenuChoice '安裝哪個頻道？' @(
            '穩定版 — 目前 Windows 建議包（CI mainline，含新功能；不是完整驗收穩定版）',
            'Preview — v0.2.1（2026-09-08 已發布）'
        )
        $selectedChannel = @('Stable', 'Preview')[$pick - 1]
    }
}

$productionRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
$previewRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1'))
$stableRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode-Mainline'))
$channelRoot = if ($selectedChannel -eq 'Preview') { $previewRoot } else { $stableRoot }
$Root = if ($InstallRoot) { [IO.Path]::GetFullPath($InstallRoot) } else { $channelRoot }
if ($Root -match '[;\r\n]') { throw 'InstallRoot cannot contain semicolons or newlines.' }
if ($Root.TrimEnd('\', '/') -ieq $productionRoot.TrimEnd('\', '/')) {
    throw 'Choose a separate directory, not the default production installation.'
}
if ($selectedChannel -eq 'Stable' -and $Root.TrimEnd('\', '/') -ieq $previewRoot.TrimEnd('\', '/')) {
    throw 'Stable/mainline cannot install into the v0.2.1 Preview directory.'
}
if ($selectedChannel -eq 'Preview' -and $Root.TrimEnd('\', '/') -ieq $stableRoot.TrimEnd('\', '/')) {
    throw 'Preview cannot install into the mainline directory.'
}

$assets = if ($selectedChannel -eq 'Preview') { $previewAssets } else { $stableAssets }
$version = 'v0.2.1'
$launcher = Join-Path $Root 'bin\polycode.cmd'
if ($selectedAction -eq 'Update' -and -not [IO.File]::Exists($launcher)) {
    Write-Warning '這個頻道還沒安裝，改為安裝。'
    $selectedAction = 'Install'
}

$IncludePath = -not $NoPath
if ($selectedAction -eq 'Overwrite' -and -not $IncludePath) {
    throw 'Overwrite requires PATH changes; omit -NoPath.'
}
$downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('polycode-channel-download-' + [Guid]::NewGuid().ToString('N'))
$previousProtocol = [Net.ServicePointManager]::SecurityProtocol
$created = $false
try {
    [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
    if ($selectedChannel -eq 'Preview') {
        Write-Warning 'Installing Polycode v0.2.1 PREVIEW, not a stable or fully accepted release. Grok generation and clean-OS acceptance remain unverified.'
    } else {
        Write-Warning 'Installing Polycode current Windows package from CI run 34380813272 (bcc4eaf5). Official stable publication is not open. This is not the 2026-09-08 Preview attestation.'
    }
    if ($selectedAction -eq 'Overwrite') {
        Write-Warning 'Overwrite will install this channel and make its launcher the first polycode on user PATH. Other polycode directories stay on disk but leave PATH.'
    } elseif ($IncludePath) { Write-Warning 'User PATH will include this launcher; it may take precedence over another polycode command. Pass -NoPath to skip.' }
    New-Item -ItemType Directory -Path $downloadRoot | Out-Null
    $created = $true
    foreach ($name in $assets.Keys) {
        Write-Host ('Downloading and verifying ' + $name)
        $destination = Join-Path $downloadRoot $name
        Invoke-WebRequest -Uri $assets[$name].uri -UseBasicParsing -OutFile $destination -TimeoutSec 180 -MaximumRedirection 5
        Assert-ChannelAsset $destination $assets[$name].bytes $assets[$name].sha256
    }
    $installerRuntime = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $installerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $downloadRoot 'install.ps1'),
        '-Version', $version, '-ArtifactDirectory', $downloadRoot, '-AllowCandidate', '-InstallRoot', $Root)
    if ((-not $IncludePath) -or ($selectedAction -eq 'Overwrite')) { $installerArguments += '-NoPath' }
    & $installerRuntime @installerArguments
    if ($LASTEXITCODE -ne 0) { throw ('Installer failed with exit code ' + $LASTEXITCODE) }
    if (-not [IO.File]::Exists($launcher)) { throw 'Installer returned success without a launcher.' }
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
