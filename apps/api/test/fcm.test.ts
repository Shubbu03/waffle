import { beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync, verify } from "node:crypto";
import { createFcm } from "../src/fcm.ts";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const credentials = JSON.stringify({
  project_id: "waffle-test",
  client_email: "sender@waffle-test.iam.gserviceaccount.com",
  private_key: keys.privateKey.export({ type: "pkcs8", format: "pem" }),
});
let clock: number;
let requests: { url: string; init: RequestInit }[];
let reply: () => Response;
const fetcher = async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  requests.push({ url, init: init ?? {} });
  if (url === "https://oauth2.googleapis.com/token")
    return Response.json({ access_token: "access-secret", token_type: "Bearer", expires_in: 3600 });
  return reply();
};
const message = () => ({
  token: "device-secret",
  expiresAt: clock + 89000,
  data: {
    id: "signal-id",
    eventId: "9007199254740993",
    score: "80",
    wallet: "wallet",
    mint: "mint",
    slot: "100",
    age: "1",
  },
});
const providerError = (status: number, code?: string, headers?: Record<string, string>, badRequest = false) =>
  Response.json(
    {
      error: {
        message: "never persist this device-secret",
        details: [
          ...(code ? [{ "@type": "type.googleapis.com/google.firebase.fcm.v1.FcmError", errorCode: code }] : []),
          ...(badRequest ? [{ "@type": "type.googleapis.com/google.rpc.BadRequest" }] : []),
        ],
      },
    },
    { status, ...(headers ? { headers } : {}) },
  );
beforeEach(() => {
  clock = Date.now();
  requests = [];
  reply = () => Response.json({ name: "projects/waffle-test/messages/accepted" });
});

test("uses a verified RS256 service-account assertion, caches OAuth, and sends bounded data-only messages", async () => {
  const fcm = createFcm(credentials, fetcher, () => clock);
  const [send] = await Promise.all([fcm.prepare(), fcm.prepare()]);
  expect(requests).toHaveLength(1);
  const oauth = requests[0];
  const assertion = new URLSearchParams(String(oauth?.init.body)).get("assertion");
  if (!assertion) throw new Error("Expected assertion");
  const parts = assertion.split(".");
  expect(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString())).toEqual({ alg: "RS256", typ: "JWT" });
  const claims = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString());
  expect(claims).toEqual({
    iss: "sender@waffle-test.iam.gserviceaccount.com",
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: "https://oauth2.googleapis.com/token",
    iat: Math.floor(clock / 1000),
    exp: Math.floor(clock / 1000) + 3600,
  });
  expect(
    verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      keys.publicKey,
      Buffer.from(parts[2] ?? "", "base64url"),
    ),
  ).toBe(true);
  expect(await send(message())).toEqual({ status: "sent" });
  const request = requests[1];
  expect(request?.url).toBe("https://fcm.googleapis.com/v1/projects/waffle-test/messages:send");
  expect(request?.init.redirect).toBe("error");
  expect(new Headers(request?.init.headers).get("authorization")).toBe("Bearer access-secret");
  const payload = JSON.parse(String(request?.init.body)).message;
  expect(payload).toEqual({ token: "device-secret", data: message().data, android: { priority: "HIGH", ttl: "89s" } });
  expect(Object.values(payload.data).every((value) => typeof value === "string")).toBe(true);
  expect(request?.init.signal).toBeInstanceOf(AbortSignal);
  await fcm.prepare();
  expect(requests).toHaveLength(2);
  clock += 3600000;
  await fcm.prepare();
  expect(requests).toHaveLength(3);
});

test.each([
  [404, "UNREGISTERED", false, "invalid-token"],
  [400, "INVALID_ARGUMENT", false, "invalid-token"],
  [400, "INVALID_ARGUMENT", true, "failed"],
  [404, undefined, false, "failed"],
  [403, "SENDER_ID_MISMATCH", false, "failed"],
  [500, undefined, false, "retry"],
] as const)("classifies HTTP %s / %s safely (bad request %s)", async (status, code, badRequest, expected) => {
  reply = () => providerError(status, code, undefined, badRequest);
  const send = await createFcm(credentials, fetcher, () => clock).prepare();
  const result = await send(message());
  expect(result.status).toBe(expected);
  expect(JSON.stringify(result)).not.toContain("device-secret");
});

test("429 pauses subsequent sends and respects a longer Retry-After header", async () => {
  reply = () => providerError(429, "QUOTA_EXCEEDED", { "Retry-After": "120" });
  const send = await createFcm(credentials, fetcher, () => clock).prepare();
  expect(await send(message())).toMatchObject({ status: "retry", retryAfterMs: 120000 });
  expect(await send(message())).toMatchObject({ status: "retry", retryAfterMs: 120000 });
  expect(requests).toHaveLength(2);
});

test("Retry-After dates are honored and expired messages never reach FCM", async () => {
  const retryAt = new Date(clock + 45000).toUTCString();
  reply = () => providerError(503, "UNAVAILABLE", { "Retry-After": retryAt });
  const send = await createFcm(credentials, fetcher, () => clock).prepare();
  expect(await send(message())).toMatchObject({ status: "retry", retryAfterMs: Date.parse(retryAt) - clock });
  expect(await send({ ...message(), expiresAt: clock })).toEqual({ status: "expired", code: "EXPIRED" });
  expect(requests).toHaveLength(2);
});

test("401 invalidates cached OAuth credentials; malformed acceptance remains retryable", async () => {
  const fcm = createFcm(credentials, fetcher, () => clock);
  const send = await fcm.prepare();
  reply = () => providerError(401);
  expect((await send(message())).status).toBe("retry");
  clock += 11000;
  const refreshed = await fcm.prepare();
  expect(requests.filter((request) => request.url.includes("oauth2"))).toHaveLength(2);
  reply = () => Response.json({ unexpected: true });
  expect(await refreshed(message())).toEqual({ status: "retry", code: "FCM_INVALID_RESPONSE" });
});

test("configuration and OAuth errors are sanitized and cannot redirect credentials", async () => {
  for (const input of ["private-secret", "{}", credentials.replace('waffle-test"', '../../other"')])
    expect(() => createFcm(input)).toThrow("Invalid FCM_SERVICE_ACCOUNT_JSON");
  const failed = createFcm(credentials, async () => Response.json({ error: "private-secret" }, { status: 400 }));
  await expect(failed.prepare()).rejects.toThrow("FCM authorization unavailable");
});
