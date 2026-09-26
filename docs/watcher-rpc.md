# Watcher RPC scheduler

Issue #9 adds the RPC boundary for the watcher. Create one `WatcherRpc` instance per watcher process with `createWatcherRpc(process.env)` and pass that instance to ingestion and scoring modules. The issue #10 ingestion loop shares this instance across every WSS connection and wallet recovery job.

Copy `apps/watcher/.env.example` to `apps/watcher/.env` when configuring Helius. The executable watcher loads this app-local file and validates its RPC, WSS, database, connection-count, and status-port settings at startup. Keep the URL and API key server-side. The factory validates an HTTPS URL and caps `RPC_REQUESTS_PER_SECOND` at 10 and `RPC_PROGRAM_ACCOUNTS_PER_SECOND` at 5. Defaults match those ceilings. A single scheduler spaces all request starts, including retries, at least 100 ms apart at the default total budget. Program-account requests are also spaced at least 200 ms apart. The configured rates can only be lowered for the current free-tier plan. [Helius lists these two limits for its free tier](https://www.helius.dev/pricing).

Use `queueTransaction(wallet, signature, "provisional")` for log sightings and `backfill(wallet, { before, limit })` for recovery pages. Backfill pages are capped at 50; failed signatures are skipped. A recently classified `(wallet, signature)` returns `duplicate` without another fetch or transaction body. An in-flight duplicate waits for the original fetch: it returns `duplicate` only after successful classification, and propagates an incomplete outcome or error so recovery cannot acknowledge failed work. The recent deduplication cache stores keys only. A `null` transaction is retried once and returns `not-ready`, allowing a later backfill to try again. Transaction results include the wallet and signature so the caller can associate them with its event.

Issue #11 requests `jsonParsed` confirmed transactions and classifies direct PumpSwap buys before returning them to a scorer. A result is `buy` with the observed base-token increase and the instruction's quote limit, or `ignored` with a reason. Failed transactions, sells, other programs, unsupported pairs, ambiguous swaps, and missing ownership or balance evidence never return a buy. Missing inner instructions do not cause an exception because the direct instruction and pre/post balances carry the necessary evidence. Run `bun run --filter '@waffle/watcher' replay` to classify the five checked-in real fixtures without RPC credentials. The catalog watcher consumes these results through its `onEvent` callback.

The classifier's instruction discriminators and account positions come from PumpSwap's [published IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json). The RPC response shape follows Solana's [`jsonParsed` transaction format](https://solana.com/docs/rpc/json-structures). The quote amount in a classified buy is an instruction limit; it is not an observed spend or profit figure.

The raw RPC fixture files are excluded from Biome formatting so replay uses their captured JSON shape; fixture tests still validate their contents.

`getTokenAccount`, `getPoolAccount`, and `getProgramAccounts` use the same scheduler. Provisional fetches have priority, but every fifth dispatch prefers waiting evidence or backfill work. Transient HTTP failures, RPC rate-limit errors, and timeouts receive at most one retry; each attempt has a four-second timeout and consumes another rate-limit slot. The scheduler bounds concurrent calls and the waiting queue. Once a new provisional event would put more than 50 provisional jobs in the queue, it returns `dropped` and exposes `status.degraded` plus `status.droppedProvisional`. Degraded status clears when the provisional backlog drains; the cumulative drop count remains available. The ingestion loop exposes this status and recovers dropped events through periodic confirmed-history scans.

Run `bun run test:watcher` for rate-limit, retry, duplicate, and degradation checks. These tests use fake RPC and socket transports, including one-connection failure and recovery. Live Helius failover remains a manual check.


## Run the catalog watcher

1. Copy `apps/watcher/.env.example` to `apps/watcher/.env` and configure Helius HTTPS/WSS URLs for the **same Solana mainnet network**, plus the required server-side `JUPITER_API_KEY` for [evidence probes](watcher-evidence.md).
2. Use a dedicated database login granted `waffle_watcher`, with no membership in `waffle_api` or `waffle_delivery`. Startup rejects owners, superusers, role creators, and RLS bypass. Apply the existing migrations and seed the catalog first; see [database setup](database.md).
3. Run `bun run dev:watcher` (watch mode) or `bun run start:watcher`.
4. Read `http://127.0.0.1:3002/health` with a local HTTP client. It returns 503 while degraded and 200 when active wallets are caught up. `WATCHER_STATUS_PORT` changes the port; the listener stays on loopback.

The database catalog is polled every 15 seconds. Only `watched_wallets.active = true` addresses receive subscriptions; personal follows do not determine ingestion. New wallets go to the least-loaded connection, preserving existing assignments. Paused wallets are unsubscribed at the next successful refresh, and their late notifications and in-flight results are discarded. A failed catalog refresh retains the last known assignments but marks status stale until a successful refresh. The MVP runtime caps the active catalog at 100 wallets and rejects a larger catalog rather than silently selecting a subset.

`WATCHER_CONNECTIONS` accepts 2 (default) or 3. Each connection sends one `logsSubscribe` per assigned address with `mentions: [address]` and `commitment: processed`, plus one `slotSubscribe`. The subscription format follows [Solana logsSubscribe](https://solana.com/docs/rpc/websocket/logssubscribe); slot notifications follow [slotSubscribe](https://solana.com/docs/rpc/websocket/slotsubscribe). Transaction fetching still requires confirmed commitment.

Each connection sends a native WebSocket ping every 60 seconds, following [Helius keepalive guidance](https://www.helius.dev/docs/rpc/websocket). The implementation uses [Bun's client ping API](https://bun.com/reference/bun/WebSocket), with progressing slot notifications as its liveness check. A stream without slot progress for 30 seconds, a connection/subscription handshake exceeding 15 seconds, or a socket/protocol failure terminates only that connection. Reconnect delay doubles from 1 second to 30 seconds, plus up to 1 second of jitter. The delay resets after 60 seconds of stable connection time.

## Recovery and status

After subscription acknowledgement and every 30 seconds thereafter, each wallet scans confirmed signatures using `getSignaturesForAddress` and its `before` cursor. Pages contain at most 50 signatures, following the [Solana pagination contract](https://solana.com/docs/rpc/http/getsignaturesforaddress). Recovery scans back to the last completed confirmed-history checkpoint, then processes successful signatures oldest first. Failed on-chain signatures are skipped. All RPC work, including discovery and retry attempts, uses the shared scheduler.

Live events never advance the recovery checkpoint. Live and recovery sightings share pending work, and already delivered signatures are remembered separately from the RPC client's short-lived cache. An incomplete fetch, full queue, consumer failure, or lost connection keeps the wallet stale. The next recovery pass retries incomplete work. Consumer callbacks may be asynchronous; a rejected callback retains its result for retry without another transaction fetch. Consumers that perform durable writes must make those writes idempotent by `(wallet, signature)` because a callback could write successfully and then reject.

Status includes each connection's state/slot/retry, each wallet's checkpoint/recovery/error/stale flag, catalog health, and RPC queue/drop metrics. A wallet is stale until subscription and recovery succeed, while its connection is unavailable, or when its connection trails the highest observed connection slot by more than `WATCHER_STALE_SLOTS` (150 by default). Quiet wallets do not become stale just because they have no transactions. A 30-second slot-progress timeout also detects all connections stalling together. Classified events carry `source` and `stale`; a confirmed buy whose transaction slot is beyond the same lag threshold also remains stale even if its socket is current. Downstream scoring/delivery must not alert on stale events.

The process logs status every 30 seconds and reports committed [signal writes](watcher-signals.md) through `watcher.signal`. It persists scored signals with evidence snapshots and an outbox event; API realtime and push delivery remain separate work. Current watcher status is available in memory and through the health endpoint; each signal snapshot records stream health at assessment time.

### Recovery bounds

Checkpoints are currently in memory. On process startup or catalog activation, the watcher bootstraps the most recent 50 confirmed signatures; it does not replay the wallet's lifetime history. Reconnect recovery is capped at 100 pages / 5,000 signatures per scan. An unreachable checkpoint or exhausted history budget exposes `history-gap` and leaves the previous checkpoint intact; it never silently marks the gap recovered. Full process restart recovery and durable checkpoints are separate from socket disconnect recovery.

Each wallet retains up to 10,000 completed signature keys and bounds pending work and undelivered results. RPC overload remains visible and retries via backfill. These bounds suit the initial 5–10 wallet catalog; a larger workload needs measured capacity and persistent recovery before raising them.

### Verification

Automated coverage includes balanced connections, subscription errors/timeouts, heartbeat and exponential backoff, one-connection isolation, multi-page recovery, live/backfill overlap, failed/not-ready fetches, consumer retry, history gaps, slot lag, catalog failure, pausing, and shutdown. Run:

```sh
bun run test:watcher
bun run test:db
bun run typecheck
bun run lint
```

Manual live acceptance (not performed by the coding agent): configure the app-local credentials, start the watcher, and watch `/health` and its structured logs. Use a network proxy to interrupt **one established WSS connection** for 30 seconds. Its wallets should become stale while the other connection keeps delivering. Restore the connection and check recovery completes without duplicate `(wallet, signature)` events. Pause a catalog wallet using an administrative DB session and verify it disappears from health/subscriptions within 15 seconds of a successful catalog refresh. No browser is required.

## Scoring and persistence

The runtime now consumes buy events through the [signal pipeline](watcher-signals.md). It saves the v1 score, reasons, evidence snapshot, source slot, and status once per signature/wallet, with an atomic outbox event. Failed writes remain retryable; successful duplicate retries leave the original signal unchanged. `watcher.signal` replaces the earlier buy-only evidence log.
