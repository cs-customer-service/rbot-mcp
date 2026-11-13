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
    this.contextPath = null;
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
      this.contextPath = null;
    }
    return { loggedIn: false };
  }

  get canReauthenticate() {
    return Boolean(this.config.email && this.config.password);
  }

  async selectProject({ id, name } = {}) {
    const listing = await this.call({ method: "GET", path: "/projects", auth: "user" });
    const projects = listing.data?.data?.projects || [];
    const matches = projects.filter(project => (id ? project._id === id : true) && (name ? project.name === name : true));
    if ((!id && !name) || matches.length !== 1) throw new RbotError("Select exactly one project by ID or exact name");
    const project = matches[0];
    const result = await this.call({ method: "POST", path: "/projects/:projectId/switch", auth: "user", encryptedBody: true }, { params: { projectId: project._id }, body: {} });
    if (result.status !== 200) throw new RbotError("Could not select project", result.status);
    return { project: { id: project._id, name: project.name }, user: summarizeUser(this.user) };
  }

  async importKnowledge({ expectedProjectName, items } = {}) {
    await this._ensureSession();
    if (!expectedProjectName || this.user?.project?.name !== expectedProjectName) throw new RbotError("The selected project does not match expectedProjectName");
    if (!Array.isArray(items) || !items.length || items.length > 50 || items.some(item => typeof item.question !== "string" || !item.question.trim() || item.question.length > 2000 || typeof item.answer !== "string" || !item.answer.trim() || item.answer.length > 5000)) throw new RbotError("Provide 1 to 50 valid knowledge entries");
    const listing = await this.call({ method: "GET", path: "/collaborators/knowledge", auth: "user" }, { query: { page: 1, limit: 100 } });
    if (listing.status !== 200) throw new RbotError("Could not list knowledge", listing.status);
    const existing = listing.data?.data?.knowledge || [];
    const results = [];
    for (const item of items) {
      const previous = existing.find(entry => (entry.questionSummary || entry.originalQuestion) === item.question);
      const route = { method: previous ? "PUT" : "POST", path: previous ? "/collaborators/knowledge/:knowledgeId" : "/collaborators/knowledge", auth: "user", encryptedBody: true };
      const response = await this.call(route, { params: previous ? { knowledgeId: previous._id } : undefined, body: item });
      results.push({ question: item.question, operation: previous ? "updated" : "created", status: response.status, success: response.status >= 200 && response.status < 300 && response.data?.success !== false });
      if (response.status >= 400 || response.data?.success === false) break;
    }
    return { project: expectedProjectName, entries: results };
  }

  async _ensureSession() {
    if (this.token) return;
    if (!this.canReauthenticate) throw new RbotError("Sem sessão: chame rbot_login com email e senha");
    const result = await this.login();
    if (result.twoFactorRequired) throw new RbotError(result.message);
    if (this.contextPath) {
      const restored = await this._send("POST", this.contextPath, { body: {}, encrypt: true });
      if (restored.status !== 200 || !restored.data?.data?.token) {
        this.token = null;
        throw new RbotError("Could not restore the selected project", restored.status);
      }
      this._session(restored.data.data);
    }
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
    if (response.status === 200 && response.data?.data?.token && route.path.startsWith("/projects/")) {
      this._session(response.data.data);
      this.contextPath = route.path === "/projects/return-to-main" ? null : buildPath(route, params);
      response = { ...response, data: redactCredentials(response.data) };
    }
    return response;
  }
}

export function redactCredentials(value) {
  if (Array.isArray(value)) return value.map(redactCredentials);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["token", "refreshToken", "password", "credential"].includes(key)).map(([key, item]) => [key, redactCredentials(item)]));
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
