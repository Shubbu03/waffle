# Mobile paper trading (#25)

The signal detail opens **Review paper copy** when persisted signal, mint, pool and stream checks are fresh. Sign in with a verified Mainnet account before trading. Account → **Paper positions** opens the owner-only list; a successful fill also links to its position detail.

## Review and fill

- Enter 0 < size ≤ 0.1 SOL, with at most nine decimal places, or choose 0.01 / 0.05 / 0.1 SOL. Amounts remain decimal strings and BigInts throughout; token quantities never pass through floating-point numbers.
- Get a new quote from the API. Review expected and minimum token output, slippage, signed price impact, router/platform fees, signature/priority/rent fees, total entry cost and expiry. Router/platform fees are already included in output and are not subtracted twice.
- Mint decimals come from the watcher's verified mint account evidence and are saved with the entry quote. Older signals/positions without decimals explicitly display base units; the app never assumes six decimals.
- Quotes last at most ten seconds. Editing size, refreshing the signal, leaving the review, backgrounding, or changing accounts invalidates the prepared quote. Confirmation independently checks expiry and current session/readiness, including after saving pending state.
- A fresh quote does not refresh the original pool evidence. The existing 15-second pool gate and server-side recheck remain in force. Refreshing an unchanged stored signal cannot make it eligible again.
- Confirm records a simulated fill only. No wallet signing, transaction broadcast, SOL debit, token transfer, or position sale occurs.

Before sending a fill, AsyncStorage saves its quote ID, signal ID and size under the API origin, account and signal. It stores no bearer token. Repeated taps cannot submit twice. A timeout, malformed success response or server error is uncertain: the app looks up the exact quote ID rather than scanning one page or replaying the POST. Restarting the app restores this check. A missing lookup is **not** proof of failure; the review stays locked and offers manual status checks until a saved fill is found. If the request never reached the API, that old signal's review can remain unresolved; other signals and saved positions remain accessible. A definitive 4xx rejection requires a new quote.

## Positions and valuation

Positions preserve exact token holdings, total entry cost, entry network fees, quote age and fill timestamp. The list pages twenty positions at a time, supports pull-to-refresh and provides an explicit **Refresh value** button per position. Opening position detail obtains one exit valuation automatically; subsequent valuation updates are manual. There is no background price polling or automatic request for every list item.

The API obtains a fresh Jupiter quote for the position's entire stored token quantity back into wrapped SOL, omitting the taker. It validates both mints, exact quantity, quote-only response, minimum output and expiry. Ownership is checked before provider access; the session is checked again afterwards. Historical signal age does not prevent valuing an existing holding. Unsupported routes, unavailable providers and invalid/stale quotes show **Current value unavailable**; expired displayed quotes also stop showing a current value.

The exit output includes router fees. Estimated exit network fees are shown separately. The indicative change subtracts entry cost and exit network fees from the exit quote; it is not a realized return. Values use SOL rather than an unverified USD price. Account changes cancel and remove the previous owner's position/value queries.

## Automated verification

```sh
bun run --filter '@waffle/mobile' test
bun run test:api
bun run test:shared
bun run test:db
bun run test:watcher
bun run typecheck
bun run lint
```

Mobile tests cover exact sizes/quantities, expiry, invalidation and late replies, persistence failures, duplicate confirmation, lost responses, lookup recovery, restarts and definitive rejections. Xior wire tests cover authenticated requests and malformed/mismatched responses. API tests use migrated PGlite with a non-owner login and forced RLS to check foreign-owner lookups/valuation, provider validation, exact reverse amounts, stale-signal valuation and logout during provider I/O. Watcher tests verify mint decimals reach the persisted snapshot.

The Android static export checks bundling only. Automated checks do not verify live Jupiter routes, a deployed Neon database, native wallet prompts or device layout.

## Device acceptance (performed by the user)

1. Sign in, open a newly eligible signal and enter 0.1 SOL. Check the quote's fees, minimum output and expiry, then confirm. Repeat on a second fresh signal; both positions must show **simulated**, the size and timestamp.
2. Edit the size after quoting; confirmation must disappear. Let a quote expire, background the app, or navigate away and return; request a new quote before confirming. Old pool evidence must still block copying.
3. Tap confirm repeatedly; only one position should be created for that quote. Interrupt the response after submission or restart during a fill; check that the exact saved fill is recovered without another POST. If no saved fill is found, check that the review stays uncertain and locked.
4. Open Account → Paper positions, refresh and page through disposable seeded positions. Open a detail; compare exact entry amounts/fees and refresh its SOL exit valuation. Wait past expiry; the value must become unavailable. Exercise an unsupported route/API failure and check the visible error state.
5. Sign out and switch accounts; the previous owner's positions and valuations must disappear. Directly opening a foreign position ID must fail without revealing its holding or accessing Jupiter.
6. Disconnect networking; no quote/fill should proceed. Recover connectivity, verify the session and refresh the signal. Review keyboard layout, scrolling, accessibility labels and readable amounts on your Android device.
