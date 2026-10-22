# Raindrop Shortcut の設計

## 目的と構成

Raindrop.io の保存済みブックマークを、ブラウザのツールバーからコレクション単位で表示・検索する Manifest V3 拡張機能。ブックマークの編集やサーバー側検索は行わず、日本語のポップアップで閲覧とリンクの起動を提供する。利用方法は [README.md](README.md)、開発・配布手順は [AGENTS.md](AGENTS.md) を参照する。

| コンポーネント | 責務と境界 |
| --- | --- |
| `src/popup/` | ログイン・メイン・設定の3画面、ローカル検索、テーマ、リンクの開き方。Raindrop.io API を直接呼ばない。 |
| `src/background/background.js` | OAuth、トークン更新、Raindrop.io API、全ページ取得、キャッシュ更新。Chrome は Service Worker、Firefox は event page として実行する。 |
| `src/lib/actions.js` | メッセージ名・ストレージキー・共有設定を凍結したグローバル定数で定義。popup と background の従来スクリプト双方から読み込む。 |
| `src/shared/` | `@kagayoi/support-extension` から同期する問い合わせ部品。Raindrop.io 認証とは独立した Kagayoi Support の認証と通信を扱う。 |
| `scripts/`、`webstore/` | 配布ファイル配置、ストア連携、アイコン・掲載画像生成。拡張機能の実行時には使わない。 |

## データフロー

1. popup は設定・キャッシュの読み取りと `CHECK_AUTH` を並行実行する。認証確認はアクセストークンの存在判定で、有効性の確認・更新は API 利用時に行う。
2. `LOGIN` は background の `chrome.identity.launchWebAuthFlow` で認可コードを取得し、ランダムな `state` を照合してトークンへ交換する。クライアント設定はブラウザ別に `OAuthClients` から選ぶ。
3. `GET_COLLECTIONS` はルートと全子孫の2エンドポイントを並行取得する。親 ID ごとの Map で接続し、各階層を日本語タイトル順に並べる。取得が2系統でも階層は2段に限定しない。
4. `GET_BOOKMARKS` は指定コレクション（`0` は「すべて」）を50件ずつ取得する。初回の件数から残ページを算出し、最大6ページずつ並行取得した後、一度だけタイトル順にソートする。
5. popup はタイトル・ドメインの小文字表現を事前計算し、200ms の debounce でローカル絞り込みを行う。リンクは設定に応じて新しいタブまたは現在のタブへ開く。

## 保存と非同期処理の不変条件

`chrome.storage.local` に OAuth の `accessToken`・`refreshToken`・`tokenExpiry`、`selectedCollection`（`{ _id, title }`）、`themeMode`（`auto/light/dark`）、`linkOpenMode`（`newTab/current`）を保存する。未選択は「すべて」、既定テーマは OS 追従、既定のリンク先は新しいタブ。

`bookmarksCache` は `{ collectionId, savedAt, items }` で、各 item は `_id/title/link/domain` を持つ。選択 ID が一致するキャッシュを即時表示し、5分未満なら popup からの再取得を省略する。古くても表示を残しながら再取得するため、5分は物理削除の期限ではない。起動・インストール・選択変更・5分間隔の alarm でも更新し、background 起動時に alarm の存在を確認する。キャッシュ保存が容量等で失敗しても取得結果は返す。

- 同一セッション・コレクションの並行取得と、トークンの並行更新は Promise を共有し、重複リクエストを抑える。
- background はセッション世代を検査し、ストレージ変更を直列化する。ログアウト前の処理が新しいセッションのトークンやキャッシュを復元しないようにする。ログアウト・認証失効時はトークン、選択コレクション、キャッシュを削除する。
- popup の `loadGeneration` は古いロードが新しい一覧・ローディング表示へ反映されるのを防ぐ。
- メッセージは `sender.id === chrome.runtime.id` の場合だけ処理し、非同期例外もエラー応答へ変換する。

## 認証・通信と失敗の扱い

OAuth と Raindrop.io API の fetch は15秒でタイムアウトする。期限5分前からトークンを更新し、一時的な更新失敗時は有効期限内の既存トークンだけを利用できる。通信障害や更新時の408・429・5xxでは認証情報を保持し、更新時のそれ以外の4xxは認証失効として扱う。

API の401では GET/HEAD のみトークン更新後に一度再試行し、再び401ならログアウトする。`network` と `unauthorized` を分けることで、一時的な通信断でログイン画面へ戻ることを避ける。

OAuth クライアント設定は background に閉じるが、配布物に含まれる client secret は利用者から秘匿できない。問い合わせは `support.kagayoi.com` の別サービスで、セッションは `window.localStorage` の `kagayoi-support-session` に保持する。Raindrop.io のログアウトでは削除しない。Firefox のデータ申告は本人識別情報・認証情報を必須、問い合わせ本文を任意とし、問い合わせ部品が送信前に任意データの許可を求める。

favicon はドメイン名を Google Favicon Service へ送り、フォントは Google Fonts から取得する。外部取得による通信と、フォントが取得できない場合のシステムフォントへのフォールバックを採用している。保存先・送信データの詳細は [プライバシーポリシー](docs/privacy-policy.md) を参照する。

## ブラウザ差分と配布

ルートの `manifest.json` は Chrome 向けの `background.service_worker` を正本とする。Firefox 128 以降向けには `scripts/stage-extension.js` が `background.scripts` を追加し、共有定数を background より先に読み込む。background の `importScripts` は存在時だけ呼ぶ。正本へ `scripts` を併記しない構成で Chrome の警告を避け、配布時に Firefox の event page を成立させる。

manifest の公開鍵 `key` はローカル Chrome の拡張 ID と OAuth redirect URI を一定にするため保持し、配布時に除去する。配布スクリプトは未作成または空でリンクではない出力ディレクトリへ manifest・PNG アイコン・`src/` のみを配置する。開発依存やストア画像を含めない方式を Chrome/Firefox と手動/CI で共有する。

既存の `tests/` は Node.js の組み込みテストでキャッシュ、セッション競合、トークン再試行、popup の世代管理、問い合わせ・プライバシー契約を確認する。ブラウザ上の OAuth と画面操作の最終確認は別途必要になる。
