"use strict";

// ========== 状態管理 ==========
const state = {
  screen: Screens.LOGIN,
  authenticated: false,
  bookmarks: [],
  filteredBookmarks: [],
  currentPage: 0,
  hasMore: true,
  loading: false,
  selectedCollection: null,
  themeMode: ThemeMode.AUTO,
  linkOpenMode: LinkOpenMode.NEW_TAB,
  collections: [],
  searchQuery: "",
};

// ========== ヘルパー ==========

/** デバウンス */
function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

/** background へメッセージ送信（MV3 はネイティブ Promise を返す） */
const sendMessage = (msg) => chrome.runtime.sendMessage(msg);

// ========== DOM 参照 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener("DOMContentLoaded", async () => {
  // 画面要素
  const screenLogin = $("#screen-login");
  const screenMain = $("#screen-main");
  const screenSettings = $("#screen-settings");

  // ログイン画面
  const btnLogin = $("#btn-login");
  const loginError = $("#login-error");

  // メイン画面
  const collectionName = $("#collection-name");
  const btnSettings = $("#btn-settings");
  const searchInput = $("#search-input");
  const listContainer = $(".list-container");
  const bookmarkList = $("#bookmark-list");
  const emptyMessage = $("#empty-message");

  // 設定画面
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
    state.screen = name;
  }

  // ========== テーマ適用 ==========

  function applyTheme(mode) {
    state.themeMode = mode;
    document.documentElement.classList.remove("light", "dark");
    if (mode === ThemeMode.LIGHT) {
      document.documentElement.classList.add("light");
    } else if (mode === ThemeMode.DARK) {
      document.documentElement.classList.add("dark");
    }
    // テーマボタンの選択状態を更新
    themeBtns.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.theme === mode);
    });
  }

  // ========== リンク開き方 ==========

  function applyLinkOpenMode(mode) {
    state.linkOpenMode = mode;
    linkModeBtns.forEach((btn) => {
      btn.classList.toggle("selected", btn.dataset.mode === mode);
    });
  }

  // ========== ブックマーク一覧レンダリング ==========

  /** ブックマーク1件分の DOM 要素を生成 */
  function createBookmarkItem(item) {
    const li = document.createElement("li");
    li.className = "bookmark-item";
    li.title = item.title;

    const favicon = document.createElement("img");
    favicon.className = "bookmark-favicon";
    favicon.src = `https://www.google.com/s2/favicons?sz=16&domain=${encodeURIComponent(item.domain)}`;
    favicon.width = 16;
    favicon.height = 16;
    favicon.alt = "";
    favicon.loading = "lazy";

    const title = document.createElement("span");
    title.className = "bookmark-title";
    title.textContent = item.title;

    const domain = document.createElement("span");
    domain.className = "bookmark-domain";
    domain.textContent = item.domain;

    li.append(favicon, title, domain);
    li.addEventListener("click", () => {
      if (state.linkOpenMode === LinkOpenMode.CURRENT) {
        chrome.tabs.update({ url: item.link });
        window.close();
      } else {
        chrome.tabs.create({ url: item.link });
      }
    });

    return li;
  }

  /** 新しいアイテムだけ末尾に追加（差分レンダリング） */
  function appendBookmarks(items) {
    if (items.length === 0) return;
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.appendChild(createBookmarkItem(item));
    }
    bookmarkList.appendChild(fragment);
  }

  /** 全件置換レンダリング（検索フィルタ時のみ使用） */
  function renderBookmarks(items) {
    bookmarkList.innerHTML = "";

    if (items.length === 0 && !state.loading) {
      emptyMessage.hidden = false;
      emptyMessage.textContent = state.searchQuery
        ? "一致するブックマークがありません"
        : "ブックマークがありません";
      return;
    }

    emptyMessage.hidden = true;
    appendBookmarks(items);
  }

  // ========== ローディング表示 ==========

  const loadingIndicator = $("#loading-indicator");

  function showLoading() {
    loadingIndicator.hidden = false;
  }

  function removeLoading() {
    loadingIndicator.hidden = true;
  }

  // ========== ブックマーク読み込み ==========

  async function loadBookmarks(reset = false) {
    if (state.loading) return;

    if (reset) {
      state.bookmarks = [];
      state.filteredBookmarks = [];
      state.currentPage = 0;
      state.hasMore = true;
      state.searchQuery = "";
      searchInput.value = "";
      bookmarkList.innerHTML = "";
    }

    state.loading = true;
    showLoading();
    emptyMessage.hidden = true;

    const collectionId = state.selectedCollection?._id || 0;
    const res = await sendMessage({
      action: Actions.GET_BOOKMARKS,
      collectionId,
      page: state.currentPage,
    });

    state.loading = false;
    removeLoading();

    if (res?.error === "unauthorized") {
      showScreen(Screens.LOGIN);
      return;
    }

    if (res?.error) {
      emptyMessage.hidden = false;
      emptyMessage.textContent = "読み込みに失敗しました";
      return;
    }

    const items = res?.items || [];
    state.bookmarks.push(...items);
    state.hasMore = items.length === ApiConfig.PER_PAGE;

    // 名前昇順でソート
    const collator = new Intl.Collator("ja");
    state.bookmarks.sort((a, b) => collator.compare(a.title, b.title));

    // 検索中は全件フィルタ、通常は全件再レンダリング（ソート反映のため）
    state.filteredBookmarks = state.bookmarks;
    if (state.searchQuery) {
      applyFilter();
    } else {
      renderBookmarks(state.filteredBookmarks);
    }
  }

  async function loadNextPage() {
    if (state.loading || !state.hasMore) return;
    state.currentPage++;
    await loadBookmarks();
  }

  // ========== 検索フィルタ ==========

  function applyFilter() {
    const q = state.searchQuery.toLowerCase();
    if (!q) {
      state.filteredBookmarks = state.bookmarks;
    } else {
      state.filteredBookmarks = state.bookmarks.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.domain.toLowerCase().includes(q)
      );
    }
    renderBookmarks(state.filteredBookmarks);
  }

  const onSearchInput = debounce(() => {
    state.searchQuery = searchInput.value.trim();
    applyFilter();
  }, 200);

  // ========== コレクションツリー ==========

  function renderCollectionTree(collections) {
    collectionTree.innerHTML = "";

    // 「すべて」オプション
    const allItem = createCollectionItem({ _id: 0, title: "すべて", count: null }, 0);
    collectionTree.appendChild(allItem);

    for (const col of collections) {
      collectionTree.appendChild(createCollectionItem(col, 0));
      for (const child of col.children || []) {
        collectionTree.appendChild(createCollectionItem(child, 1));
      }
    }
  }

  function createCollectionItem(col, depth) {
    const div = document.createElement("div");
    div.className = "collection-item";
    const selectedId = state.selectedCollection?._id ?? 0;
    if (col._id === selectedId) {
      div.classList.add("selected");
    }

    // インデント
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

      // ヘッダー更新
      collectionName.textContent = selected?.title || "すべて";

      // メイン画面に戻ってブックマーク再読込
      showScreen(Screens.MAIN);
      loadBookmarks(true);
    });

    return div;
  }

  // ========== 無限スクロール ==========

  const scrollAC = new AbortController();
  let scrollTimer = null;
  listContainer.addEventListener("scroll", () => {
    if (state.loading || !state.hasMore || state.searchQuery) return;
    if (scrollTimer) return;
    scrollTimer = setTimeout(() => {
      scrollTimer = null;
      const { scrollTop, scrollHeight, clientHeight } = listContainer;
      if (scrollHeight - scrollTop - clientHeight < 100) {
        loadNextPage();
      }
    }, 150);
  }, { signal: scrollAC.signal });

  // popup 閉じ時にリスナー解除
  window.addEventListener("unload", () => scrollAC.abort());

  // ========== イベントハンドラ ==========

  // ログインボタン
  btnLogin.addEventListener("click", async () => {
    btnLogin.disabled = true;
    loginError.hidden = true;

    const res = await sendMessage({ action: Actions.LOGIN });

    if (res?.ok) {
      state.authenticated = true;
      showScreen(Screens.MAIN);
      loadBookmarks(true);
    } else {
      loginError.textContent = res?.error || "ログインに失敗しました";
      loginError.hidden = false;
    }
    btnLogin.disabled = false;
  });

  // 設定ボタン
  btnSettings.addEventListener("click", async () => {
    showScreen(Screens.SETTINGS);
    // コレクション一覧を取得
    collectionTree.innerHTML = "";
    const loader = document.createElement("div");
    loader.className = "loading";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    loader.append(spinner, "読み込み中...");
    collectionTree.appendChild(loader);
    const res = await sendMessage({ action: Actions.GET_COLLECTIONS });
    if (res?.collections) {
      state.collections = res.collections;
      renderCollectionTree(res.collections);
    } else if (res?.error === "unauthorized") {
      showScreen(Screens.LOGIN);
    }
  });

  // 戻るボタン
  btnBack.addEventListener("click", () => {
    showScreen(Screens.MAIN);
  });

  // テーマ切替
  themeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.theme;
      applyTheme(mode);
      chrome.storage.local.set({ [StorageKeys.THEME_MODE]: mode });
    });
  });

  // リンク開き方切替
  linkModeBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const mode = btn.dataset.mode;
      applyLinkOpenMode(mode);
      chrome.storage.local.set({ [StorageKeys.LINK_OPEN_MODE]: mode });
    });
  });

  // 検索入力
  searchInput.addEventListener("input", onSearchInput);

  // ログアウト
  btnLogout.addEventListener("click", async () => {
    await sendMessage({ action: Actions.LOGOUT });
    state.authenticated = false;
    state.bookmarks = [];
    state.filteredBookmarks = [];
    bookmarkList.innerHTML = "";
    showScreen(Screens.LOGIN);
  });

  // ========== 初期化 ==========

  // ストレージから設定を復元
  const stored = await chrome.storage.local.get([
    StorageKeys.THEME_MODE,
    StorageKeys.SELECTED_COLLECTION,
    StorageKeys.LINK_OPEN_MODE,
  ]);

  // テーマ適用
  applyTheme(stored[StorageKeys.THEME_MODE] || ThemeMode.AUTO);

  // リンク開き方適用
  applyLinkOpenMode(stored[StorageKeys.LINK_OPEN_MODE] || LinkOpenMode.NEW_TAB);

  // コレクション復元
  state.selectedCollection = stored[StorageKeys.SELECTED_COLLECTION] || null;
  collectionName.textContent = state.selectedCollection?.title || "すべて";

  // 認証チェック
  const authRes = await sendMessage({ action: Actions.CHECK_AUTH });
  if (authRes?.authenticated) {
    state.authenticated = true;
    showScreen(Screens.MAIN);
    loadBookmarks(true);
  } else {
    showScreen(Screens.LOGIN);
  }
});
