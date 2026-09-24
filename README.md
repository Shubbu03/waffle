# waffle

An Android Solana app for watching curated whale wallets, understanding scored buy signals, and trying paper trades before wallet-approved real trades.

## Setup

Use Bun 1.3.13 (the version recorded in package.json):

```sh
bun install --frozen-lockfile
bun run typecheck
```

Run one workspace's check:

```sh
bun run --filter '@waffle/shared' typecheck
```

All apps depend on `@waffle/shared` through `workspace:*`. Shared code must remain platform-independent. Bun manages packages; the mobile app will use React Native's native runtime and tooling. Server runtime and framework selection remain open.

## Layout

```text
apps/
  mobile/           React Native app placeholder
  api/              API placeholder
  watcher/          Blockchain watcher placeholder
packages/
  shared/           Shared schemas and types placeholder
db/
  migrations/       Neon Postgres migrations (pending)
tests/
  fixtures/         Redacted transaction fixtures (pending)
docs/
  wallet-selection.md
```

Create environment examples alongside their consuming app when adding integrations. No credentials are needed for the current scaffold. Never put database or provider secrets in the mobile app.

## Product decisions and plan

* [Wallet selection](docs/wallet-selection.md): curated catalog, personal follows, separate opt-in alerts.
* [Build specification](AGENT.md): architecture, unresolved decisions, and chapter acceptance gates.
* [Milestones](MILESTONE.md): deliverables and progress.
* [Schedule](PLAN.md): planned daily work; future commands become available as chapters are implemented.
* [References](DOC.md): provider documentation and integration references.

The initial setup used `bun init --yes --minimal`, `mkdir -p` for the planned directories, workspace manifests, and `bun add --dev --exact typescript`. Install dependencies from the root so all packages share one bun.lock. Package management follows the [Bun workspace documentation](https://bun.sh/docs/pm/workspaces).

UI and device acceptance checks are performed manually by the user. Suggested commit checkpoints in the plans do not authorize staging, committing, or pushing.
