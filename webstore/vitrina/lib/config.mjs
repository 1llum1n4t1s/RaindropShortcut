// config.mjs — store-assets.json の読み込み・検証と、文言（{msg}/ロケール別）の解決。
// 純粋関数中心（ブラウザ非依存）にして、テストで固定できるようにする。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** 9 言語（Kagayoi の拡張共通）。en が正本。 */
export const LOCALES = Object.freeze(["en", "ja", "zh_CN", "zh_TW", "ko", "es", "fr", "de", "pt_BR"]);

/**
 * --work-dir の既定値。Chrome プロファイル・却下画像・ui-defects.json の置き場。
 *  - Windows で D: がある: D:\tmp\vitrina-<リポジトリ名>（C ドライブへ作業物を置かない運用）
 *  - それ以外（D: が無い Windows、CI の Linux 等）: OS の一時フォルダー配下の vitrina-<リポジトリ名>
 * 注意: JS 文字列では "D:\tmp" の \t がタブになるため、バックスラッシュは必ず "\\" と書く（過去の実害）。
 * platform / tmpdir / driveExists はテスト用の差し込み口。
 */
export function defaultWorkDir(repoRoot, { platform = process.platform, tmpdir = os.tmpdir(), driveExists = (drive) => fs.existsSync(drive) } = {}) {
  const flavor = platform === "win32" ? path.win32 : path.posix; // ホストと platform が違っても同じ結果にする（テスト用）
  const name = `vitrina-${flavor.basename(flavor.resolve(repoRoot))}`;
  if (platform === "win32") {
    return driveExists("D:\\") ? path.win32.join("D:\\", "tmp", name) : path.win32.join(tmpdir, name);
  }
  return path.posix.join(tmpdir, name);
}

/** 出力サイズ。 */
export const SIZES = Object.freeze({
  slide: { width: 1280, height: 800 },
  tileSmall: { width: 440, height: 280 },
  tileMarquee: { width: 1400, height: 560 },
});

/** ロケール別フォントスタック（DESIGN-BRIEF のとおり。Windows 同梱フォントのみ）。 */
export const FONT_STACKS = Object.freeze({
  en: ["Segoe UI Variable Display", "Segoe UI"],
  es: ["Segoe UI Variable Display", "Segoe UI"],
  fr: ["Segoe UI Variable Display", "Segoe UI"],
  de: ["Segoe UI Variable Display", "Segoe UI"],
  pt_BR: ["Segoe UI Variable Display", "Segoe UI"],
  ja: ["Noto Sans JP", "Yu Gothic UI"],
  ko: ["Malgun Gothic"],
  zh_CN: ["Microsoft YaHei UI"],
  zh_TW: ["Microsoft JhengHei UI"],
});

/** 記号の字形補完として許す（取り違えではない）フォント。 */
export const FALLBACK_FONTS = Object.freeze(["Segoe UI Symbol", "Segoe UI Emoji"]);

/** CJK システムフォントの言語区分（UI の字形取り違え検出用）。他言語用のフォントで描かれた文言を拾う。 */
const CJK_FONT_LANG = [
  ["ja", /^(Noto (Sans|Serif) JP|Yu Gothic|Yu Mincho|Meiryo|MS (P)?(Gothic|Mincho)|BIZ UD|Hiragino|IPA)/i],
  ["zh_CN", /^(Microsoft YaHei|SimSun|SimHei|NSimSun|DengXian|Noto (Sans|Serif) SC|PingFang SC)/i],
  ["zh_TW", /^(Microsoft JhengHei|PMingLiU|MingLiU|Noto (Sans|Serif) TC|PingFang TC)/i],
  ["ko", /^(Malgun Gothic|Batang|Gulim|Dotum|Gungsuh|Noto (Sans|Serif) KR)/i],
];
export function cjkFontLang(family) {
  return CJK_FONT_LANG.find(([, re]) => re.test(family))?.[0] ?? null;
}

/** `zh_CN` → `zh-CN`（html の lang 属性）。 */
export const toLangTag = (locale) => String(locale).replace("_", "-");

/** CSS の font-family 値。 */
export function fontFamilyCss(locale) {
  const stack = FONT_STACKS[locale];
  if (!stack) throw new Error(`未対応のロケール: ${locale}`);
  return [...stack, ...FALLBACK_FONTS].map((name) => `"${name}"`).join(", ") + ", sans-serif";
}

/** 実使用フォントが、そのロケールの許可リスト（接頭辞一致: "Segoe UI Black" など派生を許す）に入るか。 */
export function isAllowedFont(locale, familyName) {
  const allowed = [...(FONT_STACKS[locale] ?? []), ...FALLBACK_FONTS];
  return allowed.some((name) => familyName === name || familyName.startsWith(`${name} `));
}

/** `#RRGGBB` → 色相 0–359（四捨五入）。 */
export function hexToHue(hex) {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`色は #RRGGBB で指定してください: ${hex}`);
  const n = parseInt(m[1], 16);
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return Math.round((h * 60 + 360) % 360) % 360;
}

/** messages.json を ui-localizer の compact 形（{ key: { m, p? } }）にする。ui-localizer.js の compact と同じ規則。 */
export function compactMessages(json) {
  const out = {};
  if (!json || typeof json !== "object") return out;
  for (const [key, entry] of Object.entries(json)) {
    if (typeof entry?.message !== "string") continue;
    out[key] = entry.placeholders ? { m: entry.message, p: entry.placeholders } : { m: entry.message };
  }
  return out;
}

export function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, ""));
}

