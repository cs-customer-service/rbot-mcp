import test from "node:test";
import assert from "node:assert/strict";
import CryptoJS from "crypto-js";
import { decryptText, encryptText, encryptedBody } from "../src/crypto.js";
import { safeBaseUrl, loadConfig } from "../src/config.js";
import { buildPath, buildQuery, readBody, RbotError } from "../src/http.js";
import { discoverPublicKey } from "../src/publicKey.js";

const KEY = "cs-public-TesteChave123";

test("cifra no mesmo formato do CryptoJS usado pelo cs-admin e pelo cs-services", () => {
  const cipher = encryptText(JSON.stringify({ a: 1, texto: "ação" }), KEY);
  const plain = CryptoJS.AES.decrypt(cipher, KEY).toString(CryptoJS.enc.Utf8);
  assert.deepEqual(JSON.parse(plain), { a: 1, texto: "ação" });

  const fromCryptoJs = CryptoJS.AES.encrypt("olá", KEY).toString();
  assert.equal(decryptText(fromCryptoJs, KEY), "olá");
  assert.notEqual(encryptText("x", KEY), encryptText("x", KEY), "sal aleatório a cada chamada");
  assert.deepEqual(Object.keys(encryptedBody({}, KEY)), ["encrypted"]);
});

test("URLs base exigem https, exceto na própria máquina", () => {
  assert.equal(safeBaseUrl("https://api.rbot.com.br/cs-services/", "x"), "https://api.rbot.com.br/cs-services");
  assert.equal(safeBaseUrl("http://127.0.0.1:3700", "x"), "http://127.0.0.1:3700");
  assert.throws(() => safeBaseUrl("http://api.rbot.com.br", "x"), /https/);
  assert.throws(() => safeBaseUrl("https://u:p@api.rbot.com.br", "x"), /usuário/);
  assert.throws(() => safeBaseUrl("https://api.rbot.com.br/?a=1", "x"), /query/);
  assert.throws(() => safeBaseUrl("ftp://x", "x"), /https/);
  assert.equal(loadConfig({}).apiUrl, "https://api.rbot.com.br/cs-services");
});

test("parâmetros de caminho são codificados e não permitem sair da rota", () => {
  const route = { path: "/crm/deals/:id/notes" };
  assert.equal(buildPath(route, { id: "abc 1" }), "/crm/deals/abc%201/notes");
  assert.equal(buildPath(route, { id: 42 }), "/crm/deals/42/notes");
  for (const bad of ["..", ".", "a/b", "a\\b", "a\nb", "", { x: 1 }]) {
    assert.throws(() => buildPath(route, { id: bad }), RbotError, `deveria recusar ${JSON.stringify(bad)}`);
  }
  assert.throws(() => buildPath(route, {}), /params.id/);
  assert.equal(buildPath(route, { id: "%2e%2e" }), "/crm/deals/%252e%252e/notes");
});

test("query aceita escalares e listas", () => {
  assert.equal(buildQuery({ page: 2, q: "a&b", on: true, skip: null, ids: ["1", "2"] }), "?page=2&q=a%26b&on=true&ids=1&ids=2");
  assert.equal(buildQuery(undefined), "");
  assert.throws(() => buildQuery({ a: { b: 1 } }), RbotError);
  assert.throws(() => buildQuery([1]), RbotError);
});

test("leitura da resposta respeita o limite de bytes", async () => {
  const big = new Response("x".repeat(5000), { headers: { "content-type": "text/plain" } });
  const out = await readBody(big, 100);
  assert.ok(out.startsWith("x".repeat(100)));
  assert.match(out, /truncada em 100 bytes/);

  const json = await readBody(new Response(JSON.stringify({ ok: 1 }), { headers: { "content-type": "application/json" } }), 1000);
  assert.deepEqual(json, { ok: 1 });

  const bin = await readBody(new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "application/pdf" } }), 1000);
  assert.deepEqual(bin, { contentType: "application/pdf", size: 3, truncated: false, base64: "AQID" });
});

test("descobre a chave pública só em scripts do mesmo domínio do painel", async () => {
  const pages = {
    "https://gestor.example.com/entrar": `<script src="/_next/static/chunks/a.js"></script><script src="https://evil.example.com/_next/static/x.js"></script>`,
    "https://gestor.example.com/_next/static/chunks/a.js": `const k="${KEY}";`,
  };
  const requested = [];
  const fetchImpl = async (url) => {
    requested.push(String(url));
    if (!(url in pages)) return new Response("", { status: 404 });
    return new Response(pages[url], { headers: { "content-type": "text/html" } });
  };
  assert.equal(await discoverPublicKey("https://gestor.example.com", { fetchImpl }), KEY);
  assert.ok(requested.every((url) => url.startsWith("https://gestor.example.com/")));

  const empty = async () => new Response("<html></html>", { headers: { "content-type": "text/html" } });
  await assert.rejects(discoverPublicKey("https://gestor.example.com", { fetchImpl: empty }), /RBOT_PUBLIC_KEY/);
});
