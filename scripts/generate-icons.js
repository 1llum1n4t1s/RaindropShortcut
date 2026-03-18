const sharp = require('sharp');
const fs = require('fs');
const path = require('path');

const sizes = [16, 48, 128];
const svgPath = path.join(__dirname, '../icons/icon.svg');
const imagesDir = path.join(__dirname, '../images');

async function generateIcons() {
  console.log('🎨 アイコン生成を開始します...\n');

  // SVGファイルの存在確認
  if (!fs.existsSync(svgPath)) {
    console.error('❌ エラー: icon.svg が見つかりません');
    process.exit(1);
  }

  // imagesディレクトリの作成（recursive は既存でも安全）
  fs.mkdirSync(imagesDir, { recursive: true });

  // 各サイズのPNGを並列生成
  await Promise.all(sizes.map(async (size) => {
    const outputPath = path.join(imagesDir, `icon-${size}.png`);
    try {
      await sharp(svgPath)
        .resize(size, size)
        .png()
        .toFile(outputPath);

      console.log(`✅ ${size}x${size} アイコンを生成しました: ${path.basename(outputPath)}`);
    } catch (error) {
      console.error(`❌ ${size}x${size} アイコンの生成に失敗しました:`, error.message);
    }
  }));

  console.log('\n🎉 アイコン生成が完了しました！');
  console.log('\n📂 生成されたファイル:');
  sizes.forEach(size => {
    console.log(`   - images/icon-${size}.png`);
  });
}

generateIcons().catch(error => {
  console.error('❌ エラーが発生しました:', error);
  process.exit(1);
});
