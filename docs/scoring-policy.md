# Score v1 and trade limits

Accepted for issue #2 on 24 September 2026. The executable source of truth is [`scorePolicyV1`](../packages/shared/src/scoring/config.ts), used by [`scoreSignal`](../packages/shared/src/scoring/score.ts) and [`checkTradeLimits`](../packages/shared/src/scoring/trade-limits.ts). These thresholds are conservative MVP starting values, not calibrated predictions of profit or safety. Persist `scoreVersion`, points/reasons, and the evidence snapshot with every scored signal. A later adjustment must create v2 so historical cards retain their original meaning.

## Points

| Evidence | Points | Rule |
| --- | ---: | --- |
| Successful supported-family buy | 20 | Confirmed transaction, no `meta.err`, classified as the supported buy. |
| Fresh signal | 15 | At most 150 slots and 90 seconds old. Both checks must pass. |
| Mint state | 20 | Exact mint, original SPL Token Program, fetched within 60 seconds, no mint or freeze authority. Token-2022 is unsupported in v1. |
| Pool | 15 | Exact token paired with wrapped SOL, fresh within 15 seconds, verified liquidity at least $25,000. |
| Probe quote | 10 | Fresh within 10 seconds, SOL-to-exact-mint, positive output for at least 0.05 SOL input. This is an availability check; the user action needs a new quote. |
| Top ten holders | 8 | Optional, fresh within five minutes, combined share at most 30%. |
| Creator holding | 7 | Optional, fresh within five minutes, holding at most 5%. |
| Same-asset oracle | 5 | Optional, fresh within 10 seconds, price deviation at most 300 basis points. A missing or mismatched Pyth feed earns zero. |
| **Maximum** | **100** | Critical evidence alone totals **80**, so the alert threshold of **70** is reachable without holder, creator, or oracle data. |

Critical failure suppresses alerts even if the numeric score exceeds 70. An old signal is history-only. A fresh, same-asset oracle deviation above 1,000 basis points suppresses alerts; no oracle and stale oracle data simply earn zero. A deviation from 301 through 1,000 basis points earns zero without suppression. Each result includes reason codes and points, so missing optional data remains visible as missing and cannot inflate the score. The feed can still show suppressed/history-only signals with their status; no alert or copy action should be offered from stale evidence.

The mint checks follow [Solana's mint and freeze authority model](https://solana.com/docs/tokens/basics). Restricting v1 to the original token program avoids silently accepting [Token-2022 extensions](https://solana.com/docs/tokens/extensions) that need separate handling. The $25,000/$75,000 liquidity floors, percentage cutoffs, and freshness windows are product policy choices, not values asserted by those sources. Validate the liquidity source and these cutoffs against saved mainnet fixtures and observed reject distributions before expanding the catalog.

## Trade gate

Amounts are integer lamports, never floating-point SOL:

| Mode | Maximum size | Minimum current pool liquidity |
| --- | ---: | ---: |
| Paper | 100,000,000 lamports (0.1 SOL) | $25,000 |
| Real demo | 50,000,000 lamports (0.05 SOL) | $75,000 |

The pool liquidity snapshot must be no older than 15 seconds at the attempted action. Reject zero/negative sizes and missing, non-finite, or stale liquidity. The app should call the shared gate before showing a confirmation; the API must apply the same gate to mutable requests using fresh server evidence. A paper fill still needs a contemporaneous quote. A real trade also needs a new Jupiter order, current quote/expiry, router allowlist, fee-payer match, single-signer check, and wallet approval from [AGENT.md](../AGENT.md). A score or earlier quote alone never authorizes a trade.

## Implementation boundary

The current repository has the pure policy, scorer, trade gate, and tests. The watcher now fetches and caches [mint, pool, and quote evidence](watcher-evidence.md), returns explicit optional-data status, and supports fresh same-asset Pyth feeds. The watcher now [persists scored signals and an atomic outbox event](watcher-signals.md), including transaction-age and stream-health checks at persistence time. The mobile app and API have not yet wired this gate into trade actions. Record actual score distributions and rejection reasons during live acceptance, then version any policy change rather than editing v1 in place. Device and mainnet behavior require the user's manual verification under the project workflow.
