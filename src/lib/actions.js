/** @readonly メッセージアクション定義 */
const Actions = Object.freeze({
  CHECK_AUTH: "checkAuth",
  LOGIN: "login",
  LOGOUT: "logout",
  GET_COLLECTIONS: "getCollections",
  GET_BOOKMARKS: "getBookmarks",
});

/** @readonly ストレージキー */
const StorageKeys = Object.freeze({
  ACCESS_TOKEN: "accessToken",
  REFRESH_TOKEN: "refreshToken",
  TOKEN_EXPIRY: "tokenExpiry",
  SELECTED_COLLECTION: "selectedCollection",
  THEME_MODE: "themeMode",
  LINK_OPEN_MODE: "linkOpenMode",
  BOOKMARKS_CACHE: "bookmarksCache",
});

/** @readonly popup / background \u5171\u7528\u8a2d\u5b9a (OAuth \u7cfb\u306f background \u5185\u90e8\u3067\u500b\u5225\u4fdd\u6301) */
const SharedConfig = Object.freeze({
  PER_PAGE: 50,
  FAVICON_SIZE: 16,
  SEARCH_DEBOUNCE_MS: 200,
  BOOKMARKS_CACHE_TTL_MS: 5 * 60 * 1000,
});

/** @readonly \u30c8\u30fc\u30af\u30f3\u95a2\u9023\u306e StorageKey \u7fa4 (save/clear \u3067\u5171\u901a) */
const TokenStorageKeys = Object.freeze([
  StorageKeys.ACCESS_TOKEN,
  StorageKeys.REFRESH_TOKEN,
  StorageKeys.TOKEN_EXPIRY,
]);

/** @readonly \u30ea\u30f3\u30af\u306e\u958b\u304d\u65b9 */
const LinkOpenMode = Object.freeze({
  CURRENT: "current",
  NEW_TAB: "newTab",
});

/** @readonly \u30c6\u30fc\u30de\u30e2\u30fc\u30c9 */
const ThemeMode = Object.freeze({
  AUTO: "auto",
  LIGHT: "light",
  DARK: "dark",
});

/** @readonly \u753b\u9762\u72b6\u614b */
const Screens = Object.freeze({
  LOGIN: "login",
  MAIN: "main",
  SETTINGS: "settings",
});
