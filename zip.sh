#!/bin/bash

# Raindrop Shortcuts 拡張機能パッケージ生成スクリプト

cd "$(dirname "$0")" || exit 1
echo "拡張機能パッケージを生成中..."

rm -f ./raindrop-shortcut.zip

if [ -f scripts/generate-icons.js ]; then
  echo "アイコン生成中..."
  pnpm install --silent 2>/dev/null || exit $?
  node scripts/generate-icons.js || exit $?
fi

if ! command -v zip &> /dev/null; then
  echo "zipをインストールしてください"
  exit 1
fi

# 共通処理で配布ファイルを配置
BUILD_DIR=$(mktemp -d)
trap 'rm -rf "$BUILD_DIR"' EXIT

node scripts/stage-extension.js "$BUILD_DIR" chrome || exit $?

(cd "$BUILD_DIR" && zip -r "$OLDPWD/raindrop-shortcut.zip" .)

if [ $? -eq 0 ]; then
  echo "ZIPファイルを作成しました: raindrop-shortcut.zip"
  ls -lh ./raindrop-shortcut.zip
else
  echo "ZIPファイルの作成に失敗しました"
  exit 1
fi
