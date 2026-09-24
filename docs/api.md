# API runtime

Issue #5 adds the Bun/Hono API foundation. The only public route is `GET /health`: it returns `{ "status": "ok" }` after a database ping, or a `SERVICE_UNAVAILABLE` error with HTTP 503. Unknown routes and validation failures use the shared `apiErrorSchema` envelope and include `requestId`; the same ID is in the `X-Request-ID` response header. JSON body and query validators are available for later feature routes. Authentication, user-scoped transactions, signals, and trading routes are separate work.

## Local setup

1. Apply the [database migrations](database.md) to a disposable Neon branch. Create a separate login role with only membership in `waffle_api`; it must not own app tables or have superuser, `BYPASSRLS`, or `CREATEROLE` privileges. The API checks this on startup and refuses a privileged credential.
2. Copy `apps/api/.env.example` to `apps/api/.env` and fill in that login's Neon connection URL. Keep `sslmode=require` or `sslmode=verify-full` in the URL. The API loads this app-local file; `packages/db/.env` is only for migrations.
3. From the repository root, run `bun install --frozen-lockfile`, then `bun run dev:api` for watch mode or `bun run start:api` for a single run. `API_HOST` defaults to `127.0.0.1`, and `API_PORT` defaults to `3000`.
4. Request `GET http://127.0.0.1:3000/health` to confirm that the API can query Neon. `bun run test:api` runs the local API tests without credentials.

The environment file is ignored by Git. Keep the connection URL on the server; never copy it into `apps/mobile`. Live Neon connectivity and login privileges still need checking with a configured Neon branch.
