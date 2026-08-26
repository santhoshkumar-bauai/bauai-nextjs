/**
 * Azure OpenAI capability probe.
 *
 *   npm run ai:azure:probe            # all probes
 *   npm run ai:azure:probe -- P5 P6   # only the named ones
 *
 * Every design decision in the Azure integration that depends on how the live
 * deployment actually behaves is asked here rather than assumed. Run it before
 * touching provider code, and again after any deployment or model change.
 *
 * Deliberately raw `fetch` + `@azure/identity`: the point is to observe the
 * wire, so routing through LangChain (which is exactly what we are validating)
 * would beg the question.
 *
 * WHAT THIS FOUND, and why the integration looks the way it does
 * -------------------------------------------------------------
 * `aif-bauai-dev-gwc` is a Foundry resource that serves ONLY the newer
 * OpenAI-compatible surface at `{endpoint}/openai/v1/...`, with no
 * `api-version` query parameter. The classic Azure route,
 * `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`,
 * returns 404 for every request.
 *
 * That single fact rules out LangChain's `AzureChatOpenAI`, which hard-codes
 * the deployment-scoped base URL (`@langchain/openai/dist/utils/azure.js:31`)
 * with no way to override it while a token provider is set. We use plain
 * `ChatOpenAI` pointed at the v1 base URL instead — see `lib/ai/config/azure.ts`.
 *
 * Exits non-zero if any probe FAILs. SKIP does not fail the run.
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { DefaultAzureCredential } = await import("@azure/identity");

const SCOPE = "https://cognitiveservices.azure.com/.default";
const endpoint = (process.env.AZURE_OPENAI_ENDPOINT ?? "").replace(/\/+$/, "");
const deployment =
  process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.AZURE_OPENAI_DEPLOYMENT_LUNA ?? "";
/** Model identity for telemetry and capability detection, NOT for the wire. */
const MODEL_ID = process.env.AZURE_OPENAI_MODEL ?? "gpt-5.6-luna";
const apiVersion = process.env.AZURE_OPENAI_API_VERSION ?? "";

if (!endpoint || !deployment) {
  console.error(
    "[probe] AZURE_OPENAI_ENDPOINT and AZURE_OPENAI_DEPLOYMENT must be set in .env.local.",
  );
  process.exit(1);
}

const V1 = `${endpoint}/openai/v1`;

// ---------------------------------------------------------------- plumbing

/**
 * WARN is a finding, not a defect: the probe learned what it came to learn and
 * the answer is operationally interesting (the content filter fires, the
 * deployment is at its TPM ceiling). Only FAIL — a capability we depend on
 * being absent or broken — stops the run.
 */
type Status = "PASS" | "WARN" | "FAIL" | "SKIP";
interface Result {
  id: string;
  title: string;
  status: Status;
  detail: string;
  data?: Record<string, unknown>;
}

const results: Result[] = [];
const findings = new Map<string, unknown>();

let credential: InstanceType<typeof DefaultAzureCredential> | null = null;
let cachedToken: { token: string; expiresOn: number } | null = null;

async function bearer(): Promise<string> {
  credential ??= new DefaultAzureCredential();
  // 60s of slack so a probe never starts with a token that expires mid-flight.
  if (cachedToken && cachedToken.expiresOn - Date.now() > 60_000) return cachedToken.token;
  const token = await credential.getToken(SCOPE);
  if (!token) throw new Error("DefaultAzureCredential returned no token");
  cachedToken = { token: token.token, expiresOn: token.expiresOnTimestamp };
  return token.token;
}

interface Call {
  status: number;
  ok: boolean;
  body: any;
  raw: string;
}

/**
 * The dev deployment sits close to its TPM ceiling and this script is bursty,
 * so 429s here mean "no capacity right now", never "no capability". Absorb them
 * in the transport, otherwise every probe has to reason about rate limits and
 * a red run tells you nothing about the model.
 */
