import { expect, test } from "bun:test";
import { parseWatcherEnv, WatcherConfigurationError } from "../src/config.ts";

test("incomplete watcher configuration exposes field names for safe startup diagnostics", () => {
  try {
    parseWatcherEnv({ HELIUS_RPC_URL: "https://rpc.test/?api-key=private" });
    throw new Error("expected rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(WatcherConfigurationError);
    if (!(error instanceof WatcherConfigurationError)) throw error;
    expect(error.fields).toEqual(["JUPITER_API_KEY", "DATABASE_URL", "HELIUS_WSS_URL"]);
    expect(error.message).not.toContain("private");
  }
});
