import { createPrivateKey, sign } from "node:crypto";
import type { PushSender, PushSendResult } from "@waffle/db";
import { z } from "zod";

const oauthUrl = "https://oauth2.googleapis.com/token";
const scope = "https://www.googleapis.com/auth/firebase.messaging";
const credentialsSchema = z.object({
  project_id: z.string().regex(/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/),
  client_email: z.email().endsWith(".gserviceaccount.com"),
  private_key: z.string().min(1).max(16384),
});
const accessSchema = z.object({
  access_token: z.string().min(1).max(8192),
  expires_in: z.number().int().min(60).max(3600),
  token_type: z.literal("Bearer"),
});
const errorSchema = z.object({
  error: z.object({ details: z.array(z.object({ "@type": z.string(), errorCode: z.string().optional() })).optional() }),
});
const acceptedSchema = z.object({ name: z.string().min(1).max(512) });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function retryAfter(value: string | null, now: number) {
  if (!value) return 0;
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) ? Math.max(0, delay) : 0;
}

/** HTTP v1, with a service-account JWT exchanged only at Google's fixed OAuth endpoint. */
export function createFcm(
  rawCredentials: string,
  fetcher: (input: string | URL | Request, init?: RequestInit) => Promise<Response> = fetch,
  now = Date.now,
) {
  let credentials: z.infer<typeof credentialsSchema>;
  let key: ReturnType<typeof createPrivateKey>;
  try {
    credentials = credentialsSchema.parse(JSON.parse(rawCredentials));
    key = createPrivateKey(credentials.private_key);
    if (key.asymmetricKeyType !== "rsa" || (key.asymmetricKeyDetails?.modulusLength ?? 0) < 2048)
      throw new Error("Invalid signing key");
  } catch {
    throw new Error("Invalid FCM_SERVICE_ACCOUNT_JSON");
  }
  const sendUrl = `https://fcm.googleapis.com/v1/projects/${credentials.project_id}/messages:send`;
  let cached: { token: string; expiresAt: number } | undefined;
  let refreshing: Promise<string> | undefined;
  let cooldownUntil = 0;

  async function accessToken() {
    if (cached && cached.expiresAt > now() + 60_000) return cached.token;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      const issuedAt = Math.floor(now() / 1000);
      const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
        iss: credentials.client_email,
        scope,
        aud: oauthUrl,
        iat: issuedAt,
        exp: issuedAt + 3600,
      })}`;
      const assertion = `${unsigned}.${sign("RSA-SHA256", Buffer.from(unsigned), key).toString("base64url")}`;
      const response = await fetcher(oauthUrl, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(4000),
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error("FCM authorization unavailable");
      }
      const data = accessSchema.parse(await response.json());
      cached = { token: data.access_token, expiresAt: issuedAt * 1000 + data.expires_in * 1000 };
      return cached.token;
    })()
      .catch(() => {
        throw new Error("FCM authorization unavailable");
      })
      .finally(() => {
        refreshing = undefined;
      });
    return refreshing;
  }

  return {
    async prepare(): Promise<PushSender> {
      const bearer = await accessToken();
      return async (message): Promise<PushSendResult> => {
        const remaining = message.expiresAt - now();
        if (remaining <= 0) return { status: "expired", code: "EXPIRED" };
        if (cooldownUntil > now())
          return { status: "retry", code: "FCM_COOLDOWN", retryAfterMs: cooldownUntil - now() };
        let response: Response;
        try {
          response = await fetcher(sendUrl, {
            method: "POST",
            redirect: "error",
            signal: AbortSignal.timeout(Math.min(4000, remaining)),
            headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              message: {
                token: message.token,
                data: message.data,
                android: { priority: "HIGH", ttl: `${Math.floor(remaining / 1000)}s` },
              },
            }),
          });
          if (response.ok) {
            return acceptedSchema.safeParse(await response.json()).success
              ? { status: "sent" }
              : { status: "retry", code: "FCM_INVALID_RESPONSE" };
          }
          const body = errorSchema.safeParse(await response.json().catch(() => null));
          const details = body.success ? (body.data.error.details ?? []) : [];
          const code = details.find(
            (detail) => detail["@type"] === "type.googleapis.com/google.firebase.fcm.v1.FcmError",
          )?.errorCode;
          const badRequest = details.some((detail) => detail["@type"] === "type.googleapis.com/google.rpc.BadRequest");
          if (
            (response.status === 404 && code === "UNREGISTERED") ||
            (response.status === 400 && code === "INVALID_ARGUMENT" && !badRequest)
          )
            return { status: "invalid-token", code: "FCM_INVALID_TOKEN" };
          if (response.status === 401) cached = undefined;
          if (response.status === 429 || response.status >= 500 || response.status === 401) {
            const delay = Math.max(
              response.status === 429 ? 60_000 : 10_000,
              retryAfter(response.headers.get("retry-after"), now()),
            );
            cooldownUntil = now() + delay;
            return { status: "retry", code: `FCM_HTTP_${response.status}`, retryAfterMs: delay };
          }
          return { status: "failed", code: `FCM_HTTP_${response.status}` };
        } catch {
          return { status: "retry", code: "FCM_TRANSPORT_ERROR" };
        }
      };
    },
  };
}
