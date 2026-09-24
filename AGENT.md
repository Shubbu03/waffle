# AGENT.md — waffle Seeker Build Agent

**Target:** CLOCK IN submission 8 Oct 2026. **Status:** Bun workspace scaffold authorized 24 Sep 2026; Neon DB, curated catalog with personal follows, and backend/auth/live architecture selected. Feature implementation is pending.

**Workflow:** commit messages below are planned checkpoints, not authorization to stage, commit, or push. Browser/UI verification is performed manually by the user.
**Rule:** after each feature -> commit. After each module -> auto tests + manual test. No profit claims. Paper default. Wallet signs every real trade.

## Architecture (WSS, $0, no LLM on hot path)

```text
Solana mainnet → Helius standard WSS logsSubscribe mentions (1 wallet = 1 sub,
                 split across 2-3 conns, NOT one SPOF conn; free = 5 conns max)
                 → confirmed getTransaction + supported swap classifier (skip err != null)
                 → cached pool/token checks + deterministic score v1 (0-100 + reasons + data_status)
                 → Neon Postgres signals + API WebSocket (open app) + FCM (background)
                 → React Native Android feed → paper fill OR fresh Jupiter /order quote (excludeRouters=jupiterz)
                   → MWA signTransactions → /execute
```

Stack: React Native + TS + MWA, Bun 1.3.13 watcher/API + Hono, Neon Postgres + Drizzle ORM/Kit + SIWS opaque sessions + API WebSocket and Postgres outbox ([decision](docs/backend-architecture.md)), FCM, Jupiter Swap V2 order/execute, Helius standard WSS/RPC. Shared TS package for schemas, program IDs, score reasons. No Rust, external queue, custom program, LLM required for MVP.

Hard limits (free tier, verified): RPC 10 req/s total (getTransaction=1 credit, getProgramAccounts=5/sec, getSignaturesForAddress=1 credit, confirmed/finalized only), WSS 5 conns / 1000 subs each, FCM background only. Design around these, never exceed.

Latency is instrumented, not promised: log_received → tx_available → scored → API_published → device_received → quote_ready → wallet_approved → confirmed (p50/p95 in docs/demo.md).

## Decisions and remaining work

* Neon Postgres is selected. No database has been provisioned in this task; the workspace now contains the initial package/folder scaffold only.
* Wallet auth and foreground live delivery are specified in [docs/backend-architecture.md](docs/backend-architecture.md). Implement and verify them in M0/M2; a database insert alone does not reach a device.
* Wallet selection is decided: a curated catalog of 5-10 wallets with personal follows and separate alert preferences. See docs/wallet-selection.md for behavior, schema requirements, and exclusions.
* Score v1 weights, critical checks, freshness, liquidity floors, and paper/real caps are defined in [docs/scoring-policy.md](docs/scoring-policy.md) and the shared package. Watcher evidence collection and mobile/API trade integration remain to be built.
* Bun is selected for workspace/package management and both server runtimes. The API framework, migrations, demo deployment, and free-tier budget are recorded in [docs/backend-architecture.md](docs/backend-architecture.md). Provider limits and swap API behavior require current verification before implementation.

## MODULE M0 — Bootstrap

### C0.1 Repo + shared package
Work: init waffle/ (apps/mobile, apps/api, apps/watcher, packages/shared, db/migrations, tests/fixtures, docs), app-local .env.example files when integrations are configured (key names only), README skeleton, shared types + program IDs + score reasons.
Unit tests: shared schema validation (signal, score reasons, config limits).
Manual: `bun install && bun run typecheck` passes.
Commit: `feat(m0): repo skeleton + shared schemas`

### C0.2 DB + config
Work: Neon project, Drizzle migrations for watched_wallets, signals(sig,wallet,mint,slot,observed_at,score_v, reasons, snapshot, status, unique(sig,wallet)), users/push_tokens, paper_positions, trade_attempts. Add user_wallet_subscriptions(user_id, watched_wallet_id, alerts_enabled, alerts_enabled_at, created_at), UNIQUE(user_id, watched_wallet_id), with owner-only access. Add auth_challenges, sessions, signal_events, and push_deliveries from the [backend decision](docs/backend-architecture.md). One checked-in config.ts for thresholds.
Unit tests: migration up/down, unique constraint violation test.
Manual: insert + dupe rejected in Neon dashboard.
Commit: `feat(m0): neon schema + versioned config`

**Module M0 gate (auto):** typecheck + migration tests green. **(manual):** teammate clones, runs typecheck, sees tables.

## MODULE M1 — Watcher

