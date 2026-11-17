# AGENTS.md

This file provides guidance to Codex and other coding agents working in this repository.

## Project Overview

Raindrop Shortcut は Chrome / Firefox 拡張機能 (Manifest V3)。Raindrop.io の特定コレクション内ブックマークをワンクリックで一覧表示する。OAuth 2.0 認証、コレクション選択、ローカル検索フィルタ、ダークモード、リンク開き方選択、ローカルキャッシュによる高速表示に対応。UI は 9 言語（en ja zh_CN zh_TW ko es fr de pt_BR。`_locales` + `chrome.i18n` + `src/shared/ui-localizer.js`、設定画面のヘッダーで言語切替、文言は `Localizer.t` / `data-i18n`）。単一の `manifest.json` で Chrome (Service Worker) / Firefox 128+ (event page) 両方をサポートする。

## Build Commands

```bash
bun --bun run build                 # アイコン PNG + ストア画像を一括生成
bun --bun run test                      # Bun の node:test 互換テストを実行
bun --bun run generate-icons        # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
bun --bun run generate-screenshots  # webstore/store-assets.json → webstore/images/<locale>/screenshot-NN.png + tile-*.png (vitrina。Windows は release=9 言語、それ以外は smoke)
```

パッケージ作成 (配布ファイルの配置は `scripts/stage-extension.js <output-directory> <chrome|firefox>` に共通化):
```bash
pwsh -ExecutionPolicy Bypass -File zip.ps1   # raindrop-shortcut.zip を生成
bash zip.sh                                        # 同等 (bash 版)
```

テストは `node:test` を Bun の互換ランナーで実行する。ブラウザ統合の最終動作確認は `chrome://extensions` に拡張機能を読み込んで手動テスト。

- **Chrome を起動するスクリプトを足すときはシード必須**: puppeteer.launch・chrome-launcher・Chrome の直接起動は、起動前に user-data-dir の `Local State` へ `{"password_manager":{"os_password_blank":false,"os_password_last_changed":"9223372036854775000"}}` を書く。Windows の Chromium は新規プロファイルごとに空パスワードで LogonUser を呼び（`password_manager_util_win.cc` の `CheckBlankPasswordWithPrefs`）、ログオン失敗（Security 4625）として数えられるため、並列・連続起動で Windows アカウントがロックされる（2026-11-15 実害）。`scripts/chrome-profile-seed.mjs` の `createSeededProfile()` / `seedChromeProfile()` を使い、userDataDir 未指定の起動は作らない（`webstore/vitrina/` は逐語コピーで対策済み）。

## Source Layout

