#!/usr/bin/env node
// Firefox AMO のリスティング情報を JWT 経由で更新するスクリプト。
//
// 使い方:
//   $env:AMO_JWT_ISSUER="user:..."; $env:AMO_JWT_SECRET="..."; node scripts/amo-metadata-update.js
//
// 動作:
//   1. GET /api/v5/addons/addon/{guid}/ で現状確認
//   2. PATCH /api/v5/addons/addon/{guid}/ で name/summary/description/homepage/support_url/default_locale
//      - description は markdown 対応 (見出し / リスト / 強調を活用)
//   3. PATCH /api/v5/addons/addon/{guid}/eula_policy/ で privacy_policy
//      - addon 本体への PATCH では has_privacy_policy フラグが立たない既知問題の回避
//
// 認証: HS256 JWT。Authorization: JWT <token>
// JWT payload: { iss, jti, iat, exp } (exp は 60 秒程度の短命トークン)
// locale コードは BCP 47 厳密 (en は 400 拒否、en-US を使う)

const crypto = require("crypto");
const https = require("https");

const ISS = process.env.AMO_JWT_ISSUER;
const SECRET = process.env.AMO_JWT_SECRET;
// GUID の正本は manifest.json の gecko.id (ハードコード複製による更新漏れ防止)
const GUID = require("../manifest.json").browser_specific_settings.gecko.id;
const HOST = "addons.mozilla.org";

if (!ISS || !SECRET) {
  console.error("❌ AMO_JWT_ISSUER / AMO_JWT_SECRET の環境変数が必要です");
  process.exit(1);
}

const REPO_URL = "https://github.com/1llum1n4t1s/RaindropShortcut";
const PRIVACY_URL = `${REPO_URL}/blob/main/docs/privacy-policy.md`;
const ISSUES_URL = `${REPO_URL}/issues`;

const NAME = {
  ja: "Raindrop Shortcuts",
  "en-US": "Raindrop Shortcuts",
};

// summary は plain text のみ (markdown 非対応)
const SUMMARY = {
  ja: "Raindrop.io のブックマークをツールバーからワンクリックで一覧表示。検索フィルタ・コレクション選択・ダークモード・リンク開き方の切り替えに対応した軽量拡張機能。",
  "en-US": "One-click access to your Raindrop.io bookmarks from the toolbar. Search filter, collection picker, dark mode, and configurable link behavior. Lightweight and privacy-friendly.",
};

// description は markdown 対応 (見出し / リスト / 強調 / リンクが使える)
const DESCRIPTION = {
  ja: [
    "Raindrop.io のブックマークをツールバーからワンクリックで呼び出せる Firefox 拡張機能です。",
    "",
    "### 主な機能",
    "",
    "- **ワンクリック一覧表示** — ツールバーのアイコンをクリックするだけでブックマークがコンパクトに表示",
    "- **コレクション選択** — 表示するフォルダ（コレクション）を設定画面で切り替え可能",
    "- **インクリメンタル検索** — タイトル・ドメイン名でリアルタイム絞り込み",
    "- **ダークモード** — OS 設定に自動追従または手動切り替え",
    "- **リンクの開き方切替** — 新しいタブ／現在のタブを設定で選択",
    "- **高速表示** — ローカルキャッシュから即時表示しバックグラウンドで差分更新",
    "",
    "### プライバシー",
    "",
    "- OAuth 2.0 認証なのでパスワード入力は不要",
    "- 個人情報の外部送信は一切なし",
    "- favicon 取得のためドメイン名のみ Google Favicon Service へ送信",
    "",
    `オープンソース ([MIT License](${REPO_URL}))`,
  ].join("\n"),
  "en-US": [
    "A Firefox extension for one-click access to your Raindrop.io bookmarks from the toolbar.",
    "",
    "### Features",
    "",
    "- **One-click view** — click the toolbar icon to see your bookmarks in a compact list",
    "- **Collection picker** — choose which Raindrop collection to display from settings",
    "- **Incremental search** — instant filter by title and domain name",
    "- **Dark mode** — auto-follow OS theme or manual toggle",
    "- **Link behavior** — open in new tab or current tab (configurable)",
    "- **Fast display** — local cache for instant rendering, refreshed in the background",
    "",
    "### Privacy",
    "",
    "- OAuth 2.0 authentication, no password needed",
    "- No personal data collected or sent externally",
    "- Only the domain name is sent to Google Favicon Service for favicon rendering",
    "",
    `Open source ([MIT License](${REPO_URL}))`,
  ].join("\n"),
};

