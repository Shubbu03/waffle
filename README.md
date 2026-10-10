# waffle

Follow Solana wallets, review scored PumpSwap buys, and copy trades on Android. Try simulated paper trades or approve real trades with your connected wallet.

Built with Expo, React Native, Bun, Hono, and PostgreSQL.

## Setup

Requires Bun 1.3.13, PostgreSQL, Android development tools, and an MWA-compatible Solana wallet. Wallet sign-in requires a native Android build.

```sh
bun install --frozen-lockfile

cp apps/api/.env.example apps/api/.env
cp apps/watcher/.env.example apps/watcher/.env
cp apps/mobile/.env.example apps/mobile/.env
cp packages/db/.env.example packages/db/.env
```

Fill in the database and provider settings described in each environment example. Use separate restricted API/watcher database logins; keep the migration-owner connection in `packages/db/.env`.

Set the mobile API URL and app identity URL. The API's `AUTH_URI` must match `EXPO_PUBLIC_WAFFLE_APP_URI`. For push notifications, configure Firebase and add `apps/mobile/google-services.json`.

```sh
bun run db:migrate
```

## Run

Run each app in a separate terminal:

```sh
bun run dev:api
bun run dev:watcher
bun run --filter '@waffle/mobile' android
```

## Checks

```sh
bun run lint
bun run typecheck
bun run test
```

Deploy a single API instance while prepared order state remains process-local.
