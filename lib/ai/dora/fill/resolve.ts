import { createHash } from "node:crypto";

import type { DoraEditorSnapshotInput } from "@/lib/dora-gateway/snapshot-schema";

import type { FillDiscovery } from "./schema";
import type { DocumentFillEvidence, DocumentFillField } from "./types";

const SENSITIVE = /signature|initial|attest|consent|bank|iban|bic|account|commitment|certif(?:y|ication)/i;

export function resolveDiscoveredFields(input: {
  discovery: FillDiscovery;
  snapshot: DoraEditorSnapshotInput;
  evidence: Map<string, DocumentFillEvidence>;
}): DocumentFillField[] {
  const nodes = new Map(input.snapshot.nodes.map((node) => [node.id, node]));
  const occurrenceCount = (needle: string) =>
    input.snapshot.nodes.reduce((total, item) => {
      let index = 0;
      let count = 0;
      while (needle && (index = item.text.indexOf(needle, index)) >= 0) {
        count += 1;
        index += needle.length;
      }
      return total + count;
    }, 0);

  return input.discovery.fields.map((candidate, index) => {
    const node = nodes.get(candidate.nodeId);
    const target = candidate.targetText.trim();
    const formKey = node?.kind === "form" ? node.formKey?.trim() : "";
    const locator =
      node?.editable && formKey
        ? { strategy: "form_key" as const, nodeId: node.id, path: node.path, formKey }
        : node?.editable && target && node.text.includes(target) && occurrenceCount(target) === 1
          ? {
              strategy: "unique_text" as const,
              nodeId: node.id,
              path: node.path,
              searchText: target,
              occurrence: 1 as const,
            }
          : null;
    const evidence = candidate.evidenceReferences
      .map((ref) => input.evidence.get(ref))
      .filter((item): item is DocumentFillEvidence => Boolean(item));
    const sensitive = candidate.sensitive || SENSITIVE.test(`${candidate.label} ${candidate.description}`);
    const hasValue = Boolean(candidate.value?.trim());
    let state: DocumentFillField["state"];
    if (sensitive) state = "manual";
    else if (!hasValue) state = "missing";
    else if (!locator || evidence.length === 0 || candidate.confidence < 0.7) state = "needs_review";
    else if (candidate.confidence >= 0.9) state = "ready";
    else state = "needs_review";

    const id = createHash("sha256")
      .update(`${candidate.nodeId}\0${candidate.label}\0${index}`)
      .digest("hex")
      .slice(0, 24);
    return {
      id,
      label: candidate.label,
      description: candidate.description,
      required: candidate.required,
      sensitive,
      value: candidate.value?.trim() || null,
      confidence: candidate.confidence,
      state,
      locator,
      evidence,
      reason: locator ? candidate.reason : "The target could not be resolved to one exact editable location.",
      updatedBy: "ai" as const,
    };
  });
}
