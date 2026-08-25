import type { ObjectId } from "mongodb";

import {
  applySensitivityRatchet,
  computeOpenQuestions,
} from "./fieldmap.ts";
import {
  updateFillSession,
  type FillAgentSessionDocument,
} from "./store.ts";

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
  const updated = await updateFillSession(input.tenantId, session._id!, {
    values: mergedValues,
    fieldmap: ratcheted,
    openQuestions: computeOpenQuestions(ratcheted),
  });

  return { session: updated ?? session, applied, unknown };
}
