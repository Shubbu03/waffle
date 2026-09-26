import { createWatcherDatabase } from "@waffle/db";
import { JupiterService } from "@waffle/jupiter";
import { config } from "dotenv";
import { parseWatcherEnv } from "./config.ts";
import { TokenEvidenceCollector } from "./evidence.ts";
import { PythPrices } from "./pyth.ts";
import { createWatcherRpc } from "./rpc.ts";
import { WalletWatcher } from "./watcher.ts";

config({ path: new URL("../.env", import.meta.url), quiet: true });

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
    onEvent: async ({ outcome, source, stale }) => {
      // Scoring/persistence is a separate pipeline stage. Never log credentials or raw transactions.
      if (outcome.status === "buy") {
        const checks = await evidence.collect({
          mintAddress: outcome.buy.mintAddress,
          poolAddress: outcome.buy.poolAddress,
          slot: outcome.buy.slot,
        });
        console.info(
          JSON.stringify({
            event: "watcher.buy",
            wallet: outcome.wallet,
            signature: outcome.signature,
            source,
            stale,
            evidence: {
              mint: checks.mint.status,
              pool: checks.pool.status,
              quote: checks.quote.status,
              holders: checks.holders.status,
              creator: checks.creator.status,
              oracle: checks.oracle,
            },
          }),
        );
      }
    },
  });
  let server: ReturnType<typeof Bun.serve> | undefined;
  let reporting: ReturnType<typeof setInterval> | undefined;
  let closing = false;
  async function shutdown(): Promise<void> {
    if (closing) return;
    closing = true;
    clearInterval(reporting);
    server?.stop(true);
    watcher.stop();
    rpc.close();
    await database.close();
  }
  try {
    await database.assertRestrictedLogin();
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
    reporting = setInterval(() => console.info(JSON.stringify({ event: "watcher.status", ...watcher.status })), 30_000);
    console.info(`Watcher started; health at http://127.0.0.1:${env.WATCHER_STATUS_PORT}/health`);
    process.once("SIGINT", () => {
      void shutdown();
    });
    process.once("SIGTERM", () => {
      void shutdown();
    });
  } catch {
    await shutdown();
    throw new Error("Watcher startup failed; check app-local configuration and the restricted database login");
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Watcher startup failed");
  process.exitCode = 1;
});
