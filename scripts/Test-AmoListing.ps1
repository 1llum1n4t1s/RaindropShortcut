#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory, [ValidateSet('Evidence','Raindrop')][string]$Recipe='Raindrop')
$ErrorActionPreference='Stop'
if (![IO.Path]::IsPathFullyQualified($WorkDirectory)) { throw 'WorkDirectory must be absolute' }
$fixtureRoot=[IO.Path]::GetFullPath($WorkDirectory)
$ancestor=$fixtureRoot
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WorkDirectory crosses a reparse point' }
    $ancestor=[IO.Path]::GetDirectoryName($ancestor)
}
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
Import-Module "$PSScriptRoot/Amo-Http.psm1" -Force
# The fixture never waits or contacts AMO; rate-limit replay is deterministic.
& (Get-Module Amo-Http) { function script:Start-Sleep { param([int]$Seconds) } }
Add-Type -TypeDefinition @"
using System; using System.Net; using System.Net.Http; using System.Threading; using System.Threading.Tasks; using System.Collections.Generic;
public class ListingHandler : HttpMessageHandler {
 public Queue<string> Replies=new Queue<string>(); public List<byte[]> Bodies=new List<byte[]>(); public List<string> Tokens=new List<string>(); public List<string> Requests=new List<string>();
 protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r,CancellationToken c) {
  Requests.Add(r.Method+" "+r.RequestUri.AbsoluteUri); Tokens.Add(r.Headers.Authorization.ToString()); Bodies.Add(r.Content==null?new byte[0]:await r.Content.ReadAsByteArrayAsync());
  var reply=Replies.Dequeue(); if(reply=="TRANSPORT") throw new HttpRequestException("fixture-secret");
  var parts=reply.Split(new[]{'|'},2);return new HttpResponseMessage((HttpStatusCode)int.Parse(parts[0])){Content=new StringContent(parts[1])};
 }
}
"@
$env:AMO_JWT_ISSUER='fixture-issuer';$env:AMO_JWT_SECRET='fixture-secret'
$path='/api/v5/addons/addon/fixture%40example.com/'
$image=Join-Path $fixtureRoot 'preview.png';[IO.File]::WriteAllBytes($image,[byte[]](1,2,3,4,255))
foreach ($case in 'json','multipart','empty-delete','rate-once','rate-exhausted','http-failure','transport-failure') {
    $handler=[ListingHandler]::new()
    switch ($case) {
        'empty-delete' { $handler.Replies.Enqueue('204|') }
        'rate-once' { $handler.Replies.Enqueue('429|{"detail":"Expected available in 1 seconds"}');$handler.Replies.Enqueue('200|{"id":1}') }
        'rate-exhausted' { 1..5 | ForEach-Object { $handler.Replies.Enqueue('429|{"detail":"rate limited"}') } }
        'http-failure' { $handler.Replies.Enqueue('401|{"detail":"fixture-secret"}') }
        'transport-failure' { $handler.Replies.Enqueue('TRANSPORT') }
        default { $handler.Replies.Enqueue('200|{"id":1}') }
    }
    $client=New-AmoClient $handler
    $failed=$false
    try {
        if ($case -eq 'multipart') { $null=Invoke-AmoApi $client 'POST' ($path+'previews/') -Form @{image=(Get-Item $image);position=1;'caption[ja]'='fixture'} }
        elseif ($case -eq 'empty-delete') { $null=Invoke-AmoApi $client 'DELETE' ($path+'previews/1/') }
        else { $null=Invoke-AmoApi $client 'PATCH' $path -Body @{summary=@{ja='fixture'};default_locale='ja'} }
    } catch {
        $failed=$true
        if ($_ -match 'fixture-secret') { throw 'Secret leaked through transport error' }
    } finally { $client.Dispose() }
    if ($failed -ne ($case -in @('rate-exhausted','http-failure','transport-failure'))) { throw "Unexpected result: $case" }
    $expected=switch($case){'rate-once'{2};'rate-exhausted'{5};default{1}}
    if ($handler.Tokens.Count -ne $expected) { throw "Unexpected replay count: $case" }
    if (@($handler.Tokens | Select-Object -Unique).Count -ne $handler.Tokens.Count) { throw 'Retry reused JWT identity' }
    foreach ($auth in $handler.Tokens) {
        $parts=$auth.Substring(4).Split('.')
        $hmac=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes('fixture-secret'))
        try { $sig=[Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes($parts[0]+'.'+$parts[1]))).TrimEnd('=').Replace('+','-').Replace('/','_') } finally { $hmac.Dispose() }
        if ($sig -cne $parts[2]) { throw 'JWT signature mismatch' }
    }
    if ($case -eq 'multipart') {
        $text=[Text.Encoding]::Latin1.GetString($handler.Bodies[0])
        if (!$text.Contains([Text.Encoding]::Latin1.GetString([IO.File]::ReadAllBytes($image))) -or $text -notmatch 'caption\[ja\]' -or $text -notmatch 'position') { throw 'Multipart bytes or metadata changed' }
    }
    if ($case -eq 'json' -and ([Text.Encoding]::UTF8.GetString($handler.Bodies[0]) | ConvertFrom-Json).summary.ja -cne 'fixture') { throw 'Listing metadata changed' }
    Write-Output "PASS listing $case"
}

