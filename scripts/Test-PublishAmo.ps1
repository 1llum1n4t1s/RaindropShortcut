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
using System; using System.Net; using System.Net.Http; using System.Threading; using System.Threading.Tasks; using System.Collections.Generic; using System.Text;
public class AmoFixtureHandler : HttpMessageHandler {
 public Queue<string> Bodies = new Queue<string>(); public List<string> Requests = new List<string>(); public List<string> Auth = new List<string>(); public byte[] Expected; public bool ExactUpload; public string Upload; public string Submission;
 protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) {
  Requests.Add(r.Method+" "+r.RequestUri.AbsoluteUri); Auth.Add(r.Headers.Authorization.ToString());
  if(r.Method==HttpMethod.Post) { var bytes=await r.Content.ReadAsByteArrayAsync(); Upload=Encoding.UTF8.GetString(bytes); for(int i=0;i+Expected.Length<=bytes.Length;i++){bool same=true;for(int j=0;j<Expected.Length;j++){if(bytes[i+j]!=Expected[j]){same=false;break;}}if(same){ExactUpload=true;break;}} }
  if(r.Method==HttpMethod.Put) Submission=await r.Content.ReadAsStringAsync();
  return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Bodies.Dequeue())};
 }
}
"@
$env:WEB_EXT_API_KEY='fixture-issuer';$env:WEB_EXT_API_SECRET='fixture-secret'
$archive=Join-Path $fixtureRoot 'amo-fixture.xpi'; $metadata=Join-Path $fixtureRoot 'metadata.json'
$stream=[IO.File]::Open($archive,'Create');$zip=[IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create)
$writer=[IO.StreamWriter]::new($zip.CreateEntry('manifest.json').Open());$writer.Write('{"version":"1.2.3","browser_specific_settings":{"gecko":{"id":"fixture@example.com"}}}');$writer.Dispose();$zip.Dispose();$stream.Dispose()
'{"categories":["other"],"version":{"license":"MIT"}}' | Set-Content -LiteralPath $metadata
$hash=(Get-FileHash $archive -Algorithm SHA256).Hash.ToLowerInvariant()
foreach($case in 'success','pagination-success','duplicate','external-next','incomplete-pages','invalid-validation','wrong-submit','hash-mismatch','root-state','nested-state','artifact-state','post-verify-change') {
 $handler=[AmoFixtureHandler]::new(); $handler.Expected=[IO.File]::ReadAllBytes($archive)
 $page=@{count=0;next=$null;results=@()}
 if($case -eq 'duplicate'){$page.count=1;$page.results=@(@{id=1;version='1.2.3';channel='listed'})}
 if($case -eq 'external-next'){$page.next='https://evil.example/api/v5/addons/addon/fixture%40example.com/versions/?filter=all_without_unlisted'}
 if($case -eq 'incomplete-pages'){$page.count=1}
 if($case -eq 'pagination-success'){$page.count=2;$page.results=@(@{id=1;version='0.1.0';channel='listed'});$page.next='https://addons.mozilla.org/api/v5/addons/addon/fixture%40example.com/versions/?filter=all_without_unlisted&page=2'}
 $handler.Bodies.Enqueue(($page|ConvertTo-Json -Depth 5 -Compress))
 if($case -eq 'pagination-success'){$handler.Bodies.Enqueue((@{count=2;next=$null;results=@(@{id=2;version='0.2.0';channel='listed'})}|ConvertTo-Json -Depth 5 -Compress))}
 $uuid='12345678-1234-1234-1234-123456789012'
 $handler.Bodies.Enqueue((@{uuid=$uuid;processed=$true;valid=($case -ne 'invalid-validation')}|ConvertTo-Json -Compress))
 $guid=if($case -eq 'wrong-submit'){'wrong'}else{'fixture@example.com'}
 $handler.Bodies.Enqueue((@{guid=$guid;version=@{id=1;version='1.2.3';channel='listed'}}|ConvertTo-Json -Depth 5 -Compress))
 $caseArchive=$archive
 if($case -in @('root-state','nested-state','artifact-state')) {
  $caseArchive=Join-Path $fixtureRoot "$case.xpi"
  [IO.File]::Copy($archive,$caseArchive,$true)
  $z=[IO.Compression.ZipFile]::Open($caseArchive,[IO.Compression.ZipArchiveMode]::Update)
  $name=switch($case){'root-state'{'.amo-upload-uuid'};'nested-state'{'nested/.amo-upload-uuid'};default{'nested/web-ext-artifacts/state'}}
  $null=$z.CreateEntry($name);$z.Dispose()
 }
 if($case -eq 'post-verify-change') {
  $caseArchive=Join-Path $fixtureRoot 'changed-after-verification.xpi'
  [IO.File]::Copy($archive,$caseArchive,$true)
  $z=[IO.Compression.ZipFile]::Open($caseArchive,[IO.Compression.ZipArchiveMode]::Update)
  $writer=[IO.StreamWriter]::new($z.CreateEntry('changed.txt').Open());$writer.Write('changed after verified receipt');$writer.Dispose();$z.Dispose()
 }
 $expectedHash=if($case -eq 'post-verify-change'){$hash}elseif($case -eq 'hash-mismatch'){'0'*64}else{(Get-FileHash $caseArchive -Algorithm SHA256).Hash.ToLowerInvariant()}
 $failed=$false
 try { & "$PSScriptRoot/Publish-Amo.ps1" -Archive $caseArchive -Metadata $metadata -AddonId 'fixture@example.com' -ExpectedVersion '1.2.3' -ExpectedSha256 $expectedHash -HttpHandler $handler } catch {$failed=$true; if($case -eq 'success'){throw}; if($case -in @('root-state','nested-state','artifact-state') -and $_ -notmatch 'XPI contains upload state'){throw}}
 if($failed -ne ($case -notin @('success','pagination-success'))){throw "Unexpected result: $case"}
 $expected=switch($case){'success'{3};'pagination-success'{4};'wrong-submit'{3};'invalid-validation'{2};'hash-mismatch'{0};'root-state'{0};'nested-state'{0};'artifact-state'{0};'post-verify-change'{0};default{1}}
 if($handler.Requests.Count -ne $expected){throw "Unsafe request count $case : $($handler.Requests.Count)"}
 foreach($auth in $handler.Auth){
  $parts=$auth.Substring(4).Split('.')
  $hmac=[Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes('fixture-secret'))
  $signature=[Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes($parts[0]+'.'+$parts[1]))).TrimEnd('=').Replace('+','-').Replace('/','_');$hmac.Dispose()
  if($parts[2] -cne $signature){throw 'JWT signature mismatch'}
 }
 if($case -eq 'success'){
  if($handler.Upload -notmatch 'name=upload' -or $handler.Upload -notmatch 'name=channel' -or !$handler.ExactUpload){throw 'Multipart contents wrong'}
  $body=$handler.Submission|ConvertFrom-Json
  if($body.version.upload -ne $uuid -or $body.version.license -ne 'MIT' -or $body.categories.firefox[0] -ne 'other'){throw 'Metadata changed'}
 }
 Write-Output "PASS $case"
}
