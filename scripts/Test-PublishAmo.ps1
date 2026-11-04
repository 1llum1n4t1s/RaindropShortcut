#requires -Version 7.2
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
public sealed class AmoNoExternalProxy : IWebProxy, IDisposable {
 readonly System.Net.Sockets.TcpListener listener = new System.Net.Sockets.TcpListener(IPAddress.Loopback,0);
 readonly Task loop; readonly Uri endpoint; volatile bool stopping;
 public int Connections; public List<string> Requests = new List<string>(); public ICredentials Credentials {get;set;}
 public AmoNoExternalProxy(){
  listener.Start();endpoint=new Uri("http://127.0.0.1:"+((IPEndPoint)listener.LocalEndpoint).Port);
  loop=Task.Run(async()=>{while(!stopping){System.Net.Sockets.TcpClient client;try{client=await listener.AcceptTcpClientAsync();}catch{break;}
   using(client){Interlocked.Increment(ref Connections);client.ReceiveTimeout=3000;
    try{using var stream=client.GetStream();using var reader=new System.IO.StreamReader(stream,Encoding.ASCII,false,1024,true);
     Requests.Add(reader.ReadLine() ?? "");string line;int size=0;while(!String.IsNullOrEmpty(line=reader.ReadLine())){size+=line.Length;if(size>16384)break;}
     var bytes=Encoding.ASCII.GetBytes("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");stream.Write(bytes,0,bytes.Length);
    }catch{ }
   }
  }});
 }
 public bool IsBypassed(Uri uri) => false;
 public Uri GetProxy(Uri uri) => endpoint;
 public void Dispose(){stopping=true;listener.Stop();loop.GetAwaiter().GetResult();}
}
public class AmoFixtureHandler : HttpMessageHandler {
 public Queue<string> Bodies = new Queue<string>(); public List<string> Requests = new List<string>(); public List<string> Auth = new List<string>(); public byte[] Expected; public bool ExactUpload; public string Upload; public string Submission; public int FailAt, StatusAt, InvalidAt, StatusCode=503;
 protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage r, CancellationToken c) {
  Requests.Add(r.Method+" "+r.RequestUri.AbsoluteUri); Auth.Add(r.Headers.Authorization.ToString());
  if(Requests.Count==FailAt) throw new HttpRequestException("fixture-secret must not escape");
  if(Requests.Count==StatusAt) return new HttpResponseMessage((HttpStatusCode)StatusCode){Content=new StringContent("fixture-secret must not escape")};
  if(Requests.Count==InvalidAt) return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent("fixture-secret invalid JSON")};
  if(r.Method==HttpMethod.Post) { var bytes=await r.Content.ReadAsByteArrayAsync(); Upload=Encoding.UTF8.GetString(bytes); for(int i=0;i+Expected.Length<=bytes.Length;i++){bool same=true;for(int j=0;j<Expected.Length;j++){if(bytes[i+j]!=Expected[j]){same=false;break;}}if(same){ExactUpload=true;break;}} }
  if(r.Method==HttpMethod.Put) Submission=await r.Content.ReadAsStringAsync();
  return new HttpResponseMessage(HttpStatusCode.OK){Content=new StringContent(Bodies.Dequeue())};
 }
}
"@
$previousProxy=[Net.Http.HttpClient]::DefaultProxy
$blockedProxy=[AmoNoExternalProxy]::new()
[Net.Http.HttpClient]::DefaultProxy=$blockedProxy
try {
 # handler の取り違えでも外部へ接続しない。HTTP と CONNECT を所有 proxy が403で拒否する。
 $probe=[Net.Http.HttpClient]::new()
 $probe.Timeout=[TimeSpan]::FromSeconds(10)
 try{
  $response=$probe.GetAsync('http://amo-network-disabled.invalid').GetAwaiter().GetResult()
  try{if([int]$response.StatusCode -ne 403){throw 'HTTP proxy guard did not reject'}}finally{$response.Dispose()}
  $failed=$false
  try{$response=$probe.GetAsync('https://amo-network-disabled.invalid').GetAwaiter().GetResult();$response.Dispose()}catch{$failed=$true}
  if(!$failed -or $blockedProxy.Connections -ne 2 -or
     !$blockedProxy.Requests[0].StartsWith('GET http://amo-network-disabled.invalid/') -or
     !$blockedProxy.Requests[1].StartsWith('CONNECT amo-network-disabled.invalid:443 ')){throw 'HTTP/CONNECT proxy isolation failed'}
 }finally{$probe.Dispose()}
 $proxyConnections=$blockedProxy.Connections
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

# 応答の安全性を公開入口から確認する。失敗後の upload/PUT 再送を許さない。
$versionPath='https://addons.mozilla.org/api/v5/addons/addon/fixture%40example.com/versions/'
foreach($case in 'wrong-path','missing-filter','repeated-page','count-changed','duplicate-id','duplicate-version','lookup-redirect','upload-http','upload-communication','submission-http','invalid-json','invalid-uuid','poll-identity','metadata-reuse','metadata-license','submission-id-string','submission-id-object','submission-id-zero','submission-id-negative','submission-id-decimal','submission-id-boolean') {
 $handler=[AmoFixtureHandler]::new();$handler.Expected=[IO.File]::ReadAllBytes($archive)
 $page=@{count=0;next=$null;results=@()};$extra=$null;$expected=1
 switch($case){
  'wrong-path'{$page.next='https://addons.mozilla.org/other?filter=all_without_unlisted'}
  'missing-filter'{$page.next=$versionPath+'?page=2'}
  'repeated-page'{$page.next=$versionPath+'?filter=all_without_unlisted&page_size=50'}
  'count-changed'{$page.count=1;$page.next=$versionPath+'?filter=all_without_unlisted&page=2';$extra=@{count=2;next=$null;results=@()};$expected=2}
  'duplicate-id'{$page.count=2;$page.results=@(@{id=1;version='0.1';channel='listed'},@{id=1;version='0.2';channel='listed'})}
  'duplicate-version'{$page.count=2;$page.results=@(@{id=1;version='0.1';channel='listed'},@{id=2;version='0.1';channel='listed'})}
  'lookup-redirect'{$handler.StatusAt=1;$handler.StatusCode=302}
  'upload-http'{$handler.StatusAt=2;$expected=2}
  'upload-communication'{$handler.FailAt=2;$expected=2}
  'submission-http'{$handler.StatusAt=3;$expected=3}
  'invalid-json'{$handler.InvalidAt=1}
  'invalid-uuid'{$expected=2}
  'poll-identity'{$expected=3}
  'metadata-reuse'{$expected=0}
  'metadata-license'{$expected=0}
 }
 if($case -like 'submission-id-*'){$expected=3}
 $handler.Bodies.Enqueue(($page|ConvertTo-Json -Depth 5 -Compress))
 if($extra){$handler.Bodies.Enqueue(($extra|ConvertTo-Json -Depth 5 -Compress))}
 $upload=@{uuid=$uuid;processed=$true;valid=$true}
 if($case -eq 'invalid-uuid'){$upload.uuid='../not-a-uuid'}
 if($case -eq 'poll-identity'){$upload.processed=$false}
 $handler.Bodies.Enqueue(($upload|ConvertTo-Json -Compress))
 if($case -eq 'poll-identity'){$handler.Bodies.Enqueue((@{uuid='87654321-4321-4321-4321-210987654321';processed=$true;valid=$true}|ConvertTo-Json -Compress))}
 $submitted=@{guid='fixture@example.com';version=@{id=1;version='1.2.3';channel='listed'}}
 switch($case){
  'submission-id-string'{$submitted.version.id='fixture-secret'}
  'submission-id-object'{$submitted.version.id=@{sensitive='fixture-secret'}}
  'submission-id-zero'{$submitted.version.id=0}
  'submission-id-negative'{$submitted.version.id=-1}
  'submission-id-decimal'{$submitted.version.id=1.5}
  'submission-id-boolean'{$submitted.version.id=$true}
 }
 $handler.Bodies.Enqueue(($submitted|ConvertTo-Json -Depth 5 -Compress))
 $inputMetadata=$metadata
 if($case -like 'metadata-*'){
  $inputMetadata=Join-Path $fixtureRoot "$case.json"
  $value=if($case -eq 'metadata-reuse'){@{version=@{license='MIT';upload=$uuid}}}else{@{version=@{}}}
  $value|ConvertTo-Json -Depth 5|Set-Content -LiteralPath $inputMetadata
 }
 $failed=$false
 try{
  $output=@(& "$PSScriptRoot/Publish-Amo.ps1" -Archive $archive -Metadata $inputMetadata -AddonId 'fixture@example.com' -ExpectedVersion '1.2.3' -ExpectedSha256 $hash -HttpHandler $handler)
  if(($output -join "`n").Contains('fixture-secret')){throw 'Publisher returned sensitive response content'}
 }catch{
  $failed=$true
  if($_.Exception.ToString().Contains('fixture-secret')){throw 'Secret leaked in AMO exception'}
  if($case -eq 'poll-identity' -and $_ -notmatch 'identity mismatch'){throw}
  if($case -like 'submission-id-*' -and $_ -notmatch 'Submission identity/version not confirmed; inspect AMO before retrying'){throw}
 }
 if(!$failed -or $handler.Requests.Count -ne $expected){throw "Unsafe boundary result $case : $($handler.Requests.Count)"}
 Write-Output "PASS $case"
}

# 同一版の再ロードと異なる版のロードを、同じ pwsh プロセスで検証する。
$versioned=Join-Path $fixtureRoot 'versioned-entry'
[IO.Directory]::CreateDirectory($versioned)|Out-Null
$source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Publish-Amo.cs'))
[IO.File]::WriteAllText((Join-Path $versioned 'Publish-Amo.ps1'),[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Publish-Amo.ps1')))
foreach($suffix in '',"`n// alternate version"){
 $variant=$source+$suffix
 [IO.File]::WriteAllText((Join-Path $versioned 'Publish-Amo.cs'),$variant)
 $handler=[AmoFixtureHandler]::new();$handler.Expected=[IO.File]::ReadAllBytes($archive);$handler.Bodies.Enqueue('{"count":0,"next":null,"results":[]}');$handler.Bodies.Enqueue('{"uuid":"12345678-1234-1234-1234-123456789012","processed":true,"valid":false}')
 try{& (Join-Path $versioned 'Publish-Amo.ps1') -Archive $archive -Metadata $metadata -AddonId 'fixture@example.com' -ExpectedVersion '1.2.3' -ExpectedSha256 $hash -HttpHandler $handler;throw 'Expected validation rejection'}catch{if($_ -notmatch 'did not pass validation'){throw}}
 $variantHash=[Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($variant)))
 if(-not ("Kagayoi.Amo_$variantHash.Publisher" -as [type])){throw 'Source version type was not loaded'}
}
Write-Output 'PASS source-version-reload'

# process の cwd と異なる PowerShell 現在地でも相対入力を解決する。
$publisher=Join-Path $PSScriptRoot 'Publish-Amo.ps1'
$handler=[AmoFixtureHandler]::new();$handler.Expected=[IO.File]::ReadAllBytes($archive)
$handler.Bodies.Enqueue('{"count":0,"next":null,"results":[]}')
$handler.Bodies.Enqueue('{"uuid":"12345678-1234-1234-1234-123456789012","processed":true,"valid":true}')
$handler.Bodies.Enqueue('{"guid":"fixture@example.com","version":{"id":7,"version":"1.2.3","channel":"listed"}}')
Push-Location -LiteralPath $fixtureRoot
try{
 if([IO.Path]::GetFullPath([Environment]::CurrentDirectory) -eq [IO.Path]::GetFullPath((Get-Location).Path)){throw 'Relative-path fixture must differ from process cwd'}
 $output=@(& $publisher -Archive './amo-fixture.xpi' -Metadata './metadata.json' -AddonId 'fixture@example.com' -ExpectedVersion '1.2.3' -ExpectedSha256 $hash -HttpHandler $handler)
 if($handler.Requests.Count -ne 3 -or !$handler.ExactUpload -or ($output -join "`n") -notmatch 'versionId=7; review pending$'){throw 'Relative-path submission failed'}
}finally{Pop-Location}
Write-Output 'PASS PowerShell relative input paths'
$driveName='AmoFixture'+[Guid]::NewGuid().ToString('N')
$null=New-PSDrive -Name $driveName -PSProvider FileSystem -Root $fixtureRoot
try{
 $handler=[AmoFixtureHandler]::new();$handler.Expected=[IO.File]::ReadAllBytes($archive)
 $handler.Bodies.Enqueue('{"count":0,"next":null,"results":[]}')
 $handler.Bodies.Enqueue('{"uuid":"12345678-1234-1234-1234-123456789012","processed":true,"valid":true}')
 $handler.Bodies.Enqueue('{"guid":"fixture@example.com","version":{"id":8,"version":"1.2.3","channel":"listed"}}')
 $output=@(& $publisher -Archive "${driveName}:/amo-fixture.xpi" -Metadata "${driveName}:/metadata.json" -AddonId 'fixture@example.com' -ExpectedVersion '1.2.3' -ExpectedSha256 $hash -HttpHandler $handler)
 if($handler.Requests.Count -ne 3 -or !$handler.ExactUpload -or ($output -join "`n") -notmatch 'versionId=8; review pending$'){throw 'FileSystem PSDrive submission failed'}
}finally{Remove-PSDrive -Name $driveName}
Write-Output 'PASS FileSystem PSDrive archive/metadata'
if($blockedProxy.Connections -ne $proxyConnections){throw 'AMO fixture unexpectedly used the network transport'}
Write-Output 'PASS HTTP/CONNECT loopback proxy isolation'
} finally { [Net.Http.HttpClient]::DefaultProxy=$previousProxy; $blockedProxy.Dispose() }
