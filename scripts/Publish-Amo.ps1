#requires -Version 7.0
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
# https://mozilla.github.io/addons-server/topics/api/addons.html
# https://mozilla.github.io/addons-server/topics/api/auth.html
foreach ($key in 'WEB_EXT_API_KEY','WEB_EXT_API_SECRET') {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing $key" }
}
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$metadataValue = Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json -AsHashtable
if (!$metadataValue.version.license -or $metadataValue.version.upload) { throw 'Metadata must supply a license and must not reuse an upload UUID' }
if ($metadataValue.categories -is [array]) { $metadataValue.categories = @{ firefox = $metadataValue.categories } }
# Take one immutable snapshot: hash, manifest verification and multipart upload
# must consume the same bytes even when the filesystem permits concurrent writes.
$file = [IO.MemoryStream]::new([IO.File]::ReadAllBytes($archivePath), $false)
if (!$HttpHandler) { $HttpHandler = [Net.Http.HttpClientHandler]@{ AllowAutoRedirect = $false } }
$http = [Net.Http.HttpClient]::new($HttpHandler)
$http.Timeout = [TimeSpan]::FromMinutes(5)
try {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($hasher.ComputeHash($file)).Replace('-','').ToLowerInvariant() }
    finally { $hasher.Dispose() }
    if ($hash -cne $ExpectedSha256.ToLowerInvariant()) { throw 'XPI SHA-256 mismatch' }
    $file.Position = 0
    $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $entries = @($zip.Entries | Where-Object FullName -CEQ 'manifest.json')
        if ($entries.Count -ne 1) { throw 'XPI must contain one root manifest.json' }
        $reader = [IO.StreamReader]::new($entries[0].Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        $guid = $manifest.browser_specific_settings.gecko.id
        if (!$guid) { $guid = $manifest.applications.gecko.id }
        if ($guid -cne $AddonId -or $manifest.version -cne $ExpectedVersion) { throw 'XPI GUID or version mismatch' }
        if (@($zip.Entries | Where-Object { $_.FullName -match '(^|/)(\.amo-upload-uuid|web-ext-artifacts)(/|$)' }).Count) { throw 'XPI contains upload state' }
    } finally { $zip.Dispose() }
    $file.Position = 0
    function ConvertTo-Base64Url([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
    function Send-Amo([string]$Stage, [Net.Http.HttpRequestMessage]$Request) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $header = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
        $claims = @{ iss=$env:WEB_EXT_API_KEY; iat=$now; exp=$now+60; jti=[Guid]::NewGuid().ToString() } | ConvertTo-Json -Compress
        $payload = ConvertTo-Base64Url ([Text.Encoding]::UTF8.GetBytes($claims))
        $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($env:WEB_EXT_API_SECRET))
        try { $signature = ConvertTo-Base64Url ($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes("$header.$payload"))) } finally { $hmac.Dispose() }
        $Request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('JWT', "$header.$payload.$signature")
        try {
            try { $response = $http.SendAsync($Request).GetAwaiter().GetResult() }
            catch { throw "$Stage communication failed; outcome unknown. Inspect AMO before retrying." }
            try {
                if (!$response.IsSuccessStatusCode) { throw "$Stage failed (HTTP $([int]$response.StatusCode)); inspect AMO before retrying." }
                try { return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable) }
                catch { throw "$Stage returned invalid JSON; outcome unknown." }
            } finally { $response.Dispose() }
        } finally { $Request.Dispose() }
    }
    $origin = 'https://addons.mozilla.org'
    $addonPath = '/api/v5/addons/addon/' + [Uri]::EscapeDataString($AddonId) + '/'
    $versionsPath = $addonPath + 'versions/'
    $next = "${origin}${versionsPath}?filter=all_without_unlisted&page_size=50"
    $seen = [Collections.Generic.HashSet[string]]::new()
    $ids = [Collections.Generic.HashSet[long]]::new()
    $versions = [Collections.Generic.HashSet[string]]::new()
    $count = $null
    while ($next) {
        $uri = [Uri]::new([Uri]$origin, $next)
        if ($uri.GetLeftPart([UriPartial]::Authority) -cne $origin -or $uri.AbsolutePath -cne $versionsPath -or $uri.Query -notmatch '(^|[?&])filter=all_without_unlisted(&|$)' -or !$seen.Add($uri.AbsoluteUri) -or $seen.Count -gt 200) { throw 'Unsafe AMO pagination URL' }
        $page = Send-Amo 'Version lookup' ([Net.Http.HttpRequestMessage]::new('GET', $uri))
        if (!$page.ContainsKey('next') -or $page.results -isnot [array] -or $page.count -isnot [long] -or $page.count -lt 0) { throw 'Invalid AMO version page' }
        if ($null -eq $count) { $count=$page.count } elseif ($count -ne $page.count) { throw 'AMO version count changed' }
        foreach ($version in $page.results) {
            if ($version.id -isnot [long] -or $version.id -le 0 -or !$version.version -or $version.channel -cne 'listed' -or !$ids.Add($version.id) -or !$versions.Add($version.version)) { throw 'Invalid or duplicate AMO version' }
            if ($version.version -ceq $ExpectedVersion) { throw 'AMO version already exists; submitted bytes cannot be verified. Do not resubmit.' }
        }
        if ($page.next -and $page.next -isnot [string]) { throw 'Invalid AMO pagination link' }
        $next = $page.next
    }
    if ($ids.Count -ne $count) { throw 'AMO version pagination incomplete' }
    $request = [Net.Http.HttpRequestMessage]::new('POST', "$origin/api/v5/addons/upload/")
    $form = [Net.Http.MultipartFormDataContent]::new()
    $form.Add([Net.Http.StringContent]::new('listed'), 'channel')
    $content = [Net.Http.StreamContent]::new($file)
    $content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/x-xpinstall')
    $form.Add($content, 'upload', [IO.Path]::GetFileName($archivePath))
    $request.Content = $form
    $upload = Send-Amo 'Upload' $request
    if ($upload.uuid -isnot [string] -or $upload.uuid -notmatch '^[a-fA-F0-9-]{36}$') { throw 'Upload UUID not confirmed; acceptance unknown' }
    $uuid = $upload.uuid
    $deadline = [DateTime]::UtcNow.AddMinutes(15)
    while ($upload.processed -ne $true -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Seconds 10
        $upload = Send-Amo 'Upload validation' ([Net.Http.HttpRequestMessage]::new('GET', "$origin/api/v5/addons/upload/$uuid/"))
        if ($upload.uuid -cne $uuid) { throw 'Upload validation identity mismatch' }
    }
    if ($upload.processed -ne $true -or $upload.valid -ne $true) { throw 'AMO upload did not pass validation; submission stopped' }
    $metadataValue.version.upload = $uuid
    $request = [Net.Http.HttpRequestMessage]::new('PUT', "$origin$addonPath")
    $request.Content = [Net.Http.StringContent]::new(($metadataValue | ConvertTo-Json -Depth 50 -Compress), [Text.Encoding]::UTF8, 'application/json')
    $submitted = Send-Amo 'Submission' $request
    if ($submitted.guid -cne $AddonId -or !$submitted.version.id -or $submitted.version.version -cne $ExpectedVersion -or $submitted.version.channel -cne 'listed') { throw 'Submission identity/version not confirmed; inspect AMO before retrying' }
    Write-Output "AMO accepted GUID=$AddonId version=$ExpectedVersion SHA256=$hash upload=$uuid versionId=$($submitted.version.id); review pending"
} finally { $http.Dispose(); $file.Dispose() }
