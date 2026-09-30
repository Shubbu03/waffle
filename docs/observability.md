# Backend logging

`@waffle/observability` is the shared server-only logging package used by the API and watcher. It writes one JSON object per line to stdout with `time` (UTC ISO timestamp), `level`, `service`, and a stable `event` name. It has no runtime dependencies. Redirect stdout to a file or your process supervisor's log collector.

Set `LOG_LEVEL=info|warn|error|silent` in the consuming app's `.env`. The default is `info`; an unrecognized value also falls back to `info`. `warn` retains recoverable failures, and `error` retains server request/startup/shutdown failures. `silent` disables all records.

## What is logged

| Boundary | Records |
| --- | --- |
| API and watcher process | Startup, shutdown, startup/shutdown failures, and disabled API delivery configuration. |
| API HTTP failures | One `api.request.failed` per REST HTTP 5xx outside `/health`, with the generated request ID, method, registered route template, status, error code, and duration in milliseconds. Execution failures also include the attempt ID; mapped provider failures preserve safe cause codes. |
| Real execution failure | `api.trade.failed` for a persisted explicit Jupiter failure, including request ID, attempt ID, execution code, and the public transaction signature. |
| API database health, live and push workers | `dependency.failed` when an outage begins and `dependency.recovered` after a successful check/scan. Push retry and permanent-failure results also begin an outage. |
| Watcher catalog, RPC, connections and wallet recovery | The same transition records, with connection retry details or wallet/signature context when relevant. A reconnect is recovered only after subscription acknowledgements and a valid subscribed slot frame arrive; wallet recovery requires completed backfill. |

Repeated failures of the same dependency remain quiet until recovery. Ordinary successful HTTP requests, validation/authentication rejections, socket connects, healthy polls, ignored transactions, scored signals and inserts are not logged. The former per-signal and periodic watcher status console output has been removed; current state is still available through `/health`.

```json
{"time":"2026-09-30T00:00:00.000Z","level":"warn","service":"watcher","event":"dependency.failed","component":"watcher.connection","connectionId":0,"attempt":1,"retryInMs":1000,"reason":"socket-closed"}
```

Use an API error response's `requestId` or `X-Request-ID` to find its record. The logged route is a template such as `/signals/:id`, never the raw URL, query, or path parameters. Duration measures handling that failed request; it is not an end-to-end signal latency metric.

## Safe context

Use stable event names and the package's typed field allowlist. The same allowlist is enforced at runtime: bodies, headers, sessions, push tokens, provider URLs, signed transactions, SQL, and other unknown fields are dropped. Credential-bearing URLs, bearer credentials, PEM keys, and labeled secrets embedded in allowed strings are scrubbed as an additional safeguard. Do not pass arbitrary external text in an allowed field.

Errors retain their class, safe machine code/HTTP status when present, and up to eight source filename/line/column locations. Error messages, full stack text, SQL, and provider payloads are omitted; causes retain the same safe metadata to a bounded depth. API responses remain sanitized. A failing output sink does not interrupt request processing or watcher recovery.

Inject a logger with a custom `write` callback for tests. Production entrypoints pass one logger to their components so the app-local `LOG_LEVEL` applies consistently.

## Verification

```sh
bun run test:observability
bun run test:api
bun run test:watcher
bun run typecheck
bun run lint
```

Tests check structured output, filtering, secret omission, safe errors/causes, output failures, request correlation, explicit trade failures, and quiet dependency retries followed by recovery. They do not require provider credentials. API WebSocket tests require local port binding.
