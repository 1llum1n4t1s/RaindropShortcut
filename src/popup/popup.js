"use strict";

// ========== \u72b6\u614b\u7ba1\u7406 ==========
const state = {
  screen: Screens.LOGIN,
  authenticated: false,
  bookmarks: [],
  filteredBookmarks: [],
  loading: false,
  selectedCollection: null,
  themeMode: null,
  linkOpenMode: null,
  collections: [],
  searchQuery: "",
};

const collator = new Intl.Collator("ja");

// ========== \u30d8\u30eb\u30d1\u30fc ==========

function debounce(fn, ms) {
  let id;
  return (...args) => {
    clearTimeout(id);
    id = setTimeout(() => fn(...args), ms);
  };
}

const sendMessage = (msg) => chrome.runtime.sendMessage(msg);

/** \u691c\u7d22\u7528\u306e\u6b63\u898f\u5316\u30ad\u30fc\u3092\u4ed8\u4e0e\u3057\u3066\u304a\u304f (filter \u6642\u306e toLowerCase \u3092\u56de\u907f) */
function normalize(item) {
  return {
    ...item,
    _titleLower: (item.title || "").toLowerCase(),
    _domainLower: (item.domain || "").toLowerCase(),
  };
}

// ========== DOM \u53c2\u7167 ==========
const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

