// capture.mjs — 実拡張を puppeteer 同梱の Chrome for Testing へ読み込み、ロケール別に実UIを撮影する。
//
// 方式（スパイクで Windows + Bun 1.4 にて確認済み）:
//  - puppeteer.launch({ headless: true, pipe: true, enableExtensions: true }) + browser.installExtension(dir)。
//  - 言語切替は拡張の Service Worker から chrome.storage.local へ ui-localizer の 3 キー
//    （uiLanguage / uiMessages(compact) / uiMessagesVersion）を書く。--lang は使わない
//    （Localizer を通らない文言が英語で残れば拡張側の不具合として検出するため）。
//  - popup は chrome-extension://<id>/<page> をタブで開き、body 寸法に合わせたビューポートで撮影する。
//  - ページ注入UI（content script）は matches に合う実 URL へ遷移し、setRequestInterception で
//    fixtures/*.html を返す。他リクエストは 404（data:/chrome-extension:/blob: は通す）。実通信は
//    --host-resolver-rules でも止める。
//  - 注意: www.google.com/search?q=… は Chrome が sei= を付けて実 Google へ出てしまい fixture に差し替わらない
//    ことがあった。ccTLD（www.google.co.jp 等）は通る。遷移後に URL と fixture 目印の両方を必ず検査する。
import fs from "node:fs";
import path from "node:path";
import { collectTextElements, overflowOf } from "./cdp.mjs";
import { compactMessages, readJson, toLangTag } from "./config.mjs";
import { detectFontMismatches, detectUiDefects } from "./checks.mjs";

/** 拡張ページの localStorage 控え（ui-localizer.js の LOCAL_KEY）。<html lang> を同期で決めるのに使われる。 */
const LOCAL_LANG_KEY = "cpaUiLanguage";

/**
 * 拡張のコンテキスト（Service Worker か拡張ページ）の中で実行して storage を作り直す。
 * puppeteer が関数を文字列化して送るので、外の変数に依存しない自己完結の関数にすること。
 * storage 権限の無い拡張では chrome.storage が無いので false を返す（呼び出し側で扱う）。
 */
async function writeStorage(values, syncValues) {
  const local = typeof chrome !== "undefined" ? chrome.storage?.local : undefined;
  if (!local) return false;
  await local.clear();
  await local.set(values);
  // sync 側（設定を sync に置く拡張）も毎回作り直す
  const sync = chrome.storage.sync;
  if (sync) {
    await sync.clear();
    if (Object.keys(syncValues).length) await sync.set(syncValues);
  }
  return true;
}

export async function importPuppeteer() {
  const mod = await import("puppeteer");
  return mod.default ?? mod;
}

/** 設定ミス（相対パス等）の早期検出。work-dir は D:\tmp 配下などの未使用の絶対パス。 */
export function assertWorkDir(workDir) {
  if (!workDir || !path.isAbsolute(workDir)) throw new Error("--work-dir は絶対パスで指定してください（例: D:\\tmp\\<作業名>）");
}

/**
 * Windows のアカウントロック防止（必須）。
 *
 * Chromium は Windows で「OS ユーザーのパスワードが空か」を確かめるため、パスワード空で
 * LogonUser を呼ぶ（chrome/browser/password_manager/password_manager_util_win.cc の
 * CheckBlankPasswordWithPrefs）。空でないアカウントでは毎回「ログオン失敗」(Security 4625) になり、
 * 結果は Local State の password_manager.os_password_last_changed / os_password_blank に保存される。
 * 新しいプロファイルを作るたびにこの確認が走るため、並列・連続で起動すると失敗回数が
 * ロックアウトのしきい値（例: 10 分で 10 回）を超え、Windows アカウントがロックされた（2026-11-15 実害）。
 *
 * 対策として、起動前に Local State へ「確認済み・空パスワードではない」を書いておく。
 * need_recheck は `pref_last_changed > 0 && last_changed <= pref_last_changed` で false になるので、
 * os_password_last_changed に int64 の上限近い値（Chromium の int64 pref は文字列で保存）を入れれば
 * パスワードを変更しても再確認されない。あわせてパスワードマネージャー自体も無効にする。
 * 既存の Local State / Preferences がある場合は中身を保ったまま必要なキーだけ上書きする。
 */
