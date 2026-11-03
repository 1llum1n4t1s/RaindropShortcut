#requires -Version 7.0
$ErrorActionPreference = 'Stop'
function New-AmoClient {
    param([Net.Http.HttpMessageHandler]$HttpHandler)
    if (!$HttpHandler) { $HttpHandler = [Net.Http.HttpClientHandler]@{ AllowAutoRedirect = $false } }
    $client = [Net.Http.HttpClient]::new($HttpHandler)
    $client.Timeout = [TimeSpan]::FromMinutes(5)
    return $client
}
function Invoke-AmoApi {
    param([Net.Http.HttpClient]$Client, [string]$Method, [string]$Path, [hashtable]$Body, [hashtable]$Form)
    if (!$Path.StartsWith('/api/v5/addons/addon/')) { throw 'Unsupported AMO path' }
    foreach ($key in 'AMO_JWT_ISSUER','AMO_JWT_SECRET') {
        if ([string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($key))) { throw "Missing $key" }
    }
    function B64([byte[]]$Bytes) { [Convert]::ToBase64String($Bytes).TrimEnd('=').Replace('+','-').Replace('/','_') }
    for ($attempt=0; $attempt -lt 5; $attempt++) {
        $request = [Net.Http.HttpRequestMessage]::new($Method, "https://addons.mozilla.org$Path")
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
        $header = B64 ([Text.Encoding]::UTF8.GetBytes('{"alg":"HS256","typ":"JWT"}'))
        $payload = B64 ([Text.Encoding]::UTF8.GetBytes((@{iss=$env:AMO_JWT_ISSUER;iat=$now;exp=$now+60;jti=[Guid]::NewGuid().ToString()} | ConvertTo-Json -Compress)))
        $hmac = [Security.Cryptography.HMACSHA256]::new([Text.Encoding]::UTF8.GetBytes($env:AMO_JWT_SECRET))
        try { $signature = B64 ($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes("$header.$payload"))) } finally { $hmac.Dispose() }
        $request.Headers.Authorization = [Net.Http.Headers.AuthenticationHeaderValue]::new('JWT', "$header.$payload.$signature")
        $request.Headers.Accept.ParseAdd('application/json')
        try {
            if ($null -ne $Body) { $request.Content = [Net.Http.StringContent]::new(($Body | ConvertTo-Json -Depth 50 -Compress), [Text.Encoding]::UTF8, 'application/json') }
            elseif ($null -ne $Form) {
                $multipart = [Net.Http.MultipartFormDataContent]::new()
                $request.Content = $multipart
                foreach ($key in $Form.Keys) {
                    if ($Form[$key] -is [IO.FileInfo]) {
                        $content = [Net.Http.StreamContent]::new([IO.File]::OpenRead($Form[$key].FullName))
                        $content.Headers.ContentType = [Net.Http.Headers.MediaTypeHeaderValue]::new('image/png')
                        $multipart.Add($content, $key, $Form[$key].Name)
                    } else { $multipart.Add([Net.Http.StringContent]::new([string]$Form[$key]), $key) }
                }
            }
            try { $response = $Client.SendAsync($request).GetAwaiter().GetResult() }
            catch { throw "AMO $Method communication failed; outcome unknown. Inspect AMO before retrying." }
            try {
                $text = $response.Content.ReadAsStringAsync().GetAwaiter().GetResult()
                if ([int]$response.StatusCode -eq 429 -and $attempt -lt 4) {
                    $wait = 35
                    try { $detail = ($text | ConvertFrom-Json).detail; if ($detail -match '(\d+)\s*seconds?') { $wait=[int]$Matches[1]+5 } } catch {}
                    Write-Output "AMO rate limit; retry in $wait seconds" | Out-Host
                    Start-Sleep -Seconds $wait
                    continue
                }
                if (!$response.IsSuccessStatusCode) { throw "AMO $Method failed (HTTP $([int]$response.StatusCode)); inspect AMO before retrying." }
                if (!$text) { return @{} }
                try { return ($text | ConvertFrom-Json -AsHashtable) } catch { throw "AMO $Method returned invalid JSON; outcome unknown." }
            } finally { $response.Dispose() }
        } finally { $request.Dispose() }
    }
}
Export-ModuleMember -Function New-AmoClient, Invoke-AmoApi
