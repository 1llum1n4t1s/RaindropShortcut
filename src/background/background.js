// Chrome (Service Worker) では importScripts でロード、Firefox (event page) では
// manifest.json の background.scripts に列挙して先にロード済みなので skip する。
if (typeof importScripts === "function") {
  importScripts("/src/lib/actions.js");
}

// ========== OAuth / API \u8a2d\u5b9a (background \u5c02\u7528) ==========
// \u30af\u30e9\u30a4\u30a2\u30f3\u30c8\u8a8d\u8a3c\u60c5\u5831\u306f popup \u5074\u304c\u53c2\u7167\u3057\u306a\u3044\u3088\u3046 background.js \u5185\u306b\u5206\u96e2\u3002
// \u30af\u30e9\u30a4\u30a2\u30f3\u30c8\u306b\u7f6e\u3044\u3066\u3044\u308b\u9650\u308a secret \u306f\u914d\u5e03 ZIP \u7d4c\u7531\u3067\u6d41\u51fa\u3059\u308b\u305f\u3081\u3001\u30ed\u30fc\u30c6\u30fc\u30b7\u30e7\u30f3\u904b\u7528\u524d\u63d0\u3002
const OAuthConfig = Object.freeze({
  BASE_URL: "https://api.raindrop.io",
  AUTH_URL: "https://raindrop.io/oauth/authorize",
  TOKEN_URL: "https://raindrop.io/oauth/access_token",
  REFRESH_THRESHOLD_MS: 5 * 60 * 1000,
  FETCH_TIMEOUT_MS: 15_000,
});

// Chrome \u3068 Firefox \u3067\u306f chrome.identity.getRedirectURL() \u306e\u623b\u308a\u5024\u30c9\u30e1\u30a4\u30f3\u304c\u7570\u306a\u308a
// (Chrome: <id>.chromiumapp.org / Firefox: <sha1>.extensions.allizom.org)\u3001Raindrop.io \u304c
// 1 \u30a2\u30d7\u30ea 1 redirect URI \u4ed5\u69d8\u306e\u305f\u3081\u3001\u305d\u308c\u305e\u308c\u5225\u306e OAuth \u30a2\u30d7\u30ea\u3092\u767b\u9332\u3057\u3066\u4f7f\u3044\u5206\u3051\u308b\u3002
const OAuthClients = Object.freeze({
  chrome: {
    CLIENT_ID: "6a0c8f9f9a8b8816ae48158a",
    CLIENT_SECRET: "69a49702-ec6e-4f0e-8b76-0759968fc7d9",
  },
  firefox: {
    CLIENT_ID: "6a0c8e2ad7332457d8cfa30d",
    CLIENT_SECRET: "150f6fb4-10da-4100-a8b6-58ad4def3ec3",
  },
});

function getOAuthClient() {
  const redirectUri = chrome.identity.getRedirectURL();
  return redirectUri.endsWith(".chromiumapp.org/")
    ? OAuthClients.chrome
    : OAuthClients.firefox;
}

const collator = new Intl.Collator("ja");

// ========== \u30c8\u30fc\u30af\u30f3\u7ba1\u7406 ==========

async function getTokens() {
  return chrome.storage.local.get([...TokenStorageKeys]);
}

/**
 * \u9032\u884c\u4e2d\u306e refresh \u3092 coalescing \u3057\u3001\u4e26\u884c\u547c\u3073\u51fa\u3057\u6642\u306b\u30c8\u30fc\u30af\u30f3\u304c\u4e8c\u91cd\u767a\u884c\u3055\u308c\u306a\u3044\u3088\u3046\u306b\u3059\u308b\u3002
 * Raindrop \u306e refresh token \u30ed\u30fc\u30c6\u30fc\u30b7\u30e7\u30f3\u3067\u65e7\u30c8\u30fc\u30af\u30f3\u304c\u7121\u52b9\u5316\u3055\u308c\u308b\u306e\u3092\u9632\u3050\u3002
 */
let refreshPromise;
let sessionGeneration = 0;
/** @type {Promise<unknown>} */
let storageMutationPromise = Promise.resolve();

function invalidateSessionWork() {
  sessionGeneration += 1;
  refreshPromise = null;
  cacheRefreshPromises.clear();
  return sessionGeneration;
}

