"use strict";

/**
 * お問い合わせ / 評価ボタンの組み込み確認。
 *
 * 部品の正本は Kagayoi.Support（public/assets/contact-form.js と
 * clients/chrome-extension/support-footer.js）で、この拡張には逐語コピーを同梱している。
 * ここでは「同梱漏れ」「読み込み順の崩れ」「product-id の書き間違い」を止める。
 * 部品そのものの挙動は Kagayoi.Support 側のテストが見る。
 */

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const ROOT = path.join(__dirname, "..");
const SETTINGS_HTML = "src/popup/popup.html";
const PRODUCT_ID = "raindrop-shortcut";

const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("設定画面へ共通のサポートフッターを組み込んでいる", () => {
  const html = read(SETTINGS_HTML);

  assert.match(html, new RegExp(`<kagayoi-support-footer[^>]+product-id="${PRODUCT_ID}"`));
  assert.match(html, /<script type="module" src="[^"]*shared\/kagayoi-support-popup\.js"><\/script>/);
  assert.match(html, /<script type="module" src="[^"]*shared\/kagayoi-support-footer\.js"><\/script>/);
  assert.ok(
    html.indexOf("kagayoi-support-popup.js") < html.indexOf("kagayoi-support-footer.js"),
    "フッターが参照する <kagayoi-contact-popup> を先に定義する",
  );
});

test("同梱した共通部品が正本の契約を満たす", () => {
  const popupJs = read("src/shared/kagayoi-support-popup.js");
  const footerJs = read("src/shared/kagayoi-support-footer.js");

  assert.match(popupJs, /const DEFAULT_API_BASE = "https:\/\/support\.kagayoi\.com"/);
  assert.match(popupJs, /this\.form\.setAttribute\("channel", "extension"\)/);
  assert.match(popupJs, /this\.form\.setAttribute\("storage", "local"\)/);
  assert.match(popupJs, /customElements\.define\("kagayoi-contact-popup", KagayoiContactPopup\)/);
  assert.match(footerJs, /customElements\.define\("kagayoi-support-footer", KagayoiSupportFooter\)/);
  assert.match(footerJs, /chromewebstore\.google\.com\/detail\//);

  for (const [name, source] of [["popup", popupJs], ["footer", footerJs]]) {
    assert.doesNotMatch(source, /\.innerHTML\b/, `${name} も innerHTML を使わない`);
    assert.doesNotThrow(() => new vm.Script(source), `${name} が構文エラーなく読める`);
  }
});

const manifestAt = (manifestPath) => {
  const full = path.join(ROOT, manifestPath);
  return fs.existsSync(full) ? JSON.parse(fs.readFileSync(full, "utf8")) : null;
};

const allowsSupportHost = (hosts = []) =>
  hosts.some((host) => host.includes("support.kagayoi.com") || host === "<all_urls>" || host === "https://*/*");

test("manifest が問い合わせ先ホストへの権限を持つ", () => {
  for (const manifestPath of ["manifest.json", "manifest.firefox.json"]) {
    const manifest = manifestAt(manifestPath);
    if (!manifest) continue;
    assert.ok(
      allowsSupportHost(manifest.host_permissions),
      `${manifestPath} に support.kagayoi.com のホスト権限が要る`,
    );
  }
});

test("Firefox 版が問い合わせで送るデータを AMO へ申告している", () => {
  // 問い合わせフォームはメールアドレス（personallyIdentifyingInfo）と
  // 確認コード（authenticationInfo）を送る。利用者が自分で入力した値も申告対象で、
  // "none" は他の値と併記できない。
  for (const manifestPath of ["manifest.json", "manifest.firefox.json"]) {
    const gecko = manifestAt(manifestPath)?.browser_specific_settings?.gecko;
    if (!gecko) continue;
    const declared = gecko.data_collection_permissions?.required ?? [];
    for (const category of ["personallyIdentifyingInfo", "authenticationInfo"]) {
      assert.ok(declared.includes(category), `${manifestPath} の申告に ${category} が要る`);
    }
    assert.equal(declared.includes("none"), false, `${manifestPath}: "none" は併記できない`);
  }
});
