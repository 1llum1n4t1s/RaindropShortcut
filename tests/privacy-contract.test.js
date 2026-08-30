"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");

const root = resolve(__dirname, "..");
const read = (path) => readFileSync(resolve(root, path), "utf8");

test("公開プライバシー文書が実際の保存先と通信先を開示する", () => {
  const documents = [
    read("docs/privacy-policy.md"),
    read("web/privacy.html"),
    read("webstore/store-listing.txt"),
    read("scripts/amo-metadata-update.js"),
  ];

  for (const document of documents) {
    assert.match(document, /kagayoi-support-session|contact session|お問い合わせ認証セッション/);
    assert.match(document, /support\.kagayoi\.com|Kagayoi Support/);
  }

  assert.doesNotMatch(
    read("web/privacy.html"),
    /Raindrop\.io 以外の外部サーバーへの送信は一切行いません/,
  );
  assert.match(read("web/privacy.html"), /<strong>alarms<\/strong>/);
});
