# API runtime

Issue #5 adds the Bun/Hono API foundation. The public health route is `GET /health`: it returns `{ "status": "ok" }` after a database ping, or a `SERVICE_UNAVAILABLE` error with HTTP 503. Unknown routes and validation failures use the shared `apiErrorSchema` envelope and include `requestId`; the same ID is in the `X-Request-ID` response header. JSON body and query validators are available for later feature routes. Issue #15 adds wallet authentication and session-scoped owner transactions below. Issue #16 adds the wallet catalog and signal read routes below; trading routes remain separate work.

Issue #12 adds the [Jupiter quote and execution service](jupiter.md). Issue #18 exposes its paper quote path; issue #26 exposes owner-checked real order and attempt routes.

Issue #19 adds [foreground WebSocket delivery](live-delivery.md) at `GET /live`, with a separate optional `DELIVERY_DATABASE_URL`, bounded history, current Following filters, and cursor recovery. When enabled, `/health` also reports live connection count, degraded status, and last successful poll time.

Issue #20 adds authenticated `POST /push-tokens` and `DELETE /push-tokens/:id`, plus optional FCM dispatch. See [push alerts](push-alerts.md) for credential setup, response shapes, eligibility, and device integration.

## Local setup

1. Apply the [database migrations](database.md) to a disposable Neon branch. Create a separate login role with only membership in `waffle_api`; it must not own app tables or have superuser, `BYPASSRLS`, or `CREATEROLE` privileges. The API checks this on startup and refuses a privileged credential.
2. Copy `apps/api/.env.example` to `apps/api/.env` and fill in that login's Neon connection URL and `AUTH_URI`, the public HTTPS identity shown by the wallet. Its host becomes the SIWS domain; use the current tunnel URL for a demo. Keep `sslmode=require` or `sslmode=verify-full` in the URL. The API loads this app-local file; `packages/db/.env` is only for migrations.
3. From the repository root, run `bun install --frozen-lockfile`, then `bun run dev:api` for watch mode or `bun run start:api` for a single run. `API_HOST` defaults to `127.0.0.1`, and `API_PORT` defaults to `3000`.
4. Request `GET http://127.0.0.1:3000/health` to confirm that the API can query Neon. `bun run test:api` runs the local API tests without credentials.

The environment file is ignored by Git. Keep the connection URL on the server; never copy it into `apps/mobile`. Live Neon connectivity and login privileges still need checking with a configured Neon branch.

## Wallet and signal reads

| Route | Access | Result |
| --- | --- | --- |
| `GET /wallets` | Public | `{ items }` with catalog ID, address, label, inclusion reason, tracking status, and recent supported activity. Paused wallets remain visible. |
| `GET /signals` | Public for `view=all` (default); bearer session for `view=following` | `{ view, direction, items, nextCursor, hasMore }` with signal summaries. |
| `GET /signals/:id` | Public | Signal summary plus all persisted score reasons and the complete evidence snapshot. Invalid UUIDs return 400; unavailable signals return 404. |

List queries accept only `view=all|following`, `direction=before|after`, `cursor`, `limit=1..50` (default 50), and `walletId` (catalog UUID). Duplicate or unknown parameters, including supplied owner IDs, return 400. Following derives ownership from the bearer session and queries subscriptions inside its transaction with RLS. Wallet filtering narrows that set; it cannot include another user's follows. Following works independently of alerts, and its responses use `Cache-Control: no-store`.

Pages use committed outbox event IDs, represented as exact decimal strings even above JavaScript's safe integer range. `before` selects IDs strictly below the cursor in descending order; without a cursor it returns the newest page. `after` selects IDs strictly above the cursor in ascending order; without a cursor it starts at the oldest retained event. Follow and wallet filters apply before the page limit. The API reads one extra matching row to determine `hasMore`. `nextCursor` is the last returned event ID, including on a terminal nonempty page; empty pages return `null`. Continue paging only while `hasMore` is true. For reconnect after loading descending history, retain the highest applied event ID separately from the older-history pagination cursor.