```
src/
├── popup/              # ポップアップ UI (popup.html / popup.js / popup.css)
├── background/         # Service Worker (background.js) — OAuth 認証情報を保持
├── shared/             # ui-localizer.js（Kagayoi 共通 i18n の逐語コピー。編集しない）と Kagayoi サポート同梱物
└── lib/                # 共有定数 (actions.js) — popup / background 両方から読み込む
_locales/               # 9 言語の messages.json（en が正本）
icons/                  # 拡張機能アイコン (SVG 原本 + 生成 PNG)
webstore/               # Chrome Web Store / Firefox AMO 掲載画像テンプレート + 掲載文言
docs/                   # privacy-policy.md など
scripts/                # 開発用スクリプト
  ├── generate-icons.js          # icons/icon.svg → PNG (sharp)
  ├── stage-extension.js         # Chrome / Firefox 共通の配布ファイル配置
  ├── verify-extension-package.js # 提出 ZIP / XPI の版・構成・SHA-256 を確認
  ├── Publish-Amo.ps1         # 実生成 XPI を検証後、同じファイルを AMO へ提出
  ├── Amo-Http.psm1              # AMO JWT 生成・429 再試行の共通処理
  ├── Update-AmoListing.ps1     # AMO API v5 で name/summary/description/privacy_policy を一括 PATCH
  └── Update-AmoPreviews.ps1     # AMO previews multipart upload (rate limit 重く実用は Dev Hub 手動)
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
Kagayoi 共通キット vitrina（`webstore/vitrina/`。`Kagayoi.Support/clients/chrome-extension/store-assets/` の逐語コピーで改変しない。同期は同ディレクトリの `sync-kit.mjs --repo <このリポジトリ>`）が、実拡張を puppeteer の Chrome for Testing へ読み込み、9 言語のスクリーンショット 4 枚とタイル 2 種を生成する。
- 設定は `webstore/store-assets.json`、撮影前操作と Raindrop.io API の架空応答は `webstore/store-assets.steps.mjs`。ログイン済み状態は storage のダミートークン、API は Service Worker へ CDP の Fetch を張って固定応答、favicon は中立 SVG に差し替える。実トークン・実データ・他社ロゴは使わない。
- `webstore/vitrina/vitrina.mjs generate` を直接呼ぶ（`--work-dir` 省略時は `%TEMP%\vitrina-RaindropShortcut`）。出力は `webstore/images/<locale>/screenshot-NN.png` と `tile-small.png` / `tile-marquee.png`（gitignore）。検証は `bun webstore/vitrina/vitrina.mjs verify`。
- AMO のプレビュー画像は `webstore/images/ja/screenshot-01〜03.png`（`scripts/Update-AmoPreviews.ps1`）。
- `store-listing.txt` は Chrome Web Store 掲載情報のコピペ用。

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
- **loadGeneration カウンタ** — コレクション切り替え時に古い非同期ロードをキャンセル。生成番号が変わった古いロードは UI 状態を変更せず return し、最新 generation だけが `resetLoading()` する。
- **handler() の catch** — `chrome.runtime.onMessage` の非同期 handler は `.catch(e => sendResponse({ error: e.message }))` で reject 時も必ず応答。
- **favicon は Google Favicon Service** — `FAVICON_SIZE` 定数で URL と DOM 属性を一元化。プライバシーポリシーに開示済。
- **zip.ps1 / zip.sh の除外ルール** — `scripts/` (開発専用)、`node_modules`、`webstore`、`package*.json`、`icons/icon.svg` (原本) を除外。

## Cross-Browser (Chrome / Firefox 両対応)

`manifest.json` の正本は Chrome 向け (`service_worker` のみ) とし、 Firefox 固有の差分は firefox-build/ 構築時に注入する。 Chrome は Firefox 固有フィールドを silently ignore する。

- **`browser_specific_settings.gecko`** — Firefox 用 extension id (`{37d6aac9-e947-4a4b-982d-f9945e41b234}`) と `strict_min_version: "128.0"`、 `data_collection_permissions.required: ["none"]` を保持 (正本に併記したまま。 Chrome は無視する)。
- **`background.scripts` は firefox-build 構築時に注入** — 正本に `service_worker` と併記すると Chrome の拡張機能画面に `'background.scripts' requires manifest version of 2 or lower.` 警告が出るため、 正本には置かない。 `scripts/stage-extension.js <output-directory> firefox` が `m.background.scripts=['src/lib/actions.js','src/background/background.js']` を追加する (publish.yml と手動フローの両方)。 Firefox は `scripts` 配列を event page として読み、 AMO validator は `service_worker` 単独を reject する (`"Unsupported /background/service_worker manifest property used without /background/scripts property as Firefox-compatible fallback"`)。 `scripts` 配列の先頭に `src/lib/actions.js` を置くことで `TokenStorageKeys` 等のグローバルが evaluation 順で先に定義される。
- **`importScripts` の typeof guard** — `worker` 限定 API なので Firefox event page では `ReferenceError` になる。 `background.js` 先頭で `typeof importScripts === "function"` で囲み、worker のときだけ呼ぶ。
- **`manifest.json` の `key` フィールド** — Chrome ローカル開発用の公開鍵。 Firefox AMO は無視するが、 配布物には不要なので 各配布経路から呼ぶ `scripts/stage-extension.js` で除去する。

## Firefox AMO 公開フロー (手動フォールバック)

通常の新バージョン提出は `.github/workflows/publish.yml` の firefox job が自動実行する。 以下は CI が使えない場合のローカル手動手順と、 Firefox ローカル開発用の firefox-build/ 構築手順を兼ねる。 初回登録時の guid は `manifest.json` の `gecko.id` を使って `web-ext sign` が AMO 上に自動作成する。

```powershell
# 1. firefox-build/ を構築 (key を除き background.scripts を注入した manifest + icons PNG + src/)
# 出力先は未作成または空のディレクトリを指定する。既存データは削除しない。
bun scripts/stage-extension.js firefox-build firefox
if ($LASTEXITCODE -ne 0) { throw "Firefox staging failed." }

