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
  // Localizer.ready の待ち上限。通常は一瞬で解決するが、解決しない環境でも描画だけは出す（ready 後に再描画する）。
  const LOCALIZER_WAIT_MS = 1500

  // 組み込みラベル（9言語）。キーは contact-form.js の resolveLanguage() が返す内部コードと同じ。
  // 解決順は 属性 → 拡張の _locales → ここ、のまま変えない（_locales のキー名も kagayoiSupportContact / Rate）。
  const LABELS = {
    ja: { contact: "お問い合わせ", rate: "評価をお願いします！" },
    en: { contact: "Contact support", rate: "Please rate us!" },
    de: { contact: "Support kontaktieren", rate: "Bitte bewerten Sie uns!" },
    es: { contact: "Contactar con soporte", rate: "¡Déjenos su valoración!" },
    fr: { contact: "Contacter le support", rate: "Évaluez-nous !" },
    ko: { contact: "문의하기", rate: "평가해 주세요!" },
    pt_BR: { contact: "Falar com o suporte", rate: "Avalie-nos!" },
    zh_CN: { contact: "联系支持", rate: "请给我们评分！" },
    zh_TW: { contact: "聯絡支援", rate: "請為我們評分！" },
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

  /**
   * 言語タグを 9 コード（ja en de es fr ko pt_BR zh_CN zh_TW）へ写像する。
   * contact-form.js の resolveLanguage() と同一仕様（逐語コピー配布のため別ファイルに持ち、一致はテストで固定）。
   *  - ja* → ja / pt* → pt_BR / en de es fr ko はそのまま / それ以外・空 → en
   *  - zh-TW・zh-HK・zh-MO・zh-Hant* → zh_TW、それ以外の zh*（zh-Hans* を含む）→ zh_CN
   */
  function resolveLanguage(tag) {
    const [primary, ...subtags] = String(tag ?? "").trim().toLowerCase().replaceAll("_", "-").split("-")
    switch (primary) {
      case "ja": return "ja"
      case "zh":
        if (subtags.includes("hans")) return "zh_CN"
        return subtags.some((subtag) => ["tw", "hk", "mo", "hant"].includes(subtag)) ? "zh_TW" : "zh_CN"
      case "pt": return "pt_BR"
      case "en": case "de": case "es": case "fr": case "ko": return primary
      default: return "en"
    }
  }

  /** ui-localizer.js（拡張側の共通モジュール）。無い拡張・環境では null で、従来どおりの判定になる。 */
  function localizer() {
    const candidate = globalThis.Localizer
    return candidate && typeof candidate.onChange === "function" && candidate.ready ? candidate : null
  }

  /**
   * 表示言語の判定順: 要素/祖先の明示 lang → Localizer の選択言語 → <html lang> → getUILanguage → ja。
   * 祖先探索は <html> を除く。<html lang> は Localizer が後から書き換える（初回起動では古い）ため、
   * Localizer の選択言語より後に置く必要がある。
   */
  function uiLanguage(host, api) {
    const explicit = host.closest("[lang]")
    const scoped = explicit && explicit !== document.documentElement ? explicit.getAttribute("lang")?.trim() : ""
    const chosen = localizer()?.code
    const tag = scoped || (chosen ? chosen.replace("_", "-") : "")
      || document.documentElement.lang?.trim() || api?.i18n?.getUILanguage?.() || "ja"
    return resolveLanguage(tag)
  }

  /**
   * ラベルの優先順位: 属性 → 拡張の _locales（キーがあれば） → 組み込みの 9 言語。
   * 組み込みを持つので、拡張ごとに messages.json を増やさなくても日本語表示になる。
   */
  function label(host, api, attribute, messageKey, fallbackKey) {
    const fromAttribute = host.getAttribute(attribute)?.trim()
    if (fromAttribute) return fromAttribute
    const fromLocale = api?.i18n?.getMessage?.(messageKey)?.trim()
    if (fromLocale) return fromLocale
    return LABELS[uiLanguage(host, api)][fallbackKey]
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
      const api = extensionApi()
      // 拡張ページ以外（popup.html を素のブラウザで開いたプレビュー等）では出さない。
      // 問い合わせ API は拡張 Origin 前提で、ストア URL も組み立てられないため。
      if (!api) {
        this.hidden = true
        return
      }

      const loc = localizer()
      if (!loc) {
        this.render(api)
        return
      }

      // Localizer がある拡張は、辞書の差し替え（ready）が済む前に描画すると、選択言語ではなく
      // ブラウザの UI 言語の文言で固定されてしまう。ready を待ってから描く（待ち上限あり）。
      // 再接続でも購読が二重にならないよう、解除関数は 1 つだけ保持する。
      if (!this.unsubscribeLocalizer) this.unsubscribeLocalizer = loc.onChange(() => this.render(extensionApi()))
      // ready が遅れて解決する場合は、待ち上限で先に描いたあとにもう一度言語を引き直して描き直す。
      Promise.race([loc.ready, new Promise((resolve) => setTimeout(resolve, LOCALIZER_WAIT_MS))])
        .catch(() => {})
        .then(() => this.render(extensionApi()))
      loc.ready
        .then(() => {
          // <html lang> は初回起動だと古いので、Localizer の判定へ合わせてから描き直す。
          try { loc.applyDocumentLang() } catch { /* 拡張ページ以外では何もしない */ }
          this.render(extensionApi())
        })
        .catch(() => {})
    }

    disconnectedCallback() {
      this.unsubscribeLocalizer?.()
      this.unsubscribeLocalizer = null
    }

    /**
     * 描画（冪等）。言語・ラベルが前回と同じなら何もしないので、ready と onChange が重なっても
     * 二重描画やポップアップの作り直しは起きない。ダイアログを開いている間は閉じるまで見送る。
     */
    render(api) {
      if (!this.isConnected || !api) return
      const signature = JSON.stringify([
        uiLanguage(this, api),
        label(this, api, "contact-label", "kagayoiSupportContact", "contact"),
        label(this, api, "rate-label", "kagayoiSupportRate", "rate"),
      ])
      if (this.shadowRoot.childElementCount && signature === this.renderedSignature) return

      const dialog = this.popup?.dialog
      if (dialog?.open) {
        if (!this.renderDeferred) {
          this.renderDeferred = true
          dialog.addEventListener("close", () => {
            this.renderDeferred = false
            this.render(extensionApi())
          }, { once: true })
        }
        return
      }

      this.renderedSignature = signature
      this.hidden = false
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
      // 内部コード（zh_CN）を BCP 47（zh-CN）へ戻して渡す。ポップアップ側の resolveLanguage が同じ言語へ戻す。
      this.popup.setAttribute("lang", uiLanguage(this, api).replace("_", "-"))
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
        // 開く時点の言語が描画時と違っていれば（onChange 前の取りこぼし等）、先に作り直して最新の言語で開く。
        this.render(api)
        // バンドラが読み込み順を変えて定義が後から来ることがあるので、少しだけ待つ。
        if (!customElements.get("kagayoi-contact-popup")) {
          await Promise.race([
            customElements.whenDefined("kagayoi-contact-popup"),
            new Promise((resolve) => setTimeout(resolve, DEFINITION_WAIT_MS)),
          ])
        }
        // それでも来なければ（kagayoi-support-popup.js の同梱漏れ）操作不能にはせず、Web の窓口を開く。
        if (typeof this.popup.open === "function") {
          // render で作り直されていれば、元のボタンは外れているので新しい方へフォーカスを戻す。
          this.popup.open(button.isConnected ? button : this.shadowRoot.querySelector(".contact") ?? undefined)
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

    // テスト用の読み取り専用公開（ラベル表と言語写像の検証が参照する）。描画には影響しない。
    static get i18n() {
      return { LABELS, resolveLanguage }
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
