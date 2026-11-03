#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference='Stop'
if (![IO.Path]::IsPathFullyQualified($WorkDirectory)) { throw 'WorkDirectory must be absolute' }
$fixtureRoot = [IO.Path]::GetFullPath($WorkDirectory)
$ancestor = $fixtureRoot
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WorkDirectory crosses a reparse point' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
Add-Type -TypeDefinition @"
using System; using System.Net; using System.Net.Http; using System.Threading; using System.Threading.Tasks; using System.Collections.Generic;
public class FixtureHandler : HttpMessageHandler {
 public Queue<string> Bodies = new Queue<string>(); public List<string> Requests = new List<string>(); public int UploadBytes;
 protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) {
  Requests.Add(r.Method+" "+r.RequestUri.AbsoluteUri);
  if(r.RequestUri.AbsolutePath.EndsWith(":upload")) UploadBytes=(await r.Content.ReadAsByteArrayAsync()).Length;
  var body=Bodies.Dequeue(); if(body=="TRANSPORT") throw new HttpRequestException("secret"); return new HttpResponseMessage(body=="HTTP401"?HttpStatusCode.Unauthorized:HttpStatusCode.OK){Content=new StringContent(body)};
 }
}
"@
$env:CLIENT_ID='fixture';$env:CLIENT_SECRET='secret';$env:REFRESH_TOKEN='refresh';$env:PUBLISHER_ID='publisher';$env:EXTENSION_ID='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
$archive=Join-Path $fixtureRoot 'fixture.zip'
$stream=[IO.File]::Open($archive,'Create')
$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
$writer=[IO.StreamWriter]::new($zip.CreateEntry('manifest.json').Open());$writer.Write('{"version":"1.2.3"}');$writer.Dispose();$zip.Dispose();$stream.Dispose()
function Start-Sleep { param([int]$Seconds) }
$name='publishers/publisher/items/'+$env:EXTENSION_ID
foreach($case in 'success','async-stopped','wrong-version','failed-upload','wrong-identity','bad-publish','http-error','transport-error','post-verify-change','preflight-clear','preflight-existing','preflight-wrong-id','preflight-unknown-state','preflight-missing-version','preflight-no-revision','preflight-unpublished-allowed','preflight-accepted-idempotent','preflight-published-idempotent','preflight-pending-published-only') {
 $handler=[FixtureHandler]::new();$handler.Bodies.Enqueue('{"access_token":"fixture-token"}')
 $state=if($case -eq 'failed-upload'){'FAILED'}elseif($case -eq 'async-stopped'){'IN_PROGRESS'}else{'SUCCEEDED'}
 $version=if($case -eq 'wrong-version'){'9.9.9'}else{'1.2.3'}
 $identity=if($case -eq 'wrong-identity'){'wrong'}else{$name}
 if($case -eq 'async-stopped'){$version=$null}
 if($case -like 'preflight-*'){
  $statusName=if($case -eq 'preflight-wrong-id'){'wrong'}else{$name}
  $priorVersion=if($case -in @('preflight-existing','preflight-accepted-idempotent','preflight-published-idempotent','preflight-pending-published-only')){'1.2.3'}else{'0.1.0'}
  $status=@{name=$statusName;itemId=$env:EXTENSION_ID;publishedItemRevisionStatus=@{state='PUBLISHED';distributionChannels=@(@{crxVersion=$priorVersion})}}
  if($case -in @('preflight-accepted-idempotent','preflight-pending-published-only')){$status.publishedItemRevisionStatus.state='PENDING_REVIEW'}
  if($case -eq 'preflight-unknown-state'){$status.publishedItemRevisionStatus.state='UNKNOWN'}
  if($case -eq 'preflight-missing-version'){$status.publishedItemRevisionStatus.distributionChannels=@(@{})}
  if($case -in @('preflight-no-revision','preflight-unpublished-allowed')){$status.Remove('publishedItemRevisionStatus')}
  $handler.Bodies.Enqueue(($status|ConvertTo-Json -Depth 10 -Compress))
 }
 $handler.Bodies.Enqueue($(if($case -eq 'http-error'){'HTTP401'}elseif($case -eq 'transport-error'){'TRANSPORT'}else{(@{name=$identity;itemId=$env:EXTENSION_ID;uploadState=$state;crxVersion=$version}|ConvertTo-Json -Compress)}))
 if($case -eq 'async-stopped'){$handler.Bodies.Enqueue((@{name=$name;itemId=$env:EXTENSION_ID;lastAsyncUploadState='SUCCEEDED'}|ConvertTo-Json -Compress))}
 $publishState=if($case -eq 'bad-publish'){'REJECTED'}else{'PENDING_REVIEW'}
 $handler.Bodies.Enqueue((@{name=$name;itemId=$env:EXTENSION_ID;state=$publishState}|ConvertTo-Json -Compress))
 $caseArchive=$archive
 $verifiedHash=(Get-FileHash $archive -Algorithm SHA256).Hash
 if($case -eq 'post-verify-change'){
  $caseArchive=Join-Path $fixtureRoot 'cws-changed-after-verification.zip'
  [IO.File]::Copy($archive,$caseArchive,$true)
  $z=[IO.Compression.ZipFile]::Open($caseArchive,[IO.Compression.ZipArchiveMode]::Update)
  $writer=[IO.StreamWriter]::new($z.CreateEntry('changed.txt').Open());$writer.Write('changed after verified receipt');$writer.Dispose();$z.Dispose()
 }
 $failed=$false
 try { & "$PSScriptRoot/Publish-Cws.ps1" -Archive $caseArchive -ExpectedSha256 $verifiedHash -CheckExistingVersion:($case -like 'preflight-*') -AllowUnpublishedItem:($case -eq 'preflight-unpublished-allowed') -ExistingVersionPolicy:$(if($case -eq 'preflight-accepted-idempotent'){'Accepted'}elseif($case -in @('preflight-published-idempotent','preflight-pending-published-only')){'Published'}else{'Fail'}) -HttpHandler $handler } catch {$failed=$true}
 if($failed -ne ($case -notin @('success','preflight-clear','preflight-unpublished-allowed','preflight-accepted-idempotent','preflight-published-idempotent'))) {throw "Unexpected result: $case"}
 $expected=if($case -in @('preflight-clear','preflight-unpublished-allowed')){4}elseif($case -eq 'post-verify-change'){0}elseif($case -in @('success','bad-publish')){3}else{2}
 if($handler.Requests.Count -ne $expected){throw "Unsafe request count: $case"}
 if($case -notin @('post-verify-change','preflight-existing','preflight-wrong-id','preflight-unknown-state','preflight-missing-version','preflight-no-revision','preflight-accepted-idempotent','preflight-published-idempotent','preflight-pending-published-only') -and $handler.UploadBytes -ne (Get-Item $archive).Length){throw 'Upload stream mismatch'}
 Write-Output "PASS $case"
}
