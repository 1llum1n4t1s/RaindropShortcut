#requires -Version 7.0
[CmdletBinding()]
param([switch]$DryRun, [Net.Http.HttpMessageHandler]$HttpHandler)
$ErrorActionPreference = 'Stop'
Import-Module "$PSScriptRoot/Amo-Http.psm1" -Force
$root = Split-Path $PSScriptRoot -Parent
$manifest = Get-Content "$root/manifest.json" -Raw | ConvertFrom-Json
$addonId = $manifest.browser_specific_settings.gecko.id
if (!$addonId) { throw 'Manifest Gecko ID is missing' }
$path = '/api/v5/addons/addon/' + [Uri]::EscapeDataString($addonId) + '/'
$body = Get-Content "$root/webstore/amo-listing.json" -Raw | ConvertFrom-Json -AsHashtable
$privacy = @{ privacy_policy=$body.privacy_policy }
$privacy.privacy_policy.ja = (Get-Content "$root/docs/privacy-policy.md" -Raw).Trim()
$body.Remove('privacy_policy') | Out-Null
if ($DryRun) { Write-Output (@{listing=$body;policy=$privacy} | ConvertTo-Json -Depth 30); return }
$client = New-AmoClient -HttpHandler $HttpHandler
try {
    $current = Invoke-AmoApi $client 'GET' ($path+'?lang=ja')
    if ($current.guid -cne $addonId) { throw 'AMO listing identity mismatch' }
    $result = Invoke-AmoApi $client 'PATCH' $path -Body $body
    if ($result.guid -cne $addonId) { throw 'AMO listing update identity mismatch' }
    $null = Invoke-AmoApi $client 'PATCH' ($path+'eula_policy/') -Body $privacy
    $result = Invoke-AmoApi $client 'GET' ($path+'eula_policy/?show_source=1')
    foreach ($locale in 'ja','en-US') {
        if ($result.privacy_policy[$locale] -cne $privacy.privacy_policy[$locale]) { throw 'AMO privacy policy update not confirmed' }
    }
    $current = Invoke-AmoApi $client 'GET' ($path+'?lang=ja')
    if ($current.guid -cne $addonId -or !$current.has_privacy_policy) { throw 'AMO policy update not confirmed' }
    Write-Output 'AMO listing and privacy policy updated'
} finally { $client.Dispose() }
