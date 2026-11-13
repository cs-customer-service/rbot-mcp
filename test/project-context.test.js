import test from "node:test";
import assert from "node:assert/strict";
import { RbotClient, redactCredentials } from "../src/client.js";

const config = { apiUrl: "https://api.example", timeoutMs: 1000, maxResponseBytes: 10000 };

test("project switch adopts its token and keeps credentials out of tool results", async () => {
  const calls = [];
  const client = new RbotClient(config, { fetchImpl: async (url, options) => {
    calls.push(options.headers.Authorization);
    return Response.json({ data: url.endsWith("/switch") ? { token: "project-token", refreshToken: "secret", user: { id: "healtix" } } : { ok: true } });
  } });
  client.token = "main-token";
  const result = await client.call({ method: "POST", path: "/projects/:projectId/switch", auth: "user" }, { params: { projectId: "healtix" } });
  assert.equal(client.token, "project-token");
  assert.equal(client.user.id, "healtix");
  assert.equal(client.contextPath, "/projects/healtix/switch");
  assert.equal(result.data.data.token, undefined);
  await client.call({ method: "GET", path: "/agent", auth: "user" });
  assert.deepEqual(calls, ["Bearer main-token", "Bearer project-token"]);
  assert.deepEqual(redactCredentials({ nested: [{ token: "x", refreshToken: "y", ok: true }] }), { nested: [{ ok: true }] });
});

test("expired session restores the selected project before retrying", async () => {
  const client = new RbotClient({ ...config, email: "test@example.com", password: "test" });
  client.contextPath = "/projects/healtix/switch";
  client.login = async () => { client.token = "main"; return {}; };
  client._send = async (method, path) => {
    assert.equal(path, "/projects/healtix/switch");
    return { status: 200, data: { data: { token: "healtix", user: { id: "hx" } } } };
  };
  await client._ensureSession();
  assert.equal(client.token, "healtix");
  client.token = null;
  client._send = async () => ({ status: 403 });
  await assert.rejects(client._ensureSession(), /restore/);
  assert.equal(client.token, null);
});

test("knowledge imports require the selected project and update existing questions", async () => {
  const client = new RbotClient(config);
  client.token = "test";
  client.user = { project: { name: "Healtix" } };
  const calls = [];
  client.call = async (route, args) => {
    calls.push({ route, args });
    return { status: 200, data: { data: { knowledge: [{ _id: "existing", questionSummary: "Known" }] } } };
  };
  await assert.rejects(client.importKnowledge({ expectedProjectName: "Main", items: [{ question: "Q", answer: "A" }] }), /selected project/);
  assert.equal(calls.length, 0);
  const result = await client.importKnowledge({ expectedProjectName: "Healtix", items: [{ question: "Known", answer: "Updated" }, { question: "New", answer: "Answer" }] });
  assert.deepEqual(result.entries.map(entry => entry.operation), ["updated", "created"]);
  assert.equal(calls[1].args.params.knowledgeId, "existing");
  assert.equal(calls[1].route.encryptedBody, true);
  await assert.rejects(client.importKnowledge({ expectedProjectName: "Healtix", items: [{ question: "Q", answer: "" }] }), /valid knowledge/);
});
