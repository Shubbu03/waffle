# MILESTONE.md — waffle Seeker to 8 Oct 2026 (detailed)

> How to read: each MS = date window + objective + chapters from AGENT.md + deliverables + auto tests + manual test + commits + exit gate + risks. No MS is done until gate passes. Today = 24 Sep. Deadline = 8 Oct 14:00 UTC buffer.

## MS0 — Bootstrap (24-25 Sep) — done = clean clone builds + DB live

Objective: monorepo + shared types + Neon schema + config so M1-M3 never block on setup.

Chapters: C0.1, C0.2.
Deliverables:
* waffle/ scaffold: apps/mobile, apps/api, apps/watcher, packages/shared, packages/db/migrations, tests/fixtures, docs/, app-local .env.example files when integrations are configured (key names only), README skeleton.
* shared: Signal, ScoreReason, ConfigLimits, ApiSchemas + program IDs (Pump.fun, PumpSwap, Raydium AMM/CPMM/CLMM IDs as constants, no hardcode in watcher).
* Neon: watched_wallets (address, label, active), signals (signature, wallet, mint, slot, observed_at, score_v, reasons JSONB, snapshot JSONB, status, UNIQUE(signature,wallet)), users/push_tokens (user_id, token, platform), paper_positions (id, signal_id, size, quote, fees, ts, simulated=true), trade_attempts (id, signal_id, quote_id, requestId, signature, code, status).
* user_wallet_subscriptions: user_id, watched_wallet_id, alerts_enabled, alerts_enabled_at, created_at, UNIQUE(user_id, watched_wallet_id); owner-only access. Auth challenges, sessions, signal outbox, and push jobs follow [docs/backend-architecture.md](docs/backend-architecture.md). See docs/wallet-selection.md.
* Versioned score v1 config and trade caps from [docs/scoring-policy.md](docs/scoring-policy.md): threshold 70, 150-slot/90-second freshness, $25,000 signal/paper and $75,000 real liquidity floors, 0.1 SOL paper and 0.05 SOL real cap.
Auto tests:
* `typecheck` passes on all workspaces.
* migration on a fresh Neon branch passes.
* shared schema test: invalid signal rejected, reason codes enum-complete.
* unique(sig,wallet) test: dupe insert fails.
Manual test:
* teammate clones, fills app-local environment files when integrations are configured, `bun install && bun run typecheck`, sees tables in Neon dashboard, inserts 1 test signal + 1 dupe (dupe rejected).
Commits:
* `feat(m0): repo skeleton + shared schemas`
* `feat(m0): neon schema + versioned config`
Exit gate: typecheck green + tables visible + dupe test logged. Implement the SIWS/session and request-scoped RLS design in [docs/backend-architecture.md](docs/backend-architecture.md) before C2.1; Neon does not provide these application mechanisms for us.

## MS1 — Watcher live (26-28 Sep) — done = real mainnet buys in Postgres with snapshots

Objective: one swap family end-to-end, no fake pushes, every reject logged with reason.

### 26 Sep — C1.1 WSS plumbing (multi-conn, token bucket)
Work: 2-3 multiplexed Helius standard WSS conns (free = 5 max, balanced subscriptions, conn-failure isolation), logsSubscribe `{mentions:[wallet]}` per wallet (5-10 curated wallets start), commitment `processed` for provisional + `confirmed` fetch path, ping every 60s (10-min idle kill), exponential backoff reconnect per conn, per-wallet backfill priority via getSignaturesForAddress (confirmed/finalized only — processed unsupported; returns 1-1000, no ATA txs), dedupe by (sig,wallet) BEFORE fetch, shared fetch token bucket 10 rps (drop provisional if queue >50, surface degraded), mark stale if stream behind >X slots.
Auto: dedupe test (same event x2 = 1 row), backfill merge test (overlap = no dupes), stale-flag test (gap inject = status=stale, no push), conn-failure isolation test (drop conn 1, conn 2 delivers), token-bucket test (never exceeds 10 rps).
Manual: kill ONE conn 30s, restore, no dupes, other conns still live, stale badge in DB.
Commit: `feat(watcher): multi-conn mentions subs + token-bucket fetch + dedupe + backfill`

### 27 Sep — C1.2 fetch + classify
Work: on log event fetch confirmed getTransaction (max 1 retry + timeout 4s). INVARIANT: `tx.meta.err != null` → skip, never reaches scorer (mentions fires on transfers/fails too). Parse signer/accountKeys/instructions/inner/pre-post balances, classify successful buy on Family-A only (pick ONE: PumpSwap first — verify against 5+ saved real redacted fixtures). Ignore sells, transfers, failed, unknown. Store raw snapshot ref.
Auto: fixture suite — buy passes with mint+amount, sell ignored, failed (err!=null) ignored, unknown program ignored, transfer-only ignored, missing inner handled without throw.
Manual: replay fixtures via `bun run replay -- fixtures/*.json`, counts match expected (e.g. 3 buy / 1 sell-skip / 1 fail-skip / 1 transfer-skip).
Commit: `feat(watcher): confirmed fetch + failed-tx invariant + single-family buy classifier`
Risk: getTransaction rate limit (free 10rps total) — per-wallet queue + 200ms spacing + dedupe-before-fetch + drop-if-queue>50 + surface degraded.

