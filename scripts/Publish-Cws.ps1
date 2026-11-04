#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive, [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256, [switch]$CheckExistingVersion, [switch]$AllowUnpublishedItem, [ValidateSet('Fail','Published','Accepted')][string]$ExistingVersionPolicy='Fail', [Net.Http.HttpMessageHandler]$HttpHandler)
$ErrorActionPreference = 'Stop'
# API contract: https://developer.chrome.com/docs/webstore/using-api
# 既存pwsh/.NETとHttpHandler fixtureを維持し、処理本体はC#へ渡す。
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'CwsPublisher.cs'))
$hasher = [Security.Cryptography.SHA256]::Create()
try { $hash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($source))).Replace('-','') }
finally { $hasher.Dispose() }
$typeName = 'Kagayoi.Cws.H' + $hash + '.Publisher'
$publisher = $typeName -as [type]
if (!$publisher) {
    Add-Type -TypeDefinition $source.Replace('__SOURCE_HASH__', ('H' + $hash))
    $publisher = $typeName -as [type]
}
$archivePath = (Resolve-Path -LiteralPath $Archive).ProviderPath
$publisher::Run($archivePath, $ExpectedSha256, $CheckExistingVersion.IsPresent, $AllowUnpublishedItem.IsPresent, $ExistingVersionPolicy, $HttpHandler)
