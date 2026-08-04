import mongoose, { type Mongoose } from "mongoose";

type MongooseCache = {
  connection: Mongoose | null;
  promise: Promise<Mongoose> | null;
};

declare global {
  var bauaiMongoose: MongooseCache | undefined;
}

const cache = global.bauaiMongoose ?? {
  connection: null,
  promise: null,
};

if (process.env.NODE_ENV !== "production") {
  global.bauaiMongoose = cache;
}

export async function connectMongoose() {
  if (cache.connection) return cache.connection;

  const uri = process.env.MONGODB_URI;
  if (!uri) {
    throw new Error("MONGODB_URI is not configured. Add it to .env.local.");
  }

  cache.promise ??= mongoose.connect(uri, {
    dbName: process.env.MONGODB_DB || "bauai",
    bufferCommands: false,
  });

  try {
    cache.connection = await cache.promise;
  } catch (error) {
    cache.promise = null;
    throw error;
  }

  return cache.connection;
}
