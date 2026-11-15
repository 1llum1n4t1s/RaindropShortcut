#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$WorkDirectory)
$ErrorActionPreference='Stop'
Write-Output ('Fixture runtime: PowerShell '+$PSVersionTable.PSVersion+' / .NET '+[Environment]::Version)
if (![IO.Path]::IsPathFullyQualified($WorkDirectory)) { throw 'WorkDirectory must be absolute' }
$fixtureRoot = [IO.Path]::GetFullPath($WorkDirectory)
$ancestor = $fixtureRoot
while ($ancestor) {
    if ((Test-Path -LiteralPath $ancestor) -and ((Get-Item -LiteralPath $ancestor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'WorkDirectory crosses a reparse point' }
    $ancestor = [IO.Path]::GetDirectoryName($ancestor)
}
[IO.Directory]::CreateDirectory($fixtureRoot) | Out-Null
$guardSource=@'
using System; using System.Net; using System.Net.Sockets; using System.Threading; using System.Threading.Tasks;
public sealed class CwsFixtureNetworkGuard : IWebProxy, IDisposable {
 private readonly TcpListener listener; private readonly Uri proxy;
 public int Blocked; public int Connections;
 public ICredentials Credentials { get; set; }
 public CwsFixtureNetworkGuard() {
  listener=new TcpListener(IPAddress.Loopback,0); listener.Start();
  proxy=new Uri("http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port);
  Task.Run(async () => { try { while(true) { using(var client=await listener.AcceptTcpClientAsync()) { Interlocked.Increment(ref Connections); } } } catch(ObjectDisposedException) {} catch(SocketException) {} });
 }
 public Uri GetProxy(Uri target) { Interlocked.Increment(ref Blocked); return proxy; }
 public bool IsBypassed(Uri target) { return false; }
 public void Dispose() { listener.Stop(); }
}
'@
Add-Type -TypeDefinition $guardSource
$previousProxy=[Net.Http.HttpClient]::DefaultProxy
$networkGuard=[CwsFixtureNetworkGuard]::new()
[Net.Http.HttpClient]::DefaultProxy=$networkGuard
try {
# HttpHandler注入の欠落時にも、既定HttpClientがプロセス外へ通信しないことを先に確認する。
$probe=[Net.Http.HttpClient]::new()
try {
 $probe.Timeout=[TimeSpan]::FromSeconds(1)
 $blockedError=$false
 try {$probe.GetAsync('https://192.0.2.1/cws-offline-probe').GetAwaiter().GetResult()|Out-Null} catch {$blockedError=$true}
 if($networkGuard.Blocked -lt 1 -or $networkGuard.Connections -lt 1 -or !$blockedError){throw 'Offline HTTP guard negative probe failed'}
}finally{$probe.Dispose()}
Write-Output 'PASS offline-network-guard-negative-probe'
Add-Type -TypeDefinition @"
using System; using System.Net; using System.Net.Http; using System.Threading; using System.Threading.Tasks; using System.Collections.Generic;
public class FixtureHandler : HttpMessageHandler {
 public Queue<string> Bodies = new Queue<string>(); public List<string> Requests = new List<string>(); public int UploadBytes; public byte[] UploadContent;
 public string SwapPath; public string SwapStage; public byte[] SwapBytes;
 protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) {
  Requests.Add(r.Method+" "+r.RequestUri.AbsoluteUri);
  if(r.RequestUri.AbsolutePath.EndsWith(":upload")) { UploadContent=await r.Content.ReadAsByteArrayAsync(); UploadBytes=UploadContent.Length; }
  if(SwapPath!=null && r.RequestUri.AbsolutePath.EndsWith(SwapStage)) { System.IO.File.WriteAllBytes(SwapPath,SwapBytes); SwapPath=null; }
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

# 本番入口の機密保護・要求回数・再読込を、外部HTTPなしで追加確認する。
function Invoke-BoundaryCase {
 param([string]$Name,[string[]]$Bodies,[int]$Requests,[bool]$ShouldFail=$true,[string]$CaseArchive=$archive,
       [switch]$Preflight,[string]$Policy='Fail',[string]$EntryPoint="$PSScriptRoot/Publish-Cws.ps1")
 $handler=[FixtureHandler]::new()
 foreach($body in $Bodies){$handler.Bodies.Enqueue($body)}
 $message='';$failed=$false
 try { $message=(& $EntryPoint -Archive $CaseArchive -CheckExistingVersion:$Preflight -ExistingVersionPolicy $Policy -HttpHandler $handler | Out-String) }
 catch {$failed=$true;$message=$_.ToString()}
 if($failed -ne $ShouldFail){throw "Unexpected boundary result: $Name"}
 if($handler.Requests.Count -ne $Requests){throw "Unsafe boundary request count: $Name"}
 foreach($secret in 'fixture-token','secret','refresh') {
  if($message.Contains($secret)){throw "Credential appeared in boundary output: $Name"}
 }
 [Console]::WriteLine("PASS $Name")
 return $message
}
$oauth='{"access_token":"fixture-token"}'
$upload=(@{name=$name;itemId=$env:EXTENSION_ID;uploadState='SUCCEEDED';crxVersion='1.2.3'}|ConvertTo-Json -Compress)
$published=(@{name=$name;itemId=$env:EXTENSION_ID;state='PENDING_REVIEW'}|ConvertTo-Json -Compress)
# SHA-256確認後に同長の別ZIPへ差し替わっても、元のsnapshotだけを送信する。
function New-SnapshotZipBytes([string]$ManifestVersion,[string]$Marker) {
 $memory=[IO.MemoryStream]::new()
 try {
  $z=[IO.Compression.ZipArchive]::new($memory,[IO.Compression.ZipArchiveMode]::Create,$true)
  try {
   foreach($entryName in 'manifest.json','marker.txt') {
    $w=[IO.StreamWriter]::new($z.CreateEntry($entryName,[IO.Compression.CompressionLevel]::NoCompression).Open())
    try {$w.Write($(if($entryName -eq 'manifest.json'){'{"version":"'+$ManifestVersion+'"}'}else{$Marker}))}finally{$w.Dispose()}
   }
  }finally{$z.Dispose()}
  return ,$memory.ToArray()
 }finally{$memory.Dispose()}
}
$snapshotBytes=New-SnapshotZipBytes '1.2.3' 'original'
$replacementBytes=New-SnapshotZipBytes '9.9.9' 'modified'
$snapshotBase64=[Convert]::ToBase64String($snapshotBytes)
$replacementBase64=[Convert]::ToBase64String($replacementBytes)
if($snapshotBytes.Length -ne $replacementBytes.Length -or $snapshotBase64 -ceq $replacementBase64){throw 'Snapshot replacement fixture must differ but have identical length'}
foreach($stage in 'oauth','preflight') {
 $snapshotArchive=Join-Path $fixtureRoot ('snapshot-'+$stage+'.zip')
 [IO.File]::WriteAllBytes($snapshotArchive,$snapshotBytes)
 $verifiedHash=(Get-FileHash -LiteralPath $snapshotArchive -Algorithm SHA256).Hash
 $handler=[FixtureHandler]::new()
 $handler.SwapPath=$snapshotArchive;$handler.SwapBytes=$replacementBytes
 $handler.SwapStage=if($stage -eq 'oauth'){'/token'}else{':fetchStatus'}
 $handler.Bodies.Enqueue($oauth)
 if($stage -eq 'preflight') {
  $status=(@{name=$name;itemId=$env:EXTENSION_ID;publishedItemRevisionStatus=@{state='PUBLISHED';distributionChannels=@(@{crxVersion='0.1.0'})}}|ConvertTo-Json -Depth 10 -Compress)
  $handler.Bodies.Enqueue($status)
 }
 $handler.Bodies.Enqueue($upload);$handler.Bodies.Enqueue($published)
 & "$PSScriptRoot/Publish-Cws.ps1" -Archive $snapshotArchive -ExpectedSha256 $verifiedHash -CheckExistingVersion:($stage -eq 'preflight') -HttpHandler $handler | Out-Null
 if($handler.SwapPath -or [Convert]::ToBase64String([IO.File]::ReadAllBytes($snapshotArchive)) -cne $replacementBase64){throw 'ZIP replacement did not occur at the requested stage'}
 if([Convert]::ToBase64String($handler.UploadContent) -cne $snapshotBase64){throw 'Upload bytes differ from the verified snapshot'}
 $expectedRequests=if($stage -eq 'preflight'){4}else{3}
 if($handler.Requests.Count -ne $expectedRequests){throw 'Unexpected request count in snapshot replacement test'}
 Write-Output ('PASS verified-snapshot-after-same-length-'+$stage+'-replacement')
}
$oauthCase=0
foreach($response in '{}','not-json-secret','HTTP401','TRANSPORT'){
 Invoke-BoundaryCase -Name ('oauth-boundary-'+$oauthCase) -Bodies @($response) -Requests 1 | Out-Null
 $oauthCase++
}
Invoke-BoundaryCase -Name 'upload-invalid-json' -Bodies @($oauth,'not-json-secret') -Requests 2 | Out-Null
foreach($response in 'not-json-secret','HTTP401','TRANSPORT',(@{name='wrong';itemId=$env:EXTENSION_ID;state='PUBLISHED'}|ConvertTo-Json -Compress)){
 Invoke-BoundaryCase -Name 'publish-uncertain-or-wrong-identity' -Bodies @($oauth,$upload,$response) -Requests 3 | Out-Null
}
foreach($revision in @(@{state='PUBLISHED';distributionChannels=@()},@{state='PUBLISHED';distributionChannels=@{crxVersion='1.2.3'}},@{state='PUBLISHED';distributionChannels=@(@{crxVersion='1.2.3'},@{crxVersion='bad'})})){
 $status=(@{name=$name;itemId=$env:EXTENSION_ID;submittedItemRevisionStatus=$revision}|ConvertTo-Json -Depth 10 -Compress)
 Invoke-BoundaryCase -Name 'invalid-submitted-revision' -Bodies @($oauth,$status) -Requests 2 -Preflight -Policy Published | Out-Null
}
$status=(@{name=$name;itemId=$env:EXTENSION_ID;submittedItemRevisionStatus=@{state='STAGED';distributionChannels=@(@{crxVersion='1.2.3'})}}|ConvertTo-Json -Depth 10 -Compress)
Invoke-BoundaryCase -Name 'accepted-submitted-revision' -Bodies @($oauth,$status) -Requests 2 -Preflight -Policy Accepted -ShouldFail $false | Out-Null
foreach($case in 'missing-manifest','duplicate-manifest','missing-version'){
 $invalidArchive=Join-Path $fixtureRoot ($case+'.zip')
 $invalidStream=[IO.File]::Open($invalidArchive,'Create')
 $z=[IO.Compression.ZipArchive]::new($invalidStream,[IO.Compression.ZipArchiveMode]::Create)
 try {
  $names=if($case -eq 'missing-manifest'){@('nested/manifest.json')}elseif($case -eq 'duplicate-manifest'){@('manifest.json','manifest.json')}else{@('manifest.json')}
  foreach($entryName in $names){
   $w=[IO.StreamWriter]::new($z.CreateEntry($entryName).Open())
   try {$w.Write($(if($case -eq 'missing-version'){'{}'}else{'{"version":"1.2.3"}'}))}finally{$w.Dispose()}
  }
 }finally{$z.Dispose();$invalidStream.Dispose()}
 Invoke-BoundaryCase -Name $case -Bodies @() -Requests 0 -CaseArchive $invalidArchive | Out-Null
}
# Stage分離: Upload段は申請せず、Publish段はZIPをuploadしない。段の取り違えが通信前・申請前に止まることも確認する。
function New-StageStatus {
 param([string]$Property='publishedItemRevisionStatus',[string]$State='PUBLISHED',[string]$CrxVersion='0.1.0',[string]$Async,[string]$Identity=$name,[switch]$NoRevision)
 $status=@{name=$Identity;itemId=$env:EXTENSION_ID}
 if(!$NoRevision){$status[$Property]=@{state=$State;distributionChannels=@(@{crxVersion=$CrxVersion})}}
 if($Async){$status.lastAsyncUploadState=$Async}
 return ($status|ConvertTo-Json -Depth 10 -Compress)
}
function Invoke-StageCase {
 param([string]$Name,[string[]]$Bodies,[int]$Requests,[bool]$ShouldFail,[ValidateSet('Upload','Publish')][string]$Stage,
       [string]$Version,[string]$CaseArchive,[switch]$Preflight,[switch]$AllowUnpublished,[string]$Forbid,[string]$Require,[string]$Message)
 $handler=[FixtureHandler]::new()
 foreach($body in $Bodies){$handler.Bodies.Enqueue($body)}
 $params=@{Stage=$Stage;HttpHandler=$handler}
 if($CaseArchive){$params.Archive=$CaseArchive}
 if($Version){$params.Version=$Version}
 if($Preflight){$params.CheckExistingVersion=$true}
 if($AllowUnpublished){$params.AllowUnpublishedItem=$true}
 $text='';$failed=$false
 try { $text=(& "$PSScriptRoot/Publish-Cws.ps1" @params | Out-String) } catch {$failed=$true;$text=$_.ToString()}
 if($failed -ne $ShouldFail){throw "Unexpected stage result: $Name"}
 if($handler.Requests.Count -ne $Requests){throw "Unsafe stage request count: $Name"}
 if($Forbid -and @($handler.Requests|Where-Object{$_.Contains($Forbid)}).Count -ne 0){throw "Forbidden $Forbid request in stage case: $Name"}
 if($Require -and @($handler.Requests|Where-Object{$_.Contains($Require)}).Count -ne 1){throw "Required $Require request missing in stage case: $Name"}
 if($Message -and !$text.Contains($Message)){throw "Stage message mismatch: $Name"}
 foreach($secret in 'fixture-token','secret','refresh'){if($text.Contains($secret)){throw "Credential appeared in stage output: $Name"}}
 if($Stage -eq 'Upload' -and !$ShouldFail -and $handler.UploadBytes -ne (Get-Item $archive).Length){throw "Upload stream mismatch in stage case: $Name"}
 [Console]::WriteLine("PASS $Name")
}
$bad=(@{name=$name;itemId=$env:EXTENSION_ID;uploadState='SUCCEEDED';crxVersion='9.9.9'}|ConvertTo-Json -Compress)
$asyncUpload=(@{name=$name;itemId=$env:EXTENSION_ID;uploadState='IN_PROGRESS'}|ConvertTo-Json -Compress)
$rejected=(@{name=$name;itemId=$env:EXTENSION_ID;state='REJECTED'}|ConvertTo-Json -Compress)
# Upload段: uploadまでで終わり、:publishを送らない。
Invoke-StageCase -Name 'upload-stage-no-publish' -Stage Upload -CaseArchive $archive -Bodies @($oauth,$upload) -Requests 2 -ShouldFail $false -Forbid ':publish' -Require ':upload' -Message 'NOT submitted'
Invoke-StageCase -Name 'upload-stage-preflight-no-publish' -Stage Upload -CaseArchive $archive -Preflight -Bodies @($oauth,(New-StageStatus),$upload) -Requests 3 -ShouldFail $false -Forbid ':publish'
Invoke-StageCase -Name 'upload-stage-async-stops' -Stage Upload -CaseArchive $archive -Bodies @($oauth,$asyncUpload) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'upload-stage-wrong-version-stops' -Stage Upload -CaseArchive $archive -Bodies @($oauth,$bad) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'upload-stage-existing-version-stops' -Stage Upload -CaseArchive $archive -Preflight -Bodies @($oauth,(New-StageStatus -CrxVersion '1.2.3')) -Requests 2 -ShouldFail $true -Forbid ':upload'
Invoke-StageCase -Name 'upload-stage-rejects-version-param' -Stage Upload -CaseArchive $archive -Version '1.2.3' -Bodies @() -Requests 0 -ShouldFail $true
Invoke-StageCase -Name 'upload-stage-requires-archive' -Stage Upload -Bodies @() -Requests 0 -ShouldFail $true
# Publish段: ZIPを送らず、fetchStatusで確認できる範囲を満たす場合だけ:publishを送る。
Invoke-StageCase -Name 'publish-stage-submits-without-upload' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus),$published) -Requests 3 -ShouldFail $false -Forbid ':upload' -Require ':publish' -Message 'accepted version 1.2.3'
Invoke-StageCase -Name 'publish-stage-numeric-version-order' -Stage Publish -Version '1.10.0' -Bodies @($oauth,(New-StageStatus -CrxVersion '1.9.0'),$published) -Requests 3 -ShouldFail $false -Forbid ':upload' -Require ':publish'
Invoke-StageCase -Name 'publish-stage-rejects-archive' -Stage Publish -Version '1.2.3' -CaseArchive $archive -Bodies @() -Requests 0 -ShouldFail $true
Invoke-StageCase -Name 'publish-stage-requires-version' -Stage Publish -Bodies @() -Requests 0 -ShouldFail $true
Invoke-StageCase -Name 'publish-stage-invalid-version' -Stage Publish -Version '1.2.x' -Bodies @() -Requests 0 -ShouldFail $true
foreach($sameState in @(@('submittedItemRevisionStatus','PENDING_REVIEW'),@('submittedItemRevisionStatus','STAGED'),@('publishedItemRevisionStatus','PUBLISHED'),@('publishedItemRevisionStatus','PUBLISHED_TO_TESTERS'))){
 Invoke-StageCase -Name ('publish-stage-already-'+$sameState[1]) -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -Property $sameState[0] -State $sameState[1] -CrxVersion '1.2.3')) -Requests 2 -ShouldFail $false -Forbid ':publish' -Message 'publish not repeated'
}
Invoke-StageCase -Name 'publish-stage-rejected-same-version-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -Property 'submittedItemRevisionStatus' -State 'REJECTED' -CrxVersion '1.2.3')) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'publish-stage-newer-store-version-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -CrxVersion '1.2.10')) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'publish-stage-other-pending-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -Property 'submittedItemRevisionStatus' -State 'PENDING_REVIEW' -CrxVersion '1.0.0')) -Requests 2 -ShouldFail $true -Forbid ':publish'
foreach($async in 'IN_PROGRESS','FAILED'){
 Invoke-StageCase -Name ('publish-stage-last-upload-'+$async+'-stops') -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -Async $async)) -Requests 2 -ShouldFail $true -Forbid ':publish'
}
Invoke-StageCase -Name 'publish-stage-wrong-identity-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -Identity 'wrong')) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'publish-stage-unknown-status-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus -NoRevision)) -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'publish-stage-first-time-item-allowed' -Stage Publish -Version '1.2.3' -AllowUnpublished -Bodies @($oauth,(New-StageStatus -NoRevision),$published) -Requests 3 -ShouldFail $false -Forbid ':upload' -Require ':publish'
Invoke-StageCase -Name 'publish-stage-status-http-error-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,'HTTP401') -Requests 2 -ShouldFail $true -Forbid ':publish'
Invoke-StageCase -Name 'publish-stage-unconfirmed-response-stops' -Stage Publish -Version '1.2.3' -Bodies @($oauth,(New-StageStatus),$rejected) -Requests 3 -ShouldFail $true -Forbid ':upload'
# 同じpwshで同版を何度も呼べることに加え、別版は別型として動作することを確認する。
$variantRoot=Join-Path $fixtureRoot 'variant'
[IO.Directory]::CreateDirectory($variantRoot)|Out-Null
[IO.File]::Copy("$PSScriptRoot/Publish-Cws.ps1",(Join-Path $variantRoot 'Publish-Cws.ps1'),$true)
$source=[IO.File]::ReadAllText("$PSScriptRoot/CwsPublisher.cs")
[IO.File]::WriteAllText((Join-Path $variantRoot 'CwsPublisher.cs'),$source.Replace('Chrome Web Store accepted version ','Fixture variant accepted version '))
$message=Invoke-BoundaryCase -Name 'different-source-same-pwsh' -Bodies @($oauth,$upload,$published) -Requests 3 -ShouldFail $false -EntryPoint (Join-Path $variantRoot 'Publish-Cws.ps1')
if(!$message.Contains('Fixture variant accepted version ')){throw 'Different publisher source reused a stale type'}
$message=Invoke-BoundaryCase -Name 'original-source-reloaded-same-pwsh' -Bodies @($oauth,$upload,$published) -Requests 3 -ShouldFail $false
if(!$message.Contains('Chrome Web Store accepted version ')){throw 'Original publisher type changed after variant load'}
$driveName='CwsFixture'+[Guid]::NewGuid().ToString('N')
$null=New-PSDrive -Name $driveName -PSProvider FileSystem -Root $fixtureRoot
try{
 Invoke-BoundaryCase -Name 'filesystem-psdrive-archive' -Bodies @($oauth,$upload,$published) -Requests 3 -ShouldFail $false -CaseArchive "${driveName}:/fixture.zip" | Out-Null
}finally{Remove-PSDrive -Name $driveName}
# 子プロセスにも同じ遮断を設定するdriverを用い、-Fileの終了コードを検証する。
$guardPath=Join-Path $fixtureRoot 'CwsFixtureNetworkGuard.cs'
[IO.File]::WriteAllText($guardPath,$guardSource)
$driverPath=Join-Path $fixtureRoot 'native-failure-driver.ps1'
$driver=@'
#requires -Version 7.0
param([string]$EntryPoint,[string]$Archive,[string]$GuardSource)
$ErrorActionPreference='Stop'
Add-Type -Path $GuardSource
$guard=[CwsFixtureNetworkGuard]::new()
[Net.Http.HttpClient]::DefaultProxy=$guard
$probe=[Net.Http.HttpClient]::new()
try {
 $probe.Timeout=[TimeSpan]::FromSeconds(1)
 $blockedError=$false
 try {$probe.GetAsync('https://192.0.2.1/cws-offline-probe').GetAwaiter().GetResult()|Out-Null}catch{$blockedError=$true}
 if($guard.Blocked -lt 1 -or $guard.Connections -lt 1 -or !$blockedError){throw 'Child offline HTTP guard negative probe failed'}
}finally{$probe.Dispose()}
try { & $EntryPoint -Archive $Archive }finally{$guard.Dispose()}
'@
[IO.File]::WriteAllText($driverPath,$driver)
$start=[Diagnostics.ProcessStartInfo]::new((Get-Process -Id $PID).Path)
$start.UseShellExecute=$false;$start.RedirectStandardOutput=$true;$start.RedirectStandardError=$true
foreach($arg in @('-NoProfile','-File',$driverPath,'-EntryPoint',"$PSScriptRoot/Publish-Cws.ps1",'-Archive',$archive,'-GuardSource',$guardPath)){$start.ArgumentList.Add($arg)}
$start.Environment['CLIENT_SECRET']=''
$child=[Diagnostics.Process]::Start($start)
try {
 $stdout=$child.StandardOutput.ReadToEnd();$stderr=$child.StandardError.ReadToEnd();$child.WaitForExit()
 if($child.ExitCode -eq 0 -or !$stderr.Contains('Missing CLIENT_SECRET')){throw 'Publisher -File failure did not return a nonzero exit'}
 if(($stdout+$stderr).Contains('fixture-token') -or ($stdout+$stderr).Contains('refresh')){throw 'Publisher -File error disclosed a credential'}
}finally{$child.Dispose()}
Write-Output 'PASS native-file-failure-exit'
}finally{[Net.Http.HttpClient]::DefaultProxy=$previousProxy;$networkGuard.Dispose()}