# 2. 最終アーカイブを検証後、同じSHA-256の実物をHTTPで提出
$env:WEB_EXT_API_KEY = "user:..."
$env:WEB_EXT_API_SECRET = "..."
$releaseVersion = (Get-Content -LiteralPath manifest.json -Raw | ConvertFrom-Json).version
$archive = Join-Path (Get-Location) 'firefox-submission.zip'
if (Test-Path -LiteralPath $archive) { throw '提出物を上書きしません' }
Compress-Archive -Path 'firefox-build/*' -DestinationPath $archive
bun scripts/verify-extension-package.js $archive firefox $releaseVersion
if ($LASTEXITCODE -ne 0) { throw 'XPI verification failed' }
$addonId = (Get-Content manifest.json -Raw | ConvertFrom-Json).browser_specific_settings.gecko.id
$sha256 = (Get-FileHash $archive -Algorithm SHA256).Hash
pwsh -NoProfile -File scripts/Publish-Amo.ps1 -Archive $archive -Metadata .amo-metadata.json -AddonId $addonId -ExpectedVersion $releaseVersion -ExpectedSha256 $sha256
```

- `.amo-metadata.json` の `license` は **`version.license` (nested)** で渡す (top-level だと "This field, or custom_license, is required for listed versions." エラー)
- 受付応答を確認できない通信断・不正応答・重複は停止する。人手レビューの承認は待たない。

### AMO API v5 でリスティング情報を反映 (`scripts/Update-AmoListing.ps1`)

JWT (HS256, payload `{iss, jti, iat, exp}` で exp は 60 秒程度) で `Authorization: JWT <token>` を付けて API v5 を叩くと、 name / summary / description / homepage / support_url / privacy_policy をスクリプトから一括反映できる。

- **`PATCH /api/v5/addons/addon/{guid}/`** — name / summary / description / homepage / support_url / default_locale
- **`PATCH /api/v5/addons/addon/{guid}/eula_policy/`** — privacy_policy ⭐ **専用エンドポイント必須**。 `/addon/` 本体への PATCH で privacy_policy を渡しても HTTP 200 が返るが `has_privacy_policy` フラグは立たない (ReplaceFontSelect notosans でも踏んだ既知問題、 v1.0.11 で `/eula_policy/` 経由に切替て解決)
- `description` は markdown 対応 (`### 見出し` `- リスト` `**強調**` `[リンク](URL)` が `<h3>` `<ul><li>` `<strong>` `<a>` に展開、 外部リンクは Mozilla outgoing proxy 経由に書き換わる)。 summary は plain text のみ
- locale コードは BCP 47 厳密 (`en` 単独は HTTP 400、 `en-US` を使う)。 `default_locale` を `"ja"` に切り替える PATCH は同じ body に `name: {ja: "..."}` を含めないと "A value in the default locale of \"ja\" is required." エラー

### previews / screenshots (`scripts/Update-AmoPreviews.ps1`)

