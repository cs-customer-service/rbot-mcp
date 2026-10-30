import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseRouterFile, splitArgs } from "../scripts/lib/routes.js";
import { buildTools, SESSION_TOOLS } from "../src/tools.js";
import { defaultCatalog } from "../src/server.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const servicesDir = path.resolve(process.env.RBOT_SERVICES_DIR || path.join(here, "../../cs-services"));

test("separa argumentos respeitando parênteses, strings e comentários", () => {
  assert.deepEqual(splitArgs(`"/a", f(b, "c,)"), [d, e], /* x, y */ g`), [`"/a"`, `f(b, "c,)")`, "[d, e]", "g"]);
});

test("lê rotas, middlewares, prefixo e rotas criadas em laço", () => {
  const source = `
    import * as S from "#src/routers/api/x/schemas";
    import { a as b } from "#src/y";
    const COLLECTIONS = { contacts: { perm: P.c, create: S.createContact }, deals: { perm: P.d, create: S.createDeal } };
    router.get("/stages", authenticateToken, requireAnyPermission("crm.deals"), handle(() => 1));
    // router.get("/comentado", x);
    for (const [collection, cfg] of Object.entries(COLLECTIONS)) {
      router.post(\`/\${collection}\`, authenticateToken, requestBodyDecryptor, validateSchema(cfg.create), handle(() => 2));
    }
    export default (app) => { app.use("/crm", rateLimiter, router); };`;
  const parsed = parseRouterFile(source);
  assert.equal(parsed.mount, "/crm");
  assert.deepEqual(parsed.routes.map((r) => `${r.method} ${r.path}`), ["GET /stages", "POST /contacts", "POST /deals"]);
  assert.deepEqual(parsed.routes[2].middleware.find((m) => m.name === "validateSchema").args, ["S.createDeal"]);
  assert.equal(parsed.imports.S.namespace, true);
  assert.equal(parsed.imports.b.name, "a");
});

test("o catálogo cobre todas as rotas do cs-services e só expõe as de usuário e as públicas permitidas", { skip: !fs.existsSync(path.join(servicesDir, "src/routers/api")) && "cs-services ausente" }, async () => {
  const { buildCatalog } = await import("../scripts/generate-catalog.js");
  const fresh = await buildCatalog(servicesDir);
  const ids = (catalog) => catalog.modules.flatMap((m) => m.routes.map((r) => r.id)).sort();
  assert.deepEqual(ids(fresh), ids(defaultCatalog), "src/catalog.json está desatualizado: rode npm run catalog");

  const all = fresh.modules.flatMap((m) => m.routes);
  for (const mod of fresh.modules) {
    const text = fs.readFileSync(path.join(servicesDir, "src/routers/api", mod.name, "_index.js"), "utf8");
    const declared = (text.match(/router\.(get|post|put|patch|delete)\(/g) || []).length;
    assert.ok(mod.routes.length >= declared, `${mod.name}: ${declared} declaradas, ${mod.routes.length} no catálogo`);
  }
  const userHidden = all.filter((r) => r.auth === "user" && !r.exposed);
  assert.ok(userHidden.every((r) => /^use rbot_/.test(r.hiddenReason)), `rota de usuário sem ferramenta: ${userHidden.map((r) => r.id)}`);
  assert.ok(all.filter((r) => r.auth === "service" || r.auth === "apikey").every((r) => !r.exposed), "token de serviço e API key ficam fora");
  assert.ok(all.filter((r) => r.path.startsWith("/internal") || r.path.startsWith("/devops")).every((r) => !r.exposed));
});

test("ferramentas têm nomes válidos e todas as rotas expostas", () => {
  const { tools, routes } = buildTools(defaultCatalog);
  const exposed = defaultCatalog.modules.flatMap((m) => m.routes.filter((r) => r.exposed));
  assert.equal(routes.size, exposed.length);
  const names = [...SESSION_TOOLS, ...tools].map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const name of names) assert.match(name, /^[A-Za-z0-9_-]{1,64}$/);
  const crm = tools.find((t) => t.name === "rbot_crm");
  assert.ok(crm.inputSchema.properties.operation.enum.includes("POST /crm/deals"));
  assert.equal(tools.find((t) => t.name === "rbot_internal"), undefined);
});