/** 設定を読み、相対パスを絶対化して返す。検証エラーは全件を 1 つの例外メッセージにまとめる。 */
export function loadConfig(repoRoot, configPath) {
  const file = configPath ? path.resolve(configPath) : path.join(repoRoot, "webstore", "store-assets.json");
  const raw = readJson(file);
  const cfg = { ...raw, configFile: file, repoRoot };
  cfg.extensionDir = path.resolve(repoRoot, raw.extensionDir ?? ".");
  cfg.iconFile = path.resolve(repoRoot, raw.icon ?? "icons/icon.svg");
  cfg.fixturesDir = path.resolve(repoRoot, raw.fixturesDir ?? "webstore/fixtures");
  cfg.locales = raw.locales ?? [...LOCALES];
  const errors = validateConfig(cfg);
  if (errors.length) throw new Error(`${file} の検証に失敗しました:\n- ${errors.join("\n- ")}`);
  return cfg;
}

const HEX = /^#[0-9a-f]{6}$/i;
const LAYOUTS = ["hero", "feature", "wide", "steps"];

export function validateConfig(cfg) {
  const errors = [];
  if (!cfg.brand || !/^[\x20-\x7e]+$/.test(cfg.brand)) errors.push("brand は ASCII の英字ワードマークで指定してください");
  if (!cfg.palette || !HEX.test(cfg.palette.primary ?? "") || !HEX.test(cfg.palette.secondary ?? "")) errors.push("palette.primary / secondary は #RRGGBB で指定してください");
  for (const locale of cfg.locales) if (!LOCALES.includes(locale)) errors.push(`未対応のロケール: ${locale}`);
  const captures = Array.isArray(cfg.captures) ? cfg.captures : [];
  const ids = new Set();
  for (const capture of captures) {
    if (!capture.id) errors.push("captures[].id が必要です");
    if (ids.has(capture.id)) errors.push(`captures の id が重複: ${capture.id}`);
    ids.add(capture.id);
    if (capture.kind !== "popup" && capture.kind !== "page") errors.push(`captures[${capture.id}].kind は popup か page`);
    if (capture.kind === "popup" && !capture.page) errors.push(`captures[${capture.id}].page（拡張内のパス）が必要です`);
    if (capture.kind === "page" && (!capture.url || !capture.fixture)) errors.push(`captures[${capture.id}] は url と fixture が必要です`);
  }
  const slides = Array.isArray(cfg.slides) ? cfg.slides : [];
  if (slides.length < 3 || slides.length > 5) errors.push(`slides は 3〜5 枚（現在 ${slides.length}）`);
  slides.forEach((slide, index) => {
    const label = `slides[${index}]`;
    if (!LAYOUTS.includes(slide.layout)) errors.push(`${label}.layout は ${LAYOUTS.join("/")}`);
    if (slide.layout !== "steps" && !ids.has(slide.capture)) errors.push(`${label}.capture が captures に無い: ${slide.capture}`);
    if (slide.layout === "hero" && index !== 0) errors.push(`${label}: hero は 1 枚目だけ`);
    if (slide.layout === "hero" && (!slide.tagline || !Array.isArray(slide.chips) || slide.chips.length < 1 || slide.chips.length > 3)) errors.push(`${label}: hero は tagline と chips（1〜3）が必要`);
    if (slide.layout !== "hero" && !slide.title) errors.push(`${label}.title が必要`);
    if (slide.bullets && slide.bullets.length > 3) errors.push(`${label}.bullets は 3 つまで`);
    if (slide.layout === "steps" && (!Array.isArray(slide.steps) || slide.steps.length !== 3)) errors.push(`${label}.steps は 3 つ`);
  });
  if (cfg.ignoreSameAsEn !== undefined && (!Array.isArray(cfg.ignoreSameAsEn) || cfg.ignoreSameAsEn.some((v) => typeof v !== "string" || !v.trim()))) errors.push("ignoreSameAsEn は空でない文字列（文言そのものか CSS セレクター）の配列");
  const tiles = cfg.tiles ?? {};
  if (typeof tiles.tagline !== "string" || !tiles.tagline || [...tiles.tagline].length > 40) errors.push("tiles.tagline は英語 1 行 40 字以内");
  if (!ids.has(tiles.capture)) errors.push(`tiles.capture が captures に無い: ${tiles.capture}`);
  return errors;
}

/** `_locales/<locale>/messages.json` を読む。無ければ null。 */
export function loadMessages(extensionDir, locale) {
  const file = path.join(extensionDir, "_locales", locale, "messages.json");
  return fs.existsSync(file) ? readJson(file) : null;
}

/**
 * 文言値をそのロケールの文字列にする。
 *  - 文字列: 全ロケール共通（製品名など）
 *  - { msg: "<キー>" }: _locales の message
 *  - { en, ja, ... }: ロケール別の直書き
 * 非 en でそのロケールの訳が無い場合は、英語へ黙ってフォールバックせず例外にする（英語混入の防止）。
 * `$…$` の placeholders を含む message は対象外（画像文言には使わない）。
 * messages は { <locale>: messages.json の中身 }。
 */
export function resolveText(value, { locale, messages }) {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && typeof value.msg === "string") {
    const entry = messages?.[locale]?.[value.msg];
    if (!entry || typeof entry.message !== "string") throw new Error(`_locales/${locale} に message が無い: ${value.msg}`);
    if (entry.placeholders || /\$[A-Za-z0-9_]+\$|\$[1-9]/.test(entry.message)) throw new Error(`placeholders を含む message は画像に使えません: ${value.msg}`);
    return entry.message;
  }
  if (value && typeof value === "object") {
    const text = value[locale];
    if (typeof text !== "string" || !text) throw new Error(`${locale} の文言が無い（英語へ代替しません）: ${JSON.stringify(value).slice(0, 80)}`);
    return text;
  }
  throw new Error(`文言の形式が不正です: ${JSON.stringify(value)}`);
}

/** HTML エスケープ。 */
export function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