### C1.1 WSS subscriptions (multi-conn, not SPOF)
Work: 2-3 multiplexed WSS conns (free = 5 max), logsSubscribe `{mentions:[wallet]}` per wallet (5-10 curated wallets, balanced across connections), commitment `processed` for provisional + `confirmed` fetch path, ping every 60s (10-min idle kill), exponential backoff per conn, per-wallet backfill priority queue, dedupe by (sig,wallet) BEFORE fetch, mark stale if stream behind >X slots. Fetch queue = token bucket 10 rps shared across all conns (drop provisional if queue >50, surface degraded).
Unit tests: dedupe (same sig twice = 1), backfill merge (overlap = no dupes), stale flag, conn-failure isolation (drop conn 1, conn 2 still delivers), token bucket does not exceed 10 rps.
Manual: kill one conn 30s, restart, no dupes, other conn still live, stale badge in DB.
Commit: `feat(watcher): multi-conn mentions subs + token-bucket fetch + dedupe + backfill`

### C1.2 Fetch + classify (failed-tx invariant)
Work: on log event fetch confirmed getTransaction (max 1 retry + timeout 4s). INVARIANT: if `tx.meta.err != null` → skip, never reaches scorer (mentions fires on transfers/fails too). Parse signer/accountKeys/instructions/inner/pre-post balances, classify successful buy on Family-A only (PumpSwap first — verify against 5+ saved real redacted fixtures). Ignore sells/transfers/failed/unknown. Store raw snapshot ref.
Unit tests: fixture suite — buy passes, sell ignored, failed (err!=null) ignored, unknown program ignored, missing inner handled without throw, transfer-only ignored.
Manual: replay fixtures via `bun run replay -- fixtures/*.json`, counts match (e.g. 3 buy / 1 sell-skip / 1 fail-skip / 1 transfer-skip).
Commit: `feat(watcher): confirmed fetch + failed-tx invariant + single-family buy classifier`
Risk: getTransaction rate limit (free 10rps total) — per-wallet queue + 200ms spacing + drop-if-queue>50 + dedupe-before-fetch (processed log and backfill can yield same sig).

### C1.3 Score v1
Work: integrate the [versioned score v1 policy](docs/scoring-policy.md) with confirmed classifier output, fetched mint/pool/quote evidence, optional holder/creator/oracle snapshots, and persisted reasons. Critical (must pass or suppress push): recognized buy + recent slot, mint state fetched for exact mint, pool+quote available for copy size. Optional data earns points only if fresh; missing oracle earns zero and never rejects by itself. Threshold 70 + all critical complete.
Unit tests: mint-authority-present suppresses; missing optional = 0 pts not fail; old slot = history-only; missing oracle = 0 pts not reject; snapshot + score_v persisted.
Manual: 10-min mainnet dry run, review Postgres reasons distribution (expect many `oracle: none`), confirm 0 pushes for unknown formats.
Commit: `feat(watcher): versioned score + suppression rules + oracle-none bucket`

**Module M1 gate (auto):** `bun run test:watcher` green. **(manual):** 10-min mainnet run → ≥3 real buys persisted with snapshots, 0 crashes, 0 pushes for unknown/failed.

## MODULE M2 — API + Live

### C2.1 Endpoints
Work: GET /signals (cursor, wallet filter), GET /signals/:id (snapshot+reasons+status), POST /paper-positions, GET /paper-positions, POST /push-tokens. Add public GET /wallets and authenticated GET /wallet-subscriptions, PUT /wallet-subscriptions/:walletId (follow or update alerts_enabled), DELETE /wallet-subscriptions/:walletId (unfollow); only active catalog wallets can be followed. Implement SIWS challenge/verify/logout and opaque sessions per [backend decision](docs/backend-architecture.md). API authorization and native Postgres RLS enforce ownership; set user identity transaction-locally using a non-owner runtime role. Database credentials stay server-side.
Unit tests: RLS denies anon write and cross-user subscription access, allows owner read; following is idempotent, unfollowing preserves shared signals; paper insert validates size.
Manual: curl list + detail, push-token register works.
Commit: `feat(api): signals + paper + push-token endpoints`

### C2.2 Live (API delivery + FCM + permissions)
Work: API-owned Hono/Bun WebSocket delivery from the committed-signal outbox per [backend decision](docs/backend-architecture.md) — filter Following by the user's subscriptions (All signals remains public), cap initial history to recent N, and recover missed events via cursor on reconnect. FCM: only fresh, eligible signals for followers with alerts enabled and device permission; data message {id, score, wallet, mint, slot, age} after commit (background). Android: `google-services.json`, `POST_NOTIFICATIONS` runtime permission (API 33+), graceful denial, test on Play-Services emulator (Seeker has them).
Unit tests: insert emits realtime payload (filtered); FCM payload contains id+score; permission-denial path returns "alerts off" not crash.
Manual: device A open gets socket <2s; device B killed gets FCM; both taps land on same card; deny permission once → no crash, banner shows.
Commit: `feat(api): realtime filter + FCM fanout + notification permission`

