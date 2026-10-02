# Mobile sign-in and signals (#21, #23)

The app opens the public All signals feed. Wallet catalog and signal details are also public. Following, follow/alert changes, and later trade actions require an API session verified for the connected mainnet wallet.

## Configuration

Copy `apps/mobile/.env.example` into the app-local environment. Set the public HTTPS MWA identity (`EXPO_PUBLIC_WAFFLE_APP_URI`) and API origin (`EXPO_PUBLIC_WAFFLE_API_URL`). For a development emulator, the API can use HTTP at `http://10.0.2.2:3000`. Use HTTPS/WSS outside development. API, database, Helius, Jupiter, and Firebase credentials remain server-side.

For live updates, configure the API's delivery database connection as described in [live delivery](live-delivery.md). Without it, the app still loads REST history and reconciles every 30 seconds while foregrounded; it reports that live updates are reconnecting. Run on an Android development build with an MWA-compatible wallet, not Expo Go.

## Session behavior

REST requests use the mobile Xior client, with a ten-second deadline that includes response parsing. See [HTTP clients](http-clients.md) for provider policies and cancellation behavior.

Sign-in builds fresh SIWS input, obtains the wallet signature, verifies it through `/auth/verify`, and stores the validated token/session in SecureStore. A cancelled wallet prompt is surfaced without retry. A stalled wallet call gets one clean retry with newly generated input. Failed verification never creates a local authenticated session. Legacy wallet-only sessions are discarded.

A valid previously verified token survives a network outage for cached browsing, with its API link marked offline. Authenticated feature requests remain disabled until session verification succeeds again. Local expiry, wallet/account or network changes, and a 401 for the current token clear authentication. A response for an old token cannot clear a newer session. Logout clears local state before best-effort server revocation; storage writes are serialized so a late sign-in reply cannot undo logout.

## Feed, recovery, and caching

- REST history uses `/signals?view=all|following&direction=before`, with exact decimal event cursors and explicit older-page loading.
- `/live` sends credentials only in Following's initial frame. Signal frames are processed in order: fetch validated detail, apply/deduplicate the signal, persist the bounded cache, then advance the applied cursor. REST snapshots and `ready` watermarks never acknowledge events.
- All and Following keep separate cursors/caches. Following keys include the user ID; all keys include the API origin. A changed wallet-subscription set reloads Following history with a reset cursor. Alert preference changes do not change feed membership.
- Reconnect uses jittered exponential backoff. Backgrounding or leaving the feed closes its socket and aborts reads. Foregrounding resumes from the saved cursor. Retention gaps reload bounded recent history and remain visibly labelled.
- AsyncStorage holds at most 200 summaries per view/owner and 50 public signal details per API. It never stores bearer tokens. Detail screens refresh on open/foreground and every 30 seconds while active.
- Offline/failed refreshes preserve cached browsing and mark it stale. Copy readiness checks transaction age, evidence expiry, persisted suppression/history status, and stream degradation. Missing optional holders/creator/oracle stays unknown and earns zero points; it does not independently block a copy.

Paper execution (#25), notification receipt/tap handling (#24), and wallet-approved real trades (#27) remain separate work. The detail screen displays copy readiness and a disabled paper entry labelled as upcoming; it does not simulate a fill or request a wallet transaction.

## Automated checks

Run from the repository root:

```sh
bun run --filter '@waffle/mobile' test
bun run typecheck
bun run lint
```

The API wire checks bind an ephemeral loopback port; restricted sandboxes need local-port access.

Mobile tests cover session rejection/expiry/restoration, logout races, account isolation, malformed caches, exact cursor ordering, duplicate frames, detail/storage failures before acknowledgement, reconnect recovery, retention gaps, membership changes, background cancellation, and stale/degraded copy blockers. These do not verify native wallet prompts, visual layout, or live device transport.

## Manual acceptance (performed by the user)

1. Launch signed out. Browse All, Wallets, and a signal detail. Try Following or Follow and confirm sign-in is offered.
2. Cancel wallet sign-in: remain signed out, with a clear cancellation message. Sign again with Mainnet and an available API; confirm Following and follow changes work.
3. Kill/reopen: restore the verified session. Sign out using Settings or the wallet disconnect control; reopen and confirm it stays signed out. Switch wallet accounts and confirm the prior session/follows are not shown as the new account.
4. Reject/revoke a token server-side or exercise an expired stored session. Confirm authentication clears. Stop the API temporarily: preserve public/owner-specific cached browsing, display offline state, then recover when reachable.
5. Follow two catalog wallets. Compare All and Following, unfollow one, and confirm Following reloads without its signals. Alert toggles must not change Following membership.
6. Load multiple history pages. Receive a fresh supported buy with the API's live worker enabled. Interrupt connectivity, reconnect, and confirm recovery without duplicate cards.
7. Open a detail: inspect score buckets, transaction link, source slot, original timestamps, unknown optional data, and copy-blocking explanation. Let evidence expire and confirm the explanation changes without needing a reload.
8. Load a feed and open several details, then enable airplane mode. Reopen the app and confirm cached feed/details remain readable and copying is blocked. Restore connectivity and refresh.
9. On disposable data, expire the saved outbox cursor. Confirm a history-gap message and bounded recent reload; do not claim complete history.
