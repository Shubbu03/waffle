# Mobile sign-in and signals (#21, #23)

The app opens a minimal welcome screen when signed out: a centered app icon, the waffle wordmark underneath, and one **Get started** button. That button starts wallet sign-in directly on the same screen, with loading and error feedback; there is no intermediate sign-in page. A restored verified session opens Home. Bottom navigation has exactly three tabs, in order: **Home, Signals, Settings**. Home shows recent real signals and catalog wallets, with links to wallet discovery, the account, and paper positions. Signals contains public All signals and authenticated Following. Settings contains account controls, network selection, and a connection check. Wallet catalog, account, and detail screens open outside the tab bar. Demo routes and starter settings are removed.

Wallet catalog and signal details are public. Following, follow/alert changes, and later trade actions require an API session verified for the connected mainnet wallet.

## Configuration

Copy `apps/mobile/.env.example` into the app-local environment. Set the public HTTPS MWA identity (`EXPO_PUBLIC_WAFFLE_APP_URI`) and API origin (`EXPO_PUBLIC_WAFFLE_API_URL`). An Android development emulator can use `http://10.0.2.2:3000`; this explicit bridge is preserved even when Metro advertises a LAN host, so it can reach the API listening on the host's loopback address. Other local development origins follow Metro when it advertises a local IP or localhost. An iOS simulator can use `http://127.0.0.1:3000`. Physical devices should use the host's reachable LAN IP. Explicit remote origins and production URLs are preserved. Expo tunnel hosts are not used as API hosts. Use HTTPS/WSS outside development. API, database, Helius, Jupiter, and Firebase credentials remain server-side.

Start the API separately with `bun run dev:api` from the repository root. Physical devices on the same Wi-Fi require a LAN listener: `API_HOST=0.0.0.0 bun run dev:api`, plus a reachable local IP or a public HTTPS API tunnel. The Metro server does not start the API. In Settings → Connection, **Check connection** calls the actual `/health` endpoint; an unavailable service stays visibly unavailable. Development builds show the configured public API address.

The API must log `api.started` before it can serve requests. A watch process displaying “Running” after `api.startup.failed` is waiting for file changes, not serving the API. PostgreSQL URLs must contain correctly encoded credentials (a literal `%` in a password becomes `%25`). Invalid database credentials are reported by environment field name without printing the URL.

Public data routes can be browsed on iOS/web, but MWA sign-in and signing require an Android development build with a compatible wallet. Pressing Get started on iOS/web explains that limitation instead of invoking unsupported wallet transport.

For live updates, configure the API's delivery database connection as described in [live delivery](live-delivery.md). Without it, the app still loads REST history and reconciles every 30 seconds while foregrounded; it reports that live updates are reconnecting. Run on an Android development build with an MWA-compatible wallet, not Expo Go.

## Session behavior

REST requests use the mobile Xior client, with a ten-second deadline that includes response parsing. See [HTTP clients](http-clients.md) for provider policies and cancellation behavior.

Sign-in checks `/health` before opening the wallet, builds fresh SIWS input, obtains the wallet signature, verifies it through `/auth/verify`, and stores the validated token/session in SecureStore. A cancelled wallet prompt is surfaced without retry. A stalled wallet call gets one clean retry with newly generated input. Failed verification never creates a local authenticated session. Legacy wallet-only sessions are discarded.

A valid previously verified token survives a network outage for cached browsing, with its API link marked offline. Authenticated feature requests remain disabled until session verification succeeds again. Local expiry, wallet/account or network changes, and a 401 for the current token clear authentication. A response for an old token cannot clear a newer session. Logout clears local state before best-effort server revocation; storage writes are serialized so a late sign-in reply cannot undo logout.

## Feed, recovery, and caching

