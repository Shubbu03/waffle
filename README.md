# waffle

An Android Solana app for watching curated whale wallets, understanding scored buy signals, and trying paper trades before wallet-approved real trades.

## Setup

Use Bun 1.3.13 (the version recorded in package.json):

```sh
bun install --frozen-lockfile
bun run lint
bun run typecheck
bun run test:shared
bun run test:db
bun run test:api
bun run test:watcher
bun run test:observability
```

Biome checks formatting, imports, and lint rules through `bun run lint`. Run `bun run lint:fix` to apply safe fixes.

`bun install` also runs `prepare` to enable the checked-in `.githooks` for this clone. Both `pre-commit` and `pre-push` run `bun run lint:fix` from the repository root. Lint failures block the operation. If lint fixes tracked files, the hook also stops so you can review and stage the fixes before retrying; it never stages files automatically. Run `bun run prepare` to enable the hooks in an existing checkout or after installing with scripts disabled. Bun must be available in the environment used by Git, including Git GUI clients.

Run one workspace's check:

```sh
bun run --filter '@waffle/shared' typecheck
```

All apps depend on `@waffle/shared` through `workspace:*`. Shared code must remain platform-independent. Bun manages packages and is the selected watcher/API runtime; the mobile app will use React Native's native runtime and tooling. The Hono, Postgres, wallet auth, and live delivery choices are recorded in the [backend architecture decision](docs/backend-architecture.md).

### Mobile wallet configuration

The mobile app uses Solana mainnet. Signed-out launches show a welcome screen; verified sessions open Home. The only bottom tabs are **Home, Signals, Settings**. Wallet discovery and account screens are reached from Home and Settings. Copy `apps/mobile/.env.example` to `apps/mobile/.env` and set `EXPO_PUBLIC_WAFFLE_APP_URI` to the public HTTPS URL you control. Configure its Android Digital Asset Links file for the app signing key so wallets can verify the MWA identity. The app shows a sign-in error until this URL is set. `EXPO_PUBLIC_SOLANA_MAINNET_RPC_URL` is optional; without it, the app uses Solana's public mainnet RPC, which is suitable only for light development use. Both variables are bundled into the mobile app, so never put a secret RPC key or server credential in either one.

MWA sign-in is connected to the stateless SIWS API. Only a verified API token creates an authenticated session; sessions are stored in SecureStore, checked on foreground/expiry, and cleared on logout, wallet changes, or rejected tokens. Public All signals, signal details, and the wallet catalog remain available without sign-in. Set `EXPO_PUBLIC_WAFFLE_API_URL` to the public API origin (HTTP is accepted only in development). Devnet and testnet remain available in Settings for wallet testing; API sign-in accepts mainnet only. Test the wallet flow on an Android development build with an MWA-compatible wallet; Expo Go and iOS do not support this MWA flow.

## Layout

```text
apps/
  mobile/           Expo Android app, wallet sign-in, catalog, signal feed/detail
  api/              Bun/Hono API foundation
  watcher/          Catalog ingestion, recovery, evidence, scored signal persistence
packages/
  shared/           Validated API/live schemas, score policy, program IDs
  db/               Typed Postgres schema, migrations, tests
  jupiter/          Server-only quote, price, and execution service
  observability/    Shared structured logging and dependency failure reporting
tests/
  fixtures/         Redacted transaction fixtures (pending)
docs/
  backend-architecture.md
  scoring-policy.md
  wallet-selection.md
  shared-contracts.md
  database.md
  api.md
  watcher-rpc.md
```

Local typechecks and tests need no credentials. Applying migrations to a disposable Neon branch needs the server-side `packages/db/.env` described in the [database workflow](docs/database.md). The API provides health, wallet authentication, catalog, follows and alert preferences, paginated All/Following signal reads, paper positions, and foreground WebSocket delivery; see the [API runtime guide](docs/api.md). Run the catalog watcher with `bun run start:watcher` after configuring `apps/watcher/.env`; see the [watcher RPC guide](docs/watcher-rpc.md). Never put database or provider secrets in the mobile app.

## Product decisions and plan

* [Wallet selection](docs/wallet-selection.md): curated catalog, personal follows, separate opt-in alerts.
* [Backend architecture](docs/backend-architecture.md): runtime, migrations, SIWS sessions, durable live delivery, retries, reconnects, and demo budget.
* [Database workflow](docs/database.md): schema, roles, migrations, and local checks.
* [API runtime](docs/api.md): local environment, restricted database login, and health check.
* [Backend logging](docs/observability.md): important failures, request correlation, secret omission, and log levels.
* [Push alerts](docs/push-alerts.md): owner-bound device registration, FCM setup, eligibility, retry, and device acceptance.
* [Live delivery](docs/live-delivery.md): delivery credentials, WebSocket frames, cursor recovery, limits, and verification.
* [Watcher RPC](docs/watcher-rpc.md): catalog subscriptions, reconnect recovery, rate limits, and health status.
* [Watcher evidence](docs/watcher-evidence.md): mint and pool validation, quote probes, optional data, and freshness.
* [Watcher signals](docs/watcher-signals.md): score assessment, suppression, atomic outbox writes, and deduplication.
* [Scoring policy](docs/scoring-policy.md): versioned weights, critical checks, freshness windows, liquidity floors, and trade caps.
* [Shared contracts](docs/shared-contracts.md): validated API and live payloads, cursors, errors, and program IDs.
* [Build specification](AGENT.md): architecture, unresolved decisions, and chapter acceptance gates.
* [Milestones](MILESTONE.md): deliverables and progress.
* [Schedule](PLAN.md): planned daily work; future commands become available as chapters are implemented.
* [References](DOC.md): provider documentation and integration references.

The initial setup used `bun init --yes --minimal`, `mkdir -p` for the planned directories, workspace manifests, and `bun add --dev --exact typescript`. Install dependencies from the root so all packages share one bun.lock. Package management follows the [Bun workspace documentation](https://bun.sh/docs/pm/workspaces).

Home previews real signals and curated wallets. The mobile Signals tab supports All/Following, cursor pagination, foreground WebSocket recovery, and bounded offline caches. Details show original score reasons, evidence timestamps, unknown data, and copy blockers; paper review, simulated fills, owner-only positions and fresh SOL exit valuations are implemented. See [signal acceptance steps](docs/mobile-signals.md) and [paper trading acceptance steps](docs/mobile-paper.md). Wallet-approved real execution remains a separate mobile issue.

Outbound HTTP requests use shared Xior policies with clients for mobile, RPC, Pyth, Jupiter, FCM, and catalog verification. See [HTTP clients](docs/http-clients.md).

UI and device acceptance checks are performed manually by the user. Suggested commit checkpoints in the plans do not authorize staging, committing, or pushing.
