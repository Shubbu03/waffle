import { createHttpClient, type HttpTransport } from "@waffle/http";

export function createRpcClient(timeoutMs: number, transport?: HttpTransport) {
  return createHttpClient({ timeoutMs, transport });
}

export function createPythClient(transport?: HttpTransport) {
  return createHttpClient({ timeoutMs: 4000, maxResponseBytes: 100_000, transport });
}