- Home uses a compact waffle header with the verified wallet address pill. Its dropdown offers Copy wallet address, My account, and Paper positions. Recent signals and tracked wallets appear once; there is no promotional card or bottom account section. The catalog refreshes every 30 seconds while its screen is focused and the app is active, recovering from temporary errors and retaining previously loaded wallets with a stale-data label if refresh fails. API connection details remain in Settings.
- Signals omits the refresh timestamp/countdown and routine live-status text. Offline, history-gap, and request failure notices remain visible. Details group the persisted assessment score, copy availability, wallet/transaction context, snapshot metrics, token controls, and the eight score buckets. Addresses/signatures can be copied; the source transaction opens in the explorer. Additional transaction metadata is expandable. Missing values stay unavailable, and cached, expired, or mismatched evidence never appears fresh. Snapshot quote probes are labelled separately from actual wallet trade amounts.
- REST history uses `/signals?view=all|following&direction=before`, with exact decimal event cursors and explicit older-page loading.
- `/live` sends credentials only in Following's initial frame. Signal frames are processed in order: fetch validated detail, apply/deduplicate the signal, persist the bounded cache, then advance the applied cursor. REST snapshots and `ready` watermarks never acknowledge events.
- All and Following keep separate cursors/caches. Following keys include the user ID; all keys include the API origin. A changed wallet-subscription set reloads Following history with a reset cursor. Alert preference changes do not change feed membership.
- Reconnect uses jittered exponential backoff. Backgrounding or leaving the feed closes its socket and aborts reads. Foregrounding resumes from the saved cursor. Retention gaps reload bounded recent history and remain visibly labelled.
- AsyncStorage holds at most 200 summaries per view/owner and 50 public signal details per API. It never stores bearer tokens. Detail screens refresh on open/foreground and every 30 seconds while active.
- Offline/failed refreshes preserve cached browsing and mark it stale. Copy readiness checks transaction age, evidence expiry, persisted suppression/history status, and stream degradation. Missing optional holders/creator/oracle stays unknown and earns zero points; it does not independently block a copy.

The detail screen opens [paper review and positions (#25)](mobile-paper.md) when its copy checks pass. Notification receipt/tap handling (#24) and wallet-approved real trades (#27) remain separate work.

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

1. Launch signed out: confirm the centered icon and waffle wordmark appear with only Get started. Check light/dark mode, small screens, and enlarged text. Press Get started with an available API: confirm the wallet opens without another app screen. After sign-in, confirm the tab order is Home, Signals, Settings, with no Demo, Wallets, or Account tab. Check neutral backgrounds and lime accents. Open the wallet catalog from Home, then return and browse All and a signal detail.
2. On Android, cancel wallet sign-in: remain on the minimal landing screen, signed out, with a clear cancellation message and the button ready to retry. Sign again with Mainnet and an available API; confirm Following and follow changes work. Stop the API before pressing Get started: confirm an error appears without opening the wallet. On iOS/web confirm Get started explains the Android requirement.
3. Kill/reopen: restore the verified session. Sign out using Settings or the wallet disconnect control; reopen and confirm it stays signed out. Switch wallet accounts and confirm the prior session/follows are not shown as the new account.
4. Reject/revoke a token server-side or exercise an expired stored session. Confirm authentication clears. Stop the API temporarily: preserve public/owner-specific cached browsing, display offline state, then recover when reachable.
5. Open Home → Wallets. Follow two catalog wallets. Confirm inclusion reasons, tracking status, and recent activity appear. Verify a paused existing follow can be removed or muted, while new follows/alerts stay disabled. Compare All and Following, unfollow one, and confirm Following reloads without its signals. Alert toggles must not change Following membership.
6. Load multiple history pages. Receive a fresh supported buy with the API's live worker enabled. Interrupt connectivity, reconnect, and confirm recovery without duplicate cards.
7. Open a detail: inspect score buckets, transaction link, source slot, original timestamps, unknown optional data, and copy-blocking explanation. Let evidence expire and confirm the explanation changes without needing a reload.
8. Load a feed and open several details, then enable airplane mode. Reopen the app and confirm cached feed/details remain readable and copying is blocked. Restore connectivity and refresh.
9. On disposable data, expire the saved outbox cursor. Confirm a history-gap message and bounded recent reload; do not claim complete history.

10. Stop/start the API and use Settings → Connection. Confirm failure/recovery is explicit, refresh loads real catalog and signals, and an RPC failure displays balance unavailable rather than an invented zero. Check the new Home, Settings, catalog, and welcome screens on small screens and with enlarged text.
