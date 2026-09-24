# Backend, wallet auth, and live delivery decision

Accepted 24 September 2026 for the CLOCK IN MVP. This is the implementation contract for M0 C0.2 and M2; it does not claim that the services, database, or mobile client already exist. Recheck provider limits before provisioning.

## Chosen tools

| Concern | Decision | Reason |
| --- | --- | --- |
| Server runtime | Bun 1.3.13 for both `apps/watcher` and `apps/api` | Matches the workspace and lets both processes share platform-independent TypeScript contracts. React Native still runs in its native JavaScript runtime. |
| HTTP API and foreground live | Hono on Bun; Hono's `hono/bun` WebSocket adapter at `GET /live` | One API process owns REST, session checks, filtering, and live connections. WebSocket is supported by React Native and by Hono's Bun adapter. |
| Database | Neon Postgres | Already selected. The committed signal row is the durable source of truth. |
| Queries and migrations | Drizzle ORM with `postgres.js`; Drizzle Kit `generate` and `migrate` with reviewed SQL migration files in `db/migrations` | Typed queries, versioned migrations, and explicit SQL for roles, grants, indexes, and RLS policies. Write a matching down SQL script for each MVP migration and exercise it on a disposable Neon branch; Drizzle Kit does not generate rollback scripts. Do not use `drizzle-kit push` on shared or production databases. |
| Background alerts | Firebase Cloud Messaging from the API process | Wakes Android when the app is not foregrounded. An FCM acceptance response is not proof that a device displayed an alert. |
| Demo deployment | Watcher and API as two Bun processes on a developer machine during test/demo windows; Neon, Helius, and FCM free plans; temporary HTTPS/WSS Cloudflare Quick Tunnel to the API for a physical device | $0 incremental hosting cost for the short-lived hackathon demo. The tunnel hostname changes on restart and has no uptime guarantee. It is not a production deployment. |

No Redis, separate message broker, hosted key service, or database changefeed is required for the MVP. The separate watcher process is justified by its long-lived Solana subscriptions; the API process is justified by client auth and delivery. A 24/7 public service needs a paid or otherwise guaranteed always-on host and a revised database budget.

## Wallet sign-in and sessions

