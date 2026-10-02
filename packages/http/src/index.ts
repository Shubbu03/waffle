import xior from "xior";

/** Injectable Xior transport for deterministic tests; production uses Xior's own transport. */
export type HttpTransport = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
export type HttpRequest = {
  url: string;
  method?: string;
  data?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | null | undefined;
  timeoutMs?: number;
  onResponse?: (status: number) => void;
};
export type HttpResponse = { status: number; headers: Headers; data: unknown };
export type HttpClient = { request: (request: HttpRequest) => Promise<HttpResponse> };

export class HttpResponseError extends Error {
  constructor(
    readonly status: number,
    readonly code: "INVALID_JSON" | "BODY_TOO_LARGE",
  ) {
    super(code);
  }
}

function assertNotAborted(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason ?? new Error("HTTP request aborted");
}

async function readJson(response: Response, parsed: unknown, signal: AbortSignal, limit: number): Promise<unknown> {
  if (signal.aborted) {
    void response.body?.cancel().catch(() => {});
    assertNotAborted(signal);
  }
  if (response.status === 204 || response.status === 205) return undefined;
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > limit) {
    await response.body?.cancel().catch(() => {});
    throw new HttpResponseError(response.status, "BODY_TOO_LARGE");
  }
  // Xior reads HTTP-error bodies itself, even with responseType: original.
  if (response.bodyUsed) {
    if (new TextEncoder().encode(JSON.stringify(parsed) ?? "").byteLength > limit)
      throw new HttpResponseError(response.status, "BODY_TOO_LARGE");
    return parsed;
  }
  let text: string;
  if (response.body?.getReader) {
    const reader = response.body.getReader();
    const cancel = () => {
      void reader.cancel().catch(() => {});
    };
    signal.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        assertNotAborted(signal);
        const chunk = await reader.read();
        assertNotAborted(signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          throw new HttpResponseError(response.status, "BODY_TOO_LARGE");
        }
        chunks.push(chunk.value);
      }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      text = new TextDecoder().decode(bytes);
    } finally {
      signal.removeEventListener("abort", cancel);
      reader.releaseLock();
    }
  } else {
    // React Native's Response can expose text() without a readable body stream.
    text = await response.text();
    if (new TextEncoder().encode(text).byteLength > limit)
      throw new HttpResponseError(response.status, "BODY_TOO_LARGE");
  }
  assertNotAborted(signal);
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new HttpResponseError(response.status, "INVALID_JSON");
  }
}

/** Shared Xior policy: explicit deadlines, bounded JSON, no automatic retries or credential redirects. */
export function createHttpClient(options: {
  timeoutMs: number;
  maxResponseBytes?: number;
  transport?: HttpTransport | undefined;
}): HttpClient {
  const client = xior.create({
    responseType: "original",
    validateResponse: () => true,
    redirect: "error",
    ...(options.transport ? { fetch: options.transport } : {}),
  });
  return {
    async request(request) {
      const controller = new AbortController();
      const abort = () => controller.abort(request.signal?.reason);
      request.signal?.addEventListener("abort", abort, { once: true });
      if (request.signal?.aborted) abort();
      const timer = setTimeout(
        () => controller.abort(new Error("HTTP request timed out")),
        request.timeoutMs ?? options.timeoutMs,
      );
      let rejectAborted!: (reason: unknown) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAborted = reject;
      });
      const reject = () => rejectAborted(controller.signal.reason);
      controller.signal.addEventListener("abort", reject, { once: true });
      if (controller.signal.aborted) reject();
      try {
        return await Promise.race([
          (async () => {
            assertNotAborted(controller.signal);
            const result = await client.request<unknown>({
              url: request.url,
              method: request.method ?? "GET",
              data: request.data,
              headers: request.headers ?? {},
              signal: controller.signal,
            });
            if (controller.signal.aborted) {
              void result.response.body?.cancel().catch(() => {});
              assertNotAborted(controller.signal);
            }
            request.onResponse?.(result.status);
            const data = await readJson(
              result.response,
              result.data,
              controller.signal,
              options.maxResponseBytes ?? 1_000_000,
            );
            return { status: result.status, headers: result.headers, data };
          })(),
          aborted,
        ]);
      } finally {
        clearTimeout(timer);
        request.signal?.removeEventListener("abort", abort);
        controller.signal.removeEventListener("abort", reject);
      }
    },
  };
}
