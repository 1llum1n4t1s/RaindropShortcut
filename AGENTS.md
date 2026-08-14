# AGENTS.md

This file provides guidance to Codex and other coding agents working in this repository.

## Project Overview

Raindrop Shortcut は Chrome / Firefox 拡張機能 (Manifest V3)。Raindrop.io の特定コレクション内ブックマークをワンクリックで一覧表示する。OAuth 2.0 認証、コレクション選択、ローカル検索フィルタ、ダークモード、リンク開き方選択、ローカルキャッシュによる高速表示に対応。UI は日本語。単一の `manifest.json` で Chrome (Service Worker) / Firefox 128+ (event page) 両方をサポートする。

## Build Commands

```bash
pnpm run build                 # アイコン PNG + ストア画像を一括生成
pnpm test                      # Node.js 組み込みテストを実行
pnpm run generate-icons        # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
pnpm run generate-screenshots  # webstore/0x-*.html → webstore/images/*.png (puppeteer)
```

パッケージ作成:
```bash
powershell -ExecutionPolicy Bypass -File zip.ps1   # raindrop-shortcut.zip を生成
bash zip.sh                                        # 同等 (bash 版)
```

テストは Node.js 組み込みの `node:test` を使用。ブラウザ統合の最終動作確認は `chrome://extensions` に拡張機能を読み込んで手動テスト。

## Source Layout

```
src/
├── popup/              # ポップアップ UI (popup.html / popup.js / popup.css)
├── background/         # Service Worker (background.js) — OAuth 認証情報を保持
└── lib/                # 共有定数 (actions.js) — popup / background 両方から読み込む
icons/                  # 拡張機能アイコン (SVG 原本 + 生成 PNG)
webstore/               # Chrome Web Store / Firefox AMO 掲載画像テンプレート + 掲載文言
docs/                   # privacy-policy.md など
scripts/                # 開発用スクリプト
  ├── generate-icons.js          # icons/icon.svg → PNG (sharp)
  ├── amo-metadata-update.js     # AMO API v5 で name/summary/description/privacy_policy を一括 PATCH
  └── amo-previews-upload.js     # AMO previews multipart upload (rate limit 重く実用は Dev Hub 手動)
.github/workflows/      # publish.yml (Chrome Web Store + Firefox AMO の自動公開)
.amo-metadata.json      # AMO 提出時の categories + version.license (web-ext sign が読む)
```

`src/lib/actions.js` は popup の `<script>` タグと background の `importScripts()` の双方から読まれる前提で、モジュール構文を使わずグローバル定数 (`Actions`, `StorageKeys`, `SharedConfig`, `TokenStorageKeys`, `LinkOpenMode`, `ThemeMode`, `Screens`) を `Object.freeze` で定義する。この従来スクリプト形式を維持し、ES module 化はしない。

**OAuth 認証情報 (CLIENT_ID / CLIENT_SECRET / エンドポイント URL 等) は `src/background/background.js` 内の `OAuthConfig` で保持**し、popup 側は sendMessage 経由で間接利用する（認証情報を popup に露出させない）。ただし Chrome 拡張の配布 ZIP は公開されるため client_secret は構造的に漏洩する。Raindrop.io が PKCE を提供していないことによる既知の制約。

**`manifest.json` の `key` フィールドは拡張機能の公開鍵** (Chrome Web Store が署名に使うものを埋め込み済)。これによりローカル読み込み時の Extension ID が本番 (`jdehenbjjipaibjccdblhdhffmlggdnp`) と一致し、`chrome.identity.getRedirectURL()` の値も一致する → Raindrop.io に redirect URI を二重登録する必要がない。公開鍵なので漏洩リスクはない。ストアへのアップロード時は `zip.ps1` / `zip.sh` / `publish.yml` が manifest から `key` を除去する (ストア側が署名鍵を管理するため実質不要)。

## Architecture

popup.js が `chrome.runtime.sendMessage` で background.js (Service Worker) と通信する。API 呼び出しとトークン管理は全て background 側に集約されている。

```
popup.js ──msg──▶ background.js (Service Worker)
                      ├── OAuth (chrome.identity.launchWebAuthFlow) — state 検証あり
                      ├── Token 管理 (期限5分前に自動リフレッシュ、Promise coalescing で並行重複防止)
                      └── Raindrop.io API 呼び出し (apiFetch、AbortSignal.timeout 付き)

src/lib/actions.js = 共有定数
  - popup.html が <script src="../lib/actions.js"> で読み込む
  - Chrome (Service Worker) は background.js 内の importScripts() で読み込む
  - Firefox (event page) は manifest.json の background.scripts 列挙で先にロードされるので
    background.js は importScripts を `typeof importScripts === "function"` で guard して skip する
```

