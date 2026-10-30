import { encryptedBody } from "./crypto.js";
import { discoverPublicKey } from "./publicKey.js";
import { RbotError, buildPath, buildQuery, readBody } from "./http.js";

export class RbotClient {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
    this.token = null;
    this.user = null;
    this.pendingTwoFactor = null;
    this.publicKey = config.publicKey || null;
  }

  async _key() {
    if (!this.publicKey) this.publicKey = await discoverPublicKey(this.config.adminUrl, { fetchImpl: this.fetch });
    return this.publicKey;
  }

  async _send(method, path, { body, encrypt = false, auth = true } = {}) {
    const headers = { Accept: "application/json" };
    if (auth && this.token) headers.Authorization = `Bearer ${this.token}`;
    let payload;
    if (body !== undefined && method !== "GET") {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(encrypt ? encryptedBody(body, await this._key()) : body);
    }
    let res;
    try {
      res = await this.fetch(`${this.config.apiUrl}${path}`, {
        method,
        headers,
        body: payload,
        redirect: "error",
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new RbotError(`Falha de rede ao chamar ${method} ${path}: ${error.cause?.code || error.name}`);
    }
    return { status: res.status, data: await readBody(res, this.config.maxResponseBytes) };
  }

  async login({ email, password, twoFactorCode } = {}) {
    const fromEnv = !email && !password;
    const credentials = fromEnv ? { email: this.config.email, password: this.config.password } : { email, password };

    if (twoFactorCode && this.pendingTwoFactor && !email && !password) {
      const { status, data } = await this._send("POST", "/auth/2fa/validate", {
        body: { twoFactorToken: this.pendingTwoFactor, code: String(twoFactorCode) },
        encrypt: true,
        auth: false,
      });
      if (status !== 200 || !data?.data?.token) throw new RbotError(messageOf(data) || "Código de verificação inválido", status);
      this.pendingTwoFactor = null;
      return this._session(data.data);
    }

    if (!credentials.email || !credentials.password) throw new RbotError("Informe email e senha (ou defina RBOT_EMAIL e RBOT_PASSWORD)");
    const { status, data } = await this._send("POST", "/auth/login", {
      body: { email: String(credentials.email), password: String(credentials.password), remember: false },
      encrypt: true,
      auth: false,
    });
    if (status !== 200 || data?.success === false) throw new RbotError(messageOf(data) || "Credenciais inválidas", status);
    if (data?.data?.twoFactorRequired) {
      this.pendingTwoFactor = data.data.twoFactorToken;
      if (twoFactorCode) return this.login({ twoFactorCode });
      return { twoFactorRequired: true, message: "Conta com verificação em duas etapas: chame rbot_login com twoFactorCode" };
    }
    if (!data?.data?.token) throw new RbotError("O login não devolveu token", status);
    return this._session(data.data);
  }

  _session({ token, user }) {
    this.token = token;
    this.user = user || null;
    return { loggedIn: true, user: summarizeUser(user) };
  }

  async logout() {
    if (!this.token) return { loggedIn: false };
    try {
      await this._send("POST", "/auth/logout", { body: {}, encrypt: true });
    } finally {
      this.token = null;
      this.user = null;
    }
    return { loggedIn: false };
  }

  get canReauthenticate() {
    return Boolean(this.config.email && this.config.password);
  }

  async _ensureSession() {
    if (this.token) return;
    if (!this.canReauthenticate) throw new RbotError("Sem sessão: chame rbot_login com email e senha");
    const result = await this.login();
    if (result.twoFactorRequired) throw new RbotError(result.message);
  }

  /** Chama uma rota do catálogo. Só rotas do catálogo chegam aqui; o caminho é montado a partir dele. */
  async call(route, { params, query, body } = {}) {
    const path = `${buildPath(route, params)}${buildQuery(query)}`;
    const needsAuth = route.auth === "user";
    if (needsAuth) await this._ensureSession();
    const options = { body: route.method === "GET" ? undefined : body ?? (route.encryptedBody ? {} : undefined), encrypt: route.encryptedBody, auth: needsAuth };

    let response = await this._send(route.method, path, options);
    if (response.status === 401 && needsAuth) {
      this.token = null;
      if (!this.canReauthenticate) throw new RbotError("Sessão expirada: chame rbot_login de novo", 401);
      await this._ensureSession();
      response = await this._send(route.method, path, options);
    }
    return response;
  }
}

export const messageOf = (data) => (typeof data === "object" && data ? data.data?.message || data.message : null);

export function summarizeUser(user) {
  if (!user || typeof user !== "object") return null;
  const org = user.organization || user.organizationId;
  return {
    id: user.id || user._id,
    name: user.name,
    email: user.email,
    role: user.role,
    organization: org && typeof org === "object" ? { id: org.id || org._id, name: org.name } : org,
  };
}
