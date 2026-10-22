"use strict";

const crypto = require("node:crypto");

/** AMO の両コマンドで同じ短命 HS256 JWT を生成する。 */
function makeJWT(issuer, secret) {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: issuer,
    jti: crypto.randomBytes(16).toString("hex"),
    iat: now,
    exp: now + 60,
  })).toString("base64url");
  const data = `${header}.${payload}`;
  const signature = crypto.createHmac("sha256", secret).update(data).digest("base64url");
  return `${data}.${signature}`;
}

/** transport に触れず、既存の 429 待機・試行回数を共有する。 */
async function withRateLimitRetry(request) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const result = await request();
    if (result.status !== 429) return result;
    const detail = typeof result.body === "object" ? result.body?.detail : "";
    const match = /(\d+)\s*seconds?/i.exec(detail || "");
    const wait = (match ? parseInt(match[1], 10) : 30) + 5;
    console.log(`   ⏳ 429: ${wait}s 待機して retry (attempt=${attempt + 1})`);
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
  }
  throw new Error("429 が 5 回連続で続いたので断念");
}

module.exports = { makeJWT, withRateLimitRetry };
