import { createHttpClient, type HttpTransport } from "@waffle/http";

export function createJupiterClient(transport?: HttpTransport) {
  return createHttpClient({ timeoutMs: 8000, maxResponseBytes: 100_000, transport });
}
