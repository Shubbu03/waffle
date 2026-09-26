# Jupiter quote and execution service

Issue #12 adds an internal `JupiterService` in [`packages/jupiter/src/index.ts`](../packages/jupiter/src/index.ts), re-exported by `apps/api/src/jupiter.ts`. It uses Jupiter Swap V2 on mainnet. Configure `JUPITER_API_KEY` in `apps/api/.env`; the key is sent only in the server's `x-api-key` header. The service is not exposed as a public HTTP route while the API has no authenticated wallet session or trade authorization route. Do not call `execute` from a public handler without supplying a wallet address verified against that session.

The watcher also consumes this server-only package for quote probes and SOL/USD price reads. `getUsdPrice` returns the exact mint’s price, decimals, and source block ID; callers must verify that block’s age before using the price. See [watcher evidence](watcher-evidence.md).

## Flow

1. `getPaperQuote` calls `GET /order` with wrapped SOL input, output mint, and raw lamports, omitting `taker`. It requires a quote-only response with no transaction. Paper quote size is at most 0.1 SOL.
2. `getRealOrder` calls `GET /order` with the authenticated connected wallet as `taker` and `excludeRouters=jupiterz`. It requires an allowed router (`metis`, `dflow`, `okx`), `signatureFeePayer=taker`, no gasless sponsorship, a versioned transaction with exactly one required signature, and the taker as signer. Real order size is at most 0.05 SOL. The order retains the original transaction message on the server.
3. The wallet signs the returned transaction. `execute` checks the authenticated wallet, server order ID, Jupiter `requestId`, quote freshness, unchanged message bytes, and a valid Ed25519 signature before calling `POST /execute`. The server supplies the stored `lastValidBlockHeight`. Each accepted order can be submitted once. An execution timeout or malformed response returns `EXECUTION_UNKNOWN`; callers must reconcile the transaction with the chain before offering another trade.

Both quote types preserve `requestId`, router, minimum output, signed price impact, slippage, fee rates and amounts, and fee payer details. The service enforces a local 10-second quote lifetime and any earlier provider `expireAt`. Accepted quotes and orders are stored in bounded, process-local memory. A production multi-instance API should persist the accepted order and its execution state in a shared store before exposing authenticated trading routes. A block height is forwarded to Jupiter; the current service does not query Solana RPC to compare it with the live height.

The service reports typed, sanitized errors. `UPSTREAM_UNAVAILABLE` covers quote transport and non-2xx responses; `UPSTREAM_INVALID` covers malformed quote data; `EXECUTION_UNKNOWN` covers uncertain `/execute` outcomes. It does not log or expose the API key or provider error bodies. API tests inject a fake `fetch` and never submit a live transaction.

Sources: [Jupiter get started](https://developers.jup.ag/docs/get-started), [Order and Execute](https://developers.jup.ag/docs/swap/order-and-execute), [Get Order reference](https://developers.jup.ag/docs/api-reference/swap/order), [Execute reference](https://developers.jup.ag/docs/api-reference/swap/execute), [gasless routing](https://developers.jup.ag/docs/swap/advanced/gasless).