A supplied cursor below the oldest globally retained event returns HTTP 409 with `CURSOR_EXPIRED`. A supplied cursor with an empty outbox also returns that error because its history cannot be recovered. The retention bound is global, so an empty filtered result does not itself expire a valid cursor. Gaps within retained IDs are allowed. Retention bounds and page rows are read in one database statement. Clients should reload a recent page and show a history gap after `CURSOR_EXPIRED`.

All persisted statuses remain visible: eligible, history-only, and suppressed. Pausing or unfollowing a wallet does not delete public history. Reads neither rescore old evidence nor claim it is still fresh; details preserve the original timestamps, reasons, amounts, optional unknowns, and assessment. Only signals with retained outbox events are exposed by these routes. Responses are checked against the shared schemas; invalid stored data produces a safe internal error.

### Catalog setup and verification

The reviewed five-wallet seed from #7 is reused without changing its addresses or review claims. From the repository root:

```sh
bun run db:seed
# After configuring packages/db/.env with the migration-owner DB_URL:
bun run db:seed:apply
```

The first command is a credential-free dry run. Apply is an explicit administrative operation, never API startup work: the API role has no catalog write grant. Reapplying preserves catalog IDs, refreshes reviewed metadata, and marks removed entries inactive. No live database was seeded during this implementation.

`bun run test:api` seeds the catalog twice in migrated PGlite and exercises the actual queries under a non-owner role granted `waffle_api`. Tests cover bidirectional pagination, large IDs, gaps, inserts between pages, filters, paused history, full detail snapshots, unknown IDs, validation, expired cursors, and anonymous/expired/revoked/cross-user Following access. Live Neon connectivity and concurrent retention behavior still require manual acceptance.

With the API running, manually request `/wallets`, `/signals?limit=2`, the returned `nextCursor` page, and `/signals/:id`. Verify Following using two signed-in wallets with different stored subscriptions, including a wallet filter outside the current user's follows. Follow mutation endpoints are described below.

## Follows and alert preferences

Issue #17 adds these owner-only routes. Each requires `Authorization: Bearer <accessToken>` and uses the session's user ID inside the existing owner transaction and forced RLS policies. All responses use `Cache-Control: no-store`.

| Route | Request | Result |
| --- | --- | --- |
| `GET /wallet-subscriptions` | No query parameters | `{ items }` with only the current user's follows, ordered by creation time and wallet ID. Includes paused wallets. |
| `PUT /wallet-subscriptions/:walletId` | JSON `{}` or `{ "alertsEnabled": true/false }` | 200 with the resulting subscription; creates a follow or updates its alert preference. |
| `DELETE /wallet-subscriptions/:walletId` | No body or query parameters required | 204 whether the current user's follow existed or was already absent. |

`walletId` is a catalog UUID. A PUT for a nonexistent wallet returns 404. New follows default to alerts off; setting `alertsEnabled: true` explicitly opts in. Omitting the field on an existing follow preserves its preference. Repeated requests preserve `createdAt` and an unchanged `alertsEnabledAt`. The database sets the opt-in timestamp only when alerts change from off to on, clears it on mute, and assigns a new timestamp on re-enable. Clients cannot provide either timestamps or owner IDs. Invalid/extra fields and query parameters return 400; PUT requires `application/json`, with a 4 KiB body limit.

Paused wallets reject new follows and off-to-on alert changes with 409 `CONFLICT`. Existing follows remain readable and removable. An omitted preference or repeated existing preference is idempotent; muting an existing paused follow is allowed. Existing enabled preferences remain stored, but future push delivery must still require an active wallet. Paused updates never use an insert path. Active follow creation rechecks catalog activity in its insert statement, and the unique user/wallet key resolves overlapping retries without duplicate subscriptions.

Unfollowing deletes only the session owner's subscription. It does not delete catalog wallets, shared signals, outbox events, or another user's follow, and it does not stop catalog monitoring. The Following feed immediately reflects the current subscription set. Refollowing starts with alerts off unless explicitly enabled again. A preference is not proof of notification permission or push delivery; device registration and delivery remain separate work.

