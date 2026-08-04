import { MongoClient } from "mongodb";

const uri = process.env.MONGODB_URI;

if (!uri) {
  throw new Error("MONGODB_URI is not configured. Add it to .env.local.");
}

declare global {
  var bauaiMongoClient: MongoClient | undefined;
}

export const mongoClient = global.bauaiMongoClient ?? new MongoClient(uri);

if (process.env.NODE_ENV !== "production") {
  global.bauaiMongoClient = mongoClient;
}

export const mongoDatabase = mongoClient.db(process.env.MONGODB_DB || "bauai");