### 28 Sep — C1.3 score v1
Work: score(tx, caches) -> {score, reasons[], status}. Critical (must pass or suppress push): recognized buy + recent slot (<maxAgeSlots), mint state fetched for exact mint, pool+quote available for copy size. Optional (+pts only if fresh): holders/top10, creator %. Pyth: only if same-asset feed exists + freshness policy passes, else `oracle: none` = 0 points for that bucket, NEVER reject-on-missing (most memecoins have no feed — gap check rarely fires by design, score is pool-price-based for those). Threshold 70 + all critical complete.
Auto: mint-authority-present suppresses; missing optional = 0 pts not fail; old slot = history-only; missing oracle = 0 pts not reject; snapshot + score_v persisted.
Manual: 10-min mainnet dry run, review Postgres reasons distribution (expect many `oracle: none`), confirm 0 pushes for unknown formats.
Commit: `feat(watcher): versioned score + suppression rules + oracle-none bucket`
Exit gate MS1: `bun run test:watcher` green + 10-min run yields >=3 real buys persisted with snapshots + 0 crashes on unknown txs.

## MS2 — Live feed (29-30 Sep) — done = phone buzzes open + closed

Objective: API serves cards, live socket + push both work, age/slot visible.

### 29 Sep — C2.1 endpoints + auth
Work: GET /signals (cursor, wallet filter), GET /signals/:id (snapshot+reasons+status), POST /paper-positions (size, signal_id, quote ref), GET /paper-positions, POST /push-tokens. Add public GET /wallets and authenticated GET /wallet-subscriptions, PUT /wallet-subscriptions/:walletId (follow or update alerts_enabled), DELETE /wallet-subscriptions/:walletId (unfollow); only active catalog wallets can be followed. Implement SIWS challenge/verify and sessions per [backend decision](docs/backend-architecture.md). API allows public signal reads; authenticated owner-only access to paper positions/tokens, backed by Postgres RLS with transaction-scoped user identity and a non-owner runtime role.
Auto: RLS tests (anon writes and cross-user subscription access denied, owner allowed), idempotent follows and unfollow preservation, paper validation (size<=cap, signal must exist + fresh).
Manual: curl list/detail as anon, register push token as authed user.
Commit: `feat(api): signals + paper + push-token endpoints`

### 30 Sep — C2.2 live fanout
Work: API-owned WebSocket delivery of committed signals via Postgres outbox per [backend decision](docs/backend-architecture.md) — filter Following by the user's subscriptions (All signals remains public), cap initial history to recent N, recover missed events via cursor on reconnect; backend fanout for fresh, eligible signals to followers with alerts enabled and device permission -> FCM data message {id, score, wallet, mint, slot, age} for background; client tap deep-links and reloads live card + fresh quote. Android: `google-services.json` + `POST_NOTIFICATIONS` runtime permission (API 33+), graceful denial, test on Play-Services emulator (Seeker has them).
Auto: insert test row emits realtime payload (filtered); FCM mock receives id+score; permission-denial path returns "alerts off" not crash.
Manual: device A open gets socket <2s; device B killed gets FCM; both taps land on same card with live age; deny permission once → banner, no crash.
Commit: `feat(api): realtime filter + FCM fanout + notification permission`
Exit gate MS2: two-device demo recorded (screen capture), payloads contain slot + status.

## MS3 — Mobile copy (1-4 Oct) — done = paper complete + one small real traced

Objective: trustworthy card + explicit simulated vs real, no silent swaps.

### 1 Oct — C3.1 feed + detail
Work: public All signals and authenticated Following feeds; Wallets catalog with follow/unfollow and separate alert toggle (see docs/wallet-selection.md); feed row (whale, token, score, age, source slot), detail (explorer tx link, reason list, data_status banner: complete/partial/stale/unknown, degraded notice). Push-tap reloads quote.
Auto: stale renders suppressed CTA; unknown holders renders `unknown`.
Manual: airplane mode shows cached + stale flag, no copy allowed on stale.
Commit: `feat(mobile): feed + detail + staleness`

### 2 Oct — C3.2 paper copy
Work: paper fill from contemporaneous Jupiter quote (no taker = quote-only allowed for paper), store size/fees/slippage/min-out/quote age, badge `simulated`, positions list with entry vs current (manual refresh).
Auto: paper math test, no-paper-without-quote test.
Manual: paper 0.1 SOL on 2 signals, positions show simulated + timestamp.
Commit: `feat(mobile): paper copy`