`bun run test:api` verifies these routes using the actual SQL under a restricted `waffle_api` member role in migrated PGlite. Coverage includes default/explicit opt-in, timestamp transitions and retries, overlapping follows, paused and unknown wallets, anonymous/expired/revoked sessions, owner injection, RLS isolation, rollback, and preservation of shared history and other users' subscriptions. PGlite serializes transactions; live multi-connection PostgreSQL concurrency remains a manual check.

Manual acceptance with two wallet sessions: follow the same active catalog wallet, enable and mute alerts for one user, repeat the PUTs and compare timestamps, then unfollow twice. Confirm the other user's follow and public signal detail remain unchanged. Pause the catalog wallet using the administrative workflow and confirm that new follows/opt-ins fail while an existing follow can still be muted or removed.

## Wallet authentication

| Route | Request | Result |
| --- | --- | --- |
| `POST /auth/challenge` | No parameters required | `{ challengeId, signInInput }` for wallet MWA `signIn`. |
| `POST /auth/verify` | JSON matching `authVerifyRequestSchema`: `challengeId`, `accountAddress`, `signedMessageBase64`, `signatureBase64` | `{ session, accessToken }`; invalid, expired, or consumed challenge returns 401. |
| `GET /auth/session` | `Authorization: Bearer <accessToken>` | `{ session }` with user ID, wallet address, and expiry; invalid sessions return 401. |
| `POST /auth/logout` | Same authorization header | 204 after revoking that session; missing, expired, or already revoked sessions return 401. |