/**
 * @template T
 * @param {() => Promise<T>} mutation
 * @returns {Promise<T>}
 */
function queueStorageMutation(mutation) {
  const queued = storageMutationPromise.then(mutation, mutation);
  storageMutationPromise = queued.catch(() => {});
  return queued;
}

/**
 * @param {string} refreshToken
 * @param {number} generation
 * @returns {Promise<{ token: string | null, networkError?: boolean }>}
 */
function refreshTokenOnce(refreshToken, generation) {
  if (generation !== sessionGeneration) {
    return Promise.resolve({ token: null, networkError: false });
  }

  if (refreshPromise) return refreshPromise;

  const pending = refreshAccessToken(refreshToken, generation).finally(() => {
    if (refreshPromise === pending) refreshPromise = undefined;
  });
  refreshPromise = pending;
  return pending;
}

/**
 * @param {number} [expectedGeneration]
 * @returns {Promise<{ token: string | null, networkError?: boolean, generation?: number }>}
 */
async function getValidToken(expectedGeneration = sessionGeneration) {
  if (expectedGeneration !== sessionGeneration) {
    return { token: null, networkError: false, generation: expectedGeneration };
  }

  const data = await getTokens();
  if (expectedGeneration !== sessionGeneration) {
    return { token: null, networkError: false, generation: expectedGeneration };
  }

  const token = data[StorageKeys.ACCESS_TOKEN];
  const refreshToken = data[StorageKeys.REFRESH_TOKEN];
  const expiry = data[StorageKeys.TOKEN_EXPIRY] || 0;

  if (!token || !refreshToken) {
    return { token: null, networkError: false, generation: expectedGeneration };
  }

  if (Date.now() > expiry - OAuthConfig.REFRESH_THRESHOLD_MS) {
    const refreshed = await refreshTokenOnce(refreshToken, expectedGeneration);
    if (expectedGeneration !== sessionGeneration) {
      return { token: null, networkError: false, generation: expectedGeneration };
    }

    // 期限前の先行 refresh が一時的な通信障害で失敗した場合は、まだ有効な
    // access token を使う。失効後や OAuth 4xx ではフォールバックしない。
    if (!refreshed.token && refreshed.networkError && Date.now() < expiry) {
      return { token, generation: expectedGeneration };
    }

    return {
      token: refreshed.token,
      networkError: refreshed.networkError || false,
      generation: expectedGeneration,
    };
  }

  return { token, generation: expectedGeneration };
}

/**
 * refresh \u5931\u6557\u3092 network \u969c\u5bb3 vs \u30c8\u30fc\u30af\u30f3\u5931\u52b9\u3067\u5206\u3051\u3066\u8fd4\u3059\u3002
 * \u5730\u4e0b\u9244\u3067\u4e00\u6642\u7684\u306b\u5708\u5916\u2192\u5f37\u5236\u30ed\u30b0\u30a4\u30f3\u753b\u9762\u3068\u3044\u3046\u8aa4\u4f5c\u52d5\u3092\u9632\u3050\u3002
 */
/**
 * @param {string} refreshToken
 * @param {number} generation
 * @returns {Promise<{ token: string | null, networkError?: boolean }>}
 */