### メッセージフロー

| Action | 方向 | 用途 |
|--------|------|------|
| `CHECK_AUTH` | popup→bg | 認証状態確認 |
| `LOGIN` | popup→bg | OAuth フロー開始 (state パラメータで CSRF 防御) |
| `LOGOUT` | popup→bg | トークン削除 |
| `GET_COLLECTIONS` | popup→bg | コレクション一覧取得 (ルート + 子ツリー) |
| `GET_BOOKMARKS` | popup→bg | 選択コレクションの全ブックマーク取得 + キャッシュ更新 |

`onMessage` リスナーは `sender.id === chrome.runtime.id` のメッセージのみ処理し、それ以外（外部拡張からのメッセージ）は無視する (セッション破壊防止)。

### Popup
3画面構成 (ログイン / メイン / 設定)。画面切替は各 `<div class="screen">` の `hidden` 属性を切り替えるだけ。メイン画面はヘッダー、検索バー、ブックマーク一覧。クリックで設定に応じて新しいタブ / 現在のタブで開く。

**ブックマーク読み込み**: background が初回の 1 ページで `count` を取得 → 残ページを並列 fetch (concurrency=6) → 最終ソートは 1 回だけ (`Intl.Collator("ja")`)。popup は完成済み一覧を受け取り、検索フィルタ用に正規化済み `_titleLower` / `_domainLower` を付加して filter 内の `toLowerCase()` 呼び出しを回避。

**ローカルキャッシュ**: 選択中コレクション ID とブックマーク一覧を `chrome.storage.local` に保存。background はブラウザ起動時、コレクション変更時、5 分間隔の `chrome.alarms` で事前更新する。popup 再表示時は選択 ID が一致するキャッシュを即時レンダリングし、ネットワーク取得を待たない。

### Background
Service Worker。OAuth 2.0 フロー (`chrome.identity.launchWebAuthFlow` + state 検証)、アクセストークン管理 (期限5分前に自動リフレッシュ、`refreshPromise` による Promise coalescing で並行競合回避)、Raindrop.io API 呼び出し (`apiFetch` で Authorization ヘッダー自動付与)。`fetchWithTimeout()` で全 fetch に `AbortSignal.timeout(15s)` を付与。

コレクション突合は `Map<parent_id, child[]>` でバケット化して O(R+C)。`Intl.Collator` はモジュールスコープで 1 回だけ生成。

### テーマ (popup.css)
CSS カスタムプロパティでライト/ダーク切替。`auto` = OS 追従、`light`/`dark` = `<html>` にクラス付与で強制。

### ストア画像 (webstore/)
`01-*.html` 〜 `05-*.html` が HTML テンプレート。`generate-screenshots.js` が puppeteer で PNG 出力。`store-listing.txt` は Chrome Web Store 掲載情報のコピペ用。

## Storage Schema

```
chrome.storage.local:
  accessToken        - OAuth アクセストークン
  refreshToken      - OAuth リフレッシュトークン
  tokenExpiry        - トークン有効期限 (Date.now() + expires_in * 1000)
  selectedCollection - { _id, title } | null
  themeMode          - "auto" | "light" | "dark"
  linkOpenMode       - "newTab" | "current"
  bookmarksCache    - { collectionId, savedAt, items[] } (選択中コレクション、5分ごとに更新)
```

## Important Patterns

- **API 呼び出しは全て background.js に集約** — popup.js は `sendMessage()` で間接的に呼ぶ。
- **401 エラー時は自動ログアウト** — `apiFetch()` が 401 を検知したらトークン削除して `{ error: "unauthorized" }` を返す。
- **ネットワーク断と認証失敗を区別** — `apiFetch` / `refreshAccessToken` は network エラーを `{ error: "network" }` として分離返却し、popup は「ログイン画面に戻す」ではなく「ネットワークエラー表示」にする。
- **Promise coalescing によるトークン更新競合回避** — `refreshPromise` モジュール変数で並行リフレッシュを単一化。
- **コレクション階層は2段階** — ルート (`/collections`) + 子 (`/collections/childrens`) を並行取得し `Map<parent.$id, []>` で O(R+C) 突合。
- **検索はローカルフィルタ** — `_titleLower` / `_domainLower` を事前計算し毎回の `toLowerCase()` を回避。
- **並列ページ取得** — background の `fetchAllBookmarks` が `count` から総ページ数を算出し `Promise.all` + concurrency=6 で並列取得。
- **事前取得と定期更新** — browser 起動・コレクション変更・5分間隔の alarm で選択中コレクションを更新。同じコレクションへの並行取得は Promise coalescing で単一化。
- **loadGeneration カウンタ** — コレクション切り替え時に古い非同期ロードをキャンセル。生成番号が変わったら即 `resetLoading()` して return。
- **handler() の catch** — `chrome.runtime.onMessage` の非同期 handler は `.catch(e => sendResponse({ error: e.message }))` で reject 時も必ず応答。
- **favicon は Google Favicon Service** — `FAVICON_SIZE` 定数で URL と DOM 属性を一元化。プライバシーポリシーに開示済。
- **zip.ps1 / zip.sh の除外ルール** — `scripts/` (開発専用)、`node_modules`、`webstore`、`package*.json`、`icons/icon.svg` (原本) を除外。

