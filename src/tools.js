/*
 * Uma ferramenta por módulo do cs-services (rbot_crm, rbot_billing, ...), com o parâmetro `operation`
 * escolhendo a rota ("GET /crm/deals/:id"). Assim todas as rotas ficam acessíveis sem centenas de ferramentas.
 */
export const toolName = (moduleName) => `rbot_${moduleName.replace(/[^A-Za-z0-9]+/g, "_")}`.slice(0, 64);

const fieldsOf = (schema) => Object.keys(schema?.properties || {});

function operationLine(route) {
  const parts = [];
  for (const where of ["query", "body"]) {
    const fields = fieldsOf(route.input[where]);
    if (fields.length) parts.push(`${where}: ${fields.slice(0, 10).join(", ")}${fields.length > 10 ? ", ..." : ""}`);
  }
  if (route.params.length) parts.unshift(`params: ${route.params.join(", ")}`);
  if (route.permissions.length) parts.push(`permissão: ${route.permissions.join(" ")}`);
  return `- ${route.id}${parts.length ? ` (${parts.join("; ")})` : ""}`;
}

export function buildTools(catalog) {
  const tools = [];
  const routes = new Map();

  for (const mod of catalog.modules) {
    const exposed = mod.routes.filter((route) => route.exposed);
    if (!exposed.length) continue;
    const name = toolName(mod.name);
    for (const route of exposed) routes.set(`${name}::${route.id}`, route);
    const readOnly = exposed.every((route) => route.method === "GET");
    tools.push({
      name,
      title: `RBot ${mod.mount}`,
      description: [
        `Rotas ${mod.mount} da API do RBot (cs-services) com a sessão do usuário logado.`,
        "Escolha a rota em `operation`; `params` preenche :parâmetros, `query` vai na URL e `body` no corpo (GET não tem corpo).",
        "Use rbot_describe para ver o schema completo de entrada.",
        "Operações:",
        ...exposed.map(operationLine),
      ].join("\n"),
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: exposed.map((route) => route.id), description: "Método e caminho da rota" },
          params: { type: "object", description: "Valores dos :parâmetros do caminho", additionalProperties: { type: ["string", "number"] } },
          query: { type: "object", description: "Parâmetros de query string" },
          body: { description: "Corpo JSON (cifrado automaticamente quando a rota exige)" },
        },
        required: ["operation"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: readOnly,
        destructiveHint: exposed.some((route) => route.method === "DELETE"),
        openWorldHint: true,
      },
    });
  }
  return { tools, routes };
}

export const SESSION_TOOLS = [
  {
    name: "rbot_login",
    title: "Entrar no RBot",
    description: "Entra no RBot com email e senha do usuário. Sem argumentos, usa RBOT_EMAIL e RBOT_PASSWORD. Para conta com verificação em duas etapas, chame de novo só com twoFactorCode.",
    inputSchema: {
      type: "object",
      properties: {
        email: { type: "string", format: "email", maxLength: 255 },
        password: { type: "string", maxLength: 128 },
        twoFactorCode: { type: "string", maxLength: 12 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "rbot_logout",
    title: "Sair do RBot",
    description: "Encerra a sessão atual no RBot e apaga o token da memória.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
  },
  {
    name: "rbot_session",
    title: "Sessão atual",
    description: "Mostra se há sessão ativa, o usuário e a organização, sem chamar a API.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "rbot_describe",
    title: "Descrever rotas",
    description: "Lista as rotas disponíveis (filtro por texto) ou mostra o schema de entrada completo de uma operação.",
    inputSchema: {
      type: "object",
      properties: {
        operation: { type: "string", description: "Ex.: \"POST /crm/deals\"" },
        search: { type: "string", description: "Filtra rotas pelo texto do caminho" },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
];
