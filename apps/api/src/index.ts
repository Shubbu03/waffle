import { createApiDatabase, createDeliveryDatabase } from "@waffle/db";
import { config } from "dotenv";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { parseApiEnv } from "./config.ts";
import { createJupiterServiceFromEnv } from "./jupiter.ts";
import { LiveDelivery } from "./live-delivery.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });

async function main() {
  const env = parseApiEnv(process.env);
  const database = createApiDatabase(env.DATABASE_URL);
  const delivery = env.DELIVERY_DATABASE_URL ? createDeliveryDatabase(env.DELIVERY_DATABASE_URL) : undefined;
  try {
    await database.assertRestrictedLogin();
    await delivery?.assertRestrictedLogin();
  } catch {
    await delivery?.close();
    await database.close();
    throw new Error("API database login verification failed");
  }

  const jupiter =
    process.env.JUPITER_API_KEY?.trim() && process.env.JUPITER_API_KEY !== "replace-me"
      ? createJupiterServiceFromEnv({ JUPITER_API_KEY: process.env.JUPITER_API_KEY })
      : undefined;
  const live = delivery
    ? new LiveDelivery({ auth: database.auth, reads: database.live, dispatch: delivery.live })
    : undefined;
  const app = createApp(database, { store: database.auth, uri: env.AUTH_URI }, jupiter ? { jupiter } : undefined, live);
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: env.API_HOST,
      port: env.API_PORT,
      fetch: (request, server) => app.fetch(request, { remoteAddress: server.requestIP(request)?.address, server }),
      websocket: {
        ...websocket,
        maxPayloadLength: 2048,
        backpressureLimit: 64 * 1024,
        closeOnBackpressureLimit: true,
        idleTimeout: 120,
        sendPings: true,
      },
    });
  } catch (error) {
    await delivery?.close();
    await database.close();
    throw error;
  }
  live?.start();
  if (!live) console.info("Live delivery disabled: configure DELIVERY_DATABASE_URL");
  console.info(`API listening on ${server.url.origin}`);

  async function shutdown() {
    await live?.stop();
    server.stop(true);
    await delivery?.close();
    await database.close();
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "API startup failed");
  process.exitCode = 1;
});
