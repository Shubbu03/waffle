import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { parseSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import type { AuthStore, DatabaseExecutor } from "@waffle/db";
import { type AuthVerifyRequest, type Session, SIWS_MAX_SKEW_SEC } from "@waffle/shared";
import bs58 from "bs58";
import type { Context } from "hono";
import { apiError } from "./errors.ts";
import type { AppEnv } from "./types.ts";

export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret).digest("hex");
}

export function bearerToken(authorization: string | undefined): string | null {
  return /^Bearer ([A-Za-z0-9_-]{43})$/i.exec(authorization ?? "")?.[1] ?? null;
}

export function createAuthService(store: AuthStore, authUri: string) {
  const uri = new URL(authUri).href;
  const domain = new URL(uri).host;
  return {
    async verify(request: AuthVerifyRequest) {
      // Stateless SIWS: trust flows from the signature + freshness, not a stored
      // challenge. Replays within the skew window only re-mint an equivalent
      // session for the same wallet — useless without the private key.
      try {
        const signedMessage = Buffer.from(request.signedMessageBase64, "base64");
        const signature = Buffer.from(request.signatureBase64, "base64");
        const publicKey = bs58.decode(request.accountAddress);
        const parsed = parseSignInMessage(signedMessage);
        if (!parsed?.nonce || publicKey.length !== 32 || signature.length !== 64) return null;
        if (parsed.domain !== domain || parsed.uri !== uri) return null;
        if (parsed.version !== "1" || (parsed.chainId !== "mainnet" && parsed.chainId !== "solana:mainnet")) {
          return null;
        }
        if (!parsed.statement) return null;
        const now = Date.now();
        const { issuedAt, expirationTime } = parsed;
        if (typeof issuedAt !== "string" || typeof expirationTime !== "string") return null;
        const issued = Date.parse(issuedAt);
        const expires = Date.parse(expirationTime);
        if (!Number.isFinite(issued) || Math.abs(now - issued) > SIWS_MAX_SKEW_SEC * 1000) return null;
        if (!Number.isFinite(expires) || expires <= now) return null;
        const valid = verifySignIn(
          {
            domain: parsed.domain,
            uri: parsed.uri,
            version: parsed.version,
            chainId: parsed.chainId,
            statement: parsed.statement,
            issuedAt,
            expirationTime,
            nonce: parsed.nonce,
            address: request.accountAddress,
          },
          {
            account: {
              address: request.accountAddress,
              publicKey,
              chains: ["solana:mainnet"],
              features: ["solana:signIn"],
            },
            signedMessage,
            signature,
            signatureType: "ed25519",
          },
        );
        // Wallet Standard uses consensus-friendly ZIP-215 verification. Auth also rejects
        // small-order public keys, whose signatures do not prove wallet ownership.
        if (!valid || !ed25519.verify(signature, signedMessage, publicKey, { zip215: false })) return null;
      } catch {
        // Malformed bytes and invalid points/signatures are authentication failures.
        return null;
      }
      const accessToken = randomBytes(32).toString("base64url");
      const session = await store.completeSignIn(request.accountAddress, hashSecret(accessToken));
      return session ? { session, accessToken } : null;
    },
  };
}

/** Private handlers must perform their work through this callback, using the supplied transaction. */
export async function withOwner(
  c: Context<AppEnv>,
  store: AuthStore,
  run: (tx: DatabaseExecutor, session: Session) => Promise<Response>,
): Promise<Response> {
  const token = bearerToken(c.req.header("authorization"));
  const result = token ? await store.withSession(hashSecret(token), run) : null;
  if (result) return result;
  c.header("WWW-Authenticate", "Bearer");
  return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
}
