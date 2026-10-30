import { createRequire } from "node:module";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { RbotClient, summarizeUser } from "./client.js";
import { RbotError } from "./http.js";
import { SESSION_TOOLS, buildTools, toolName } from "./tools.js";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
export const defaultCatalog = require("./catalog.json");

const text = (value, maxChars) => {
  let out = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  if (out.length > maxChars) out = `${out.slice(0, maxChars)}\n[saída truncada em ${maxChars} caracteres]`;
  return { content: [{ type: "text", text: out }] };
};
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

export function createServer({ config, catalog = defaultCatalog, fetchImpl } = {}) {
  const client = new RbotClient(config, { fetchImpl });
  const { tools, routes } = buildTools(catalog);
  const allRoutes = catalog.modules.flatMap((mod) => mod.routes.filter((route) => route.exposed).map((route) => ({ ...route, tool: toolName(mod.name) })));
  const server = new Server({ name: "rbot", version: pkg.version }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [...SESSION_TOOLS, ...tools] }));

  const handlers = {
    rbot_login: async (args) => text(await client.login(args), config.maxOutputChars),
    rbot_logout: async () => text(await client.logout(), config.maxOutputChars),
    rbot_session: async () => text({ loggedIn: Boolean(client.token), user: summarizeUser(client.user), apiUrl: config.apiUrl }, config.maxOutputChars),
    rbot_describe: async ({ operation, search } = {}) => {
      if (operation) {
        const route = allRoutes.find((r) => r.id === String(operation).trim());
        if (!route) return failure(`Operação não encontrada: ${operation}`);
        return text(route, config.maxOutputChars);
      }
      const needle = String(search || "").toLowerCase();
      const list = allRoutes.filter((r) => !needle || r.id.toLowerCase().includes(needle)).map((r) => `${r.tool}: ${r.id}`);
      return text(list.join("\n") || "Nenhuma rota", config.maxOutputChars);
    },
  };

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;
    try {
      if (handlers[name]) return await handlers[name](args);
      const route = routes.get(`${name}::${args.operation}`);
      if (!route) return failure(`Operação desconhecida para ${name}: ${args.operation}`);
      const { status, data } = await client.call(route, args);
      const result = text({ status, response: data }, config.maxOutputChars);
      return status >= 400 ? { ...result, isError: true } : result;
    } catch (error) {
      if (error instanceof RbotError) return failure(error.message);
      return failure(`Erro inesperado: ${error.message}`);
    }
  });

  return { server, client };
}
