import { createApiDatabase } from "@waffle/db";
import { config } from "dotenv";
import { createApp } from "./app.ts";
import { parseApiEnv } from "./config.ts";

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

  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: env.API_HOST,
      port: env.API_PORT,
      fetch: createApp(database).fetch,
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