async function post(url: string, body: unknown, attempt = 1): Promise<Call> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${await bearer()}`,
    },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const raw = await response.text();

  if (response.status === 429 && attempt <= 4) {
    const retryAfter = Number(response.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? retryAfter * 1_000
      : 5_000 * 2 ** (attempt - 1);
    process.stdout.write(`      … 429, waiting ${Math.round(waitMs / 1000)}s\n`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    return post(url, body, attempt + 1);
  }

  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    /* leave null; `raw` carries the truth */
  }
  return { status: response.status, ok: response.ok, body: parsed, raw };
}

const chat = (body: Record<string, unknown>) => post(`${V1}/chat/completions`, body);
const responses = (body: Record<string, unknown>) => post(`${V1}/responses`, body);

/** Smallest chat request that still exercises the deployment. */
function ping(extra: Record<string, unknown> = {}) {
  return {
    model: deployment,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_completion_tokens: 2_000,
    ...extra,
  };
}

function errorOf(call: Call): string {
  const error = call.body?.error;
  if (!error) return call.raw.slice(0, 300);
  const code = error.code ?? error.innererror?.code ?? "";
  return `${call.status}${code ? ` ${code}` : ""}: ${error.message ?? ""}`.slice(0, 300);
}

const textOf = (call: Call): string => call.body?.choices?.[0]?.message?.content ?? "";
const finishOf = (call: Call): string => call.body?.choices?.[0]?.finish_reason ?? "";
const reasoningTokensOf = (call: Call): number =>
  call.body?.usage?.completion_tokens_details?.reasoning_tokens ?? 0;

/** Concatenated output_text across a Responses payload. */
function responsesText(call: Call): string {
  const output = call.body?.output;
  if (!Array.isArray(output)) return "";
  return output
    .flatMap((item: any) => (Array.isArray(item?.content) ? item.content : []))
    .filter((part: any) => part?.type === "output_text")
    .map((part: any) => part.text ?? "")
    .join("");
}

const only = process.argv
  .slice(2)
  .filter((a) => /^P\d+$/i.test(a))
  .map((a) => a.toUpperCase());

async function probe(
  id: string,
  title: string,
  run: () => Promise<Omit<Result, "id" | "title">>,
): Promise<void> {
  if (only.length > 0 && !only.includes(id)) return;
  process.stdout.write(`\n[${id}] ${title}\n`);
  try {
    const outcome = await run();
    results.push({ id, title, ...outcome });
    if (outcome.data) for (const [k, v] of Object.entries(outcome.data)) findings.set(k, v);
    console.log(`      ${outcome.status}  ${outcome.detail}`);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    results.push({ id, title, status: "FAIL", detail });
    console.log(`      FAIL  ${detail}`);
  }
}

// ------------------------------------------------------------------ probes

await probe("P0", "Entra service-principal auth", async () => {
  const started = Date.now();
  const token = await bearer();
  const expires = cachedToken ? new Date(cachedToken.expiresOn).toISOString() : "?";
  return {
    status: "PASS",
    detail: `token in ${Date.now() - started}ms, expires ${expires}, ${token.length} chars`,
  };
});

await probe("P1", "Which API surface is live", async () => {
  const legacy = apiVersion
    ? await post(
        `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`,
        ping(),
      )
    : null;
  const v1 = await chat(ping());
  return {
    status: v1.ok ? "PASS" : "FAIL",
    detail:
      `/openai/v1/chat/completions → ${v1.ok ? "OK" : errorOf(v1)}; ` +
      `/openai/deployments/${deployment}/…?api-version=${apiVersion || "(unset)"} → ` +
      `${legacy ? (legacy.ok ? "OK" : String(legacy.status)) : "not tried"}. ` +
      (v1.ok && legacy && !legacy.ok
        ? "v1-only resource: AzureChatOpenAI (which hard-codes the deployment route) CANNOT be used."
        : ""),
    data: { p1V1Live: v1.ok, p1LegacyLive: legacy?.ok ?? false },
  };
});

await probe("P2", "Body `model`: deployment name vs real model id", async () => {
  const asDeployment = await chat(ping());
  const asModelId = await chat(ping({ model: MODEL_ID }));
  const resolved = asDeployment.body?.model ?? "?";
  return {
    status: asDeployment.ok ? "PASS" : "FAIL",
    detail:
      `model:"${deployment}" → ${asDeployment.ok ? `OK (resolves to ${resolved})` : errorOf(asDeployment)}; ` +
      `model:"${MODEL_ID}" → ${asModelId.ok ? "OK" : errorOf(asModelId)}. ` +
      (asDeployment.ok && !asModelId.ok
        ? "The wire needs the DEPLOYMENT name, but LangChain keys capability detection off `model` — " +
          "hence the body rewrite in lib/ai/config/azure.ts."
        : ""),
    data: {
      p2DeploymentNameRequired: asDeployment.ok && !asModelId.ok,
      p2ResolvedModel: resolved,
    },
  };
});

await probe("P3", "max_tokens vs max_completion_tokens", async () => {
  const legacy = await chat({
    model: deployment,
    messages: [{ role: "user", content: "Reply with the single word: ok" }],
    max_tokens: 2_000,
  });
  const modern = await chat(ping());
  return {
    status: modern.ok ? "PASS" : "FAIL",
    detail:
      `max_tokens → ${legacy.ok ? "accepted" : errorOf(legacy)}; ` +
      `max_completion_tokens → ${modern.ok ? "accepted" : errorOf(modern)}. ` +
      (!legacy.ok
        ? "HARD failure, not a silent degradation: isReasoningModel MUST see a gpt-5* model string."
        : ""),
    data: { p3MaxTokensAccepted: legacy.ok },
  };
});

await probe("P4", "temperature on a reasoning model", async () => {
  const custom = await chat(ping({ temperature: 0.2 }));
  const one = await chat(ping({ temperature: 1 }));
  return {
    status: one.ok ? "PASS" : "FAIL",
    detail:
      `temperature:0.2 → ${custom.ok ? "accepted" : errorOf(custom)}; ` +
      `temperature:1 → ${one.ok ? "accepted" : errorOf(one)}. ` +
      (!custom.ok ? "Omission is REQUIRED." : "Omission is optional."),
    data: { p4CustomTemperatureAccepted: custom.ok },
  };
});

await probe("P5", "reasoning_effort ladder", async () => {
  const rungs = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
  const accepted: string[] = [];
  const rejected: string[] = [];
  const reasoningTokens: Record<string, number> = {};
  for (const effort of rungs) {
    const call = await chat(
      ping({
        messages: [{ role: "user", content: "What is 17*23? Think, then answer." }],
        reasoning_effort: effort,
        max_completion_tokens: 4_000,
      }),
    );
    if (call.ok) {
      accepted.push(effort);
      reasoningTokens[effort] = reasoningTokensOf(call);
    } else rejected.push(effort);
  }
  return {
    status: accepted.length > 0 ? "PASS" : "FAIL",
    detail:
      `accepted: ${accepted.join(", ") || "(none)"}` +
      (rejected.length > 0 ? ` | REJECTED: ${rejected.join(", ")}` : ""),
    data: { p5Accepted: accepted, p5Rejected: rejected, p5ReasoningTokens: reasoningTokens },
  };
});

await probe("P6", "Responses API", async () => {
  const call = await responses({
    model: deployment,
    input: "Reply with the single word: ok",
    reasoning: { effort: "high" },
    max_output_tokens: 3_000,
  });
  return {
    status: call.ok ? "PASS" : "FAIL",
    detail: call.ok
      ? `OK at /openai/v1/responses, status=${call.body?.status}, text="${responsesText(call).slice(0, 40)}"`
      : errorOf(call),
    data: { p6ResponsesLive: call.ok },
  };
});

await probe("P7", "strict json_schema, with and without bounds keywords", async () => {
  const base = {
    type: "object",
    additionalProperties: false,
    properties: {
      label: { type: "string", enum: ["a", "b"] },
      items: { type: "array", items: { type: "string" } },
      score: { type: ["number", "null"] },
    },
    required: ["label", "items", "score"],
  };
  const bounded = structuredClone(base) as any;
  bounded.properties.items.maxItems = 5;
  bounded.properties.items.minItems = 1;
  bounded.properties.label.maxLength = 32;
  bounded.properties.score.minimum = 0;
  bounded.properties.score.maximum = 1;

  // A schema with an OPTIONAL property — strict mode requires every key in
  // `required`, which is the rule the adapter has to enforce.
  const partial = {
    type: "object",
    additionalProperties: false,
    properties: { a: { type: "string" }, b: { type: "string" } },
    required: ["a"],
  };

  const ask = (schema: unknown) =>
    chat(
      ping({
        messages: [{ role: "user", content: 'Return {"label":"a","items":["x"],"score":0.5}' }],
        response_format: {
          type: "json_schema",
          json_schema: { name: "probe_schema", strict: true, schema },
        },
      }),
    );

  const plain = await ask(base);
  const withBounds = await ask(bounded);
  const withOptional = await ask(partial);
  return {
    status: plain.ok ? "PASS" : "FAIL",
    detail:
      `strict → ${plain.ok ? `OK ${JSON.stringify(textOf(plain).slice(0, 50))}` : errorOf(plain)}; ` +
      `+bounds → ${withBounds.ok ? "accepted" : errorOf(withBounds)}; ` +
      `partial required → ${withOptional.ok ? "accepted" : errorOf(withOptional)}`,
    data: {
      p7StrictAccepted: plain.ok,
      p7BoundsAccepted: withBounds.ok,
      p7PartialRequiredAccepted: withOptional.ok,
    },
  };
});

await probe("P8", "vision (image_url)", async () => {
  // 1x1 transparent PNG.
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const call = await chat(
    ping({
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: "Describe this image in three words." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${png}` } },
          ],
        },
      ],
    }),
  );
  return {
    status: call.ok ? "PASS" : "FAIL",
    detail: call.ok ? `accepted; said "${textOf(call).slice(0, 60)}"` : errorOf(call),
    data: { p8VisionAccepted: call.ok },
  };
});

