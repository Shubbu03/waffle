# Foreground live delivery (#19)

`GET /live` upgrades to a Hono/Bun WebSocket. The committed `signal_events` outbox is the durable source; socket frames are best effort. The watcher already inserts each signal and its event atomically and serializes event allocation before commit. No migration is required.

## Server setup

In `apps/api/.env`, configure `DELIVERY_DATABASE_URL` using a separate non-owner login granted **only** `waffle_delivery`, against the same database as `DATABASE_URL`. Both URLs require encrypted connections. Startup checks reject owners, superusers, `BYPASSRLS`, role administrators, and mixed API/watcher/delivery membership. Keep both credentials server-side. The delivery pool records dispatch; public reads and authenticated Following reads use the API pool and its existing session/RLS transactions.

Without the delivery URL, REST still runs and `/live` returns 503. With it configured, the worker scans at startup, then every two seconds with connections or every 30 seconds while idle. A new connection wakes polling. These intervals are demo defaults, not a latency guarantee. The optional private watcher wake-up POST from the architecture plan is not needed for correctness and is not implemented here.

Each scan loads up to 100 pending event IDs and records `live_dispatched_at` after attempting connected-client pages. This flag records a processing attempt, not receipt by every client; events can be marked with no clients connected. Every client independently reads committed history by cursor, regardless of that flag. A crash, missed poll, failed marker update, or API restart therefore cannot remove the recovery source. Push expansion and FCM are separate work (#20).

`GET /health` includes `live: { connections, degraded, lastPollAt }` when enabled. `lastPollAt` is the last successful scan time in epoch milliseconds, initially null. A failed scan sets degraded and HTTP 503 until a successful scan. No bearer tokens or database errors are returned.

## Protocol and recovery

Send exactly one JSON frame within five seconds of opening a socket. Public All requires no session:

```json
{"v":1,"type":"subscribe","view":"all","cursor":null}
```

Following requires a session from `/auth/verify` in the frame, never the URL:

```json
{"v":1,"type":"auth","view":"following","accessToken":"<43-character bearer token>","cursor":null}
```

All query parameters on `/live` are rejected. Use WSS outside local development. Changing view or account requires a new socket. The server hashes the token and rechecks session expiry/revocation on every page, including idle pages; logout closes Following on the next check. Following filters by the authenticated owner's current subscriptions under RLS, independently of alert preferences. A completed unfollow excludes the wallet from subsequent page reads. All continues to include eligible, suppressed, and historical signals.

A null cursor sends at most the latest 50 matching events, oldest first. A supplied cursor sends newer matching events in ascending pages of 50; additional pages arrive on subsequent polls. The socket is registered before the first query so racing commits are included in a later page. Events use exact decimal string IDs, including above JavaScript's safe integer range:

```json
{"v":1,"type":"signal","view":"all","eventId":"9007199254740993","signalId":"<uuid>","walletId":"<uuid>"}
```

After initial history or catch-up reaches the current end, the server sends `ready` with the view and nullable `latestEventId`. That value is a global informational watermark, **not proof that the client applied those events**.

Client integration (#23) must:

1. Fetch each signal through `GET /signals/:id`, apply it, and deduplicate by `signalId`. Only then persist its `eventId`. Process frames in order or advance only through a contiguous applied sequence.
2. Keep separate applied cursors for All and Following, and reset Following on wallet/account or subscription changes when reloading the desired history. Reconcile REST every 30 seconds while foregrounded.
3. Reconnect with the last applied cursor and jittered backoff. Never persist the `ready` watermark as an applied cursor. Repeated frames after disconnect are expected.
4. On `gap`, reload bounded recent history and show the history gap. The server sends `oldestAvailableEventId` and closes when the cursor predates retained history. An empty outbox with a non-null cursor returns `CURSOR_EXPIRED`; a future cursor is rejected. Do not silently claim complete history.

Retain outbox rows for at least seven days as specified in the architecture. Cleanup scheduling remains an operator responsibility; deleting outbox rows also removes those signals from cursor-based REST history.

## Limits and checks

The process allows 64 sockets, four per peer IP, ten accepted connection attempts per IP per minute, and at most 1,000 tracked IP buckets. It trusts the actual socket peer, not forwarded headers: a tunnel/reverse proxy can share one bucket, so verify demo device capacity behind it. Each socket accepts one text subscription frame, at most 2 KiB; malformed, repeated, binary, or unauthenticated Following frames close the connection. Bun enforces a 64 KiB backpressure limit; send failures close slow clients for cursor-based reconnect. No database failure blocks watcher persistence.

`bun run test:api` includes migrated PGlite role tests and a real loopback Bun WebSocket test; local port binding is required. Coverage includes initial history, IDs above the safe integer range, multiple missed pages, commits during catch-up, an initially empty feed, reconnect after idle dispatch/restart, current follows and unfollows, revoked/expired sessions, malformed input, bounded connections, slow clients, dispatch retry, and retention gaps. PGlite serializes transactions; these tests do not replace multi-connection Neon acceptance.

Manual acceptance: configure both restricted logins on a disposable Neon branch, run watcher/API, and connect two clients (All and signed-in Following). Confirm one committed signal appears, disconnect/restart and recover it once in the applied feed, unfollow and verify later events disappear only from Following, and log out to verify closure. Test retention gaps and database recovery on disposable data. Device UI, tunnel behavior, and live Neon have not been verified by local tests.