Challenges contain a random 128-bit alphanumeric nonce and expire after five minutes. Only its SHA-256 hash is stored. Verification uses the [Wallet Standard SIWS verifier](https://github.com/phantom/sign-in-with-solana#sign-in-output-verification), binds the exact signed bytes and account to all persisted challenge fields, and additionally applies strict Ed25519 verification to reject small-order public keys. `AUTH_URI` must still match the persisted URI and domain, so changing the deployment identity invalidates pending challenges. A conditional database update consumes a challenge once; user upsert and session insertion commit in the same transaction. Failed session creation rolls everything back.

Sessions use random 256-bit bearer tokens, store only SHA-256 hashes, and expire after seven days. Return the raw token only at sign-in. The future mobile integration must keep it in OS-backed secure storage, send it only in the authorization header over HTTPS, and clear it on expiry, logout, or wallet changes. Mobile API sign-in remains separate work; the live server rechecks sessions on every page and closes revoked/expired Following sockets. Auth responses use `Cache-Control: no-store`; request bodies are capped at 8 KiB.

The single API process limits all auth requests to 60 per peer IP per minute, challenges to 10 per peer IP, and verification to 10 per account address. Buckets expire, memory is bounded, and a full bucket map rejects new keys. Peer addresses come from `Bun.serve`'s socket metadata; caller-provided forwarding headers are ignored. Behind a tunnel or reverse proxy, clients share that proxy peer's limits. Multiple API instances need a shared limiter; do not expose independent instances expecting these process-local limits to coordinate.

## Owner-scoped operations

Private route handlers use `withOwner(context, store, callback)` from `apps/api/src/auth.ts`. It rejects missing or malformed bearer headers and runs the callback through `database.auth.withSession`. That operation validates session expiry/revocation, locks the session against concurrent logout, and sets `app.user_id` transaction-locally before any owner query. Use the supplied query function and the authenticated `session.userId` for ownership predicates and inserts. Never take the owner ID from a request body or execute a private query through the top-level database handle.

Throw on a failed mutation to roll back; do not catch a failed operation and return a success response inside the callback. Identity resets after both commit and rollback. Existing forced RLS policies independently protect subscriptions, push tokens, paper positions, and trade attempts. The runtime still refuses owner, superuser, `BYPASSRLS`, role-admin, and watcher/delivery credentials at startup. No new migration is needed for this issue.

## Verification

`bun run test:api` exercises real Ed25519 signatures and the production auth store against migrated PGlite, using a non-owner login role granted only `waffle_api`. It covers tampered inputs, small-order keys, replay, overlapping verification requests, challenge/session expiry, logout, failed-session rollback, anonymous writes, cross-user read/insert/update/delete, and identity reset on reused connections after commit/rollback. The existing database suite separately checks grants and forced RLS.

PGlite serializes database operations; overlapping API requests here are not proof of PostgreSQL lock contention or production pool behavior. Before deployment, run the API with its dedicated login on a disposable Neon branch and manually verify:

1. Obtain a challenge and sign its input with an MWA-compatible wallet; verify the returned bytes/signature to obtain a session.
2. Submit the same signed challenge simultaneously twice; exactly one request should succeed. Confirm one session was created.
3. Read `/auth/session`, log out, and confirm the same token now gets 401. Also check an expired session.
4. Use two wallets against private feature routes as they are added; each must see and mutate only its own records. Repeat across reused pooled connections and after failed transactions.

No browser, device wallet flow, or live Neon database was used for the local automated checks.

## Paper positions (#18)

All three routes require a valid bearer session and return `Cache-Control: no-store`:

| Route | Request | Response |
| --- | --- | --- |
| `POST /paper-positions/quote` | `{ "signalId": "<uuid>", "sizeLamports": "100000000" }` | Validated `PaperQuote`, including its server-issued `id`. |
| `POST /paper-positions` | `{ "signalId": "<uuid>", "quoteId": "<quote id>", "sizeLamports": "100000000" }` | `201` simulated position with the entry quote and calculated `fill`. |
| `GET /paper-positions?limit=50&cursor=<position uuid>` | Optional limit 1–50 and last position ID. | `{ items, nextCursor }`, newest first by creation time and ID. |

Configure `JUPITER_API_KEY` in `apps/api/.env` to obtain quotes. Without it, quoting returns `503 SERVICE_UNAVAILABLE`; authenticated position listing remains available. The server derives the output mint from the committed signal and calls the existing Jupiter `/order` service without a taker. No signing or `/execute` call occurs. Owner IDs, quote bodies, output mints, and fill values are never accepted from clients.

Only eligible signals with a known transaction timestamp, a healthy stream at assessment, transaction/observation ages at most 90 seconds, mint evidence at most 60 seconds, and pool liquidity of at least $25,000 observed within 15 seconds can be used. Future timestamps fail. The existing paper size cap is 0.1 SOL, excluding the separately reported network fees. Stale evidence fails closed; this endpoint does not refresh pool/mint evidence. The owner and signal are rechecked after provider I/O, which runs outside database transactions, and again when filling. Quotes expire after at most 10 seconds or an earlier provider expiry.

Quotes are bound to their authenticated owner and requested signal/size. A quote can create one position; concurrent/repeated successful use is rejected. An insert failure rolls back and permits retry while the quote remains fresh. Unused quotes live in a bounded 256-entry cache in the single API process; restart/eviction requires a new quote. Multiple API instances need shared quote storage before deployment.

The immutable `entryQuote` JSON persists amounts, fees, slippage, minimum output, price impact, provider request ID, and fetch/expiry timestamps. The persisted position creation time is the simulated fill time. `fill.outputAmountRaw` uses Jupiter's quoted output unchanged (route fees are already reflected); `fill.minOutputAmountRaw` preserves the provider's minimum. `fill.totalDebitLamports` adds network fees to input lamports using bigint arithmetic. `fill.quoteAgeMs` is reproduced exactly from the persisted fill and quote timestamps. These are simulations, not execution guarantees or wallet balances. No schema migration is required.

`401 UNAUTHORIZED` rejects missing/expired/revoked sessions; `404 NOT_FOUND` covers missing signals or inaccessible cursors; `409 STALE_SIGNAL`, `LIMIT_EXCEEDED`, `CONFLICT`, or `QUOTE_UNAVAILABLE` explains rejected fills. Provider failures return sanitized `503 QUOTE_UNAVAILABLE`. Listing uses both the session owner filter and existing forced RLS; another user's cursor cannot reveal their positions.

Automated PGlite and injected-provider tests cover exact fill calculations, freshness, owner isolation, quote binding/reuse, validation, pagination, and rollback. For manual acceptance, sign in, request a fresh quote for a newly persisted eligible signal, create a 0.1 SOL paper position before expiry, and list it; repeat with a second account and an expired quote to verify rejection/isolation. Live Jupiter and Neon acceptance remain pending.

## Real trade attempts (#26)

These routes require a bearer session and return `Cache-Control: no-store`. The server derives the owner, taker wallet, and output mint from the session and persisted signal; clients cannot supply them.

| Route | Request | Response |
| --- | --- | --- |
| `POST /trade-attempts` | `{ "signalId": "<uuid>", "inputAmountLamports": "50000000" }` | `201` with `{ order, attempt }`. Sign only `order.transactionBase64` with the authenticated wallet. |
| `POST /trade-attempts/:id/execute` | `{ "quoteId": "<order.id>", "requestId": "<order.requestId>", "signedTransactionBase64": "..." }` | Updated attempt (`confirmed` or `failed`); uncertain execution returns 503 and leaves a readable `submitted` attempt. |
| `POST /trade-attempts/:id/wallet-rejection` | `{ "quoteId": "<order.id>", "requestId": "<order.requestId>", "reason": "WALLET_REJECTED" }` or `USER_CANCELLED` | Updated `wallet_rejected` attempt. Repeating the same reason is idempotent. |
| `GET /trade-attempts/:id` | No query parameters | Owner's attempt. |
| `GET /trade-attempts?limit=50&cursor=<attempt uuid>` | Optional limit 1–50 and last attempt ID | `{ items, nextCursor }`, newest first by creation time and ID. |

Preparation requires a still-eligible signal, fresh transaction/mint/pool evidence, at least $75,000 in fresh pool liquidity, and at most 0.05 SOL input. The server rechecks the session and signal after Jupiter responds, validates the returned order against the wallet, mint, size, router, fee payer, and expiry, then inserts a `prepared` row. A duplicate provider `requestId` for that owner fails with 409. Orders expire within 10 seconds, and their transaction bytes remain in a bounded process-local cache; a restart or eviction requires a new order. The `trade_attempts` table already exists, so this issue needs no migration.

Execution verifies the wallet's Ed25519 signature over the unchanged order message. It atomically moves the matching owner row from `prepared` to `submitted` and stores that signature **before** calling Jupiter `/execute`. A failed database update prevents broadcast; repeated or concurrent submissions cannot broadcast the same attempt again. Jupiter success confirms the attempt only when its signature matches the signed transaction. An explicit Jupiter failure records its code and reason. A timeout, malformed response, or signature mismatch leaves `submitted` with `EXECUTION_UNKNOWN` or `SIGNATURE_MISMATCH`; the client must reconcile the stored signature against the chain before offering another trade. `submitted` is not proof of landing, and this API does not perform chain reconciliation. Wallet rejection is accepted only while `prepared` and cannot overwrite a submitted outcome.

`401 UNAUTHORIZED` covers missing, expired, or revoked sessions; `404 NOT_FOUND` covers missing signals, inaccessible attempts, and foreign cursors; `409` covers stale evidence, limits, expired or mismatched orders, duplicate requests, and state conflicts. Provider unavailability or uncertain execution returns a sanitized 503. Owner predicates and forced database RLS both guard reads and mutations. Without `JUPITER_API_KEY`, order and execute requests return 503 while attempt reads still work.

Automated PGlite tests use a restricted API role, a fake provider, and locally signed transaction fixtures. They cover duplicate requests, order mismatches, stale evidence, owner isolation, wallet rejection, signature verification, explicit failures, unknown outcomes, and pre-broadcast persistence rollback. They do not send a live trade. Manual acceptance on a disposable Neon branch and a wallet-controlled test amount is still needed, including provider response behavior and signature reconciliation. The mobile sign/submit flow belongs to #27. Multiple API instances require shared validated-order state before deployment; the current Jupiter cache is process-local.
