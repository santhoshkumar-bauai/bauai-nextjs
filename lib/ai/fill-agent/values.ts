import type { ObjectId } from "mongodb";

import {
  applySensitivityRatchet,
  computeOpenQuestions,
} from "./fieldmap.ts";
import {
  updateFillSession,
  type FillAgentSessionDocument,
} from "./store.ts";
import { emptyFillWorkflow, type ValueEvidence } from "./workflow-wire.ts";

/**
 * The ONE way user-stated values enter a session — used by both the
 * `set_field_values` chat tool and the values-form route, so the sensitivity
 * ratchet and open-question bookkeeping can never diverge between the two.
 */
export async function applyUserFieldValues(input: {
  tenantId: ObjectId;
  session: FillAgentSessionDocument;
  values: Array<{ fieldId: string; value: string }>;
}): Promise<{
  session: FillAgentSessionDocument;
  applied: string[];
  unknown: string[];
}> {
  const { session } = input;
  const knownIds = new Set(session.fieldmap.map((field) => field.id));
  const applied: string[] = [];
  const unknown: string[] = [];
  const mergedValues = { ...session.values };
  let fieldmap = session.fieldmap;

  for (const { fieldId, value } of input.values) {
    mergedValues[fieldId] = value;
    if (knownIds.has(fieldId)) {
      fieldmap = fieldmap.map((field) =>
        field.id === fieldId ? { ...field, value } : field,
      );
      applied.push(fieldId);
    } else {
      unknown.push(fieldId);
    }
  }

  const { fields: ratcheted } = applySensitivityRatchet(
    fieldmap,
    new Set(Object.keys(mergedValues)),
  );
  const workflow = session.workflow ?? emptyFillWorkflow();
  const evidence = { ...workflow.evidence };
  for (const { fieldId, value } of input.values) {
    evidence[fieldId] = {
      fieldId,
      value,
      source: "user",
      sourceRef: `user:${session.createdBy}`,
      confidence: 1,
      authorized: true,
      recordedAt: new Date().toISOString(),
    } satisfies ValueEvidence;
  }
  const updated = await updateFillSession(input.tenantId, session._id!, {
    values: mergedValues,
    fieldmap: ratcheted,
    openQuestions: computeOpenQuestions(ratcheted),
    workflow: { ...workflow, evidence },
  });

  return { session: updated ?? session, applied, unknown };
}

export async function applyWorkflowInput(input: {
  tenantId: ObjectId;
  session: FillAgentSessionDocument;
  userId: string;
  values: Array<{ fieldId: string; value: string }>;
  decisions: Array<{ groupId: string; fieldId: string }>;
}): Promise<FillAgentSessionDocument> {
  let session = input.session;
  if (input.values.length > 0) {
    session = (await applyUserFieldValues({ tenantId: input.tenantId, session, values: input.values })).session;
  }
  const workflow = session.workflow ?? emptyFillWorkflow();
  const selected = new Map(input.decisions.map((decision) => [decision.groupId, decision.fieldId]));
  const confirmedAt = new Date().toISOString();
  const decisions = workflow.decisions.map((group) => {
    const fieldId = selected.get(group.id);
    if (!fieldId) return group;
    if (!group.fieldIds.includes(fieldId)) {
      throw new Error(`Decision ${group.id} cannot select unrelated field ${fieldId}.`);
    }
    return { ...group, selection: fieldId, confirmedBy: input.userId, confirmedAt };
  });
  const groupByField = new Map(
    decisions.flatMap((group) => group.fieldIds.map((fieldId) => [fieldId, group] as const)),
  );
  const fieldmap = session.fieldmap.map((field) => {
    const group = groupByField.get(field.id);
    if (!group) return field;
    return { ...field, value: group?.selection === field.id ? "X" : "" };
  });
  const updated = await updateFillSession(input.tenantId, session._id!, {
    fieldmap,
    openQuestions: computeOpenQuestions(fieldmap),
    workflow: { ...workflow, decisions },
  });
  return updated ?? session;
}
