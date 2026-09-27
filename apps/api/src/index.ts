import { createApiDatabase, createDeliveryDatabase } from "@waffle/db";
import { config } from "dotenv";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { parseApiEnv } from "./config.ts";
import { createFcm } from "./fcm.ts";
import { createJupiterServiceFromEnv } from "./jupiter.ts";
import { LiveDelivery } from "./live-delivery.ts";
import { PushDelivery } from "./push-delivery.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });

async function main() {
  const env = parseApiEnv(process.env);
  const fcm = process.env.FCM_SERVICE_ACCOUNT_JSON ? createFcm(process.env.FCM_SERVICE_ACCOUNT_JSON) : undefined;
  if (fcm && !env.DELIVERY_DATABASE_URL) throw new Error("FCM requires DELIVERY_DATABASE_URL");
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
  const push = delivery && fcm ? new PushDelivery(delivery.push, fcm) : undefined;
  const app = createApp(
    database,
    { store: database.auth, uri: env.AUTH_URI },
    jupiter ? { jupiter } : undefined,
    live,
    push,
  );
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
  push?.start();
  if (!push) console.info("Push delivery disabled: configure FCM_SERVICE_ACCOUNT_JSON and DELIVERY_DATABASE_URL");
  if (!live) console.info("Live delivery disabled: configure DELIVERY_DATABASE_URL");
  console.info(`API listening on ${server.url.origin}`);

  async function shutdown() {
    await Promise.all([live?.stop(), push?.stop()]);
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
