/*
 * <kagayoi-support-footer> — Chrome 拡張の設定画面に置く共通フッター。
 *
 * 「お問い合わせ」と「評価をお願いします！★★★★★」の 2 ボタンをまとめて描画する。
 * 全拡張で同じ組み込み方にするための部品で、拡張側では次の 3 行だけを書く。
 *
 *   <kagayoi-support-footer product-id="my-extension" product-name="拡張機能名"></kagayoi-support-footer>
 *   <script type="module" src="../shared/kagayoi-support-popup.js"></script>
 *   <script type="module" src="../shared/kagayoi-support-footer.js"></script>
 *
 * このファイルは Kagayoi.Support が正本。拡張側へは逐語コピーで同梱し、拡張ごとに改変しない
 * （改変すると「作り方が全拡張で同じ」が崩れ、正本の修正が配れなくなる）。
 *
 * 方針:
 *   - innerHTML を使わない。AMO の静的解析 UNSAFE_VAR_ASSIGNMENT 回避と、拡張側リポジトリの
 *     「innerHTML 不使用」契約に合わせるため、DOM は createElement + textContent で組む。
 *   - 配色は host のテキスト色に対する灰色オーバーレイで作る。拡張ごとに CSS 変数名が違うので、
 *     どのテーマ（ライト / ダーク）でも破綻しない中立色を既定にし、必要なら --kgs-* で上書きする。
 *   - ストア URL は runtime.id から実行時に組み立てる。拡張ごとに ID を書かないので設定漏れが出ない。
 */