### 3-4 Oct — C3.3 real copy spike (gated, RFQ excluded)
Spike must pass before promising real in video:
* `taker` = MWA-CONNECTED wallet pubkey (not hardcoded).
* `/order?taker=<connected>&excludeRouters=jupiterz` — REQUIRED: keyed api.jup.ag silently ignores `excludeRfq`; JupiterZ needs taker+MM 2 signers which MWA `signTransactions` (fully signed) can't produce. Accept only `router=metis|dflow|okx`.
* Verify `signatureFeePayer == taker` on every response (gasless MM/sponsor paths → fee payer ≠ taker; drop those quotes).
* Decode tx, guard `numRequiredSignatures == 1` before MWA sign (multi-signer backstop).
* Fresh quote on ONE liquid pair (e.g. SOL-USDC), render impact/fee/min-out/expiry + strict cap (e.g. <=0.05 SOL demo), MWA signTransactions -> /execute {signedTransaction, requestId}, handle codes 0/-1/-2/-3/-1000..-2004, show signature or explicit failure. Never signAndSend for /order, never reuse quote >X secs, never store keys server-side.
* Verify which Android wallet signs (Phantom vs Seed Vault MWA support) — use that in demo; do not claim Seed Vault if it doesn't sign.
Auto: expiry blocked, requestId mismatch surfaces code, cap enforced, non-metis/dflow/okx router rejected, signatureFeePayer != taker rejected, numRequiredSignatures>1 rejected.
Manual (device + funded mainnet wallet, small size): success shows explorer link; unsupported memecoin route shows `unsupported route — paper only` (acceptable, do not fake).
Commit: `feat(mobile): MWA Jupiter order-execute copy (metis/dflow/okx only)` OR `docs: real route unsupported, paper complete` (either is a pass if honest).
Exit gate MS3: paper trail + one real attempt traced to signature OR documented unsupported with paper intact.

## MS4 — Freeze + submission (5-8 Oct) — done = shippable + honest

### 5-6 Oct — C4.1 docs/demo.md
Work: steps to reproduce (env, run watcher/api/mobile, replay fixture), 3 links (signal, push, tx), measured p50/p95 for log_received→scored→published→received→quote→approved→confirmed, limitations list (no win-rates, no latency promise, unsupported venues, Pyth coverage, free-tier 10rps/5 conns, real-copy restricted to metis/dflow/okx, Seed Vault vs Phantom signing verified).
Auto: markdown link checker + fixture count matches docs.
Manual: teammate clean-clone follows demo.md with zero help.
Commit: `docs: demo script + measured latencies + limitations`

### 7 Oct — C4.2 build
Work: release APK (versioned), public GitHub (no secrets, .env.example only), <3min video (mainnet signal -> scored alert -> paper -> optional small real), 8-slide deck (problem, demo, arch, score, limits, roadmap).
Manual: fresh emulator installs APK, video plays, repo README has APK link + setup.
Commit: `chore(release): clock-in rc1`

### 8 Oct (buffer to 14:00 UTC) — submit
Submit APK + GitHub + video + deck to CLOCK IN portal. Keep build machine free for re-upload.
Exit gate MS4: portal shows submitted; docs/demo.md contains real measurements, not estimates.

## Non-goals (V2 only)
Auto TP/SL execution, hosted keys, LLM trading, paid API, Dodo subs, SKR staking, exit automation. Mention as roadmap slide only.

## Progress — 24 September 2026

MS0 C0.1 partial | done: workspace scaffold, shared score/API/live contracts, and schema tests | C0.2 partial: typed Postgres schema, generated migrations, role/RLS SQL, local migration/duplicate tests, and migration environment example | verified: PGlite database tests, shared tests, and workspace typechecks pass | pending: native mobile initialization, Neon branch migration and login-role tests, live Neon API connection checks, WSS watcher ingestion, and live Helius verification. The API foundation now includes Bun/Hono startup, app-local environment validation, restricted-role verification, health checking, request validation, and standard errors; local API tests pass.

Issue #9 RPC scheduler foundation: one watcher client budgets transaction, backfill, token/pool, and program-account calls; bounded retries/timeouts, duplicate suppression, provisional overload status, and local tests are in place. WSS subscriptions and signal classification remain separate work.

Issue #10: catalog-driven subscriptions now run across two or three isolated WSS connections with heartbeat, exponential reconnect, paginated confirmed-history recovery, duplicate suppression, pause handling, and local health status. Automated failure/recovery checks pass. Live Helius failover remains a manual acceptance check; checkpoints are in memory and scored signal persistence remains a later stage.
