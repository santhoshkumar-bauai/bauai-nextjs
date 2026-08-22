import { ObjectId } from "mongodb";

import { aiEnv } from "@/lib/ai/config/env";
import { getAiCollections } from "@/lib/ai/db/collections";
import { getObjectBuffer } from "@/lib/storage/s3";

import { isGaebExtension } from "./format";
import { parseGaeb } from "./parse";
import type { GaebDocument, GaebParseError } from "./types";

/**
 * Layer A of the GAEB data model: the immutable parsed source, cached per
 * `(documentId, sourceSha256, parserVersion)`. Parse-on-demand — a 1.4 MB
 * GAEB XML parses in well under a second, so there is no queue. Failures are
 * cached under the same identity, which makes a broken file cheap to reopen
 * and a parser fix (version bump) retry them automatically.
 */

export interface GaebStoredDocument {
  _id: ObjectId;
  tenantId: ObjectId;
  documentId: ObjectId;
  versionId: ObjectId;
  sourceSha256: string;
  parserVersion: string;
  parsedAt: Date;
  document: GaebDocument | null;
  parseError: GaebParseError | null;
}

export async function getOrParseGaebDocument(input: {
  tenantId: ObjectId;
  documentId: ObjectId;
  versionId: ObjectId;
  sourceSha256: string;
  s3Key: string;
  extension: string;
}): Promise<GaebStoredDocument> {
  const { gaebDocuments } = await getAiCollections();
  const parserVersion = aiEnv().gaebParserVersion;

  const cached = await gaebDocuments.findOne({
    documentId: input.documentId,
    sourceSha256: input.sourceSha256,
    parserVersion,
  });
  if (cached) return cached;

  let document: GaebDocument | null = null;
  let parseError: GaebParseError | null = null;
  const extension = input.extension.toLowerCase();
  if (!isGaebExtension(extension)) {
    parseError = {
      code: "unsupported_flavor",
      message: `.${extension} is not a GAEB extension`,
    };
  } else {
    const bytes = await getObjectBuffer(input.s3Key);
    const result = parseGaeb(bytes, extension);
    if (result.ok) document = result.document;
    else parseError = result.error;
  }

  const row: GaebStoredDocument = {
    _id: new ObjectId(),
    tenantId: input.tenantId,
    documentId: input.documentId,
    versionId: input.versionId,
    sourceSha256: input.sourceSha256,
    parserVersion,
    parsedAt: new Date(),
    document,
    parseError,
  };

  try {
    await gaebDocuments.insertOne(row);
    return row;
  } catch {
    // Lost an insert race against a concurrent open — the winner's row is
    // identical by construction (same bytes, same parser version).
    const raced = await gaebDocuments.findOne({
      documentId: input.documentId,
      sourceSha256: input.sourceSha256,
      parserVersion,
    });
    if (raced) return raced;
    throw new Error("gaeb_document_cache_write_failed");
  }
}
