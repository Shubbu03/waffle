# HTTP clients

All application-owned outbound HTTP requests use Xior through `@waffle/http`. The mobile API wrapper, watcher RPC/Pyth clients, shared Jupiter client, API FCM client, and catalog verifier configure it for their own boundary. Test transports are injected into Xior so tests exercise serialization and response handling.

| Consumer | Deadline | Response limit |
| --- | --- | --- |
| Mobile API | 10 seconds | 1 MB |
| Watcher RPC | Scheduler timeout, default 4 seconds | 1 MB |
| Pyth | 4 seconds | 100 KB |
| Jupiter quotes/prices | 8 seconds | 100 KB |
| Jupiter execution | 20 seconds | 100 KB |
| FCM OAuth/delivery | 4 seconds, delivery capped by remaining eligibility | 100 KB |
| Catalog verification script | 10 seconds | 1 MB |

Deadlines and caller cancellation remain active through body reading and JSON parsing. Streaming success responses stop at the byte limit. React Native responses without a readable stream use `text()` and validate the resulting byte size. Xior parses error bodies internally; the client checks that parsed payload's size before returning it. Empty 204/205 responses do not require JSON.

Clients disable redirects and return HTTP status, headers, and unknown JSON data. Consumer modules validate domain schemas and translate errors. The mobile wrapper supplies bearer tokens per request and reports 401 responses for that exact token; public requests cannot inherit an earlier account's credentials.

No Xior retry plugin is installed. Watcher retries still consume the shared RPC scheduler budget; FCM keeps its delivery cooldown and retry policy. Jupiter execution is submitted once because a transport failure cannot prove that a trade did not land.

The lint configuration prohibits global `fetch`. Bun's `fetch` server handler and Hono's `app.fetch` remain incoming request handlers, not outbound HTTP calls. Dependency internals and wallet SDK transports are managed by those dependencies.

Run `bun run --filter '@waffle/http' test`, mobile/API/watcher tests, `bun run typecheck`, and `bun run lint`. Wire tests require ephemeral loopback-port access. Android/device verification is performed manually by the user.
