# Score v1 and trade limits

Accepted for issue #2 on 24 September 2026. The executable source of truth is [`scorePolicyV1`](../packages/shared/src/scoring/config.ts), used by [`scoreSignal`](../packages/shared/src/scoring/score.ts) and [`checkTradeLimits`](../packages/shared/src/scoring/trade-limits.ts). These thresholds are conservative MVP starting values, not calibrated predictions of profit or safety. Persist `scoreVersion`, points/reasons, and the evidence snapshot with every scored signal. A later adjustment must create v2 so historical cards retain their original meaning.

## Points

| Evidence | Points | Rule |
| --- | ---: | --- |
| Successful supported-family buy | 20 | Confirmed transaction, no `meta.err`, classified as the supported buy. |
| Fresh signal | 15 | At most 150 slots and 90 seconds old. Both checks must pass. |
| Mint state | 20 | Exact mint, SPL Token **or Token-2022** base layout, fetched within 60 seconds, no mint or freeze authority. Token-2022 extensions (transfer fees/hooks) are not evaluated in v1. |
| Pool | 15 | Exact token paired with wrapped SOL, fresh within 15 seconds, verified liquidity at least $25,000. |
| Probe quote | 10 | Fresh within 10 seconds, SOL-to-exact-mint, positive output for at least 0.05 SOL input. This is an availability check; the user action needs a new quote. |
| Top ten holders | 8 | Optional, fresh within five minutes, combined share at most 30%. |
| Creator holding | 7 | Optional, fresh within five minutes, holding at most 5%. |
| Same-asset oracle | 5 | Optional, fresh within 10 seconds, price deviation at most 300 basis points. A missing or mismatched Pyth feed earns zero. |
| **Maximum** | **100** | Critical evidence alone totals **80**, so the alert threshold of **70** is reachable without holder, creator, or oracle data. |

Critical failure suppresses alerts even if the numeric score exceeds 70. An old signal is history-only. A fresh, same-asset oracle deviation above 1,000 basis points suppresses alerts; no oracle and stale oracle data simply earn zero. A deviation from 301 through 1,000 basis points earns zero without suppression. Each result includes reason codes and points, so missing optional data remains visible as missing and cannot inflate the score. The feed can still show suppressed/history-only signals with their status; no alert is sent from stale evidence. Manual trade review uses a separate current assessment as described below.

The mint checks follow [Solana's mint and freeze authority model](https://solana.com/docs/tokens/basics). V1 accepts both the original SPL Token program and Token-2022, because PumpSwap now launches Token-2022 mints; both share the same 82-byte base layout, and the no-authority requirement is unchanged. [Token-2022 extensions](https://solana.com/docs/tokens/extensions) (transfer fees, transfer hooks) are **not** evaluated, so a Token-2022 mint with a transfer fee still earns mint points — a documented v1 limitation to revisit in v2. The $25,000/$75,000 liquidity floors, percentage cutoffs, and freshness windows are product policy choices, not values asserted by those sources. Validate the liquidity source and these cutoffs against saved mainnet fixtures and observed reject distributions before expanding the catalog.

## Trade gate

Amounts are integer lamports, never floating-point SOL:

| Mode | Maximum size | Minimum current pool liquidity |
| --- | ---: | ---: |
| Paper | 100,000,000 lamports (0.1 SOL) | $25,000 |
| Real demo | 50,000,000 lamports (0.05 SOL) | $75,000 |

The pool liquidity snapshot must be no older than 15 seconds at the attempted action. Reject zero/negative sizes and missing, non-finite, or stale liquidity. The API applies this gate to a new server-side assessment for each requested trade; mobile shows the returned current liquidity before confirmation. A paper fill still needs a contemporaneous quote. A real trade also needs a new Jupiter order, current quote/expiry, router allowlist, fee-payer match, single-signer check, and wallet approval from [AGENT.md](../AGENT.md). A score or earlier quote alone never authorizes a trade.

## Manual trade assessment v1

Manual review is separate from historical score v1. Signal age, slot distance, original suppression/history status, and original stream health remain unchanged in the saved score and still govern alerts. They do not permanently prevent a manually requested trade on an older confirmed supported buy.

On each paper quote or real order request, the API authenticates the owner, loads the saved signal, and re-fetches its confirmed transaction. The shared PumpSwap classifier must verify success, watched signer, mint, slot, and pool. The API then reads current mint and pool/vault accounts, values current SOL reserves, checks mint/freeze authorities, and applies the mode's size cap and liquidity floor. A configured fresh same-asset Pyth deviation above 1,000 basis points still blocks. Missing optional holder, creator, or oracle data does not block; Token-2022 extensions remain an explicit limitation. This flow does not recalculate or rewrite the original score.

The new Jupiter quote/order is for the exact requested size and mint. Its response contains an `assessment` (manual policy version 1, mode, size, mint, pool liquidity, timestamps, and oracle availability), separate from the signal snapshot. The API bounds the review's expiry by both quote and evidence deadlines, checks after provider latency, and checks again before a paper fill or real broadcast. Expired reviews require another request, which reruns current checks. No trades are automatically retried or signed. Real transaction signatures, message integrity, allowed router, authenticated taker/fee payer, and single-use execution guards remain mandatory.

Current assessment needs `HELIUS_RPC_URL` and `JUPITER_API_KEY` in `apps/api/.env`; missing providers return 503 without falling back to old snapshots. Optional `PYTH_API_KEY` and `PYTH_PRICE_FEEDS_JSON` configure the same Pyth integration used by the watcher. API activity validation and trade reads share one bounded RPC scheduler. When API and watcher use the same Helius key, set their `RPC_REQUESTS_PER_SECOND` values so the **combined** budget stays at most 10 (for example API 2, watcher 8). The API uses one concurrent RPC request, leaving four connections for the watcher. Provider quotas apply across processes and deployments; the per-process schedulers cannot enforce an account-wide total.

## Implementation boundary

The watcher uses the shared `packages/market-data` account validation, classifier, evidence collector, and RPC scheduler, and persists immutable scores plus an atomic outbox event. API paper and real review use the same validation code with newly collected evidence. Paper fills persist the complete quote and assessment; real reviews are owner-bound and held until execution or expiry. Restarting the API invalidates unexecuted reviews and requires a new quote. Automated tests cover historical review, current unsafe/missing evidence, limits, expiry, ownership, and no broadcast after expiry. Device wallet approval and funded mainnet execution remain manual acceptance checks.
