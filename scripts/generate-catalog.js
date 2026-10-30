#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseRouterFile, pathParams } from "./lib/routes.js";
import { zodToJson } from "./lib/zod-json.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const AUTH_MIDDLEWARE = { authenticateToken: "user", serviceAuthMiddleware: "service", authenticateApiKey: "apikey" };
const PERMISSION_MIDDLEWARE = new Set(["requireRole", "requirePermission", "requireAnyPermission", "requireOrganization"]);
const HIDDEN_MODULES = {
  devops: "rotas de infraestrutura, sem login de usuário",
  internal: "uso interno entre serviços (x-service-token)",
  "app-login": "confirmação de login do app desktop (cs-app-services)",
};

const HIDDEN_ROUTES = {
  "POST /auth/login": "use rbot_login",
  "POST /auth/2fa/validate": "use rbot_login com twoFactorCode",
  "POST /auth/refresh": "o servidor MCP renova a sessão sozinho",
  "POST /auth/logout": "use rbot_logout",
  "GET /auth/external-login/webhook/:origin/:identifier": "webhook chamado por sistemas externos",
  "POST /auth/external-login/confirm": "fluxo de login externo de outro sistema",
  "POST /external-connections/webhook/:databaseId": "webhook chamado pela Evolution API",
  "GET /meta/webhook/:connectionId": "webhook chamado pela Meta",
  "POST /meta/webhook/:connectionId": "webhook chamado pela Meta",
};

const joinPath = (mount, sub) => {
  const full = `${mount}${sub === "/" ? "" : sub}`;
  return full.replace(/\/+/g, "/") || "/";
};

export async function buildCatalog(servicesDir) {
  globalThis.Universal ??= { log() {}, info() {}, warn() {}, error() {}, debug() {} };
  const apiDir = path.join(servicesDir, "src/routers/api");
  const modules = [];
  const schemaCache = new Map();

  const loadExport = async (fromFile, imports, expression) => {
    const [head, member] = String(expression).split(".");
    const imported = imports[head];
    if (!imported || (imported.namespace && !member)) return null;
    const ref = imported.namespace ? { module: imported.module, name: member } : imported;
    const file = ref.module.startsWith("#src/")
      ? path.join(servicesDir, "src", `${ref.module.slice(5)}.js`)
      : path.resolve(path.dirname(fromFile), ref.module.endsWith(".js") ? ref.module : `${ref.module}.js`);
    if (!fs.existsSync(file)) return null;
    if (!schemaCache.has(file)) schemaCache.set(file, await import(pathToFileURL(file).href).catch(() => ({})));
    return schemaCache.get(file)[ref.name] ?? null;
  };

  for (const name of fs.readdirSync(apiDir).sort()) {
    const file = path.join(apiDir, name, "_index.js");
    if (name.startsWith(".") || !fs.existsSync(file)) continue;
    const parsed = parseRouterFile(fs.readFileSync(file, "utf8"));
    if (!parsed.mount) continue;
    const moduleAuth = parsed.routerUse.map((m) => AUTH_MIDDLEWARE[m.name]).find(Boolean);

    const routes = [];
    for (const route of parsed.routes) {
      const names = route.middleware.map((m) => m.name);
      const auth = names.map((n) => AUTH_MIDDLEWARE[n]).find(Boolean) || moduleAuth || "public";
      const input = {};
      for (const mw of route.middleware.filter((m) => m.name === "validateSchema")) {
        const location = (mw.args[1] || "'body'").replace(/["'`]/g, "");
        const schema = await loadExport(file, parsed.imports, mw.args[0]);
        if (schema?._def) input[location] = zodToJson(schema);
      }
      const permissions = route.middleware
        .filter((m) => PERMISSION_MIDDLEWARE.has(m.name) || parsed.constants[m.name])
        .map((m) => (parsed.constants[m.name] ? parsed.constants[m.name] : `${m.name}(${m.args.join(", ")})`));
      const fullPath = joinPath(parsed.mount, route.path);
      const hiddenReason = HIDDEN_MODULES[name] || HIDDEN_ROUTES[`${route.method} ${fullPath}`] || (auth === "service" ? "token de serviço" : auth === "apikey" ? "exige a API key de disparos, não o login" : null);
      routes.push({
        id: `${route.method} ${fullPath}`,
        method: route.method,
        path: fullPath,
        params: pathParams(fullPath),
        auth,
        encryptedBody: names.includes("requestBodyDecryptor"),
        permissions,
        input,
        exposed: !hiddenReason,
        ...(hiddenReason ? { hiddenReason } : {}),
      });
    }
    modules.push({ name, mount: parsed.mount, routes });
  }

  let commit = null;
  try {
    commit = execFileSync("git", ["-C", servicesDir, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch { /* fora de um repositório git */ }
  return { source: { repository: "cs-customer-service/cs-services", commit }, modules };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const servicesDir = path.resolve(process.env.RBOT_SERVICES_DIR || path.join(here, "../../cs-services"));
  const catalog = await buildCatalog(servicesDir);
  const out = path.join(here, "../src/catalog.json");
  fs.writeFileSync(out, `${JSON.stringify(catalog, null, 1)}\n`);
  const all = catalog.modules.flatMap((m) => m.routes);
  console.log(`${all.length} rotas em ${catalog.modules.length} módulos; ${all.filter((r) => r.exposed).length} expostas. Gravado em ${path.relative(process.cwd(), out)}`);
  process.exit(0);
}
