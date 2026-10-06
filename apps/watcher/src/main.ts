import { createWatcherDatabase, waitForDatabase } from "@waffle/db";
import { JupiterService } from "@waffle/jupiter";
import { createLogger } from "@waffle/observability";
import { config } from "dotenv";
import { parseWatcherEnv, WatcherConfigurationError } from "./config.ts";
import { TokenEvidenceCollector } from "./evidence.ts";
import { PythPrices } from "./pyth.ts";
import { createWatcherRpc } from "./rpc.ts";
import { SignalPipeline } from "./signals.ts";
import { WalletWatcher } from "./watcher.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });
const logger = createLogger({ service: "watcher", level: process.env.LOG_LEVEL });

async function main(): Promise<void> {
  const env = parseWatcherEnv(process.env);
  const database = createWatcherDatabase(env.DATABASE_URL);
  const rpc = createWatcherRpc(process.env);
  const evidence = new TokenEvidenceCollector({
    rpc,
    jupiter: new JupiterService(env.JUPITER_API_KEY),
    pyth: new PythPrices({ apiKey: env.PYTH_API_KEY, feeds: env.PYTH_PRICE_FEEDS_JSON }),
    copySizeLamports: env.WATCHER_COPY_SIZE_LAMPORTS,
  });
  const watcher = new WalletWatcher({
    url: env.HELIUS_WSS_URL,
    connectionCount: env.WATCHER_CONNECTIONS,
    staleSlots: env.WATCHER_STALE_SLOTS,
    rpc,
    loadActiveWallets: database.loadActiveWallets,
    logger,
    onEvent: async (event) => {
      await signals.handle(event);
    },
  });
  const signals = new SignalPipeline({
    evidence,
    database,
    context(wallet) {
      const status = watcher.status;
      const tracked = status.wallets.find((entry) => entry.address === wallet);
      return { currentSlot: status.headSlot, stale: !status.running || !tracked || tracked.stale };
    },
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    logger.info("watcher.stopping");
    server?.stop(true);
    watcher.stop();
    rpc.close();
    await signals.close();
    await database.close();
    logger.info("watcher.stopped");
  }
  try {
    await waitForDatabase(() => database.assertRestrictedLogin(), {
      onRetry: (status) => logger.warn("watcher.database.waiting", status),
    });
    await watcher.start();
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: env.WATCHER_STATUS_PORT,
      fetch(request) {
        if (request.method !== "GET" || new URL(request.url).pathname !== "/health")
          return new Response(null, { status: 404 });
        const status = watcher.status;
        return Response.json(status, { status: status.degraded ? 503 : 200, headers: { "cache-control": "no-store" } });
      },
    });
    logger.info("watcher.started", { port: env.WATCHER_STATUS_PORT });
    process.once("SIGINT", () => {
      void shutdown().catch((error: unknown) => {
        logger.error("watcher.shutdown.failed", { error });
        process.exitCode = 1;
      });
    });
    process.once("SIGTERM", () => {
      void shutdown().catch((error: unknown) => {
        logger.error("watcher.shutdown.failed", { error });
        process.exitCode = 1;
      });
    });
  } catch (error) {
    await shutdown();
    throw error;
  }
}

main().catch((error: unknown) => {
  logger.error("watcher.startup.failed", {
    ...(error instanceof WatcherConfigurationError
      ? { reason: `Invalid configuration: ${error.fields.join(", ")}` }
      : {}),
    error,
  });
  process.exitCode = 1;
});