const PRIVACY_POLICY = {
  ja: [
    "# Raindrop Shortcut プライバシーポリシー",
    "",
    "本拡張機能は個人情報を一切収集しません。",
    "",
    "## ローカルに保存するデータ",
    "",
    "- OAuth アクセストークン／リフレッシュトークン（Raindrop.io 認証用）",
    "- 選択中のコレクション情報",
    "- テーマ設定（自動／ライト／ダーク）",
    "- リンクの開き方設定",
    "- ブックマーク一覧のローカルキャッシュ（TTL 5 分）",
    "",
    "これらは端末内にのみ保存され、Raindrop.io 以外の外部サーバーへの送信は一切ありません。",
    "",
    "## ネットワーク通信",
    "",
    "- **raindrop.io** — OAuth 認証",
    "- **api.raindrop.io** — ブックマーク取得",
    "- **www.google.com** — ブックマークのドメイン名のみ送信（favicon 取得用）",
    "- **fonts.googleapis.com / fonts.gstatic.com** — ポップアップ UI のフォント取得（ユーザーデータは送信しません）",
    "",
    "## 権限の使用目的",
    "",
    "- **identity**: Raindrop.io の OAuth 認証",
    "- **storage**: 設定・キャッシュのローカル保存",
    "- **host_permissions (api.raindrop.io, raindrop.io)**: API 通信",
    "",
    `詳細: ${PRIVACY_URL}`,
  ].join("\n"),
  "en-US": [
    "# Raindrop Shortcut Privacy Policy",
    "",
    "This extension does not collect any personal information.",
    "",
    "## Data stored locally",
    "",
    "- OAuth access / refresh tokens (for Raindrop.io authentication)",
    "- Currently selected collection",
    "- Theme preference (auto / light / dark)",
    "- Link open mode preference",
    "- Bookmark list local cache (TTL 5 minutes)",
    "",
    "All data is stored on your device only and never transmitted to any external server other than Raindrop.io.",
    "",
    "## Network communication",
    "",
    "- **raindrop.io** — OAuth authentication",
    "- **api.raindrop.io** — bookmark retrieval",
    "- **www.google.com** — only the domain name is sent for favicon retrieval",
    "- **fonts.googleapis.com / fonts.gstatic.com** — popup UI fonts (no user data sent)",
    "",
    "## Permission rationale",
    "",
    "- **identity**: Raindrop.io OAuth flow",
    "- **storage**: local storage of settings and cache",
    "- **host_permissions (api.raindrop.io, raindrop.io)**: API communication",
    "",
    `Details: ${PRIVACY_URL}`,
  ].join("\n"),
};

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJWT() {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISS,
    jti: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + 60,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  return `${data}.${sig}`;
}