async function refreshAccessToken(refreshToken, generation) {
  try {
    const res = await fetchWithTimeout(OAuthConfig.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: getOAuthClient().CLIENT_ID,
        client_secret: getOAuthClient().CLIENT_SECRET,
      }),
    });

    if (generation !== sessionGeneration) {
      return { token: null, networkError: false };
    }

    if (!res.ok) {
      // 4xx \u306f\u30c8\u30fc\u30af\u30f3\u5931\u52b9\u3068\u307f\u306a\u3057\u3066\u30af\u30ea\u30a2 (OAuth 2.0 \u306e invalid_grant \u306f RFC 6749 \u00a75.2 \u3067
      // HTTP 400 \u306a\u306e\u3067\u3001401/403 \u3060\u3051\u306b\u7d5e\u308b\u3068\u672c\u5f53\u306e\u5931\u52b9\u3067\u30c8\u30fc\u30af\u30f3\u304c\u6b8b\u308a\u7d9a\u3051\u3066\u3057\u307e\u3046)\u3002
      // \u305f\u3060\u3057 429 (\u30ec\u30fc\u30c8\u5236\u9650) / 408 (\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8) \u306f\u4e00\u6642\u969c\u5bb3\u306a\u306e\u3067\u30c8\u30fc\u30af\u30f3\u3092\u6b8b\u3057\u3001
      // \u518d\u8a66\u884c\u53ef\u80fd\u306a\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u7cfb\u30a8\u30e9\u30fc\u3068\u3057\u3066\u8fd4\u3059 (\u5f37\u5236\u30ed\u30b0\u30a4\u30f3\u753b\u9762\u3092\u9632\u3050)\u3002
      const retryable = res.status === 429 || res.status === 408;
      if (res.status >= 400 && res.status < 500 && !retryable) {
        await clearTokens(generation);
      }
      return { token: null, networkError: res.status >= 500 || retryable };
    }

    const json = await res.json();
    const saved = await saveTokens(json, { generation });
    return { token: saved ? json.access_token : null };
  } catch {
    // \u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u65ad\u2192\u30c8\u30fc\u30af\u30f3\u306f\u6d88\u3055\u305a\u6b21\u56de\u30ea\u30c8\u30e9\u30a4\u306b\u8cbb\u3084\u3059
    return { token: null, networkError: true };
  }
}

/** @returns {Promise<boolean>} */
async function saveTokens(
  { access_token, refresh_token, expires_in },
  { generation = sessionGeneration, clearUserData = false } = {},
) {
  await queueStorageMutation(async () => {
    if (generation !== sessionGeneration) return;

    if (clearUserData) {
      await chrome.storage.local.remove([
        StorageKeys.SELECTED_COLLECTION,
        StorageKeys.BOOKMARKS_CACHE,
      ]);
      if (generation !== sessionGeneration) return;
    }

    await chrome.storage.local.set({
      [StorageKeys.ACCESS_TOKEN]: access_token,
      [StorageKeys.REFRESH_TOKEN]: refresh_token,
      [StorageKeys.TOKEN_EXPIRY]: Date.now() + expires_in * 1000,
    });
  });
  return generation === sessionGeneration;
}

/** @returns {Promise<boolean>} */
async function establishSession(tokens) {
  const generation = invalidateSessionWork();
  return saveTokens(tokens, { generation, clearUserData: true });
}

async function clearTokens(expectedGeneration = sessionGeneration) {
  if (expectedGeneration !== sessionGeneration) return false;
  invalidateSessionWork();

  // 認証が失効した利用者のブックマークを端末上に残さない。
  await queueStorageMutation(() =>
    chrome.storage.local.remove([
      ...TokenStorageKeys,
      StorageKeys.SELECTED_COLLECTION,
      StorageKeys.BOOKMARKS_CACHE,
    ]),
  );
  return true;
}

// ========== fetch \u30d8\u30eb\u30d1\u30fc (\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u4ed8\u304d) ==========

function fetchWithTimeout(url, opts = {}) {
  const signal = AbortSignal.timeout(OAuthConfig.FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal });
}

// ========== OAuth \u30d5\u30ed\u30fc ==========

function randomState() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

async function handleLogin() {
  const redirectUri = chrome.identity.getRedirectURL();
  const { CLIENT_ID, CLIENT_SECRET } = getOAuthClient();
  const state = randomState();
  const authUrl =
    `${OAuthConfig.AUTH_URL}?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=${state}`;

  // 認証ウィンドウを閉じた場合等の英語例外は日本語へ正規化 (UI は日本語契約)
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch {
    throw new Error("認証ウィンドウが閉じられたか、認証に失敗しました");
  }

  if (!responseUrl) {
    throw new Error("\u8a8d\u8a3c\u304c\u30ad\u30e3\u30f3\u30bb\u30eb\u3055\u308c\u307e\u3057\u305f");
  }

  const url = new URL(responseUrl);
  const err = url.searchParams.get("error");
  if (err) {
    throw new Error(`\u8a8d\u8a3c\u30a8\u30e9\u30fc: ${err}`);
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error("\u8a8d\u8a3c\u30ec\u30b9\u30dd\u30f3\u30b9\u306e state \u304c\u4e00\u81f4\u3057\u307e\u305b\u3093");
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("\u8a8d\u8a3c\u30b3\u30fc\u30c9\u3092\u53d6\u5f97\u3067\u304d\u307e\u305b\u3093\u3067\u3057\u305f");
  }

  // refreshAccessToken \u3068\u540c\u69d8\u3001\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u65ad\u30fb\u30bf\u30a4\u30e0\u30a2\u30a6\u30c8\u306e\u82f1\u8a9e\u4f8b\u5916\u306f\u65e5\u672c\u8a9e\u3078\u6b63\u898f\u5316
  let json;
  try {
    const res = await fetchWithTimeout(OAuthConfig.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: redirectUri,
      }),
    });
    if (!res.ok) {
      throw new Error("\u30c8\u30fc\u30af\u30f3\u4ea4\u63db\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
    }
    json = await res.json();
  } catch (e) {
    if (e instanceof TypeError || e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error("\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u306b\u63a5\u7d9a\u3067\u304d\u307e\u305b\u3093");
    }
    throw e;
  }
  if (!(await establishSession(json))) {
    throw new Error("認証状態が更新されたため、もう一度ログインしてください");
  }
}

