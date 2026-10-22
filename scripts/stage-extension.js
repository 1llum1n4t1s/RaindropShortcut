// Chrome / Firefox 共通の配布ファイルを、空の出力先へ配置する。
const fs = require('node:fs');
const path = require('node:path');

const [output, browser, ...extra] = process.argv.slice(2);
if (!output || !['chrome', 'firefox'].includes(browser) || extra.length) {
  console.error('Usage: node scripts/stage-extension.js <output-directory> <chrome|firefox>');
  process.exit(1);
}

const root = path.resolve(__dirname, '..');
const destination = path.resolve(output);
if (fs.existsSync(destination)) {
  const stat = fs.lstatSync(destination);
  if (!stat.isDirectory() || stat.isSymbolicLink() || fs.readdirSync(destination).length) {
    throw new Error('Output directory must be empty and must not be a symbolic link.');
  }
} else {
  fs.mkdirSync(destination, { recursive: true });
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
delete manifest.key;
if (browser === 'firefox') {
  manifest.background.scripts = ['src/lib/actions.js', 'src/background/background.js'];
}
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(manifest, null, 2));

fs.mkdirSync(path.join(destination, 'icons'));
for (const size of [16, 48, 128]) {
  const filename = `icon-${size}.png`;
  fs.copyFileSync(path.join(root, 'icons', filename), path.join(destination, 'icons', filename));
}
fs.cpSync(path.join(root, 'src'), path.join(destination, 'src'), {
  recursive: true,
  filter: source => !/(?:\.DS_Store|\.swp|~)$/.test(path.basename(source)),
});
