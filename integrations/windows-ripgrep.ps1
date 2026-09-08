# Build-time dependency only. The installer receives the verified executable in
# its runtime ZIP and never downloads tools on an end user's machine.
function Get-RipgrepSha256([string]$Path) {
    $stream = [IO.File]::OpenRead($Path)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { return [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose(); $stream.Dispose() }
}
function Get-WindowsRipgrepArchive([string]$Archive = $env:POLYCODE_RIPGREP_ARCHIVE) {
    $expected = '21a98bf42c4da97ca543c010e764cc6dec8b9b7538d05f8d21874016385e0860'
    $name = 'ripgrep-15.0.0-x86_64-pc-windows-msvc.zip'
    if (-not $Archive) {
        $cache = Join-Path ([IO.Path]::GetTempPath()) 'polycode-build-cache'
        New-Item -ItemType Directory -Force -Path $cache | Out-Null
        $Archive = Join-Path $cache $name
        if (-not (Test-Path -LiteralPath $Archive)) {
            $download = Join-Path $cache ([Guid]::NewGuid().ToString('N') + '.download')
            try {
                Invoke-Native (Get-Command curl.exe -ErrorAction Stop).Source @('-fL', '--retry', '2', '--connect-timeout', '15', '--max-time', '45', '-o', $download, ('https://github.com/BurntSushi/ripgrep/releases/download/15.0.0/' + $name)) 150 | Out-Null
                if ((Get-RipgrepSha256 $download) -ne $expected) { throw 'Downloaded ripgrep archive does not match its pinned SHA-256.' }
                try { [IO.File]::Move($download, $Archive) }
                catch { if (-not (Test-Path -LiteralPath $Archive)) { throw } }
            } finally {
                if (Test-Path -LiteralPath $download) { Remove-Item -LiteralPath $download -Force }
            }
        }
    }
    $Archive = (Resolve-Path -LiteralPath $Archive -ErrorAction Stop).Path
    if ((Get-RipgrepSha256 $Archive) -ne $expected) { throw 'Ripgrep archive does not match the pinned Windows release.' }
    return $Archive
}
