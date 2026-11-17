#!/usr/bin/env bun
// vitrina.mjs — Chrome Web Store 掲載画像（スクショ 3〜5 枚 × 9 言語、小タイル、マーキー）の生成・検証・一覧シート。
//
//   bun webstore/vitrina/vitrina.mjs generate [--work-dir <abs>] [--locales ja,de] [--out <dir>] [--profile release|smoke]
//     （--work-dir 省略時: OS の一時フォルダー（%TEMP% = os.tmpdir()）配下の vitrina-<リポジトリ名>）
//   bun webstore/vitrina/vitrina.mjs verify   [--images-dir <dir>] [--locales ja,de]
//   bun webstore/vitrina/vitrina.mjs sheet    --sheet-dir %TEMP%\<作業名>\sheet [--images-dir <dir>] [--locales ja,de]
//
// 共通オプション: --repo <abs>（既定: このファイルの 2 つ上 = リポジトリ直下）, --config <abs>（既定 webstore/store-assets.json）,
//                --format png24|jpeg（既定 png24）
// 正本は Kagayoi.Support の clients/chrome-extension/store-assets。各リポジトリの webstore/vitrina/ へは
// sync-kit.mjs で逐語コピーする（改変禁止）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultWorkDir, loadConfig, loadMessages, LOCALES, SIZES, escapeHtml } from "./lib/config.mjs";
import { CaptureSession, launchBrowser, assertWorkDir, importPuppeteer, seedChromeProfile } from "./lib/capture.mjs";
import { renderPage, slideBody, tileMarqueeBody, tileSmallBody } from "./lib/compose.mjs";
import { detectUiDefects, verifyImages } from "./lib/checks.mjs";

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const opts = { _: [] };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith("--")) {
      opts._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = rest[i + 1];
    if (next === undefined || next.startsWith("--")) opts[key] = true;
    else {
      opts[key] = next;
      i++;
    }
  }
  return { command, opts };
}

const here = path.dirname(fileURLToPath(import.meta.url));
const ext = (format) => (format === "jpeg" ? "jpg" : "png");

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

