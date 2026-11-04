#requires -Version 7.2
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Archive,
    [Parameter(Mandatory)][string]$Metadata,
    [Parameter(Mandatory)][string]$AddonId,
    [Parameter(Mandatory)][string]$ExpectedVersion,
    [Parameter(Mandatory)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256,
    [Net.Http.HttpMessageHandler]$HttpHandler
)
$ErrorActionPreference = 'Stop'
# 公開パラメーターと HTTP handler 契約を維持し、処理本体は同梱 .NET で動かす。
$source = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Publish-Amo.cs'))
$hash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($source)))
$namespace = "Kagayoi.Amo_$hash"
$type = "$namespace.Publisher" -as [type]
if (!$type) {
    Add-Type -TypeDefinition $source.Replace('Kagayoi.AmoSource', $namespace)
    $type = "$namespace.Publisher" -as [type]
}
$archivePath = (Resolve-Path -LiteralPath $Archive -ErrorAction Stop).ProviderPath
$metadataPath = (Resolve-Path -LiteralPath $Metadata -ErrorAction Stop).ProviderPath
$type::Publish($archivePath, $metadataPath, $AddonId, $ExpectedVersion, $ExpectedSha256, $HttpHandler)
