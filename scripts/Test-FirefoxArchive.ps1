#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference='Stop'
if (![IO.Path]::IsPathFullyQualified($WorkDirectory)) { throw 'WorkDirectory must be absolute' }
$root=[IO.Path]::GetFullPath($WorkDirectory)
$ancestor=$root
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WorkDirectory crosses a reparse point' }
    $ancestor=[IO.Path]::GetDirectoryName($ancestor)
}
$source=Join-Path $root ('source-'+[Guid]::NewGuid().ToString('N'))
foreach ($name in 'manifest.json','src/normal.js','.env','src/.credentials/token','src/node_modules/module.js','src/archive.zip','src/archive.xpi','src/backup.swp','src/backup~') {
    $path=Join-Path $source $name
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($path)) | Out-Null
    [IO.File]::WriteAllText($path,$name)
}
$archive=Join-Path $root ('fixture-'+[Guid]::NewGuid().ToString('N')+'.xpi')
$receipt=(& "$PSScriptRoot/New-FirefoxArchive.ps1" -SourceDirectory $source -Archive $archive)|ConvertFrom-Json
if ($receipt.sha256 -cne (Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()) { throw 'Builder receipt does not match archive snapshot' }
$zip=[IO.Compression.ZipFile]::OpenRead($archive)
try {
    $names=@($zip.Entries.FullName|Sort-Object)
    if (($names -join ',') -cne 'manifest.json,src/normal.js') { throw "Unexpected XPI entries: $names" }
} finally { $zip.Dispose() }
$rejected=$false
try { & "$PSScriptRoot/New-FirefoxArchive.ps1" -SourceDirectory $source -Archive $archive } catch {$rejected=$true}
if (!$rejected) { throw 'Existing archive was overwritten' }
Write-Output 'PASS archive default exclusions, exact receipt and no overwrite'
