"use strict";

// <html lang> を同期で合わせる。Kagayoi のフッター (module) より先に classic script として実行する。
Localizer.applyDocumentLang();

// ========== ヘルパー ==========

function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

const sendMessage = (msg) => chrome.runtime.sendMessage(msg);

/** 検索用の正規化キーを付与しておく (filter 時の toLowerCase を回避) */
function normalize(item) {
  return {
    ...item,
    _titleLower: (item.title || "").toLowerCase(),
    _domainLower: (item.domain || "").toLowerCase(),
  };
}

function isBookmarksCacheFresh(cache, now = Date.now()) {
  const age = now - cache?.savedAt;
  const ttlMs = SharedConfig.BOOKMARKS_REFRESH_INTERVAL_MINUTES * 60 * 1000;
  return Number.isFinite(age) && age >= 0 && age < ttlMs;
}

document.addEventListener("DOMContentLoaded", async () => {
  // 保存済みの UI 言語を読み込み、HTML の静的文言を置換して言語切替を組み立てる。
  await Localizer.ready;
  await Localizer.ensureFresh();
  Localizer.localizeDocument();
  Localizer.mountLanguageSelect(document.getElementById("uiLanguage"));
  const t = (key, fallback, substitutions) => Localizer.t(key, substitutions, fallback);
  // 画面の状態と DOM 参照は、この popup のイベント処理だけで共有する。
  const state = {
    bookmarks: [],
    loading: false,
    selectedCollection: null,
    linkOpenMode: null,
    collections: [],
    searchQuery: "",
  };
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  const screenLogin = $("#screen-login");
  const screenMain = $("#screen-main");
  const screenSettings = $("#screen-settings");

  const btnLogin = $("#btn-login");
  const loginError = $("#login-error");
  // バージョン表記は manifest を正本にする (ハードコードだと更新漏れでズレる)
  $("#login-foot").textContent =
    t("loginFoot", `v${chrome.runtime.getManifest().version} · OAuth 2.0 authentication`, [
      chrome.runtime.getManifest().version,
    ]);

  const collectionName = $("#collection-name");
  const btnSettings = $("#btn-settings");
  const searchInput = $("#search-input");
  const listContainer = $(".list-container");
  const bookmarkList = $("#bookmark-list");
  const emptyMessage = $("#empty-message");
  const loadingIndicator = $("#loading-indicator");

  const btnBack = $("#btn-back");
  const collectionTree = $("#collection-tree");
  const themeBtns = $$(".theme-btn");
  const linkModeBtns = $$(".link-mode-btn");
  const btnLogout = $("#btn-logout");

  // ========== 画面遷移 ==========

  function showScreen(name) {
    screenLogin.hidden = name !== Screens.LOGIN;
    screenMain.hidden = name !== Screens.MAIN;
    screenSettings.hidden = name !== Screens.SETTINGS;
  }

  function applyTheme(mode) {
    document.documentElement.classList.remove("light", "dark");
    if (mode === ThemeMode.LIGHT) {
      document.documentElement.classList.add("light");
    } else if (mode === ThemeMode.DARK) {
      document.documentElement.classList.add("dark");
    }
    themeBtns.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.theme === mode);
    });
  }

  function applyLinkOpenMode(mode) {
    state.linkOpenMode = mode;
    linkModeBtns.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.mode === mode);
    });
  }

  // ========== ブックマーク一覧レンダリング ==========

  const bookmarkItems = new WeakMap();

  function createBookmarkItem(item, index = 0, animate = true) {
    const li = document.createElement("li");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "bookmark-item";
    button.title = item.title;
    // 先頭 ~30 件のみスタッガード・フェードイン。31 件目以降は no-anim で即表示
    // (--i 未設定だと既定値 0 の delay で全件が一斉アニメーションしてしまうため)
    if (animate && index < 30) {
      button.style.setProperty("--i", String(index));
    } else {
      button.classList.add("no-anim");
    }

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.src = `https://www.google.com/s2/favicons?sz=${SharedConfig.FAVICON_SIZE}&domain=${encodeURIComponent(item.domain)}`;
    favicon.width = SharedConfig.FAVICON_SIZE;
    favicon.height = SharedConfig.FAVICON_SIZE;
    favicon.alt = "";
    favicon.loading = "lazy";

    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = item.title;

    const domain = document.createElement("span");
    domain.className = "bookmark-domain";
    domain.textContent = item.domain;

    button.append(favicon, title, domain);
    bookmarkItems.set(button, item);
    li.appendChild(button);
    return li;
  }

  bookmarkList.addEventListener("click", (event) => {
    const button = event.target.closest(".bookmark-item");
    const item = bookmarkItems.get(button);
    if (!item) return;
    if (state.linkOpenMode === LinkOpenMode.CURRENT) {
      chrome.tabs.update({ url: item.link });
      window.close();
    } else {
      chrome.tabs.create({ url: item.link });
    }
  });

  function renderBookmarks(items, animate = false) {
    bookmarkList.innerHTML = "";

    if (items.length === 0 && !state.loading) {
      emptyMessage.hidden = false;
      emptyMessage.textContent = state.searchQuery
        ? t("mainNoMatch", "No matching bookmarks")
        : t("mainEmpty", "No bookmarks");
      return;
    }

    emptyMessage.hidden = true;
    const fragment = document.createDocumentFragment();
    items.forEach((item, i) => fragment.appendChild(createBookmarkItem(item, i, animate)));
    bookmarkList.appendChild(fragment);
  }

  // ========== ローディング表示 ==========

  function showLoading() {
    loadingIndicator.hidden = false;
  }

  function hideLoading() {
    loadingIndicator.hidden = true;
  }

  function resetLoading() {
    state.loading = false;
    hideLoading();
  }

  // ========== ブックマーク読み込み ==========

  /**
   * loadGeneration: コレクション切り替え時に古い非同期ロードを無効化するキャンセラ。
   * 新しい loadBookmarks() 呼び出しで generation が進むと、古い await から復帰したロードは
   * currentGen !== loadGeneration で早期復帰し、stale な結果での DOM 汚染を防ぐ。
   */
  let loadGeneration = 0;

  async function loadBookmarks(reset = false) {
    if (reset) {
      state.bookmarks = [];
      state.searchQuery = "";
      searchInput.value = "";
      bookmarkList.innerHTML = "";
    }

    const currentGen = ++loadGeneration;
    state.loading = true;
    showLoading();
    emptyMessage.hidden = true;

    const collectionId = state.selectedCollection?._id || 0;

    // background 側で全ページ取得とキャッシュ更新を一元化する。
    const result = await sendMessage({
      action: Actions.GET_BOOKMARKS,
      collectionId,
    });

    if (currentGen !== loadGeneration) {
      return;
    }

    if (!handleBookmarkError(result, !reset)) return;

    // ログアウトや 401 で generation が進んでいたら、state もキャッシュも書き戻さない
    if (currentGen !== loadGeneration) {
      return;
    }

    state.bookmarks = (result.items || []).map(normalize);

    resetLoading();
    applyFilter();
  }

  /**
   * ブックマーク API レスポンスのエラーを扱う。続行可なら true。
   * silent=true の場合 (キャッシュ背景のリフレッシュ) はエラー UI を出さず黙って終了する。
   */
  function handleBookmarkError(res, silent = false) {
    if (!res) {
      resetLoading();
      if (!silent) showErrorMessage(t("errorCommunication", "Communication failed"));
      return false;
    }
    if (res.error === "unauthorized") {
      resetToLoginScreen();
      return false;
    }
    if (res.error === "network") {
      resetLoading();
      if (!silent) showErrorMessage(t("errorNetwork", "Could not connect to the network"));
      return false;
    }
    if (res.error) {
      resetLoading();
      if (!silent) showErrorMessage(t("errorLoadFailed", "Failed to load"));
      return false;
    }
    return true;
  }

  function showErrorMessage(msg) {
    emptyMessage.hidden = false;
    emptyMessage.textContent = msg;
  }

  /**
   * アカウント境界をまたいで持ち越してはいけないローカル状態を消す。
   * bookmarksCache はユーザー ID と紐付いていないため、残すと別アカウントで
   * ログインし直したときに前ユーザーの一覧が TTL 内で描画されてしまう。
   * selectedCollection も前ユーザーのコレクション ID なので取得先が狂う。
   */
  function clearUserScopedStorage() {
    return chrome.storage.local.remove([
      StorageKeys.BOOKMARKS_CACHE,
      StorageKeys.SELECTED_COLLECTION,
    ]);
  }

  /**
   * ログイン画面へ戻す際の後始末。loadGeneration を進めることで、
   * 進行中ロードが復帰したあとに state やキャッシュを書き戻すのを無効化する。
   */
  function resetToLoginScreen() {
    loadGeneration++;
    resetLoading();
    state.bookmarks = [];
    state.collections = [];
    state.selectedCollection = null;
    state.searchQuery = "";
    searchInput.value = "";
    bookmarkList.innerHTML = "";
    collectionName.textContent = t("collectionAll", "All");
    showScreen(Screens.LOGIN);
    return clearUserScopedStorage();
  }

  // ========== 検索フィルタ ==========

  // 初回表示や検索だけアニメーションし、取得後の差分更新では繰り返さない。
  function applyFilter(animate = false) {
    const q = state.searchQuery.toLowerCase();
    const filteredBookmarks = q
      ? state.bookmarks.filter(
        (b) => b._titleLower.includes(q) || b._domainLower.includes(q),
      )
      : state.bookmarks;
    renderBookmarks(filteredBookmarks, animate);
  }

  const onSearchInput = debounce(() => {
    state.searchQuery = searchInput.value.trim();
    // 検索クエリ変更時は「あたらしい結果」なので animate=true
    applyFilter(true);
  }, SharedConfig.SEARCH_DEBOUNCE_MS);

  // ========== コレクションツリー ==========

  function renderCollectionTree(collections) {
    collectionTree.innerHTML = "";

    const allItem = createCollectionItem(
      { _id: 0, title: t("collectionAll", "All"), count: null },
      0,
    );
    collectionTree.appendChild(allItem);

    appendCollectionNodes(collections, 0);
  }

  /** 深さ優先で全世代を並べる (Raindrop は 3 階層以上のネストを許すため段数を固定しない) */
  function appendCollectionNodes(nodes, depth) {
    for (const col of nodes) {
      collectionTree.appendChild(createCollectionItem(col, depth));
      if (col.children?.length) {
        appendCollectionNodes(col.children, depth + 1);
      }
    }
  }

  function createCollectionItem(col, depth) {
    const div = document.createElement("button");
    div.type = "button";
    div.className = "collection-item";
    const selectedId = state.selectedCollection?._id ?? 0;
    if (col._id === selectedId) {
      div.classList.add("selected");
    }

    for (let i = 0; i < depth; i++) {
      const indent = document.createElement("span");
      indent.className = "indent";
      div.appendChild(indent);
    }

    const titleSpan = document.createElement("span");
    titleSpan.textContent = col.title;
    div.appendChild(titleSpan);

    if (col.count != null) {
      const countSpan = document.createElement("span");
      countSpan.className = "collection-count";
      countSpan.textContent = col.count;
      div.appendChild(countSpan);
    }

    div.addEventListener("click", async () => {
      const selected = col._id === 0 ? null : { _id: col._id, title: col.title };
      state.selectedCollection = selected;
      await chrome.storage.local.set({
        [StorageKeys.SELECTED_COLLECTION]: selected,
      });

      collectionName.textContent = selected?.title || t("collectionAll", "All");

      showScreen(Screens.MAIN);
      loadBookmarks(true);
    });

    return div;
  }

  // ========== イベントハンドラ ==========

  btnLogin.addEventListener("click", async () => {
    btnLogin.disabled = true;
    loginError.hidden = true;

    try {
      const res = await sendMessage({ action: Actions.LOGIN });
      if (res?.ok) {
        // 別アカウントでログインし直した場合に前ユーザーの一覧・選択コレクションを持ち越さない
        await clearUserScopedStorage();
        state.selectedCollection = null;
        collectionName.textContent = t("collectionAll", "All");
        showScreen(Screens.MAIN);
        loadBookmarks(true);
      } else {
        loginError.textContent = res?.error || t("errorLoginFailed", "Login failed");
        loginError.hidden = false;
      }
    } finally {
      btnLogin.disabled = false;
    }
  });

  btnSettings.addEventListener("click", async () => {
    showScreen(Screens.SETTINGS);

    // キャッシュがあれば即座に表示
    if (state.collections.length > 0) {
      renderCollectionTree(state.collections);
      return;
    }

    collectionTree.innerHTML = "";
    const loader = document.createElement("div");
    loader.className = "loading";
    const dot = document.createElement("span");
    dot.className = "pulse-dot";
    const label = document.createElement("span");
    label.textContent = t("mainLoading", "Loading");
    loader.append(dot, label);
    collectionTree.appendChild(loader);

    const res = await sendMessage({ action: Actions.GET_COLLECTIONS });
    if (res?.collections) {
      state.collections = res.collections;
      renderCollectionTree(res.collections);
    } else if (res?.error === "unauthorized") {
      await resetToLoginScreen();
    } else {
      collectionTree.innerHTML = "";
      const err = document.createElement("div");
      err.className = "empty-message";
      err.textContent = t("errorCollectionsLoadFailed", "Failed to load collections");
      collectionTree.appendChild(err);
    }
  });

  btnBack.addEventListener("click", () => {
    showScreen(Screens.MAIN);
  });

  themeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.theme;
      applyTheme(mode);
      chrome.storage.local.set({ [StorageKeys.THEME_MODE]: mode });
    });
  });

  linkModeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      applyLinkOpenMode(mode);
      chrome.storage.local.set({ [StorageKeys.LINK_OPEN_MODE]: mode });
    });
  });

  searchInput.addEventListener("input", onSearchInput);

  btnLogout.addEventListener("click", async () => {
    await sendMessage({ action: Actions.LOGOUT });
    await resetToLoginScreen();
  });

  // ========== 初期化 ==========

  // ストレージと認証チェックを並列化して起動時間を短縮
  const [stored, authRes] = await Promise.all([
    chrome.storage.local.get([
      StorageKeys.THEME_MODE,
      StorageKeys.SELECTED_COLLECTION,
      StorageKeys.LINK_OPEN_MODE,
      StorageKeys.BOOKMARKS_CACHE,
    ]),
    sendMessage({ action: Actions.CHECK_AUTH }),
  ]);

  applyTheme(stored[StorageKeys.THEME_MODE] || ThemeMode.AUTO);
  applyLinkOpenMode(stored[StorageKeys.LINK_OPEN_MODE] || LinkOpenMode.NEW_TAB);

  state.selectedCollection = stored[StorageKeys.SELECTED_COLLECTION] || null;
  collectionName.textContent = state.selectedCollection?.title || t("collectionAll", "All");

  if (authRes?.authenticated) {
    showScreen(Screens.MAIN);

    // 選択中コレクションのキャッシュがあれば即座に表示する。
    // TTL 超過時も表示を維持しつつ、裏で最新データを取得する。
    const cache = stored[StorageKeys.BOOKMARKS_CACHE];
    const selectedCollectionId = state.selectedCollection?._id || 0;
    const cacheMatchesSelection =
      cache &&
      cache.collectionId === selectedCollectionId &&
      Array.isArray(cache.items);

    if (cacheMatchesSelection) {
      state.bookmarks = cache.items.map(normalize);
      // キャッシュ初回表示は「初めて見せる」フェードイン
      renderBookmarks(state.bookmarks, true);
      if (!isBookmarksCacheFresh(cache)) {
        loadBookmarks(false);
      }
    } else {
      loadBookmarks(true);
    }
  } else {
    showScreen(Screens.LOGIN);
  }
});
