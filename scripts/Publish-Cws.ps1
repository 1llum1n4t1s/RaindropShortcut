#requires -Version 7.0
[CmdletBinding()]
param([Parameter(Mandatory)][string]$Archive, [ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ExpectedSha256, [switch]$CheckExistingVersion, [switch]$AllowUnpublishedItem, [ValidateSet('Fail','Published','Accepted')][string]$ExistingVersionPolicy='Fail', [Net.Http.HttpMessageHandler]$HttpHandler)
$ErrorActionPreference = 'Stop'
# API contract: https://developer.chrome.com/docs/webstore/using-api
foreach ($key in 'CLIENT_ID','CLIENT_SECRET','REFRESH_TOKEN','PUBLISHER_ID','EXTENSION_ID') {
    if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing $key" }
}
if ($env:EXTENSION_ID -cnotmatch '^[a-p]{32}$') { throw 'Invalid extension ID' }
$archivePath = (Resolve-Path -LiteralPath $Archive).Path
$file = [IO.MemoryStream]::new([IO.File]::ReadAllBytes($archivePath), $false)
if (!$HttpHandler) { $HttpHandler = [Net.Http.HttpClientHandler]@{ AllowAutoRedirect = $false } }
$http = [Net.Http.HttpClient]::new($HttpHandler)
$http.Timeout = [TimeSpan]::FromMinutes(5)
try {
    if ($ExpectedSha256) {
        $hasher = [Security.Cryptography.SHA256]::Create()
        try { $hash = [BitConverter]::ToString($hasher.ComputeHash($file)).Replace('-','').ToLowerInvariant() }
        finally { $hasher.Dispose() }
        if ($hash -cne $ExpectedSha256.ToLowerInvariant()) { throw 'ZIP SHA-256 mismatch' }
        $file.Position = 0
    }
    $zip = [IO.Compression.ZipArchive]::new($file, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        $entries = @($zip.Entries | Where-Object FullName -CEQ 'manifest.json')
        if ($entries.Count -ne 1) { throw 'Archive must contain one root manifest.json' }
        $reader = [IO.StreamReader]::new($entries[0].Open())
        try { $manifest = $reader.ReadToEnd() | ConvertFrom-Json } finally { $reader.Dispose() }
        if (!$manifest.version) { throw 'Manifest version is missing' }
    } finally { $zip.Dispose() }
    $file.Position = 0
    function Send-Request([string]$Stage, [Net.Http.HttpRequestMessage]$Request) {
        try {
            try { $response = $http.SendAsync($Request).GetAwaiter().GetResult() }
            catch { throw "$Stage communication failed; outcome unknown. Inspect store status before retrying." }
            try {
                if (!$response.IsSuccessStatusCode) { throw "$Stage failed (HTTP $([int]$response.StatusCode)); inspect store status before retrying." }
                try { return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json -AsHashtable) }
                catch { throw "$Stage returned an invalid response; outcome unknown." }
            } finally { $response.Dispose() }
        } finally { $Request.Dispose() }
    }
    $request = [Net.Http.HttpRequestMessage]::new('POST', 'https://oauth2.googleapis.com/token')
    $form = [Collections.Generic.Dictionary[string,string]]::new()
    $form['client_id']=$env:CLIENT_ID; $form['client_secret']=$env:CLIENT_SECRET
    $form['refresh_token']=$env:REFRESH_TOKEN; $form['grant_type']='refresh_token'
    $request.Content = [Net.Http.FormUrlEncodedContent]::new($form)
    $token = Send-Request 'OAuth' $request
    if (!$token.access_token) { throw 'OAuth returned no access token' }
    $http.DefaultRequestHeaders.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('Bearer', $token.access_token)
    $name = 'publishers/{0}/items/{1}' -f [Uri]::EscapeDataString($env:PUBLISHER_ID), $env:EXTENSION_ID
    $base = "https://chromewebstore.googleapis.com/v2/$name"
    if ($CheckExistingVersion) {
        $status = Send-Request 'Preflight' ([Net.Http.HttpRequestMessage]::new('GET', "${base}:fetchStatus"))
        if ($status.name -cne $name -or $status.itemId -cne $env:EXTENSION_ID) { throw 'Preflight identity mismatch; upload stopped' }
        $revisions = @($status.publishedItemRevisionStatus, $status.submittedItemRevisionStatus) | Where-Object { $null -ne $_ }
        if (!@($revisions).Count -and !$AllowUnpublishedItem) { throw 'CWS revision status is unknown; upload stopped. A confirmed first-time item requires AllowUnpublishedItem.' }
        $matchedState = $null
        $matchingAccepted = $false
        foreach ($revision in $revisions) {
            if ($revision -isnot [Collections.IDictionary] -or $revision.state -notin @('PUBLISHED','PUBLISHED_TO_TESTERS','PENDING_REVIEW','STAGED','REJECTED','CANCELLED') -or $revision.distributionChannels -isnot [array] -or !$revision.distributionChannels.Count) { throw 'CWS revision status is invalid; upload stopped' }
            foreach ($channel in $revision.distributionChannels) {
                if ($channel -isnot [Collections.IDictionary] -or $channel.crxVersion -isnot [string] -or $channel.crxVersion -notmatch '^\d+(?:\.\d+){0,3}$') { throw 'CWS channel version is unknown; upload stopped' }
                if ($channel.crxVersion -ceq $manifest.version) {
                    $acceptedStates = if ($ExistingVersionPolicy -eq 'Accepted') { @('PUBLISHED','PUBLISHED_TO_TESTERS','PENDING_REVIEW','STAGED') } elseif ($ExistingVersionPolicy -eq 'Published') { @('PUBLISHED','PUBLISHED_TO_TESTERS') } else { @() }
                    if (!$matchedState) { $matchedState = $revision.state }
                    if ($revision.state -in $acceptedStates) {
                        $matchedState = $revision.state
                        $matchingAccepted = $true
                    }
                }
            }
        }
        if ($matchedState) {
            if ($matchingAccepted) {
                Write-Output "CWS already $matchedState, version $($manifest.version); no new ZIP submitted. Store/package byte equality was not verified."
                return
            }
            throw 'CWS version already exists; this ZIP identity cannot be confirmed. Inspect the store before retrying.'
        }
    }
    $request = [Net.Http.HttpRequestMessage]::new('POST', "https://chromewebstore.googleapis.com/upload/v2/${name}:upload")
    $request.Content = [Net.Http.StreamContent]::new($file)
    $request.Content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('application/zip')
    $upload = Send-Request 'Upload' $request
    if ($upload.name -cne $name -or $upload.itemId -cne $env:EXTENSION_ID) { throw 'Upload identity mismatch; publish stopped' }
    $state = $upload.uploadState
    $version = $upload.crxVersion
    # fetchStatus has no upload UUID or draft version. Never publish based on
    # lastAsyncUploadState: it can refer to another upload of the same item.
    if ($state -in @('IN_PROGRESS','UPLOAD_IN_PROGRESS')) {
        throw 'Upload is asynchronous; draft version cannot be confirmed by API v2. Publish was not attempted. Inspect the store before continuing.'
    }
    if ($state -ne 'SUCCEEDED' -or $version -cne $manifest.version) { throw 'Upload success and version were not confirmed; publish stopped' }
    $request = [Net.Http.HttpRequestMessage]::new('POST', "${base}:publish")
    $request.Content = [Net.Http.StringContent]::new('{}', [Text.Encoding]::UTF8, 'application/json')
    $published = Send-Request 'Publish' $request
    if ($published.name -cne $name -or $published.itemId -cne $env:EXTENSION_ID -or $published.state -notin @('PUBLISHED','PUBLISHED_TO_TESTERS','PENDING_REVIEW','STAGED')) { throw 'Publish response was not confirmed; inspect store status before retrying' }
    Write-Output "Chrome Web Store accepted version $($manifest.version): $($published.state)"
} finally { $http.Dispose(); $file.Dispose() }