`POST /api/v5/addons/addon/{guid}/previews/` (multipart/form-data: `image` + `position`) で screenshots を upload できる、 が **DELETE / POST の user-level rate limit が非常に重い** (1 回叩いただけで 3474 秒 wait、 連投で 53000 秒級まで伸びた事例あり)。 **実運用は AMO Developer Hub からの手動 upload 推奨**。 スクリプトは `-Check` モードで既存 previews の `image_url` / `position` 一覧取得のみ実用。

### HTTP 429 リトライ

両スクリプトとも `detail` の `"Expected available in N seconds"` を正規表現で parse して自動 sleep + 5 回リトライ。 ただし上記の通り **previews 系は累積で 1 時間超の wait に伸びる** ため、 自動リトライは無力。

## CI / Release

`release/<X.Y.Z>` push が公開workflowを起動する。chrome・firefox の両 job は提出前に `bun --bun run test` を通し、失敗したら提出しない（同じテストは `dependency-validation.yml` で main への push と全 PR でも走る）。製品ビルド・最終アーカイブ検証後にPowerShell 7のHTTP publisherでCWSとAMOへ提出する。認証secret・publisher/item/GUIDを維持し、GitHub ActionsはSHA固定を維持する。

バージョン更新は `/vava` スキルで `manifest.json` と `package.json` を同期し、`bun install --lockfile-only` で `bun.lock` を整合させる（PRIMARY_VERSION_FILE = manifest.json、SECONDARY = package.json/bun.lock）。

Firefox AMO も publish.yml の firefox job が `web-ext sign` (`--approval-timeout=0`) で自動 submission する。 CI が使えない場合のフォールバックは上記「Firefox AMO 公開フロー (手動フォールバック)」。

## Setup