await probe("P9", "native PDF input (file content part)", async () => {
  const b64 = Buffer.from(minimalPdf("PROBE-TOKEN-8F2A"), "latin1").toString("base64");
  const parts = (withFilename: boolean) => [
    { type: "text", text: "Reply with the token printed in this PDF, nothing else." },
    {
      type: "file",
      file: {
        ...(withFilename ? { filename: "probe.pdf" } : {}),
        file_data: `data:application/pdf;base64,${b64}`,
      },
    },
  ];
  const named = await chat(ping({ messages: [{ role: "user", content: parts(true) }] }));
  const anonymous = await chat(ping({ messages: [{ role: "user", content: parts(false) }] }));
  const readIt = named.ok && textOf(named).includes("8F2A");
  return {
    status: named.ok ? "PASS" : "FAIL",
    detail:
      `with filename → ${named.ok ? "accepted" : errorOf(named)}; ` +
      `without → ${anonymous.ok ? "accepted" : errorOf(anonymous)}; ` +
      `token read back: ${readIt ? "yes" : "no"}`,
    data: {
      p9PdfAccepted: named.ok,
      p9FilenameRequired: named.ok && !anonymous.ok,
      p9PdfTextRead: readIt,
    },
  };
});

await probe("P10", "native web search tool", async () => {
  // Only skip when P6 actually ran and said no; a filtered run (`-- P10`) has
  // no P6 finding and should still attempt the call.
  if (results.some((r) => r.id === "P6") && !findings.get("p6ResponsesLive")) {
    return { status: "SKIP", detail: "no Responses route (P6) — web search is Responses-only" };
  }
  const call = await responses({
    model: deployment,
    input:
      "Was kostet aktuell ein Sack Zement CEM I 42,5 R (25 kg) in Deutschland? " +
      "Nenne einen Preis und die Quelle.",
    tools: [{ type: "web_search" }],
    max_output_tokens: 8_000,
  });
  if (call.status === 429) {
    return {
      status: "WARN",
      detail: `still 429 after the transport's backoff ladder — capacity, not capability`,
      data: { p10WebSearchAccepted: null },
    };
  }
  const searched = call.raw.includes("web_search_call");
  const cited = call.raw.includes("url_citation");
  return {
    status: call.ok ? "PASS" : "FAIL",
    detail: call.ok
      ? `accepted; web_search_call: ${searched ? "yes" : "no"}, url_citation annotations: ${cited ? "yes" : "no"}; ` +
        `text="${responsesText(call).slice(0, 90)}"`
      : errorOf(call),
    data: { p10WebSearchAccepted: call.ok, p10Searched: searched, p10UrlCitations: cited },
  };
});

