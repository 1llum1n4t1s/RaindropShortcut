#requires -Version 7.2
[CmdletBinding(DefaultParameterSetName='File')]
param(
    [Parameter(Mandatory,ParameterSetName='File')][string]$VersionFile,
    [Parameter(Mandatory,ParameterSetName='Version')][string]$Version,
    [string]$InstallRoot = $env:RUNNER_TEMP
)
$ErrorActionPreference = 'Stop'
if ($PSCmdlet.ParameterSetName -eq 'File') {
    # Bunのfrozen指定はlock欠落時に新規解決するため、CIでは先に欠落を拒否する。
    $manifestPath = (Get-Item -LiteralPath $VersionFile).FullName
    $lock = Get-Item -LiteralPath (Join-Path (Split-Path $manifestPath -Parent) 'bun.lock') -Force
    if ($lock.PSIsContainer -or ($lock.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'bun.lock must be a regular file.' }
    $lockData = Get-Content -LiteralPath $lock.FullName -Raw | ConvertFrom-Json -AsHashtable
    if ($null -eq $lockData -or $lockData.lockfileVersion -notin @(1,2,3) -or
        $lockData.workspaces -isnot [Collections.IDictionary] -or !$lockData.workspaces.Contains('') -or
        $lockData.packages -isnot [Collections.IDictionary]) { throw 'bun.lock is empty or has an invalid lockfile structure.' }
    $manager = (Get-Content -LiteralPath $VersionFile -Raw | ConvertFrom-Json).packageManager
    if ($manager -notmatch '^bun@(\d+\.\d+\.\d+)$') { throw 'packageManager must pin an exact Bun version.' }
    $Version = $Matches[1]
}
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw 'Bun version must be exact.' }
if (!$InstallRoot -or ![IO.Path]::IsPathRooted($InstallRoot)) { throw 'InstallRoot must be an absolute existing directory.' }
$root = Get-Item -LiteralPath $InstallRoot
if (!$root.PSIsContainer) { throw 'InstallRoot must be a directory.' }
$ancestor = $root
while ($null -ne $ancestor) {
    if ($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'InstallRoot must not traverse a reparse point.' }
    $ancestor = $ancestor.Parent
}
$platform = if ($IsWindows) { 'windows' } elseif ($IsMacOS) { 'darwin' } elseif ($IsLinux) { 'linux' } else { throw 'Unsupported OS.' }
$cpu = switch ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()) {
    'X64' { 'x64' }
    'Arm64' { 'aarch64' }
    default { throw 'Unsupported CPU architecture.' }
}
$artifact = "bun-$platform-$cpu"
$archiveName = "$artifact.zip"
$target = Join-Path $root.FullName ('bun-build-' + [Guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($target) | Out-Null
$client = [Net.Http.HttpClient]::new()
$client.Timeout = [TimeSpan]::FromMinutes(5)
function Get-OfficialFile([string]$Name, [string]$Destination) {
    $deadline = [Threading.CancellationTokenSource]::new([TimeSpan]::FromMinutes(5))
    $response = $null
    try {
        $url = "https://github.com/oven-sh/bun/releases/download/bun-v$Version/$Name"
        $response = $client.GetAsync($url, [Net.Http.HttpCompletionOption]::ResponseHeadersRead, $deadline.Token).GetAwaiter().GetResult()
        if (!$response.IsSuccessStatusCode) { throw "Official Bun download failed: HTTP $([int]$response.StatusCode)" }
        $output = [IO.File]::Open($Destination, 'CreateNew', 'Write', 'None')
        try { $response.Content.CopyToAsync($output, $deadline.Token).GetAwaiter().GetResult() | Out-Null } finally { $output.Dispose() }
    } finally {
        if ($null -ne $response) { $response.Dispose() }
        $deadline.Dispose()
    }
}
try {
    $checksumPath = Join-Path $target 'SHASUMS256.txt'
    Get-OfficialFile 'SHASUMS256.txt' $checksumPath
    $checksumMatches = [Regex]::Matches([IO.File]::ReadAllText($checksumPath), '(?m)^([a-fA-F0-9]{64})\s+\*?' + [Regex]::Escape($archiveName) + '\r?$')
    if ($checksumMatches.Count -ne 1) { throw 'Bun archive checksum is missing or ambiguous.' }
    $archivePath = Join-Path $target $archiveName
    Get-OfficialFile $archiveName $archivePath
    if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ine $checksumMatches[0].Groups[1].Value) { throw 'Bun archive SHA-256 mismatch.' }
    # 実行ファイルだけを取り出し、アーカイブ内のパスを展開先に利用しない。
    $executableName = if ($IsWindows) { 'bun.exe' } else { 'bun' }
    $executable = Join-Path $target $executableName
    $zip = [IO.Compression.ZipFile]::OpenRead($archivePath)
    try {
        $entries = @($zip.Entries | Where-Object FullName -CEQ "$artifact/$executableName")
        if ($entries.Count -ne 1) { throw 'Bun executable is missing or ambiguous in archive.' }
        [IO.Compression.ZipFileExtensions]::ExtractToFile($entries[0], $executable)
    } finally { $zip.Dispose() }
    if (!$IsWindows) {
        & chmod 700 $executable
        if ($LASTEXITCODE -ne 0) { throw 'Bun executable permission setup failed.' }
    }
    $installed = & $executable --version
    if ($LASTEXITCODE -ne 0 -or "$installed".Trim() -cne $Version) { throw 'Installed Bun version does not match pin.' }
    $env:PATH = $target + [IO.Path]::PathSeparator + $env:PATH
    if ($env:GITHUB_PATH) { $target | Add-Content -LiteralPath $env:GITHUB_PATH -Encoding utf8 }
    Write-Output "Build tools prepared: Bun $Version ($platform-$cpu)"
} finally { $client.Dispose() }
