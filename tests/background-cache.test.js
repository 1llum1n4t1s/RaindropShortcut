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
  tokenExpiry = Date.now() + 60 * 60 * 1000,
  bookmarksCache,
  fetchHandler,
  pages = async () => ({ count: 0, items: [] }),
}) {
  const storage = {
    accessToken: "access-token",
    refreshToken: "refresh-token",
    tokenExpiry,
    selectedCollection,
    themeMode: "dark",
  };
  if (bookmarksCache !== undefined) storage.bookmarksCache = bookmarksCache;
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
    fetch: async (url, options) => {
      if (fetchHandler) return fetchHandler(url, options);
      const page = Number(new URL(url).searchParams.get("page"));
      fetchCalls.push(page);
      const payload = await pages(page, options, url);
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

test("期限前の先行 refresh が通信失敗した場合は既存トークンを使う", async () => {
  const harness = createHarness({
    tokenExpiry: Date.now() + 60 * 1000,
    fetchHandler: async () => {
      throw new Error("offline");
    },
  });

  const result = await harness.run("getValidToken()");

  assert.equal(result.token, "access-token");
  assert.equal(harness.storage.accessToken, "access-token");
});

test("期限切れ後の refresh 通信失敗では既存トークンを使わない", async () => {
  const harness = createHarness({
    tokenExpiry: Date.now() - 1,
    fetchHandler: async () => {
      throw new Error("offline");
    },
  });

  const result = await harness.run("getValidToken()");

  assert.equal(result.token, null);
  assert.equal(result.networkError, true);
});

test("API の 401 は refresh 成功後に GET を一度だけ再試行する", async () => {
  let apiRequestCount = 0;
  const authorizations = [];
  const harness = createHarness({
    bookmarksCache: { collectionId: 42, savedAt: Date.now(), items: [] },
    fetchHandler: async (url, options) => {
      if (url === "https://raindrop.io/oauth/access_token") {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              access_token: "refreshed-access-token",
              refresh_token: "refreshed-refresh-token",
              expires_in: 1200,
            };
          },
        };
      }

      apiRequestCount += 1;
      authorizations.push(options?.headers?.Authorization);
      if (apiRequestCount === 1) return { ok: false, status: 401 };
      return {
        ok: true,
        status: 200,
        async json() {
          return { items: [] };
        },
      };
    },
  });

  const result = await harness.run('apiFetch("/rest/v1/raindrops/42")');

  assert.deepEqual(Array.from(result.items), []);
  assert.equal(apiRequestCount, 2);
  assert.deepEqual(authorizations, [
    "Bearer access-token",
    "Bearer refreshed-access-token",
  ]);
  assert.equal(harness.storage.accessToken, "refreshed-access-token");
  assert.equal(harness.storage.refreshToken, "refreshed-refresh-token");
  assert.equal(harness.storage.selectedCollection._id, 42);
  assert.equal(harness.storage.bookmarksCache.collectionId, 42);
});

test("API の 401 後に refresh も拒否された場合は利用者データを破棄する", async () => {
  let requestCount = 0;
  const harness = createHarness({
    bookmarksCache: { collectionId: 42, savedAt: Date.now(), items: [] },
    fetchHandler: async () => {
      requestCount += 1;
      return {
        ok: false,
        status: requestCount === 1 ? 401 : 400,
      };
    },
  });

  const result = await harness.run('apiFetch("/rest/v1/raindrops/42")');

  assert.equal(result.error, "unauthorized");
  assert.equal(requestCount, 2);
  assert.equal(harness.storage.accessToken, undefined);
  assert.equal(harness.storage.refreshToken, undefined);
  assert.equal(harness.storage.tokenExpiry, undefined);
  assert.equal(harness.storage.selectedCollection, undefined);
  assert.equal(harness.storage.bookmarksCache, undefined);
  assert.equal(harness.storage.themeMode, "dark");
});

test("ログアウト前の refresh は新しいセッションを上書きしない", async () => {
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => {
    markRefreshStarted = resolve;
  });
  const waitForRelease = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  const harness = createHarness({
    tokenExpiry: Date.now() + 60 * 1000,
    fetchHandler: async () => {
      markRefreshStarted();
      await waitForRelease;
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            access_token: "late-access-token",
            refresh_token: "late-refresh-token",
            expires_in: 1200,
          };
        },
      };
    },
  });

  const pending = harness.run("getValidToken()");
  await refreshStarted;
  await harness.run("clearTokens()");
  assert.equal(harness.storage.accessToken, undefined);
  await harness.run(`establishSession({
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    expires_in: 1200
  })`);
  releaseRefresh();
  const result = await pending;

  assert.equal(result.token, null);
  assert.equal(harness.storage.accessToken, "new-access-token");
  assert.equal(harness.storage.refreshToken, "new-refresh-token");
  assert.equal(typeof harness.storage.tokenExpiry, "number");
});

test("ログアウト前のブックマーク取得を新しいセッションと共有しない", async () => {
  let releaseOldFetch;
  let markOldFetchStarted;
  const oldFetchStarted = new Promise((resolve) => {
    markOldFetchStarted = resolve;
  });
  const waitForOldRelease = new Promise((resolve) => {
    releaseOldFetch = resolve;
  });
  const harness = createHarness({
    selectedCollection: null,
    pages: async (_page, options) => {
      const authorization = options?.headers?.Authorization;
      if (authorization === "Bearer access-token") {
        markOldFetchStarted();
        await waitForOldRelease;
        return {
          count: 1,
          items: [
            {
              _id: 1,
              title: "旧アカウント",
              link: "https://old.example",
              domain: "old.example",
            },
          ],
        };
      }

      return {
        count: 1,
        items: [
          {
            _id: 2,
            title: "新アカウント",
            link: "https://new.example",
            domain: "new.example",
          },
        ],
      };
    },
  });

  const oldRefresh = harness.run("refreshBookmarksCache(0)");
  await oldFetchStarted;
  await harness.run("clearTokens()");
  await harness.run(`establishSession({
    access_token: "new-access-token",
    refresh_token: "new-refresh-token",
    expires_in: 1200
  })`);

  const latest = await harness.run("refreshBookmarksCache(0)");
  releaseOldFetch();
  const stale = await oldRefresh;

  assert.equal(latest.items[0].title, "新アカウント");
  assert.equal(stale.error, "unauthorized");
  assert.equal(harness.storage.bookmarksCache.items[0].title, "新アカウント");
});

test("ログアウト前に開始した API 応答をセッション変更後に返さない", async () => {
  let releaseFetch;
  let markFetchStarted;
  const fetchStarted = new Promise((resolve) => {
    markFetchStarted = resolve;
  });
  const waitForRelease = new Promise((resolve) => {
    releaseFetch = resolve;
  });
  const harness = createHarness({
    fetchHandler: async () => {
      markFetchStarted();
      await waitForRelease;
      return {
        ok: true,
        status: 200,
        async json() {
          return { items: [{ _id: 1, title: "旧アカウント" }] };
        },
      };
    },
  });

  const pending = harness.run('apiFetch("/rest/v1/collections")');
  await fetchStarted;
  await harness.run("clearTokens()");
  releaseFetch();
  const result = await pending;

  assert.equal(result.error, "unauthorized");
});