await probe("P11", "prompt caching", async () => {
  // A long, stable prefix is what gets cached; the tail varies.
  const prefix =
    "Referenzunterlagen zur Vergabe.\n" +
    "Die Vergabestelle behält sich vor, Nachweise nachzufordern. ".repeat(500);
  const ask = (tail: string) =>
    chat(
      ping({
        messages: [
          { role: "system", content: prefix },
          { role: "user", content: tail },
        ],
        prompt_cache_key: "bauai:probe",
      }),
    );
  const first = await ask("Erste Frage: antworte mit ok.");
  const second = await ask("Zweite Frage: antworte mit ok.");
  const cached = second.body?.usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const prompt = second.body?.usage?.prompt_tokens ?? 0;
  if (!first.ok || !second.ok) {
    return { status: "FAIL", detail: errorOf(first.ok ? second : first) };
  }
  return {
    // A cold cache is not a broken capability — two back-to-back calls from one
    // probe are the weakest possible signal. Worth seeing, not worth failing on.
    status: cached > 0 ? "PASS" : "WARN",
    detail:
      `prompt_tokens=${prompt}, cached_tokens=${cached}` +
      (cached > 0 ? " — caching is live" : " — cold; re-check under real traffic"),
    data: { p11CachedTokens: cached },
  };
});

