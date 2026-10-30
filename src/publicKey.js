const KEY_PATTERN = /["'](cs-public-[A-Za-z0-9]{8,128})["']/g;
const CHUNK_PATTERN = /["'](\/_next\/static\/[A-Za-z0-9/_.\-~]+\.js)["']/g;
const MAX_CHUNKS = 80;
const MAX_BYTES = 6 * 1024 * 1024;

async function fetchText(url, { fetchImpl, timeoutMs }) {
  const res = await fetchImpl(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") || 0);
  if (length > MAX_BYTES) throw new Error("arquivo grande demais");
  const text = await res.text();
  return text.length > MAX_BYTES ? text.slice(0, MAX_BYTES) : text;
}

export async function discoverPublicKey(adminUrl, { fetchImpl = fetch, timeoutMs = 20000 } = {}) {
  const origin = new URL(adminUrl).origin;
  const html = await fetchText(`${adminUrl}/entrar`, { fetchImpl, timeoutMs });
  const chunks = [...new Set([...html.matchAll(CHUNK_PATTERN)].map((m) => m[1]))].slice(0, MAX_CHUNKS);
  const found = new Set([...html.matchAll(KEY_PATTERN)].map((m) => m[1]));

  for (const chunk of chunks) {
    if (found.size) break;
    const url = new URL(chunk, origin);
    if (url.origin !== origin) continue;
    try {
      const js = await fetchText(url.href, { fetchImpl, timeoutMs });
      for (const m of js.matchAll(KEY_PATTERN)) found.add(m[1]);
    } catch {
      /* chunk indisponível: tenta o próximo */
    }
  }

  if (found.size === 1) return [...found][0];
  if (found.size > 1) throw new Error("Mais de uma chave pública no painel; defina RBOT_PUBLIC_KEY");
  throw new Error("Chave pública do painel não encontrada; defina RBOT_PUBLIC_KEY");
}
