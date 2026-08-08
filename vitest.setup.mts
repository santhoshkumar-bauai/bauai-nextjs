import nextEnv from "@next/env";

// Same env-loading path as the workers (`workers/*.mts`): .env.local et al.
// @next/env skips .env.local entirely when NODE_ENV === "test" (Next.js
// convention), which would leave integration tests without MONGODB_URI —
// mask the vitest NODE_ENV for the duration of the load.
const env = process.env as Record<string, string | undefined>;
const nodeEnv = env.NODE_ENV;
env.NODE_ENV = "development";
nextEnv.loadEnvConfig(process.cwd(), true);
env.NODE_ENV = nodeEnv;
