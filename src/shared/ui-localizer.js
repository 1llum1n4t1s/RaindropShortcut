/*
 * ui-localizer.js — Chrome / Firefox 拡張共通の「表示言語の切り替え」モジュール（Kagayoi.Support が正本）。
 *
 * 目的:
 *   拡張標準の `chrome.i18n` はブラウザの UI 言語に固定で、利用者が言語を選べない。
 *   そこで利用者が選んだ言語の文言（同梱の `_locales/<code>/messages.json`）を `chrome.storage.local` に
 *   保存し、`chrome.i18n.getMessage` / `getUILanguage`（`browser.i18n` も）を「選んだ言語を優先する版」に
 *   差し替える。既存の getMessage 呼び出し箇所は無改造のまま切り替わる。
 *   未選択（自動）・キー欠落時はブラウザ標準の動作へ戻す。
 *
 * 配布方式（全拡張で同一バイト）:
 *   各拡張の `src/shared/ui-localizer.js` へ逐語コピーする。拡張ごとに改変しない
 *   （改変すると正本の修正が配れなくなる。verify-l10n.mjs が SHA-256 で一致を検査する）。
 *
 * 読み込み方（どれでも同一バイトで動く）:
 *   - HTML の classic script（<head> で最初に読む）
 *   - Service Worker の importScripts("src/shared/ui-localizer.js")
 *   - module Service Worker / ES module からの副作用 import（`import "./ui-localizer.js"`）
 *   - content script（manifest の content_scripts.js の先頭）
 *   export は持たず、`globalThis.Localizer` へ Object.freeze で公開するだけ。二重ロードは無害（2回目は何もしない）。
 *
 * 設計上の制約:
 *   - トップレベルに束縛（const / let / function）を作らない。classic script を同一グローバルで二重に
 *     読んでも「再宣言」の SyntaxError にならないようにするため、すべて IIFE の中に置く。
 *   - 差し替え前のネイティブ関数は、各 i18n オブジェクトについて「差し替える前に」束縛して確保する
 *     （後から取ると差し替え後の自分自身を掴んで無限再帰になる）。
 *   - save() / clear() は拡張ページと Service Worker 専用。content script は共有の storage を書き換えず、
 *     読むだけ（保存された辞書を getMessage / t() で使う）。content script から呼ぶと Promise が reject する。
 *   - <html lang> と localStorage の控え（cpaUiLanguage）は拡張ページでのみ触る。
 *   - MAIN world（ページ内 world）には chrome.* が無いので使えない。必要な文言は ISOLATED world から渡す。
 *   - innerHTML は使わない（AMO の UNSAFE_VAR_ASSIGNMENT 回避）。
 */
