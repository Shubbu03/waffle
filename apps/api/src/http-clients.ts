import { createHttpClient, type HttpTransport } from "@waffle/http";

export function createFcmClient(transport?: HttpTransport) {
  return createHttpClient({ timeoutMs: 4000, maxResponseBytes: 100_000, transport });
}