**Module M2 gate (auto):** API + RLS tests green. **(manual):** two devices, one open one closed, both alert, denial graceful.

## MODULE M3 — Mobile

### C3.1 Feed + detail
Work: public All signals and authenticated Following feeds; Wallets catalog with follow/unfollow and separate alert toggle (see docs/wallet-selection.md); feed (whale, token, score, age, source), detail (tx link, reasons, data status, degraded banner). Opening push reloads live quote.
Unit tests: stale card renders suppressed CTA; unknown holders renders unknown.
Manual: airplane-mode shows cached + stale flag, no copy on stale.
Commit: `feat(mobile): feed + detail + staleness`

### C3.2 Paper copy
Work: paper fill from contemporaneous Jupiter quote (no taker = quote-only), store size/fees/slippage/min-out/quote age, badge simulated, positions list.
Unit tests: paper math (size*price-fees), cannot paper without fresh quote.
Manual: paper 0.1 SOL on 2 signals, positions show simulated + timestamp.
Commit: `feat(mobile): paper copy`

### C3.3 Real copy via MWA + Jupiter (spike-gated, RFQ excluded)
Spike acceptance BEFORE promising real in video:
* `taker` = the MWA-CONNECTED wallet pubkey (not hardcoded).
* Call `/order?taker=<connected>&excludeRouters=jupiterz` — REQUIRED: keyed api.jup.ag silently ignores `excludeRfq`, and JupiterZ needs taker+MM 2 signers which MWA `signTransactions` (fully signed) cannot produce. Accept only `router=metis|dflow|okx`.
* Verify `signatureFeePayer == taker` on every response (gasless MM/sponsor paths make fee payer ≠ taker; drop those quotes).
* Decode tx: guard `numRequiredSignatures == 1` before MWA sign (backstop against multi-signer routes).
* Fresh quote, render impact/fee/min-out/expiry + strict cap (≤0.05 SOL demo), MWA `signTransactions` → `/execute {signedTransaction, requestId}`, handle codes 0/-1/-2/-3/-1000..-2004, show signature or explicit failure. Never signAndSend for /order, never reuse stale quote, never store keys server-side.
* Verify which Android wallet signs (Phantom vs Seed Vault MWA support) — use that in demo; do not claim Seed Vault if it doesn't sign.
Unit tests: expired quote blocked; requestId mismatch surfaces code; cap enforced; non-metis/dflow/okx router rejected; signatureFeePayer != taker rejected; numRequiredSignatures>1 rejected.
Manual (device + small funded mainnet): SOL-USDC success shows explorer link; unsupported memecoin shows `unsupported route — paper only` (acceptable, do not fake).
Commit: `feat(mobile): MWA Jupiter order-execute copy (metis/dflow/okx only)`

**Module M3 gate (auto):** mobile logic + quote-expiry + router-guard tests green. **(manual):** test wallet completes paper + one small real on supported pair; failures show reason.

## MODULE M4 — Submission hardening

### C4.1 docs/demo.md + fixtures
Work: reproducible steps, links, measured p50/p95 per stage, limitations (no win-rate claims, no latency guarantees, unsupported venues, Pyth coverage, free-tier 10rps/5conns).
Unit tests: docs checklist lints (all links resolve, fixtures count matches).
Manual: teammate follows demo.md clean-clone to push + paper + trace attempt.
Commit: `docs: demo script + measured latencies + limitations`

### C4.2 APK + repo + video + deck
Work: release APK, public GitHub, <3min video (mainnet signal -> scored alert -> paper -> optional small real), short deck.
Manual: fresh emulator installs APK, video plays without private keys.
Commit: `chore(release): clock-in rc1`

**Final gate:** clone -> .env.example -> run watcher/api/mobile -> replay fixture -> real push -> paper -> trace real attempt to success or explicit failure. No manufactured win-rate.

## Cross-cutting invariants (never violate)
1. `meta.err != null` txs never scored. 2. Dedupe before fetch. 3. Oracle missing = 0 pts, not reject. 4. Real copy = excludeRouters=jupiterz + signatureFeePayer==taker + numRequiredSignatures==1. 5. Never exceed 10 rps total. 6. Keys never leave wallet/device. 7. Commit after each chapter.
