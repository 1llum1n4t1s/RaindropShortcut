#!/usr/bin/env node
// Firefox AMO のスクリーンショット (previews) を JWT 経由で multipart upload するスクリプト。
//
// 使い方:
//   $env:AMO_JWT_ISSUER="user:..."; $env:AMO_JWT_SECRET="..."; node scripts/amo-previews-upload.js
//
// 動作:
//   1. GET /api/v5/addons/addon/{guid}/ で現状確認 + 既存 previews の削除
//   2. POST /api/v5/addons/addon/{guid}/previews/ で webstore/images/*.png を順次 upload
//      - multipart/form-data で image (File) + position (integer)
//      - position は 1, 2, 3, ... の順
//
// 認証: HS256 JWT (amo-metadata-update.js と同じ)
// Node 20+ の global fetch / FormData / Blob を使う

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const ISS = process.env.AMO_JWT_ISSUER;
const SECRET = process.env.AMO_JWT_SECRET;
const GUID = "{37d6aac9-e947-4a4b-982d-f9945e41b234}";
const HOST = "addons.mozilla.org";
const BASE = `https://${HOST}`;

if (!ISS || !SECRET) {
  console.error("❌ AMO_JWT_ISSUER / AMO_JWT_SECRET の環境変数が必要です");
  process.exit(1);
}

// upload 対象 (AMO ストア掲載順、 promo-marquee / promo-small は Chrome Web Store 用なので除外)
const PREVIEWS = [
  { file: "webstore/images/01-feature-overview-1280x800.png", position: 1 },
  { file: "webstore/images/02-how-to-use-1280x800.png", position: 2 },
  { file: "webstore/images/03-hero-promo-1280x800.png", position: 3 },
];

function b64url(buf) {
  return Buffer.from(buf).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function makeJWT() {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iss: ISS,
    jti: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + 60,
  };
  const data = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const sig = b64url(crypto.createHmac("sha256", SECRET).update(data).digest());
  return `${data}.${sig}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rawApi(method, pathStr, opts = {}) {
  const headers = {
    Authorization: `JWT ${makeJWT()}`,
    Accept: "application/json",
    ...(opts.headers || {}),
  };
  const res = await fetch(`${BASE}${pathStr}`, {
    method,
    headers,
    body: opts.body,
  });
  let body;
  const text = await res.text();
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body };
}

// HTTP 429 自動リトライ。 multipart の body は再利用可能 (Blob 由来) なのでそのまま retry できる。
async function api(method, pathStr, opts = {}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const r = await rawApi(method, pathStr, opts);
    if (r.status !== 429) return r;
    const detail = typeof r.body === "object" ? r.body?.detail : "";
    const m = /(\d+)\s*seconds?/i.exec(detail || "");
    const wait = (m ? parseInt(m[1], 10) : 30) + 5;
    console.log(`   ⏳ 429: ${wait}s 待機して retry (attempt=${attempt + 1})`);
    await sleep(wait * 1000);
  }
  throw new Error("429 が 5 回連続で続いたので断念");
}

async function listPreviews(guidEnc) {
  // addon detail の previews フィールドから既存 preview を取る
  const r = await api("GET", `/api/v5/addons/addon/${guidEnc}/?lang=ja`);
  if (r.status !== 200) {
    console.error("❌ GET 失敗:", r.status, JSON.stringify(r.body));
    process.exit(1);
  }
  return r.body.previews || [];
}

async function deletePreview(guidEnc, previewId) {
  const r = await api("DELETE", `/api/v5/addons/addon/${guidEnc}/previews/${previewId}/`);
  return r;
}

async function uploadPreview(guidEnc, filePath, position) {
  const buf = fs.readFileSync(filePath);
  const filename = path.basename(filePath);
  const form = new FormData();
  form.append("image", new Blob([buf], { type: "image/png" }), filename);
  form.append("position", String(position));
  return api("POST", `/api/v5/addons/addon/${guidEnc}/previews/`, { body: form });
}

async function main() {
  const guidEnc = encodeURIComponent(GUID);
  const CHECK_ONLY = process.argv.includes("--check");

  console.log("===== 1. 既存 previews を確認 =====");
  const existing = await listPreviews(guidEnc);
  console.log(`  既存 preview 数: ${existing.length}`);
  for (const p of existing) {
    console.log(`    id=${p.id} position=${p.position} size=${JSON.stringify(p.image_size)}`);
    console.log(`      image_url: ${p.image_url}`);
    if (p.thumbnail_url) console.log(`      thumbnail: ${p.thumbnail_url}`);
  }
  console.log("");

  if (CHECK_ONLY) {
    console.log("✅ --check モード: 確認のみ (削除・upload はスキップ)");
    return;
  }

  if (existing.length > 0) {
    console.log("===== 2. 既存 previews を削除 =====");
    for (const p of existing) {
      const r = await deletePreview(guidEnc, p.id);
      console.log(`  DELETE id=${p.id} → status=${r.status}`);
    }
    console.log("");
  }

  console.log("===== 3. 新規 previews を upload =====");
  for (const { file, position } of PREVIEWS) {
    const fullPath = path.resolve(file);
    if (!fs.existsSync(fullPath)) {
      console.error(`❌ ファイルなし: ${fullPath}`);
      continue;
    }
    const sizeKB = (fs.statSync(fullPath).size / 1024).toFixed(1);
    console.log(`  📷 ${file} (${sizeKB}KB) position=${position}`);
    const r = await uploadPreview(guidEnc, fullPath, position);
    if (r.status >= 400) {
      console.error(`     ❌ status=${r.status}`, JSON.stringify(r.body));
    } else {
      console.log(`     ✅ status=${r.status} id=${r.body?.id} image_url=${r.body?.image_url}`);
    }
  }
  console.log("");

  console.log("===== 4. 反映確認 =====");
  const finalList = await listPreviews(guidEnc);
  console.log(`  最終 preview 数: ${finalList.length}`);
  for (const p of finalList) {
    console.log(`    id=${p.id} position=${p.position} image_size=${JSON.stringify(p.image_size)}`);
  }

  console.log("\n🎉 完了");
}

main().catch((e) => {
  console.error("❌", e);
  process.exit(1);
});
