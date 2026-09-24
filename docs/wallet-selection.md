# Wallet selection

Accepted 24 September 2026. This describes intended MVP behavior; it is not implemented yet.

## Catalog and follows

waffle maintains a curated catalog of 5-10 manually reviewed wallets. Each user chooses which catalog wallets to follow. Arbitrary address entry, user-submitted monitoring jobs, profitability rankings, and automatic wallet discovery are outside the MVP.

The watcher monitors every active catalog wallet once, regardless of follower count. Signals are shared records. Following changes a user's feed and delivery preferences; it does not create another blockchain subscription. Unfollowing never deletes shared signals or stops catalog monitoring.

Select wallets with recent buys on the supported swap family (initially PumpSwap), manageable transaction volume, and a documented inclusion reason. No specific addresses have been selected yet. Monitor actual RPC usage and credits before expanding the catalog; 5-10 is a starting scope, not a guarantee that the free tier can handle any activity level.

## User experience

* Public users can browse the catalog and recent All signals feed without wallet sign-in.
* Wallet sign-in is required to save follows and alert preferences.
* The Wallets screen shows label, public address, tracking status, and recent supported activity.
* Following shows signals from followed wallets; All signals shows the shared catalog's signals.
* An empty Following feed invites users to select catalog wallets.
* Follow and alerts are separate controls. New follows default to alerts off; users explicitly enable them.
* Push requires a follow, enabled alerts, notification permission, and a fresh signal that passes the score and critical checks. Following alone does not authorize push.
* Inactive catalog wallets show tracking as paused. Existing follows/history remain; new follows and new alerts are disabled until reactivated.

## Persistence and API requirements

`watched_wallets` is the global catalog: unique address, label, active status, and inclusion reason. Recent supported activity can be derived from persisted signals.

`user_wallet_subscriptions` stores user_id, watched_wallet_id, alerts_enabled (default false), `alerts_enabled_at` (set when alerts change from off to on), and created_at. The user/wallet pair must be unique and reference existing records. Users can read or mutate only their own subscriptions. The backend determines user identity from the authenticated session, never a client-supplied owner ID. The alert timestamp prevents a newly enabled preference from triggering a delayed alert for an earlier signal.

Proposed endpoint contract:

* `GET /wallets`: public catalog.
* `GET /wallet-subscriptions`: authenticated user's follows and alert preferences.
* `PUT /wallet-subscriptions/:walletId`: idempotent follow or alert-preference update for an active catalog wallet.
* `DELETE /wallet-subscriptions/:walletId`: idempotent unfollow.

Database credentials remain server-side. Apply ownership checks through the API and native Postgres RLS. The SIWS session and live transport decisions are in [backend-architecture.md](backend-architecture.md).

## Acceptance checks for implementation

* Multiple users following one wallet do not duplicate watcher subscriptions or stored signals.
* Anonymous users can browse but cannot mutate follows.
* Users cannot read or modify another user's subscriptions.
* Duplicate follows are idempotent; unfollowing preserves shared history.
* All signals and Following return the correct sets with cursor pagination.
* Push excludes non-followers, muted follows, stale signals, and suppressed signals.
* Pausing a catalog wallet preserves history and follows while stopping monitoring and new alerts.
