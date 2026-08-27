(() => {
  "use strict"

  const DEFAULT_API_BASE = "https://support.kagayoi.com"
  const SESSION_KEY = "kagayoi-support-session"
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

  function adoptShadowStyles(shadowRoot) {
    const style = shadowRoot.querySelector("style")
    if (!style || typeof CSSStyleSheet !== "function") return
    try {
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(style.textContent)
      shadowRoot.adoptedStyleSheets = [...shadowRoot.adoptedStyleSheets, sheet]
      style.remove()
    } catch {
      // Older browsers keep using the inline shadow style as a fallback.
    }
  }

  // shadow DOM の中身は innerHTML 代入で組まない。このファイルは Chrome 拡張へ同梱する正本で、
  // AMO の静的解析が innerHTML 代入を UNSAFE_VAR_ASSIGNMENT として弾き、拡張側リポジトリにも
  // 「innerHTML 不使用」の契約があるため。テンプレートは静的文字列のみで、利用者入力は通さない。
  function replaceShadowContent(shadowRoot, markup) {
    const parsed = new DOMParser().parseFromString(markup, "text/html")
    const styles = [...parsed.head.querySelectorAll("style")]
    shadowRoot.replaceChildren(...styles, ...parsed.body.childNodes)
  }

  let instanceCount = 0

  class KagayoiContactForm extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
      this.instanceId = `kagayoi-support-${++instanceCount}`
      this.codeRequestedFor = ""
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
      replaceShadowContent(this.shadowRoot, `
        <style>
          :host {
            --ks-accent: var(--accent, var(--primary, #006fee));
            --ks-surface: var(--panel, var(--surface, #ffffff));
            --ks-surface-soft: var(--panel-2, var(--content2, rgba(127, 127, 127, 0.08)));
            --ks-border: var(--line, var(--border, rgba(127, 127, 127, 0.28)));
            --ks-text: var(--ink, var(--fg, inherit));
            --ks-muted: var(--muted, #62626b);
            display: block;
            color: var(--ks-text);
            font: inherit;
            line-height: 1.7;
          }
          *, *::before, *::after { box-sizing: border-box; }
          [hidden] { display: none !important; }
          .panel {
            padding: clamp(1rem, 3vw, 1.5rem);
            border: 1px solid var(--ks-border);
            border-radius: 16px;
            background-color: var(--ks-surface);
          }
          .intro { margin: 0 0 1.25rem; color: var(--ks-muted); font-size: 0.9rem; }
          .grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 1rem; }
          .field { display: grid; gap: 0.4rem; min-width: 0; }
          .field--full { grid-column: 1 / -1; }
          label, legend { text-align: left; font-weight: 600; font-size: 0.88rem; }
          .optional { color: var(--ks-muted); font-size: 0.76rem; font-weight: 400; }
          input, select, textarea, button { font: inherit; }
          input, select, textarea {
            width: 100%;
            min-height: 44px;
            padding: 0.68rem 0.78rem;
            border: 1px solid var(--ks-border);
            border-radius: 10px;
            background-color: var(--ks-surface);
            color: var(--ks-text);
          }
          textarea { min-height: 10rem; resize: vertical; }
          input:focus-visible, select:focus-visible, textarea:focus-visible, button:focus-visible, a:focus-visible {
            outline: 3px solid color-mix(in srgb, var(--ks-accent) 35%, transparent);
            outline-offset: 2px;
          }
          .verification {
            grid-column: 1 / -1;
            display: grid;
            grid-template-columns: minmax(0, 14rem) 1fr;
            align-items: end;
            gap: 0.8rem;
            padding: 1rem;
            border: 1px solid var(--ks-border);
            border-radius: 12px;
            background-color: var(--ks-surface-soft);
          }
          .verification p { align-self: center; margin: 0; color: var(--ks-muted); font-size: 0.82rem; }
          .resend {
            justify-self: start;
            padding: 0;
            border: 0;
            background-color: transparent;
            color: var(--ks-accent);
            cursor: pointer;
            text-decoration: underline;
            text-underline-offset: 0.18em;
          }
          .actions { display: flex; flex-wrap: wrap; align-items: center; gap: 0.8rem; margin-top: 1.15rem; }
          .submit, .again {
            min-height: 46px;
            padding: 0.72rem 1.15rem;
            border: 1px solid var(--ks-accent);
            border-radius: 999px;
            background-color: var(--ks-accent);
            color: #ffffff;
            font-weight: 700;
            cursor: pointer;
          }
          .submit:disabled, .again:disabled, .resend:disabled { cursor: wait; opacity: 0.62; }
          .auth-note { margin: 0; color: var(--ks-muted); font-size: 0.8rem; }
          .status { min-height: 1.7em; margin: 0.8rem 0 0; font-size: 0.86rem; }
          .status[data-kind="error"] { color: #c62828; }
          .status[data-kind="success"] { color: #19743b; }
          .success {
            padding: clamp(1.2rem, 4vw, 2rem);
            border: 1px solid var(--ks-border);
            border-radius: 16px;
            background-color: var(--ks-surface);
            text-align: center;
          }
          .success h2 { margin: 0 0 0.55rem; font-size: 1.35rem; }
          .success p { margin: 0.45rem 0; color: var(--ks-muted); }
          .reference { color: var(--ks-text) !important; font-weight: 700; letter-spacing: 0.05em; }
          .success a { color: var(--ks-accent); }
          .again { margin-top: 0.8rem; }
          .trap { position: absolute; left: -9999px; width: 1px; height: 1px; overflow: hidden; }
          @media (max-width: 620px) {
            .grid, .verification { grid-template-columns: 1fr; }
            .field--full { grid-column: auto; }
            .submit { width: 100%; }
          }
          @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
        </style>
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
            <div class="trap" aria-hidden="true">
              <label for="${id}-website">ウェブサイト</label>
              <input id="${id}-website" name="website" type="text" tabindex="-1" autocomplete="off">
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
      adoptShadowStyles(this.shadowRoot)
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
      if (this.form.elements.website.value) {
        this.showSuccess("KGS-RECEIVED")
        return
      }
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
      await this.requestCode()
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

    async requestCode() {
      if (this.busy || !this.email.checkValidity()) {
        if (!this.email.checkValidity()) this.email.reportValidity()
        return
      }
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
        const result = await this.api("/api/tickets", {
          method: "POST",
          token: accessToken,
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
        this.showSuccess(result.ticket.reference)
      }
      if (manageBusy) await this.runBusy(action)
      else await action()
    }

    async api(path, options) {
      const headers = { "Content-Type": "application/json" }
      if (options.token) headers.Authorization = `Bearer ${options.token}`
      let response
      try {
        response = await fetch(`${this.apiBase}${path}`, {
          method: options.method,
          credentials: "omit",
          headers,
          body: JSON.stringify(options.body),
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

  class KagayoiContactPopup extends HTMLElement {
    constructor() {
      super()
      this.attachShadow({ mode: "open" })
    }

    connectedCallback() {
      if (this.shadowRoot.childElementCount) return
      const popupId = `kagayoi-support-popup-${++popupCount}`
      replaceShadowContent(this.shadowRoot, `
        <style>
          :host {
            --ksp-accent: var(--ks-accent, var(--accent, var(--primary, #006fee)));
            --ksp-surface: var(--ks-surface, var(--panel, var(--surface, #ffffff)));
            --ksp-border: var(--ks-border, var(--line, var(--border, rgba(127, 127, 127, 0.28))));
            --ksp-text: var(--ks-text, var(--ink, var(--fg, #202124)));
            display: inline-block;
            color: var(--ksp-text);
            font: inherit;
          }
          *, *::before, *::after { box-sizing: border-box; }
          [hidden] { display: none !important; }
          .trigger {
            min-height: 40px;
            padding: 0.58rem 1rem;
            border: 1px solid var(--ksp-accent);
            border-radius: 999px;
            background: var(--ksp-accent);
            color: #ffffff;
            font: inherit;
            font-weight: 700;
            cursor: pointer;
          }
          .trigger:focus-visible, .close:focus-visible {
            outline: 3px solid color-mix(in srgb, var(--ksp-accent) 35%, transparent);
            outline-offset: 2px;
          }
          dialog {
            width: min(720px, calc(100vw - 1.5rem));
            max-width: none;
            max-height: calc(100vh - 1.5rem);
            padding: 0;
            border: 1px solid var(--ksp-border);
            border-radius: 18px;
            background: var(--ksp-surface);
            color: var(--ksp-text);
            box-shadow: 0 20px 60px rgba(0, 0, 0, 0.28);
            overflow: auto;
          }
          dialog::backdrop { background: rgba(0, 0, 0, 0.52); }
          .shell { min-width: 0; }
          .header {
            position: sticky;
            top: 0;
            z-index: 1;
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 1rem;
            padding: 0.9rem 1rem;
            border-bottom: 1px solid var(--ksp-border);
            background: var(--ksp-surface);
          }
          .title { margin: 0; font-size: 1.05rem; }
          .close {
            width: 38px;
            height: 38px;
            padding: 0;
            border: 1px solid var(--ksp-border);
            border-radius: 999px;
            background: transparent;
            color: inherit;
            font: inherit;
            font-size: 1.25rem;
            line-height: 1;
            cursor: pointer;
          }
          kagayoi-contact-form {
            display: block;
            padding: 1rem;
            --ks-accent: var(--ksp-accent);
            --ks-surface: transparent;
            --ks-border: var(--ksp-border);
            --ks-text: var(--ksp-text);
          }
          @media (max-width: 620px) {
            dialog { width: calc(100vw - 0.75rem); max-height: calc(100vh - 0.75rem); }
            kagayoi-contact-form { padding: 0.65rem; }
          }
        </style>
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
      adoptShadowStyles(this.shadowRoot)
      this.trigger = this.shadowRoot.querySelector(".trigger")
      this.dialog = this.shadowRoot.querySelector("dialog")
      this.form = document.createElement("kagayoi-contact-form")
      this.form.setAttribute("channel", "extension")
      this.form.setAttribute("storage", "local")
      this.trigger.textContent = this.getAttribute("button-label")?.trim() || "お問い合わせ"
      this.trigger.hidden = this.hasAttribute("hide-trigger")
      this.shadowRoot.querySelector(".title").textContent = this.getAttribute("dialog-title")?.trim() || "お問い合わせ"
      for (const name of ["product-id", "product-name", "api-base", "app-version", "os-version", "locale", "diagnostics"]) {
        if (this.hasAttribute(name)) this.form.setAttribute(name, this.getAttribute(name))
      }
      this.shadowRoot.querySelector(".form-host").append(this.form)
      this.trigger.addEventListener("click", () => this.open())
      this.shadowRoot.querySelector(".close").addEventListener("click", () => this.close())
      this.dialog.addEventListener("click", (event) => {
        if (event.target === this.dialog) this.close()
      })
      if (this.hasAttribute("open")) queueMicrotask(() => this.open())
    }

    open() {
      if (!this.dialog || this.dialog.open) return
      if (typeof this.dialog.showModal === "function") this.dialog.showModal()
      else this.dialog.setAttribute("open", "")
      queueMicrotask(() => this.form?.shadowRoot?.querySelector('input[name="email"]')?.focus())
    }

    close() {
      if (!this.dialog?.open) return
      if (typeof this.dialog.close === "function") this.dialog.close()
      else this.dialog.removeAttribute("open")
      this.trigger?.focus()
    }
  }

  if (!customElements.get("kagayoi-contact-form")) customElements.define("kagayoi-contact-form", KagayoiContactForm)
  if (!customElements.get("kagayoi-contact-popup")) customElements.define("kagayoi-contact-popup", KagayoiContactPopup)
})()