document.addEventListener("DOMContentLoaded", async () => {
  const screenLogin = $("#screen-login");
  const screenMain = $("#screen-main");
  const screenSettings = $("#screen-settings");

  const btnLogin = $("#btn-login");
  const loginError = $("#login-error");

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

  // ========== \u753b\u9762\u9077\u79fb ==========

  function showScreen(name) {
    screenLogin.hidden = name !== Screens.LOGIN;
    screenMain.hidden = name !== Screens.MAIN;
    screenSettings.hidden = name !== Screens.SETTINGS;
    state.screen = name;
  }

  function applyTheme(mode) {
    state.themeMode = mode;
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

  // ========== \u30d6\u30c3\u30af\u30de\u30fc\u30af\u4e00\u89a7\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0 ==========

  function createBookmarkItem(item) {
    const li = document.createElement("li");
    li.className = "bookmark-item";
    li.title = item.title;

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

  function renderBookmarks(items) {
    bookmarkList.innerHTML = "";

    if (items.length === 0 && !state.loading) {
      emptyMessage.hidden = false;
      emptyMessage.textContent = state.searchQuery
        ? "\u4e00\u81f4\u3059\u308b\u30d6\u30c3\u30af\u30de\u30fc\u30af\u304c\u3042\u308a\u307e\u305b\u3093"
        : "\u30d6\u30c3\u30af\u30de\u30fc\u30af\u304c\u3042\u308a\u307e\u305b\u3093";
      return;
    }

    emptyMessage.hidden = true;
    const fragment = document.createDocumentFragment();
    for (const item of items) {
      fragment.appendChild(createBookmarkItem(item));
    }
    bookmarkList.appendChild(fragment);
  }

  /** \u30d5\u30a3\u30eb\u30bf\u9069\u7528\u3068\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0\u306e\u5171\u901a\u5f15\u304d\u8fbc\u307f */
  function rerender() {
    if (state.searchQuery) {
      applyFilter();
    } else {
      state.filteredBookmarks = state.bookmarks;
      renderBookmarks(state.bookmarks);
    }
  }

  // ========== \u30ed\u30fc\u30c7\u30a3\u30f3\u30b0\u8868\u793a ==========

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

  // ========== \u30d6\u30c3\u30af\u30de\u30fc\u30af\u8aad\u307f\u8fbc\u307f ==========

  /**
   * loadGeneration: \u30b3\u30ec\u30af\u30b7\u30e7\u30f3\u5207\u308a\u66ff\u3048\u6642\u306b\u53e4\u3044\u975e\u540c\u671f\u30ed\u30fc\u30c9\u3092\u7121\u52b9\u5316\u3059\u308b\u30ad\u30e3\u30f3\u30bb\u30e9\u3002
   * \u65b0\u3057\u3044 loadBookmarks() \u547c\u3073\u51fa\u3057\u3067 generation \u304c\u9032\u3080\u3068\u3001\u53e4\u3044 await \u304b\u3089\u5fa9\u5e30\u3057\u305f\u30ed\u30fc\u30c9\u306f
   * currentGen !== loadGeneration \u3067\u65e9\u671f\u5fa9\u5e30\u3057\u3001stale \u306a\u7d50\u679c\u3067\u306e DOM \u6c5a\u67d3\u3092\u9632\u3050\u3002
   */
  let loadGeneration = 0;

  async function loadBookmarks(reset = false) {
    if (reset) {
      state.bookmarks = [];
      state.filteredBookmarks = [];
      state.searchQuery = "";
      searchInput.value = "";
      bookmarkList.innerHTML = "";
    }

    const currentGen = ++loadGeneration;
    state.loading = true;
    showLoading();
    emptyMessage.hidden = true;

    const collectionId = state.selectedCollection?._id || 0;

    // 1\u30da\u30fc\u30b8\u76ee\u3067\u7dcf\u4ef6\u6570\u3092\u53d6\u5f97\u3057\u3066\u6b8b\u30da\u30fc\u30b8\u3092\u4e26\u5217\u53d6\u5f97\u3059\u308b\u3002
    const first = await sendMessage({
      action: Actions.GET_BOOKMARKS,
      collectionId,
      page: 0,
    });

    if (currentGen !== loadGeneration) {
      resetLoading();
      return;
    }

    if (!handleBookmarkError(first, !reset)) return;

    let all = (first.items || []).map(normalize);
    const totalCount = typeof first.count === "number" ? first.count : all.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / SharedConfig.PER_PAGE));

    // \u6b8b\u30da\u30fc\u30b8\u3092\u4e26\u5217\u53d6\u5f97 (\u4e26\u5217\u5ea6\u306f rate limit \u914d\u616e\u3067 6 \u306b\u6291\u3048\u308b)
    const remaining = [];
    for (let p = 1; p < totalPages; p++) remaining.push(p);

    const CONCURRENCY = 6;
    for (let i = 0; i < remaining.length; i += CONCURRENCY) {
      const chunk = remaining.slice(i, i + CONCURRENCY);
      const results = await Promise.all(
        chunk.map((p) =>
          sendMessage({ action: Actions.GET_BOOKMARKS, collectionId, page: p }),
        ),
      );

      if (currentGen !== loadGeneration) {
        resetLoading();
        return;
      }

      for (const res of results) {
        if (!handleBookmarkError(res, !reset)) return;
        all = all.concat((res.items || []).map(normalize));
      }

      // \u4e2d\u9593\u30ec\u30f3\u30c0\u30ea\u30f3\u30b0 (\u30bd\u30fc\u30c8\u306f\u6700\u7d42\u306e 1 \u56de\u306b\u96c6\u7d04\u3057\u3066 O(n\u00b2 log n) \u3092\u56de\u907f)
      // \u30ad\u30e3\u30c3\u30b7\u30e5\u66f4\u65b0\u7d4c\u7531 (reset=false) \u3067\u306f\u4e2d\u9593\u30ec\u30f3\u30c0\u30fc\u3092\u3057\u306a\u3044 (\u4e00\u89a7\u306e\u30c1\u30e9\u3064\u304d\u56de\u907f)
      if (reset) {
        state.bookmarks = all;
        const prevScroll = listContainer.scrollTop;
        rerender();
        listContainer.scrollTop = prevScroll;
      }
    }

    all.sort((a, b) => collator.compare(a.title, b.title));
    state.bookmarks = all;

    resetLoading();
    rerender();

    // \u30ad\u30e3\u30c3\u30b7\u30e5\u66f4\u65b0 (\u6a19\u6e96\u306e\u300c\u3059\u3079\u3066\u300d\u30b3\u30ec\u30af\u30b7\u30e7\u30f3\u306e\u307f)
    if (!state.selectedCollection) {
      chrome.storage.local.set({
        [StorageKeys.BOOKMARKS_CACHE]: {
          savedAt: Date.now(),
          items: all.map(({ _id, title, link, domain }) => ({
            _id,
            title,
            link,
            domain,
          })),
        },
      });
    }
  }

  /**
   * \u30d6\u30c3\u30af\u30de\u30fc\u30af API \u30ec\u30b9\u30dd\u30f3\u30b9\u306e\u30a8\u30e9\u30fc\u3092\u6271\u3046\u3002\u7d9a\u884c\u53ef\u306a\u3089 true\u3002
   * silent=true \u306e\u5834\u5408 (\u30ad\u30e3\u30c3\u30b7\u30e5\u80cc\u666f\u306e\u30ea\u30d5\u30ec\u30c3\u30b7\u30e5) \u306f\u30a8\u30e9\u30fc UI \u3092\u51fa\u3055\u305a\u9ed9\u3063\u3066\u7d42\u4e86\u3059\u308b\u3002
   */
  function handleBookmarkError(res, silent = false) {
    if (!res) {
      resetLoading();
      if (!silent) showErrorMessage("\u901a\u4fe1\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
      return false;
    }
    if (res.error === "unauthorized") {
      resetLoading();
      showScreen(Screens.LOGIN);
      return false;
    }
    if (res.error === "network") {
      resetLoading();
      if (!silent) showErrorMessage("\u30cd\u30c3\u30c8\u30ef\u30fc\u30af\u306b\u63a5\u7d9a\u3067\u304d\u307e\u305b\u3093");
      return false;
    }
    if (res.error) {
      resetLoading();
      if (!silent) showErrorMessage("\u8aad\u307f\u8fbc\u307f\u306b\u5931\u6557\u3057\u307e\u3057\u305f");
      return false;
    }
    return true;
  }

  function showErrorMessage(msg) {
    emptyMessage.hidden = false;
    emptyMessage.textContent = msg;
  }

  // ========== \u691c\u7d22\u30d5\u30a3\u30eb\u30bf ==========

  function applyFilter() {
    const q = state.searchQuery.toLowerCase();
    if (!q) {
      state.filteredBookmarks = state.bookmarks;
    } else {
      state.filteredBookmarks = state.bookmarks.filter(
        (b) => b._titleLower.includes(q) || b._domainLower.includes(q),
      );
    }
    renderBookmarks(state.filteredBookmarks);
  }

  const onSearchInput = debounce(() => {
    state.searchQuery = searchInput.value.trim();
    applyFilter();
  }, SharedConfig.SEARCH_DEBOUNCE_MS);

  // ========== \u30b3\u30ec\u30af\u30b7\u30e7\u30f3\u30c4\u30ea\u30fc ==========

  function renderCollectionTree(collections) {
    collectionTree.innerHTML = "";

    const allItem = createCollectionItem(
      { _id: 0, title: "\u3059\u3079\u3066", count: null },
      0,
    );
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

      collectionName.textContent = selected?.title || "\u3059\u3079\u3066";

      showScreen(Screens.MAIN);
      loadBookmarks(true);
    });

    return div;
  }

  // ========== \u30a4\u30d9\u30f3\u30c8\u30cf\u30f3\u30c9\u30e9 ==========

  btnLogin.addEventListener("click", async () => {
    btnLogin.disabled = true;
    loginError.hidden = true;

    try {
      const res = await sendMessage({ action: Actions.LOGIN });
      if (res?.ok) {
        state.authenticated = true;
        showScreen(Screens.MAIN);
        loadBookmarks(true);
      } else {
        loginError.textContent = res?.error || "\u30ed\u30b0\u30a4\u30f3\u306b\u5931\u6557\u3057\u307e\u3057\u305f";
        loginError.hidden = false;
      }
    } finally {
      btnLogin.disabled = false;
    }
  });

  btnSettings.addEventListener("click", async () => {
    showScreen(Screens.SETTINGS);

    // \u30ad\u30e3\u30c3\u30b7\u30e5\u304c\u3042\u308c\u3070\u5373\u5ea7\u306b\u8868\u793a
    if (state.collections.length > 0) {
      renderCollectionTree(state.collections);
      return;
    }

    collectionTree.innerHTML = "";
    const loader = document.createElement("div");
    loader.className = "loading";
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    loader.append(spinner, "\u8aad\u307f\u8fbc\u307f\u4e2d...");
    collectionTree.appendChild(loader);

    const res = await sendMessage({ action: Actions.GET_COLLECTIONS });
    if (res?.collections) {
      state.collections = res.collections;
      renderCollectionTree(res.collections);
    } else if (res?.error === "unauthorized") {
      showScreen(Screens.LOGIN);
    } else {
      collectionTree.innerHTML = "";
      const err = document.createElement("div");
      err.className = "empty-message";
      err.textContent = "\u30b3\u30ec\u30af\u30b7\u30e7\u30f3\u306e\u53d6\u5f97\u306b\u5931\u6557\u3057\u307e\u3057\u305f";
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
    state.authenticated = false;
    state.bookmarks = [];
    state.filteredBookmarks = [];
    state.collections = [];
    bookmarkList.innerHTML = "";
    await chrome.storage.local.remove([StorageKeys.BOOKMARKS_CACHE]);
    showScreen(Screens.LOGIN);
  });

  // ========== \u521d\u671f\u5316 ==========

  // \u30b9\u30c8\u30ec\u30fc\u30b8\u3068\u8a8d\u8a3c\u30c1\u30a7\u30c3\u30af\u3092\u4e26\u5217\u5316\u3057\u3066\u8d77\u52d5\u6642\u9593\u3092\u77ed\u7e2e
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
  collectionName.textContent = state.selectedCollection?.title || "\u3059\u3079\u3066";

  if (authRes?.authenticated) {
    state.authenticated = true;
    showScreen(Screens.MAIN);

    // \u30ad\u30e3\u30c3\u30b7\u30e5\u304c\u65b0\u3057\u3051\u308c\u3070\u5373\u5ea7\u306b\u8868\u793a (\u300c\u3059\u3079\u3066\u300d\u9078\u629e\u6642\u306e\u307f)
    const cache = stored[StorageKeys.BOOKMARKS_CACHE];
    const cacheFresh =
      !state.selectedCollection &&
      cache &&
      typeof cache.savedAt === "number" &&
      Date.now() - cache.savedAt < SharedConfig.BOOKMARKS_CACHE_TTL_MS &&
      Array.isArray(cache.items);

    if (cacheFresh) {
      state.bookmarks = cache.items.map(normalize);
      state.filteredBookmarks = state.bookmarks;
      renderBookmarks(state.filteredBookmarks);
      // \u30d0\u30c3\u30af\u30b0\u30e9\u30a6\u30f3\u30c9\u3067\u5dee\u5206\u66f4\u65b0
      loadBookmarks(false);
    } else {
      loadBookmarks(true);
    }
  } else {
    showScreen(Screens.LOGIN);
  }
});
