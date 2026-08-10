import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadCompanyFiles } from "./upload-client.ts";

/**
 * Drives the three-step presigned flow against a fake `fetch`. `failFor` names
 * the files whose storage PUT should fail, so a batch can mix outcomes.
 */
function stubFetch(failFor: string[] = []) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    // Only the JSON steps carry a string body; the PUT body is the File itself.
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : {};

    if (url.endsWith("/upload-url")) {
      return Response.json({
        key: `key/${body.fileName}`,
        uploadUrl: `https://storage.test/put?name=${encodeURIComponent(body.fileName)}`,
        contentType: body.contentType,
        category: body.category,
      });
    }
    if (url.startsWith("https://storage.test/put")) {
      const name = decodeURIComponent(new URL(url).searchParams.get("name") ?? "");
      return failFor.includes(name)
        ? new Response("nope", { status: 500 })
        : new Response(null, { status: 200 });
    }
    // Confirm step.
    return Response.json({
      file: { id: `id-${body.fileName}`, fileName: body.fileName },
    });
  });
}

function pdf(name: string) {
  return new File([new Uint8Array(8)], name, { type: "application/pdf" });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadCompanyFiles", () => {
  it("uploads every file and returns outcomes in selection order", async () => {
    vi.stubGlobal("fetch", stubFetch());
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf"), pdf("d.pdf")];

    const outcomes = await uploadCompanyFiles(files, "general");

    expect(outcomes.map((outcome) => outcome.file.name)).toEqual([
      "a.pdf",
      "b.pdf",
      "c.pdf",
      "d.pdf",
    ]);
    expect(outcomes.every((outcome) => outcome.status === "done")).toBe(true);
  });

  it("keeps going when one file fails and reports it per file", async () => {
    vi.stubGlobal("fetch", stubFetch(["b.pdf"]));
    const files = [pdf("a.pdf"), pdf("b.pdf"), pdf("c.pdf")];
    const seen: string[] = [];

    const outcomes = await uploadCompanyFiles(files, "general", {
      onOutcome: (outcome) => seen.push(`${outcome.file.name}:${outcome.status}`),
    });

    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "done",
      "failed",
      "done",
    ]);
    expect(seen).toContain("b.pdf:failed");
    expect(seen).toHaveLength(3);
  });

  it("never runs more uploads at once than the concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const base = stubFetch();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const isPut = String(input).startsWith("https://storage.test/put");
      if (isPut) {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const response = await base(input, init);
      if (isPut) inFlight--;
      return response;
    });

    await uploadCompanyFiles(
      ["a", "b", "c", "d", "e", "f"].map((name) => pdf(`${name}.pdf`)),
      "general",
      { concurrency: 2 },
    );

    expect(peak).toBeLessThanOrEqual(2);
  });
});
