# Repository guidance

- Never open a browser or GUI preview to verify UI changes. Ask the user to verify them manually.
- Do not stage, commit, or push unless the user explicitly requests that exact Git action.
- Use Bun for workspace package management and server runtimes. Run commands from the repository root unless a workspace command requires otherwise.
- Keep test files and helpers in each workspace's `tests/` folder. Keep saved transaction fixtures in the root `tests/fixtures/` folder.
- Use Xior through `@waffle/http` for outbound HTTP requests. Native `fetch` and Axios are not allowed. Bun fetch handlers and Hono's `app.fetch` serve incoming requests.
- Set HTTP deadlines and response limits in the consuming service. Keep retries in the domain scheduler; never replay trade execution automatically.
- Use Drizzle's typed query builder for application reads, inserts, updates, deletes, joins, upserts, and transactions.
- Use parameterized Drizzle `sql` fragments only for PostgreSQL-specific expressions, locks, session settings, and system-catalog checks. Never interpolate request values into SQL or use `sql.raw`/driver `.unsafe` for application queries. Reviewed migrations/DDL and test setup may use SQL.
- Import validated contracts and scoring policy from `@waffle/shared`; shared code must stay platform-independent.
- Keep environment files with their consuming apps/packages. Never bundle database credentials, provider secrets, or private keys into mobile code.
- Preserve failed-transaction exclusion, deduplication before fetch, RPC budgets, evidence freshness, owner isolation, and explicit unknown data.
- Real trades require the connected wallet's approval. For mainnet Jupiter orders, exclude JupiterZ, require the connected wallet as fee payer, and require exactly one signer.
- Run `bun run lint`, `bun run typecheck`, and `bun run test` for relevant changes. Report manual acceptance separately from automated verification.