# Exercise the real wrapper: AMO renders policy Markdown in PATCH responses.
$plan=(& "$PSScriptRoot/Update-AmoListing.ps1" -DryRun) | ConvertFrom-Json -AsHashtable
$guid=if($Recipe -eq 'Evidence'){'{ff2db429-9e61-439d-9e11-b565113d5711}'}else{(Get-Content "$PSScriptRoot/../manifest.json" -Raw|ConvertFrom-Json).browser_specific_settings.gecko.id}
foreach($case in 'policy-source-success','policy-source-mismatch') {
    $handler=[ListingHandler]::new()
    $identity='200|'+(@{guid=$guid;has_privacy_policy=$true}|ConvertTo-Json -Compress)
    if($Recipe -eq 'Raindrop'){$handler.Replies.Enqueue($identity)}
    $handler.Replies.Enqueue($identity)
    $handler.Replies.Enqueue('200|{"privacy_policy":{"ja":"<h1>Rendered</h1>","en-US":"<h1>Rendered</h1>"}}')
    $source=if($case -eq 'policy-source-success'){$plan.policy}else{@{privacy_policy=@{ja='wrong';'en-US'='wrong'}}}
    $handler.Replies.Enqueue('200|'+($source|ConvertTo-Json -Depth 30 -Compress))
    if($Recipe -eq 'Raindrop'){$handler.Replies.Enqueue($identity)}
    $failed=$false
    try {
        if($Recipe -eq 'Evidence'){& "$PSScriptRoot/Update-AmoListing.ps1" -MetadataOnly -HttpHandler $handler}
        else{& "$PSScriptRoot/Update-AmoListing.ps1" -HttpHandler $handler}
    } catch {$failed=$true}
    if($failed -ne ($case -eq 'policy-source-mismatch')){throw "Unexpected wrapper result: $case"}
    if(!($handler.Requests | Where-Object {$_ -match 'GET .*eula_policy/\?show_source=1$'})){throw 'Raw privacy policy was not checked'}
    $patchIndex=if($Recipe -eq 'Evidence'){0}else{1}
    $listing=[Text.Encoding]::UTF8.GetString($handler.Bodies[$patchIndex])|ConvertFrom-Json -AsHashtable
    if($listing.ContainsKey('privacy_policy') -or $listing.ContainsKey('has_privacy_policy')){throw 'Policy sent to unsupported addon fields'}
    Write-Output "PASS wrapper $case"
}
if($Recipe -eq 'Evidence') {
    foreach($case in 'caption-success','caption-mismatch') {
        $handler=[ListingHandler]::new()
        $captions=@(@('機能概要','Feature overview'),@('使い方','How to use'),@('撮影サンプル','Sample capture'))
        $names=@('01-feature-overview-1280x800.png','02-how-to-use-1280x800.png','03-hero-promo-1280x800.png')
        for($i=0;$i -lt 3;$i++){
            [IO.File]::WriteAllBytes((Join-Path $fixtureRoot $names[$i]),[byte[]](1,2,3))
            $handler.Replies.Enqueue('200|'+(@{id=($i+1)}|ConvertTo-Json -Compress))
            $caption=if($case -eq 'caption-mismatch'){@{ja='wrong';'en-US'='wrong'}}else{@{ja=$captions[$i][0];'en-US'=$captions[$i][1]}}
            $handler.Replies.Enqueue('200|'+(@{id=($i+1);caption=$caption}|ConvertTo-Json -Depth 10 -Compress))
        }
        $failed=$false
        try{& "$PSScriptRoot/Update-AmoListing.ps1" -PreviewsOnly -PreviewDirectory $fixtureRoot -HttpHandler $handler}catch{$failed=$true}
        if($failed -ne ($case -eq 'caption-mismatch')){throw "Unexpected caption result: $case"}
        $expected=if($case -eq 'caption-success'){6}else{2}
        if($handler.Requests.Count -ne $expected -or $handler.Requests[0] -notmatch '^POST ' -or $handler.Requests[1] -notmatch '^PATCH .*previews/1/$'){throw 'Preview endpoint sequence changed'}
        if([Text.Encoding]::UTF8.GetString($handler.Bodies[0]) -match 'caption'){throw 'Caption was sent in preview create multipart'}
        Write-Output "PASS wrapper $case"
    }
}

if($Recipe -eq 'Raindrop') {
    foreach($case in 'replace-success','replacement-rejected','partial-replacement') {
        $handler=[ListingHandler]::new()
        $handler.Replies.Enqueue('200|'+(@{guid=$guid;previews=@(@{id=10;position=1})}|ConvertTo-Json -Depth 10 -Compress))
        $handler.Replies.Enqueue($(if($case -eq 'replacement-rejected'){'401|{"detail":"rejected"}'}else{'200|{"id":1}'}))
        if($case -eq 'partial-replacement'){$handler.Replies.Enqueue('401|{"detail":"rejected"}')}
        elseif($case -eq 'replace-success'){$handler.Replies.Enqueue('200|{"id":2}');$handler.Replies.Enqueue('200|{"id":3}');$handler.Replies.Enqueue('204|')}
        foreach($name in '01-feature-overview-1280x800.png','02-how-to-use-1280x800.png','03-hero-promo-1280x800.png'){[IO.File]::WriteAllBytes((Join-Path $fixtureRoot $name),[byte[]](1,2,3))}
        $failed=$false
        try{& "$PSScriptRoot/Update-AmoPreviews.ps1" -PreviewDirectory $fixtureRoot -HttpHandler $handler}catch{$failed=$true}
        if($failed -ne ($case -ne 'replace-success')){throw "Unexpected replacement result: $case"}
        $deletes=@($handler.Requests|Where-Object{$_ -match '^DELETE '})
        if($case -eq 'replace-success'){
            if($handler.Requests.Count -ne 5 -or $handler.Requests[4] -notmatch '^DELETE .*previews/10/$'){throw 'Previous images deleted before replacements were accepted'}
        }elseif($deletes.Count){throw 'Previous images deleted after replacement failure'}
        Write-Output "PASS wrapper $case"
    }
}