export function seedChromeProfile(userDataDir) {
  fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  const merge = (file, patch) => {
    let json = {};
    try { json = JSON.parse(fs.readFileSync(file, "utf8")); } catch { json = {}; }
    for (const [section, values] of Object.entries(patch)) {
      json[section] = { ...(json[section] && typeof json[section] === "object" ? json[section] : {}), ...values };
    }
    fs.writeFileSync(file, JSON.stringify(json));
  };
  merge(path.join(userDataDir, "Local State"), {
    password_manager: { os_password_blank: false, os_password_last_changed: "9223372036854775000" },
  });
  merge(path.join(userDataDir, "Default", "Preferences"), {
    profile: { password_manager_enabled: false },
  });
  // credentials_enable_service はトップレベルのキー
  const prefsFile = path.join(userDataDir, "Default", "Preferences");
  const prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
  prefs.credentials_enable_service = false;
  fs.writeFileSync(prefsFile, JSON.stringify(prefs));
}

/** ブラウザを起動する。extension=false は smoke（実拡張を読まない）。 */
export async function launchBrowser({ workDir, extension }) {
  assertWorkDir(workDir);
  fs.mkdirSync(workDir, { recursive: true });
  const puppeteer = await importPuppeteer();
  const userDataDir = path.join(workDir, `profile-${process.pid}-${Date.now()}`);
  seedChromeProfile(userDataDir); // Windows アカウントのロック防止（上記コメント参照）
  const args = ["--host-resolver-rules=MAP * ~NOTFOUND"];
  if (process.platform !== "win32") args.push("--no-sandbox");
  return puppeteer.launch({ headless: true, pipe: true, enableExtensions: !!extension, userDataDir, args });
}

export class CaptureSession {
  constructor({ browser, cfg, messages }) {
    this.browser = browser;
    this.cfg = cfg;
    this.messages = messages;
    this.extensionId = null;
    this.worker = null;
    this.manifest = readJson(path.join(cfg.extensionDir, "manifest.json"));
    this.manifestVersion = this.manifest.version;
    // Service Worker の無い拡張（background なし）は、拡張ページ経由で storage を書く
    this.hasServiceWorker = !!this.manifest.background?.service_worker;
    this.currentLocale = "en";
    this.steps = null;
  }

  async init() {
    this.extensionId = await this.browser.installExtension(this.cfg.extensionDir);
    if (this.hasServiceWorker) await this.getWorker();
    const stepsFile = path.join(this.cfg.repoRoot, "webstore", "store-assets.steps.mjs");
    if (fs.existsSync(stepsFile)) this.steps = (await import(pathToUrl(stepsFile))).default ?? {};
    return this.extensionId;
  }

