import { afterEach, expect, test } from "bun:test";
import { createHttpClient } from "../src/index.ts";

let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(() => {
  server?.stop(true);
  server = undefined;
});
const url = "https://example.test/resource";

test("Xior sends JSON and form bodies over HTTP and preserves error status and headers without retry", async () => {
  const bodies: string[] = [];
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      bodies.push(await request.text());
      return Response.json({ error: "busy" }, { status: 429, headers: { "retry-after": "60" } });
    },
  });
  const client = createHttpClient({ timeoutMs: 1000 });
  const endpoint = server.url.toString();
  const response = await client.request({ url: endpoint, method: "POST", data: { amount: "9007199254740993" } });
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  expect(response.data).toEqual({ error: "busy" });
  expect(bodies).toEqual(['{"amount":"9007199254740993"}']);
  await client.request({
    url: endpoint,
    method: "POST",
    data: new URLSearchParams({ assertion: "a+b/c=" }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(new URLSearchParams(bodies[1]).get("assertion")).toBe("a+b/c=");
});

test("the deadline still aborts a stalled response after headers arrive", async () => {
  let cancelled = false;
  const client = createHttpClient({
    timeoutMs: 25,
    transport: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"partial":'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await expect(client.request({ url })).rejects.toThrow("timed out");
  expect(cancelled).toBe(true);
});

test("caller cancellation aborts body parsing and a pre-aborted request never reaches the transport", async () => {
  let calls = 0;
  let cancelled = false;
  const client = createHttpClient({
    timeoutMs: 1000,
    transport: async () => {
      calls++;
      return new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      );
    },
  });
  const controller = new AbortController();
  const pending = client.request({
    url,
    signal: controller.signal,
    onResponse() {
      controller.abort();
    },
  });
  await expect(pending).rejects.toThrow();
  await expect(client.request({ url, signal: controller.signal })).rejects.toThrow();
  expect(calls).toBe(1);
  // Cancel the stream even when cancellation happens between headers and the first read.
  expect(cancelled).toBe(true);
});

test("oversized streamed success bodies stop reading at the byte cap", async () => {
  let cancelled = false;
  const client = createHttpClient({
    timeoutMs: 1000,
    maxResponseBytes: 8,
    transport: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('"123456789"'));
          },
          cancel() {
            cancelled = true;
          },
        }),
      ),
  });
  await expect(client.request({ url })).rejects.toMatchObject({ status: 200, code: "BODY_TOO_LARGE" });
  expect(cancelled).toBe(true);
});

test("rejects malformed JSON and skips parsing empty 204 responses", async () => {
  let reply = new Response("invalid-json");
  const client = createHttpClient({ timeoutMs: 1000, transport: async () => reply });
  await expect(client.request({ url })).rejects.toMatchObject({ status: 200, code: "INVALID_JSON" });
  reply = new Response(null, { status: 204 });
  expect(await client.request({ url, method: "DELETE" })).toMatchObject({ status: 204, data: undefined });
});

test("a caller deadline overrides the provider default and rejects a transport that ignores abort", async () => {
  const client = createHttpClient({ timeoutMs: 1000, transport: () => new Promise(() => {}) });
  await expect(client.request({ url, timeoutMs: 20 })).rejects.toThrow("timed out");
});

test("a late reply after cancellation cannot emit response side effects and its body is discarded", async () => {
  let reply!: (response: Response) => void;
  let started!: () => void;
  const ready = new Promise<void>((resolve) => {
    started = resolve;
  });
  const client = createHttpClient({
    timeoutMs: 1000,
    transport: () => {
      started();
      return new Promise<Response>((resolve) => {
        reply = resolve;
      });
    },
  });
  let responses = 0;
  let cancelled = false;
  const controller = new AbortController();
  const pending = client.request({
    url,
    signal: controller.signal,
    onResponse() {
      responses++;
    },
  });
  await ready;
  controller.abort();
  await expect(pending).rejects.toThrow();
  reply(
    new Response(
      new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
    ),
  );
  // Wait for the transport and Xior adapter to settle before checking side effects.
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(responses).toBe(0);
  expect(cancelled).toBe(true);
});

test("responses without a readable body stream still parse JSON and enforce the byte limit", async () => {
  const response = Response.json({ label: "🙂" });
  Object.defineProperty(response, "body", { value: null });
  const client = createHttpClient({ timeoutMs: 1000, maxResponseBytes: 15, transport: async () => response });
  await expect(client.request({ url })).rejects.toMatchObject({ code: "BODY_TOO_LARGE" });
  const valid = Response.json({ value: 1 });
  Object.defineProperty(valid, "body", { value: null });
  const fallback = createHttpClient({ timeoutMs: 1000, transport: async () => valid });
  expect((await fallback.request({ url })).data).toEqual({ value: 1 });
});