(() => {
  "use strict";

  const root = globalThis;

  // 二重ロード防止。公開済みのオブジェクトがあれば何もしない（storage リスナー等の二重登録も避ける）。
  // 旧版（WRR の actions-core.js 内蔵の Localizer）も LANGUAGES を持つため、新版だけが持つ mountLanguageSelect を目印にする。
  if (root.Localizer && typeof root.Localizer === "object" && typeof root.Localizer.mountLanguageSelect === "function") return;

  // ---------------------------------------------------------------------------
  // 定数
  // ---------------------------------------------------------------------------

  /** 対応言語。順序と自称名は固定（選択欄の並び順。どの表示言語でも選べるよう各言語の自国語表記）。 */
  const LANGUAGES = Object.freeze([
    Object.freeze({ code: "en", name: "English" }),
    Object.freeze({ code: "ja", name: "日本語" }),
    Object.freeze({ code: "zh_CN", name: "简体中文" }),
    Object.freeze({ code: "zh_TW", name: "繁體中文" }),
    Object.freeze({ code: "ko", name: "한국어" }),
    Object.freeze({ code: "es", name: "Español" }),
    Object.freeze({ code: "fr", name: "Français" }),
    Object.freeze({ code: "de", name: "Deutsch" }),
    Object.freeze({ code: "pt_BR", name: "Português (Brasil)" }),
  ]);
  const CODES = LANGUAGES.map((language) => language.code);

  /** chrome.storage.local のキー（端末内のみ・同期しない）。WRR 現行名を維持する。 */
  const KEY_LANGUAGE = "uiLanguage"; // 選択した言語コード（未設定 = 自動）
  const KEY_MESSAGES = "uiMessages"; // 選択言語の辞書（compact の形）。content script も同じ言語で表示するため storage に置く
  const KEY_VERSION = "uiMessagesVersion"; // 辞書を作ったときの拡張の版。更新後の作り直し判定に使う
  /** 拡張ページ自身の localStorage 控え。<html lang> を storage の非同期読み込みを待たず同期で決めるため。 */
  const LOCAL_KEY = "cpaUiLanguage";
  const KEYS = Object.freeze([KEY_LANGUAGE, KEY_MESSAGES, KEY_VERSION]);

  // ---------------------------------------------------------------------------
  // 純粋関数
  // ---------------------------------------------------------------------------

  /** 9 コード以外は null。 */
  const normalizeCode = (raw) => (CODES.includes(raw) ? raw : null);

  /** `zh_CN` → `zh-CN`（html の lang 属性・getUILanguage 用） */
  const toTag = (code) => String(code).replace("_", "-");

  /** messages.json を保存用に圧縮する（description を捨て、{ key: { m, p? } } にする）。 */
  function compact(json) {
    const out = {};
    if (!json || typeof json !== "object") return out;
    for (const [key, entry] of Object.entries(json)) {
      if (typeof entry?.message !== "string") continue;
      out[key] = entry.placeholders ? { m: entry.message, p: entry.placeholders } : { m: entry.message };
    }
    return out;
  }

  /** `$NAME$`（placeholders）→ `$1`…`$9`（引数）の順に置換する。Chrome の getMessage と同じ規則。 */
  function format(entry, substitutions) {
    const args = substitutions === undefined || substitutions === null ? [] : Array.isArray(substitutions) ? substitutions : [substitutions];
    let text = entry.m;
    if (entry.p) {
      for (const [name, value] of Object.entries(entry.p)) {
        text = text.replace(new RegExp(`\\$${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\$`, "gi"), () => String(value?.content ?? ""));
      }
    }
    return text.replace(/\$([1-9])|\$\$/g, (match, digit) => (digit ? String(args[Number(digit) - 1] ?? "") : "$"));
  }

  // ---------------------------------------------------------------------------
  // 実行環境の判定
  // ---------------------------------------------------------------------------

  /** 拡張 API の名前空間。`chrome` を優先し、無ければ `browser`。i18n と storage.local が揃うものだけ採用。 */
  function primaryApi() {
    for (const name of ["chrome", "browser"]) {
      const api = root[name];
      if (api?.i18n && typeof api.i18n.getMessage === "function" && api.storage?.local) return api;
    }
    return null;
  }

  /** i18n / runtime だけを使う処理用。storage 権限が無い拡張（切替 UI なし）でも動くよう storage を要求しない。 */
  function anyApi() {
    for (const name of ["chrome", "browser"]) {
      const api = root[name];
      if (api && (api.i18n || api.runtime)) return api;
    }
    return null;
  }

  /**
   * 拡張自身のコンテキスト（拡張ページ / Service Worker）か。content script は location がページ側になるので false。
   * 保存先を書き換えてよいのは拡張自身だけ、という境界の判定に使う。
   */
  function inExtensionContext() {
    try {
      const href = root.location?.href;
      if (typeof href !== "string") return false;
      const base = anyApi()?.runtime?.getURL?.("");
      if (typeof base === "string" && base) return href.startsWith(base);
      return /^(?:chrome|moz|safari-web)-extension:/.test(href);
    } catch {
      return false;
    }
  }

  /** 拡張ページ（document を持つ拡張コンテキスト）か。Service Worker には document が無い。 */
  const inExtensionPage = () => inExtensionContext() && typeof root.document !== "undefined" && !!root.document?.documentElement;

  /** 拡張ページの localStorage。使えない環境（ブロック・SW）では null。 */
  function pageStorage() {
    try {
      return inExtensionPage() ? root.localStorage ?? null : null;
    } catch {
      return null;
    }
  }

  const currentVersion = () => {
    try {
      return primaryApi()?.runtime?.getManifest?.().version ?? null;
    } catch {
      return null;
    }
  };

  // ---------------------------------------------------------------------------
  // 状態
  // ---------------------------------------------------------------------------

  let code = null; // 有効な選択言語（null = 自動）
  let messages = null; // 選択言語の辞書（compact の形）
  let installed = false; // 差し替えが実際に効いたか。効かない環境では選んだ言語を名乗らない
  let signature = ""; // 反映済みの状態の識別子
  let emittedSignature = null; // onChange で最後に通知した状態。null = まだ一度も通知していない
  let nativeGetMessage = null; // t() が使うネイティブ getMessage（primary の差し替え前の束縛）
  const listeners = new Set();

  function emit() {
    emittedSignature = signature;
    for (const listener of [...listeners]) {
      try {
        listener(code);
      } catch {
        // 1 つのリスナーの失敗で他を止めない
      }
    }
  }

  /** storage の値を状態へ反映し、状態が変わったかを返す。拡張ページでは localStorage の控えも合わせる。 */
  function apply(stored) {
    const next = normalizeCode(stored?.[KEY_LANGUAGE]);
    const dictionary = stored?.[KEY_MESSAGES];
    code = installed && next && dictionary && typeof dictionary === "object" ? next : null;
    messages = code ? dictionary : null;
    const nextSignature = code ? `${code}|${stored?.[KEY_VERSION] ?? ""}|${Object.keys(messages).length}` : "";
    const changed = nextSignature !== signature;
    signature = nextSignature;
    if (installed) {
      // 控えを storage の実態へ合わせる（storage だけ消された・他ページで変更された場合のずれ防止）。
      const local = pageStorage();
      if (local) {
        try {
          if (code) local.setItem(LOCAL_KEY, code);
          else local.removeItem(LOCAL_KEY);
        } catch {
          // 控えが無くても storage の値で表示できる
        }
      }
    }
    return changed;
  }

  /**
   * storage を読み直して状態へ反映する。失敗しても reject しない。onChange の発火規則は kind で決める。
   *   "init"  : 初期読み込み。発火しない（起動時の組み立ては呼び出し側が ready の後に行うため）
   *   "reload": 直前の状態から変わったときだけ発火
   *   "event" : storage.onChanged 経由。まだ通知していない状態なら発火する。休止中の Service Worker は
   *             起動時の初期読み込みで新しい状態を先に取り込むため、変化の有無では判定できない
   */
  async function load(kind) {
    const storage = primaryApi()?.storage?.local;
    if (!storage) return;
    let stored;
    try {
      stored = await storage.get(Array.from(KEYS));
    } catch {
      return;
    }
    const changed = apply(stored);
    if (kind === "reload" && changed) emit();
    else if (kind === "event" && signature !== emittedSignature) emit();
  }

  /** storage を読み直し、状態が変わっていれば onChange を発火する（他コンテキストの変更の取り込みにも使う）。 */
  const reload = () => load("reload");

  // ---------------------------------------------------------------------------
  // 公開 API: 文言取得
  // ---------------------------------------------------------------------------

  /** 選択辞書 → ネイティブ getMessage → fallback の順に文言を引く。 */
  function t(key, substitutions, fallback = "") {
    const entry = messages?.[key];
    if (entry && typeof entry.m === "string") return format(entry, substitutions);
    if (nativeGetMessage) {
      try {
        const native = nativeGetMessage(key, substitutions);
        if (native) return native;
      } catch {
        // 標準側で失敗したら fallback へ
      }
    }
    return fallback;
  }

  // ---------------------------------------------------------------------------
  // 公開 API: 保存・解除
  // ---------------------------------------------------------------------------

  function assertWritable() {
    if (!inExtensionContext()) throw new Error("localizer-write-not-allowed-in-this-context");
  }

  /**
   * 選んだ言語の文言を同梱の messages.json から読み、storage へ保存して即座に反映する。
   * 拡張ページ / Service Worker 専用（content script からは reject）。拡張ページでは localStorage の控えも更新する。
   */
  async function save(raw) {
    assertWritable();
    const target = normalizeCode(raw);
    if (!target) throw new Error("unsupported-language");
    const api = primaryApi();
    if (!api || typeof root.fetch !== "function") throw new Error("localizer-unavailable");
    const response = await root.fetch(api.runtime.getURL(`_locales/${target}/messages.json`));
    if (!response.ok) throw new Error("locale-fetch-failed");
    const dictionary = compact(await response.json());
    await api.storage.local.set({ [KEY_LANGUAGE]: target, [KEY_MESSAGES]: dictionary, [KEY_VERSION]: currentVersion() });
    const local = pageStorage();
    if (local) {
      try {
        local.setItem(LOCAL_KEY, target);
      } catch {
        // 控えが無くても storage の値で表示できる
      }
    }
    await reload();
  }

  /** 「自動（ブラウザ言語）」へ戻す。3 キーを削除し、控えも消す。拡張ページ / Service Worker 専用。 */
  async function clear() {
    assertWritable();
    const api = primaryApi();
    if (!api) throw new Error("localizer-unavailable");
    await api.storage.local.remove(Array.from(KEYS));
    const local = pageStorage();
    if (local) {
      try {
        local.removeItem(LOCAL_KEY);
      } catch {
        // 同上
      }
    }
    await reload();
  }

  /**
   * 拡張の更新後に、保存済みの辞書が古い版のままなら作り直す。更新でキーが増えたり文言が変わっても、
   * 選んだ言語とブラウザ標準の言語が混ざらないようにする（Service Worker の onInstalled と、ページの起動時に呼ぶ）。
   * content script では何もしない（書き込めないため）。失敗しても保存済みの辞書で続ける。
   */
  async function ensureFresh() {
    if (!inExtensionContext()) return;
    try {
      const stored = await primaryApi().storage.local.get(Array.from(KEYS));
      const target = normalizeCode(stored[KEY_LANGUAGE]);
      if (target && (stored[KEY_VERSION] !== currentVersion() || !stored[KEY_MESSAGES])) await save(target);
    } catch {
      // 作り直せなければ保存済みの辞書で続ける
    }
  }

  /**
   * 状態の変化（言語の選択・自動へ戻す・辞書の作り直し）を購読する。引数は現在の言語コード（自動は null）。
   * 他コンテキスト（別ページ・Service Worker）の変更も storage.onChanged 経由で届く。
   * コンテキストメニューなど、起動時に一度だけ組み立てる UI の再生成に使う。解除関数を返す。
   */
  function onChange(listener) {
    if (typeof listener !== "function") throw new TypeError("listener must be a function");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  // ---------------------------------------------------------------------------
  // 公開 API: 文書（拡張ページ）
  // ---------------------------------------------------------------------------

  /**
   * <html lang> を表示言語へ合わせる（同期。拡張ページのみ）。localStorage の控え → 無ければ getUILanguage。
   * storage の非同期読み込みを待てない時点（<head> の classic script 直後）で呼べるよう同期にしてある。
   * 設定した lang を返す（設定しなければ null）。
   */
  function applyDocumentLang() {
    if (!inExtensionPage()) return null;
    try {
      let tag = null;
      const local = pageStorage();
      if (local) {
        try {
          const chosen = normalizeCode(local.getItem(LOCAL_KEY));
          if (chosen) tag = toTag(chosen);
        } catch {
          // 読めなければ自動扱い
        }
      }
      if (!tag) {
        const ui = anyApi()?.i18n?.getUILanguage?.();
        if (typeof ui === "string" && ui.length > 0) tag = ui;
      }
      if (tag) {
        root.document.documentElement.lang = tag;
        return tag;
      }
    } catch {
      // lang が設定できなくても表示には影響しない
    }
    return null;
  }

  /**
   * `data-i18n="key"` → textContent、`data-i18n-attr="attr:key;attr:key"` → 各属性を翻訳文言で置き換える。
   * 文言が空（キー欠落）なら置き換えず、HTML に書いた英語の fallback 文言を残す。innerHTML は使わない。
   */
  function localizeDocument(scope) {
    const rootNode = scope ?? root.document;
    if (!rootNode?.querySelectorAll) return;
    const collect = (selector) => {
      const found = Array.from(rootNode.querySelectorAll(selector));
      if (typeof rootNode.matches === "function" && rootNode.matches(selector)) found.unshift(rootNode);
      return found;
    };
    for (const el of collect("[data-i18n]")) {
      const message = t(el.getAttribute("data-i18n"));
      if (message) el.textContent = message;
    }
    for (const el of collect("[data-i18n-attr]")) {
      for (const pair of (el.getAttribute("data-i18n-attr") || "").split(";")) {
        const index = pair.indexOf(":");
        if (index < 0) continue;
        const attr = pair.slice(0, index).trim();
        const key = pair.slice(index + 1).trim();
        if (!attr || !key) continue;
        const message = t(key);
        if (message) el.setAttribute(attr, message);
      }
    }
  }

  /**
   * 言語選択の <select> を組み立てる。先頭に「自動」（t("languageAuto")）、続けて 9 言語（自国語表記）。
   * 変更で save / clear し、既定はページを再読み込みして反映する。onApplied を渡すと再読み込みの代わりに呼ぶ。
   * 失敗時は元の選択へ戻す。イベント解除用の関数を返す。
   */
  function mountLanguageSelect(select, { onApplied } = {}) {
    if (!select) return () => {};
    select.replaceChildren();
    select.add(new root.Option(t("languageAuto", undefined, "Auto"), "auto"));
    for (const language of LANGUAGES) select.add(new root.Option(language.name, language.code));
    select.value = code ?? "auto";
    const handler = async () => {
      const chosen = normalizeCode(select.value);
      select.disabled = true;
      try {
        if (chosen) await save(chosen);
        else await clear();
        if (typeof onApplied === "function") {
          await onApplied(chosen);
          select.disabled = false;
        } else {
          root.location.reload();
        }
      } catch {
        select.value = code ?? "auto";
        select.disabled = false;
      }
    };
    select.addEventListener("change", handler);
    return () => select.removeEventListener("change", handler);
  }

  // ---------------------------------------------------------------------------
  // 差し替えの取り付け
  // ---------------------------------------------------------------------------

  /** chrome.i18n / browser.i18n（同一オブジェクトなら 1 つ）の getMessage / getUILanguage を差し替える。 */
  function install() {
    const primary = primaryApi();
    if (!primary) {
      // storage 権限が無い等で言語切替が使えない環境でも、t() はブラウザ標準の文言を返せるようにする。
      const bare = [root.chrome, root.browser].find((api) => typeof api?.i18n?.getMessage === "function")?.i18n;
      if (bare) nativeGetMessage = bare.getMessage.bind(bare);
      return Promise.resolve();
    }

    // 差し替え対象（重複除去）。chrome と browser が別オブジェクトでも両方で選んだ言語を使えるようにする
    // （Kagayoi のフッターは browser.i18n を優先して getMessage を呼ぶ）。
    const targets = [];
    for (const name of ["chrome", "browser"]) {
      const target = root[name]?.i18n;
      if (target && typeof target.getMessage === "function" && !targets.includes(target)) targets.push(target);
    }

    let allEffective = targets.length > 0;
    for (const target of targets) {
      // 差し替える「前」にネイティブを束縛して確保する（再帰防止）
      const native = target.getMessage.bind(target);
      const nativeUi = typeof target.getUILanguage === "function" ? target.getUILanguage.bind(target) : null;
      if (target === primary.i18n) nativeGetMessage = native;

      const wrapper = (key, substitutions) => {
        const entry = messages?.[key];
        if (entry && typeof entry.m === "string") return format(entry, substitutions);
        return native(key, substitutions);
      };
      const uiWrapper = () => (code ? toTag(code) : nativeUi());

      replace(target, "getMessage", wrapper);
      if (nativeUi) replace(target, "getUILanguage", uiWrapper);
      if (target.getMessage !== wrapper) allEffective = false;
    }
    // 全対象で差し替えが効いたときだけ選んだ言語を使う（効かないのに言語だけ名乗ると、表示と選択がずれる）。
    installed = allEffective;

    try {
      primary.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        if (!(KEY_LANGUAGE in changes || KEY_MESSAGES in changes || KEY_VERSION in changes)) return;
        load("event");
      });
    } catch {
      // 文書破棄中など
    }
    return load("init");
  }

  /** 代入、だめなら defineProperty の順で差し替える。どちらも不可なら黙って諦める（呼び出し側が効果を検証する）。 */
  function replace(target, name, value) {
    try {
      target[name] = value;
    } catch {
      // 次の手段へ
    }
    if (target[name] !== value) {
      try {
        Object.defineProperty(target, name, { value, configurable: true, writable: true });
      } catch {
        // 差し替え不可
      }
    }
  }

  const ready = install();

  root.Localizer = Object.freeze({
    LANGUAGES,
    KEYS,
    normalizeCode,
    toTag,
    compact,
    format,
    ready,
    get code() {
      return code;
    },
    get installed() {
      return installed;
    },
    t,
    save,
    clear,
    ensureFresh,
    reload,
    onChange,
    applyDocumentLang,
    localizeDocument,
    mountLanguageSelect,
  });
})();