1. Raindrop.io 開発者コンソール (https://app.raindrop.io/settings/integrations) でアプリ作成
2. `chrome.identity.getRedirectURL()` の値をリダイレクト URI に登録
3. `src/background/background.js` の `OAuthConfig` の `CLIENT_ID` / `CLIENT_SECRET` を設定
4. `bun install && bun --bun run build` でアイコン・ストア画像生成
5. **Chrome**: `chrome://extensions` で開発者モード → パッケージ化されていない拡張機能を読み込む
6. **Firefox 128+**: 先に「Firefox AMO 公開フロー」手順 1 で `firefox-build/` を構築 (`background.scripts` 注入が必要なため、ルートの `manifest.json` 直接読み込みでは background が動かない) → `about:debugging#/runtime/this-firefox` → 「一時的なアドオンを読み込む...」 → `firefox-build/manifest.json` を選択 (再起動で消えるのは仕様)

### CWS 公開のHTTP境界

`publish.yml` はビルド済みZIPを `scripts/Publish-Cws.ps1`（PowerShell 7）へ渡す。既存のOAuth secrets・publisher/item IDを維持し、ZIPをストリーム送信し、upload成功を確認する（既定の `-Stage All` はその後publishまで行うが、CIは `-Stage Upload` でアップロードだけを行い、申請は `cws-submit.yml` が `-Stage Publish` で行う）。重複・通信断・不明な応答を公開成功として扱わず、ストア状態を確認してから再開する。公開専用npm CLIは使用しない。変更時はHTTP fixtureで成功・版/ID不一致・upload失敗・publish拒否を確認する。

### CWS のアップロードと申請の分離

`publish.yml` は検証済みZIPを `-Stage Upload` で下書きとしてアップロードするだけで、審査へは申請しない。新ロケールの掲載画像欄はアップロード後でないと Dashboard に出ないため、申請は別workflow `.github/workflows/cws-submit.yml`（手動実行、`-Stage Publish`）で行う。

1. `release/x.y.z` を push する（publish.yml がアップロードする）
2. Dashboard（Edictora）でロケール別の掲載画像などを整えて下書き保存する
3. `gh workflow run cws-submit.yml -f version=x.y.z --ref release/x.y.z` で申請する

- API v2 は未申請の下書き版を返さないため、下書きの版そのものは確認できない。`cws-submit.yml` は次を満たす場合だけ `:publish` する: 実行 ref が `release/<version>` で manifest の版が入力と一致する。`publish.yml` の直近のアップロード成功 run（固定ステップ名 `Chrome Web Store にアップロード（下書き）`。`actions: read` で履歴を参照）が同じ commit である。fetchStatus で item identity・直近アップロード状態・公開/審査中の版を確認できる。
- 同版が申請済み・公開済み（PENDING_REVIEW / STAGED / PUBLISHED / PUBLISHED_TO_TESTERS）なら再送せず成功終了する。別版の審査中、より新しい版の存在、直近アップロードの進行中・失敗、状態不明は申請せず停止する。
- Dashboard で手動アップロードした下書きなど、同じ commit のアップロード成功 run が無い場合は申請されない。その場合は Dashboard から手動で申請する。
- 両workflowは同じ concurrency group で直列化する。申請中は Dashboard の操作を並行しない。

### AMO 公開のHTTP境界

公開workflowは生成した最終XPIを既存の配布物検証へ通し、SHA-256・GUID・versionを `scripts/Publish-Amo.ps1`（PowerShell 7.2 以上）へ渡す。旧web-ext sign/承認タイムアウトを成功化する手順に代えて、JWT認証・全ページの非公開listed版検査・upload検証・GUIDに対するPUT提出の受付応答まで確認する。XPIの同一snapshotをhash検証と送信に使い、保存UUIDの再利用・重複・不明な受付結果は停止する。CI成功は審査完了・ストア公開を意味しない。

掲載情報は `pwsh -NoProfile -File scripts/Update-AmoListing.ps1`、画像は `pwsh -NoProfile -File scripts/Update-AmoPreviews.ps1` で更新する。`-DryRun` は外部接続せず入力を表示し、画像の `-Check` は現状取得だけ行う。画像差し替えは全入力ファイルを確認し、新画像3枚すべての受付後に既存画像を削除する。途中拒否は旧画像を維持して停止し、追加済みIDを示して再実行前の確認を促す。文言の正本は `webstore/amo-listing.json` と日本語privacy文書。

CWS公開workflowはrepository固定のconcurrency groupで直列化する。同期uploadの成功・ID・版を確認した場合だけpublishし、非同期uploadはAPI v2でdraft版を要求と結び付けられないため停止する。APIにはuploadとpublishの原子的なCASが無いため、提出中はDashboardや他の手動公開操作を並行しない。

## Bun依存の脆弱性検出

依存の固定復元は `bun run deps` を使う。lock欠落・破損を拒否し、`[run] bun=true` 経由で依存のpostinstallまでBunで実行する。Node.jsがあるPCでも通常の `bun install` を直接使う経路へ戻さない。

ローカルでは `bun audit` でlock全体を監査できる。通常のDependabot更新PRは維持し、Dependency validationで検証する。


### 依存の暫定セキュリティ修正

minimatch は 11.0.4 以降、multimatch は named import 対応の 8 系へ override する。ESLint 設定の ESM 経路は @eslint/eslintrc@3.3.7 と @eslint/config-array@0.21.2 の最小 import patch で互換性を保つ。web-ext@10.8.0 の FileFilter は Windows で windowsPathsNoEscape を明示し、開発用ファイルやアーカイブの除外を維持する。

CVE-2026-93753（GHSA-gcqx-w48m-w2h4）の deepmerge 4.3.1 は公式修正版が未公開のため、patches/deepmerge@4.3.1.patch で戻り値への書込みを own データ属性にし、__proto__ 経由の prototype 汚染を防ぐ。bun run test:dependencies で web-ext → addons-linter の実解決先の攻撃入力と通常 API を検証する。Bun 標準の patchedDependencies で適用し、公式修正版の採用時に patch の要否を再確認する。バージョンベースの bun audit 警告は残るため、警告を除外したり成功扱いにしない。
