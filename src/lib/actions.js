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
});

/** @readonly API 設定 */
const ApiConfig = Object.freeze({
  BASE_URL: "https://api.raindrop.io",
  AUTH_URL: "https://raindrop.io/oauth/authorize",
  TOKEN_URL: "https://raindrop.io/oauth/access_token",
  CLIENT_ID: "69bae7a399c4ee2b01348f86",
  CLIENT_SECRET: "REDACTED_CLIENT_SECRET",
  PER_PAGE: 50,
});

/** @readonly リンクの開き方 */
const LinkOpenMode = Object.freeze({
  CURRENT: "current",
  NEW_TAB: "newTab",
});

/** @readonly テーマモード */
const ThemeMode = Object.freeze({
  AUTO: "auto",
  LIGHT: "light",
  DARK: "dark",
});

/** @readonly 画面状態 */
const Screens = Object.freeze({
  LOGIN: "login",
  MAIN: "main",
  SETTINGS: "settings",
});
