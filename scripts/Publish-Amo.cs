using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using System.Threading;

namespace Kagayoi.AmoSource
{
    // HTTP handler は既存の公開入口から受け取り、検証でも同じ経路を通す。
    public static class Publisher
    {
        const string Origin = "https://addons.mozilla.org";
        static readonly JsonNodeOptions NodeOptions = new JsonNodeOptions { PropertyNameCaseInsensitive = false };
        static JsonNode Parse(string value) => JsonNode.Parse(value, NodeOptions);
        static JsonNode Get(JsonNode node, string key) => node is JsonObject ? node[key] : null;
        static string Text(JsonNode node, string key) => Get(node, key) is JsonValue value && value.TryGetValue<string>(out var text) ? text : null;
        static bool True(JsonNode node, string key) => Get(node, key) is JsonValue value && value.TryGetValue<bool>(out var b) && b;
        static bool Integer(JsonNode node, string key, out long result)
        {
            result = 0;
            return Get(node, key) is JsonValue value && value.TryGetValue<long>(out result);
        }
        static bool Truthy(JsonNode value)
        {
            if (value == null) return false;
            if (value is JsonValue scalar)
            {
                if (scalar.TryGetValue<string>(out var s)) return !String.IsNullOrEmpty(s);
                if (scalar.TryGetValue<bool>(out var b)) return b;
                if (scalar.TryGetValue<long>(out var n)) return n != 0;
            }
            return true;
        }
        static string Base64Url(byte[] bytes) => Convert.ToBase64String(bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_');
        static JsonNode Send(HttpClient http, string stage, HttpRequestMessage request)
        {
            using (request)
            {
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                var header = Base64Url(Encoding.UTF8.GetBytes("{\"alg\":\"HS256\",\"typ\":\"JWT\"}"));
                var claims = new JsonObject { ["iss"] = Environment.GetEnvironmentVariable("WEB_EXT_API_KEY"), ["iat"] = now, ["exp"] = now + 60, ["jti"] = Guid.NewGuid().ToString() };
                var payload = Base64Url(Encoding.UTF8.GetBytes(claims.ToJsonString()));
                using var hmac = new HMACSHA256(Encoding.UTF8.GetBytes(Environment.GetEnvironmentVariable("WEB_EXT_API_SECRET")));
                var signature = Base64Url(hmac.ComputeHash(Encoding.ASCII.GetBytes(header + "." + payload)));
                request.Headers.Authorization = new AuthenticationHeaderValue("JWT", header + "." + payload + "." + signature);
                HttpResponseMessage response;
                try { response = http.SendAsync(request).GetAwaiter().GetResult(); }
                catch { throw new InvalidOperationException(stage + " communication failed; outcome unknown. Inspect AMO before retrying."); }
                using (response)
                {
                    if (!response.IsSuccessStatusCode) throw new InvalidOperationException(stage + " failed (HTTP " + (int)response.StatusCode + "); inspect AMO before retrying.");
                    try { return Parse(response.Content.ReadAsStringAsync().GetAwaiter().GetResult()) ?? throw new Exception(); }
                    catch { throw new InvalidOperationException(stage + " returned invalid JSON; outcome unknown."); }
                }
            }
        }
        public static string Publish(string archive, string metadata, string addonId, string expectedVersion, string expectedSha256, HttpMessageHandler handler)
        {
            foreach (var key in new[] { "WEB_EXT_API_KEY", "WEB_EXT_API_SECRET" })
                if (String.IsNullOrWhiteSpace(Environment.GetEnvironmentVariable(key))) throw new InvalidOperationException("Missing " + key);
            var archivePath = Path.GetFullPath(archive);
            var metadataValue = Parse(File.ReadAllText(metadata));
            var versionMetadata = Get(metadataValue, "version");
            if (!Truthy(Get(versionMetadata, "license")) || Truthy(Get(versionMetadata, "upload")))
                throw new InvalidOperationException("Metadata must supply a license and must not reuse an upload UUID");
            if (Get(metadataValue, "categories") is JsonArray categories)
            {
                metadataValue["categories"] = null;
                metadataValue["categories"] = new JsonObject { ["firefox"] = categories };
            }
            // hash・manifest・multipart はファイルの同じ不変スナップショットを使う。
            var bytes = File.ReadAllBytes(archivePath);
            using var http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false });
            http.Timeout = TimeSpan.FromMinutes(5);
            var hash = Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
            if (!String.Equals(hash, expectedSha256, StringComparison.OrdinalIgnoreCase)) throw new InvalidOperationException("XPI SHA-256 mismatch");
            using (var file = new MemoryStream(bytes, false))
            using (var zip = new ZipArchive(file, ZipArchiveMode.Read))
            {
                var manifests = zip.Entries.Where(entry => entry.FullName == "manifest.json").ToArray();
                if (manifests.Length != 1) throw new InvalidOperationException("XPI must contain one root manifest.json");
                using var reader = new StreamReader(manifests[0].Open());
                var manifest = JsonNode.Parse(reader.ReadToEnd(), new JsonNodeOptions { PropertyNameCaseInsensitive = true });
                var guid = Text(Get(Get(manifest, "browser_specific_settings"), "gecko"), "id");
                if (String.IsNullOrEmpty(guid)) guid = Text(Get(Get(manifest, "applications"), "gecko"), "id");
                if (guid != addonId || Text(manifest, "version") != expectedVersion) throw new InvalidOperationException("XPI GUID or version mismatch");
                if (zip.Entries.Any(entry => Regex.IsMatch(entry.FullName, @"(^|/)(\.amo-upload-uuid|web-ext-artifacts)(/|$)", RegexOptions.IgnoreCase)))
                    throw new InvalidOperationException("XPI contains upload state");
            }
            var addonPath = "/api/v5/addons/addon/" + Uri.EscapeDataString(addonId) + "/";
            var versionsPath = addonPath + "versions/";
            string next = Origin + versionsPath + "?filter=all_without_unlisted&page_size=50";
            var seen = new HashSet<string>();
            var ids = new HashSet<long>();
            var versions = new HashSet<string>();
            long? count = null;
            while (!String.IsNullOrEmpty(next))
            {
                var uri = new Uri(new Uri(Origin), next);
                if (uri.GetLeftPart(UriPartial.Authority) != Origin || uri.AbsolutePath != versionsPath ||
                    !Regex.IsMatch(uri.Query, @"(^|[?&])filter=all_without_unlisted(&|$)", RegexOptions.IgnoreCase) || !seen.Add(uri.AbsoluteUri) || seen.Count > 200)
                    throw new InvalidOperationException("Unsafe AMO pagination URL");
                var page = Send(http, "Version lookup", new HttpRequestMessage(HttpMethod.Get, uri));
                if (!(page is JsonObject pageObject) || !pageObject.ContainsKey("next") || !(Get(page, "results") is JsonArray results) || !Integer(page, "count", out var pageCount) || pageCount < 0)
                    throw new InvalidOperationException("Invalid AMO version page");
                if (count == null) count = pageCount;
                else if (count != pageCount) throw new InvalidOperationException("AMO version count changed");
                foreach (var version in results)
                {
                    var number = Text(version, "version");
                    if (!Integer(version, "id", out var id) || id <= 0 || String.IsNullOrEmpty(number) || Text(version, "channel") != "listed" || !ids.Add(id) || !versions.Add(number))
                        throw new InvalidOperationException("Invalid or duplicate AMO version");
                    if (number == expectedVersion) throw new InvalidOperationException("AMO version already exists; submitted bytes cannot be verified. Do not resubmit.");
                }
                if (Truthy(Get(page, "next")) && Text(page, "next") == null) throw new InvalidOperationException("Invalid AMO pagination link");
                next = Text(page, "next");
            }
            if (ids.Count != count) throw new InvalidOperationException("AMO version pagination incomplete");
            var uploadRequest = new HttpRequestMessage(HttpMethod.Post, Origin + "/api/v5/addons/upload/");
            var form = new MultipartFormDataContent();
            form.Add(new StringContent("listed"), "channel");
            var content = new ByteArrayContent(bytes);
            content.Headers.ContentType = new MediaTypeHeaderValue("application/x-xpinstall");
            form.Add(content, "upload", Path.GetFileName(archivePath));
            uploadRequest.Content = form;
            var upload = Send(http, "Upload", uploadRequest);
            var uuid = Text(upload, "uuid");
            if (uuid == null || !Regex.IsMatch(uuid, @"^[a-fA-F0-9-]{36}$")) throw new InvalidOperationException("Upload UUID not confirmed; acceptance unknown");
            var deadline = DateTime.UtcNow.AddMinutes(15);
            while (!True(upload, "processed") && DateTime.UtcNow < deadline)
            {
                Thread.Sleep(10000);
                upload = Send(http, "Upload validation", new HttpRequestMessage(HttpMethod.Get, Origin + "/api/v5/addons/upload/" + uuid + "/"));
                if (Text(upload, "uuid") != uuid) throw new InvalidOperationException("Upload validation identity mismatch");
            }
            if (!True(upload, "processed") || !True(upload, "valid")) throw new InvalidOperationException("AMO upload did not pass validation; submission stopped");
            versionMetadata["upload"] = uuid;
            var submission = new HttpRequestMessage(HttpMethod.Put, Origin + addonPath);
            submission.Content = new StringContent(metadataValue.ToJsonString(), Encoding.UTF8, "application/json");
            var submitted = Send(http, "Submission", submission);
            var submittedVersion = Get(submitted, "version");
            if (Text(submitted, "guid") != addonId || !Integer(submittedVersion, "id", out var submittedId) || submittedId <= 0 || Text(submittedVersion, "version") != expectedVersion || Text(submittedVersion, "channel") != "listed")
                throw new InvalidOperationException("Submission identity/version not confirmed; inspect AMO before retrying");
            return "AMO accepted GUID=" + addonId + " version=" + expectedVersion + " SHA256=" + hash + " upload=" + uuid + " versionId=" + submittedId.ToString(System.Globalization.CultureInfo.InvariantCulture) + "; review pending";
        }
    }
}
