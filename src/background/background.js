importScripts("/src/lib/actions.js");

// ========== トークン管理 ==========

/** ストレージからトークン情報を取得 */
async function getTokens() {
  return chrome.storage.local.get([
    StorageKeys.ACCESS_TOKEN,
    StorageKeys.REFRESH_TOKEN,
    StorageKeys.TOKEN_EXPIRY,
  ]);
}

/** 有効なアクセストークンを返す（期限切れならリフレッシュ） */
async function getValidToken() {
  const data = await getTokens();
  const token = data[StorageKeys.ACCESS_TOKEN];
  const refreshToken = data[StorageKeys.REFRESH_TOKEN];
  const expiry = data[StorageKeys.TOKEN_EXPIRY] || 0;

  if (!token || !refreshToken) return null;

  // 期限の5分前ならリフレッシュ
  if (Date.now() > expiry - 300000) {
    return refreshAccessToken(refreshToken);
  }

  return token;
}

/** リフレッシュトークンで新しいアクセストークンを取得 */
async function refreshAccessToken(refreshToken) {
  try {
    const res = await fetch(ApiConfig.TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: ApiConfig.CLIENT_ID,
        client_secret: ApiConfig.CLIENT_SECRET,
      }),
    });

    if (!res.ok) {
      await clearTokens();
      return null;
    }

    const json = await res.json();
    await saveTokens(json);
    return json.access_token;
  } catch {
    return null;
  }
}

/** トークンをストレージに保存 */
async function saveTokens({ access_token, refresh_token, expires_in }) {
  await chrome.storage.local.set({
    [StorageKeys.ACCESS_TOKEN]: access_token,
    [StorageKeys.REFRESH_TOKEN]: refresh_token,
    [StorageKeys.TOKEN_EXPIRY]: Date.now() + expires_in * 1000,
  });
}

/** トークンをストレージから削除 */
async function clearTokens() {
  await chrome.storage.local.remove([
    StorageKeys.ACCESS_TOKEN,
    StorageKeys.REFRESH_TOKEN,
    StorageKeys.TOKEN_EXPIRY,
  ]);
}

// ========== OAuth フロー ==========

/** OAuth ログインフローを実行 */
async function handleLogin() {
  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl =
    `${ApiConfig.AUTH_URL}?client_id=${ApiConfig.CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&response_type=code`;

  // 認証ウィンドウを開く
  const responseUrl = await chrome.identity.launchWebAuthFlow({
    url: authUrl,
    interactive: true,
  });

  // 認証コードを抽出
  const url = new URL(responseUrl);
  const code = url.searchParams.get("code");
  if (!code) {
    throw new Error("認証コードを取得できませんでした");
  }

  // トークン交換
  const res = await fetch(ApiConfig.TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      grant_type: "authorization_code",
      code,
      client_id: ApiConfig.CLIENT_ID,
      client_secret: ApiConfig.CLIENT_SECRET,
      redirect_uri: redirectUri,
    }),
  });

  if (!res.ok) {
    throw new Error("トークン交換に失敗しました");
  }

  const json = await res.json();
  await saveTokens(json);
}

// ========== API レイヤー ==========

/** 共通 API フェッチ（Authorization ヘッダー自動付与） */
async function apiFetch(path, opts = {}) {
  const token = await getValidToken();
  if (!token) {
    return { error: "unauthorized" };
  }

  const res = await fetch(`${ApiConfig.BASE_URL}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      ...opts.headers,
    },
    ...opts,
  });

  if (res.status === 401) {
    await clearTokens();
    return { error: "unauthorized" };
  }

  if (!res.ok) {
    return { error: `API error: ${res.status}` };
  }

  return res.json();
}

/** コレクション一覧取得（ルート + 子を統合してツリー構造化） */
async function fetchCollections() {
  const [rootRes, childRes] = await Promise.all([
    apiFetch("/rest/v1/collections"),
    apiFetch("/rest/v1/collections/childrens"),
  ]);

  if (rootRes.error || childRes.error) {
    return { error: rootRes.error || childRes.error };
  }

  const roots = rootRes.items || [];
  const children = childRes.items || [];

  // ツリー構造を構築（名前昇順ソート）
  const collator = new Intl.Collator("ja");
  const tree = roots
    .map((col) => ({
      _id: col._id,
      title: col.title,
      count: col.count,
      children: children
        .filter((c) => c.parent && c.parent.$id === col._id)
        .map((c) => ({
          _id: c._id,
          title: c.title,
          count: c.count,
          children: [],
        }))
        .sort((a, b) => collator.compare(a.title, b.title)),
    }))
    .sort((a, b) => collator.compare(a.title, b.title));

  return { collections: tree };
}

/** ブックマーク取得（ページ指定） */
async function fetchBookmarks(collectionId, page = 0) {
  const id = collectionId || 0;
  const res = await apiFetch(
    `/rest/v1/raindrops/${id}?perpage=${ApiConfig.PER_PAGE}&page=${page}&sort=-created`
  );

  if (res.error) return res;

  return {
    items: (res.items || []).map((item) => ({
      _id: item._id,
      title: item.title,
      link: item.link,
      domain: item.domain,
    })),
  };
}

// ========== メッセージハンドラ ==========

chrome.runtime.onMessage.addListener((request, _sender, sendResponse) => {
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
        return fetchBookmarks(request.collectionId, request.page);
      }

      default:
        return { error: "unknown action" };
    }
  };

  handler().then(sendResponse);
  return true; // 非同期レスポンスのため
});
