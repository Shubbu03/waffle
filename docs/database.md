# Database schema and migration workflow

Issue #4 defines the Postgres storage used by the [backend architecture](backend-architecture.md) and [shared contracts](shared-contracts.md). The typed source is [`packages/db/src/schema`](../packages/db/src/schema/index.ts). The package owns its [Drizzle config](../packages/db/drizzle.config.ts), [migration files](../packages/db/migrations/0000_initial_schema.sql), environment example, and tests. Drizzle Kit generated `0000_initial_schema.sql`; `0001_access_control.sql` adds reviewed role grants and row security.

## Tables and boundaries

| Group | Tables | Key constraints |
| --- | --- | --- |
| Catalog and accounts | `watched_wallets`, `users`, `user_wallet_subscriptions` | Unique addresses and user/wallet follows; new follows default to alerts off. |
| Signals | `signals`, `signal_events` | One signal per signature and catalog wallet; one outbox event per signal; event ID is a signed 64-bit cursor. |
| User actions | `push_tokens`, `paper_positions`, `trade_attempts` | Owner IDs and foreign keys; simulated paper positions and size limits; user/request ID uniqueness for attempts. |
| Auth and delivery | `auth_challenges`, `sessions`, `push_deliveries` | Stored nonce/session hashes, expiration bounds, unique event/token deliveries, retry fields. |

`signals.reasons`, `signals.snapshot`, and `paper_positions.entry_quote` are JSONB with compile-time Drizzle types. The watcher and API must validate them with `@waffle/shared` at their write boundaries; PostgreSQL does not validate every nested JSON field. Raw push tokens are server-only and indexed by a server-computed SHA-256 hex `token_hash`, avoiding a large-text index. Store only the hash for SIWS nonces and bearer tokens. Never log these values or expose the migration credential to the mobile app.

The migration creates three `NOLOGIN NOBYPASSRLS` privilege groups: `waffle_api`, `waffle_watcher`, and `waffle_delivery`. Provision separate non-owner login credentials in Neon and grant each only its matching group. Do not run the API or watcher with the migration owner credential. `waffle_api` gets public catalog/signal reads and owner-scoped writes. `waffle_watcher` can read catalog wallets and insert signals/outbox rows. `waffle_delivery` can read eligible delivery data across owners and manage push jobs; it needs a distinct server-side credential. Auth/session tables are accessible to the API group only. Subscription, push-token, position, attempt, and delivery tables use `FORCE ROW LEVEL SECURITY`.

Owner policies use `nullif(current_setting('app.user_id', true), '')::uuid`. The API must set this value with `set_config('app.user_id', userId, true)` inside **each authenticated transaction**; it must never use a session-level setting on a pooled connection. A missing identity sees no owner rows and cannot insert them. API authorization is still required before DB access. The delivery worker has an explicit cross-owner read policy for subscriptions and tokens so it can expand alert jobs. This role must not be used for ordinary API requests.

## Apply and verify

1. Create a disposable Neon branch and a migration-owner connection there. Copy `packages/db/.env.example` to `packages/db/.env` and replace the placeholder locally. The package-local Drizzle config loads that file. The migration owner needs table/schema creation and role-management privileges. Use a direct connection string for migration administration.
2. From the repo root run `bun install --frozen-lockfile`, then `bun run db:migrate`. Drizzle records applied versions in `drizzle.__drizzle_migrations`.
3. Provision separate API, watcher, and delivery login roles and grant the matching privilege groups. Check they do not own the tables and have no `BYPASSRLS` privilege. Test actual access using those login credentials before connecting an app.
4. Run `bun run typecheck`, `bun run test:shared`, and `bun run test:db`. The database tests apply the checked-in migrations to an in-memory PostgreSQL-compatible PGlite instance and check duplicates, defaults, grants, and owner access.

`bun run db:generate` creates a reviewed migration after a Drizzle schema change; `bun run db:check` checks the migration history. Do not use `drizzle-kit push` on shared or production databases. Recreate the disposable Neon branch when a clean migration run is needed.

The local automated suite verifies SQL against PGlite. A migration run and role/RLS test against a real Neon branch still remain before the database milestone is accepted; no Neon project or credential is configured in this repository.

## References

* [Drizzle Kit generate](https://orm.drizzle.team/docs/drizzle-kit-generate) and [migrate](https://orm.drizzle.team/docs/drizzle-kit-migrate)
* [PostgreSQL row security](https://www.postgresql.org/docs/current/ddl-rowsecurity.html) and [roles](https://www.postgresql.org/docs/current/sql-createrole.html)
* [Neon branching workflow](https://neon.com/docs/get-started-with-neon/workflow-primer)
