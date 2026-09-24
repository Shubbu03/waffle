# DOC.md — waffle official references

Planning references, not proof of integration. Existing provider claims were recorded in Sep 2026 and must be rechecked before implementation. The accepted auth/live delivery design is in [docs/backend-architecture.md](docs/backend-architecture.md).

## Workspace and accepted product decisions
* Bun workspaces: https://bun.sh/docs/pm/workspaces
* Bun project initialization: https://bun.com/docs/runtime/templating/init
* Curated catalog and personal follows: [wallet-selection.md](docs/wallet-selection.md)
* Shared API and live contracts: [shared-contracts.md](docs/shared-contracts.md)
* Database schema and migrations: [database.md](docs/database.md)

## CLOCK IN
* Announcement + rules + prizes + judging: https://solanamobile.com/blog/clock-in-the-solana-mobile-hackathon
* Submit portal mirror: https://solanamobile.radiant.nexus
* dApp Store publish: https://docs.solanamobile.com/dapp-store/submit-new-app

## Solana Mobile + MWA (React Native first-class, Android only)
* RN installation (polyfill, dev build, @wallet-ui/react-native-web3js): https://docs.solanamobile.com/get-started/react-native/installation
* RN quickstart (connect, signIn SIWS, signAndSend): https://docs.solanamobile.com/get-started/react-native/quickstart
* MWA TypeScript reference (transact, authorize, signTransactions, signAndSendTransactions, signMessages): https://docs.solanamobile.com/get-started/react-native/mobile-wallet-adapter
* Expo setup + custom dev build (Expo Go unsupported): https://docs.solanamobile.com/react-native/expo
* Hello world tutorial (transact + authorize + memo): https://docs.solanamobile.com/react-native/hello_world_tutorial
* MWA caution: do not reauthorize inside same transact before sign (stalls Phantom prompt) — builder report, verify on device.

## Helius (free = standard WSS only)
* Pricing (free 1M credits/10rps, gRPC mainnet = Business $499, devnet = Developer $49): https://www.helius.dev/pricing and https://www.helius.dev/docs/billing/plans
* Credits per method (getTransaction=1, getSignaturesForAddress=1, getProgramAccounts=10): https://www.helius.dev/docs/billing/credits
* Rate limits (free RPC 10 req/s total, getProgramAccounts 5/sec, error shape -32005): https://www.helius.dev/docs/billing/rate-limits
* getSignaturesForAddress (backfill; confirmed/finalized only, 1-1000, no ATA txs): https://www.helius.dev/docs/api-reference/rpc/http/getsignaturesforaddress
* LaserStream websockets tiers (standard WSS free, txSubscribe Developer+, gRPC Business+): https://www.helius.dev/blog/laserstream-websockets
* logsSubscribe (mentions = single pubkey per call, commitment processed/confirmed/finalized, 10-min idle, ping/min): https://www.helius.dev/docs/api-reference/rpc/websocket/logssubscribe
* WSS limits (free 5 conns, dev 150, bus 250, pro 1000; 1000 subs/conn): https://www.helius.dev/docs/api-reference/rpc/websocket/llms.txt and https://www.helius.dev/docs/faqs/websockets
* Solana RPC logsSubscribe + getTransaction (log has sig/logs only, fetch tx for deltas): https://solana.com/docs/rpc/websocket/logssubscribe and https://solana.com/docs/rpc/http/gettransaction

## Jupiter Swap V2 (order/execute, needs API key)
* Swap overview (order+execute vs build+submit): https://developers.jup.ag/docs/swap and https://dev.jup.ag/docs/swap
* Order & Execute (taker required for tx, partiallySign for JupiterZ, requestId, expiries): https://developers.jup.ag/docs/swap/order-and-execute
* Execute API (signedTransaction+requestId, codes 0/-1..-2004): https://developers.jup.ag/docs/api-reference/swap/execute
* Get Order API (slippageBps, router ultra/manual, outAmount, priceImpact, excludeRouters, signatureFeePayer, gasless flag, lastValidBlockHeight, expireAt): https://jupiter.mintlify.app/api-reference/swap/order
* Gasless + signatureFeePayer check (drop quotes where signatureFeePayer != taker): https://developers.jup.ag/docs/swap/advanced/gasless
* Portal for API key + rate limits (execute has own bucket: keyless 20 / free 50 / paid 100 RPS): https://developers.jup.ag/portal
* Landing via tx.jup.ag (sendTransaction, 0.001 SOL tip min, skipPreflight true): https://jupiter.mintlify.app/transaction/submit

## Neon Postgres + application auth/live delivery
* Connect from an application: https://neon.com/docs/connect/connect-from-any-app
* Connection pooling: https://neon.com/docs/connect/connection-pooling
* Database branches for migration tests: https://neon.com/docs/introduction/branching
* Native Postgres row security policies: https://www.postgresql.org/docs/current/ddl-rowsecurity.html
* [Backend/auth/live decision](docs/backend-architecture.md): Bun + Hono, Drizzle migrations, SIWS sessions, Postgres outbox, WebSocket, FCM retries, reconnect cursor, and demo budget.
* Hono Bun WebSocket adapter: https://hono.dev/docs/helpers/websocket
* Drizzle migrations: https://orm.drizzle.team/docs/migrations
* SIWS specification and verification flow: https://github.com/phantom/sign-in-with-solana
* FCM retry guidance: https://firebase.google.com/docs/cloud-messaging/error-codes
* Neon free-tier budget: https://neon.com/blog/neon-backend-is-ga
* Cloudflare Quick Tunnel demo access: https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/

## Push (background required — foreground live delivery alone will not wake app)
* Firebase Cloud Messaging official: https://firebase.google.com/docs/cloud-messaging
* React Native Firebase Messaging: https://rnfirebase.io/messaging/usage
* Android notification runtime permission (POST_NOTIFICATIONS, API 33+): https://developer.android.com/develop/ui/views/notifications/notification-permission

## Pyth (same-asset only, no memecoin gap math)
* Push feeds on Solana (sponsored list only, some deprecated Apr 2026): https://docs.pyth.network/price-feeds/core/push-feeds/solana and https://dev-forum.pyth.network/t/deprecation-of-some-pyth-push-feeds-on-solana-april-30th-2026/757
* Use real-time pull + get_price_no_older_than validation: https://docs.pyth.network/price-feeds/core/use-real-time-data/pull-integration/solana

## Reference builds (patterns, not code to copy blindly)
* Helius-level copy-trading WSS+gRPC + multi-sender race: lescasinos/solana-copy-trading-bot (GitHub)
* Rules + optional LLM + DRY_RUN + TELEGRAM HITL: 0xJonaseb11/solana-trading-bot (GitHub)
* Rust live + Python backtest + wallet scoring: yuno-research/solana_copy_trading (GitHub)
* JupiterZ 2-signer trap — use `excludeRouters=jupiterz`, NOT `excludeRfq` (keyed endpoint silently ignores it; single-signer guard `numRequiredSignatures==1`): https://github.com/helium/helium-wallet-rs/pull/558
