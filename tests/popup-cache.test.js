"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const actionsSource = readFileSync(resolve(root, "src/lib/actions.js"), "utf8");
const popupSource = readFileSync(resolve(root, "src/popup/popup.js"), "utf8");

const context = vm.createContext({
  Date,
  Number,
  clearTimeout,
  setTimeout,
  chrome: { runtime: { sendMessage() {} } },
  document: { addEventListener() {} },
});

vm.runInContext(actionsSource, context, { filename: "actions.js" });
vm.runInContext(popupSource, context, { filename: "popup.js" });

function isFresh(savedAt, now = 1_000_000) {
  context.savedAt = savedAt;
  context.now = now;
  return vm.runInContext(
    "isBookmarksCacheFresh({ savedAt }, now)",
    context,
  );
}

test("ブックマークキャッシュは5分未満だけ新鮮と判定する", () => {
  assert.equal(isFresh(700_001), true);
  assert.equal(isFresh(700_000), false);
  assert.equal(isFresh(undefined), false);
  assert.equal(isFresh(1_000_001), false);
});
