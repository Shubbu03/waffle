# PLAN.md — waffle day-by-day plan (24 Sep – 8 Oct 2026)

## Principles
* Paper default. One swap family first. Fixtures before venues. Measure before optimize.
* Commit after each chapter (see AGENT.md). No feature without unit + manual test.
* Hard limits: 10 rps RPC, 5 WSS conns, real copy = metis/dflow/okx only, oracle missing = 0 pts not reject.
* Failure rule: gate red at EOD → fix before next chapter OR explicitly downgrade chapter with documented reason. Buffer is for packaging, not features.

## Thu 24 Sep — M0 C0.1
* Scaffold monorepo, shared package (types, program IDs, score reasons), app-local environment examples when needed, README.
* Typecheck green. Commit.
* Evening: write MILESTONE check-in (what done, what blocked).

## Fri 25 Sep — M0 C0.2
* Neon project + migrations (signals unique(sig,wallet), paper_positions, trade_attempts, push_tokens, watched_wallets, user_wallet_subscriptions).
* config.ts thresholds checked in. Migration up/down + dupe tests. RLS smoke.
* Manual: dashboard shows tables, dupe rejected. Commit. **MS0 gate.**

## Sat 26 Sep — M1 C1.1 (WSS multi-conn)
* 2-3 WSS conns, logsSubscribe mentions 5-10 curated wallets (balanced across connections), ping 60s, backoff, per-conn isolation.
* getSignaturesForAddress backfill (confirmed only), dedupe before fetch, shared 10rps token bucket, stale marking.
* Tests: dedupe, backfill merge, stale, conn isolation, token bucket. Manual: kill one conn. Commit. **Risk: rate limits — drop-if-queue>50 + degraded surface.**

## Sun 27 Sep — M1 C1.2 (classifier)
* getTransaction confirmed + failed-tx invariant (err!=null skip), Family-A only (PumpSwap).
* 5+ redacted real fixtures: buy/sell/fail/transfer/unknown. Fixture replay script.
* Tests green. Manual replay counts match. Commit.

## Mon 28 Sep — M1 C1.3 (score)
* Score v1: critical gates (buy+slot, mint, pool+quote), optional (holders/creator), oracle-none bucket.
* Tests: mint-authority suppress, missing-optional no-inflate, old-slot history-only, missing-oracle no-reject.
* 10-min mainnet dry run → ≥3 buys + reasons distribution + 0 unknown pushes. Commit. **MS1 gate.**

## Tue 29 Sep — M2 C2.1 (API + auth)
* GET /signals (cursor, wallet filter), GET /signals/:id, POST/GET paper-positions, POST /push-tokens.
* Wallet sign-in + single-use nonce/signature verification + sessions per [backend decision](docs/backend-architecture.md); API authorization + Postgres RLS (public signals, owner-only paper/tokens, transaction-scoped identity).
* Public wallet catalog + owner-only follow/unfollow and alert preferences (docs/wallet-selection.md).
* RLS tests + paper validation. Manual curl checks. Commit.

## Wed 30 Sep — M2 C2.2 (live + push)
* API-owned WebSocket delivery filtered by watched wallet + recent N + reconnect cursor; Postgres outbox handoff and backend FCM fanout after commit per [backend decision](docs/backend-architecture.md).
* Android: google-services.json, POST_NOTIFICATIONS (API 33+), graceful denial, Play-Services emulator test.
* Tests: filtered realtime, FCM payload, denial path. Manual: open vs killed app, deny permission. Commit. **MS2 gate.**

## Thu 1 Oct — M3 C3.1 (feed + detail)
* Wallets catalog, follow/unfollow, separate alert toggle; All signals / Following filters.
* Feed row (whale/token/score/age/source), detail (tx link, reasons, status banner), push-tap reloads quote.
* Tests: stale suppressed CTA, unknown holders. Manual: airplane-mode stale. Commit.

## Fri 2 Oct — M3 C3.2 (paper)
* Paper fill from contemporaneous quote-only, simulated badge, positions list.
* Tests: paper math, no-quote-no-paper. Manual: 0.1 SOL on 2 signals. Commit.

## Sat 3 Oct — M3 C3.3 spike (day 1)
* Jupiter /order with `taker=connected` + `excludeRouters=jupiterz`; verify router ∈ {metis,dflow,okx} + `signatureFeePayer==taker` + `numRequiredSignatures==1`.
* MWA signTransactions → /execute; handle all codes; size cap ≤0.05 SOL.
* Verify signing wallet: Phantom vs Seed Vault MWA. Record which works.

## Sun 4 Oct — M3 C3.3 finish (day 2)
* Device real trade on SOL-USDC small size → explorer link or explicit code.
* Unsupported memecoin → `paper only` (acceptable). Tests: router guard, fee-payer guard, sig-count guard, expiry, cap.
* Commit (feature OR honest docs). **MS3 gate.**

## Mon 5 Oct — M4 C4.1 (docs)
* docs/demo.md: repro steps, 3 links, p50/p95 measured, limitations (incl. metis/dflow/okx-only, signing wallet verified).
* Link checker + fixture count. Manual: teammate clean-clone follows with zero help. Commit.

## Tue 6 Oct — M4 C4.1 finish + prep
* Polish README, .env.example completeness, license, fixture list. Latency table from logs.
* Commit. Record raw video takes (signal → scored alert → paper → optional real).

## Wed 7 Oct — M4 C4.2 (build)
* Release APK (versioned), public GitHub (no secrets), <3min video edit, 8-slide deck (problem/demo/arch/score/limits/roadmap).
* Manual: fresh emulator installs APK; video plays clean. Commit `chore(release): clock-in rc1`.

## Thu 8 Oct (buffer to 14:00 UTC) — submit
* Upload APK + GitHub + video + deck to CLOCK IN portal.
* Keep build machine free for re-upload. Confirm portal shows submitted.

## Daily exit criteria (every day)
1. `bun run typecheck && bun run test` green.
2. Manual checklist from AGENT.md gate ticked.
3. Commit pushed with chapter prefix.
4. One-line log in MILESTONE.md: `MSX Cx.y done | blocked: <reason> | next: <chapter>`.
