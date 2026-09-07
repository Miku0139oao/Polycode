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