// ========== API \u30ec\u30a4\u30e4\u30fc ==========

/**
 * @param {string} path
 * @param {any} [opts]
 * @param {number} [expectedGeneration]
 */
async function apiFetch(
  path,
  opts = {},
  expectedGeneration = sessionGeneration,
) {
  const requestOptions = { headers: {}, method: "GET", ...opts };
  const auth = await getValidToken(expectedGeneration);
  const { token, networkError } = auth;
  if (!token) {
    return { error: networkError ? "network" : "unauthorized" };
  }

  const fetchAuthorized = (accessToken) =>
    fetchWithTimeout(`${OAuthConfig.BASE_URL}${path}`, {
      ...requestOptions,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...requestOptions.headers,
      },
    });

  let res;
  try {
    res = await fetchAuthorized(token);
  } catch {
    return { error: "network" };
  }

  if (res.status === 401) {
    const method = String(requestOptions.method || "GET").toUpperCase();
    const canRetry = method === "GET" || method === "HEAD";

    if (canRetry && auth.generation === sessionGeneration) {
      const data = await getTokens();
      if (auth.generation !== sessionGeneration) {
        return { error: "unauthorized" };
      }

      const refreshToken = data[StorageKeys.REFRESH_TOKEN];
      if (refreshToken) {
        const refreshed = await refreshTokenOnce(refreshToken, auth.generation);
        if (!refreshed.token) {
          return { error: refreshed.networkError ? "network" : "unauthorized" };
        }

        try {
          res = await fetchAuthorized(refreshed.token);
        } catch {
          return { error: "network" };
        }
      }
    }

    if (res.status === 401) {
      await clearTokens(auth.generation);
      return { error: "unauthorized" };
    }
  }

  if (auth.generation !== sessionGeneration) {
    return { error: "unauthorized" };
  }

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  return res.json();
}

async function fetchCollections() {
  const generation = sessionGeneration;
  const [rootRes, childRes] = await Promise.all([
    apiFetch("/rest/v1/collections", {}, generation),
    apiFetch("/rest/v1/collections/childrens", {}, generation),
  ]);

  if (rootRes.error || childRes.error) {
    return { error: rootRes.error || childRes.error };
  }

  const roots = rootRes.items || [];
  const children = childRes.items || [];

  // \u89aa ID \u3054\u3068\u306b\u5b50\u3092\u30d0\u30b1\u30c3\u30c8\u5316\u3057\u3066 O(R+C) \u3067\u7a81\u5408\u3002
  // /collections/childrens \u306f\u5b6b\u4ee5\u964d\u3082\u542b\u3080\u5168\u4e16\u4ee3\u3092\u8fd4\u3059\u305f\u3081\u3001childMap \u3082\u5168\u4e16\u4ee3\u3092\u4fdd\u6301\u3059\u308b\u3002
  const nodeMap = new Map();
  const childMap = new Map();
  for (const c of children) {
    const pid = c.parent?.$id;
    if (pid == null) continue;
    const node = { _id: c._id, title: c.title, count: c.count, children: [] };
    nodeMap.set(c._id, node);
    if (!childMap.has(pid)) childMap.set(pid, []);
    childMap.get(pid).push(node);
  }

  const sortByTitle = (list) =>
    list.sort((a, b) => collator.compare(a.title, b.title));

  // \u5404\u30ce\u30fc\u30c9\u3078\u81ea\u5206\u306e\u5b50\u3092\u63a5\u7d9a\u3059\u308b\u3002childMap \u306f\u5168\u4e16\u4ee3\u3092\u6301\u3064\u306e\u3067 1 \u30d1\u30b9\u3067\u591a\u6bb5\u306e\u6728\u304c\u5b8c\u6210\u3057\u3001
  // 3 \u968e\u5c64\u4ee5\u4e0a\u306e\u30b3\u30ec\u30af\u30b7\u30e7\u30f3\u3082\u30eb\u30fc\u30c8\u914d\u4e0b\u304b\u3089\u5230\u9054\u3067\u304d\u308b (\u518d\u5e30\u306f\u4e0d\u8981)\u3002
  for (const node of nodeMap.values()) {
    node.children = sortByTitle(childMap.get(node._id) || []);
  }

  const tree = sortByTitle(
    roots.map((col) => ({
      _id: col._id,
      title: col.title,
      count: col.count,
      children: sortByTitle(childMap.get(col._id) || []),
    })),
  );

  return { collections: tree };
}

