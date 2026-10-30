import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decryptText } from "../src/crypto.js";
import { loadConfig } from "../src/config.js";
import { createServer } from "../src/server.js";
import { fakeApi, KEY } from "./fake-api.js";

async function connect(env = {}) {
  const api = fakeApi();
  const config = loadConfig({ RBOT_API_URL: "http://127.0.0.1:9", RBOT_PUBLIC_KEY: KEY, ...env });
  const { server } = createServer({ config, fetchImpl: api.fetch });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  return { client, api };
}

const call = (client, name, args = {}) => client.callTool({ name, arguments: args });
const body = (result) => JSON.parse(result.content[0].text);

test("lista as ferramentas de sessão e de módulos", async () => {
  const { client } = await connect();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const name of ["rbot_login", "rbot_logout", "rbot_session", "rbot_describe", "rbot_crm", "rbot_billing"]) assert.ok(names.includes(name), name);
  assert.ok(!names.includes("rbot_internal"));
});

test("login cifra o corpo, guarda o token e as rotas usam Bearer", async () => {
  const { client, api } = await connect();
  const login = await call(client, "rbot_login", { email: "a@b.com", password: "segredo" });
  assert.equal(body(login).loggedIn, true);
  const sent = api.requests.find((r) => r.path === "/auth/login");
  assert.ok(sent.body.encrypted, "corpo cifrado");
  assert.deepEqual(JSON.parse(decryptText(sent.body.encrypted, KEY)), { email: "a@b.com", password: "segredo", remember: false });
  assert.ok(!JSON.stringify(sent.body).includes("segredo"));

  const res = await call(client, "rbot_crm", { operation: "GET /crm/deals/:id", params: { id: "d1" } });
  assert.equal(body(res).status, 200);
  const get = api.requests.at(-1);
  assert.equal(get.path, "/crm/deals/d1");
  assert.equal(get.headers.authorization, "Bearer token-1");

  const session = body(await call(client, "rbot_session"));
  assert.equal(session.loggedIn, true);
  assert.ok(!JSON.stringify(session).includes("token-1"), "token não aparece na saída");
});

test("sem login, rota de usuário pede rbot_login e não chama a API", async () => {
  const { client, api } = await connect();
  const res = await call(client, "rbot_crm", { operation: "GET /crm/stages" });
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /rbot_login/);
  assert.equal(api.requests.length, 0);
});

test("operação fora do catálogo e caminho malicioso são recusados", async () => {
  const { client, api } = await connect({ RBOT_EMAIL: "a@b.com", RBOT_PASSWORD: "segredo" });
  const unknown = await call(client, "rbot_crm", { operation: "GET /internal/socket/messages" });
  assert.equal(unknown.isError, true);
  const traversal = await call(client, "rbot_crm", { operation: "GET /crm/deals/:id", params: { id: "../../internal" } });
  assert.equal(traversal.isError, true);
  assert.ok(api.requests.every((r) => !r.path.includes("internal")));
});

test("sessão expirada renova com as credenciais do ambiente", async () => {
  const { client, api } = await connect({ RBOT_EMAIL: "a@b.com", RBOT_PASSWORD: "segredo" });
  await call(client, "rbot_crm", { operation: "GET /crm/stages" });
  api.expire();
  const res = await call(client, "rbot_crm", { operation: "GET /crm/stages" });
  assert.equal(body(res).status, 200);
  assert.equal(api.requests.filter((r) => r.path === "/auth/login").length, 2);
});

test("conta com 2FA pede o código e conclui com twoFactorCode", async () => {
  const { client, api } = await connect();
  api.enableTwoFactor();
  const first = body(await call(client, "rbot_login", { email: "a@b.com", password: "segredo" }));
  assert.equal(first.twoFactorRequired, true);
  const second = body(await call(client, "rbot_login", { twoFactorCode: "123456" }));
  assert.equal(second.loggedIn, true);
  const validate = api.requests.find((r) => r.path === "/auth/2fa/validate");
  assert.equal(JSON.parse(decryptText(validate.body.encrypted, KEY)).code, "123456");
});
