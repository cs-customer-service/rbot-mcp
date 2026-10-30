/*
 * Converte os schemas zod v3 do cs-services em JSON Schema simples, só para descrever as entradas das ferramentas.
 * A validação de verdade continua no cs-services.
 */
const MAX_DEPTH = 8;

export function zodToJson(schema, depth = 0) {
  const def = schema?._def;
  if (!def || depth > MAX_DEPTH) return {};
  const out = convert(schema, def, depth);
  if (def.description) out.description = def.description;
  return out;
}

function convert(schema, def, depth) {
  const next = (s) => zodToJson(s, depth + 1);
  switch (def.typeName) {
    case "ZodString": return withChecks({ type: "string" }, def.checks, { min: "minLength", max: "maxLength", length: "minLength" }, (c, o) => {
      if (c.kind === "email") o.format = "email";
      if (c.kind === "url") o.format = "uri";
      if (c.kind === "regex") o.pattern = c.regex.source;
      if (c.kind === "length") o.maxLength = c.value;
    });
    case "ZodNumber": return withChecks({ type: def.checks?.some((c) => c.kind === "int") ? "integer" : "number" }, def.checks, { min: "minimum", max: "maximum" });
    case "ZodBigInt": return { type: "integer" };
    case "ZodBoolean": return { type: "boolean" };
    case "ZodDate": return { type: "string", format: "date-time" };
    case "ZodLiteral": return { const: def.value };
    case "ZodEnum": return { type: "string", enum: [...def.values] };
    case "ZodNativeEnum": return { enum: Object.values(def.values).filter((v) => typeof v !== "number" || !Object.values(def.values).includes(String(v))) };
    case "ZodArray": return withLimits({ type: "array", items: next(def.type) }, def);
    case "ZodSet": return { type: "array", uniqueItems: true, items: next(def.valueType) };
    case "ZodTuple": return { type: "array", prefixItems: def.items.map(next) };
    case "ZodRecord": return { type: "object", additionalProperties: next(def.valueType) };
    case "ZodMap": return { type: "object" };
    case "ZodObject": {
      const shape = typeof def.shape === "function" ? def.shape() : def.shape;
      const properties = {};
      const required = [];
      for (const [key, value] of Object.entries(shape || {})) {
        properties[key] = next(value);
        if (!isOptional(value)) required.push(key);
      }
      const out = { type: "object", properties };
      if (required.length) out.required = required;
      if (def.unknownKeys === "strict") out.additionalProperties = false;
      return out;
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": return { anyOf: [...(def.options?.values?.() ?? def.options)].map(next) };
    case "ZodIntersection": return { allOf: [next(def.left), next(def.right)] };
    case "ZodOptional": return next(def.innerType);
    case "ZodNullable": return { anyOf: [next(def.innerType), { type: "null" }] };
    case "ZodDefault": {
      const out = next(def.innerType);
      try { out.default = def.defaultValue(); } catch { /* default dinâmico */ }
      return out;
    }
    case "ZodCatch":
    case "ZodReadonly":
    case "ZodBranded": return next(def.innerType ?? def.type);
    case "ZodEffects": return next(def.schema);
    case "ZodPipeline": return next(def.in);
    case "ZodLazy": return depth >= MAX_DEPTH ? {} : next(def.getter());
    default: return {};
  }
}

function isOptional(schema) {
  try {
    return schema.isOptional();
  } catch {
    return false;
  }
}

function withChecks(out, checks = [], keys, extra) {
  for (const check of checks) {
    if (keys[check.kind] && typeof check.value === "number") out[keys[check.kind]] = check.value;
    extra?.(check, out);
  }
  return out;
}

function withLimits(out, def) {
  if (def.minLength) out.minItems = def.minLength.value;
  if (def.maxLength) out.maxItems = def.maxLength.value;
  return out;
}