await probe("P12", "content filter on real German procurement text", async () => {
  // Benign but filter-adjacent: demolition and blasting work is ordinary
  // construction procurement and routinely trips violence classifiers.
  const lv = [
    "Leistungsverzeichnis, Titel 03 — Abbruch- und Sprengarbeiten.",
    "Pos. 03.010: Kontrollierter Abbruch des Bestandsgebäudes einschließlich",
    "Sprengvorbereitung, Bohren der Sprengbohrlöcher, Laden mit gewerblichen",
    "Sprengstoffen und Zündung durch einen bestellten Sprengberechtigten.",
    "Pos. 03.040: Rückbau der Nasszellen einer Justizvollzugsanstalt sowie",
    "Entsorgung medizinischer Abfälle aus dem angrenzenden Krankenhaustrakt.",
    "",
    "Fasse die Position 03.010 in einem Satz zusammen.",
  ].join("\n");
  const call = await chat(ping({ messages: [{ role: "user", content: lv }] }));
  const filtered = finishOf(call) === "content_filter" || /content_filter/i.test(errorOf(call));
  if (!call.ok && !filtered) return { status: "FAIL", detail: errorOf(call) };
  return {
    // Recording that the filter fires IS the result this probe exists for, so a
    // block is a WARN. It is nonetheless the single most operationally
    // important line this script prints: demolition, blasting, correctional and
    // hospital work are ordinary German construction procurement, and the block
    // arrives as a 200 that no status check would notice.
    status: filtered ? "WARN" : "PASS",
    detail: filtered
      ? `BLOCKED on ordinary Sprengarbeiten/JVA/medical-waste text — shape: ` +
        `${call.ok ? 'HTTP 200, finish_reason="content_filter", empty content' : errorOf(call)}. ` +
        `classifyAiError must detect this; see the content_filtered runbook.`
      : `passed the filter; replied "${textOf(call).slice(0, 70)}"`,
    data: { p12Filtered: filtered, p12Raw: filtered ? call.raw.slice(0, 800) : undefined },
  };
});

