"use strict";
// GHSA-gcqx-w48m-w2h4 の攻撃入力を、web-ext が実際に解決する依存へ渡す。
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { createRequire } = require("node:module");
const { pathToFileURL } = require("node:url");
const webExtRequire = createRequire(require.resolve("web-ext"));
const addonsRequire = createRequire(webExtRequire.resolve("addons-linter"));
const cjs = addonsRequire.resolve("deepmerge");

for (const [format, entry] of [["CJS", cjs], ["UMD", path.join(path.dirname(cjs), "umd.js")]]) {
  const merge = require(entry);
  const payload = () => JSON.parse('{"__proto__":{"admin":true},"normal":1}');

  test(`${format}: target自身の__proto__をコピーしても戻り値のprototypeを汚染しない`, () => {
    const result = merge(payload(), {});
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.admin, undefined);
    assert.equal(result.normal, 1);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
    assert.equal(result.__proto__.admin, true);
  });

  test(`${format}: null prototypeのtargetへ悪性sourceをマージしてもprototypeを汚染しない`, () => {
    const result = merge(Object.create(null), payload());
    assert.equal(Object.getPrototypeOf(result), Object.prototype);
    assert.equal(result.admin, undefined);
    assert.equal(Object.hasOwn(result, "__proto__"), true);
  });

  test(`${format}: ネストしたマージとclone:falseでもprototypeを汚染しない`, () => {
    const target = payload();
    const result = merge({ config: target }, { config: { enabled: true } });
    assert.equal(Object.getPrototypeOf(result.config), Object.prototype);
    assert.equal(result.config.admin, undefined);
    assert.equal(result.config.enabled, true);
    const unCloned = merge(target, {}, { clone: false });
    assert.equal(Object.getPrototypeOf(unCloned), Object.prototype);
    assert.equal(unCloned.admin, undefined);
    assert.equal(unCloned.__proto__, target.__proto__);
    assert.equal({}.admin, undefined);
  });

  test(`${format}: 通常のネスト・配列連結・非破壊cloneを維持する`, () => {
    const first = { nested: { a: 1 }, values: [{ a: 1 }] };
    const second = { nested: { b: 2 }, values: [{ b: 2 }] };
    const result = merge(first, second);
    assert.deepEqual(result, { nested: { a: 1, b: 2 }, values: [{ a: 1 }, { b: 2 }] });
    assert.notEqual(result.values[0], first.values[0]);
    assert.deepEqual(first, { nested: { a: 1 }, values: [{ a: 1 }] });
  });

  test(`${format}: symbolと書き換え可能なownデータ属性を維持する`, () => {
    const symbol = Symbol("metadata");
    const result = merge({ [symbol]: { a: 1 }, count: 1 }, { count: 2 });
    assert.deepEqual(result[symbol], { a: 1 });
    assert.deepEqual(Object.getOwnPropertyDescriptor(result, "count"), {
      value: 2, enumerable: true, configurable: true, writable: true,
    });
    result.count = 3;
    assert.equal(result.count, 3);
  });

  test(`${format}: customMerge・merge.all・clone:falseの契約を維持する`, () => {
    const custom = merge({ counts: { value: 1 } }, { counts: { value: 2 } }, {
      customMerge: key => key === "counts" ? (a, b) => ({ total: a.value + b.value }) : undefined,
    });
    assert.deepEqual(custom, { counts: { total: 3 } });
    assert.deepEqual(merge.all([{ a: 1 }, { b: 2 }, { a: 3 }]), { a: 3, b: 2 });
    const value = { a: 1 };
    assert.equal(merge({}, { value }, { clone: false }).value, value);
  });

  test(`${format}: 継承プロパティの既存フィルターを維持する`, () => {
    const target = Object.create({ inherited: 1 });
    target.own = 2;
    const result = merge(target, { inherited: 3, constructor: { prototype: { admin: true } } });
    assert.deepEqual(result, { own: 2 });
    assert.equal({}.admin, undefined);
  });
}

