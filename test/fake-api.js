export const KEY = "cs-public-TesteChave123";

export function fakeApi() {
  const requests = [];
  let tokenCounter = 0;
  let valid = new Set();
  let twoFactor = false;

  const json = (status, data) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  const user = { id: "u1", name: "Teste", email: "a@b.com", role: "manager", organization: { id: "o1", name: "Org" } };
  const issue = () => {
    const token = `token-${++tokenCounter}`;
    valid.add(token);
    return json(200, { success: true, data: { token, user } });
  };

  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    const headers = Object.fromEntries(Object.entries(init.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: init.method || "GET", path: u.pathname, query: u.search, headers, body: init.body ? JSON.parse(init.body) : undefined };
    requests.push(req);

    if (req.path === "/auth/login") {
      if (twoFactor) return json(200, { success: true, data: { twoFactorRequired: true, twoFactorToken: "tf-1" } });
      return issue();
    }
    if (req.path === "/auth/2fa/validate") return issue();
    if (req.path === "/auth/logout") return json(200, { success: true, data: { message: "ok" } });

    const token = (headers.authorization || "").replace("Bearer ", "");
    if (!valid.has(token)) return json(401, { success: false, data: { message: "Sessão inválida" } });
    return json(200, { success: true, data: { content: { path: req.path } } });
  };

  return {
    fetch: fetchImpl,
    requests,
    expire: () => { valid = new Set(); },
    enableTwoFactor: () => { twoFactor = true; },
  };
}