await probe("P13", "tool calling round trip", async () => {
  const tools = [
    {
      type: "function",
      function: {
        name: "get_unit_price",
        description: "Look up the unit price of a construction material.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { material: { type: "string" } },
          required: ["material"],
        },
        strict: true,
      },
    },
  ];
  const prompt = { role: "user", content: "What does Portland cement cost? Use the tool." };
  const first = await chat(ping({ messages: [prompt], tools }));
  if (!first.ok) return { status: "FAIL", detail: errorOf(first) };

  const message = first.body?.choices?.[0]?.message;
  const toolCalls = message?.tool_calls ?? [];
  if (toolCalls.length === 0) {
    return { status: "FAIL", detail: "model returned no tool_calls", data: { p13ToolCalls: 0 } };
  }
  const second = await chat(
    ping({
      messages: [
        prompt,
        message,
        {
          role: "tool",
          tool_call_id: toolCalls[0].id,
          content: JSON.stringify({ material: "Portland cement", eurPerBag: 8.4 }),
        },
      ],
      tools,
    }),
  );
  return {
    status: second.ok ? "PASS" : "FAIL",
    detail: second.ok
      ? `${toolCalls[0].function.name}(${toolCalls[0].function.arguments}) → "${textOf(second).slice(0, 60)}"`
      : errorOf(second),
    data: { p13ToolCalls: toolCalls.length },
  };
});

await probe("P14", "truncation shape when the budget is exhausted", async () => {
  // A reasoning model can spend its whole budget thinking and return nothing.
  // The adapter has to report that as truncation, not as "non-JSON output".
  const call = await chat(
    ping({
      messages: [
        {
          role: "user",
          content: "Prove the Collatz conjecture rigorously. Show every step of your reasoning.",
        },
      ],
      reasoning_effort: "xhigh",
      max_completion_tokens: 16,
    }),
  );
  return {
    status: "PASS",
    detail: call.ok
      ? `HTTP 200, finish_reason="${finishOf(call)}", content=${JSON.stringify(textOf(call).slice(0, 30))}, ` +
        `reasoning_tokens=${reasoningTokensOf(call)}`
      : errorOf(call),
    data: { p14FinishReason: call.ok ? finishOf(call) : null, p14Empty: textOf(call).length === 0 },
  };
});

// ----------------------------------------------------------------- helpers

/** A one-page PDF whose only content stream prints `token`. */
function minimalPdf(token: string): string {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] " +
      "/Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = `BT /F1 14 Tf 20 50 Td (${token}) Tj ET`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  offsets.push(pdf.length);
  pdf += `5 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`;
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 2}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 2} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

// ----------------------------------------------------------------- summary

console.log(`\n${"─".repeat(74)}`);
console.log(`endpoint   ${endpoint}`);
console.log(`surface    ${V1}`);
console.log(`deployment ${deployment}   model-id ${MODEL_ID}`);
console.log(`${"─".repeat(74)}`);
for (const result of results) {
  console.log(`${result.status.padEnd(5)} ${result.id.padEnd(4)} ${result.title}`);
}
const failed = results.filter((r) => r.status === "FAIL");
const warned = results.filter((r) => r.status === "WARN");
console.log(
  `\n${results.filter((r) => r.status === "PASS").length} passed, ` +
    `${warned.length} warned, ${failed.length} failed, ` +
    `${results.filter((r) => r.status === "SKIP").length} skipped`,
);
if (warned.length > 0) {
  console.log(`\nFindings (not failures):`);
  for (const result of warned) console.log(`  ${result.id}: ${result.detail}`);
}
if (failed.length > 0) {
  console.log(`\nFailures:`);
  for (const result of failed) console.log(`  ${result.id}: ${result.detail}`);
}
process.exit(failed.length > 0 ? 1 : 0);
