// checks.mjs — 画像の検証（verify）と、実UI文言の欠陥検出。ブラウザ非依存の純粋ロジック。
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { LOCALES, SIZES, cjkFontLang } from "./config.mjs";
import { inspectJpeg, inspectPng } from "./png.mjs";

const SHOT_RE = /^screenshot-(0[1-5])\.(png|jpg)$/;

/** ひらがな・カタカナ（ja 以外の UI に混ざれば「Localizer を通らず日本語が残った」疑い）。 */
const KANA = /[ぁ-ゖァ-ヺ]/;

function dimsOf(file, ext) {
  const buffer = fs.readFileSync(file);
  if (ext === "jpg") return { ...inspectJpeg(buffer), buffer, format: "jpeg" };
  return { ...inspectPng(buffer), buffer, format: "png" };
}

/**
 * 画像ディレクトリを検査する。
 * 返値: { ok, errors[], warnings[], summary }
 * 検査: 言語ごとの枚数一致（3〜5）、寸法、アルファ無し、命名、.smoke 無し、
 *       スライド別ロケール間ハッシュ重複（英語フォールバック検出）、タイル 2 種の存在と寸法。
 */
export function verifyImages({ imagesDir, locales = LOCALES, format = "png24" }) {
  const errors = [];
  const warnings = [];
  const ext = format === "jpeg" ? "jpg" : "png";
  const summary = { locales: {}, tiles: {} };
  if (!fs.existsSync(imagesDir)) return { ok: false, errors: [`画像ディレクトリが無い: ${imagesDir}`], warnings, summary };

  if (fs.existsSync(path.join(imagesDir, ".smoke"))) errors.push(".smoke が存在します（smoke プロファイルの代替画像。release で作り直してください）");

  // 命名: 直下は ロケール dir / tile-small / tile-marquee / .smoke / ui-defects.json のみ
  const topAllowed = new Set([".smoke", `tile-small.${ext}`, `tile-marquee.${ext}`]);
  for (const entry of fs.readdirSync(imagesDir, { withFileTypes: true })) {
    if (entry.isDirectory() && locales.includes(entry.name)) continue;
    if (entry.isDirectory()) {
      if (LOCALES.includes(entry.name)) continue; // 検査対象外のロケール（--locales で絞った場合）
      errors.push(`命名規約外のディレクトリ: ${entry.name}`);
      continue;
    }
    if (!topAllowed.has(entry.name)) errors.push(`命名規約外のファイル: ${entry.name}`);
  }

  // タイル
  const tiles = [
    [`tile-small.${ext}`, SIZES.tileSmall],
    [`tile-marquee.${ext}`, SIZES.tileMarquee],
  ];
  for (const [name, size] of tiles) {
    const file = path.join(imagesDir, name);
    if (!fs.existsSync(file)) {
      errors.push(`${name} がありません`);
      continue;
    }
    checkOne(file, name, size, ext, errors);
    summary.tiles[name] = true;
  }

  // スクリーンショット
  const counts = new Map();
  const hashesBySlide = new Map(); // "01" → Map(hash → [locale...])
  for (const locale of locales) {
    const dir = path.join(imagesDir, locale);
    if (!fs.existsSync(dir)) {
      errors.push(`ロケール ${locale} のディレクトリがありません`);
      continue;
    }
    const names = fs.readdirSync(dir).sort();
    const shots = [];
    for (const name of names) {
      const m = SHOT_RE.exec(name);
      if (!m || m[2] !== ext) {
        errors.push(`${locale}/${name}: 命名規約（screenshot-01..05.${ext}）外`);
        continue;
      }
      shots.push(m[1]);
      checkOne(path.join(dir, name), `${locale}/${name}`, SIZES.slide, ext, errors);
      const hash = crypto.createHash("sha256").update(fs.readFileSync(path.join(dir, name))).digest("hex");
      const bySlide = hashesBySlide.get(m[1]) ?? new Map();
      bySlide.set(hash, [...(bySlide.get(hash) ?? []), locale]);
      hashesBySlide.set(m[1], bySlide);
    }
    if (shots.length < 3 || shots.length > 5) errors.push(`${locale}: スクリーンショットは 3〜5 枚（現在 ${shots.length}）`);
    shots.forEach((id, index) => {
      if (Number(id) !== index + 1) errors.push(`${locale}: 連番が欠けています（${id} が ${index + 1} 番目）`);
    });
    counts.set(locale, shots.length);
    summary.locales[locale] = shots.length;
  }
  if (new Set(counts.values()).size > 1) errors.push(`言語間で枚数が違います: ${[...counts].map(([l, n]) => `${l}=${n}`).join(", ")}`);

  // 英語フォールバック検出: 同じスライドで 2 言語以上が同一画像
  for (const [slide, byHash] of hashesBySlide) {
    for (const [, group] of byHash) {
      if (group.length > 1) errors.push(`screenshot-${slide}: ${group.join(" と ")} が同一画像（未翻訳・英語フォールバックの疑い）`);
    }
  }
  return { ok: errors.length === 0, errors, warnings, summary };
}

