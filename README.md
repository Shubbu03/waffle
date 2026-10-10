# waffle

An Android Solana app for watching wallets, reviewing scored buy signals, and trying paper trades before wallet-approved real trades.

## Setup

Use Bun 1.3.13 from the repository root:

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test
```

`bun run test` runs all workspace suites. Wire tests need permission to start local HTTP/WebSocket servers. Tests and their helpers live in each workspace's `tests/` folder; saved transaction fixtures live in the root `tests/fixtures/` folder.

Copy the environment examples for the services you run:

```sh
cp apps/api/.env.example apps/api/.env
cp apps/watcher/.env.example apps/watcher/.env
cp apps/mobile/.env.example apps/mobile/.env
cp packages/db/.env.example packages/db/.env
```

Keep migration-owner credentials in `packages/db/.env`. The API, watcher, and delivery worker use separate restricted database logins. Run `bun run db:check` to check migration history and `bun run db:migrate` to apply migrations using the configured migration connection. Never put database or provider credentials in the mobile environment.

For mobile, configure `EXPO_PUBLIC_WAFFLE_API_URL` and `EXPO_PUBLIC_WAFFLE_APP_URI` with public HTTPS URLs. The app identity needs Android Digital Asset Links for the signing key. Public RPC URLs bundled into the app must not contain secrets. Wallet sign-in requires an Android development build and a compatible Solana wallet; Expo Go and iOS do not support the MWA flow. Push notifications need the local, gitignored `apps/mobile/google-services.json` file.

Start the configured services:

```sh
bun run start:api
bun run start:watcher
bun run --filter '@waffle/mobile' android
```

## Layout

```text
apps/
  api/              Bun/Hono auth, feeds, live/push delivery, and trade routes
  mobile/           Expo Android app and Mobile Wallet Adapter
  watcher/          Wallet subscriptions, recovery, evidence, and signal persistence
packages/
  db/               Drizzle schema, migrations, and database stores
  http/             Xior clients, deadlines, and response limits
  jupiter/          Server-side quote, price, and execution service
  market-data/      RPC scheduling, swap classification, evidence, and Devnet trading
  observability/    Structured backend logging
  shared/           Validated contracts and scoring policy
tests/fixtures/    Saved transaction fixtures
```

Outbound HTTP uses `@waffle/http`. Application database queries use Drizzle's typed query builder. Shared code stays platform-independent.

## Development checks

Biome checks formatting, imports, and lint rules. Mobile console calls are limited to warnings and errors. `bun run lint:fix` applies safe fixes.

Installing dependencies enables `.githooks`. Pre-commit and pre-push run `bun run lint:fix`; if tracked files change, the hook stops for review and staging. Hooks never stage files automatically.

UI and Android device checks are performed manually. Local tests do not verify live provider behavior or Neon pool concurrency. Real trades require wallet approval and are never automatically replayed. Multiple API instances require shared validated-order state; the current order cache is process-local.
