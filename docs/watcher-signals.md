# Scored signal persistence

Issue #14 connects classified buys and token evidence to the versioned scorer and database. `bun run start:watcher` now writes signals using the existing restricted `waffle_watcher` login. No new migration or environment variable is required. See [watcher setup](watcher-rpc.md) and [evidence configuration](watcher-evidence.md).

## Assessment

`SignalPipeline` revalidates the raw confirmed transaction before enrichment. Failed transactions, sells, transfers, and unsupported instructions do not reach scoring or persistence. Successful direct PumpSwap buys collect the existing mint, pool, quote, and optional evidence.

The watcher preserves the original observation timestamp and source across persistence retries. After enrichment, local write queuing, and database lock acquisition, the pipeline checks the current clock, head slot, and wallet stream health again. Signal freshness requires all of:

- At most 150 slots of lag, with the head at or above the transaction slot.
- An observation no older than 90 seconds.
- A known transaction block time no older than 90 seconds and not in the future.
- A healthy wallet stream, both when delivered to the pipeline and when assessed.

Old backfills cannot gain freshness from a recent fetch. Missing transaction time fails the freshness check. A stale signal with otherwise passing critical checks is `history-only`; failed critical evidence is `suppressed`. Only `eligible` signals meeting the v1 threshold can be considered for alerts. Current mint authority, freeze authority, shallow/missing pools, unavailable quotes, and excessive same-asset oracle deviation suppress eligibility. Missing optional holder/creator/oracle data contributes zero points; fresh critical checks alone score 80. The [v1 weights and thresholds](scoring-policy.md) remain unchanged.

Each signal stores the score version, score, ordered reason buckets, source slot, observation time, status, and snapshot. The snapshot retains known unsafe or stale values and their original timestamps. Its `assessment` also records scoring time, transaction time, source, stream health, and each evidence bucket's freshness, expiry, or unavailable reason. Amounts remain decimal strings. Older stored snapshots without this metadata remain readable.

`dataStatus` describes availability separately from safety: stale signal/critical evidence is `stale`; missing critical evidence is `unknown`; missing or stale optional evidence is `partial`; all current observations are `complete`. A complete snapshot can still be suppressed for an unsafe mint or other failed policy check.

## Atomic and idempotent writes

The database adapter serializes short write transactions in each watcher. A shared transaction advisory lock serializes these writes across watcher processes before outbox sequence allocation, so committed outbox IDs follow writer commit order. Enrichment and provider requests happen outside these transactions. An active-wallet row lock prevents catalog pausing from racing past the persistence check; paused or removed wallets are skipped.

The transaction inserts `signals` with `ON CONFLICT (signature, wallet_id) DO NOTHING`. An inserted signal gets exactly one `signal_events` row in the same transaction. Any outbox failure rolls everything back. A duplicate keeps its original score/snapshot and creates no new event. The transaction also advances catalog supported activity using the original transaction time, never moving it backwards during backfill.

Persistence failures propagate to watcher recovery, which retains undelivered outcomes for retry. Shutdown stops ingestion, cancels RPC work, drains accepted signal processing, then closes the database. The `watcher.signal` log is emitted after the transaction commits and reports `inserted` with IDs, `duplicate`, or `inactive-wallet`.

The outbox includes eligible, suppressed, and historical signals for later feed delivery. API realtime/FCM dispatch remains a separate issue: delivery must recheck age, eligibility, active catalog membership, and user alert settings at dispatch time. An outbox row alone never authorizes an alert or trade.

## Verification

Run `bun run test:shared`, `bun run test:watcher`, `bun run test:db`, and `bun run typecheck`. Tests cover authority suppression, missing optional/oracle data, transaction age, stream health, evidence expiry during write queuing, preserved retry timestamps, and shutdown draining. PGlite runs the actual persistence SQL under `waffle_watcher`, checking duplicate races, independent wallet identities, atomic rollback, paused wallets, and monotonic activity timestamps. PGlite serializes its transactions; these checks do not replace live multi-connection Neon verification.

Manual acceptance: configure the watcher against a disposable Neon branch with active catalog wallets, observe a supported live buy, and inspect its `signals` row plus corresponding `signal_events` row. Replay/recover the same signature and verify counts remain one per wallet. Confirm suppressed/history-only rows stay ineligible and optional absence stays explicit. Live Helius/Jupiter/Pyth and Neon behavior have not been verified by these local tests.