/** \u30da\u30fc\u30b8\u6307\u5b9a\u306e\u30d6\u30c3\u30af\u30de\u30fc\u30af\u53d6\u5f97\u3002 */
async function fetchBookmarks(
  collectionId,
  page = 0,
  expectedGeneration = sessionGeneration,
) {
  const id = collectionId || 0;
  const res = await apiFetch(
    `/rest/v1/raindrops/${id}?perpage=${SharedConfig.PER_PAGE}&page=${page}&sort=-created`,
    {},
    expectedGeneration,
  );

  if (res.error) return res;

  return {
    items: (res.items || []).map((item) => ({
      _id: item._id,
      title: item.title,
      link: item.link,
      domain: item.domain,
    })),
    count: typeof res.count === "number" ? res.count : null,
  };
}

/**
 * 指定コレクションの全ページを取得する。
 * Raindrop.io への同時リクエスト数を抑えるため、並列度 6 で処理する。
 */
async function fetchAllBookmarks(
  collectionId,
  expectedGeneration = sessionGeneration,
) {
  const first = await fetchBookmarks(collectionId, 0, expectedGeneration);
  if (first.error) return first;

  let items = first.items || [];
  const totalCount = typeof first.count === "number" ? first.count : items.length;
  const totalPages = Math.max(1, Math.ceil(totalCount / SharedConfig.PER_PAGE));

  for (
    let start = 1;
    start < totalPages;
    start += SharedConfig.BOOKMARKS_FETCH_CONCURRENCY
  ) {
    const end = Math.min(
      start + SharedConfig.BOOKMARKS_FETCH_CONCURRENCY,
      totalPages,
    );
    const pages = [];
    for (let page = start; page < end; page++) {
      pages.push(fetchBookmarks(collectionId, page, expectedGeneration));
    }

    const results = await Promise.all(pages);
    for (const result of results) {
      if (result.error) return result;
      items = items.concat(result.items || []);
    }
  }

  items.sort((a, b) => collator.compare(a.title, b.title));
  return { items };
}

// ========== ブックマークの事前取得・定期更新 ==========

const BOOKMARKS_REFRESH_ALARM = "bookmarks-cache-refresh";
const cacheRefreshPromises = new Map();

function getSelectedCollectionId(selectedCollection) {
  return selectedCollection?._id || 0;
}

/**
 * 同じコレクションへの並行取得を 1 本へまとめ、取得対象が現在も選択中ならキャッシュする。
 * 選択変更中に古い取得が完了しても、新しいコレクションのキャッシュを上書きしない。
 */
