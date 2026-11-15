// 撮影前の操作と、Raindrop.io API の中立的な固定応答（vitrina 用）。
//
// popup はログイン後にブックマーク一覧を出す。実トークンも実アカウントも使わず、次の方法で再現する。
//  - ログイン済み状態: capture の storage にダミーのトークン風文字列（store-assets.json）を置く。
//  - API 応答: ブックマーク取得は拡張の Service Worker が行うため、ページ側の setRequestInterception では
//    捕まらない。SW ターゲットへ CDP（Fetch.enable）を張り、api.raindrop.io への要求を架空データで返す。
//  - favicon（Google Favicon Service）: popup ページ側の setRequestInterception で中立的な単色 SVG に差し替える。
// 実在サイト名・他社ロゴは使わない（ドメインは example.* のみ）。

/** 架空のブックマーク（title / link / domain）。ID は連番。 */
const BOOKMARKS = [
  ["Getting started guide", "docs.example.com"],
  ["Keyboard shortcuts guide", "docs.example.com"],
  ["Style guide for clear writing", "blog.example.org"],
  ["Weekly planning notes", "notes.example.net"],
  ["Color palette ideas", "design.example.org"],
  ["Responsive layout patterns", "design.example.org"],
  ["Typography basics", "type.example.com"],
  ["Spring trip checklist", "travel.example.net"],
  ["Packing guide for short trips", "travel.example.net"],
  ["Simple weeknight recipes", "kitchen.example.com"],
  ["Meeting notes template", "notes.example.net"],
  ["Project roadmap overview", "work.example.com"],
  ["Reading list for the quarter", "books.example.org"],
  ["Home office setup tips", "blog.example.org"],
].map(([title, domain], i) => ({ _id: 9000 + i, title, link: `https://${domain}/item-${i + 1}`, domain }));

/** コレクションごとの一覧（ID → ブックマークの添字）。0 は「すべて」。 */
const BY_COLLECTION = {
  1001: [12, 13, 3],
  1002: [4, 5, 6],
  1003: [7, 8],
  1004: [10, 11, 3],
  1005: [9],
};

/** ルート／子コレクション（Raindrop.io の /collections と /collections/childrens と同じ形）。 */
const ROOTS = [
  { _id: 1001, title: "Reading list", count: 24 },
  { _id: 1002, title: "Design references", count: 18 },
  { _id: 1003, title: "Travel plans", count: 9 },
  { _id: 1004, title: "Work", count: 31 },
  { _id: 1005, title: "Recipes", count: 14 },
];
const CHILDREN = [
  { _id: 1102, title: "Typography", count: 7, parent: { $id: 1002 } },
  { _id: 1103, title: "Color", count: 5, parent: { $id: 1002 } },
  { _id: 1104, title: "Meeting notes", count: 12, parent: { $id: 1004 } },
  { _id: 1105, title: "Project docs", count: 19, parent: { $id: 1004 } },
];

/** api.raindrop.io へのパスから架空の JSON を作る。未知のパスは 404。 */
function respondFor(urlString) {
  const url = new URL(urlString);
  const p = url.pathname;
  if (p === "/rest/v1/collections") return { items: ROOTS, result: true };
  if (p === "/rest/v1/collections/childrens") return { items: CHILDREN, result: true };
  const m = /^\/rest\/v1\/raindrops\/(\d+)$/.exec(p);
  if (m) {
    const id = Number(m[1]);
    const items = id === 0 ? BOOKMARKS : (BY_COLLECTION[id] ?? []).map((i) => BOOKMARKS[i]);
    return { items, count: items.length, result: true };
  }
  return null;
}

/** ドメイン文字列から色相を決め、中立的な角丸の単色 favicon を作る（他社ロゴを描かない）。 */
function faviconSvg(domain) {
  let h = 0;
  for (const ch of domain) h = (h * 31 + ch.charCodeAt(0)) % 360;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="1" y="1" width="14" height="14" rx="4" fill="hsl(${h} 55% 52%)"/><rect x="4" y="4" width="8" height="8" rx="2" fill="rgba(255,255,255,.55)"/></svg>`;
}

/** SW に CDP の Fetch を張り、api.raindrop.io を固定応答にする。capture ごとに張り直す。 */
async function attachApiMock(session) {
  if (session.__apiMock) {
    await session.__apiMock.detach().catch(() => {});
    session.__apiMock = null;
  }
  const worker = await session.getWorker();
  const target = session.browser.targets().find((t) => t.type() === "service_worker" && t.url().startsWith(`chrome-extension://${session.extensionId}/`));
  if (!target) throw new Error("拡張の Service Worker ターゲットが見つかりません");
  void worker;
  const cdp = await target.createCDPSession();
  await cdp.send("Fetch.enable", { patterns: [{ urlPattern: "https://api.raindrop.io/*" }] });
  cdp.on("Fetch.requestPaused", (ev) => {
    const body = respondFor(ev.request.url);
    const headers = [
      { name: "Content-Type", value: "application/json; charset=utf-8" },
      { name: "Access-Control-Allow-Origin", value: "*" },
    ];
    cdp
      .send("Fetch.fulfillRequest", {
        requestId: ev.requestId,
        responseCode: body ? 200 : 404,
        responseHeaders: headers,
        body: Buffer.from(JSON.stringify(body ?? { result: false })).toString("base64"),
      })
      .catch(() => {});
  });
  session.__apiMock = cdp;
}

/** popup ページ側: favicon を中立 SVG へ、他の外部要求は従来どおり（解決不能）のままにする。 */
async function interceptFavicons(page) {
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (url.startsWith("https://www.google.com/s2/favicons")) {
      const domain = new URL(url).searchParams.get("domain") ?? "";
      return request.respond({ status: 200, contentType: "image/svg+xml", body: faviconSvg(domain) });
    }
    return request.continue();
  });
}

/** API モックと favicon 差し替えを入れて popup を再読込し、一覧の描画を待つ。 */
async function loadMocked({ page, session }) {
  await attachApiMock(session);
  await interceptFavicons(page);
  await page.reload({ waitUntil: "load" });
  await page.waitForSelector(".bookmark-item", { timeout: 15000 });
  // favicon の差し替え完了を待つ
  await page.waitForFunction(() => [...document.images].every((img) => img.complete), { timeout: 10000 });
}

export default {
  "popup-main": loadMocked,
  "popup-dark": loadMocked,
  // 検索: 実際に入力して絞り込む（デバウンス後に描画される）
  "popup-search": async (ctx) => {
    await loadMocked(ctx);
    await ctx.page.type("#search-input", "guide");
    await new Promise((r) => setTimeout(r, 700));
  },
  // 設定画面: 歯車を押してコレクションツリーを出す
  "popup-collections": async (ctx) => {
    await loadMocked(ctx);
    await ctx.page.click("#btn-settings");
    await ctx.page.waitForSelector(".collection-item", { timeout: 15000 });
    await new Promise((r) => setTimeout(r, 600));
  },
};
