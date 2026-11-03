#requires -Version 7.0
[CmdletBinding()]
param([switch]$Check, [switch]$DryRun, [string]$PreviewDirectory = "$PSScriptRoot/../webstore/images", [Net.Http.HttpMessageHandler]$HttpHandler)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/Amo-Http.psm1" -Force
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content "$root/manifest.json" -Raw | ConvertFrom-Json
$addonId = $manifest.browser_specific_settings.gecko.id
if (!$addonId) { throw 'Manifest Gecko ID is missing' }
$path = '/api/v5/addons/addon/' + [Uri]::EscapeDataString($addonId) + '/'
$files = @('01-feature-overview-1280x800.png','02-how-to-use-1280x800.png','03-hero-promo-1280x800.png') | ForEach-Object { Join-Path $PreviewDirectory $_ }
if (!$Check) {
    foreach ($file in $files) { if (!(Test-Path -LiteralPath $file -PathType Leaf)) { throw "Preview missing: $file; existing previews retained" } }
}
if ($DryRun) { Write-Output ($files | ConvertTo-Json); return }
$client = New-AmoClient -HttpHandler $HttpHandler
$added = [Collections.Generic.List[long]]::new()
try {
    $current = Invoke-AmoApi $client 'GET' ($path+'?lang=ja')
    if ($current.guid -cne $addonId) { throw 'AMO listing identity mismatch' }
    if (!$current.ContainsKey('previews') -or $current.previews -isnot [array]) { throw 'AMO preview inventory not confirmed' }
    if ($Check) { Write-Output ($current.previews | ConvertTo-Json -Depth 10); return }
    foreach ($preview in $current.previews) {
        if ($preview.id -isnot [long] -or $preview.id -le 0) { throw 'Invalid existing preview identity' }
    }
    for ($i=0; $i -lt $files.Count; $i++) {
        $result = Invoke-AmoApi $client 'POST' ($path+'previews/') -Form @{image=(Get-Item -LiteralPath $files[$i]);position=($i+1)}
        if ($result.id -isnot [long] -or $result.id -le 0 -or $added.Contains($result.id) -or $result.id -in $current.previews.id) { throw 'AMO preview acceptance not confirmed' }
        $added.Add($result.id)
        Write-Output "AMO preview accepted: $($result.id)"
    }
    # Preserve the previous images until all replacements have been accepted.
    foreach ($preview in $current.previews) {
        $null = Invoke-AmoApi $client 'DELETE' ($path+"previews/$($preview.id)/")
    }
} catch {
    if ($added.Count) { Write-Warning "New AMO preview IDs: $($added -join ','). Inspect existing and new images before retrying; do not blindly resubmit." }
    throw
} finally { $client.Dispose() }
