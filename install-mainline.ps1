param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Polycode-Mainline'),
    [switch]$NoPath
)

& {
    param([string]$Root, [switch]$IncludePath)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'Polycode mainline requires Windows x64 and a 64-bit PowerShell session.'
    }
    if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 or newer is required.' }
    $Root = [IO.Path]::GetFullPath($Root)
    if ($Root -match '[;\r\n]') { throw 'InstallRoot cannot contain semicolons or newlines.' }
    $productionRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
    $previewRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1'))
    if ($Root.TrimEnd('\', '/') -ieq $productionRoot.TrimEnd('\', '/')) {
        throw 'Choose a separate mainline directory, not the default production installation.'
    }
    if ($Root.TrimEnd('\', '/') -ieq $previewRoot.TrimEnd('\', '/')) {
        throw 'Choose a separate mainline directory, not the v0.2.1 Preview installation.'
    }
    $version = 'v0.2.1'
    $releaseBase = 'https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1'
    $commitBase = 'https://raw.githubusercontent.com/Miku0139oao/Polycode/831e7375f88be4a346481c4b18d40cab8887f1d3'
    $assets = [ordered]@{
        'install.ps1' = @{ bytes = 34301; sha256 = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476'; uri = ($releaseBase + '/install.ps1') }
        'manifest.json' = @{ bytes = 6851; sha256 = '11709e24c2f2d44eca53f2f2f06425a73670b4d807606543c9d50fb8fc4e291a'; uri = ($commitBase + '/manifest.json') }
        'SHA256SUMS' = @{ bytes = 434; sha256 = '45219a4f2a42655f582a5f8bd288d909ae2f1d47edbf416254ef74c083543895'; uri = ($commitBase + '/SHA256SUMS') }
        'polycode-windows-x64.gz' = @{ bytes = 59539339; sha256 = '536871a7aa419acd5116693f06b791e638ba1d50568cd14202a56c6437b18d3a'; uri = ($commitBase + '/polycode-windows-x64.gz') }
        'polycode-bun-windows-x64.gz' = @{ bytes = 39647574; sha256 = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949'; uri = ($releaseBase + '/polycode-bun-windows-x64.gz') }
        'polycode-runtime.zip' = @{ bytes = 1961750; sha256 = 'ee8b18ca7be25d40bbff4463d40a3486c3c443cb73c3685191fd569b38eca86b'; uri = ($commitBase + '/polycode-runtime.zip') }
    }
    function Assert-MainlineAsset([string]$Path, [long]$Bytes, [string]$Sha256) {
        $stream = [IO.File]::OpenRead($Path)
        try {
            if ($stream.Length -ne $Bytes) { throw ('Unexpected file size: ' + [IO.Path]::GetFileName($Path)) }
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $hasher.Dispose() }
            if ($actual -cne $Sha256) { throw ('SHA256 mismatch: ' + [IO.Path]::GetFileName($Path)) }
        } finally { $stream.Dispose() }
    }
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('polycode-mainline-download-' + [Guid]::NewGuid().ToString('N'))
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    $created = $false
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Warning 'Installing Polycode mainline from Windows CI run 34380813272 (bcc4eaf5). This is not the 2026-09-08 Preview attestation and not a stable release. Grok generation and clean-OS acceptance remain unverified.'
        if ($IncludePath) { Write-Warning 'User PATH will include the mainline launcher; it may take precedence over another polycode command. Pass -NoPath to skip.' }
        New-Item -ItemType Directory -Path $downloadRoot | Out-Null
        $created = $true
        foreach ($name in $assets.Keys) {
            Write-Host ('Downloading and verifying ' + $name)
            $destination = Join-Path $downloadRoot $name
            Invoke-WebRequest -Uri $assets[$name].uri -UseBasicParsing -OutFile $destination -TimeoutSec 180 -MaximumRedirection 5
            Assert-MainlineAsset $destination $assets[$name].bytes $assets[$name].sha256
        }
        $installerRuntime = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $installerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $downloadRoot 'install.ps1'),
            '-Version', $version, '-ArtifactDirectory', $downloadRoot, '-AllowCandidate', '-InstallRoot', $Root)
        if (-not $IncludePath) { $installerArguments += '-NoPath' }
        & $installerRuntime @installerArguments
        if ($LASTEXITCODE -ne 0) { throw ('Mainline installer failed with exit code ' + $LASTEXITCODE) }
        $launcher = Join-Path $Root 'bin\polycode.cmd'
        if (-not [IO.File]::Exists($launcher)) { throw 'Installer returned success without a launcher.' }
        Write-Host 'Polycode mainline installed. No login or model request was started.'
        Write-Host 'context_budget and computer_use stay off until you set GROK_CONTEXT_BUDGET=1 / GROK_COMPUTER_USE=1 or [features] in config.toml.'
        if ($IncludePath) { Write-Host 'User PATH updated. Open a new terminal to use polycode, or use the explicit command below.' }
        else { Write-Host 'PATH unchanged. Start mainline with:' }
        Write-Host ("& '" + $launcher.Replace("'", "''") + "' -Project (Get-Location).Path -AuthDirectory '" + (Join-Path $Root 'auth').Replace("'", "''") + "'")
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
        if ($created -and [IO.Directory]::Exists($downloadRoot)) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force }
    }
} -Root $InstallRoot -IncludePath:(-not $NoPath)
