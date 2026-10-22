"use strict";

// 実際に web-ext が解決する依存を、外部通信も秘密鍵の保存もせず検証する。
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const { createRequire } = require("node:module");
const webExtRequire = createRequire(require.resolve("web-ext"));
const adbRequire = createRequire(webExtRequire.resolve("@devicefarmer/adbkit"));
const forge = adbRequire("node-forge");
const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicExponent: 65537,
});
const key = forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" }));
const message = Buffer.from("node-forge security verification: synthetic input");
const digest = crypto.createHash("sha256").update(message).digest();
const asn1 = forge.asn1;
const sequence = (values) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.SEQUENCE, true, values);
const octets = (value) => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OCTETSTRING, false, value);
const oid = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.OID, false, asn1.oidToDer(forge.oids.sha256).getBytes());
const nullValue = () => asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "");

// 所有する一時鍵で署名し、DigestInfo の受理条件だけを実公開 API で確認する。
function signatureFor(algorithmValues, extraOuter = [], trailing = "") {
  const info = sequence([sequence(algorithmValues), octets(digest.toString("binary")), ...extraOuter]);
  const encoded = asn1.toDer(info).getBytes() + trailing;
  return crypto.privateEncrypt({ key: privateKey, padding: crypto.constants.RSA_PKCS1_PADDING }, Buffer.from(encoded, "binary")).toString("binary");
}

function rejects(signature) {
  try {
    return key.verify(digest.toString("binary"), signature) === false;
  } catch (error) {
    // 環境不足や API エラーを拒否成功に数えない。
    if (!/ASN\.1|DigestInfo|Unparsed DER bytes|padding/i.test(error.message)) throw error;
    return true;
  }
}

const cases = [
  ["SHA-1 / SHA-256 / SHA-512 の正常署名", () => {
    for (const algorithm of ["sha1", "sha256", "sha512"]) {
      const hash = crypto.createHash(algorithm).update(message).digest("binary");
      const signature = crypto.sign(algorithm, message, privateKey).toString("binary");
      assert.equal(key.verify(hash, signature), true);
    }
  }],
  ["NULL パラメーターあり・なしの正常 DigestInfo", () => {
    for (const fields of [[oid(), nullValue()], [oid()]]) {
      assert.equal(key.verify(digest.toString("binary"), signatureFor(fields)), true);
    }
  }],
  ["異なるメッセージは拒否", () => {
    const signature = crypto.sign("sha256", message, privateKey).toString("binary");
    assert.equal(key.verify(crypto.createHash("sha256").update("different message").digest("binary"), signature), false);
  }],
  ["入れ子の追加要素を拒否（NULL あり）", () => assert.equal(rejects(signatureFor([oid(), nullValue(), octets("canary")])), true)],
  ["入れ子の追加要素を拒否（NULL なし）", () => assert.equal(rejects(signatureFor([oid(), octets("canary")])), true)],
  ["入れ子の重複 NULL を拒否", () => assert.equal(rejects(signatureFor([oid(), nullValue(), nullValue()])), true)],
  ["内容を持つ不正な NULL を拒否", () => assert.equal(rejects(signatureFor([oid(), asn1.create(asn1.Class.UNIVERSAL, asn1.Type.NULL, false, "canary")])), true)],
  ["外側の追加要素を拒否", () => assert.equal(rejects(signatureFor([oid(), nullValue()], [octets("canary")])), true)],
  ["末尾の未消費データを拒否", () => assert.equal(rejects(signatureFor([oid(), nullValue()], [], "canary")), true)],
  ["RSA-PSS の正常署名", () => {
    const signature = crypto.sign("sha256", message, { key: privateKey, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: 32 });
    const scheme = forge.pss.create({ md: forge.md.sha256.create(), mgf: forge.mgf.mgf1.create(forge.md.sha256.create()), saltLength: 32 });
    assert.equal(key.verify(digest.toString("binary"), signature.toString("binary"), scheme), true);
  }],
];

let failures = 0;
for (const [name, verify] of cases) {
  try { verify(); console.log(`PASS ${name}`); }
  catch (error) { failures++; console.error(`FAIL ${name}: ${error.message}`); }
}
console.log(`node-forge security: ${cases.length - failures}/${cases.length} passed`);
if (failures) process.exitCode = 1;