1. `POST /auth/challenge` returns a server-generated [SIWS](https://github.com/phantom/sign-in-with-solana) input: configured public domain and URI, mainnet chain ID, random alphanumeric nonce (at least 128 bits of entropy), issued-at, and expiration time. Store only a hash of the nonce with a five-minute expiry in `auth_challenges`. Rate-limit by IP and wallet where known. The configured domain must match the current HTTPS tunnel hostname for a demo; changing the hostname invalidates outstanding challenges and requires a new app API configuration.
2. The connected Android wallet signs that input through MWA `signIn`. `POST /auth/verify` sends the signed bytes, signature, and account address to the API. The API loads its stored challenge, checks the exact nonce/domain/URI/chain/issued-at/expiry/address, verifies the Ed25519 signature over the returned bytes with a vetted SIWS verifier, and consumes the challenge atomically so replay and concurrent verification fail. Never trust a client-supplied replacement challenge or user ID.
3. On success, upsert `users.wallet_address` and issue a random 256-bit opaque bearer session. Store only its hash, user ID, created-at, and seven-day expiry in `sessions`; return the raw token once. The Android app stores it in OS-backed secure storage and sends it in `Authorization: Bearer` over HTTPS. Never place it in a URL, analytics event, or log. `POST /auth/logout` revokes the session; expiry, logout, or wallet-account change clears local state and closes the live socket. Re-sign-in creates a new session. Refresh is another SIWS sign-in for the MVP.
4. `GET /live` accepts a WebSocket upgrade, then requires an `auth` frame with the bearer session within five seconds for Following. Public All may connect without a session but has per-IP connection and message limits. Reject invalid/expired sessions before subscribing, recheck session validity periodically, and close revoked sessions. No bearer token goes in the query string or WebSocket URL.

API authorization checks ownership before mutations. Native Postgres RLS is a second enforcement layer on follows, push tokens, paper positions, and trade attempts. The API uses a non-owner, non-`BYPASSRLS` runtime role, with `FORCE ROW LEVEL SECURITY` on owner-scoped tables. For each authenticated database operation, open a transaction, set `app.user_id` with transaction-local `set_config(..., true)`, run the query, and commit/roll back. Policies compare the row's `user_id` with `nullif(current_setting('app.user_id', true), '')::uuid`; an absent identity denies access. Never use a session-level `SET` with pooled connections. Public catalog and signal reads have explicit read grants/policies. Migrations use a separate owner credential; the watcher uses a restricted writer credential. Session/challenge tables are server-only and are not exposed through a client database connection. Test actual grants and RLS using the same role as the API, including anonymous, cross-user, and connection-reuse cases.

## Committed signal to device

```text
Helius -> watcher classify/score -> one Postgres transaction:
  INSERT signals ON CONFLICT (signature, wallet) DO NOTHING
  if inserted: INSERT signal_events(signal_id, created_at)
COMMIT -> watcher POST /internal/events/{id} (authenticated wake-up, event ID only)
       -> API loads committed row and applies delivery rules
       -> WebSocket for open app + durable push jobs for eligible followers
       -> FCM for background alerts
```

`signal_events` is an outbox, with a unique `signal_id`, increasing `id`, `push_expanded_at`, and `live_dispatched_at`. Only the watcher creates signal rows and it serializes these short insert transactions, so event IDs reflect commit order. A duplicate `(signature, wallet)` creates no new event. The watcher-to-API POST is an optional low-latency wake-up, authenticated with a server-only shared secret, accepted only over loopback/private network, and never carries a signal payload or is treated as the durable handoff. API looks up the committed event from Postgres. A missed POST cannot lose an event: API scans unprocessed events on startup and every two seconds while serving clients, every 30 seconds when idle. These are initial demo values; measure DB usage and delivery latency. Avoid an idle poll loop on a 24/7 free-plan database.

On event processing, API first expands push work in a transaction: insert one `push_deliveries` row per eligible device with `UNIQUE(signal_event_id, push_token_id)`, then set `push_expanded_at`. Store `alerts_enabled_at` on subscriptions whenever alerts change from off to on. Use the outbox row's `created_at` as the conservative cutoff: subscription creation and alert opt-in must both predate it. Eligibility also requires an active catalog wallet, alerts currently enabled, valid registered token, signal freshness, score threshold, and complete critical checks. Recheck freshness and current follow/alert state immediately before sending. Inactive, suppressed, stale, or historical signals never produce push. If API crashes during expansion, the transaction rolls back and the event is retried without duplicate jobs.

For connected clients, API reads the committed event, filters All/Following by the authenticated user's current subscriptions, sends a compact `{eventId, signalId, walletId}` frame, then records `live_dispatched_at`. WebSocket delivery is best effort; clients fetch the signal card through the API and deduplicate by `signalId`. A crash after marking dispatch or a dropped socket is repaired by cursor catch-up. No client is promised exactly-once socket delivery. The API must not broadcast the raw watcher transaction or trust a client-supplied wallet filter for Following.

## Retries, reconnect, and limits

* `push_deliveries` has `status`, `attempts`, `next_attempt_at`, `last_error`, and `sent_at`. A bounded API worker claims due jobs with `FOR UPDATE SKIP LOCKED`. Retry transient FCM errors with exponential backoff and jitter, respecting `Retry-After`; disable invalid/unregistered tokens. Stop at a small attempt cap or when the signal is older than the alert freshness window. A crash after FCM accepts but before `sent_at` can cause a duplicate alert; the device deduplicates by `signalId`. FCM TTL must be no longer than the alert freshness window. Record provider acceptance separately from device receipt.
* Mobile stores the last applied `eventId` for All and Following separately. On first open, load a bounded recent page through `GET /signals?view=all|following&limit=50`. On socket open or reconnect, send that cursor and fetch paginated events newer than it, then process live frames; register the socket before the catch-up query and deduplicate IDs so events racing with the query are not lost. Also reconcile every 30 seconds while foregrounded. Advance the cursor only after the corresponding card is fetched/applied. On process restart use the stored cursor; on a cursor older than retained history, reload recent history and show a gap/degraded state instead of silently claiming completeness. Backoff reconnect attempts with jitter and show connection status. All and Following use the same shared signals; Following is a server-side filtered view.
* Keep outbox rows at least seven days, longer than the expected demo offline gap; retention must not remove a row needed by a supported cursor. Bound `GET /signals` pages and socket frame size. Apply per-IP auth and socket rate limits, cap active sockets, and close slow consumers. A failed API/DB/FCM service does not block watcher scoring or committed signal storage; surface delivery lag and failures in logs/health output.
* Instrument `log_received`, `tx_available`, `scored`, `db_committed`, `api_published`, `device_received`, and FCM acceptance separately. The `<2s` open-device target is a manual acceptance measurement, not a guarantee.

## Budget and deployment gate

The hackathon demo runs the two Bun processes on a developer machine only while testing. Use a temporary Quick Tunnel for the physical Android device; configure the SIWS domain and API base URL from that run's HTTPS hostname. Keep `DATABASE_URL`, Helius key, FCM credentials, and internal wake secret only in the server process environments. The app contains only the public API base URL and public Firebase mobile configuration. Stop processes/tunnel outside demo windows.

As checked on 24 September 2026: [Helius Free](https://www.helius.dev/pricing) lists 1M credits and 10 requests/s; [Neon Free](https://neon.com/blog/neon-backend-is-ga) lists 100 CU-hours per project and 0.5 GB database storage; [FCM](https://firebase.google.com/pricing) is no-cost; [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/) are for testing and have no SLA. At 0.25 CU, a continuously active 30-day database would consume about 180 CU-hours, above Neon's listed free allowance; two weeks of continuous use would consume about 84 CU-hours before development/branch usage. These are budget estimates, not measured consumption. Check the provider dashboards during testing and narrow the catalog or demo runtime before hitting limits. No 24/7 uptime or push latency claim follows from this $0 setup.

## Acceptance before M2 is called done

* Fresh migration on a Neon branch creates tables, grants, indexes, and RLS policies; rollback/forward and runtime-role cross-user tests pass.
* Replayed SIWS proof fails; expired challenge fails; wrong domain/chain/address fails; expired and revoked sessions fail over REST and WebSocket.
* Duplicate watcher event yields one signal/outbox row; API restart after commit still expands push and serves catch-up; FCM transient failure retries without losing the job.
* Open device receives a fresh eligible event; disconnected device receives FCM only when opted in; reconnect fills a deliberately missed socket event without duplicate cards; stale and muted signals do not alert.
* Run the physical-device, wallet, permission-denial, tunnel, and visual checks manually. The repository's automated checks do not prove those device outcomes.

## Primary references

* [Hono Bun WebSocket adapter](https://hono.dev/docs/helpers/websocket)
* [Drizzle migrations](https://orm.drizzle.team/docs/migrations) and [Postgres RLS](https://www.postgresql.org/docs/current/ddl-rowsecurity.html)
* [SIWS specification and verification flow](https://github.com/phantom/sign-in-with-solana)
* [Firebase FCM error and retry guidance](https://firebase.google.com/docs/cloud-messaging/error-codes)
