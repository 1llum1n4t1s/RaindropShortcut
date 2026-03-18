# Raindrop Shortcut 拡張機能パッケージ生成スクリプト
# 使い方: powershell -ExecutionPolicy Bypass -File zip.ps1

Write-Host "拡張機能パッケージを生成中..." -ForegroundColor Cyan
Write-Host ""

# スクリプトのディレクトリをカレントディレクトリに設定
$scriptDir = Split-Path -Parent ($MyInvocation.MyCommand.Path ?? $PSCommandPath ?? $PWD)
if ($scriptDir) { Set-Location $scriptDir }

# アイコン生成
Write-Host "アイコンを生成中..." -ForegroundColor Yellow
npm install --silent 2>$null
node scripts/generate-icons.js

# 古いZIPファイルを削除
$zipName = "raindrop-shortcut.zip"
if (Test-Path $zipName) {
    Remove-Item $zipName -Force
    Write-Host "既存のZIPファイルを削除しました" -ForegroundColor Yellow
}

# 一時ディレクトリを作成
$tempDir = "temp-build"
if (Test-Path $tempDir) {
    Remove-Item $tempDir -Recurse -Force
}
New-Item -ItemType Directory -Path $tempDir | Out-Null

# 必要なファイルをコピー
Write-Host "必要なファイルをコピー中..." -ForegroundColor Yellow

Copy-Item "manifest.json" -Destination $tempDir
Copy-Item "popup.html" -Destination $tempDir
Copy-Item "popup.js" -Destination $tempDir
Copy-Item "popup.css" -Destination $tempDir
Copy-Item "scripts" -Destination $tempDir -Recurse
Copy-Item "images" -Destination $tempDir -Recurse

# 不要なファイルを除外
Get-ChildItem -Path $tempDir -Recurse -Include "generate-icons.js", "*.DS_Store", "*.swp", "*~" | Remove-Item -Force

# ZIPファイルを作成
Write-Host "ZIPファイルを作成中..." -ForegroundColor Cyan
Compress-Archive -Path "$tempDir/*" -DestinationPath $zipName -Force

# 一時ディレクトリを削除
Remove-Item $tempDir -Recurse -Force

if (Test-Path $zipName) {
    Write-Host "ZIPファイルを作成しました: $zipName" -ForegroundColor Green
    Write-Host ""
    Write-Host "ファイルサイズ:" -ForegroundColor Cyan
    $fileSize = (Get-Item $zipName).Length
    $fileSizeKB = [math]::Round($fileSize / 1KB, 2)
    Write-Host "   $fileSizeKB KB" -ForegroundColor White
    Write-Host ""
    Write-Host "パッケージが正常に作成されました!" -ForegroundColor Green
} else {
    Write-Host "ZIPファイルの作成に失敗しました" -ForegroundColor Red
    exit 1
}
