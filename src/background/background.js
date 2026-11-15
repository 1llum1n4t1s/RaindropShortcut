// Chrome (Service Worker) では importScripts でロード、Firefox (event page) では
// manifest.json の background.scripts に列挙して先にロード済みなので skip する。
if (typeof importScripts === "function") {
importScripts("/src/shared/ui-localizer.js");
  importScripts("/src/lib/actions.js");
}

// ========== OAuth / API 設定 (background 専用) ==========
// クライアント認証情報は popup 側が参照しないよう background.js 内に分離。
// クライアントに置いている限り secret は配布 ZIP 経由で流出するため、ローテーション運用前提。
const OAuthConfig = Object.freeze({
  BASE_URL: "https://api.raindrop.io",
  AUTH_URL: "https://raindrop.io/oauth/authorize",
  TOKEN_URL: "https://raindrop.io/oauth/access_token",
  REFRESH_THRESHOLD_MS: 5 * 60 * 1000,
  FETCH_TIMEOUT_MS: 15_000,
});

// Chrome と Firefox では chrome.identity.getRedirectURL() の戻り値ドメインが異なり
// (Chrome: <id>.chromiumapp.org / Firefox: <sha1>.extensions.allizom.org)、Raindrop.io が
// 1 アプリ 1 redirect URI 仕様のため、それぞれ別の OAuth アプリを登録して使い分ける。
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

// ========== トークン管理 ==========

async function getTokens() {
  return chrome.storage.local.get([...TokenStorageKeys]);
}

/**
 * 進行中の refresh を coalescing し、並行呼び出し時にトークンが二重発行されないようにする。
 * Raindrop の refresh token ローテーションで旧トークンが無効化されるのを防ぐ。
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
 * refresh 失敗を network 障害 vs トークン失効で分けて返す。
 * 地下鉄で一時的に圈外→強制ログイン画面という誤作動を防ぐ。
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
      // 4xx はトークン失効とみなしてクリア (OAuth 2.0 の invalid_grant は RFC 6749 §5.2 で
      // HTTP 400 なので、401/403 だけに絞ると本当の失効でトークンが残り続けてしまう)。
      // ただし 429 (レート制限) / 408 (タイムアウト) は一時障害なのでトークンを残し、
      // 再試行可能なネットワーク系エラーとして返す (強制ログイン画面を防ぐ)。
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
    // ネットワーク断→トークンは消さず次回リトライに費やす
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

// ========== fetch ヘルパー (タイムアウト付き) ==========

function fetchWithTimeout(url, opts = {}) {
  const signal = AbortSignal.timeout(OAuthConfig.FETCH_TIMEOUT_MS);
  return fetch(url, { ...opts, signal });
}

// ========== OAuth フロー ==========

function randomState() {
  const buf = new Uint8Array(16);
  crypto.getRandomValues(buf);
  return Array.from(buf, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** UI に出るエラー文言を、利用者が選んだ言語で引く。fallback は英語。 */
function bgText(key, fallback, substitutions) {
  return Localizer.t(key, substitutions, fallback);
}

async function handleLogin() {
  // 保存済みの UI 言語の読み込み完了を待ってから文言を引く。
  await Localizer.ready;
  const redirectUri = chrome.identity.getRedirectURL();
  const { CLIENT_ID, CLIENT_SECRET } = getOAuthClient();
  const state = randomState();
  const authUrl =
    `${OAuthConfig.AUTH_URL}?client_id=${CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code` +
    `&state=${state}`;

  // 認証ウィンドウを閉じた場合等の英語例外は選択中の UI 言語の文言へ正規化
  let responseUrl;
  try {
    responseUrl = await chrome.identity.launchWebAuthFlow({
      url: authUrl,
      interactive: true,
    });
  } catch {
    throw new Error(bgText("authWindowClosed", "The authentication window was closed, or authentication failed"));
  }

  if (!responseUrl) {
    throw new Error(bgText("authCancelled", "Authentication was cancelled"));
  }

  const url = new URL(responseUrl);
  const err = url.searchParams.get("error");
  if (err) {
    throw new Error(bgText("authError", `Authentication error: ${err}`, [err]));
  }
  if (url.searchParams.get("state") !== state) {
    throw new Error(bgText("authStateMismatch", "The state of the authentication response does not match"));
  }

  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error(bgText("authCodeMissing", "Could not get the authorization code"));
  }

  // refreshAccessToken と同様、ネットワーク断・タイムアウトの英語例外は選択中の UI 言語の文言へ正規化
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
      throw new Error(bgText("tokenExchangeFailed", "Token exchange failed"));
    }
    json = await res.json();
  } catch (e) {
    if (e instanceof TypeError || e.name === "TimeoutError" || e.name === "AbortError") {
      throw new Error(bgText("errorNetwork", "Could not connect to the network"));
    }
    throw e;
  }
  if (!(await establishSession(json))) {
    throw new Error(bgText("authSessionChanged", "Your authentication state was updated. Please log in again."));
  }
}

// ========== API レイヤー ==========

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

  const json = await res.json();
  if (auth.generation !== sessionGeneration) {
    return { error: "unauthorized" };
  }
  return json;
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

  // 親 ID ごとに子をバケット化して O(R+C) で突合。
  // /collections/childrens は孫以降も含む全世代を返すため、childMap も全世代を保持する。
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

  // 各ノードへ自分の子を接続する。childMap は全世代を持つので 1 パスで多段の木が完成し、
  // 3 階層以上のコレクションもルート配下から到達できる (再帰は不要)。
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

/** ページ指定のブックマーク取得。 */
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

  const items = first.items || [];
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
      for (const item of result.items || []) items.push(item);
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

async function ensureBookmarksRefreshAlarm() {
  const existing = await chrome.alarms.get(BOOKMARKS_REFRESH_ALARM);
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
  // 拡張の更新後に UI 言語の辞書が古ければ作り直す (失敗しても本来の処理は止めない)。
  Localizer.ready.then(() => Localizer.ensureFresh()).catch(() => {});
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

// ========== メッセージハンドラ ==========

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // 自拡張 (popup / background) 外からのメッセージは完全無視
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
