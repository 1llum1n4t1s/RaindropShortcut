(() => {
  "use strict"

  const DEFAULT_API_BASE = "https://support.kagayoi.com"
  const SESSION_KEY = "kagayoi-support-session"
  const API_TIMEOUT_MS = 15_000
  const FORM_STYLESHEET_URL = bundledStylesheetUrl("kagayoi-support-form.css")
  const POPUP_STYLESHEET_URL = bundledStylesheetUrl("kagayoi-support-popup.css")
  const FIREFOX_OPTIONAL_CONTACT_DATA_PERMISSIONS = ["personalCommunications"]
  const CHANNELS = new Set(["web", "desktop", "extension", "other"])
  const STORAGE_SCOPES = new Set(["session", "local"])
  const CATEGORIES = [
    ["question", "使い方・ご質問"],
    ["bug", "不具合のご報告"],
    ["feature", "機能のご要望"],
    ["billing", "料金・ご依頼"],
    ["other", "その他"],
  ]
  const ERROR_LABELS = {
    "invalid email": "メールアドレスを確認してください。",
    "too many requests": "短時間に送信が集中しています。少し時間を置いてからお試しください。",
    "email unavailable": "確認メールを送信できませんでした。時間を置いてからお試しください。",
    "invalid code": "確認コードが正しくありません。",
    "code expired or locked": "確認コードの期限が切れたか、入力回数の上限に達しました。新しいコードを取得してください。",
    "code already used": "この確認コードは使用済みです。新しいコードを取得してください。",
    "authentication required": "認証の有効期限が切れました。確認コードを取得し直してください。",
    "invalid session": "認証の有効期限が切れました。確認コードを取得し直してください。",
    "invalid ticket": "入力内容を確認してください。",
    "invalid ticket metadata": "入力内容が長すぎます。",
    "unknown product": "お問い合わせ先を確認できませんでした。",
    "request too large": "お問い合わせ内容が長すぎます。",
    "origin not allowed": "このサイトからは現在送信できません。",
  }

  function bundledStylesheetUrl(fileName) {
    const api = typeof browser !== "undefined" ? browser : typeof chrome !== "undefined" ? chrome : null
    if (api?.runtime?.getURL) return api.runtime.getURL(`src/shared/${fileName}`)

    const script = Array.from(document.scripts).find(({ src }) =>
      /(?:^|\/)(?:contact-form|kagayoi-support-popup)\.js(?:[?#]|$)/.test(src),
    )
    return new URL(fileName, script?.src || document.baseURI).href
  }

  // shadow DOM の中身は innerHTML 代入で組まない。このファイルは Chrome 拡張へ同梱する正本で、
  // AMO の静的解析が innerHTML 代入を UNSAFE_VAR_ASSIGNMENT として弾き、拡張側リポジトリにも
  // 「innerHTML 不使用」の契約があるため。テンプレートは静的文字列のみで、利用者入力は通さない。
  function replaceShadowContent(shadowRoot, stylesheetUrl, markup) {
    const parsed = new DOMParser().parseFromString(markup, "text/html")
    const stylesheet = document.createElement("link")
    stylesheet.rel = "stylesheet"
    stylesheet.href = stylesheetUrl
    // MV3 の style-src 'self' では、style要素もConstructable StylesheetのCSS文字列もinline扱いになる。
    // 同梱した外部CSSだけを読み込み、Shadow DOMへinline styleを一度も入れない。
    shadowRoot.replaceChildren(stylesheet, ...parsed.body.childNodes)
  }

  let instanceCount = 0

  class KagayoiContactForm extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
      this.instanceId = `kagayoi-support-${++instanceCount}`
      this.codeRequestedFor = ""
      this.ticketIdempotencyKey = ""
      this.busy = false
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      this.productId = this.getAttribute("product-id")?.trim() ?? ""
      this.productName = this.getAttribute("product-name")?.trim() || "このサイト"
      this.apiBase = (this.getAttribute("api-base")?.trim() || DEFAULT_API_BASE).replace(/\/$/, "")
      const requestedChannel = this.getAttribute("channel")?.trim().toLowerCase() || "web"
      const requestedStorage = this.getAttribute("storage")?.trim().toLowerCase() || "session"
      this.channel = CHANNELS.has(requestedChannel) ? requestedChannel : "web"
      this.storageScope = STORAGE_SCOPES.has(requestedStorage) ? requestedStorage : "session"
      this.appVersion = this.optionalAttribute("app-version", 100)
      this.osVersion = this.optionalAttribute("os-version", 200)
      this.locale = this.optionalAttribute("locale", 40) || navigator.language?.slice(0, 40) || null
      this.diagnostics = this.optionalAttribute("diagnostics", 20000)
      this.render()
      this.bindEvents()
      this.syncAuthState()
    }

    render() {
      const id = this.instanceId
      replaceShadowContent(this.shadowRoot, FORM_STYLESHEET_URL, `
        <form class="panel" novalidate aria-label="お問い合わせフォーム">
          <p class="intro"><strong class="product-name"></strong>について、不具合・ご質問・ご要望・ご依頼を送信できます。返信先の確認のため、初回はメールで届く6桁のコードを入力してください。</p>
          <div class="grid">
            <div class="field">
              <label for="${id}-name">お名前 <span class="optional">（任意）</span></label>
              <input id="${id}-name" name="customerName" type="text" autocomplete="name" maxlength="100">
            </div>
            <div class="field">
              <label for="${id}-email">メールアドレス</label>
              <input id="${id}-email" name="email" type="email" autocomplete="email" inputmode="email" maxlength="254" required>
            </div>
            <div class="field field--full">
              <label for="${id}-category">お問い合わせ種別</label>
              <select id="${id}-category" name="category" required>
                ${CATEGORIES.map(([value, label]) => `<option value="${value}">${label}</option>`).join("")}
              </select>
            </div>
            <div class="field field--full">
              <label for="${id}-subject">件名</label>
              <input id="${id}-subject" name="subject" type="text" maxlength="160" required>
            </div>
            <div class="field field--full">
              <label for="${id}-description">お問い合わせ内容</label>
              <textarea id="${id}-description" name="description" maxlength="10000" required></textarea>
            </div>
            <div class="verification" hidden>
              <div class="field">
                <label for="${id}-code">6桁の確認コード</label>
                <input id="${id}-code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{6}" minlength="6" maxlength="6">
              </div>
              <p>コードは10分間有効です。届かない場合は迷惑メールフォルダーもご確認ください。<br><button class="resend" type="button">確認コードを再送する</button></p>
            </div>
          </div>
          <div class="actions">
            <button class="submit" type="submit">確認コードを送信</button>
            <p class="auth-note" hidden></p>
          </div>
          <p class="status" role="status" aria-live="polite"></p>
        </form>
        <section class="success" hidden tabindex="-1" aria-live="polite">
          <h2>お問い合わせを受け付けました</h2>
          <p>受付番号を控えてください。</p>
          <p class="reference"></p>
          <p>同じメールアドレスでログインすると、返信と対応状況を <a href="https://support.kagayoi.com/tickets" target="_blank" rel="noopener">Kagayoi Support</a> で確認できます。</p>
          <button class="again" type="button">別のお問い合わせを送る</button>
        </section>
      `)
      this.form = this.shadowRoot.querySelector("form")
      this.success = this.shadowRoot.querySelector(".success")
      this.email = this.form.elements.email
      this.code = this.form.elements.code
      this.verification = this.shadowRoot.querySelector(".verification")
      this.submit = this.shadowRoot.querySelector(".submit")
      this.resend = this.shadowRoot.querySelector(".resend")
      this.status = this.shadowRoot.querySelector(".status")
      this.authNote = this.shadowRoot.querySelector(".auth-note")
      this.shadowRoot.querySelector(".product-name").textContent = this.productName
      this.form.setAttribute("aria-label", `${this.productName}へのお問い合わせフォーム`)
    }

    bindEvents() {
      this.form.addEventListener("submit", (event) => {
        event.preventDefault()
        void this.handleSubmit()
      })
      this.email.addEventListener("input", () => {
        if (this.codeRequestedFor && this.normalizedEmail() !== this.codeRequestedFor) this.resetVerification()
        this.syncAuthState()
      })
      this.resend.addEventListener("click", () => void this.requestCode())
      this.shadowRoot.querySelector(".again").addEventListener("click", () => this.resetForm())
    }

    async handleSubmit() {
      if (this.busy || !this.productId) return
      if (!this.validateTicketFields()) return
      if (!await this.ensureDataCollectionConsent()) return
      const session = this.sessionForCurrentEmail()
      if (session) {
        await this.createTicket(session.accessToken)
        return
      }
      if (this.codeRequestedFor === this.normalizedEmail()) {
        if (!this.code.checkValidity()) {
          this.code.reportValidity()
          return
        }
        await this.verifyAndCreate()
        return
      }
      await this.requestCode(true)
    }

    validateTicketFields() {
      for (const control of [this.email, this.form.elements.category, this.form.elements.subject, this.form.elements.description]) {
        if (!control.checkValidity()) {
          control.reportValidity()
          return false
        }
      }
      return true
    }

    async requestCode(consentChecked = false) {
      if (this.busy || !this.email.checkValidity()) {
        if (!this.email.checkValidity()) this.email.reportValidity()
        return
      }
      if (!consentChecked && !await this.ensureDataCollectionConsent()) return
      const email = this.normalizedEmail()
      await this.runBusy(async () => {
        const data = await this.api("/api/auth/request", { method: "POST", body: { email } })
        this.codeRequestedFor = email
        this.verification.hidden = false
        this.code.required = true
        if (data.devCode && /^https?:\/\/(?:127\.0\.0\.1|localhost)(?::\d+)?$/.test(this.apiBase)) this.code.value = data.devCode
        this.submit.textContent = "認証して問い合わせを送信"
        this.setStatus(`${email} へ確認コードを送りました。`, "success")
        this.code.focus()
      })
    }

    async verifyAndCreate() {
      const email = this.normalizedEmail()
      await this.runBusy(async () => {
        const session = await this.api("/api/auth/verify", {
          method: "POST",
          body: { email, code: this.code.value.trim() },
        })
        this.storeSession(session)
        await this.createTicket(session.accessToken, false)
      })
    }

    async createTicket(accessToken, manageBusy = true) {
      const action = async () => {
        this.ticketIdempotencyKey ||= crypto.randomUUID()
        const result = await this.api("/api/tickets", {
          method: "POST",
          token: accessToken,
          idempotencyKey: this.ticketIdempotencyKey,
          body: {
            productId: this.productId,
            customerName: this.form.elements.customerName.value.trim() || null,
            category: this.form.elements.category.value,
            subject: this.form.elements.subject.value.trim(),
            description: this.form.elements.description.value.trim(),
            channel: this.channel,
            appVersion: this.appVersion,
            osVersion: this.osVersion,
            locale: this.locale,
            diagnostics: this.diagnostics,
          },
        })
        this.ticketIdempotencyKey = ""
        this.showSuccess(result.ticket.reference)
      }
      if (manageBusy) await this.runBusy(action)
      else await action()
    }

    async ensureDataCollectionConsent() {
      if (!this.hasAttribute("firefox-data-consent")) return true
      const api = globalThis.browser ?? globalThis.chrome
      let extensionOrigin = ""
      try {
        extensionOrigin = api?.runtime?.getURL?.("") || ""
      } catch {}
      if (!extensionOrigin.startsWith("moz-extension://")) return true

      try {
        // submit / resend の user-activated handler 内で最初の非同期 API として呼ぶ。
        // 既に許可済みなら Firefox はプロンプトなしで true を返す。
        const granted = await api.permissions.request({
          data_collection: FIREFOX_OPTIONAL_CONTACT_DATA_PERMISSIONS,
        })
        if (granted) return true
        this.setStatus("お問い合わせ情報の送信には Firefox の許可が必要です。", "error")
      } catch {
        this.setStatus("Firefox のデータ送信許可を確認できませんでした。", "error")
      }
      return false
    }

    async api(path, options) {
      const headers = { "Content-Type": "application/json" }
      if (options.token) headers.Authorization = `Bearer ${options.token}`
      if (options.idempotencyKey) headers["Idempotency-Key"] = options.idempotencyKey
      let response
      try {
        response = await fetch(`${this.apiBase}${path}`, {
          method: options.method,
          credentials: "omit",
          headers,
          body: JSON.stringify(options.body),
          signal: AbortSignal.timeout(API_TIMEOUT_MS),
        })
      } catch {
        throw new Error("network")
      }
      const data = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(data.error || "request failed")
        error.status = response.status
        throw error
      }
      return data
    }

    async runBusy(action) {
      this.busy = true
      this.submit.disabled = true
      this.resend.disabled = true
      this.setStatus("送信しています…")
      try {
        await action()
      } catch (error) {
        if (error.status === 401) {
          this.clearSession()
          this.resetVerification()
        }
        this.setStatus(this.errorLabel(error), "error")
      } finally {
        this.busy = false
        this.submit.disabled = false
        this.resend.disabled = false
        this.syncAuthState()
      }
    }

    showSuccess(reference) {
      this.shadowRoot.querySelector(".reference").textContent = reference
      this.form.hidden = true
      this.success.hidden = false
      this.success.focus?.()
      this.dispatchEvent(new CustomEvent("kagayoi-support-submitted", {
        bubbles: true,
        composed: true,
        detail: { reference },
      }))
    }

    resetForm() {
      const email = this.normalizedEmail()
      this.form.reset()
      this.email.value = email
      this.resetVerification()
      this.success.hidden = true
      this.form.hidden = false
      this.setStatus("")
      this.syncAuthState()
      this.form.elements.subject.focus()
    }

    resetVerification() {
      this.codeRequestedFor = ""
      this.code.value = ""
      this.code.required = false
      this.verification.hidden = true
    }

    syncAuthState() {
      if (this.codeRequestedFor) return
      const session = this.sessionForCurrentEmail()
      this.submit.textContent = session ? "問い合わせを送信" : "確認コードを送信"
      this.authNote.hidden = !session
      this.authNote.textContent = session ? `${session.email} は認証済みです。` : ""
    }

    normalizedEmail() {
      return this.email.value.trim().toLowerCase()
    }

    sessionForCurrentEmail() {
      const session = this.readSession()
      return session?.email === this.normalizedEmail() ? session : null
    }

    readSession() {
      try {
        const session = JSON.parse(this.storageArea()?.getItem(SESSION_KEY) || "null")
        if (!session?.accessToken || !session.email || Number(session.expiresAt) <= Math.floor(Date.now() / 1000)) {
          this.clearSession()
          return null
        }
        return session
      } catch {
        this.clearSession()
        return null
      }
    }

    storeSession(session) {
      try {
        this.storageArea()?.setItem(SESSION_KEY, JSON.stringify({
          accessToken: session.accessToken,
          expiresAt: session.expiresAt,
          email: String(session.email).toLowerCase(),
        }))
      } catch {
        // Storage can be unavailable in hardened browsers. The current submission can still continue.
      }
    }

    clearSession() {
      try {
        this.storageArea()?.removeItem(SESSION_KEY)
      } catch {
        // Nothing else is required when browser storage is unavailable.
      }
    }

    setStatus(message, kind = "") {
      this.status.textContent = message
      this.status.dataset.kind = kind
    }

    optionalAttribute(name, maxLength) {
      const value = this.getAttribute(name)?.trim()
      return value ? value.slice(0, maxLength) : null
    }

    storageArea() {
      try {
        return this.storageScope === "local" ? window.localStorage : window.sessionStorage
      } catch {
        return null
      }
    }

    errorLabel(error) {
      if (error.message === "network") return "通信できませんでした。接続を確認して、もう一度お試しください。"
      return ERROR_LABELS[error.message] || "送信できませんでした。時間を置いてからお試しください。"
    }
  }

  let popupCount = 0
  let documentScrollLockCount = 0
  let documentScrollRestore = []
  let documentScrollPosition = { left: 0, top: 0 }

  function rememberInlineStyles(element, properties) {
    return {
      element,
      properties: properties.map((property) => ({
        property,
        value: element.style.getPropertyValue(property),
        priority: element.style.getPropertyPriority(property),
      })),
    }
  }

  function applyLockedStyles(element, styles) {
    for (const [property, value] of Object.entries(styles)) {
      element.style.setProperty(property, value, "important")
    }
  }

  function lockDocumentScroll() {
    const root = document.documentElement
    const body = document.body
    if (!root || !body) return
    documentScrollLockCount += 1
    if (documentScrollLockCount !== 1) return

    const viewportWidth = Math.max(1, window.innerWidth || root.clientWidth || body.clientWidth || 1)
    const viewportHeight = Math.max(1, window.innerHeight || root.clientHeight || body.clientHeight || 1)
    const lockedWidth = `${viewportWidth}px`
    const lockedHeight = `${viewportHeight}px`
    documentScrollPosition = {
      left: Number.isFinite(window.scrollX) ? window.scrollX : 0,
      top: Number.isFinite(window.scrollY) ? window.scrollY : 0,
    }
    documentScrollRestore = [
      rememberInlineStyles(root, [
        "overflow",
        "width",
        "min-width",
        "max-width",
        "height",
        "min-height",
        "max-height",
        "scrollbar-width",
        "scrollbar-color",
      ]),
      rememberInlineStyles(body, [
        "overflow",
        "position",
        "top",
        "right",
        "left",
        "width",
        "min-width",
        "max-width",
        "height",
        "min-height",
        "max-height",
        "scrollbar-width",
        "scrollbar-color",
      ]),
    ]

    // Chrome の action popup は documentElement.scrollHeight が上限 (600px) を超えると、
    // overflow:hidden でもブラウザ側の外スクロールバーを強制する。現在の viewport 寸法へ
    // レイアウト自体を固定し、body を通常フローから外すことで dialog の1本だけにする。
    // fixed body の幅解決は Chromium のビルド差があるため、左右位置だけでなく pixel 幅も固定する。
    applyLockedStyles(root, {
      overflow: "hidden",
      width: lockedWidth,
      "min-width": lockedWidth,
      "max-width": lockedWidth,
      height: lockedHeight,
      "min-height": lockedHeight,
      "max-height": lockedHeight,
      "scrollbar-width": "none",
      "scrollbar-color": "transparent transparent",
    })
    applyLockedStyles(body, {
      overflow: "hidden",
      position: "fixed",
      top: "0",
      right: "0",
      left: "0",
      width: lockedWidth,
      "min-width": lockedWidth,
      "max-width": lockedWidth,
      height: lockedHeight,
      "min-height": lockedHeight,
      "max-height": lockedHeight,
      "scrollbar-width": "none",
      "scrollbar-color": "transparent transparent",
    })
  }

  function unlockDocumentScroll() {
    if (documentScrollLockCount === 0) return
    documentScrollLockCount -= 1
    if (documentScrollLockCount !== 0) return

    for (const { element, properties } of documentScrollRestore) {
      for (const { property, value, priority } of properties) {
        if (value) element.style.setProperty(property, value, priority)
        else element.style.removeProperty(property)
      }
    }
    documentScrollRestore = []
    if (documentScrollPosition.left || documentScrollPosition.top) {
      try {
        window.scrollTo(documentScrollPosition.left, documentScrollPosition.top)
      } catch {
        // Embedded or hardened contexts can reject programmatic scrolling.
      }
    }
    documentScrollPosition = { left: 0, top: 0 }
  }

  class KagayoiContactPopup extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      const popupId = `kagayoi-support-popup-${++popupCount}`
      replaceShadowContent(this.shadowRoot, POPUP_STYLESHEET_URL, `
        <button class="trigger" type="button" aria-haspopup="dialog" aria-controls="${popupId}">お問い合わせ</button>
        <dialog id="${popupId}" aria-labelledby="${popupId}-title">
          <div class="shell">
            <header class="header">
              <h2 class="title" id="${popupId}-title">お問い合わせ</h2>
              <button class="close" type="button" aria-label="閉じる">×</button>
            </header>
            <div class="form-host"></div>
          </div>
        </dialog>
      `)
      this.trigger = this.shadowRoot.querySelector(".trigger")
      this.dialog = this.shadowRoot.querySelector("dialog")
      this.form = document.createElement("kagayoi-contact-form")
      this.form.setAttribute("channel", "extension")
      this.form.setAttribute("storage", "local")
      this.trigger.textContent = this.getAttribute("button-label")?.trim() || "お問い合わせ"
      this.trigger.hidden = this.hasAttribute("hide-trigger")
      this.shadowRoot.querySelector(".title").textContent = this.getAttribute("dialog-title")?.trim() || "お問い合わせ"
      for (const name of ["product-id", "product-name", "api-base", "app-version", "os-version", "locale", "diagnostics", "firefox-data-consent"]) {
        if (this.hasAttribute(name)) this.form.setAttribute(name, this.getAttribute(name))
      }
      this.shadowRoot.querySelector(".form-host").append(this.form)
      this.trigger.addEventListener("click", () => this.open())
      this.shadowRoot.querySelector(".close").addEventListener("click", () => this.close())
      this.dialog.addEventListener("click", (event) => {
        if (event.target === this.dialog) this.close()
      })
      this.dialog.addEventListener("close", () => {
        this.finishClose()
      })
      if (this.hasAttribute("open")) {
        queueMicrotask(() => {
          if (this.isConnected) this.open()
        })
      }
    }

    disconnectedCallback() {
      this.releaseDocumentScrollLock()
    }

    open(returnFocusTo = this.trigger) {
      if (!this.isConnected || !this.dialog || this.dialog.open) return
      this.returnFocusTo = returnFocusTo
      this.acquireDocumentScrollLock()
      try {
        if (typeof this.dialog.showModal === "function") this.dialog.showModal()
        else this.dialog.setAttribute("open", "")
      } catch (error) {
        this.releaseDocumentScrollLock()
        throw error
      }
      queueMicrotask(() => this.form?.shadowRoot?.querySelector('input[name="email"]')?.focus())
    }

    close() {
      if (!this.dialog?.open) return
      if (typeof this.dialog.close === "function") this.dialog.close()
      else this.dialog.removeAttribute("open")
      this.finishClose()
    }

    finishClose() {
      if (!this.documentScrollLocked) return
      this.releaseDocumentScrollLock()
      this.restoreFocus()
    }

    restoreFocus() {
      const target = this.returnFocusTo?.isConnected ? this.returnFocusTo : this.trigger
      target?.focus()
      this.returnFocusTo = this.trigger
    }

    acquireDocumentScrollLock() {
      if (this.documentScrollLocked) return
      this.documentScrollLocked = true
      lockDocumentScroll()
    }

    releaseDocumentScrollLock() {
      if (!this.documentScrollLocked) return
      this.documentScrollLocked = false
      unlockDocumentScroll()
    }
  }

  if (!customElements.get("kagayoi-contact-form")) customElements.define("kagayoi-contact-form", KagayoiContactForm)
  if (!customElements.get("kagayoi-contact-popup")) customElements.define("kagayoi-contact-popup", KagayoiContactPopup)
})()
