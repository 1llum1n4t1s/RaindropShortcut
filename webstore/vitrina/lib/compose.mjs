// compose.mjs — テンプレート（4 型 + タイル 2 種）へ文言と実UI画像を差し込み、1280x800 等の PNG にする。
// 文言は文言値（{msg}/ロケール別/共通）を resolveText で解決する。非 en で訳が無ければ例外（英語へ代替しない）。
// 段階縮小（fit.js）・はみ出し・実使用フォント（許可リスト）の検査もここで行い、問題は report.problems に返す。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SIZES, escapeHtml, fontFamilyCss, hexToHue, isAllowedFont, resolveText, toLangTag } from "./config.mjs";
import { collectTextElements } from "./cdp.mjs";
import { toRgb24 } from "./png.mjs";

const TEMPLATE_DIR = fileURLToPath(new URL("../templates/", import.meta.url));
let cache = null;

function templates() {
  if (cache) return cache;
  const read = (name) => fs.readFileSync(path.join(TEMPLATE_DIR, name), "utf8");
  cache = {
    tokens: read("tokens.css"),
    fit: read("fit.js"),
    layouts: Object.fromEntries(["hero", "feature", "wide", "steps", "tile-small", "tile-marquee"].map((n) => [n, read(`${n}.html`)])),
  };
  return cache;
}

/** `{{{raw}}}`（そのまま）と `{{name}}`（エスケープ）を置換する。未定義キーは例外。 */
export function renderTemplate(template, data) {
  const take = (key) => {
    if (!(key in data)) throw new Error(`テンプレートの値が未指定: ${key}`);
    return data[key];
  };
  return template.replace(/\{\{\{(\w+)\}\}\}/g, (_, key) => String(take(key))).replace(/\{\{(\w+)\}\}/g, (_, key) => escapeHtml(take(key)));
}

/** アイコンを data URI にする（setContent の about:blank から file:// を読めないため）。 */
export function iconDataUri(file) {
  const bytes = fs.readFileSync(file);
  const ext = path.extname(file).toLowerCase();
  const mime = ext === ".svg" ? "image/svg+xml" : ext === ".png" ? "image/png" : "application/octet-stream";
  return `data:${mime};base64,${bytes.toString("base64")}`;
}

/** 撮影結果（PNG と撮影時の倍率）から <img> 用の寸法を出す。UI は等倍（CSS px）で置く。 */
export function imageInfo(capture) {
  return { dataUrl: `data:image/png;base64,${capture.png.toString("base64")}`, width: capture.cssWidth, height: capture.cssHeight };
}

/**
 * 実UI枠（ui）または簡易ブラウザ枠（browser）の HTML。max に収まらない場合だけ縮小し、report.notes に残す。
 * smoke のときは「SMOKE」代替板（実UIを使わない）。
 */
export function frameHtml({ capture, kind, max, smoke, notes }) {
  if (smoke) {
    const w = kind === "browser" ? 1120 : capture?.smokeWidth ?? 460;
    const h = kind === "browser" ? 560 : capture?.smokeHeight ?? 600;
    return `<div class="ui-frame smoke-board" style="width:${w}px;height:${h}px">SMOKE</div>`;
  }
  const info = imageInfo(capture);
  if (kind === "browser") {
    if (Math.abs(info.width - 1120) > 1 || Math.abs(info.height - 524) > 1) notes.push(`ブラウザ枠の撮影は 1120x524 が基準（実際 ${info.width}x${info.height}）。cover で収めています`);
    return `<div class="browser"><div class="bar"><i></i><i></i><i></i><b></b></div><img src="${info.dataUrl}" alt=""></div>`;
  }
  const scale = Math.min(1, max.width / info.width, max.height / info.height);
  if (scale < 1) notes.push(`実UIが枠に収まらないため ${(scale * 100).toFixed(0)}% に縮小しました（${info.width}x${info.height}）`);
  const w = Math.round(info.width * scale);
  const h = Math.round(info.height * scale);
  return `<div class="ui-frame" style="width:${w}px;height:${h}px"><img src="${info.dataUrl}" width="${w}" height="${h}" alt=""></div>`;
}

function documentHtml({ body, locale, cfg, size, bodyClass = "" }) {
  const t = templates();
  const hue = hexToHue(cfg.palette.primary);
  const css = `:root{--h:${hue};--primary:${cfg.palette.primary};--secondary:${cfg.palette.secondary};--font:${fontFamilyCss(locale)};--w:${size.width}px;--h-px:${size.height}px}`;
  return `<!doctype html><html lang="${toLangTag(locale)}"><head><meta charset="utf-8"><style>${css}\n${t.tokens}</style></head><body class="${bodyClass}"><div class="orb p"></div><div class="orb s"></div><div class="noise"></div>${body}<script>${t.fit}</script></body></html>`;
}

/**
 * 文言の軽量マークアップ（HTML エスケープ後に適用）。
 *  - `[[語句]]`: その語句の途中で折り返さない（中国語など語の切れ目が無い言語で「留言區」が割れるのを防ぐ）
 *  - 改行（\n）: 強制改行（見出しの折り位置を指定する）
 */
