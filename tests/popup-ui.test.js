"use strict";

const assert = require("node:assert/strict");
const { resolve } = require("node:path");
const { pathToFileURL } = require("node:url");
const test = require("node:test");
const puppeteer = require("puppeteer");

test("コレクション切替後の古い応答が読み込み表示や新しい一覧を上書きしない", { timeout: 30_000 }, async (t) => {
  const browser = await puppeteer.launch({
    executablePath: await puppeteer.executablePath(),
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--allow-file-access-from-files"],
  });
  try {
    for (const oldFirst of [true, false]) {
      await t.test(oldFirst ? "新要求の読み込み中に旧応答が届く" : "新要求の完了後に旧応答が届く", async () => {
        const page = await browser.newPage();
        try {
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          await page.setRequestInterception(true);
          page.on("request", (request) => {
            if (request.url().startsWith("file:") || request.url().startsWith("data:")) {
              void request.continue();
            } else {
              void request.abort();
            }
          });
          await page.evaluateOnNewDocument(() => {
            // 拡張 API の境界だけ差し替え、DOM と popup.js は実物を使う。
            window.bookmarkRequests = [];
            window.chrome = {
              runtime: {
                getManifest: () => ({ version: "1.0.0" }),
                sendMessage: async (message) => {
                  if (message.action === "checkAuth") return { authenticated: true };
                  if (message.action === "getCollections") {
                    return { collections: [{ _id: 2, title: "新コレクション" }] };
                  }
                  if (message.action === "getBookmarks") {
                    return new Promise((resolve) => {
                      window.bookmarkRequests.push({ collectionId: message.collectionId, resolve });
                    });
                  }
                  throw new Error(`想定外のメッセージ: ${message.action}`);
                },
              },
              storage: { local: {
                get: async () => ({ selectedCollection: { _id: 1, title: "旧コレクション" } }),
                set: async () => {},
                remove: async () => {},
              } },
              tabs: { create: async () => {}, update: async () => {} },
            };
          });
          await page.goto(pathToFileURL(resolve(__dirname, "../src/popup/popup.html")).href);
          await page.waitForFunction(() => window.bookmarkRequests.length === 1);
          await page.click("#btn-settings");
          await page.waitForSelector("#collection-tree .collection-item:nth-child(2)");
          await page.click("#collection-tree .collection-item:nth-child(2)");
          await page.waitForFunction(() => window.bookmarkRequests.length === 2);
          assert.deepEqual(await page.evaluate(() => window.bookmarkRequests.map((r) => r.collectionId)), [1, 2]);

          const respond = async (index, title) => {
            await page.evaluate(async (index, title) => {
              window.bookmarkRequests[index].resolve({ items: [{ title, domain: "example.com", link: "https://example.com/" }] });
              // 応答 Promise の利用側と DOM 更新が完了してから観測する。
              await new Promise((resolve) => setTimeout(resolve, 0));
            }, index, title);
          };
          const readView = () => page.evaluate(() => ({
            loading: !document.querySelector("#loading-indicator").hidden,
            titles: Array.from(document.querySelectorAll(".bookmark-title"), (el) => el.textContent),
            collection: document.querySelector("#collection-name").textContent,
          }));

          if (oldFirst) {
            await respond(0, "旧ブックマーク");
            assert.deepEqual(await readView(), { loading: true, titles: [], collection: "新コレクション" });
            await respond(1, "新ブックマーク");
          } else {
            await respond(1, "新ブックマーク");
            assert.deepEqual(await readView(), { loading: false, titles: ["新ブックマーク"], collection: "新コレクション" });
            await respond(0, "旧ブックマーク");
          }
          assert.deepEqual(await readView(), { loading: false, titles: ["新ブックマーク"], collection: "新コレクション" });
          assert.deepEqual(errors, []);
        } finally {
          await page.close();
        }
      });
    }
  } finally {
    await browser.close();
  }
});