  async getWorker() {
    if (this.worker) return this.worker;
    const id = this.extensionId;
    const target = await this.browser.waitForTarget((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${id}/`), { timeout: 20000 });
    this.worker = await target.worker();
    return this.worker;
  }

  /**
   * storage を書くための拡張ページ（Service Worker が無い拡張用）。
   * manifest の popup / options を優先し、無ければ popup 型 capture のページを使う。
   */
  storagePagePath() {
    const m = this.manifest;
    const fromManifest = m.action?.default_popup ?? m.browser_action?.default_popup ?? m.options_ui?.page ?? m.options_page;
    const fromCapture = this.cfg.captures.find((c) => c.kind === "popup")?.page;
    return fromManifest ?? fromCapture ?? null;
  }

  /**
   * 言語（と capture 固有の storage）を拡張の storage.local へ書く。毎回 clear して前の状態を持ち越さない。
   *  - Service Worker がある拡張: SW 内で書く（停止していたら取り直して 1 回だけ再試行）。
   *  - Service Worker が無い拡張: 拡張ページを開いて、そのページの文脈で書く。
   *  - storage 権限が無い拡張（chrome.storage が無い）: 書き込みを省く。capture が storage を要求していれば設定ミスなので例外。
   */
  async prepareStorage(locale, extra = {}, syncItems = {}) {
    const dict = this.messages[locale];
    if (!dict) throw new Error(`_locales/${locale} がありません`);
    const items = { uiLanguage: locale, uiMessages: compactMessages(dict), uiMessagesVersion: this.manifestVersion, ...extra };
    const written = this.hasServiceWorker ? await this.#writeViaWorker(items, syncItems) : await this.#writeViaPage(items, syncItems);
    if (!written && (Object.keys(extra).length || Object.keys(syncItems).length)) {
      throw new Error("capture が storage / syncStorage を指定していますが、この拡張には storage 権限がありません（manifest の permissions を確認）");
    }
  }

  async #writeViaWorker(items, syncItems) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const worker = await this.getWorker();
        return await worker.evaluate(writeStorage, items, syncItems);
      } catch (error) {
        this.worker = null; // SW が停止した場合は取り直す
        if (attempt === 1) throw error;
      }
    }
  }

  async #writeViaPage(items, syncItems) {
    const pagePath = this.storagePagePath();
    if (!pagePath) throw new Error("Service Worker の無い拡張で storage を書くための拡張ページ（popup / options）が見つかりません");
    const page = await this.browser.newPage();
    try {
      await page.goto(`chrome-extension://${this.extensionId}/${pagePath}`, { waitUntil: "load" });
      return await page.evaluate(writeStorage, items, syncItems);
    } finally {
      await page.close().catch(() => {});
    }
  }

  /** 1 つの capture を 1 ロケールで撮る。 */
  async capture(cap, locale) {
    this.currentLocale = locale;
    await this.prepareStorage(locale, cap.storage ?? {}, cap.syncStorage ?? {});
    const page = await this.browser.newPage();
    try {
      const dsf = cap.scale ?? 2;
      const notes = [];
      if (cap.kind === "popup") await this.#openPopup(page, cap, dsf);
      else await this.#openFixturePage(page, cap, dsf);
      if (this.steps?.[cap.id]) await this.steps[cap.id]({ page, locale, cap, session: this });
      await settle(page, cap.settleMs ?? 600);

      const clip = await resolveClip(page, cap.clip);
      const els = await collectTextElements(page, { fonts: true });
      const texts = els.map((el) => ({ text: el.text, overflow: overflowOf(el.metrics), fonts: el.fonts }));
      const defects = detectUiDefects({ locale, texts, reference: [] });
      // 字形取り違え（報告のみ。空白だけのグリフは除く）
      for (const el of els) defects.push(...detectFontMismatches({ locale, text: el.text, fonts: el.fonts }));
      // same-as-en の除外指定（store-assets.json の ignoreSameAsEn: 文言そのものか CSS セレクター）を文言へ解決する
      const ignoreTexts = await resolveIgnoreTexts(page, this.cfg.ignoreSameAsEn ?? []);
      const png = Buffer.from(await page.screenshot({ type: "png", omitBackground: false, ...(clip ? { clip } : {}) }));
      const viewport = page.viewport();
      return {
        id: cap.id,
        locale,
        png,
        cssWidth: clip ? clip.width : viewport.width,
        cssHeight: clip ? clip.height : viewport.height,
        texts,
        ignoreTexts,
        defects,
        notes,
      };
    } finally {
      await page.close().catch(() => {});
    }
  }

  async #openPopup(page, cap, dsf) {
    await page.setViewport({ width: cap.viewportWidth ?? 800, height: 600, deviceScaleFactor: dsf });
    await page.goto(`chrome-extension://${this.extensionId}/${cap.page}`, { waitUntil: "load" });
    // <html lang> を確定させる。ui-localizer は storage を非同期で読むため初回ロードでは lang が古いまま
    // （CJK の字形選択が変わる）。localStorage 控えを書いて 1 回だけ再読込し、同期経路で lang を決めさせる。
    const tag = toLangTag(this.currentLocale);
    const lang = await page.evaluate((key, code) => {
      try { localStorage.setItem(key, code); } catch { /* 控えが使えなくても再読込で足りる場合がある */ }
      return document.documentElement.lang;
    }, LOCAL_LANG_KEY, this.currentLocale);
    if (lang !== tag) await page.reload({ waitUntil: "load" });
    await settle(page, cap.settleMs ?? 600);
    // body 幅 × min(高さ, 600) に合わせる（Chrome の popup と同じ上限）
    const size = await page.evaluate(() => {
      const r = document.body.getBoundingClientRect();
      return { w: Math.ceil(r.width), h: Math.ceil(Math.max(document.body.scrollHeight, r.height)) };
    });
    await page.setViewport({ width: cap.width ?? size.w, height: Math.min(cap.height ?? size.h, cap.maxHeight ?? 600), deviceScaleFactor: dsf });
  }

