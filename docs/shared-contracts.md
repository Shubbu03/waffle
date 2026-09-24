# Shared API and live contracts

Issue #3 establishes the JSON boundary in [`@waffle/shared`](../packages/shared/src/index.ts). API, watcher, and mobile should import the exported Zod schemas and inferred types rather than copy their shapes. These are contracts for future integrations; the API routes, database, watcher, and mobile consumers are not implemented by this issue.

## Wire conventions

* Objects are strict: unknown keys fail validation. IDs are UUIDs, timestamps are ISO 8601 strings with offsets, Solana addresses and signatures decode to 32 and 64 bytes respectively.
* Lamport and token raw amounts are unsigned decimal strings within `u64`; outbox event IDs and cursors are positive decimal strings within signed `bigint`. Never convert either to JavaScript `number` for storage, comparison, or JSON transport.
* Monetary size caps come from [`scorePolicyV1`](../packages/shared/src/scoring/config.ts): paper 100,000,000 lamports; real 50,000,000 lamports. Validate limits again against current server evidence when accepting a trade.
* Every error response follows `{ "error": { "code": "...", "message": "...", "fieldErrors"?: { "field": ["..."] } }, "requestId"?: "uuid" }`. `apiErrorCodeSchema` is the allowed code list. Do not expose provider payloads, secrets, or stack traces in `message`.

## HTTP shapes

| Operation | Shared schema | Notes |
| --- | --- | --- |
| `GET /wallets` | `walletCatalogResponseSchema` | Public curated catalog; `active` is explicit. |
| `GET /wallet-subscriptions` | `walletSubscriptionsResponseSchema` | Session owner only. |
| `PUT /wallet-subscriptions/:walletId` | `putWalletSubscriptionRequestSchema` → `walletSubscriptionSchema` | Empty body follows with alerts off; `alertsEnabled` can update the preference. URL wallet ID uses `idSchema`. |
| `POST /push-tokens` | `pushTokenRegistrationSchema` | Session owner only; Android permission state travels with the registration. |
| `POST /auth/challenge` | `authChallengeResponseSchema` | Server generates the SIWS input and stores the challenge. |
| `POST /auth/verify` | `authVerifyRequestSchema` → `authVerifyResponseSchema` | API verifies exact signed bytes and consumes the challenge; shape validation alone does not authenticate. |
| `GET /signals` | `getSignalsQuerySchema` → `signalPageSchema` | Public `all`, authenticated `following`; optional wallet filter; maximum page size 50. |
| `GET /signals/:id` | `signalDetailSchema` | Summary plus ordered score reasons and evidence snapshot. |
| `POST /paper-positions` | `createPaperPositionRequestSchema` → `paperPositionSchema` | Owner only; server checks quote ID, current freshness, signal, and size. |
| `GET /paper-positions` | `paperPositionsResponseSchema` | Owner only. |
| Real order and attempt flow | `realOrderSchema`, `createTradeAttemptRequestSchema`, `tradeAttemptSchema`, `tradeAttemptsResponseSchema` | Defines the payload boundary for C3.3; route and signing flow are still to be implemented. |

`paperQuoteSchema` and `realOrderSchema` are distinguished by `kind`. Paper quotes contain no taker or transaction. Accepted real orders require the connected taker to be the fee payer, exactly one required signature, an allowed router (`metis`, `dflow`, `okx`), and the real size cap. The client and API must still decode and inspect the actual transaction, check quote expiry at use time, and verify provider responses. A schema cannot prove a transaction is safe to sign.

`GET /signals` uses `view=all|following`, `direction=before|after`, optional `cursor`, `limit=1..50` (default 50), and optional `walletId`. `before` pages older event IDs for history; `after` replays newer event IDs for reconnect. `nextCursor` is a decimal event ID or `null`; `hasMore` tells the client whether to continue. The API must use a stable event-ID order and apply Following and wallet filters before page limits. An expired cursor returns `CURSOR_EXPIRED` and the client reloads a recent page with a visible gap state. Paper-position and trade-attempt list cursors are UUIDs in their current response contracts.

## Score reasons and evidence

`signalSummarySchema` carries the public card fields, source program ID, score version, status, data status, and outbox `eventId`. `signalDetailSchema` adds one reason per [`SCORE_REASON_GROUPS`](../packages/shared/src/scoring/score.ts), in group order, and the evidence snapshot. The schema rejects unknown reason codes, incorrect v1 points or totals, incompatible status, and missing evidence for awarded mint, pool, quote, holder, creator, or oracle points. The watcher remains responsible for scoring from fresh evidence and persisting the original snapshot; validation does not replace the scorer or recompute time-relative freshness.

## WebSocket frames

`GET /live` uses protocol `v: 1`. The first client frame is one of:

```json
{"v":1,"type":"subscribe","view":"all","cursor":null}
{"v":1,"type":"auth","view":"following","accessToken":"<43-character base64url bearer>","cursor":"123"}
```

The bearer token is sent only in the authenticated frame over WSS, never in the URL. The API checks the session and ownership before accepting Following. `cursor: null` requests the bounded recent view; a decimal cursor requests catch-up. Server frames are:

```json
{"v":1,"type":"ready","view":"all","latestEventId":"123"}
{"v":1,"type":"signal","view":"all","eventId":"124","signalId":"11111111-1111-4111-8111-111111111111","walletId":"22222222-2222-4222-8222-222222222222"}
{"v":1,"type":"gap","view":"all","oldestAvailableEventId":"100"}
{"v":1,"type":"error","error":{"code":"UNAUTHORIZED","message":"Session expired"}}
```

The signal frame is deliberately small. The client fetches the card by `signalId`, applies/deduplicates it, then advances the stored `eventId` separately for All and Following. The outbox, reconnect catch-up, and gap behavior follow the [backend architecture decision](backend-architecture.md). `ready.latestEventId` is informational; receiving it alone must not advance the applied cursor. A `gap` means the client reloads a recent page and surfaces incomplete history.

## Program IDs

[`program-ids.ts`](../packages/shared/src/program-ids.ts) exports Pump, PumpSwap, Raydium AMM v4/CPMM/CLMM, the two token programs, and wrapped SOL. The IDs are validated as 32-byte addresses in schema tests. They do not expand the MVP classifier scope beyond PumpSwap. Primary sources: [Pump public docs](https://github.com/pump-fun/pump-public-docs), [Raydium AMM](https://github.com/raydium-io/raydium-amm), [Raydium CPI examples](https://github.com/raydium-io/raydium-cpi-example), and [Solana terminology](https://solana.com/docs/references/terminology).

Run `bun run typecheck` and `bun run test:shared` after contract changes. Bump the live protocol version or score policy version when changing their meanings; coordinate wire changes across API and mobile consumers.
