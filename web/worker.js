// raindropshortcuts.kagayoi.com のランディングページ配信 Worker。
// 拡張機能の配布そのものは Chrome ウェブストア / Firefox AMO が担うため、
// この Worker は LP と付属静的素材だけを返し、未知のパスは 404 を返す。
import landingHtml from "./index.html";
import privacyHtml from "./privacy.html";
import styles from "./styles.css";
import script from "./script.js";
import robots from "./robots.txt";
import sitemap from "./sitemap.xml";
import popupShot from "./popup.png";

const securityHeaders = {
  "content-security-policy": "default-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; img-src 'self' data:; object-src 'none'; script-src 'self'; style-src 'self'",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
};

const staticAssets = new Map([
  ["/", { body: landingHtml, contentType: "text/html; charset=utf-8", cache: "public, max-age=300" }],
  ["/index.html", { body: landingHtml, contentType: "text/html; charset=utf-8", cache: "public, max-age=300" }],
  ["/privacy", { body: privacyHtml, contentType: "text/html; charset=utf-8", cache: "public, max-age=300" }],
  ["/privacy.html", { body: privacyHtml, contentType: "text/html; charset=utf-8", cache: "public, max-age=300" }],
  ["/styles.css", { body: styles, contentType: "text/css; charset=utf-8", cache: "public, max-age=86400" }],
  ["/script.js", { body: script, contentType: "text/javascript; charset=utf-8", cache: "public, max-age=86400" }],
  ["/robots.txt", { body: robots, contentType: "text/plain; charset=utf-8", cache: "public, max-age=86400" }],
  ["/sitemap.xml", { body: sitemap, contentType: "application/xml; charset=utf-8", cache: "public, max-age=86400" }],
  ["/popup.png", { body: popupShot, contentType: "image/png", cache: "public, max-age=86400" }],
]);

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const asset = staticAssets.get(url.pathname);

    if (asset) {
      if (request.method !== "GET" && request.method !== "HEAD") {
        return new Response("Method Not Allowed", {
          status: 405,
          headers: { ...securityHeaders, allow: "GET, HEAD" },
        });
      }
      return new Response(request.method === "HEAD" ? null : asset.body, {
        headers: {
          ...securityHeaders,
          "cache-control": asset.cache,
          "content-type": asset.contentType,
        },
      });
    }

    return new Response("Not Found", {
      status: 404,
      headers: { ...securityHeaders, "content-type": "text/plain; charset=utf-8" },
    });
  },
};
