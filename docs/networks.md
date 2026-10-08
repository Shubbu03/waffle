# Solana networks

The selected network is saved on the device. Switching it keeps the wallet's waffle session and selects separate wallets, follows, signals, paper positions, real attempts, live streams, and offline caches. An open quote cannot be signed or filled after a network change. The same public address can be tracked independently on each network.

| Capability | Mainnet | Devnet | Testnet |
| --- | --- | --- | --- |
| Wallet sign-in, account and settings | Available | Available | Available |
| Wallet balances and Explorer | Mainnet | Devnet | Testnet |
| PumpSwap signals | Mainnet watcher | Devnet watcher | No published PumpSwap deployment |
| Paper trades and exit valuation | Jupiter | Direct PumpSwap pool quotes | Unavailable without a supported venue |
| Wallet-approved purchases | Jupiter Swap V2 | Direct PumpSwap, test SOL and test tokens | Unavailable without a supported venue |

PumpSwap documents its program on [Mainnet and Devnet](https://github.com/pump-fun/pump-public-docs/blob/main/docs/PUMP_SWAP_README.md). Testnet is a separate Solana cluster, not an alias for Devnet. This app does not fabricate Testnet pools or route a test-network order to Mainnet. Our existing Jupiter Swap V2 integration remains Mainnet-only.

## Run locally

Use the same PostgreSQL database and restricted watcher role as before. There is no new database or database login for Devnet. Migration `0004` adds network columns, preserves existing rows as Mainnet, and permits the same tracked address on different networks:

```sh
bun run db:migrate
bun run dev:api
```

The API serves all three networks from one process. Root market routes remain Mainnet-compatible. Devnet and Testnet market routes live under `/networks/devnet` and `/networks/testnet`; each has a `/network` availability endpoint. Sign-in and push-token registration use the root API because wallet identity and device registration are shared. Session authentication also works on the scoped endpoints.

Keep the existing Mainnet watcher running if you want Mainnet signals. In a second terminal, start:

```sh
bun run dev:watcher:devnet
```

This sets `SOLANA_NETWORK=devnet` and status port `3003`; the usual Mainnet watcher uses port `3002`. Each watches only wallets belonging to its own network. Do not start two watchers for the same network unnecessarily.

API environment (`apps/api/.env`):

```dotenv
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
```

Watcher environment (`apps/watcher/.env`):

```dotenv
SOLANA_DEVNET_RPC_URL=https://api.devnet.solana.com
SOLANA_DEVNET_WSS_URL=wss://api.devnet.solana.com
```

These defaults work without a Jupiter key for Devnet. Dedicated Devnet RPC/WSS endpoints can replace the public endpoints. The watcher ignores the Mainnet Helius endpoints when its selected network is Devnet. Do not place server RPC credentials in public mobile configuration. Keep combined API/watcher requests within the provider budget (for a shared free Helius key, 10 requests/sec total), and keep combined WSS connections within five. Two default watchers use four connections.

Mobile public RPC overrides are optional: `EXPO_PUBLIC_SOLANA_DEVNET_RPC_URL` and `EXPO_PUBLIC_SOLANA_TESTNET_RPC_URL`. Their defaults are the official public cluster endpoints. Keep `EXPO_PUBLIC_WAFFLE_API_URL` pointed at the API root; the app chooses the network prefix itself.

## Devnet trade behavior

Devnet uses the pinned official `@pump-fun/pump-swap-sdk` through the bounded Xior RPC transport. The API verifies the full Devnet genesis hash before reading pools or broadcasting. It derives the pool from a successful confirmed source buy, checks pool PDA/owner, exact mints and vaults, disabled mint/freeze authorities, and supports plain SPL Token or Token-2022 mints without transfer-changing extensions. Mayhem pools are unsupported.

Test SOL has no USD price. Devnet manual trades therefore require at least **1 test SOL** of available quote reserve, with each trade at most **1%** of that reserve. Caps remain **0.05 SOL real** and **0.1 SOL paper**. Current token/pool checks and Devnet entry quotes expire within **60 seconds**; paper exit valuations expire within 10 seconds. Original score-v1 USD evidence remains unavailable on Devnet and can suppress historical alert eligibility. It does not prevent a separate, fresh manual trade assessment. Mainnet's USD policy and stricter quote window are unchanged.

A real review contains a single-signer transaction and a minimum token output at 1% slippage, with a hard maximum SOL input. Fees/rent are estimates; simulation and balance checks run before wallet approval, and the exact signed message is checked and simulated again before broadcast. Only the connected wallet signs. Execution is never automatically replayed. If a response is lost, the recorded signature can be checked with the existing status action: it queries Devnet and updates the attempt after confirmation without sending another transaction. Confirmed output and input amounts come from transaction evidence rather than the original spending cap.

Paper fills and current exit valuations use real Devnet pool math but remain simulated. Neither requests a signature nor moves tokens. Background alerts still require the score-v1 eligibility policy; Devnet's missing USD evidence does not generate a pretend eligible alert.

## Device verification

1. Restart the API after migration, reload the Android app, select Devnet, and sign in. Switching among all three networks should preserve the account session.
2. Fund the connected wallet with **Devnet** SOL and track an address that actually buys tokens on **Devnet PumpSwap**. The earlier Mainnet wallets and transactions do not appear in Devnet. Newly tracked custom wallets appear in Following, as on Mainnet.
3. Open a supported Devnet buy, request a paper quote, confirm its simulated fill, and refresh its exit value.
4. Review a small real purchase, check the Devnet label, approve it in the wallet, then check the Devnet Explorer signature. Mainnet SOL cannot fund this transaction.
5. Switch networks during a review and confirm that the old quote is refused. On Testnet, verify account access and the explicit PumpSwap-unavailable explanation.

Automated fixtures cover network isolation and transaction guards. A live wallet-approved Devnet purchase and visual device verification must still be performed manually.
