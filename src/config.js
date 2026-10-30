export const DEFAULTS = Object.freeze({
  apiUrl: "https://api.rbot.com.br/cs-services",
  adminUrl: "https://gestor.rbot.com.br",
  timeoutMs: 60000,
  maxResponseBytes: 2 * 1024 * 1024,
  maxOutputChars: 60000,
});

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function safeBaseUrl(value, label) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new Error(`${label} inválida`);
  }
  const local = LOCAL_HOSTS.has(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new Error(`${label} precisa usar https`);
  if (url.username || url.password) throw new Error(`${label} não pode conter usuário ou senha`);
  if (url.search || url.hash) throw new Error(`${label} não pode ter query nem fragmento`);
  return url.href.replace(/\/+$/, "");
}

const positive = (value, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

export function loadConfig(env = process.env) {
  return {
    apiUrl: safeBaseUrl(env.RBOT_API_URL || DEFAULTS.apiUrl, "RBOT_API_URL"),
    adminUrl: safeBaseUrl(env.RBOT_ADMIN_URL || DEFAULTS.adminUrl, "RBOT_ADMIN_URL"),
    email: env.RBOT_EMAIL || "",
    password: env.RBOT_PASSWORD || "",
    publicKey: env.RBOT_PUBLIC_KEY || "",
    timeoutMs: positive(env.RBOT_TIMEOUT_MS, DEFAULTS.timeoutMs),
    maxResponseBytes: positive(env.RBOT_MAX_RESPONSE_BYTES, DEFAULTS.maxResponseBytes),
    maxOutputChars: positive(env.RBOT_MAX_OUTPUT_CHARS, DEFAULTS.maxOutputChars),
  };
}
