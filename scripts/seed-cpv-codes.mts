import nextEnv from "@next/env";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { MongoClient, type AnyBulkWriteOperation, type Document } from "mongodb";

import { cpvCodes as curatedCpvCodes } from "../data/onboarding-catalog.ts";

nextEnv.loadEnvConfig(process.cwd());

const MAIN_CODE = /^\d{8}-\d$/;
const SUPPLEMENTARY_CODE = /^[A-Z]{2}\d{2}-\d$/;
const SPARQL_ENDPOINT = "https://publications.europa.eu/webapi/rdf/sparql";
const TRANSLATION_PAGE_SIZE = 2_000;
const BULK_WRITE_SIZE = 750;

// These two codes exist in the supplied CPV 2008 Annex CSV but are omitted from
// the current Publications Office RDF concept scheme. Keep the reviewed German
// CPV wording explicit so an upstream data gap can never silently become English.
const germanMainOverrides = new Map([
  ["15894230", "Fischmehl"],
  ["35611000", "Starrflügelflugzeuge"],
]);

type CsvCpv = { code: string; description: string };
type SparqlResponse = {
  results?: {
    bindings?: Array<{
      concept?: { value?: string };
      label?: { value?: string };
    }>;
  };
};

const divisionDomains: Record<string, string[]> = {
  "14": ["MATERIAL_SUPPLIER"],
  "24": ["MATERIAL_SUPPLIER"],
  "31": ["EQUIPMENT_SUPPLIER"],
  "34": ["EQUIPMENT_SUPPLIER"],
  "42": ["EQUIPMENT_SUPPLIER"],
  "43": ["EQUIPMENT_SUPPLIER"],
  "44": ["MATERIAL_SUPPLIER"],
  "45": ["CONSTRUCTION", "HANDWERK", "SUBCONTRACTOR"],
  "50": ["HANDWERK", "SUBCONTRACTOR", "FACILITY_MANAGEMENT"],
  "51": ["HANDWERK", "SUBCONTRACTOR", "FACILITY_MANAGEMENT"],
  "71": ["ARCHITECTURE", "ENGINEERING"],
  "73": ["ENGINEERING"],
  "77": ["FACILITY_MANAGEMENT"],
  "79": ["FACILITY_MANAGEMENT"],
  "90": ["FACILITY_MANAGEMENT"],
};

function parseCsv(input: string) {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index];
    if (quoted) {
      if (character === '"' && input[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    rows.push(row);
  }
  return rows;
}

function readVocabulary(rows: string[][], pattern: RegExp) {
  const entries: CsvCpv[] = rows.flatMap((row) => {
    const code = row[0]?.replace(/^\uFEFF/, "").trim().toUpperCase();
    const description = row[1]?.trim().replace(/\.$/, "");
    return pattern.test(code) && description ? [{ code, description }] : [];
  });
  const uniqueCodes = new Set(entries.map((entry) => entry.code));
  if (uniqueCodes.size !== entries.length) {
    throw new Error(`CSV contains ${entries.length - uniqueCodes.size} duplicate CPV code(s).`);
  }
  return entries;
}

async function fetchGermanLabels(scheme: "cpv" | "cpvsuppl") {
  const labels = new Map<string, string>();
  for (let offset = 0; ; offset += TRANSLATION_PAGE_SIZE) {
    const query = `
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      SELECT ?concept ?label WHERE {
        ?concept skos:inScheme <http://data.europa.eu/cpv/${scheme}>;
          skos:prefLabel ?label.
        FILTER(lang(?label) = "de")
      }
      ORDER BY ?concept
      LIMIT ${TRANSLATION_PAGE_SIZE}
      OFFSET ${offset}
    `;
    const searchParams = new URLSearchParams({
      query,
      format: "application/sparql-results+json",
    });
    let response: Response | undefined;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      response = await fetch(`${SPARQL_ENDPOINT}?${searchParams}`, {
        headers: { accept: "application/sparql-results+json" },
        signal: AbortSignal.timeout(60_000),
      }).catch(() => undefined);
      if (response?.ok) break;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 1_000));
    }
    if (!response?.ok) {
      throw new Error(`German ${scheme} translation request failed (${response?.status || "network error"}).`);
    }
    const data = await response.json() as SparqlResponse;
    const bindings = data.results?.bindings || [];
    for (const binding of bindings) {
      const concept = binding.concept?.value?.split("/").pop()?.toUpperCase();
      const label = binding.label?.value?.trim();
      if (concept && label) labels.set(concept, label);
    }
    if (bindings.length < TRANSLATION_PAGE_SIZE) break;
  }
  return labels;
}

function hierarchyLevel(code: string) {
  const digits = code.slice(0, 8);
  for (let index = digits.length - 1; index >= 0; index -= 1) {
    if (digits[index] !== "0") return index + 1;
  }
  return 2;
}

function chunks<T>(items: T[], size: number) {
  return Array.from({ length: Math.ceil(items.length / size) }, (_, index) =>
    items.slice(index * size, (index + 1) * size));
}

