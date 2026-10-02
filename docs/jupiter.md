# Jupiter quote and execution service

Issue #12 adds `JupiterService` in [`packages/jupiter/src/index.ts`](../packages/jupiter/src/index.ts), re-exported by `apps/api/src/jupiter.ts`. It uses Jupiter Swap V2 on mainnet. Configure `JUPITER_API_KEY` in `apps/api/.env`; the key is sent only in the server's `x-api-key` header. Issue #18 exposes owner-authorized paper quotes through `POST /paper-positions/quote`; issue #26 exposes real orders and execution through the [owner-checked trade-attempt API](api.md#real-trade-attempts-26).

The watcher also consumes this server-only package for quote probes and SOL/USD price reads. `getUsdPrice` returns the exact mint’s price, decimals, and source block ID; callers must verify that block’s age before using the price. See [watcher evidence](watcher-evidence.md).

## Flow

1. `getPaperQuote` calls `GET /order` with wrapped SOL input, output mint, and raw lamports, omitting `taker`. It requires a quote-only response with no transaction. Paper quote size is at most 0.1 SOL.
2. `getRealOrder` calls `GET /order` with the authenticated connected wallet as `taker` and `excludeRouters=jupiterz`. It requires an allowed router (`metis`, `dflow`, `okx`), `signatureFeePayer=taker`, no gasless sponsorship, a versioned transaction with exactly one required signature, and the taker as signer. Real order size is at most 0.05 SOL. The order retains the original transaction message on the server.
3. The wallet signs the returned transaction. `execute` checks the authenticated wallet, server order ID, Jupiter `requestId`, quote freshness, unchanged message bytes, and a valid Ed25519 signature before calling `POST /execute`. The API's validation callback persists the signed signature and `submitted` state before broadcast. The server supplies the stored `lastValidBlockHeight`. Each accepted order can be submitted once. An execution timeout or malformed response returns `EXECUTION_UNKNOWN`; callers must reconcile the transaction with the chain before offering another trade.

Both quote types preserve `requestId`, router, minimum output, signed price impact, slippage, fee rates and amounts, and fee payer details. The service enforces a local 10-second quote lifetime and any earlier provider `expireAt`. Accepted quote and order transactions remain in bounded, process-local memory; authenticated trade attempts and their outcomes are persisted in Postgres. A production multi-instance API needs shared validated-order state so preparation and execution can run on different instances. A block height is forwarded to Jupiter; the current service does not query Solana RPC to compare it with the live height or reconcile submitted signatures.

The service reports typed, sanitized errors. `UPSTREAM_UNAVAILABLE` covers quote transport and non-2xx responses; `UPSTREAM_INVALID` covers malformed quote data; `EXECUTION_UNKNOWN` covers uncertain `/execute` outcomes. It does not log or expose the API key or provider error bodies. API tests inject a test HTTP transport and never submit a live transaction.

Sources: [Jupiter get started](https://developers.jup.ag/docs/get-started), [Order and Execute](https://developers.jup.ag/docs/swap/order-and-execute), [Get Order reference](https://developers.jup.ag/docs/api-reference/swap/order), [Execute reference](https://developers.jup.ag/docs/api-reference/swap/execute), [gasless routing](https://developers.jup.ag/docs/swap/advanced/gasless).


For paper position valuation, `getPaperValuation` requests `/order` with the held token as input, wrapped SOL as output and the exact stored raw quantity. It omits the taker, rejects transactions and mismatched mints/amounts, applies the same response deadline and ten-second freshness limit, and returns an indicative exit quote. The [position API](api.md#paper-position-reads-and-valuation-25) maps unsupported/unavailable/invalid quotes to an explicit unavailable result. This does not execute a sale or require an RPC/price feed read.
