import {
  createApiDatabase,
  createDeliveryDatabase,
  createLiveReadStore,
  createReadStore,
  waitForDatabase,
} from "@waffle/db";
import { DevnetPumpSwap } from "@waffle/market-data/devnet-pumpswap";
import { PythPrices } from "@waffle/market-data/pyth";
import { MarketRpc } from "@waffle/market-data/rpc";
import { createLogger } from "@waffle/observability";
import { config } from "dotenv";
import { websocket } from "hono/bun";
import { createApp } from "./app.ts";
import { ApiConfigurationError, parseApiEnv } from "./config.ts";
import { createFcm } from "./fcm.ts";
import { createJupiterServiceFromEnv } from "./jupiter.ts";
import { LiveDelivery } from "./live-delivery.ts";
import { PushDelivery } from "./push-delivery.ts";
import { createTradeAssessor, TradeAssessmentError } from "./trade-assessment.ts";
import { createWalletActivityValidator } from "./wallet-activity.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });
const logger = createLogger({ service: "api", level: process.env.LOG_LEVEL });

async function main() {
  const env = parseApiEnv(process.env);
  const fcm = process.env.FCM_SERVICE_ACCOUNT_JSON ? createFcm(process.env.FCM_SERVICE_ACCOUNT_JSON) : undefined;
  if (fcm && !env.DELIVERY_DATABASE_URL) throw new Error("FCM requires DELIVERY_DATABASE_URL");
  const database = createApiDatabase(env.DATABASE_URL);
  const delivery = env.DELIVERY_DATABASE_URL ? createDeliveryDatabase(env.DELIVERY_DATABASE_URL) : undefined;
  try {
    await waitForDatabase(
      async () => {
        await database.assertRestrictedLogin();
        await delivery?.assertRestrictedLogin();
      },
      { onRetry: (status) => logger.warn("api.database.waiting", status) },
    );
  } catch (error) {
    await delivery?.close();
    await database.close();
    throw new Error("API database login verification failed", { cause: error });
  }

  const jupiter =
    process.env.JUPITER_API_KEY?.trim() && process.env.JUPITER_API_KEY !== "replace-me"
      ? createJupiterServiceFromEnv({ JUPITER_API_KEY: process.env.JUPITER_API_KEY })
      : undefined;
  const live = delivery
    ? new LiveDelivery({ auth: database.auth, reads: database.live, dispatch: delivery.live, logger })
    : undefined;
  const push = delivery && fcm ? new PushDelivery(delivery.push, fcm, logger) : undefined;
  const marketRpc = env.HELIUS_RPC_URL
    ? new MarketRpc({ url: env.HELIUS_RPC_URL, requestsPerSecond: env.RPC_REQUESTS_PER_SECOND })
    : undefined;
  const assessor =
    marketRpc && jupiter
      ? createTradeAssessor({
          rpc: marketRpc,
          jupiter,
          pyth: new PythPrices({
            feeds: env.PYTH_PRICE_FEEDS_JSON,
            ...(env.PYTH_API_KEY ? { apiKey: env.PYTH_API_KEY } : {}),
          }),
        })
      : undefined;
  const activity = env.HELIUS_RPC_URL
    ? createWalletActivityValidator({
        url: env.HELIUS_RPC_URL,
        requestsPerSecond: env.RPC_REQUESTS_PER_SECOND,
        ...(marketRpc ? { rpc: marketRpc } : {}),
      })
    : undefined;
  const app = createApp(
    database,
    { store: database.auth, uri: env.AUTH_URI, ...(activity ? { activity } : {}) },
    jupiter ? { jupiter, ...(assessor ? { assessor } : {}) } : undefined,
    live,
    push,
    jupiter ? { jupiter, ...(assessor ? { assessor } : {}) } : undefined,
    logger,
  );
  const devnetRpc = new MarketRpc({ url: env.SOLANA_DEVNET_RPC_URL, requestsPerSecond: env.RPC_REQUESTS_PER_SECOND });
  const devnet = new DevnetPumpSwap(devnetRpc);
  const networkLives: LiveDelivery[] = [];
  for (const network of ["devnet", "testnet"] as const) {
    const scopedLive = delivery
      ? new LiveDelivery({
          auth: database.auth,
          reads: createLiveReadStore(database.db, network),
          dispatch: delivery.live,
          logger,
          network,
        })
      : undefined;
    if (scopedLive) networkLives.push(scopedLive);
    const devnetAssessor = {
      async assess(...args: Parameters<typeof devnet.assess>) {
        try {
          return await devnet.assess(...args);
        } catch {
          throw new TradeAssessmentError(
            "SERVICE_UNAVAILABLE",
            503,
            "Unable to verify this Devnet token and PumpSwap pool. Check the Devnet RPC and pool.",
          );
        }
      },
    };
    const unavailableAssessor = {
      async assess(): Promise<never> {
        throw new TradeAssessmentError(
          "UNSUPPORTED_ROUTE",
          409,
          "PumpSwap has no published Testnet deployment. Use Devnet for test-token trades.",
        );
      },
    };
    const provider = network === "devnet" ? devnet : undefined;
    const networkAssessor = network === "devnet" ? devnetAssessor : unavailableAssessor;
    const scoped = createApp(
      { ping: database.ping, reads: createReadStore(database.db, network) },
      { store: database.auth, uri: env.AUTH_URI },
      { ...(provider ? { jupiter: provider } : {}), assessor: networkAssessor },
      scopedLive,
      undefined,
      { ...(provider ? { jupiter: provider } : {}), assessor: networkAssessor },
      logger,
      network,
    );
    app.route(`/networks/${network}`, scoped);
  }
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
    devnetRpc.close();
    marketRpc?.close();
    await delivery?.close();
    await database.close();
    throw error;
  }
  for (const scoped of networkLives) scoped.start();
  live?.start();
  push?.start();
  if (!push) logger.info("api.push.disabled", { reason: "missing-fcm-or-delivery-configuration" });
  if (!live) logger.info("api.live.disabled", { reason: "missing-delivery-configuration" });
  if (!activity) logger.info("api.wallet-activity.disabled", { reason: "missing-helius-rpc-url" });
  logger.info("api.started", { port: env.API_PORT });

  let closing = false;
  async function shutdown() {
    if (closing) return;
    closing = true;
    logger.info("api.stopping");
    try {
      await Promise.all([live?.stop(), push?.stop(), ...networkLives.map((scoped) => scoped.stop())]);
      server.stop(true);
      devnetRpc.close();
      marketRpc?.close();
      await delivery?.close();
      await database.close();
      logger.info("api.stopped");
    } catch (error) {
      logger.error("api.shutdown.failed", { error });
      process.exitCode = 1;
    }
  }
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  logger.error("api.startup.failed", {
    ...(error instanceof ApiConfigurationError ? { reason: `Invalid configuration: ${error.fields.join(", ")}` } : {}),
    error,
  });
  process.exitCode = 1;
});
