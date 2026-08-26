import type { ClientOptions } from "@langchain/openai";

/**
 * Azure OpenAI transport.
 *
 * Everything here exists because of one fact, established by
 * `npm run ai:azure:probe` (P1) against the live resource:
 *
 *   `aif-bauai-dev-gwc` serves ONLY the OpenAI-compatible surface at
 *   `{endpoint}/openai/v1/...`, with no `api-version` parameter. The classic
 *   `{endpoint}/openai/deployments/{deployment}/chat/completions?api-version=…`
 *   route returns 404 for every request.
 *
 * That rules out LangChain's `AzureChatOpenAI`. It builds its base URL as
 * `{endpoint}/openai/deployments/{deployment}` (`@langchain/openai`
 * `dist/utils/azure.js:31`) and there is no override: `getEndpoint` throws
 * `azureOpenAIApiInstanceName is required` if you clear the deployment name
 * while a token provider is set. So we use plain `ChatOpenAI` pointed at the
 * v1 base URL — which is exactly what that surface is designed for.
 *
 * Two things then need doing by hand, and `azureClientOptions` does both.
 */

/** Entra scope for Azure AI Services data-plane calls. */
const SCOPE = "https://cognitiveservices.azure.com/.default";

/**
 * The model id we tell LangChain about. It never reaches the wire — the
 * `fetch` wrapper below swaps it for the deployment name — but it decides
 * three things that all matter:
 *
 *   1. `isReasoningModel()` (`dist/utils/misc.js:4`) matches `gpt-5*`, which is
 *      what makes LangChain send `max_completion_tokens` instead of
 *      `max_tokens` and emit `reasoning_effort` at all. Probe P3 confirms
 *      `max_tokens` is a hard 400 on this model, so getting this wrong is a
 *      total outage, not a degradation.
 *   2. The tiktoken family used for token counting.
 *   3. The `providerModel` stamped on every persisted artifact. A deployment
 *      rename must not invalidate cached extractions and reports, so the model
 *      identity — not the deployment — is what we record.
 */
export const DEFAULT_AZURE_MODEL_ID = "gpt-5.6-luna";

/**
 * Reasoning efforts this model family accepts, from probe P5. `minimal` (a
 * gpt-5.0 spelling) and `max` are both rejected with `unsupported_value`, so
 * the product-level union has to be clamped rather than passed through.
 */
export const AZURE_REASONING_EFFORTS = ["none", "low", "medium", "high", "xhigh"] as const;
export type AzureReasoningEffort = (typeof AZURE_REASONING_EFFORTS)[number];

function requireAzureEnv(name: string, role: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `${name} is not configured, but the "${role}" role resolves to provider "azure". ` +
        `Set it in .env.local or change AI_MODEL_ROLES.`,
    );
  }
  return value;
}

/** `https://…openai.azure.com/openai/v1`, trailing slashes tolerated. */
export function azureBaseUrl(role: string): string {
  const endpoint = requireAzureEnv("AZURE_OPENAI_ENDPOINT", role).replace(/\/+$/, "");
  return `${endpoint}/openai/v1`;
}

type TokenProvider = () => Promise<string>;

let tokenProvider: TokenProvider | null = null;

/**
 * One credential and one token provider for the whole process.
 *
 * `getChatModel` runs on every chat turn and every planner call, so a fresh
 * `DefaultAzureCredential` per call would re-run MSAL discovery and, with a
 * client secret, re-authenticate against Entra on every AI request.
 * `getBearerTokenProvider` caches and refreshes the token internally.
 *
 * Deliberately shared with the Lane A gateway adapter: two providers would
 * mean two token caches and twice the Entra traffic for no benefit.
 */
export async function getAzureTokenProvider(): Promise<TokenProvider> {
  if (tokenProvider) return tokenProvider;
  const { DefaultAzureCredential, getBearerTokenProvider } = await import("@azure/identity");
  // Picks up AZURE_CLIENT_ID / AZURE_TENANT_ID / AZURE_CLIENT_SECRET locally,
  // and managed identity when deployed — no code change between the two.
  tokenProvider = getBearerTokenProvider(new DefaultAzureCredential(), SCOPE);
  return tokenProvider;
}

/** Test hook: drop the memoized credential so a fake can take its place. */
export function resetAzureTokenProviderForTests(provider: TokenProvider | null = null): void {
  tokenProvider = provider;
}

/**
 * Rewrite the outgoing request for Azure's v1 surface.
 *
 * Two edits, both forced by the probe:
 *
 * - **Auth.** The surface takes an Entra bearer token. The OpenAI SDK only
 *   knows about a static `apiKey`, so the header is set here from the shared
 *   token provider, which keeps refresh working over a long-lived process.
 * - **`model`.** Probe P2: the wire wants the deployment name (`luna-dev`);
 *   the real model id 404s with `DeploymentNotFound`. LangChain reads the same
 *   field for capability detection and needs `gpt-5.6-luna` there. The two
 *   requirements are irreconcilable in one string, so the swap happens on the
 *   way out — the last possible moment, after LangChain has finished deciding
 *   which parameters to send.
 */
function azureFetch(deployment: string, provider: TokenProvider): typeof fetch {
  return async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("authorization", `Bearer ${await provider()}`);
    // The SDK sets this from `apiKey`; leaving it would send a placeholder
    // alongside a valid bearer token.
    headers.delete("api-key");

    let body = init?.body;
    if (typeof body === "string") {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        if (typeof parsed.model === "string") {
          parsed.model = deployment;
          body = JSON.stringify(parsed);
        }
      } catch {
        // Not JSON (multipart upload, etc.) — pass it through untouched.
      }
    }

    return fetch(input, { ...init, headers, body });
  };
}

/**
 * `configuration` for a `ChatOpenAI` (or a raw `OpenAI` client) talking to
 * Azure. `apiKey` is a placeholder the SDK insists on having; the real
 * credential is the bearer token the fetch wrapper attaches.
 */
export async function azureClientOptions(
  deployment: string,
  role: string,
): Promise<ClientOptions & { fetch: typeof fetch }> {
  return {
    baseURL: azureBaseUrl(role),
    apiKey: "entra",
    fetch: azureFetch(deployment, await getAzureTokenProvider()),
  };
}
