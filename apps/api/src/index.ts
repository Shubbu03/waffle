import { createApiDatabase } from "@waffle/db";
import { config } from "dotenv";
import { createApp } from "./app.ts";
import { parseApiEnv } from "./config.ts";
import { createJupiterServiceFromEnv } from "./jupiter.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });

async function main() {
  const env = parseApiEnv(process.env);
  const database = createApiDatabase(env.DATABASE_URL);
  try {
    await database.assertRestrictedLogin();
  } catch {
    await database.close();
    throw new Error("API database login verification failed");
  }

  const jupiter =
    process.env.JUPITER_API_KEY?.trim() && process.env.JUPITER_API_KEY !== "replace-me"
      ? createJupiterServiceFromEnv({ JUPITER_API_KEY: process.env.JUPITER_API_KEY })
      : undefined;
  const app = createApp(database, { store: database.auth, uri: env.AUTH_URI }, jupiter ? { jupiter } : undefined);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: env.API_HOST,
      port: env.API_PORT,
      fetch: (request, server) => app.fetch(request, { remoteAddress: server.requestIP(request)?.address }),
    });
  } catch (error) {
    await database.close();
    throw error;
  }
  console.info(`API listening on ${server.url.origin}`);

  async function shutdown() {
    server.stop();
    await database.close();
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "API startup failed");
  process.exitCode = 1;
});
