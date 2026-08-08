import type { ObjectId } from "mongodb";

import { logger } from "../../ingestion/observability/logger.ts";
import { getGateway } from "../gateway/index.ts";
import type { ModelGateway } from "../gateway/types.ts";
import {
  callModel,
  extractFromDocuments,
  extractViaRetrieval,
  type RawExtractionResult,
} from "./engine.ts";
import { mergeFieldResults, type VerifiedFields } from "./merge.ts";
import { buildRetryPrompt } from "./prompts.ts";
import {
  EXTRACTION_SCHEMAS,
  type ExtractionSchemaName,
} from "./schemas/index.ts";
import { verifyFields, type VerificationSources } from "./verify.ts";

const log = logger.child("ai.extractor");

const MAX_CITATION_RETRIES = 2;

export type ExtractionStatus = "VERIFIED" | "PARTIAL" | "EMPTY" | "FAILED";

export interface ExtractionOutcome {
  schemaName: ExtractionSchemaName;
  schemaVersion: number;
  fields: VerifiedFields;
  unresolved: string[];
  sourceDocumentRecordIds: string[];
  status: ExtractionStatus;
  stats: {
    modelCalls: number;
    retriedFields: number;
    verifiedFields: number;
    totalFields: number;
  };
}

function sourcesOf(result: RawExtractionResult): VerificationSources {
  const anyChunk = result.chunksById.values().next().value;
  return {
    chunksById: result.chunksById,
    documentText: result.documentText,
    documentRecordId: result.documentRecordId,
    documentFileSha256:
      result.path === "document" ? (anyChunk?.fileSha256 ?? null) : null,
  };
}

/**
 * Verifies one raw result and re-extracts fields whose citations failed, at
 * most twice (§18.4). Retries reuse the exact same source blocks with a
 * narrowed prompt; a field that still fails keeps its value UNVERIFIED.
 */
async function verifyWithRetries(
  gateway: ModelGateway,
  schemaName: ExtractionSchemaName,
  result: RawExtractionResult,
): Promise<{ fields: VerifiedFields; retriedFields: number; modelCalls: number }> {
  const schema = EXTRACTION_SCHEMAS[schemaName];
  const sources = sourcesOf(result);

  const initial = verifyFields(result.fields, sources);
  const fields = initial.fields;
  let failedFieldNames = initial.failedFieldNames;
  let modelCalls = 0;
  const retriedFields = new Set<string>();

  for (
    let attempt = 1;
    failedFieldNames.length > 0 && attempt <= MAX_CITATION_RETRIES;
    attempt++
  ) {
    for (const name of failedFieldNames) retriedFields.add(name);
    log.info("re-extracting fields with failed citations", {
      schemaName,
      attempt,
      fields: failedFieldNames,
    });

    const retryOutput = await callModel(
      gateway,
      schema,
      result.blocks,
      buildRetryPrompt({ schema, failedFieldNames, blocks: result.blocks }),
    );
    modelCalls += 1;

    const retryVerified = verifyFields(retryOutput.fields, sources);
    const nextFailed: string[] = [];
    for (const name of failedFieldNames) {
      const replacement = retryVerified.fields[name];
      if (replacement && replacement.citationState === "VERIFIED") {
        fields[name] = replacement;
      } else {
        nextFailed.push(name);
      }
    }
    failedFieldNames = nextFailed;
  }

  return { fields, retriedFields: retriedFields.size, modelCalls };
}

/**
 * Extracts one schema for one tender: retrieval path + full-document path,
 * each citation-verified with retries, merged field-by-field.
 */
export async function extractSchemaForTender(input: {
  tenderId: ObjectId;
  schemaName: ExtractionSchemaName;
  gateway?: ModelGateway;
}): Promise<ExtractionOutcome> {
  const gateway = input.gateway ?? getGateway();
  const schema = EXTRACTION_SCHEMAS[input.schemaName];

  let modelCalls = 0;
  let retriedFields = 0;
  const verifiedSets: VerifiedFields[] = [];
  const sourceDocumentRecordIds = new Set<string>();

  try {
    const rawResults: RawExtractionResult[] = [];

    const retrievalResult = await extractViaRetrieval({
      tenderId: input.tenderId,
      schema,
      gateway,
    });
    if (retrievalResult) rawResults.push(retrievalResult);

    rawResults.push(
      ...(await extractFromDocuments({ tenderId: input.tenderId, schema, gateway })),
    );

    if (rawResults.length === 0) {
      return {
        schemaName: schema.name,
        schemaVersion: schema.schemaVersion,
        fields: {},
        unresolved: [...schema.fieldNames],
        sourceDocumentRecordIds: [],
        status: "EMPTY",
        stats: { modelCalls: 0, retriedFields: 0, verifiedFields: 0, totalFields: schema.fieldNames.length },
      };
    }

    for (const raw of rawResults) {
      modelCalls += raw.modelCalls;
      if (raw.documentRecordId) sourceDocumentRecordIds.add(raw.documentRecordId);
      for (const source of raw.chunksById.values()) {
        sourceDocumentRecordIds.add(source.documentRecordId);
      }

      const verified = await verifyWithRetries(gateway, schema.name, raw);
      modelCalls += verified.modelCalls;
      retriedFields += verified.retriedFields;
      verifiedSets.push(verified.fields);
    }

    const merged = mergeFieldResults(schema.fieldNames, verifiedSets);
    const verifiedFields = Object.values(merged.fields).filter(
      (field) => field.citationState === "VERIFIED",
    ).length;
    const nonNull = Object.values(merged.fields).filter(
      (field) => field.value != null,
    ).length;

    const status: ExtractionStatus =
      nonNull === 0
        ? "EMPTY"
        : Object.values(merged.fields).every(
              (field) => field.value == null || field.citationState === "VERIFIED",
            )
          ? "VERIFIED"
          : "PARTIAL";

    return {
      schemaName: schema.name,
      schemaVersion: schema.schemaVersion,
      fields: merged.fields,
      unresolved: merged.unresolved,
      sourceDocumentRecordIds: [...sourceDocumentRecordIds].sort(),
      status,
      stats: {
        modelCalls,
        retriedFields,
        verifiedFields,
        totalFields: schema.fieldNames.length,
      },
    };
  } catch (error) {
    log.error("extraction failed", {
      tenderId: String(input.tenderId),
      schemaName: input.schemaName,
      error: String(error),
    });
    throw error;
  }
}