## Cross-Browser (Chrome / Firefox 両対応)

`manifest.json` の正本は Chrome 向け (`service_worker` のみ) とし、 Firefox 固有の差分は firefox-build/ 構築時に注入する。 Chrome は Firefox 固有フィールドを silently ignore する。

- **`browser_specific_settings.gecko`** — Firefox 用 extension id (`{37d6aac9-e947-4a4b-982d-f9945e41b234}`) と `strict_min_version: "128.0"`、 `data_collection_permissions.required: ["none"]` を保持 (正本に併記したまま。 Chrome は無視する)。
- **`background.scripts` は firefox-build 構築時に注入** — 正本に `service_worker` と併記すると Chrome の拡張機能画面に `'background.scripts' requires manifest version of 2 or lower.` 警告が出るため、 正本には置かない。 firefox-build/ 構築の `node -e` で `m.background.scripts=['src/lib/actions.js','src/background/background.js']` を追加する (publish.yml と手動フローの両方)。 Firefox は `scripts` 配列を event page として読み、 AMO validator は `service_worker` 単独を reject する (`"Unsupported /background/service_worker manifest property used without /background/scripts property as Firefox-compatible fallback"`)。 `scripts` 配列の先頭に `src/lib/actions.js` を置くことで `TokenStorageKeys` 等のグローバルが evaluation 順で先に定義される。
- **`importScripts` の typeof guard** — `worker` 限定 API なので Firefox event page では `ReferenceError` になる。 `background.js` 先頭で `typeof importScripts === "function"` で囲み、worker のときだけ呼ぶ。
- **`manifest.json` の `key` フィールド** — Chrome ローカル開発用の公開鍵。 Firefox AMO は無視するが、 配布物には不要なので `zip.ps1` / `zip.sh` と firefox-build/ 構築時に削除する。

## Firefox AMO 公開フロー (手動フォールバック)

通常の新バージョン提出は `.github/workflows/publish.yml` の firefox job が自動実行する。 以下は CI が使えない場合のローカル手動手順と、 Firefox ローカル開発用の firefox-build/ 構築手順を兼ねる。 初回登録時の guid は `manifest.json` の `gecko.id` を使って `web-ext sign` が AMO 上に自動作成する。

```powershell
# 1. firefox-build/ を構築 (key を除き background.scripts を注入した manifest + icons PNG + src/)
$dir = "firefox-build"
Remove-Item $dir -Recurse -Force -EA SilentlyContinue
New-Item -ItemType Directory $dir | Out-Null
node -e "const m=require('./manifest.json');delete m.key;m.background.scripts=['src/lib/actions.js','src/background/background.js'];require('fs').writeFileSync('firefox-build/manifest.json',JSON.stringify(m,null,2))"
New-Item -ItemType Directory "$dir/icons" | Out-Null
Copy-Item "icons/icon-16.png","icons/icon-48.png","icons/icon-128.png" -Destination "$dir/icons/"
Copy-Item "src" -Destination $dir -Recurse
Get-ChildItem $dir -Recurse -Include "*.DS_Store","*.swp","*~","preview.html","*.ttf" | Remove-Item -Force

# 2. web-ext sign で AMO submission API 経由 upload
$env:WEB_EXT_API_KEY = "user:..."
$env:WEB_EXT_API_SECRET = "..."
pnpm exec web-ext sign --source-dir=firefox-build --artifacts-dir=web-ext-artifacts `
  --channel=listed --amo-metadata=.amo-metadata.json --no-input
