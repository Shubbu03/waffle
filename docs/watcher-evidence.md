# Token and pool evidence

Issue #13 adds `TokenEvidenceCollector` in `apps/watcher/src/evidence.ts`. The executable watcher calls it for confirmed PumpSwap buys. Each result has separate mint, pool, quote, holder, creator, and oracle evidence; the [signal pipeline](watcher-signals.md) scores and persists these observations. `toScoreEvidence(checks, nowMs)` converts only usable observations into the existing score v1 input shape.

## Configuration

Use the watcher’s app-local `.env`:

```dotenv
JUPITER_API_KEY=replace-me
WATCHER_COPY_SIZE_LAMPORTS=50000000
PYTH_API_KEY=
PYTH_PRICE_FEEDS_JSON={}
```

`JUPITER_API_KEY` is now required for watcher startup. The probe defaults to 0.05 SOL; the supported configured range is 0.05–0.1 SOL, matching score v1’s minimum probe and paper maximum. Amounts remain integer lamports. These are quote-only requests: no taker, wallet signature, or transaction execution. A cached probe cannot authorize a user trade.

Pyth is optional. `PYTH_PRICE_FEEDS_JSON` is a trusted server-maintained mapping from **exact Solana mint addresses to verified USD-denominated Pyth feed IDs**. It defaults to an empty object. Audit each mapping against the feed’s underlying asset before enabling it; neither token symbols nor SOL proxy feeds establish token identity. Provider responses must return the configured feed ID. Keep both API keys server-side.

Pyth’s current [Hermes authentication guide](https://docs.pyth.network/price-feeds/core/upgrade/preparing) requires an API key. The client uses its documented `https://pyth.dourolabs.app/hermes` endpoint with a Bearer header. Missing configuration produces `oracle: { source: "none", reason: ... }` without making a Pyth request.

## Sources and validation

### Exact mint

The collector requests the classified mint’s account at confirmed commitment, through the existing shared RPC scheduler. It checks the original SPL Token Program owner, the [82-byte mint layout](https://github.com/solana-program/token/blob/main/interface/src/state.rs), initialization, supply, decimals, and both authority option fields. Authorities are returned accurately; an authority-bearing mint remains known data and is rejected by the existing score policy. Token-2022 and malformed accounts remain unknown/unsupported in v1.

### PumpSwap liquidity

The collector reads the specific classified pool, validates its PumpSwap owner/discriminator, recomputes its PDA, and verifies its exact base mint and wrapped-SOL quote mint against the [published PumpSwap IDL](https://github.com/pump-fun/pump-public-docs/blob/main/idl/pump_amm.json). It then reads the pool, mint, and both vaults in one confirmed [`getMultipleAccounts`](https://solana.com/docs/rpc/http/getmultipleaccounts) snapshot. The minimum context slot prevents reading an account snapshot older than the buy; vault references must still match the discovery response.

Vaults must be initialized original SPL token accounts, owned by the pool PDA, with the expected mints and no delegate or close authority. Empty pools, unsupported pool modes (mayhem or nonzero virtual reserves), mismatched vaults, and malformed data produce unknown evidence. Raw reserves remain decimal strings; floating-point values are used only for USD estimates.

SOL/USD comes from [Jupiter Price V3](https://developers.jup.ag/docs/price), which returns its source block ID. The shared RPC scheduler fetches that block’s timestamp; the price must be less than 10 seconds old and not from the future. No fresh SOL price means no fresh USD liquidity estimate. This pricing source is independent of the token’s optional Pyth oracle.

For a supported constant-product token/SOL pool:

- Pool spot price = quote SOL reserve × SOL/USD ÷ base token reserve.
- Total liquidity USD = 2 × quote SOL reserve × SOL/USD, valuing both sides at that pool spot price.

This is reserve value, not guaranteed executable exit liquidity or proof against market manipulation. The separate Jupiter probe checks route availability at the configured size. Pool evidence retains raw reserves and the RPC context slot for inspection.

### Probe quote

The collector reuses `@waffle/jupiter`, the server-only service originally implemented in #12. The API re-exports that same implementation. Quotes are keyed by exact mint and amount, must match wrapped SOL input and the configured size, and retain the complete paper quote: request ID, route, fees, impact, minimum output, timestamps, and expiry. The probe’s `signalId` is a temporary correlation UUID, not a persisted signal ID. Later paper/real actions must obtain their own fresh quote linked to their actual signal.

### Holder and creator data

The default runtime returns `unknown` with `holder-distribution-unavailable` and `creator-attribution-unavailable`. It does not label the largest token accounts as the top ten wallet owners, infer a creator from mint/pool authority, or replace missing percentages with zero.

Collector integrations can supply authoritative `getHolders` and `getCreator` sources. Their responses must include the exact mint, a percentage in [0, 100], and the original measurement timestamp. Owner aggregation and creator attribution are those sources’ responsibilities. Missing, mismatched, future, or stale data earns no points through `toScoreEvidence`.

### Optional same-asset oracle

Only a configured exact-mint feed is queried. The response ID must match, price must be positive and finite, confidence must be within 1% of price, and `publish_time` must be less than 10 seconds old and not in the future. Cache reads never replace publish time with the current time. Requests are limited to one start per second; rate-limited or unavailable optional data returns none.

With a fresh verified pool valuation and fresh same-asset feed, deviation is the absolute difference between pool spot USD and Pyth USD divided by Pyth USD, in basis points. The original publication time and the earlier dependency expiry are retained. All other cases return `source: "none"` with a reason. SOL/USD used to value reserves never earns the token’s oracle points. Missing oracle alone does not suppress a signal; the critical evidence can still earn 80 points.

## Freshness, caching, and failures

Every non-oracle field returns either `{ status: "fresh" | "stale", value, fetchedAtMs, expiresAtMs }` or `{ status: "unknown", reason }`. Freshness is rechecked after all parallel work finishes and again when converting to score input.

| Evidence | Maximum age |
| --- | --- |
| Mint | 60 seconds |
| Pool | 15 seconds, shortened to the SOL price expiry |
| Quote | 10 seconds, shortened to provider expiry |
| Holder / creator | 5 minutes from source measurement |
| Pyth / SOL price | 10 seconds from publication/block time |

Each resource cache holds at most 256 entries and 256 pending keys, shares concurrent requests, clones returned values, and evicts older entries. Failed refreshes preserve previous timestamps and stale evidence; first failures return unknown. Failed/unknown results have a two-second retry cooldown. All Solana reads, including account snapshots and block timestamps, consume the existing 10 requests/second budget. External requests have deadlines, fixed HTTPS hosts, bounded response bodies, and redirects disabled. Provider bodies, credentials, and raw exceptions are not included in evidence errors.

## Verification

Run `bun run test:watcher`, `bun run test:api`, and `bun run typecheck`. Tests use synthetic binary accounts and injected transports; they cover authority and owner validation, pool PDA/mint/vault mismatches, unsupported modes, shared cache loads, stale refreshes, exact quote size, optional-data timestamps, oracle identity/freshness, and the shared RPC path. No live trade is executed.

Manual verification remains: configure credentials, run `bun run start:watcher`, and inspect the `watcher.signal` insertion logs and stored snapshot evidence statuses. Compare a known live mint/pool with an explorer and confirm unavailable optional data is shown honestly. [Scored-signal persistence](watcher-signals.md) is wired by #14; user trade integration remains pending.
