import { z } from "zod";

export const solanaNetworkSchema = z.enum(["mainnet", "devnet", "testnet"]);
export type SolanaNetwork = z.infer<typeof solanaNetworkSchema>;
export const solanaChainSchema = z.enum(["solana:mainnet", "solana:devnet", "solana:testnet"]);
export type SolanaChain = z.infer<typeof solanaChainSchema>;
export const networkAvailability = (network: SolanaNetwork) => ({
  network,
  signIn: true,
  pumpSwap: network !== "testnet",
  realTrades: network !== "testnet",
  quoteProvider: network === "mainnet" ? "jupiter" : network === "devnet" ? "pumpswap" : null,
  message:
    network === "testnet"
      ? "PumpSwap does not publish a Testnet deployment. Sign-in and account access are available; use Devnet for test-token trades."
      : null,
});
