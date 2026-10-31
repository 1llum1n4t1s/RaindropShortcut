"use strict";

const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const fs = require("node:fs/promises");
const { createRequire } = require("node:module");
const path = require("node:path");

// 配布経路と同じ web-ext が利用する ZIP 実装を使う。
const webExtRequire = createRequire(require.resolve("web-ext"));
const JSZip = webExtRequire("jszip");
const root = path.resolve(__dirname, "..");

async function verifyExtensionPackage(archivePath, browser, expectedVersion) {
  assert.ok(["chrome", "firefox"].includes(browser), "browser must be chrome or firefox");
  assert.match(expectedVersion || "", /^\d+\.\d+\.\d+$/, "expected version is required");
  const manifest = JSON.parse(await fs.readFile(path.join(root, "manifest.json"), "utf8"));
  const packageJson = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.version, expectedVersion, "root manifest version differs from release version");
  assert.equal(packageJson.version, expectedVersion, "package version differs from release version");
  delete manifest.key;
  if (browser === "firefox") {
    manifest.background.scripts = ["src/lib/actions.js", "src/background/background.js"];
  }

  const payload = new Map();
  async function addSource(relativePath) {
    const sourcePath = path.join(root, relativePath);
    const stat = await fs.lstat(sourcePath);
    assert.ok(!stat.isSymbolicLink(), `source must not be a symbolic link: ${relativePath}`);
    if (stat.isDirectory()) {
      for (const name of await fs.readdir(sourcePath)) {
        // stage-extension.js が除外する作業ファイルと同じ条件。
        if (!/(?:\.DS_Store|\.swp|~)$/.test(name)) {
          await addSource(`${relativePath}/${name}`);
        }
      }
    } else {
      assert.ok(stat.isFile(), `source must be a regular file: ${relativePath}`);
      payload.set(relativePath, await fs.readFile(sourcePath));
    }
  }
  await addSource("src");
  for (const size of [16, 48, 128]) await addSource(`icons/icon-${size}.png`);

  for (const filename of [
    "src/lib/actions.js",
    "src/background/background.js",
    "src/popup/popup.html",
    "src/popup/popup.js",
    "src/popup/popup.css",
  ]) {
    assert.ok(payload.has(filename), `missing required source: ${filename}`);
  }

  const expectedFiles = new Set(["manifest.json", ...payload.keys()]);
  const expectedDirectories = new Set();
  for (const filename of expectedFiles) {
    let directory = path.posix.dirname(filename);
    while (directory !== ".") {
      expectedDirectories.add(`${directory}/`);
      directory = path.posix.dirname(directory);
    }
  }

  const absolutePath = path.resolve(archivePath);
  const archiveStat = await fs.lstat(absolutePath);
  assert.ok(archiveStat.isFile() && !archiveStat.isSymbolicLink(), "archive must be a regular file");
  const bytes = await fs.readFile(absolutePath);
  const zip = await JSZip.loadAsync(bytes, { checkCRC32: true });
  for (const entry of Object.values(zip.files)) {
    assert.ok(!entry.unsafeOriginalName || entry.unsafeOriginalName === entry.name,
      `unsafe archive path: ${entry.unsafeOriginalName}`);
    assert.ok(!entry.name.includes("\\") && !entry.name.startsWith("/"), `invalid archive path: ${entry.name}`);
    assert.ok((Number(entry.unixPermissions) & 0o170000) !== 0o120000,
      `archive must not contain symbolic links: ${entry.name}`);
    if (entry.dir) {
      assert.ok(expectedDirectories.has(entry.name), `unexpected directory: ${entry.name}`);
    } else {
      assert.ok(expectedFiles.has(entry.name), `unexpected file: ${entry.name}`);
    }
  }
  for (const filename of expectedFiles) {
    const entry = zip.file(filename);
    assert.ok(entry, `missing required file: ${filename}`);
    const content = await entry.async("nodebuffer");
    if (filename === "manifest.json") {
      assert.deepStrictEqual(JSON.parse(content.toString("utf8")), manifest, "packaged manifest differs from staged manifest");
    } else {
      assert.ok(content.equals(payload.get(filename)), `packaged bytes differ from source: ${filename}`);
    }
  }

  const identity = {
    archivePath: absolutePath,
    browser,
    version: expectedVersion,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    byteCount: bytes.length,
    fileCount: expectedFiles.size,
  };
  console.log(JSON.stringify(identity));
  return identity;
}

module.exports = { verifyExtensionPackage };

if (require.main === module) {
  const [archivePath, browser, expectedVersion, ...extra] = process.argv.slice(2);
  if (!archivePath || !browser || !expectedVersion || extra.length) {
    console.error("Usage: node scripts/verify-extension-package.js <archive> <chrome|firefox> <release-version>");
    process.exitCode = 1;
  } else {
    verifyExtensionPackage(archivePath, browser, expectedVersion).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
