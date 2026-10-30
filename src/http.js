export class RbotError extends Error {
  constructor(message, status = null) {
    super(message);
    this.name = "RbotError";
    this.status = status;
  }
}

const PARAM_MAX = 200;

export function buildPath(route, params = {}) {
  if (params !== null && (typeof params !== "object" || Array.isArray(params))) throw new RbotError("params precisa ser um objeto");
  return route.path.replace(/:([A-Za-z_]\w*)/g, (_, name) => {
    const value = params?.[name];
    if (value === undefined || value === null || value === "") throw new RbotError(`Parâmetro obrigatório: params.${name}`);
    if (!["string", "number"].includes(typeof value)) throw new RbotError(`params.${name} precisa ser texto ou número`);
    const text = String(value);
    if (text.length > PARAM_MAX || text === "." || text === ".." || /[/\\\u0000-\u001f\u007f]/.test(text)) {
      throw new RbotError(`Parâmetro inválido: params.${name}`);
    }
    return encodeURIComponent(text);
  });
}

const scalar = (value, key) => {
  if (["string", "number", "boolean"].includes(typeof value)) return String(value);
  throw new RbotError(`query.${key} precisa ser texto, número ou booleano`);
};

export function buildQuery(query) {
  if (query === undefined || query === null) return "";
  if (typeof query !== "object" || Array.isArray(query)) throw new RbotError("query precisa ser um objeto");
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue;
    if (Array.isArray(value)) value.forEach((item) => search.append(key, scalar(item, key)));
    else search.set(key, scalar(value, key));
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

const MAX_BINARY_INLINE = 256 * 1024;

/** Lê o corpo até `limit` bytes. JSON vira objeto, texto vira string, binário vira { contentType, size, base64 }. */
export async function readBody(res, limit) {
  const chunks = [];
  let total = 0;
  let truncated = false;
  if (res.body?.getReader) {
    const reader = res.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > limit) {
        chunks.push(value.subarray(0, value.length - (total - limit)));
        truncated = true;
        await reader.cancel().catch(() => {});
        break;
      }
      chunks.push(value);
    }
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  const type = res.headers.get("content-type") || "";
  const note = `[resposta truncada em ${limit} bytes]`;
  if (/json/i.test(type)) {
    const text = buffer.toString("utf8");
    if (truncated) return `${text}\n${note}`;
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return text;
    }
  }
  if (!type || /^text\/|xml|csv|javascript/i.test(type)) {
    const text = buffer.toString("utf8");
    return truncated ? `${text}\n${note}` : text;
  }
  return {
    contentType: type,
    size: buffer.length,
    truncated,
    ...(buffer.length <= MAX_BINARY_INLINE ? { base64: buffer.toString("base64") } : { note: "binário grande demais para devolver inline" }),
  };
}