(() => {
  "use strict"

  const SUPPORT_SITE = "https://support.kagayoi.com/"
  const DEFINITION_WAIT_MS = 1000

  const LABELS = {
    ja: { contact: "お問い合わせ", rate: "評価をお願いします！" },
    en: { contact: "Contact support", rate: "Please rate us!" },
  }
  const STYLESHEET_URL = bundledStylesheetUrl("kagayoi-support-footer.css")

  function bundledStylesheetUrl(fileName) {
    const api = extensionApi()
    if (api) return api.runtime.getURL(`src/shared/${fileName}`)

    const script = Array.from(document.scripts).find(({ src }) =>
      /(?:^|\/)kagayoi-support-footer\.js(?:[?#]|$)/.test(src),
    )
    return new URL(fileName, script?.src || document.baseURI).href
  }

  function replaceShadowContent(shadowRoot, ...nodes) {
    const stylesheet = document.createElement("link")
    stylesheet.rel = "stylesheet"
    stylesheet.href = STYLESHEET_URL
    shadowRoot.replaceChildren(stylesheet, ...nodes)
  }

  /** Chrome は chrome.*、Firefox は browser.*。拡張ページ以外（プレビュー等）では null。 */
  function extensionApi() {
    const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null
    return api?.runtime?.getURL ? api : null
  }

  // Firefox 判定は評価リンクの向き先（AMO）を決めるためだけに使う。問い合わせは
  // Worker が拡張スキームを許可しているので、Chrome / Firefox のどちらでも送れる。
  function isFirefox(api) {
    return api.runtime.getURL("").startsWith("moz-extension://")
  }

  function uiLanguage(api) {
    const tag = api?.i18n?.getUILanguage?.() || navigator.language || "en"
    return tag.toLowerCase().startsWith("ja") ? "ja" : "en"
  }

  /**
   * ラベルの優先順位: 属性 → 拡張の _locales（キーがあれば） → 組み込みの ja/en。
   * 組み込みを持つので、拡張ごとに messages.json を増やさなくても日本語表示になる。
   */
  function label(host, api, attribute, messageKey, fallbackKey) {
    const fromAttribute = host.getAttribute(attribute)?.trim()
    if (fromAttribute) return fromAttribute
    const fromLocale = api?.i18n?.getMessage?.(messageKey)?.trim()
    if (fromLocale) return fromLocale
    return LABELS[uiLanguage(api)][fallbackKey]
  }

  /**
   * 製品名。既定は manifest の name で、`__MSG_appName__` 形式なら _locales から引き直す
   * （getManifest() はプレースホルダを解決しないため）。拡張ごとに名前を書かなくて済む。
   */
  function productName(host, api) {
    const explicit = host.getAttribute("product-name")?.trim()
    if (explicit) return explicit
    const raw = api.runtime.getManifest?.().name?.trim() ?? ""
    const messageKey = raw.match(/^__MSG_(.+)__$/)?.[1]
    if (!messageKey) return raw
    return api.i18n?.getMessage?.(messageKey)?.trim() || ""
  }

  /**
   * 評価ページの URL。Firefox は AMO、update_url に microsoft を含むものは Edge アドオン、
   * それ以外は Chrome ウェブストア。拡張 ID は公開時にストアの ID と一致する。
   */
  function storeUrl(host, api) {
    const explicit = host.getAttribute("store-url")?.trim()
    if (explicit?.startsWith("https://")) return explicit
    if (!api) return ""
    const manifest = api.runtime.getManifest?.() ?? {}
    if (isFirefox(api)) {
      const slug = host.getAttribute("amo-slug")?.trim() || manifest.browser_specific_settings?.gecko?.id || ""
      return slug ? `https://addons.mozilla.org/firefox/addon/${encodeURIComponent(slug)}/` : ""
    }
    const id = api.runtime.id
    if (!id) return ""
    return String(manifest.update_url ?? "").toLowerCase().includes("microsoft")
      ? `https://microsoftedge.microsoft.com/addons/detail/${id}`
      : `https://chromewebstore.google.com/detail/${id}`
  }

  class KagayoiSupportFooter extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      const api = extensionApi()
      // 拡張ページ以外（popup.html を素のブラウザで開いたプレビュー等）では出さない。
      // 問い合わせ API は拡張 Origin 前提で、ストア URL も組み立てられないため。
      if (!api) {
        this.hidden = true
        return
      }

      const stack = document.createElement("div")
      stack.className = "stack"

      if (!this.hasAttribute("hide-contact")) stack.append(this.buildContact(api))
      if (!this.hasAttribute("hide-rate")) {
        const rate = this.buildRate(api)
        if (rate) stack.append(rate)
      }

      replaceShadowContent(this.shadowRoot, stack)
      if (!stack.childElementCount) this.hidden = true
    }

    buildContact(api) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "item contact"
      button.setAttribute("aria-haspopup", "dialog")
      button.textContent = label(this, api, "contact-label", "kagayoiSupportContact", "contact")

      this.popup = document.createElement("kagayoi-contact-popup")
      this.popup.setAttribute("hide-trigger", "")
      this.popup.setAttribute("product-id", this.getAttribute("product-id")?.trim() ?? "")
      const dialogTitle = this.getAttribute("dialog-title")?.trim() || button.textContent
      this.popup.setAttribute("dialog-title", dialogTitle)
      const name = productName(this, api)
      if (name) this.popup.setAttribute("product-name", name)
      for (const attribute of ["api-base", "os-version", "locale", "diagnostics"]) {
        const value = this.getAttribute(attribute)?.trim()
        if (value) this.popup.setAttribute(attribute, value)
      }
      if (this.hasAttribute("firefox-data-consent")) this.popup.setAttribute("firefox-data-consent", "")
      const version = this.getAttribute("app-version")?.trim() || api.runtime.getManifest?.().version
      if (version) this.popup.setAttribute("app-version", version)

      button.addEventListener("click", async () => {
        // バンドラが読み込み順を変えて定義が後から来ることがあるので、少しだけ待つ。
        if (!customElements.get("kagayoi-contact-popup")) {
          await Promise.race([
            customElements.whenDefined("kagayoi-contact-popup"),
            new Promise((resolve) => setTimeout(resolve, DEFINITION_WAIT_MS)),
          ])
        }
        // それでも来なければ（kagayoi-support-popup.js の同梱漏れ）操作不能にはせず、Web の窓口を開く。
        if (typeof this.popup.open === "function") {
          this.popup.open(button)
        } else if (api.tabs?.create) {
          api.tabs.create({ url: SUPPORT_SITE })
        } else {
          window.open(SUPPORT_SITE, "_blank", "noopener")
        }
      })

      const wrapper = document.createDocumentFragment()
      wrapper.append(button, this.popup)
      return wrapper
    }

    buildRate(api) {
      const href = storeUrl(this, api)
      if (!href) return null
      const link = document.createElement("a")
      link.className = "item rate"
      link.href = href
      link.target = "_blank"
      link.rel = "noreferrer noopener"

      const text = document.createElement("span")
      text.className = "rate-label"
      text.textContent = label(this, api, "rate-label", "kagayoiSupportRate", "rate")

      const stars = document.createElement("span")
      stars.className = "stars"
      stars.setAttribute("aria-hidden", "true")
      stars.textContent = "★★★★★"

      link.append(text, stars)
      return link
    }

    /** 既存ボタンから問い合わせダイアログだけ開きたい場合の入口。 */
    open() {
      this.popup?.open?.()
    }
  }

  if (!customElements.get("kagayoi-support-footer")) {
    customElements.define("kagayoi-support-footer", KagayoiSupportFooter)
  }
})()
