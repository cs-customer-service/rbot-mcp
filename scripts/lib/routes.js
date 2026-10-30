
const METHODS = ["get", "post", "put", "patch", "delete"];

export function matchParen(text, start) {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (ch === "/" && next === "/") { i = text.indexOf("\n", i); if (i < 0) return -1; continue; }
    if (ch === "/" && next === "*") { i = text.indexOf("*/", i + 2) + 1; if (i <= 0) return -1; continue; }
    if (ch === "\"" || ch === "'" || ch === "`") { i = skipString(text, i); if (i < 0) return -1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function skipString(text, start) {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") { i++; continue; }
    if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
      const end = matchParen(text, i + 1);
      if (end < 0) return -1;
      i = end;
      continue;
    }
    if (text[i] === quote) return i;
  }
  return -1;
}

export function splitArgs(inner) {
  const args = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < inner.length; i++) {
    const ch = inner[i];
    if (ch === "\"" || ch === "'" || ch === "`") {
      const end = skipString(inner, i);
      current += inner.slice(i, end + 1);
      i = end;
      continue;
    }
    if (ch === "/" && inner[i + 1] === "/") { const end = inner.indexOf("\n", i); i = end < 0 ? inner.length : end; continue; }
    if (ch === "/" && inner[i + 1] === "*") { i = inner.indexOf("*/", i + 2) + 1; continue; }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if (ch === ")" || ch === "]" || ch === "}") depth--;
    if (ch === "," && depth === 0) { args.push(current.trim()); current = ""; continue; }
    current += ch;
  }
  if (current.trim()) args.push(current.trim());
  return args;
}

const stringLiteral = (arg) => {
  const m = /^(["'`])([^"'`$]*)\1$/.exec(arg || "");
  return m ? m[2] : null;
};

function calls(text, pattern) {
  const found = [];
  const re = new RegExp(pattern, "g");
  let m;
  while ((m = re.exec(text))) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close < 0) continue;
    found.push({ match: m, args: splitArgs(text.slice(open + 1, close)), end: close });
    re.lastIndex = close;
  }
  return found;
}

export function describeMiddleware(expr) {
  const m = /^([A-Za-z_$][\w$.]*)\s*\(/.exec(expr);
  if (!m) return { name: expr, args: [] };
  const open = expr.indexOf("(");
  const close = matchParen(expr, open);
  return { name: m[1], args: splitArgs(expr.slice(open + 1, close)) };
}

export function objectEntries(text, name) {
  const m = new RegExp(`const\\s+${name}\\s*=\\s*\\{`).exec(text);
  if (!m) return null;
  return entriesOf(text.slice(m.index + m[0].length - 1));
}

function entriesOf(objectText) {
  const close = matchParen(objectText, 0);
  if (close < 0) return null;
  const entries = {};
  for (const part of splitArgs(objectText.slice(1, close))) {
    const kv = /^["']?([\w$-]+)["']?\s*:\s*([\s\S]+)$/.exec(part);
    if (kv) entries[kv[1]] = kv[2].trim();
  }
  return entries;
}

function expandLoopRoute(text, index, method, args) {
  const loops = [...text.slice(0, index).matchAll(/for\s*\(\s*const\s*\[\s*(\w+)\s*,\s*(\w+)\s*\]\s*of\s+Object\.entries\(\s*(\w+)\s*\)\s*\)/g)];
  const loop = loops.at(-1);
  const template = /^`([^`]*)`$/.exec(args[0] || "")?.[1];
  if (!loop || template === undefined) return [];
  const [, keyVar, cfgVar, objectName] = loop;
  const entries = objectEntries(text, objectName) || {};
  return Object.entries(entries).map(([key, value]) => {
    const fields = value.startsWith("{") ? entriesOf(value) || {} : {};
    const substitute = (expr) => expr.replace(new RegExp(`\\b${cfgVar}\\.(\\w+)`, "g"), (all, field) => fields[field] ?? all);
    return {
      method: method.toUpperCase(),
      path: template.replaceAll(`\${${keyVar}}`, key),
      middleware: args.slice(1, -1).map((arg) => describeMiddleware(substitute(arg))),
    };
  }).filter((route) => !route.path.includes("${"));
}

export function parseRouterFile(text) {
  const routes = calls(text, `\\brouter\\.(${METHODS.join("|")})\\s*\\(`).flatMap(({ match, args }) => {
    const path = stringLiteral(args[0]);
    if (path === null) return expandLoopRoute(text, match.index, match[1], args);
    return [{
      method: match[1].toUpperCase(),
      path,
      middleware: args.slice(1, -1).map(describeMiddleware),
    }];
  });

  const routerUse = calls(text, "\\brouter\\.use\\s*\\(").flatMap(({ args }) => args.map(describeMiddleware));
  const mounts = calls(text, "\\bapp\\.use\\s*\\(").map(({ args }) => stringLiteral(args[0])).filter(Boolean);

  const constants = {};
  for (const m of text.matchAll(/const\s+([A-Za-z_$][\w$]*)\s*=\s*(require[A-Za-z]*\s*\()/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close > 0) constants[m[1]] = text.slice(m.index + m[0].length - m[2].length, close + 1);
  }

  return { mount: mounts[0] || null, routes, routerUse, constants, imports: parseImports(text) };
}

export function parseImports(text) {
  const map = {};
  for (const m of text.matchAll(/import\s*\*\s*as\s+([\w$]+)\s+from\s*["']([^"']+)["']/g)) {
    map[m[1]] = { module: m[2], namespace: true };
  }
  for (const m of text.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    for (const part of m[1].split(",")) {
      const [name, alias] = part.trim().split(/\s+as\s+/);
      if (name) map[(alias || name).trim()] = { module: m[2], name: name.trim() };
    }
  }
  return map;
}

export const pathParams = (path) => [...path.matchAll(/:([A-Za-z_][\w]*)/g)].map((m) => m[1]);
