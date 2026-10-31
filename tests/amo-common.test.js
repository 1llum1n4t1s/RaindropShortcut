"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const { setImmediate } = require("node:timers/promises");
const { withRateLimitRetry } = require("../scripts/amo-common");

test("429 以外は成功・エラーとも待機せず元の応答を返す", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = t.mock.method(console, "log", () => {});
  for (const status of [200, 400, 500]) {
    const response = { status, body: { status } };
    const request = t.mock.fn(() => response);
    assert.strictEqual(await withRateLimitRetry(request), response);
    assert.equal(request.mock.callCount(), 1);
  }
  assert.equal(log.mock.callCount(), 0);
});

test("429 は指定秒数と既定秒数で再試行し、5 回目には待機しない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const log = t.mock.method(console, "log", () => {});
  const details = ["Expected available in 2 seconds", null, "1 second", "3 SECONDS", "53000 seconds"];
  const request = t.mock.fn(() => ({
    status: 429,
    body: { detail: details[request.mock.callCount()] },
  }));
  let settled = false;
  const rejected = assert.rejects(withRateLimitRetry(request), {
    message: "429 が 5 回連続で続いたので断念",
  }).then(() => { settled = true; });
  await setImmediate();

  for (const [index, seconds] of [7, 35, 6, 8].entries()) {
    assert.equal(request.mock.callCount(), index + 1);
    assert.equal(log.mock.calls[index].arguments[0],
      `   ⏳ 429: ${seconds}s 待機して retry (attempt=${index + 1})`);
    t.mock.timers.tick(seconds * 1000 - 1);
    await setImmediate();
    assert.equal(request.mock.callCount(), index + 1);
    t.mock.timers.tick(1);
    await setImmediate();
  }

  assert.equal(request.mock.callCount(), 5);
  assert.equal(log.mock.callCount(), 4);
  assert.equal(settled, true);
  await rejected;
});

test("429 後の成功応答を返し、それ以降のリクエストを行わない", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  t.mock.method(console, "log", () => {});
  const success = { status: 200, body: { ok: true } };
  const request = t.mock.fn(() => request.mock.callCount() === 0
    ? { status: 429, body: { detail: "1 second" } }
    : success);
  const result = withRateLimitRetry(request);
  await setImmediate();
  assert.equal(request.mock.callCount(), 1);
  t.mock.timers.tick(6000);
  assert.strictEqual(await result, success);
  t.mock.timers.runAll();
  assert.equal(request.mock.callCount(), 2);
});
