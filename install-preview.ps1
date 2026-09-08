param(
    [string]$InstallRoot = (Join-Path $env:LOCALAPPDATA 'Polycode-Preview-v0.2.1'),
    [switch]$AddToPath
)

& {
    param([string]$Root, [switch]$IncludePath)
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    if ($env:OS -ne 'Windows_NT' -or -not [Environment]::Is64BitProcess -or
        $env:PROCESSOR_ARCHITECTURE -eq 'ARM64' -or $env:PROCESSOR_ARCHITEW6432 -eq 'ARM64') {
        throw 'Polycode Preview requires Windows x64 and a 64-bit PowerShell session.'
    }
    if ([Environment]::OSVersion.Version.Build -lt 19045) { throw 'Windows 10 22H2 or newer is required.' }
    $Root = [IO.Path]::GetFullPath($Root)
    if ($Root -match '[;\r\n]') { throw 'InstallRoot cannot contain semicolons or newlines.' }
    $productionRoot = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'Polycode'))
    if ($Root.TrimEnd('\', '/') -ieq $productionRoot.TrimEnd('\', '/')) {
        throw 'Choose a separate Preview directory, not the default production installation.'
    }
    $version = 'v0.2.1'
    $base = 'https://github.com/Miku0139oao/Polycode/releases/download/v0.2.1'
    $assets = [ordered]@{
        'install.ps1' = @{ bytes = 34301; sha256 = '06607648b697bbc783e2cc730a230cc51aacb3000287c25bdee9850b630c8476' }
        'manifest.json' = @{ bytes = 6851; sha256 = '6cc3df445e8b02577d8d009d308c949845a852b710f16412dd8a2d30b90de88a' }
        'SHA256SUMS' = @{ bytes = 434; sha256 = '2cbc8617eeb3bf0b903a01bfada3f660d0357a952a4c501b9811fe077b229396' }
        'polycode-windows-x64.gz' = @{ bytes = 59473371; sha256 = 'adffd26e77e3d018ff138e345568fed8551e41b017d09e7832ee807adb6cdbd5' }
        'polycode-bun-windows-x64.gz' = @{ bytes = 39647574; sha256 = '7411c0ae90f6aa34c8181ca233fbf4016335b89cf4e4f50c1b062db53da13949' }
        'polycode-runtime.zip' = @{ bytes = 1961144; sha256 = '3b6e3ceb80907f1faf30720d47746399028e8c983a18db8e88539c1ba4d63814' }
    }
    function Assert-PreviewAsset([string]$Path, [long]$Bytes, [string]$Sha256) {
        $stream = [IO.File]::OpenRead($Path)
        try {
            if ($stream.Length -ne $Bytes) { throw ('Unexpected file size: ' + [IO.Path]::GetFileName($Path)) }
            $hasher = [Security.Cryptography.SHA256]::Create()
            try { $actual = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
            finally { $hasher.Dispose() }
            if ($actual -cne $Sha256) { throw ('SHA256 mismatch: ' + [IO.Path]::GetFileName($Path)) }
        } finally { $stream.Dispose() }
    }
    $downloadRoot = Join-Path ([IO.Path]::GetTempPath()) ('polycode-preview-download-' + [Guid]::NewGuid().ToString('N'))
    $previousProtocol = [Net.ServicePointManager]::SecurityProtocol
    $created = $false
    try {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol -bor [Net.SecurityProtocolType]::Tls12
        Write-Warning 'Installing Polycode v0.2.1 PREVIEW, not a stable or fully accepted release. Grok generation and clean-OS acceptance remain unverified.'
        if ($IncludePath) { Write-Warning 'AddToPath explicitly enables the Preview launcher in user PATH; it may take precedence over another polycode command.' }
        New-Item -ItemType Directory -Path $downloadRoot | Out-Null
        $created = $true
        foreach ($name in $assets.Keys) {
            Write-Host ('Downloading and verifying ' + $name)
            $destination = Join-Path $downloadRoot $name
            Invoke-WebRequest -Uri ($base + '/' + $name) -UseBasicParsing -OutFile $destination -TimeoutSec 180 -MaximumRedirection 5
            Assert-PreviewAsset $destination $assets[$name].bytes $assets[$name].sha256
        }
        $installerRuntime = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $installerArguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $downloadRoot 'install.ps1'),
            '-Version', $version, '-ArtifactDirectory', $downloadRoot, '-AllowCandidate', '-InstallRoot', $Root)
        if (-not $IncludePath) { $installerArguments += '-NoPath' }
        & $installerRuntime @installerArguments
        if ($LASTEXITCODE -ne 0) { throw ('Preview installer failed with exit code ' + $LASTEXITCODE) }
        $launcher = Join-Path $Root 'bin\polycode.cmd'
        if (-not [IO.File]::Exists($launcher)) { throw 'Installer returned success without a launcher.' }
        Write-Host 'Polycode Preview installed. No login or model request was started.'
        if ($IncludePath) { Write-Host 'User PATH updated. Open a new terminal to use polycode, or use the explicit command below.' }
        else { Write-Host 'PATH unchanged. Start Preview with:' }
        Write-Host ("& '" + $launcher.Replace("'", "''") + "' -Project (Get-Location).Path -AuthDirectory '" + (Join-Path $Root 'auth').Replace("'", "''") + "'")
    } finally {
        [Net.ServicePointManager]::SecurityProtocol = $previousProtocol
        if ($created -and [IO.Directory]::Exists($downloadRoot)) { Remove-Item -LiteralPath $downloadRoot -Recurse -Force }
    }
} -Root $InstallRoot -IncludePath:$AddToPath
