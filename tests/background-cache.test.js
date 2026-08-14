"use strict";

const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { webcrypto } = require("node:crypto");
const { resolve } = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

const root = resolve(__dirname, "..");
const actionsSource = readFileSync(resolve(root, "src/lib/actions.js"), "utf8");
const backgroundSource = readFileSync(
  resolve(root, "src/background/background.js"),
  "utf8",
);

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(listener) {
      listeners.push(listener);
    },
  };
}

function createHarness({
  selectedCollection = { _id: 42, title: "対象" },
  failCacheWrite = false,
  pages,
}) {
  const storage = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry: Date.now() + 60 * 60 * 1000,
    selectedCollection,
  };
  const alarms = new Map();
  const fetchCalls = [];

  const onMessage = createEvent();
  const onInstalled = createEvent();
  const onStartup = createEvent();
  const onAlarm = createEvent();
  const onChanged = createEvent();

  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      onMessage,
      onInstalled,
      onStartup,
    },
    identity: {
      getRedirectURL: () => "https://test.chromiumapp.org/",
    },
    storage: {
      local: {
        async get(keys) {
          const requested = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(
            requested
              .filter((key) => Object.hasOwn(storage, key))
              .map((key) => [key, storage[key]]),
          );
        },
        async set(values) {
          if (failCacheWrite && Object.hasOwn(values, "bookmarksCache")) {
            throw new Error("QUOTA_BYTES quota exceeded");
          }
          Object.assign(storage, values);
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) {
            delete storage[key];
          }
        },
      },
      onChanged,
    },
    alarms: {
      get(name, callback) {
        callback(alarms.get(name));
      },
      create(name, info) {
        alarms.set(name, { name, ...info });
      },
      onAlarm,
    },
  };

  const context = vm.createContext({
    AbortSignal,
    Date,
    Error,
    Intl,
    Map,
    Math,
    Object,
    Promise,
    URL,
    Uint8Array,
    chrome,
    console,
    crypto: webcrypto,
    fetch: async (url) => {
      const page = Number(new URL(url).searchParams.get("page"));
      fetchCalls.push(page);
      const payload = await pages(page);
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
  });

  vm.runInContext(actionsSource, context, { filename: "actions.js" });
  vm.runInContext(backgroundSource, context, { filename: "background.js" });

  return {
    alarms,
    fetchCalls,
    storage,
    run(expression) {
      return vm.runInContext(expression, context);
    },
  };
}

test("選択中コレクションを全ページ取得して ID 付きでキャッシュする", async () => {
  const harness = createHarness({
    pages: async (page) =>
      page === 0
        ? {
            count: 51,
            items: [
              {
                _id: 1,
                title: "B",
                link: "https://b.example",
                domain: "b.example",
              },
              {
                _id: 2,
                title: "A",
                link: "https://a.example",
                domain: "a.example",
              },
            ],
          }
        : {
            count: 51,
            items: [
              {
                _id: 3,
                title: "C",
                link: "https://c.example",
                domain: "c.example",
              },
            ],
          },
  });

  const result = await harness.run("refreshSelectedBookmarksCache()");

  assert.deepEqual(harness.fetchCalls, [0, 1]);
  assert.deepEqual(
    Array.from(result.items, (item) => item.title),
    ["A", "B", "C"],
  );
  assert.equal(harness.storage.bookmarksCache.collectionId, 42);
  assert.deepEqual(
    Array.from(harness.storage.bookmarksCache.items, (item) => item._id),
    [2, 1, 3],
  );
  assert.equal(typeof harness.storage.bookmarksCache.savedAt, "number");
});

test("同じコレクションの並行更新を一本化し、5分間隔の alarm を作る", async () => {
  let releaseFetch;
  const waiting = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const harness = createHarness({
    pages: async () => {
      await waiting;
      return { count: 1, items: [] };
    },
  });

  const first = harness.run("refreshBookmarksCache(42)");
  const second = harness.run("refreshBookmarksCache(42)");
  releaseFetch();
  await Promise.all([first, second]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(harness.fetchCalls, [0]);
  assert.deepEqual(harness.alarms.get("bookmarks-cache-refresh"), {
    name: "bookmarks-cache-refresh",
    delayInMinutes: 5,
    periodInMinutes: 5,
  });
});

test("取得中に選択が変わった場合は古いコレクションをキャッシュしない", async () => {
  let releaseFetch;
  const waiting = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const harness = createHarness({
    pages: async () => {
      await waiting;
      return {
        count: 1,
        items: [
          {
            _id: 1,
            title: "旧",
            link: "https://old.example",
            domain: "old.example",
          },
        ],
      };
    },
  });

  const refresh = harness.run("refreshBookmarksCache(42)");
  harness.storage.selectedCollection = { _id: 99, title: "新" };
  releaseFetch();
  await refresh;

  assert.equal(harness.storage.bookmarksCache, undefined);
});

test("容量上限でキャッシュできなくても取得結果は popup へ返す", async () => {
  const harness = createHarness({
    failCacheWrite: true,
    pages: async () => ({
      count: 1,
      items: [
        {
          _id: 1,
          title: "表示可能",
          link: "https://shown.example",
          domain: "shown.example",
        },
      ],
    }),
  });

  const result = await harness.run("refreshBookmarksCache(42)");

  assert.equal(result.items[0].title, "表示可能");
  assert.equal(harness.storage.bookmarksCache, undefined);
});
