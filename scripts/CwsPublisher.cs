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
        // stage: Upload=検証済みZIPのアップロードのみ / Publish=申請(:publish)のみ / All=従来どおり連続実行。
        // Publishはzipを持たないため、対象版は expectedVersion(workflow入力)で受け取る。
        public static string Run(string archive, string expectedSha256, bool checkExistingVersion,
            bool allowUnpublishedItem, string existingVersionPolicy, HttpMessageHandler handler,
            string stage, string expectedVersion)
        {
            if (!IsOneOf(stage, "Upload", "Publish", "All")) throw new InvalidOperationException("Stage must be Upload, Publish or All");
            var submitOnly = string.Equals(stage, "Publish", StringComparison.OrdinalIgnoreCase);
            var uploadOnly = string.Equals(stage, "Upload", StringComparison.OrdinalIgnoreCase);
            if (submitOnly)
            {
                // 申請段はZIPを扱わない。ZIP関連の引数が残っていれば、誤った段を呼んだとみなして通信前に止める。
                if (!string.IsNullOrEmpty(archive) || !string.IsNullOrEmpty(expectedSha256))
                    throw new InvalidOperationException("Publish stage does not take an archive");
                if (string.IsNullOrEmpty(expectedVersion) || !Regex.IsMatch(expectedVersion, @"^\d+(?:\.\d+){0,3}$"))
                    throw new InvalidOperationException("Publish stage requires a valid -Version");
            }
            else
            {
                if (string.IsNullOrEmpty(archive)) throw new InvalidOperationException("Archive is required for the " + stage + " stage");
                if (!string.IsNullOrEmpty(expectedVersion)) throw new InvalidOperationException("-Version is only valid for the Publish stage");
            }
            var credentials = new Dictionary<string, string>();
            foreach (var key in new[] { "CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN", "PUBLISHER_ID", "EXTENSION_ID" })
            {
                var value = Environment.GetEnvironmentVariable(key);
                if (string.IsNullOrWhiteSpace(value)) throw new InvalidOperationException("Missing " + key);
                credentials[key] = value;
            }
            var itemId = credentials["EXTENSION_ID"];
            if (!Regex.IsMatch(itemId, "^[a-p]{32}$")) throw new InvalidOperationException("Invalid extension ID");

            // verifierが確認したbytesを固定し、hash・manifest・uploadで同じsnapshotを使う。Publish段はZIPを持たない。
            using (var file = submitOnly ? null : new MemoryStream(File.ReadAllBytes(archive), false))
            using (var http = new HttpClient(handler ?? new HttpClientHandler { AllowAutoRedirect = false }))
            {
                http.Timeout = TimeSpan.FromMinutes(5);
                var version = expectedVersion;
                if (!submitOnly)
                {
                    if (!string.IsNullOrEmpty(expectedSha256))
                    {
                        string hash;
                        using (var hasher = SHA256.Create())
                            hash = BitConverter.ToString(hasher.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                        if (hash != expectedSha256.ToLowerInvariant()) throw new InvalidOperationException("ZIP SHA-256 mismatch");
                        file.Position = 0;
                    }
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
                }
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
                if (submitOnly) return SubmitOnly(http, name, itemId, baseUrl, version, allowUnpublishedItem);
                if (checkExistingVersion)
                {
                    var status = Send(http, "Preflight", new HttpRequestMessage(HttpMethod.Get, baseUrl + ":fetchStatus"));
                    if (!Identity(status, name, itemId)) throw new InvalidOperationException("Preflight identity mismatch; upload stopped");
                    var revisions = ReadRevisions(status, allowUnpublishedItem, "upload");
                    string matchedState = null;
                    var matchingAccepted = false;
                    foreach (var revision in revisions)
                    {
                        foreach (var channelVersion in revision.Versions)
                        {
                            if (channelVersion == version)
                            {
                                if (matchedState == null) matchedState = revision.State;
                                if ((existingVersionPolicy.Equals("Accepted", StringComparison.OrdinalIgnoreCase)
                                        && IsOneOf(revision.State, "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"))
                                    || (existingVersionPolicy.Equals("Published", StringComparison.OrdinalIgnoreCase)
                                        && IsOneOf(revision.State, "PUBLISHED", "PUBLISHED_TO_TESTERS")))
                                {
                                    matchedState = revision.State;
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
                // Upload段はここで終了する。申請は別workflow(Publish段)で、掲載画像などを整えた後に行う。
                if (uploadOnly)
                    return "Chrome Web Store uploaded version " + version + " as a draft; NOT submitted for review. Run the Publish stage after the store listing is ready.";
                return Submit(http, name, itemId, baseUrl, version);
            }
        }

        // 申請(:publish)のみ。API v2は未申請の下書き版を返さないため、下書きの版そのものは確認できない。
        // 代わりに、fetchStatusで確認できる範囲(identity・非同期upload状態・公開/申請中の版)を満たす場合だけ送る。
        // 「対象版の下書きが同一commitのUpload段で作られたこと」は呼び出し側workflowが実行履歴で確認する。
        private static string SubmitOnly(HttpClient http, string name, string itemId, string baseUrl, string version, bool allowUnpublishedItem)
        {
            var status = Send(http, "Preflight", new HttpRequestMessage(HttpMethod.Get, baseUrl + ":fetchStatus"));
            if (!Identity(status, name, itemId)) throw new InvalidOperationException("Preflight identity mismatch; publish stopped");
            var asyncState = Text(status, "lastAsyncUploadState");
            if (IsOneOf(asyncState, "IN_PROGRESS", "UPLOAD_IN_PROGRESS", "FAILED"))
                throw new InvalidOperationException("CWS last upload is " + asyncState + "; publish stopped. Inspect the store before continuing.");
            var revisions = ReadRevisions(status, allowUnpublishedItem, "publish");
            foreach (var revision in revisions)
            {
                // 別版が審査中・公開待ちのまま申請すると、どの下書きが送られるか判断できない。
                if (IsOneOf(revision.State, "PENDING_REVIEW", "STAGED") && !revision.Versions.Contains(version))
                    throw new InvalidOperationException("CWS has another version in " + revision.State + "; publish stopped. Inspect the store before continuing.");
                foreach (var channelVersion in revision.Versions)
                {
                    var order = CompareVersions(channelVersion, version);
                    if (order > 0)
                        throw new InvalidOperationException("CWS already has newer version " + channelVersion + "; publish stopped.");
                    if (order == 0)
                    {
                        // 同版が申請済み・公開済みなら再送しない。再実行しても二重申請にならない。
                        if (IsOneOf(revision.State, "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"))
                            return "CWS already " + revision.State + ", version " + version + "; publish not repeated.";
                        throw new InvalidOperationException("CWS version " + version + " is " + revision.State + "; publish stopped. Upload a new version.");
                    }
                }
            }
            return Submit(http, name, itemId, baseUrl, version);
        }

        private static string Submit(HttpClient http, string name, string itemId, string baseUrl, string version)
        {
            var request = new HttpRequestMessage(HttpMethod.Post, baseUrl + ":publish");
            request.Content = new StringContent("{}", Encoding.UTF8, "application/json");
            var published = Send(http, "Publish", request);
            if (!Identity(published, name, itemId) || !IsOneOf(Text(published, "state"), "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED"))
                throw new InvalidOperationException("Publish response was not confirmed; inspect store status before retrying");
            return "Chrome Web Store accepted version " + version + ": " + Text(published, "state");
        }

        private sealed class Revision
        {
            public string State;
            public List<string> Versions = new List<string>();
        }

        // fetchStatusの公開済み/提出済みrevisionを検証して読む。未知のstate・版は安全側で停止する。
        private static List<Revision> ReadRevisions(JsonElement status, bool allowUnpublishedItem, string stopped)
        {
            var result = new List<Revision>();
            var found = 0;
            foreach (var property in new[] { "publishedItemRevisionStatus", "submittedItemRevisionStatus" })
            {
                JsonElement revision;
                if (!status.TryGetProperty(property, out revision) || revision.ValueKind == JsonValueKind.Null) continue;
                found++;
                var state = Text(revision, "state");
                JsonElement channels;
                if (!IsOneOf(state, "PUBLISHED", "PUBLISHED_TO_TESTERS", "PENDING_REVIEW", "STAGED", "REJECTED", "CANCELLED")
                    || !revision.TryGetProperty("distributionChannels", out channels) || channels.ValueKind != JsonValueKind.Array
                    || channels.GetArrayLength() == 0)
                    throw new InvalidOperationException("CWS revision status is invalid; " + stopped + " stopped");
                var item = new Revision { State = state };
                foreach (var channel in channels.EnumerateArray())
                {
                    var channelVersion = Text(channel, "crxVersion");
                    if (channelVersion == null || !Regex.IsMatch(channelVersion, @"^\d+(?:\.\d+){0,3}$"))
                        throw new InvalidOperationException("CWS channel version is unknown; " + stopped + " stopped");
                    item.Versions.Add(channelVersion);
                }
                result.Add(item);
            }
            if (found == 0 && !allowUnpublishedItem)
                throw new InvalidOperationException("CWS revision status is unknown; " + stopped + " stopped. A confirmed first-time item requires AllowUnpublishedItem.");
            return result;
        }

        // 版は最大4要素の数値。足りない要素は0として比較する。
        private static int CompareVersions(string left, string right)
        {
            var a = left.Split('.').Select(int.Parse).ToArray();
            var b = right.Split('.').Select(int.Parse).ToArray();
            for (var i = 0; i < Math.Max(a.Length, b.Length); i++)
            {
                var x = i < a.Length ? a[i] : 0;
                var y = i < b.Length ? b[i] : 0;
                if (x != y) return x < y ? -1 : 1;
            }
            return 0;
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
