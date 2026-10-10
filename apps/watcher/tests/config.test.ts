import { expect, test } from "bun:test";
import { parseWatcherEnv, WatcherConfigurationError } from "../src/config.ts";

test("incomplete watcher configuration exposes field names for safe startup diagnostics", () => {
  try {
    parseWatcherEnv({ HELIUS_RPC_URL: "https://rpc.test/?api-key=private" });
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(WatcherConfigurationError);
    if (!(error instanceof WatcherConfigurationError)) throw error;
    expect(error.fields).toEqual(["DATABASE_URL", "HELIUS_WSS_URL"]);
    expect(error.message).not.toContain("private");
  }
});

const configured = {
  DATABASE_URL: "postgresql://login:password@db.test/waffle",
  HELIUS_RPC_URL: "https://api.devnet.solana.com",
  HELIUS_WSS_URL: "wss://api.devnet.solana.com",
};
test("Devnet watcher uses its network without requiring a Mainnet Jupiter key", () => {
  expect(parseWatcherEnv({ ...configured, SOLANA_NETWORK: "devnet" }).SOLANA_NETWORK).toBe("devnet");
  expect(() => parseWatcherEnv(configured)).toThrow("JUPITER_API_KEY");
  expect(() => parseWatcherEnv({ ...configured, SOLANA_NETWORK: "testnet" })).toThrow(
    "PumpSwap is not deployed on Testnet",
  );
});
