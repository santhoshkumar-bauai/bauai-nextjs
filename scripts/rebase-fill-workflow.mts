import { ObjectId } from "mongodb";

import { getFillSessionCollection } from "../lib/ai/fill-agent/store.ts";
import { emptyFillWorkflow } from "../lib/ai/fill-agent/workflow-wire.ts";

const sessionId = process.argv[2];
if (!sessionId || !ObjectId.isValid(sessionId)) {
  throw new Error("Usage: node --experimental-strip-types scripts/rebase-fill-workflow.mts <sessionId>");
}

const collection = await getFillSessionCollection();
const id = new ObjectId(sessionId);
const existing = await collection.findOne({ _id: id });
if (!existing) throw new Error("Fill session not found.");

const result = await collection.updateOne(
  { _id: id },
  {
    $set: {
      workflow: emptyFillWorkflow(),
      sandboxSessionId: null,
      score: null,
      issues: [],
      output: null,
      critiqued: false,
      repairsSinceValidate: 0,
      updatedAt: new Date(),
    },
  },
);

console.log(JSON.stringify({
  matched: result.matchedCount,
  modified: result.modifiedCount,
  retainedFieldCount: existing.fieldmap.length,
  retainedValueCount: Object.keys(existing.values).length,
  geometryVersion: 2,
}));
process.exit(0);
