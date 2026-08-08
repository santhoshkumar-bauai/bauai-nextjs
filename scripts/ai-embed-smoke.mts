/**
 * Smoke test for the embedding path: embeds three German sentences via the
 * gateway and prints dimensions and norms. Requires GEMINI_API_KEY.
 *
 *   node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types scripts/ai-embed-smoke.mts
 */
import nextEnv from "@next/env";

nextEnv.loadEnvConfig(process.cwd());

const { getGateway } = await import("../lib/ai/gateway/index.ts");

const texts = [
  "Verlängerung von VMware Lizenzen für das Rechenzentrum 2026-2029.",
  "Der Bieter hat mindestens drei vergleichbare Referenzen nachzuweisen.",
  "Neubau einer Kindertagesstätte mit sechs Gruppenräumen in Stuttgart.",
];

const result = await getGateway().embed({
  texts,
  taskType: "RETRIEVAL_DOCUMENT",
});

console.log(`model=${result.model} version=${result.version} dims=${result.dimensions}`);
for (const [i, vector] of result.vectors.entries()) {
  const norm = Math.sqrt(vector.reduce((sum, v) => sum + v * v, 0));
  console.log(
    `text[${i}] len=${vector.length} norm=${norm.toFixed(6)} head=[${vector
      .slice(0, 4)
      .map((v) => v.toFixed(4))
      .join(", ")}]`,
  );
}

// Pairwise cosine similarity — eyeball that unrelated topics score lower.
function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
console.log("similarity matrix:");
for (let i = 0; i < result.vectors.length; i++) {
  const row = result.vectors
    .map((v) => cosine(result.vectors[i], v).toFixed(3))
    .join("  ");
  console.log(`  [${i}] ${row}`);
}
