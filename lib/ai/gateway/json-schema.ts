/**
 * JSON Schema dialect adaptation.
 *
 * Every provider claims to take JSON Schema and every provider takes a
 * different subset. Rather than shape each schema for one provider at its
 * definition site — which is how `dora/fill/schema.ts`, `schema-gaeb.ts` and
 * `edit-v2.ts` each ended up Gemini-flavoured in a different way — schemas are
 * written once in the honest dialect and translated here, at the boundary.
 *
 * The two dialects we serve, both established by running real schemas against
 * the real providers:
 *
 * - **gemini** — `responseJsonSchema` accepts only a small OpenAPI subset.
 *   Validation-only keywords (`minLength`, `maxItems`, …) are an
 *   INVALID_ARGUMENT, so they are dropped. Zod still enforces them server-side.
 *
 * - **openai-strict** — `response_format: { type: "json_schema", strict: true }`
 *   demands `additionalProperties: false` and, crucially, that `required`
 *   lists *every* key in `properties`. Probe P7 against gpt-5.6-luna:
 *
 *     "Invalid schema for response_format 'probe_schema': In context=(),
 *      'required' is required to be supplied and to be an array including
 *      every key in properties. Missing 'b'."
 *
 * The consequence of that rule is the subtle part, and rule 4 below exists
 * entirely to handle it.
 */

export type SchemaDialect = "gemini" | "openai-strict";

/** Keywords Gemini's response-schema validator accepts. */
const GEMINI_KEYS = new Set([
  "type",
  "format",
  "description",
  "nullable",
  "enum",
  "items",
  "properties",
  "required",
]);

/**
 * Keywords that describe the document rather than constrain it. Stripped for
 * every dialect: providers either reject them or ignore them, and Zod is the
 * real contract in both cases.
 */
const METADATA_KEYS = new Set(["$schema", "$comment", "default"]);

/** Value-range keywords. Accepted by Azure strict mode (probe P7), but
 * `AI_AZURE_SCHEMA_STRIP_BOUNDS=true` removes them if a future model objects. */
const BOUNDS_KEYS = new Set([
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minItems",
  "maxItems",
  "uniqueItems",
]);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Add `"null"` to a schema's accepted types.
 *
 * Strict mode has no way to say "this key may be absent", only "this key is
 * present and may be null". So a property the product treats as optional has
 * to be widened as it is forced into `required` — otherwise the schema tells
 * the model a field is mandatory and the model duly invents a value for it.
 * Silent fabrication in a filled tender document is the worst failure mode in
 * this codebase, which is why this is done rather than left to chance.
 */
function widenWithNull(schema: JsonObject): JsonObject {
  if (Array.isArray(schema.anyOf) || Array.isArray(schema.oneOf)) {
    const key = Array.isArray(schema.anyOf) ? "anyOf" : "oneOf";
    const branches = schema[key] as unknown[];
    const hasNull = branches.some((b) => isObject(b) && b.type === "null");
    return hasNull ? schema : { ...schema, [key]: [...branches, { type: "null" }] };
  }
  const type = schema.type;
  if (typeof type === "string") {
    return type === "null" ? schema : { ...schema, type: [type, "null"] };
  }
  if (Array.isArray(type)) {
    return type.includes("null") ? schema : { ...schema, type: [...type, "null"] };
  }
  // No `type` to widen (a bare $ref or an enum-only node) — wrap instead.
  return { anyOf: [schema, { type: "null" }] };
}

interface AdaptOptions {
  /** Drop value-range keywords. Off by default; see BOUNDS_KEYS. */
  stripBounds?: boolean;
}

function adapt(value: unknown, dialect: SchemaDialect, options: AdaptOptions): unknown {
  if (Array.isArray(value)) return value.map((entry) => adapt(entry, dialect, options));
  if (!isObject(value)) return value;

  const out: JsonObject = {};
  for (const [key, entry] of Object.entries(value)) {
    if (METADATA_KEYS.has(key)) continue;
    if (dialect === "gemini" && !GEMINI_KEYS.has(key)) continue;
    if (dialect === "openai-strict" && options.stripBounds && BOUNDS_KEYS.has(key)) continue;

    if (key === "properties" && isObject(entry)) {
      out.properties = Object.fromEntries(
        Object.entries(entry).map(([property, schema]) => [
          property,
          adapt(schema, dialect, options),
        ]),
      );
      continue;
    }
    out[key] = adapt(entry, dialect, options);
  }

  if (dialect !== "openai-strict") return out;

  // ── openai-strict object rules ──────────────────────────────────────────
  //
  // 3. `nullable: true` is OpenAPI 3.0, which strict mode does not know.
  //    Rewrite it as a type union before anything else looks at `type`.
  if (out.nullable === true) {
    delete out.nullable;
    Object.assign(out, widenWithNull(out));
  } else {
    delete out.nullable;
  }

  if (out.type === "object" && isObject(out.properties)) {
    const keys = Object.keys(out.properties);
    const alreadyRequired = new Set(
      Array.isArray(out.required) ? (out.required as string[]) : [],
    );

    // 4. Any key we are about to force into `required` was optional in the
    //    product's model, so widen it with null in the same breath.
    out.properties = Object.fromEntries(
      keys.map((key) => {
        const schema = (out.properties as JsonObject)[key];
        if (alreadyRequired.has(key) || !isObject(schema)) return [key, schema];
        return [key, widenWithNull(schema)];
      }),
    );

    // 2. strict mode: every key present in `required`, no extra keys allowed.
    out.required = keys;
    out.additionalProperties = false;
  }

  return out;
}

/**
 * Translate a JSON Schema into one provider's dialect.
 *
 * Idempotent: adapting an already-adapted schema is a no-op, so it is safe to
 * call at a boundary that a caller may have already crossed.
 */
export function adaptJsonSchema(
  schema: unknown,
  dialect: SchemaDialect,
  options: AdaptOptions = {},
): Record<string, unknown> {
  const stripBounds = options.stripBounds ?? process.env.AI_AZURE_SCHEMA_STRIP_BOUNDS === "true";
  return adapt(schema, dialect, { stripBounds }) as Record<string, unknown>;
}

/**
 * @deprecated Prefer `adaptJsonSchema(schema, "gemini")`. Kept because
 * `edit-v2.ts` exports this name and its test pins the behaviour.
 */
export function toProviderSafeJsonSchema(value: unknown): unknown {
  return adaptJsonSchema(value, "gemini");
}

/** The dialect a provider speaks. Unknown providers get the stricter one. */
export function dialectForProvider(provider: string): SchemaDialect {
  return provider === "gemini" ? "gemini" : "openai-strict";
}
