using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

// PS入口がソースSHA-256で名前空間を置換し、同一プロセスで異版を安全に読み込む。
namespace Kagayoi.Cws.__SOURCE_HASH__
{
    public static class Publisher
    {
        public static string Run(string archive, string expectedSha256, bool checkExistingVersion,
            bool allowUnpublishedItem, string existingVersionPolicy, HttpMessageHandler handler)
        {
            var credentials = new Dictionary<string, string>();
            foreach (var key in new[] { "CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "PUBLISHER_ID", "EXTENSION_ID" })
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("Missing " + key);
                credentials[key] = value;
            }
            var itemId = credentials["EXTENSION_ID"];
            if (!Regex.IsMatch(itemId, "^[a-p]{32}$")) throw new InvalidOperationException("Invalid extension ID");

            // verifierが確認したbytesを固定し、hash・manifest・uploadで同じsnapshotを使う。
            using (var file = new MemoryStream(File.ReadAllBytes(archive), false))
            using (var http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }))
            {
                http.Timeout = TimeSpan.FromMinutes(5);
                if (!string.IsNullOrEmpty(expectedSha256))
                {
                    string hash;
                    using (var hasher = SHA256.Create())
                        hash = BitConverter.ToString(hasher.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                    if (hash != expectedSha256.ToLowerInvariant()) throw new InvalidOperationException("ZIP SHA-256 mismatch");
                    file.Position = 0;
                }
                string version;
                using (var zip = new ZipArchive(file, ZipArchiveMode.Read, true))
                {
                    var entries = zip.Entries.Where(entry => entry.FullName == "manifest.json").ToArray();
                    if (entries.Length != 1) throw new InvalidOperationException("Archive must contain one root manifest.json");
                    using (var reader = new StreamReader(entries[0].Open()))
                    using (var manifest = JsonDocument.Parse(reader.ReadToEnd()))
                        version = Text(manifest.RootElement, "version");
                    if (string.IsNullOrEmpty(version)) throw new InvalidOperationException("Manifest version is missing");
                }
                file.Position = 0;
                var request = new HttpRequestMessage(HttpMethod.Post, "https://oauth2.googleapis.com/token");
                request.Content = new FormUrlEncodedContent(new Dictionary<string, string>
                {
                    ["client_id"] = credentials["CLIENT_ID"], ["client_secret"] = credentials["CLIENT_SECRET"],
                    ["refresh_token"] = credentials["REFRESH_TOKEN"], ["grant_type"] = "refresh_token"
                });
                var token = Text(Send(http, "OAuth", request), "access_token");
                if (string.IsNullOrEmpty(token)) throw new InvalidOperationException("OAuth returned no access token");
                try { http.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Bearer", token); }
                catch { throw new InvalidOperationException("OAuth returned an invalid access token"); }
                var name = "publishers/" + Uri.EscapeDataString(credentials["PUBLISHER_ID"]) + "/items/" + itemId;
                var baseUrl = "https://chromewebstore.googleapis.com/v2/" + name;
                if (checkExistingVersion)
                {
                    var status = Send(http, "Preflight", new HttpRequestMessage(HttpMethod.Get, baseUrl + ":fetchStatus"));
                    if (!Identity(status, name, itemId)) throw new InvalidOperationException("Preflight identity mismatch; upload stopped");
                    var revisions = new List<JsonElement>();
                    foreach (var property in new[] { "publishedItemRevisionStatus", "submittedItemRevisionStatus" })
                    {
                        JsonElement revision;
                        if (status.TryGetProperty(property, out revision) && revision.ValueKind != JsonValueKind.Null)
                            revisions.Add(revision);
                    }
                    if (revisions.Count == 0 && !allowUnpublishedItem)
                        throw new InvalidOperationException("CWS revision status is unknown; upload stopped. A confirmed first-time item requires AllowUnpublishedItem.");
                    string matchedState = null;
                    var matchingAccepted = false;
                    foreach (var revision in revisions)
                    {
                        var state = Text(revision, "state");
                        JsonElement channels;
                        if (!IsOneOf(state, "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED", "REJECTED", "CANCELLED")
                            || !revision.TryGetProperty("distributionChannels", out channels) || channels.ValueKind != JsonValueKind.Array
                            || channels.GetArrayLength() == 0)
                            throw new InvalidOperationException("CWS revision status is invalid; upload stopped");
                        foreach (var channel in channels.EnumerateArray())
                        {
                            var channelVersion = Text(channel, "crxVersion");
                            if (channelVersion == null || !Regex.IsMatch(channelVersion, @"^\d+(?:\.\d+){0,3}$"))
                                throw new InvalidOperationException("CWS channel version is unknown; upload stopped");
                            if (channelVersion == version)
                            {
                                if (matchedState == null) matchedState = state;
                                if ((existingVersionPolicy.Equals("Accepted", StringComparison.OrdinalIgnoreCase)
                                        && IsOneOf(state, "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"))
                                    || (existingVersionPolicy.Equals("Published", StringComparison.OrdinalIgnoreCase)
                                        && IsOneOf(state, "PUBLISHED", "PUBLISHED_TO_TESTERS")))
                                {
                                    matchedState = state;
                                    matchingAccepted = true;
                                }
                            }
                        }
                    }
                    if (matchedState != null)
                    {
                        if (matchingAccepted)
                            return "CWS already " + matchedState + ", version " + version + "; no new ZIP submitted. Store/package byte equality was not verified.";
                        throw new InvalidOperationException("CWS version already exists; this ZIP identity cannot be confirmed. Inspect the store before retrying.");
                    }
                }
                request = new HttpRequestMessage(HttpMethod.Post, "https://chromewebstore.googleapis.com/upload/v2/" + name + ":upload");
                request.Content = new StreamContent(file);
                request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/zip");
                var upload = Send(http, "Upload", request);
                if (!Identity(upload, name, itemId)) throw new InvalidOperationException("Upload identity mismatch; publish stopped");
                var uploadState = Text(upload, "uploadState");
                // fetchStatusのlastAsyncUploadStateにはupload UUIDとdraft版が無く、公開の根拠にできない。
                if (IsOneOf(uploadState, "IN_PROGRESS", "UPLOAD_IN_PROGRESS"))
                    throw new InvalidOperationException("Upload is asynchronous; draft version cannot be confirmed by API v2. Publish was not attempted. Inspect the store before continuing.");
                if (!string.Equals(uploadState, "SUCCEEDED", StringComparison.OrdinalIgnoreCase) || Text(upload, "crxVersion") != version)
                    throw new InvalidOperationException("Upload success and version were not confirmed; publish stopped");
                request = new HttpRequestMessage(HttpMethod.Post, baseUrl + ":publish");
                request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                var published = Send(http, "Publish", request);
                if (!Identity(published, name, itemId) || !IsOneOf(Text(published, "state"), "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"))
                    throw new InvalidOperationException("Publish response was not confirmed; inspect store status before retrying");
                return "Chrome Web Store accepted version " + version + ": " + Text(published, "state");
            }
        }

        private static bool IsOneOf(string value, params string[] choices)
        {
            return choices.Any(choice => string.Equals(choice, value, StringComparison.OrdinalIgnoreCase));
        }

        private static string Text(JsonElement value, string property)
        {
            JsonElement result;
            return value.ValueKind == JsonValueKind.Object && value.TryGetProperty(property, out result)
                && result.ValueKind == JsonValueKind.String ? result.GetString() : null;
        }

        private static bool Identity(JsonElement value, string name, string itemId)
        {
            return Text(value, "name") == name && Text(value, "itemId") == itemId;
        }

        private static JsonElement Send(HttpClient http, string stage, HttpRequestMessage request)
        {
            using (request)
            {
                HttpResponseMessage response;
                try { response = http.SendAsync(request).GetAwaiter().GetResult(); }
                catch { throw new InvalidOperationException(stage + " communication failed; outcome unknown. Inspect store status before retrying."); }
                using (response)
                {
                    if (!response.IsSuccessStatusCode)
                        throw new InvalidOperationException(stage + " failed (HTTP " + (int)response.StatusCode + "); inspect store status before retrying.");
                    try
                    {
                        using (var json = JsonDocument.Parse(response.Content.ReadAsStringAsync().GetAwaiter().GetResult()))
                            return json.RootElement.Clone();
                    }
                    catch { throw new InvalidOperationException(stage + " returned an invalid response; outcome unknown."); }
                }
            }
        }
    }
}
