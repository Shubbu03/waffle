# Background push alerts (#20)

The API registers Android device tokens for authenticated owners and sends FCM HTTP v1 data messages from durable `push_deliveries` jobs. Foreground WebSockets continue independently. Native permission prompts, token refresh callbacks, receiving/displaying notifications, and device deduplication are mobile work (#24).

## Configuration

Set these server-only values in `apps/api/.env` or the process secret environment:

- `DATABASE_URL`: the existing restricted API login.
- `DELIVERY_DATABASE_URL`: the separate restricted `waffle_delivery` login for the same database, as described in [live delivery](live-delivery.md).
- `FCM_SERVICE_ACCOUNT_JSON`: service-account JSON containing `project_id`, `client_email`, and its RSA `private_key`. In a dotenv file use single-quoted JSON, preserving the JSON `\n` escapes inside the PEM string. Do not commit the key or bundle it into the mobile app.

Enable the Firebase Cloud Messaging API in the project and grant the service account permission to send messages (Firebase Cloud Messaging API Admin). Its project must match the Android app's Firebase configuration. The API validates the credential shape/key at startup, obtains short-lived OAuth tokens using an RS256 service-account assertion, and sends only to Google's fixed HTTPS OAuth/FCM endpoints. Redirects are refused; requests have four-second timeouts. Credentials and raw provider errors are never logged or returned. The implementation uses Bun's Node crypto support and native fetch; no new dependency is needed. See [Firebase authorization](https://firebase.google.com/docs/cloud-messaging/send/v1-api) and [Google's service-account flow](https://developers.google.com/identity/protocols/oauth2/service-account).

Missing FCM configuration disables the worker with an explicit startup log; registration and REST remain available. Setting FCM credentials without the delivery database URL fails startup. Registration success means a preference was stored, not that FCM is configured or a device received anything. No schema migration or additional role grant is needed.

## Owner-bound registration

Authenticated `POST /push-tokens` accepts:

```json
{"token":"<FCM registration token>","platform":"android","notificationPermission":"granted"}
```

The response contains `{ id, platform, notificationPermission, active }`, never the token or its hash. Permission is `granted` or `denied`; denied registrations are inactive. The backend relies on the native app reporting OS permission accurately; it cannot independently attest that permission. Each owner may keep ten registrations. The token is stored server-side for FCM, with a globally unique SHA-256 hash for lookup.

Repeating a registration returns the same ID. Unchanged retries preserve the consent timestamp; permission changes and reactivation renew it so old events cannot become alerts. A token belonging to another owner returns a generic 409 and is never transferred. Unknown fields, owner IDs, malformed values, and unbounded bodies are rejected. Session validation, explicit owner predicates, and forced RLS all apply.

`DELETE /push-tokens/:id` removes only the current owner's registration and cascades its jobs; repeated deletes return 204. The mobile app must save the returned ID, unregister before logout/account change, and register rotated tokens while removing the old registration. If the old owner session is unavailable, rotate the FCM token before registering for another owner. Do not send registration tokens in URLs or logs. Reporting permission denial disables pending sends; a request already accepted by FCM cannot be recalled.

## Durable dispatch

With FCM configured, a worker scans at startup and every two seconds even without foreground sockets. Each scan expands at most ten committed outbox events and processes at most ten due jobs. A transient send failure ends that scan's sends. This polling is intended for the documented demo windows; stop the process outside them to preserve the free-plan database budget.

Expansion locks one unexpanded event with `FOR UPDATE SKIP LOCKED`. It inserts jobs and sets `push_expanded_at` in one transaction. The unique `(signal_event_id, push_token_id)` constraint prevents duplicate jobs on retries. Only active catalog wallets and eligible signals with score at least 70 and valid, complete critical evidence qualify; missing optional data is allowed. Suppressed, history-only, stale, malformed, and unknown-critical signals produce no alert.

The recipient must currently follow that wallet with alerts enabled and have an active token with granted permission. Follow creation, alert opt-in, device creation, and its latest permission/reactivation must **predate the outbox event**. Enabling alerts later never replays older events as notifications.

Before sending each job, the worker locks it with `FOR UPDATE SKIP LOCKED`, locks its token, and rechecks the current subscription, opt-in cutoff, permission, catalog state, signal eligibility, and age. Device changes serialize with the attempt. A mute/unfollow/pause committed before this final read prevents sending; changes racing an already-started network request cannot retract that request. The original transaction and observation timestamps define a maximum 90-second lifetime, never the retry time. Critical evidence must have been complete and fresh at scoring; a push is not a fresh executable quote. Fetch a new quote on opening the signal.

The data-only message contains string fields `id` (signal ID), `eventId`, `score`, `wallet` (address), `mint`, `slot`, `age` (transaction age in seconds at dispatch), and absolute `expiresAt`. Android priority is high and TTL is the remaining signal lifetime, rounded down to seconds. The device must check `expiresAt`, fetch current signal data, and deduplicate by `id` before displaying a notification. See [FCM Android configuration](https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages#AndroidConfig).

## Failures and observability

- Jobs persist `attempts`, `next_attempt_at`, and sanitized error codes. Transient failures back off from ten seconds, double on each attempt, and add up to 25% jitter. There are at most four recorded attempts; a retry that would outlive the signal fails instead. Unsent ineligible jobs become disabled.
- HTTP 429 waits at least 60 seconds; `Retry-After` seconds or dates can extend the wait. HTTP 5xx/network failures retry, and 401 invalidates the OAuth cache. Other permanent failures stop the job. A process-local cooldown prevents other jobs immediately ignoring a provider backoff. Per-job retry dates survive restart. These classifications follow [FCM error guidance](https://firebase.google.com/docs/cloud-messaging/error-codes).
- `UNREGISTERED` and token-specific `INVALID_ARGUMENT` disable the token. A generic payload error or sender/project mismatch does not disable a device token. Other devices remain active.
- `sent_at` and `/health`'s process-local `push.accepted` count mean **FCM accepted the request**, not device receipt. A crash after acceptance but before the database commit may repeat the message with the same signal ID; exactly-once device delivery is not promised.
- `/health` includes `push: { degraded, lastPollAt, accepted }` when configured and returns 503 after a worker/provider failure. A later successful scan clears degraded. Authorization failures leave jobs pending for recovery; freshness is checked again before any later send.

Local verification uses migrated PGlite under the actual API/delivery role grants, provider-response fixtures, and cryptographic verification of generated OAuth assertions. Tests cover ownership, permission denial, device caps, consent cutoffs, muted/unfollowed/paused/stale/suppressed signals, current-state rechecks, retries, invalid tokens, rollback, and duplicate crash recovery. PGlite serializes transactions and does not prove multi-connection Neon lock behavior.

Manual acceptance: use a disposable Neon branch and test Firebase project; register a real Android device after native permission is granted; follow an active catalog wallet with alerts enabled before a fresh supported signal arrives. Check job state and FCM acceptance, then separately verify device receipt/display. Repeat with permission denied, alerts muted, wallet paused, stale/suppressed signals, token rotation, account switching, and a disconnected device. Verify duplicate suppression and expiry in the device handler. Live FCM, Neon concurrency, and Android receipt have not been exercised by local tests; UI/device verification is performed manually by the user.