function refreshBookmarksCache(
  collectionId,
  expectedGeneration = sessionGeneration,
) {
  if (expectedGeneration !== sessionGeneration) {
    return Promise.resolve({ error: "unauthorized" });
  }

  const id = collectionId || 0;
  const cacheKey = `${expectedGeneration}:${id}`;
  const inFlight = cacheRefreshPromises.get(cacheKey);
  if (inFlight) return inFlight;

  const refresh = (async () => {
    const result = await fetchAllBookmarks(id, expectedGeneration);
    if (result.error) return result;
    if (expectedGeneration !== sessionGeneration) {
      return { error: "unauthorized" };
    }

    const stored = await chrome.storage.local.get(StorageKeys.SELECTED_COLLECTION);
    if (expectedGeneration !== sessionGeneration) {
      return { error: "unauthorized" };
    }
    const currentId = getSelectedCollectionId(
      stored[StorageKeys.SELECTED_COLLECTION],
    );

    if (currentId === id) {
      try {
        await queueStorageMutation(async () => {
          if (expectedGeneration !== sessionGeneration) return;
          await chrome.storage.local.set({
            [StorageKeys.BOOKMARKS_CACHE]: {
              collectionId: id,
              savedAt: Date.now(),
              items: result.items,
            },
          });
        });
        if (expectedGeneration !== sessionGeneration) {
          return { error: "unauthorized" };
        }
      } catch {
        // 容量上限などでキャッシュできなくても、取得済み一覧は popup へ返す。
      }
    }

    return result;
  })().finally(() => {
    cacheRefreshPromises.delete(cacheKey);
  });

  cacheRefreshPromises.set(cacheKey, refresh);
  return refresh;
}

async function refreshSelectedBookmarksCache() {
  const generation = sessionGeneration;
  const stored = await chrome.storage.local.get(StorageKeys.SELECTED_COLLECTION);
  if (generation !== sessionGeneration) return { error: "unauthorized" };
  return refreshBookmarksCache(
    getSelectedCollectionId(stored[StorageKeys.SELECTED_COLLECTION]),
    generation,
  );
}

function getAlarm(name) {
  return new Promise((resolve, reject) => {
    chrome.alarms.get(name, (alarm) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message));
      } else {
        resolve(alarm);
      }
    });
  });
}

async function ensureBookmarksRefreshAlarm() {
  const existing = await getAlarm(BOOKMARKS_REFRESH_ALARM);
  if (
    !existing ||
    existing.periodInMinutes !== SharedConfig.BOOKMARKS_REFRESH_INTERVAL_MINUTES
  ) {
    chrome.alarms.create(BOOKMARKS_REFRESH_ALARM, {
      delayInMinutes: SharedConfig.BOOKMARKS_REFRESH_INTERVAL_MINUTES,
      periodInMinutes: SharedConfig.BOOKMARKS_REFRESH_INTERVAL_MINUTES,
    });
  }
}

function runBackgroundRefresh() {
  refreshSelectedBookmarksCache().catch(() => {
    // ネットワーク断などでは既存キャッシュを維持し、次回の定期更新に任せる。
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureBookmarksRefreshAlarm().catch(() => {});
  runBackgroundRefresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureBookmarksRefreshAlarm().catch(() => {});
  runBackgroundRefresh();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BOOKMARKS_REFRESH_ALARM) {
    runBackgroundRefresh();
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (
    areaName === "local" &&
    Object.hasOwn(changes, StorageKeys.SELECTED_COLLECTION)
  ) {
    runBackgroundRefresh();
  }
});

// Firefox の alarm はブラウザ再起動で消えるため、background 起動ごとに存在を確認する。
ensureBookmarksRefreshAlarm().catch(() => {});

// ========== \u30e1\u30c3\u30bb\u30fc\u30b8\u30cf\u30f3\u30c9\u30e9 ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // \u81ea\u62e1\u5f35 (popup / background) \u5916\u304b\u3089\u306e\u30e1\u30c3\u30bb\u30fc\u30b8\u306f\u5b8c\u5168\u7121\u8996
  if (sender.id !== chrome.runtime.id) return false;

  const handler = async () => {
    switch (request.action) {
      case Actions.CHECK_AUTH: {
        const data = await getTokens();
        return { authenticated: !!data[StorageKeys.ACCESS_TOKEN] };
      }

      case Actions.LOGIN: {
        try {
          await handleLogin();
          return { ok: true };
        } catch (e) {
          return { error: e.message };
        }
      }

      case Actions.LOGOUT: {
        await clearTokens();
        return { ok: true };
      }

      case Actions.GET_COLLECTIONS: {
        return fetchCollections();
      }

      case Actions.GET_BOOKMARKS: {
        return refreshBookmarksCache(request.collectionId);
      }

      default:
        return { error: "unknown action" };
    }
  };

  handler()
    .then(sendResponse)
    .catch((e) => sendResponse({ error: e?.message || "internal error" }));
  return true;
});