export function rich(text) {
  return escapeHtml(text)
    .replace(/\[\[(.+?)\]\]/g, '<span class="nb">$1</span>')
    .replace(/\n/g, "<br>");
}

/** スライド 1 枚分の本文 HTML を作る。 */
export function slideBody({ slide, locale, cfg, messages, capture, smoke, notes }) {
  const t = templates();
  const text = (value) => resolveText(value, { locale, messages });
  const iconSrc = iconDataUri(cfg.iconFile);
  const frame = (kind, max) => frameHtml({ capture, kind, max, smoke, notes });
  if (slide.layout === "hero") {
    return renderTemplate(t.layouts.hero, {
      iconSrc,
      product: text(slide.product ?? cfg.brand),
      tagline: rich(text(slide.tagline)),
      chips: slide.chips.map((chip) => `<span class="chip">${rich(text(chip))}</span>`).join(""),
      ui: frame("ui", { width: 552, height: 672 }),
    });
  }
  if (slide.layout === "feature") {
    return renderTemplate(t.layouts.feature, {
      kicker: slide.kicker ? `<p class="kicker">${rich(text(slide.kicker))}</p>` : "",
      title: rich(text(slide.title)),
      lead: slide.body ? `<p class="lead" data-fit="lead" data-sizes="24,22,20" data-max-lines="6">${rich(text(slide.body))}</p>` : "",
      bullets: slide.bullets?.length
        ? `<ul class="bullets" data-fit="bullets" data-sizes="22,20,18,18">${slide.bullets.map((b) => `<li>${rich(text(b))}</li>`).join("")}</ul>`
        : "",
      ui: frame("ui", { width: 618, height: 672 }),
    });
  }
  if (slide.layout === "wide") {
    return renderTemplate(t.layouts.wide, {
      title: rich(text(slide.title)),
      lead: slide.body ? `<p class="lead" data-fit="lead" data-sizes="24,22,20" data-max-lines="1">${rich(text(slide.body))}</p>` : "",
      ui: frame("browser"),
    });
  }
  if (slide.layout === "steps") {
    const cards = slide.steps
      .map((step, i) => `<div class="card glass" data-contain="card"><div class="num">${i + 1}</div><h3>${rich(text(step.title))}</h3><p>${rich(text(step.body))}</p></div>`)
      .join("");
    return renderTemplate(t.layouts.steps, { title: rich(text(slide.title)), cards });
  }
  throw new Error(`未対応のレイアウト: ${slide.layout}`);
}

export function tileSmallBody({ cfg }) {
  return renderTemplate(templates().layouts["tile-small"], { iconSrc: iconDataUri(cfg.iconFile), brand: cfg.brand });
}

export function tileMarqueeBody({ cfg, capture, smoke, notes }) {
  const ghost = frameHtml({ capture, kind: "ui", max: { width: 500, height: 480 }, smoke, notes });
  return renderTemplate(templates().layouts["tile-marquee"], { iconSrc: iconDataUri(cfg.iconFile), brand: cfg.brand, tagline: rich(cfg.tiles.tagline), ghost });
}

/**
 * HTML を描画して PNG（RGB 24bit）にする。
 * 返値: { png, report: { ok, problems[], notes[], sizes } }
 * problems があっても PNG は返す（呼び出し側が失敗として扱い、画像を採用しない）。
 */
export async function renderPage(page, { body, locale, cfg, size, notes = [], format = "png24", bodyClass = "", checkFonts = true }) {
  const html = documentHtml({ body, locale, cfg, size, bodyClass });
  await page.setViewport({ width: size.width, height: size.height, deviceScaleFactor: 1 });
  await page.setContent(html, { waitUntil: "load" });
  await page.evaluate(async () => {
    await document.fonts.ready;
    await Promise.all([...document.images].map((img) => (img.complete ? null : img.decode().catch(() => {}))));
  });
  const fit = await page.evaluate(() => window.__vitrinaFit());
  const problems = fit.problems.map((p) => ({ type: "layout", ...p }));

  // 実使用フォント: スライド文言（画像の中身ではなく HTML の文字）が許可リスト外なら失敗。
  // smoke の板は「SMOKE」表示の代替画像で、Windows 同梱フォント前提の検査対象ではない（Linux の CI では
  // 必ず別フォントになる）ため、checkFonts=false で省く。release（Windows）は従来どおり厳密に検査する。
  const elements = checkFonts ? await collectTextElements(page, { fonts: true }) : [];
  const bad = new Map();
  for (const el of elements) {
    for (const font of el.fonts) {
      if (!isAllowedFont(locale, font.family)) bad.set(`${font.family}`, { type: "font", family: font.family, sample: el.text.slice(0, 40), glyphs: (bad.get(font.family)?.glyphs ?? 0) + font.glyphs });
    }
  }
  problems.push(...bad.values());

  let png;
  if (format === "jpeg") {
    png = await page.screenshot({ type: "jpeg", quality: 92, omitBackground: false });
  } else {
    png = toRgb24(Buffer.from(await page.screenshot({ type: "png", omitBackground: false })));
  }
  return { png, report: { ok: problems.length === 0, problems, notes, sizes: fit.sizes, level: fit.level } };
}

export { SIZES };