function rawRequest(method, pathStr, body) {
  return new Promise((resolve, reject) => {
    const token = makeJWT();
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: HOST,
      port: 443,
      path: pathStr,
      method,
      headers: {
        Authorization: `JWT ${token}`,
        Accept: "application/json",
      },
    };
    if (data) {
      opts.headers["Content-Type"] = "application/json";
      opts.headers["Content-Length"] = Buffer.byteLength(data);
    }
    const req = https.request(opts, (res) => {
      let chunks = "";
      res.on("data", (c) => (chunks += c));
      res.on("end", () => {
        let parsed;
        try {
          parsed = chunks ? JSON.parse(chunks) : null;
        } catch (e) {
          parsed = chunks;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// HTTP 429 (rate limited) を自動リトライ。レスポンスの "Expected available in N seconds" を尊重。
async function apiRequest(method, pathStr, body) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await rawRequest(method, pathStr, body);
    if (r.status !== 429) return r;
    const detail = typeof r.body === "object" ? r.body?.detail : "";
    const m = /(\d+)\s*seconds?/i.exec(detail || "");
    const wait = (m ? parseInt(m[1], 10) : 30) + 5; // バッファ +5s
    console.log(`   ⏳ 429: ${wait}s 待機して retry (attempt=${attempt + 1})`);
    await sleep(wait * 1000);
  }
  throw new Error("429 が 5 回連続で続いたので断念");
}

async function main() {
  const guidEnc = encodeURIComponent(GUID);

  console.log("===== 1. GET 現状確認 =====");
  const getResp = await apiRequest("GET", `/api/v5/addons/addon/${guidEnc}/?lang=ja`);
  console.log(`status=${getResp.status}`);
  if (getResp.status !== 200) {
    console.error("❌ GET 失敗:", JSON.stringify(getResp.body, null, 2));
    process.exit(1);
  }
  const cur = getResp.body;
  console.log(`  slug: ${cur.slug}`);
  console.log(`  status: ${cur.status}`);
  console.log(`  default_locale: ${cur.default_locale}`);
  console.log(`  has_privacy_policy: ${cur.has_privacy_policy}`);
  console.log("");

  console.log("===== 2. PATCH addon (name/summary/description/homepage/support_url/default_locale) =====");
  const patchAddon = {
    default_locale: "ja",
    name: NAME,
    summary: SUMMARY,
    description: DESCRIPTION,
    homepage: { ja: REPO_URL, "en-US": REPO_URL },
    support_url: { ja: ISSUES_URL, "en-US": ISSUES_URL },
  };
  const patchResp = await apiRequest("PATCH", `/api/v5/addons/addon/${guidEnc}/`, patchAddon);
  console.log(`status=${patchResp.status}`);
  if (patchResp.status >= 400) {
    console.error("❌ PATCH 失敗:", JSON.stringify(patchResp.body, null, 2));
    process.exit(1);
  }
  console.log("✅ PATCH 成功");
  console.log(`  default_locale: ${patchResp.body.default_locale}`);
  console.log(`  name.ja: ${patchResp.body.name?.ja}`);
  console.log("");

  console.log("===== 3. PATCH eula_policy (privacy_policy 専用エンドポイント) =====");
  const eulaResp = await apiRequest(
    "PATCH",
    `/api/v5/addons/addon/${guidEnc}/eula_policy/`,
    { privacy_policy: PRIVACY_POLICY }
  );
  console.log(`status=${eulaResp.status}`);
  if (eulaResp.status >= 400) {
    console.error("❌ eula_policy PATCH 失敗:", JSON.stringify(eulaResp.body, null, 2));
  } else {
    console.log("✅ eula_policy PATCH 成功");
    console.log(`  privacy_policy.ja preview: ${(eulaResp.body.privacy_policy?.ja || "").slice(0, 80)}...`);
  }
  console.log("");

  console.log("===== 4. GET 反映確認 =====");
  const checkResp = await apiRequest("GET", `/api/v5/addons/addon/${guidEnc}/?lang=ja`);
  if (checkResp.status === 200) {
    const c = checkResp.body;
    console.log(`  default_locale: ${c.default_locale}`);
    console.log(`  name.ja: ${c.name?.ja || c.name?._default}`);
    console.log(`  summary preview: ${(c.summary?.ja || c.summary?._default || "").slice(0, 80)}...`);
    console.log(`  description preview: ${(c.description?.ja || c.description?._default || "").slice(0, 80)}...`);
    console.log(`  homepage: ${c.homepage?.url?.ja || c.homepage?.url?._default || c.homepage}`);
    console.log(`  support_url: ${c.support_url?.ja || c.support_url?._default || c.support_url}`);
    console.log(`  has_privacy_policy: ${c.has_privacy_policy}`);
    console.log(`  categories: ${JSON.stringify(c.categories)}`);
    console.log(`  current_version.license: ${c.current_version?.license?.slug}`);
    console.log(`  status: ${c.status}`);
  }

  console.log("\n🎉 完了。AMO Developer Hub:");
  console.log(`   https://addons.mozilla.org/ja/developers/addon/${cur.slug}/`);
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
