import { afterEach, describe, expect, it } from "vitest";

import { corsHeadersFor, handlePreflight } from "./cors.ts";

const originalOrigins = process.env.DORA_EDITOR_ORIGINS;

afterEach(() => {
  if (originalOrigins === undefined) delete process.env.DORA_EDITOR_ORIGINS;
  else process.env.DORA_EDITOR_ORIGINS = originalOrigins;
});

describe("Dora gateway CORS", () => {
  it("allows every method used by the document-fill lifecycle", () => {
    process.env.DORA_EDITOR_ORIGINS = "http://localhost:9000";
    const request = new Request("http://localhost:3000/api/dora-gateway/fill/document", {
      method: "OPTIONS",
      headers: { origin: "http://localhost:9000" },
    });

    const response = handlePreflight(request);

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET, POST, PATCH, DELETE, OPTIONS",
    );
  });

  it("rejects an unconfigured editor origin", () => {
    process.env.DORA_EDITOR_ORIGINS = "http://localhost:9000";
    const request = new Request("http://localhost:3000/api/dora-gateway/fill/document", {
      headers: { origin: "https://untrusted.example" },
    });

    expect(corsHeadersFor(request)).toBeNull();
  });
});