function checkOne(file, label, size, ext, errors) {
  let info;
  try {
    info = dimsOf(file, ext);
  } catch (error) {
    errors.push(`${label}: 読み取り不可（${error.message}）`);
    return;
  }
  if (info.width !== size.width || info.height !== size.height) errors.push(`${label}: 寸法 ${info.width}x${info.height}（期待 ${size.width}x${size.height}）`);
  if (info.format === "png") {
    if (info.colorType !== 2 || info.bitDepth !== 8) errors.push(`${label}: カラータイプ ${info.colorType}/ビット深度 ${info.bitDepth}（24bit RGB=2/8 が必要。アルファ有りは不可）`);
    if (info.hasTransparencyChunk) errors.push(`${label}: tRNS（透過）チャンクがあります`);
  }
}

const CJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/;

/**
 * 字形取り違えの検出（報告のみ）: 別言語向けの CJK フォント（例: ja 文言が Microsoft YaHei）で描かれた CJK 文言。
 * UI 自身が選んだ書体（Noto Serif JP 等、同じ言語向け）は取り違えではない。
 * 空白だけを描いたフォント（描画グリフ数が文言中の空白文字数以下）は、文字の字形ではないので無視する。
 * 返値: [{ kind: "font-mismatch", text, detail }]
 */
export function detectFontMismatches({ locale, text, fonts = [] }) {
  if (!CJK.test(text) || !["ja", "zh_CN", "zh_TW", "ko"].includes(locale)) return [];
  const whitespace = (text.match(/\s/gu) ?? []).length;
  const out = [];
  for (const font of fonts) {
    const lang = cjkFontLang(font.family);
    if (!lang || lang === locale) continue;
    if (font.glyphs <= whitespace) continue;
    out.push({ kind: "font-mismatch", text: text.slice(0, 60), detail: `${font.family}（${lang} 向け・${font.glyphs} グリフ）` });
  }
  return out;
}

/**
 * 実UIの文言を検査して欠陥の一覧を返す（ui-defects.json 用）。
 * texts: [{ text, overflow?, fonts? }]（そのロケールの撮影結果）
 * reference: 同じ capture の en 撮影結果の文言配列（英語のまま残った疑いの検出用）
 * ignoreSameAsEn: same-as-en の対象から外す文言（store-assets.json の ignoreSameAsEn を撮影側で文言へ解決したもの。完全一致）
 */
export function detectUiDefects({ locale, texts, reference = [], ignoreSameAsEn = [] }) {
  const defects = [];
  const refSet = new Set(reference.map((t) => t.text));
  const ignored = new Set(ignoreSameAsEn.map((t) => String(t).replace(/\s+/g, " ").trim()));
  for (const item of texts) {
    const text = item.text;
    if (item.overflow) defects.push({ kind: "overflow", text, detail: item.overflow });
    if (locale !== "ja" && KANA.test(text)) defects.push({ kind: "kana-in-non-ja", text, detail: "仮名が含まれます（Localizer を通らない日本語文言の疑い）" });
    if (locale !== "en" && refSet.has(text) && !ignored.has(text) && /[A-Za-z]{3,}\s+[A-Za-z]{2,}/.test(text)) defects.push({ kind: "same-as-en", text, detail: "英語と同一の複数語文言（未翻訳の疑い）" });
  }
  return defects;
}
