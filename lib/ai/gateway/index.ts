import { resolveRole } from "./config.ts";
import { AzureOpenAIProvider } from "./providers/azure-openai.ts";
import { GeminiProvider } from "./providers/gemini.ts";
import type {
  EmbedRequest,
  EmbedResult,
  GenerateStructuredRequest,
  GenerateStructuredResult,
  ModelGateway,
} from "./types.ts";

/**
 * Adding a provider (OpenAI, Anthropic, self-hosted TEI, …) means: one
 * adapter class with `embed`/`generateStructured`, one entry here, and an
 * `AI_MODEL_ROLES` change. Call sites are untouched by design.
 */
interface Provider {
  name: string;
  embed(model: string, request: EmbedRequest): Promise<EmbedResult>;
  generateStructured<T>(
    model: string,
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>>;
}

const providers: Record<string, () => Provider> = {
  gemini: () => new GeminiProvider(),
  azure: () => new AzureOpenAIProvider(),
};

const instances = new Map<string, Provider>();

function getProvider(name: string): Provider {
  const cached = instances.get(name);
  if (cached) return cached;
  const factory = providers[name];
  if (!factory) {
    throw new Error(
      `Unknown model provider "${name}". Known: ${Object.keys(providers).join(", ")}`,
    );
  }
  const instance = factory();
  instances.set(name, instance);
  return instance;
}

class RoleRoutingGateway implements ModelGateway {
  async embed(request: EmbedRequest): Promise<EmbedResult> {
    const ref = resolveRole("embedding");
    return getProvider(ref.provider).embed(ref.model, request);
  }

  async generateStructured<T>(
    request: GenerateStructuredRequest<T>,
  ): Promise<GenerateStructuredResult<T>> {
    const ref = resolveRole(request.role);
    return getProvider(ref.provider).generateStructured(ref.model, request);
  }
}

let gateway: ModelGateway | null = null;

export function getGateway(): ModelGateway {
  gateway ??= new RoleRoutingGateway();
  return gateway;
}
