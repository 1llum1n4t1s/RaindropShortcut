// cdp.mjs — CDP 経由でページ内（closed shadow root・iframe を含む）の文字を持つ要素を列挙し、
// 実使用フォント（CSS.getPlatformFontsForNode）と描画メトリクス（はみ出し判定用）を取る。
// 背景: SearchClock のパネルは closed Shadow DOM のため page.evaluate / querySelector では届かない。
//       DOM.getDocument({ pierce: true }) なら closed shadow も含めて辿れる。
// 注意: getPlatformFontsForNode は「そのノード直下のテキスト」だけを対象にするので、body などでは空になる。
//       文字を直接持つ要素ごとに呼ぶ。

const SKIP = new Set(["HEAD", "STYLE", "SCRIPT", "NOSCRIPT", "TITLE", "META", "LINK", "TEMPLATE"]);

/** 要素のメトリクスを返す関数（ページ側で実行される。文字列化して callFunctionOn へ渡す）。 */
function metricsFn() {
  const r = this.getBoundingClientRect();
  const cs = getComputedStyle(this);
  const win = this.ownerDocument.defaultView;
  const visible =
    this.getClientRects().length > 0 && cs.visibility !== "hidden" && cs.display !== "none" && cs.opacity !== "0" &&
    r.bottom > 0 && r.top < win.innerHeight && r.right > 0 && r.left < win.innerWidth;
  return {
    visible,
    scrollWidth: this.scrollWidth,
    clientWidth: this.clientWidth,
    overflowX: cs.overflowX,
    display: cs.display,
    ellipsis: cs.textOverflow === "ellipsis",
    rect: [Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom)],
  };
}

/**
 * 文字を直接持つ要素を列挙する。
 * 返値: [{ text, tag, visible, metrics, fonts: [{ family, glyphs, custom }] }]
 * options.fonts: false にするとフォント取得を省く。 options.visibleOnly: 既定 true（画面外・非表示は除く）
 */
export async function collectTextElements(page, { fonts = true, visibleOnly = true } = {}) {
  const cdp = await page.createCDPSession();
  try {
    await cdp.send("DOM.enable");
    await cdp.send("CSS.enable");
    const { root } = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
    const targets = [];
    (function walk(node) {
      if (!node) return;
      if (node.nodeType === 1 && !SKIP.has(node.nodeName)) {
        const text = (node.children ?? []).filter((c) => c.nodeType === 3).map((c) => c.nodeValue).join(" ").replace(/\s+/g, " ").trim();
        if (text) targets.push({ nodeId: node.nodeId, tag: node.nodeName.toLowerCase(), text });
      }
      if (node.nodeType === 1 && SKIP.has(node.nodeName)) return;
      for (const child of node.children ?? []) if (child.nodeType === 1 || child.nodeType === 9) walk(child);
      for (const shadow of node.shadowRoots ?? []) walk(shadow);
      if (node.contentDocument) walk(node.contentDocument);
    })(root);

    const out = [];
    for (const target of targets) {
      let metrics = null;
      try {
        const { object } = await cdp.send("DOM.resolveNode", { nodeId: target.nodeId });
        const result = await cdp.send("Runtime.callFunctionOn", { objectId: object.objectId, functionDeclaration: metricsFn.toString(), returnByValue: true });
        metrics = result.result?.value ?? null;
        await cdp.send("Runtime.releaseObject", { objectId: object.objectId }).catch(() => {});
      } catch {
        continue; // 取得の間に消えた要素は無視
      }
      if (!metrics) continue;
      if (visibleOnly && !metrics.visible) continue;
      let used = [];
      if (fonts) {
        try {
          const res = await cdp.send("CSS.getPlatformFontsForNode", { nodeId: target.nodeId });
          used = (res.fonts ?? []).map((f) => ({ family: f.familyName, glyphs: f.glyphCount, custom: !!f.isCustomFont }));
        } catch {
          used = [];
        }
      }
      out.push({ ...target, visible: metrics.visible, metrics, fonts: used });
    }
    return out;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** 水平方向のはみ出し（省略表示を含む）があるか。スクロール容器は意図的なので除く。 */
export function overflowOf(metrics) {
  if (!metrics) return null;
  if (metrics.display === "inline") return null;
  if (metrics.overflowX === "auto" || metrics.overflowX === "scroll") return null;
  // sr-only（1px 角に畳んだ読み上げ専用要素）は見えないので、はみ出しとして数えない
  const [left, top, right, bottom] = metrics.rect ?? [];
  if ([left, top, right, bottom].every(Number.isFinite) && (right - left <= 1 || bottom - top <= 1)) return null;
  if (metrics.clientWidth > 0 && metrics.clientWidth <= 1) return null;
  if (metrics.clientWidth > 0 && metrics.scrollWidth > metrics.clientWidth + 1) {
    return `scrollWidth ${metrics.scrollWidth} > clientWidth ${metrics.clientWidth}${metrics.ellipsis ? "（text-overflow: ellipsis で省略表示）" : ""}`;
  }
  return null;
}
