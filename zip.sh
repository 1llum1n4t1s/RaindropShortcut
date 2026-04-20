#!/bin/bash

# Raindrop Shortcuts 拡張機能パッケージ生成スクリプト

cd "$(dirname "$0")" || exit 1
echo "拡張機能パッケージを生成中..."

rm -f ./raindrop-shortcut.zip

if [ -f scripts/generate-icons.js ]; then
  echo "アイコン生成中..."
  npm install --silent 2>/dev/null
  node scripts/generate-icons.js
fi

if ! command -v zip &> /dev/null; then
  echo "zipをインストールしてください"
  exit 1
fi

# manifest.json から key フィールドを除去したビルドディレクトリを作成
# (key はローカル開発専用、ストアアップロード時は不要)
BUILD_DIR=$(mktemp -d)
trap "rm -rf $BUILD_DIR" EXIT

node -e "const m=require('./manifest.json');delete m.key;require('fs').writeFileSync('$BUILD_DIR/manifest.json',JSON.stringify(m,null,2))"
mkdir -p "$BUILD_DIR/icons"
cp icons/icon-16.png icons/icon-48.png icons/icon-128.png "$BUILD_DIR/icons/"
cp -r src "$BUILD_DIR/"

(cd "$BUILD_DIR" && zip -r "$OLDPWD/raindrop-shortcut.zip" . -x "*.DS_Store" "*.swp" "*~")

if [ $? -eq 0 ]; then
  echo "ZIPファイルを作成しました: raindrop-shortcut.zip"
  ls -lh ./raindrop-shortcut.zip
else
  echo "ZIPファイルの作成に失敗しました"
  exit 1
fi
