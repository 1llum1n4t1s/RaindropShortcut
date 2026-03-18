# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Raindrop Shortcut は Chrome 拡張機能 (Manifest V3)。Raindrop.io の特定コレクション内ブックマークをワンクリックで一覧表示する。OAuth 2.0 認証、コレクション選択、検索フィルタ、ダークモード対応。UI は日本語。

## Build Commands

```bash
npm run build              # アイコン PNG + ストア画像を一括生成
npm run generate-icons     # icons/icon.svg → images/icon-{16,48,128}.png (sharp)
npm run generate-screenshots  # webstore/0x-*.html → webstore/images/*.png (puppeteer)
```

パッケージ作成:
```bash
powershell -ExecutionPolicy Bypass -File zip.ps1   # raindrop-shortcut.zip を生成
```

テストフレームワーク・リンターは未導入。動作確認は Chrome に拡張機能を読み込んで手動テスト。

## Architecture

popup.js が chrome.runtime メッセージで background.js (Service Worker) と通信する。actions.js に共有定数を定義。

```
popup.js ──msg──▶ background.js (Service Worker)
                      ├── OAuth (chrome.identity.launchWebAuthFlow)
                      ├── Token管理 (自動リフレッシュ)
                      └── Raindrop.io API 呼び出し

actions.js = 共有定数 (アクション名, ストレージキー, API設定)
```

### メッセージフロー

| Action | 方向 | 用途 |
|--------|------|------|
| `CHECK_AUTH` | popup→bg | 認証状態確認 |
| `LOGIN` | popup→bg | OAuthフロー開始 |
| `LOGOUT` | popup→bg | トークン削除 |
| `GET_COLLECTIONS` | popup→bg | コレクション一覧取得 |
| `GET_BOOKMARKS` | popup→bg | ブックマーク取得 (ページ付き) |

### Popup (`popup.html`, `popup.js`, `popup.css`)
3画面構成: ログイン / メイン（ブックマーク一覧） / 設定。画面は `hidden` 属性で切替。メイン画面はヘッダー（コレクション名 + 設定アイコン）、検索バー（ローカルフィルタ）、ブックマーク一覧（無限スクロール）。クリックで新しいタブを開く。

### Background (`scripts/background.js`)
Service Worker。OAuth 2.0 フロー（`chrome.identity.launchWebAuthFlow`）、アクセストークン管理（期限5分前に自動リフレッシュ）、Raindrop.io API 呼び出し（`apiFetch()` で Authorization ヘッダー自動付与）。コレクションはルート + 子を並行取得してツリー構造化。

### 定数 (`scripts/actions.js`)
`Actions`, `StorageKeys`, `ApiConfig`, `ThemeMode`, `Screens` を `Object.freeze` で定義。`CLIENT_ID` / `CLIENT_SECRET` はここにハードコード。

### テーマ (`popup.css`)
CSS カスタムプロパティでライト/ダークテーマ。`auto` = OS追従 (`prefers-color-scheme`)、`light`/`dark` = `:root` にクラス付与で強制。

### ストア画像 (`webstore/`)
`01-*.html` 〜 `05-*.html` が HTML テンプレート。`generate-screenshots.js` が puppeteer で各 HTML をスクリーンショットして `webstore/images/` に PNG 出力。`store-listing.txt` は Chrome Web Store 掲載情報のコピペ用テキスト。

## Storage Schema

```
chrome.storage.local:
  accessToken       - OAuth アクセストークン
  refreshToken      - OAuth リフレッシュトークン
  tokenExpiry       - トークン有効期限 (Date.now() + expires_in * 1000)
  selectedCollection - { _id, title } | null
  themeMode         - "auto" | "light" | "dark"
```

## Important Patterns

- **API 呼び出しは全て background.js に集約** — popup.js は `sendMessage()` で間接的に呼ぶ。トークンリフレッシュが一箇所で処理される。
- **401 エラー時は自動ログアウト** — `apiFetch()` で 401 を検知したらトークン削除、popup はログイン画面に戻す。
- **コレクション階層は2段階** — ルート (`/collections`) + 子 (`/collections/childrens`) を並行取得して `parent.$id` で親子関係を構築。
- **検索はローカルフィルタ** — 読み込み済みブックマークの title/domain で絞り込み。サーバーサイド検索は未使用。
- **無限スクロール** — `listContainer` の scroll イベントで残り100px以下になったら次ページ取得。検索中はスクロール読み込み無効。
- **favicon は Google Favicon Service** — `https://www.google.com/s2/favicons?sz=16&domain=DOMAIN` で取得。
- **zip.ps1** — `scripts/generate-icons.js` は含めずパッケージする。開発ツール系ファイル（node_modules, webstore, package.json 等）は除外。

## Setup

1. Raindrop.io 開発者コンソール (https://app.raindrop.io/settings/integrations) でアプリ作成
2. `chrome.identity.getRedirectURL()` の値をリダイレクト URI に登録
3. `scripts/actions.js` の `CLIENT_ID` / `CLIENT_SECRET` を設定
4. `npm install && npm run build` でアイコン・ストア画像生成
5. `chrome://extensions` で開発者モード → パッケージ化されていない拡張機能を読み込む
