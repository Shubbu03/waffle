# API runtime

Issue #5 adds the Bun/Hono API foundation. The public health route is `GET /health`: it returns `{ "status": "ok" }` after a database ping, or a `SERVICE_UNAVAILABLE` error with HTTP 503. Unknown routes and validation failures use the shared `apiErrorSchema` envelope and include `requestId`; the same ID is in the `X-Request-ID` response header. JSON body and query validators are available for later feature routes. Issue #15 adds wallet authentication and session-scoped owner transactions below. Signals and trading routes remain separate work.

Issue #12 adds the internal [Jupiter quote and execution service](jupiter.md). It has no public route until authenticated wallet and trade authorization are available.

## Local setup

1. Apply the [database migrations](database.md) to a disposable Neon branch. Create a separate login role with only membership in `waffle_api`; it must not own app tables or have superuser, `BYPASSRLS`, or `CREATEROLE` privileges. The API checks this on startup and refuses a privileged credential.
2. Copy `apps/api/.env.example` to `apps/api/.env` and fill in that login's Neon connection URL and `AUTH_URI`, the public HTTPS identity shown by the wallet. Its host becomes the SIWS domain; use the current tunnel URL for a demo. Keep `sslmode=require` or `sslmode=verify-full` in the URL. The API loads this app-local file; `packages/db/.env` is only for migrations.
3. From the repository root, run `bun install --frozen-lockfile`, then `bun run dev:api` for watch mode or `bun run start:api` for a single run. `API_HOST` defaults to `127.0.0.1`, and `API_PORT` defaults to `3000`.
4. Request `GET http://127.0.0.1:3000/health` to confirm that the API can query Neon. `bun run test:api` runs the local API tests without credentials.

The environment file is ignored by Git. Keep the connection URL on the server; never copy it into `apps/mobile`. Live Neon connectivity and login privileges still need checking with a configured Neon branch.

## Wallet authentication

| Route | Request | Result |
| --- | --- | --- |
| `POST /auth/challenge` | No parameters required | `{ challengeId, signInInput }` for wallet MWA `signIn`. |
| `POST /auth/verify` | JSON matching `authVerifyRequestSchema`: `challengeId`, `accountAddress`, `signedMessageBase64`, `signatureBase64` | `{ session, accessToken }`; invalid, expired, or consumed challenge returns 401. |
| `GET /auth/session` | `Authorization: Bearer <accessToken>` | `{ session }` with user ID, wallet address, and expiry; invalid sessions return 401. |
| `POST /auth/logout` | Same authorization header | 204 after revoking that session; missing, expired, or already revoked sessions return 401. |

Challenges contain a random 128-bit alphanumeric nonce and expire after five minutes. Only its SHA-256 hash is stored. Verification uses the [Wallet Standard SIWS verifier](https://github.com/phantom/sign-in-with-solana#sign-in-output-verification), binds the exact signed bytes and account to all persisted challenge fields, and additionally applies strict Ed25519 verification to reject small-order public keys. `AUTH_URI` must still match the persisted URI and domain, so changing the deployment identity invalidates pending challenges. A conditional database update consumes a challenge once; user upsert and session insertion commit in the same transaction. Failed session creation rolls everything back.

Sessions use random 256-bit bearer tokens, store only SHA-256 hashes, and expire after seven days. Return the raw token only at sign-in. The future mobile integration must keep it in OS-backed secure storage, send it only in the authorization header over HTTPS, and clear it on expiry, logout, or wallet changes. Mobile API sign-in and live-socket invalidation remain separate work. Auth responses use `Cache-Control: no-store`; request bodies are capped at 8 KiB.

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