```

- `.amo-metadata.json` の `license` は **`version.license` (nested)** で渡す (top-level だと "This field, or custom_license, is required for listed versions." エラー)
- `web-ext sign` が `Approval: timeout exceeded` と表示しても submission は受理済 (エラーメッセージに含まれる `/versions/<id>` URL がそれ)

### AMO API v5 でリスティング情報を反映 (`scripts/amo-metadata-update.js`)

JWT (HS256, payload `{iss, jti, iat, exp}` で exp は 60 秒程度) で `Authorization: JWT <token>` を付けて API v5 を叩くと、 name / summary / description / homepage / support_url / privacy_policy をスクリプトから一括反映できる。

- **`PATCH /api/v5/addons/addon/{guid}/`** — name / summary / description / homepage / support_url / default_locale
- **`PATCH /api/v5/addons/addon/{guid}/eula_policy/`** — privacy_policy ⭐ **専用エンドポイント必須**。 `/addon/` 本体への PATCH で privacy_policy を渡しても HTTP 200 が返るが `has_privacy_policy` フラグは立たない (ReplaceFontSelect notosans でも踏んだ既知問題、 v1.0.11 で `/eula_policy/` 経由に切替て解決)
- `description` は markdown 対応 (`### 見出し` `- リスト` `**強調**` `[リンク](URL)` が `<h3>` `<ul><li>` `<strong>` `<a>` に展開、 外部リンクは Mozilla outgoing proxy 経由に書き換わる)。 summary は plain text のみ
- locale コードは BCP 47 厳密 (`en` 単独は HTTP 400、 `en-US` を使う)。 `default_locale` を `"ja"` に切り替える PATCH は同じ body に `name: {ja: "..."}` を含めないと "A value in the default locale of \"ja\" is required." エラー

### previews / screenshots (`scripts/amo-previews-upload.js`)

`POST /api/v5/addons/addon/{guid}/previews/` (multipart/form-data: `image` + `position`) で screenshots を upload できる、 が **DELETE / POST の user-level rate limit が非常に重い** (1 回叩いただけで 3474 秒 wait、 連投で 53000 秒級まで伸びた事例あり)。 **実運用は AMO Developer Hub からの手動 upload 推奨**。 スクリプトは `--check` モードで既存 previews の `image_url` / `position` 一覧取得のみ実用。

### HTTP 429 リトライ

両スクリプトとも `detail` の `"Expected available in N seconds"` を正規表現で parse して自動 sleep + 5 回リトライ。 ただし上記の通り **previews 系は累積で 1 時間超の wait に伸びる** ため、 自動リトライは無力。

## CI / Release

`.github/workflows/publish.yml` は Chrome Web Store と Firefox AMO の自動公開ワークフロー。 `release/<X.Y.Z>` push でトリガー。 外部 action は SHA 固定、 `chrome-webstore-upload-cli` は devDependencies に exact pin して `pnpm exec` 経由で実行する (サプライチェーン対策)。 v4 から認証は環境変数のみ (`CLIENT_ID` / `CLIENT_SECRET` / `REFRESH_TOKEN` / `PUBLISHER_ID` / `EXTENSION_ID`) で、 `PUBLISHER_ID` は GitHub Secrets `CWS_PUBLISHER_ID` (正本は secrets.json の `chrome_web_store.publisher_id`) から渡す。 サブコマンド無しで upload + publish 一括 (`--auto-publish` は廃止)。

バージョン更新は `manifest.json` を Edit で書き換え、 `package.json` / `pnpm-lock.yaml` は `pnpm version <X.Y.Z> --no-git-tag-version` で同期。 `/vava` スキルが一括バンプ + release ブランチ作成 + 古いブランチ掃除まで自動化する (PRIMARY_VERSION_FILE = manifest.json、 SECONDARY = package.json/pnpm-lock.yaml)。

Firefox AMO も publish.yml の firefox job が `web-ext sign` (`--approval-timeout=0`) で自動 submission する。 CI が使えない場合のフォールバックは上記「Firefox AMO 公開フロー (手動フォールバック)」。

## Setup

1. Raindrop.io 開発者コンソール (https://app.raindrop.io/settings/integrations) でアプリ作成
2. `chrome.identity.getRedirectURL()` の値をリダイレクト URI に登録
3. `src/background/background.js` の `OAuthConfig` の `CLIENT_ID` / `CLIENT_SECRET` を設定
4. `pnpm install && pnpm run build` でアイコン・ストア画像生成
5. **Chrome**: `chrome://extensions` で開発者モード → パッケージ化されていない拡張機能を読み込む
6. **Firefox 128+**: 先に「Firefox AMO 公開フロー」手順 1 で `firefox-build/` を構築 (`background.scripts` 注入が必要なため、ルートの `manifest.json` 直接読み込みでは background が動かない) → `about:debugging#/runtime/this-firefox` → 「一時的なアドオンを読み込む...」 → `firefox-build/manifest.json` を選択 (再起動で消えるのは仕様)
