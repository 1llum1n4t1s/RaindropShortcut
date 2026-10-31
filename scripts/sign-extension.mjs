import { lstat, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { cmd } from "web-ext";
import { signAddon } from "web-ext/util/submit-addon";
import verifier from "./verify-extension-package.js";

const require = createRequire(import.meta.url);
const { version: webextVersion } = JSON.parse(
  await readFile(path.join(path.dirname(require.resolve("web-ext")), "package.json"), "utf8"),
);

async function rejectPreviousUpload(filename) {
  try {
    await lstat(filename);
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Cannot reuse an AMO upload without its verified SHA-256 identity: ${filename}`);
}

// 公開 API の submitAddon hook で、実生成された同じ XPI を提出直前に確認する。
// hook の差し替えは外部送信なしで梱包経路を確認するときにも利用できる。
export async function signVerifiedExtension({
  sourceDir,
  artifactsDir,
  expectedVersion,
  amoMetadata = ".amo-metadata.json",
}, { submitAddon = signAddon } = {}) {
  if (!process.env.WEB_EXT_API_KEY || !process.env.WEB_EXT_API_SECRET) {
    throw new Error("WEB_EXT_API_KEY / WEB_EXT_API_SECRET are required");
  }
  const source = path.resolve(sourceDir);
  await rejectPreviousUpload(path.join(source, ".amo-upload-uuid"));
  return cmd.sign({
    sourceDir: source,
    artifactsDir: path.resolve(artifactsDir),
    channel: "listed",
    amoMetadata: path.resolve(amoMetadata),
    approvalTimeout: 0,
    apiKey: process.env.WEB_EXT_API_KEY,
    apiSecret: process.env.WEB_EXT_API_SECRET,
    apiProxy: process.env.WEB_EXT_API_PROXY,
    webextVersion,
  }, {
    submitAddon: async args => {
      await rejectPreviousUpload(args.savedUploadUuidPath);
      await verifier.verifyExtensionPackage(args.xpiPath, "firefox", expectedVersion);
      // AMO が後で署名・再包装する配信物とは別の提出物 identity を出力する。
      return submitAddon(args);
    },
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [sourceDir, artifactsDir, expectedVersion, ...extra] = process.argv.slice(2);
  if (!sourceDir || !artifactsDir || !expectedVersion || extra.length) {
    console.error("Usage: node scripts/sign-extension.mjs <source-directory> <artifacts-directory> <release-version>");
    process.exitCode = 1;
  } else {
    signVerifiedExtension({ sourceDir, artifactsDir, expectedVersion }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
