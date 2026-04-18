# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Raindrop Shortcut は Chrome 拡張機能 (Manifest V3)。Raindrop.io の特定コレクション内ブックマークをワンクリックで一覧表示する。OAuth 2.0 認証、コレクション選択、ローカル検索フィルタ、ダークモード、リンク開き方選択、ローカルキャッシュによる高速表示に対応。UI は日本語。

## Build Commands

```bash
npm run build                  # アイコン PNG + ストア画像を一括生成
npm run generate-icons         # icons/icon.svg → icons/icon-{16,48,128}.png (sharp)
npm run generate-screenshots   # webstore/0x-*.html → webstore/images/*.png (puppeteer)
```

パッケージ作成:
```bash
powershell -ExecutionPolicy Bypass -File zip.ps1   # raindrop-shortcut.zip を生成
bash zip.sh                                        # 同等 (bash 版)
```

テストフレームワーク・リンターは未導入。動作確認は `chrome://extensions` に拡張機能を読み込んで手動テスト。

## Source Layout

```
src/
├── popup/              # ポップアップ UI (popup.html / popup.js / popup.css)
├── background/         # Service Worker (background.js) — OAuth 認証情報を保持
└── lib/                # 共有定数 (actions.js) — popup / background 両方から読み込む
icons/                  # 拡張機能アイコン (SVG 原本 + 生成 PNG)
webstore/               # Chrome Web Store 掲載画像テンプレート + 掲載文言
docs/                   # privacy-policy.md など
scripts/                # 開発用スクリプト (generate-icons.js)
.github/workflows/      # publish.yml (Chrome Web Store 自動公開)
```

`src/lib/actions.js` は popup の `<script>` タグと background の `importScripts()` の双方から読まれる前提で、モジュール構文を使わずグローバル定数 (`Actions`, `StorageKeys`, `SharedConfig`, `TokenStorageKeys`, `LinkOpenMode`, `ThemeMode`, `Screens`) を `Object.freeze` で定義する。ES module 化しないこと。

**OAuth 認証情報 (CLIENT_ID / CLIENT_SECRET / エンドポイント URL 等) は `src/background/background.js` 内の `OAuthConfig` で保持**し、popup 側には露出させない。ただし Chrome 拡張の配布 ZIP は公開されるため client_secret は構造的に漏洩する。Raindrop.io が PKCE を提供していないことによる既知の制約。

## Architecture

popup.js が `chrome.runtime.sendMessage` で background.js (Service Worker) と通信する。API 呼び出しとトークン管理は全て background 側に集約されている。

```
popup.js ──msg──▶ background.js (Service Worker)
                      ├── OAuth (chrome.identity.launchWebAuthFlow) — state 検証あり
                      ├── Token 管理 (期限5分前に自動リフレッシュ、Promise coalescing で並行重複防止)
                      └── Raindrop.io API 呼び出し (apiFetch、AbortSignal.timeout 付き)

src/lib/actions.js = 共有定数
  - popup.html が <script src="../lib/actions.js"> で読み込む
  - background.js が importScripts("/src/lib/actions.js") で読み込む
```

### メッセージフロー

| Action | 方向 | 用途 |
|--------|------|------|
| `CHECK_AUTH` | popup→bg | 認証状態確認 |
| `LOGIN` | popup→bg | OAuth フロー開始 (state パラメータで CSRF 防御) |
| `LOGOUT` | popup→bg | トークン削除 |
| `GET_COLLECTIONS` | popup→bg | コレクション一覧取得 (ルート + 子ツリー) |
| `GET_BOOKMARKS` | popup→bg | ブックマーク取得 (ページ指定、count 付きで返却) |

`onMessage` リスナーは `sender.id !== chrome.runtime.id` のメッセージを無視する (外部拡張からのセッション破壊防止)。

### Popup
3画面構成 (ログイン / メイン / 設定)。画面切替は各 `<div class="screen">` の `hidden` 属性を切り替えるだけ。メイン画面はヘッダー、検索バー、ブックマーク一覧。クリックで設定に応じて新しいタブ / 現在のタブで開く。

**ブックマーク読み込み**: 初回の 1 ページで `count` を取得 → 残ページを並列 fetch (concurrency=6) → 最終ソートは 1 回だけ (`Intl.Collator("ja")`)。検索フィルタ用に正規化済み `_titleLower` / `_domainLower` を付加しておき、filter 内の `toLowerCase()` 呼び出しを回避。

**ローカルキャッシュ**: 「すべて」選択時は `chrome.storage.local` にブックマーク一覧を保存 (TTL 5 分)。popup 再表示時はキャッシュから即時レンダリングし、バックグラウンドで差分更新。

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
  bookmarksCache    - { savedAt, items[] } (「すべて」選択時のみ、TTL 5分)
```

## Important Patterns

- **API 呼び出しは全て background.js に集約** — popup.js は `sendMessage()` で間接的に呼ぶ。
- **401 エラー時は自動ログアウト** — `apiFetch()` が 401 を検知したらトークン削除して `{ error: "unauthorized" }` を返す。
- **ネットワーク断と認証失敗を区別** — `apiFetch` / `refreshAccessToken` は network エラーを `{ error: "network" }` として分離返却し、popup は「ログイン画面に戻す」ではなく「ネットワークエラー表示」にする。
- **Promise coalescing によるトークン更新競合回避** — `refreshPromise` モジュール変数で並行リフレッシュを単一化。
- **コレクション階層は2段階** — ルート (`/collections`) + 子 (`/collections/childrens`) を並行取得し `Map<parent.$id, []>` で O(R+C) 突合。
- **検索はローカルフィルタ** — `_titleLower` / `_domainLower` を事前計算し毎回の `toLowerCase()` を回避。
- **並列ページ取得** — `fetchBookmarks` が返す `count` から総ページ数を算出し `Promise.all` + concurrency=6 で並列取得。
- **中間レンダリングは `reset=true` のときのみ** — キャッシュ経由のリフレッシュ (`reset=false`) では最終結果のみ描画してチラつきを防止。
- **loadGeneration カウンタ** — コレクション切り替え時に古い非同期ロードをキャンセル。生成番号が変わったら即 `resetLoading()` して return。
- **handler() の catch** — `chrome.runtime.onMessage` の非同期 handler は `.catch(e => sendResponse({ error: e.message }))` で reject 時も必ず応答。
- **favicon は Google Favicon Service** — `FAVICON_SIZE` 定数で URL と DOM 属性を一元化。プライバシーポリシーに開示済。
- **zip.ps1 / zip.sh の除外ルール** — `scripts/` (開発専用)、`node_modules`、`webstore`、`package*.json`、`icons/icon.svg` (原本) を除外。

## CI / Release

`.github/workflows/publish.yml` が Chrome Web Store への自動公開ワークフロー。バージョン更新時は `manifest.json` と `package.json` の `version` を両方揃えて更新する。外部 action は SHA 固定、`chrome-webstore-upload-cli` は devDependencies に固定して `npx` 経由で実行する。

## Setup

1. Raindrop.io 開発者コンソール (https://app.raindrop.io/settings/integrations) でアプリ作成
2. `chrome.identity.getRedirectURL()` の値をリダイレクト URI に登録
3. `src/background/background.js` の `OAuthConfig` の `CLIENT_ID` / `CLIENT_SECRET` を設定
4. `npm install && npm run build` でアイコン・ストア画像生成
5. `chrome://extensions` で開発者モード → パッケージ化されていない拡張機能を読み込む
