import { loadEnvConfig } from "@next/env";
import { MongoClient } from "mongodb";

import { companyDomains, cpvCodes, services } from "../data/onboarding-catalog.ts";

loadEnvConfig(process.cwd());

const uri = process.env.MONGODB_URI;
if (!uri) throw new Error("MONGODB_URI is not configured.");

const client = new MongoClient(uri);

try {
  await client.connect();
  const database = client.db(process.env.MONGODB_DB || "bauai");

  const cpvCollection = database.collection("cpvcodes");
  if (cpvCodes.length) {
    await cpvCollection.bulkWrite(cpvCodes.map((item) => ({
      updateOne: {
        filter: { code: item.code },
        update: { $set: { ...item, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
        upsert: true,
      },
    })));
  }
  await cpvCollection.createIndex({ code: 1 }, { unique: true });
  await cpvCollection.createIndex({ "name.en": "text", "name.de": "text", keywords: "text" });

  const optionCollection = database.collection("onboardingoptions");
  const optionRecords = [
    ...companyDomains.map((item) => ({ ...item, type: "company-domain" })),
    ...services.map((item) => ({ ...item, type: "service" })),
  ];
  await optionCollection.bulkWrite(optionRecords.map((item) => ({
    updateOne: {
      filter: { type: item.type, value: item.value },
      update: { $set: { ...item, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } },
      upsert: true,
    },
  })));
  await optionCollection.createIndex({ type: 1, value: 1 }, { unique: true });

  console.log(`Seeded ${cpvCodes.length} CPV codes, ${companyDomains.length} company domains, and ${services.length} services.`);
} finally {
  await client.close();
}
