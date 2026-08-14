# Raindrop Shortcut

<p align="center">
  <img src="icons/icon.svg" width="128" height="128" alt="Raindrop Shortcut">
</p>

Raindrop.io のブックマークをツールバーからすばやく検索・アクセスできる Chrome / Firefox 拡張機能 (Manifest V3) です。

## 機能

- **ワンクリック一覧表示** — ツールバーのアイコンをクリックするだけで、ブックマークをコンパクトに表示
- **コレクション選択** — 表示するフォルダ（コレクション）を設定画面で切り替え可能
- **インクリメンタル検索** — タイトル・ドメイン名でリアルタイム絞り込み
- **ダークモード** — OS 設定に自動追従 / 手動切り替え
- **リンクの開き方切替** — 新しいタブ / 現在のタブを設定で選択可能
- **高速表示** — 選択中コレクションをバックグラウンドで定期取得し、アイコンクリック時はローカルキャッシュから即時表示

## インストール

- **Chrome Web Store**: 公開済（リンクは Web Store 公開ページを参照）
- **Firefox Add-ons (AMO)**: [raindrop-shortcuts](https://addons.mozilla.org/firefox/addon/raindrop-shortcuts/) （レビュー後に公開）

## 使い方

1. ツールバーの Raindrop Shortcut アイコンをクリック
2. 「ログイン」ボタンを押して Raindrop.io アカウントで認証（初回のみ）
3. ブックマーク一覧が表示されます
4. 設定（⚙ アイコン）から表示するコレクションを選択

## プライバシー

- OAuth 2.0 認証を使用。パスワードを拡張機能に入力する必要はありません
- 個人情報の収集・外部送信は一切行いません
- favicon 画像取得のためにブックマークのドメイン名のみ Google Favicon Service へ送信します
- ポップアップ UI の Web フォント (IBM Plex Sans JP / IBM Plex Mono) を Google Fonts CDN から取得します。オフライン時はシステムフォント (Yu Gothic UI / Hiragino Kaku Gothic ProN 等) にフォールバックします
- 詳細は [プライバシーポリシー](docs/privacy-policy.md) をご覧ください

## ライセンス

MIT
