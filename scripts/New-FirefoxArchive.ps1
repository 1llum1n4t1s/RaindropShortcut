#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$SourceDirectory, [Parameter(Mandatory)][string]$Archive)
$ErrorActionPreference='Stop'
$source=(Resolve-Path -LiteralPath $SourceDirectory).Path.TrimEnd([IO.Path]::DirectorySeparatorChar)
$destination=[IO.Path]::GetFullPath($Archive)
if ($destination.StartsWith($source+[IO.Path]::DirectorySeparatorChar,[StringComparison]::Ordinal)) { throw 'Archive must be outside source directory' }
foreach ($target in @($source,[IO.Path]::GetDirectoryName($destination))) {
    $ancestor=$target
    while ($ancestor) {
        if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Archive path crosses a reparse point' }
        $ancestor=[IO.Path]::GetDirectoryName($ancestor)
    }
}
$memory=[IO.MemoryStream]::new()
try {
    $zip=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        function Add-SourceDirectory([string]$Directory) {
            foreach ($item in Get-ChildItem -LiteralPath $Directory -Force | Sort-Object Name) {
                # Preserve web-ext's default exclusions plus the existing workflow exclusions.
                if ($item.Name.StartsWith('.') -or $item.Name -ceq 'node_modules' -or $item.Name -cmatch '\.(xpi|zip)$|\.swp$|~$') { continue }
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Archive source contains a link' }
                if ($item.PSIsContainer) { Add-SourceDirectory $item.FullName; continue }
                $relative=[IO.Path]::GetRelativePath($source,$item.FullName).Replace('\','/')
                $entry=$zip.CreateEntry($relative,[IO.Compression.CompressionLevel]::Optimal)
                $input=[IO.File]::OpenRead($item.FullName)
                $output=$entry.Open()
                try { $input.CopyTo($output) } finally { $output.Dispose();$input.Dispose() }
            }
        }
        Add-SourceDirectory $source
    } finally { $zip.Dispose() }
    $bytes=$memory.ToArray()
    $hasher=[Security.Cryptography.SHA256]::Create()
    try { $hash=[BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    $output=[IO.File]::Open($destination,'CreateNew','Write','None')
    try { $output.Write($bytes,0,$bytes.Length) } finally { $output.Dispose() }
    @{archive=$destination;sha256=$hash} | ConvertTo-Json -Compress
} finally { $memory.Dispose() }