async function writeInBatches(
  collection: ReturnType<ReturnType<MongoClient["db"]>["collection"]>,
  operations: AnyBulkWriteOperation<Document>[],
) {
  for (const batch of chunks(operations, BULK_WRITE_SIZE)) {
    await collection.bulkWrite(batch, { ordered: false });
  }
}

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");

const csvPath = path.resolve(process.env.CPV_EN_CSV_PATH || path.join(process.cwd(), "CPV2008en(Annex Ia & Ib).csv"));
const csvRows = parseCsv(await readFile(csvPath, "utf8"));
const mainVocabulary = readVocabulary(csvRows, MAIN_CODE);
const supplementaryVocabulary = readVocabulary(csvRows, SUPPLEMENTARY_CODE);
if (!mainVocabulary.length || !supplementaryVocabulary.length) {
  throw new Error("The supplied CSV does not contain both CPV main and supplementary vocabularies.");
}

console.log(`Validated CSV: ${mainVocabulary.length} main and ${supplementaryVocabulary.length} supplementary CPV codes.`);
console.log("Downloading official German CPV 2008 labels from the EU Publications Office...");
const [germanMain, germanSupplementary] = await Promise.all([
  fetchGermanLabels("cpv"),
  fetchGermanLabels("cpvsuppl"),
]);
for (const [code, label] of germanMainOverrides) germanMain.set(code, label);

const missingMain = mainVocabulary.filter(({ code }) => !germanMain.has(code.slice(0, 8)));
const missingSupplementary = supplementaryVocabulary.filter(({ code }) => !germanSupplementary.has(code.slice(0, 4)));
if (missingMain.length || missingSupplementary.length) {
  throw new Error(
    `German CPV validation failed: ${missingMain.length} main (${missingMain.map(({ code }) => code).join(", ") || "none"}) and ${missingSupplementary.length} supplementary (${missingSupplementary.map(({ code }) => code).join(", ") || "none"}) labels are missing.`,
  );
}
console.log(`Matched every CSV code to German labels (${germanMain.size - germanMainOverrides.size} official main labels, ${germanSupplementary.size} official supplementary labels, and ${germanMainOverrides.size} reviewed RDF-gap overrides).`);

const curatedByCode = new Map(curatedCpvCodes.map((item) => [item.code, item]));
const now = new Date();
const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");
  const cpvCollection = database.collection("cpvcodes");
  const mainOperations: AnyBulkWriteOperation<Document>[] = mainVocabulary.map((item) => {
    const curated = curatedByCode.get(item.code);
    const division = item.code.slice(0, 2);
    return {
      updateOne: {
        filter: { code: item.code },
        update: {
          $set: {
            code: item.code,
            name: { en: item.description, de: germanMain.get(item.code.slice(0, 8))! },
            division,
            hierarchyLevel: hierarchyLevel(item.code),
            categories: [...new Set([...(divisionDomains[division] || []), ...(curated?.categories || [])])],
            keywords: curated?.keywords || [],
            source: "CPV 2008",
            sourceFile: path.basename(csvPath),
            translationSource: germanMainOverrides.has(item.code.slice(0, 8))
              ? "Reviewed German CPV 2008 fallback (EU RDF omission)"
              : SPARQL_ENDPOINT,
            version: "2008",
            updatedAt: now,
          },
          $setOnInsert: { createdAt: now },
        },
        upsert: true,
      },
    };
  });
  await writeInBatches(cpvCollection, mainOperations);
  await cpvCollection.createIndex({ code: 1 }, { unique: true });
  await cpvCollection.createIndex({ categories: 1, hierarchyLevel: 1 });
  await cpvCollection.createIndex({ "name.en": "text", "name.de": "text", keywords: "text" });

  const supplementaryCollection = database.collection("cpvsupplementarycodes");
  const supplementaryOperations: AnyBulkWriteOperation<Document>[] = supplementaryVocabulary.map((item) => ({
    updateOne: {
      filter: { code: item.code },
      update: {
        $set: {
          code: item.code,
          name: { en: item.description, de: germanSupplementary.get(item.code.slice(0, 4))! },
          source: "CPV 2008",
          sourceFile: path.basename(csvPath),
          translationSource: SPARQL_ENDPOINT,
          version: "2008",
          updatedAt: now,
        },
        $setOnInsert: { createdAt: now },
      },
      upsert: true,
    },
  }));
  await writeInBatches(supplementaryCollection, supplementaryOperations);
  await supplementaryCollection.createIndex({ code: 1 }, { unique: true });
  await supplementaryCollection.createIndex({ "name.en": "text", "name.de": "text" });

  const [mainCount, supplementaryCount] = await Promise.all([
    cpvCollection.countDocuments({ source: "CPV 2008" }),
    supplementaryCollection.countDocuments({ source: "CPV 2008" }),
  ]);
  console.log(`CPV import complete: ${mainCount} main and ${supplementaryCount} supplementary records are in MongoDB.`);
} finally {
  await client.close();
}