  async #openFixturePage(page, cap, dsf) {
    const target = new URL(cap.url);
    const fixture = fs.readFileSync(path.join(this.cfg.fixturesDir, cap.fixture), "utf8");
    await page.setViewport({ width: cap.width ?? 1120, height: cap.height ?? 524, deviceScaleFactor: dsf });
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (url.startsWith("data:") || url.startsWith("chrome-extension:") || url.startsWith("blob:") || url.startsWith("about:")) return request.continue();
      const u = new URL(url);
      if (request.isNavigationRequest() && u.origin === target.origin && u.pathname === target.pathname) {
        return request.respond({ status: 200, contentType: "text/html; charset=utf-8", body: fixture });
      }
      return request.respond({ status: 404, contentType: "text/plain", body: "" });
    });
    await page.goto(cap.url, { waitUntil: "load" });
    // 目印検査: 実ページ（Google 等）が返っていたら失敗にする
    const ok = page.url().startsWith(target.origin + target.pathname) && (await page.evaluate(() => !!document.querySelector('meta[name="vitrina-fixture"]')));
    if (!ok) throw new Error(`fixture が返っていません（url=${page.url()}）。ccTLD の URL を試してください: ${cap.url}`);
    if (cap.waitFor) await page.waitForSelector(cap.waitFor, { timeout: 15000 });
  }
}

/**
 * ignoreSameAsEn の各指定を、same-as-en から外す文言の一覧にする。
 * 指定は文言そのもの（完全一致）か CSS セレクター（一致した要素の文言）。両方として扱い、セレクターとして不正なら文言だけ。
 * セレクターは通常 DOM のみ（closed Shadow DOM 内は届かないので、その場合は文言で指定する）。
 */
async function resolveIgnoreTexts(page, specs) {
  if (!specs.length) return [];
  const fromSelectors = await page.evaluate((list) => {
    const out = [];
    for (const spec of list) {
      try {
        for (const el of document.querySelectorAll(spec)) {
          const text = (el.textContent ?? "").replace(/\s+/g, " ").trim();
          if (text) out.push(text);
        }
      } catch {
        /* セレクターとして不正 = 文言指定 */
      }
    }
    return out;
  }, specs);
  return [...specs, ...fromSelectors];
}

const pathToUrl = (file) => new URL(`file:///${file.replace(/\\/g, "/")}`).href;

/** フォント読み込みと描画の安定待ち。 */
async function settle(page, ms) {
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** clip 指定（矩形 or セレクター+余白）を puppeteer の clip へ。 */
async function resolveClip(page, clip) {
  if (!clip) return undefined;
  if (!clip.selector) return { x: clip.x, y: clip.y, width: clip.width, height: clip.height };
  const rect = await page.evaluate((selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  }, clip.selector);
  if (!rect) throw new Error(`clip.selector が見つかりません: ${clip.selector}`);
  const pad = typeof clip.pad === "number" ? { top: clip.pad, right: clip.pad, bottom: clip.pad, left: clip.pad } : { top: 0, right: 0, bottom: 0, left: 0, ...(clip.pad ?? {}) };
  return {
    x: Math.max(0, Math.floor(rect.x - pad.left)),
    y: Math.max(0, Math.floor(rect.y - pad.top)),
    width: Math.ceil(rect.width + pad.left + pad.right),
    height: Math.ceil(rect.height + pad.top + pad.bottom),
  };
}