test("web-extのmultimatchがminimatch 11で包含・除外・隠しファイルを処理する", async () => {
  const { default: multimatch } = await import(pathToFileURL(webExtRequire.resolve("multimatch")).href);
  assert.deepEqual(multimatch(["a.js", "b.js", "b.txt", ".hidden.js"], ["*.js", "!b*"], { dot: true }), ["a.js", ".hidden.js"]);
  assert.deepEqual(multimatch(["src/a.js", "src/a.css"], ["src/**/*.js"]), ["src/a.js"]);
});

test("addons-linterのESLint設定がCJS/ESMともminimatch 11でinclude/excludeを評価する", async () => {
  const eslintRequire = createRequire(addonsRequire.resolve("eslint"));
  const configEntry = eslintRequire.resolve("@eslint/eslintrc");
  const { Legacy: esm } = await import(pathToFileURL(path.resolve(path.dirname(configEntry), "../lib/index.js")).href);
  const { Legacy: cjs } = eslintRequire("@eslint/eslintrc");
  for (const api of [cjs, esm]) {
    const configs = new api.ConfigArrayFactory().create({ overrides: [{
      files: ["**/*.js"], excludedFiles: ["**/excluded.js"], rules: { semi: "error" },
    }] }, { basePath: process.cwd() });
    assert.equal(configs.extractConfig(path.join(process.cwd(), "src/included.js")).rules.semi[0], "error");
    assert.equal(configs.extractConfig(path.join(process.cwd(), "src/excluded.js")).rules.semi, undefined);
    assert.equal(configs.extractConfig(path.join(process.cwd(), "src/other.css")).rules.semi, undefined);
  }
});

test("addons-linterのConfigArrayがCJS/ESMともminimatch 11で設定対象を評価する", async () => {
  const eslintRequire = createRequire(addonsRequire.resolve("eslint"));
  const entry = eslintRequire.resolve("@eslint/config-array");
  const esm = await import(pathToFileURL(path.resolve(path.dirname(entry), "../esm/index.js")).href);
  for (const { ConfigArray } of [eslintRequire("@eslint/config-array"), esm]) {
    const configs = new ConfigArray([{ files: ["**/*.js"], ignores: ["**/excluded.js"], value: 42 }], {
      basePath: process.cwd(), schema: { value: { merge: "replace", validate: "number" } },
    });
    await configs.normalize();
    assert.equal(configs.getConfig(path.join(process.cwd(), "src/included.js")).value, 42);
    assert.equal(configs.getConfig(path.join(process.cwd(), "src/excluded.js")), undefined);
    assert.equal(configs.getConfig(path.join(process.cwd(), "src/other.css")), undefined);
  }
});

test("web-extのFileFilterが実OSのパスで秘密ファイル・依存・成果物を除外する", async () => {
  const entry = path.join(path.dirname(require.resolve("web-ext")), "lib/util/file-filter.js");
  const { FileFilter } = await import(pathToFileURL(entry).href);
  for (const suffix of ["normal-source", "source [beta]"]) {
    const sourceDir = path.join(process.cwd(), suffix);
    const filter = new FileFilter({ sourceDir, artifactsDir: path.join(sourceDir, "web-ext-artifacts"),
      ignoreFiles: ["ignore-me/**", "!ignore-me/keep.js"],
    });
    for (const file of ["manifest.json", "src/content.js", "ignore-me/keep.js"]) {
      assert.equal(filter.wantFile(path.join(sourceDir, file)), true, `${suffix}: ${file}`);
    }
    for (const file of [".git/config", ".env", "node_modules/foo/index.js", "archive.xpi", "archive.zip", "web-ext-artifacts/output.js", "ignore-me/drop.js"]) {
      assert.equal(filter.wantFile(path.join(sourceDir, file)), false, `${suffix}: ${file}`);
    }
  }
});