async function generate(opts) {
  const repoRoot = path.resolve(opts.repo ?? path.join(here, "..", ".."));
  const cfg = loadConfig(repoRoot, opts.config);
  const profile = opts.profile ?? (process.platform === "win32" ? "release" : "smoke");
  if (!["release", "smoke"].includes(profile)) throw new Error("--profile は release か smoke");
  const smoke = profile === "smoke";
  const format = opts.format ?? "png24";
  const workDir = opts["work-dir"] ?? defaultWorkDir(repoRoot);
  assertWorkDir(workDir);
  const outDir = path.resolve(opts.out ?? path.join(repoRoot, "webstore", "images"));
  const locales = smoke ? ["en"] : opts.locales ? String(opts.locales).split(",") : cfg.locales;
  for (const locale of locales) if (!LOCALES.includes(locale)) throw new Error(`未対応のロケール: ${locale}`);
  if (!smoke && process.platform !== "win32") throw new Error("release は Windows 専用です（フォント検査が Windows 同梱フォント前提）。CI は --profile smoke");

  // 文言辞書: 出力ロケール + en（参照・タイル用）
  const messages = {};
  for (const locale of new Set(["en", ...locales])) {
    messages[locale] = loadMessages(cfg.extensionDir, locale);
    if (!messages[locale]) throw new Error(`_locales/${locale}/messages.json がありません`);
  }

  console.log(`[vitrina] profile=${profile} locales=${locales.join(",")} out=${outDir} work-dir=${workDir}`);
  const browser = await launchBrowser({ workDir, extension: !smoke });
  const failures = [];
  const uiDefects = [];
  const slideReports = [];
  try {
    const session = smoke ? null : new CaptureSession({ browser, cfg, messages });
    if (session) console.log(`[vitrina] extension id = ${await session.init()}`);

    // 必要な capture（スライド用 + タイル用）を、en（参照）と各ロケールで撮る
    const needed = [...new Set([...cfg.slides.map((s) => s.capture).filter(Boolean), cfg.tiles.capture])];
    const captures = new Map(); // `${locale}:${id}` → result
    if (session) {
      for (const locale of new Set(["en", ...locales])) {
        for (const id of needed) {
          const cap = cfg.captures.find((c) => c.id === id);
          const result = await session.capture(cap, locale);
          captures.set(`${locale}:${id}`, result);
          console.log(`[vitrina] capture ${locale}/${id} ${result.cssWidth}x${result.cssHeight}`);
        }
      }
      // 英語のまま残った疑い（en 撮影との比較）を加えて ui-defects へ
      for (const [key, result] of captures) {
        const [locale, id] = key.split(":");
        const ref = captures.get(`en:${id}`);
        const extra = locale === "en" ? [] : detectUiDefects({ locale, texts: result.texts, reference: ref?.texts ?? [], ignoreSameAsEn: result.ignoreTexts ?? [] }).filter((d) => d.kind === "same-as-en");
        for (const defect of [...result.defects, ...extra]) uiDefects.push({ locale, capture: id, ...defect });
      }
    }

    const page = await browser.newPage();
    const jobs = [];
    const smokeCapture = (id) => {
      const cap = cfg.captures.find((c) => c.id === id);
      return { smokeWidth: cap.width ?? 460, smokeHeight: cap.height ?? 600 };
    };
    const captureFor = (locale, id) => (smoke ? smokeCapture(id) : captures.get(`${locale}:${id}`));

    for (const locale of locales) {
      for (let i = 0; i < cfg.slides.length; i++) {
        const slide = cfg.slides[i];
        const name = `screenshot-${String(i + 1).padStart(2, "0")}.${ext(format)}`;
        jobs.push({
          label: `${locale}/${name}`,
          file: path.join(outDir, locale, name),
          reject: path.join(workDir, "rejected", `${locale}-${name}`),
          size: SIZES.slide,
          locale,
          body: (notes) => slideBody({ slide, locale, cfg, messages, capture: slide.capture ? captureFor(locale, slide.capture) : null, smoke, notes }),
        });
      }
    }
    if (!opts["no-tiles"]) {
      jobs.push({ label: "tile-small", file: path.join(outDir, `tile-small.${ext(format)}`), reject: path.join(workDir, "rejected", "tile-small.png"), size: SIZES.tileSmall, locale: "en", bodyClass: "t-small", body: () => tileSmallBody({ cfg }) });
      jobs.push({
        label: "tile-marquee",
        file: path.join(outDir, `tile-marquee.${ext(format)}`),
        reject: path.join(workDir, "rejected", "tile-marquee.png"),
        size: SIZES.tileMarquee,
        locale: "en",
        body: (notes) => tileMarqueeBody({ cfg, capture: captureFor("en", cfg.tiles.capture), smoke, notes }),
      });
    }

    for (const job of jobs) {
      const notes = [];
      let result;
      try {
        result = await renderPage(page, { body: job.body(notes), locale: job.locale, cfg, size: job.size, notes, format, bodyClass: job.bodyClass });
      } catch (error) {
        failures.push({ label: job.label, problems: [{ type: "error", message: error.message }] });
        console.error(`[vitrina] FAIL ${job.label}: ${error.message}`);
        continue;
      }
      slideReports.push({ label: job.label, ...result.report });
      if (result.report.ok) {
        write(job.file, result.png);
        console.log(`[vitrina] wrote ${job.label}${notes.length ? `  (${notes.join(" / ")})` : ""}`);
      } else {
        write(job.reject, result.png);
        failures.push({ label: job.label, problems: result.report.problems });
        console.error(`[vitrina] REJECT ${job.label}: ${JSON.stringify(result.report.problems)}（画像は ${job.reject} へ退避。採用しません）`);
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }

  if (smoke) write(path.join(outDir, ".smoke"), "smoke プロファイルの代替画像です。release で作り直してください。\n");
  // release でも却下（失敗）が 1 件でもあれば .smoke を消さない（前回の SMOKE 板が残ったまま verify が通るのを防ぐ）
  else if (!failures.length && fs.existsSync(path.join(outDir, ".smoke"))) fs.rmSync(path.join(outDir, ".smoke"));
  write(path.join(workDir, "ui-defects.json"), JSON.stringify(uiDefects, null, 2));
  write(path.join(workDir, "slide-reports.json"), JSON.stringify(slideReports, null, 2));
  console.log(`[vitrina] ui-defects: ${uiDefects.length} 件 → ${path.join(workDir, "ui-defects.json")}`);
  if (failures.length) {
    console.error(`[vitrina] 生成失敗 ${failures.length} 件`);
    process.exitCode = 1;
  } else if (opts["strict-ui"] && uiDefects.length) {
    console.error("[vitrina] --strict-ui: 実UIの欠陥があるため失敗");
    process.exitCode = 1;
  }
}

function verify(opts) {
  const repoRoot = path.resolve(opts.repo ?? path.join(here, "..", ".."));
  const imagesDir = path.resolve(opts["images-dir"] ?? path.join(repoRoot, "webstore", "images"));
  let locales = LOCALES;
  if (opts.locales) locales = String(opts.locales).split(",");
  else {
    try {
      locales = loadConfig(repoRoot, opts.config).locales;
    } catch {
      /* 設定が読めなければ 9 言語 */
    }
  }
  const result = verifyImages({ imagesDir, locales, format: opts.format ?? "png24" });
  for (const warning of result.warnings) console.warn(`[verify] WARN ${warning}`);
  for (const error of result.errors) console.error(`[verify] NG ${error}`);
  console.log(`[verify] ${result.ok ? "OK" : "NG"} locales=${JSON.stringify(result.summary.locales)} tiles=${Object.keys(result.summary.tiles).join(",")}`);
  if (!result.ok) process.exitCode = 1;
}

/** スライドごとに言語を 3x3 に並べた PNG と index.html を作る。 */
async function sheet(opts) {
  const repoRoot = path.resolve(opts.repo ?? path.join(here, "..", ".."));
  const imagesDir = path.resolve(opts["images-dir"] ?? path.join(repoRoot, "webstore", "images"));
  const sheetDir = opts["sheet-dir"];
  assertWorkDir(sheetDir);
  const e = ext(opts.format ?? "png24");
  const locales = (opts.locales ? String(opts.locales).split(",") : LOCALES).filter((l) => fs.existsSync(path.join(imagesDir, l)));
  const slideNames = new Set();
  for (const l of locales) for (const n of fs.readdirSync(path.join(imagesDir, l))) if (n.endsWith(`.${e}`)) slideNames.add(n);
  const names = [...slideNames].sort();
  const url = (file) => new URL(`file:///${file.replace(/\\/g, "/")}`).href;
  const style = `body{margin:0;background:#0d1117;color:#e6edf3;font:14px "Segoe UI",sans-serif}.grid{display:grid;grid-template-columns:repeat(3,400px);gap:16px;padding:24px;justify-content:center}.cell img{display:block;width:400px;height:250px;border-radius:8px}.cell b{display:block;margin:6px 2px;font-size:13px}h1{margin:16px 24px 0;font-size:16px}`;
  const pages = [];
  for (const name of names) {
    const cells = locales.filter((l) => fs.existsSync(path.join(imagesDir, l, name))).map((l) => `<div class="cell"><b>${escapeHtml(l)}</b><img src="${url(path.join(imagesDir, l, name))}"></div>`).join("");
    pages.push({ id: `sheet-${name.replace(/\.\w+$/, "")}`, html: `<!doctype html><meta charset="utf-8"><style>${style}</style><h1>${escapeHtml(name)}</h1><div class="grid">${cells}</div>` });
  }
  const tiles = ["tile-small", "tile-marquee"].filter((n) => fs.existsSync(path.join(imagesDir, `${n}.${e}`)));
  if (tiles.length) {
    const cells = tiles.map((n) => `<div class="cell"><b>${n}</b><img style="width:auto;height:auto;max-width:1100px" src="${url(path.join(imagesDir, `${n}.${e}`))}"></div>`).join("");
    pages.push({ id: "sheet-tiles", html: `<!doctype html><meta charset="utf-8"><style>${style}.grid{display:block}.cell{margin-bottom:16px}</style><h1>tiles</h1><div class="grid">${cells}</div>` });
  }
  fs.mkdirSync(sheetDir, { recursive: true });
  const puppeteer = await importPuppeteer();
  // プロファイルは OS の一時フォルダー（C:）へ作らず、--work-dir（未指定は既定の work-dir。generate と同じ）に置く
  const userDataDir = path.join(opts["work-dir"] ?? defaultWorkDir(repoRoot), `sheet-profile-${process.pid}`);
  seedChromeProfile(userDataDir); // Windows アカウントのロック防止（lib/capture.mjs のコメント参照）
  const browser = await puppeteer.launch({ headless: true, userDataDir, args: process.platform === "win32" ? [] : ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 100, deviceScaleFactor: 1 }); // fullPage で内容の高さに切り詰める
    for (const sheetPage of pages) {
      const htmlFile = path.join(sheetDir, `${sheetPage.id}.html`);
      fs.writeFileSync(htmlFile, sheetPage.html);
      await page.goto(url(htmlFile), { waitUntil: "load" });
      await page.screenshot({ path: path.join(sheetDir, `${sheetPage.id}.png`), fullPage: true });
      console.log(`[sheet] ${path.join(sheetDir, `${sheetPage.id}.png`)}`);
    }
  } finally {
    await browser.close().catch(() => {});
  }
  const index = `<!doctype html><meta charset="utf-8"><title>vitrina sheet</title><style>${style}img{max-width:100%;margin:12px 0}</style>${pages.map((p) => `<h1>${p.id}</h1><img src="${p.id}.png">`).join("")}`;
  fs.writeFileSync(path.join(sheetDir, "index.html"), index);
  console.log(`[sheet] ${path.join(sheetDir, "index.html")}`);
}

const { command, opts } = parseArgs(process.argv.slice(2));
try {
  if (command === "generate") await generate(opts);
  else if (command === "verify") verify(opts);
  else if (command === "sheet") await sheet(opts);
  else {
    console.error("使い方: vitrina.mjs <generate|verify|sheet> [options]（README.md を参照）");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(`[vitrina] エラー: ${error.message}`);
  process.exitCode = 1;
}
