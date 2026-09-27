import { createHash, randomBytes } from "node:crypto";
import { ed25519 } from "@noble/curves/ed25519";
import { parseSignInMessage, verifySignIn } from "@solana/wallet-standard-util";
import type { AuthQuery, AuthStore } from "@waffle/db";
import { type AuthVerifyRequest, type Session, signInInputSchema } from "@waffle/shared";
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
    async challenge() {
      const now = Date.now();
      const signInInput = signInInputSchema.parse({
        domain,
        uri,
        version: "1",
        chainId: "solana:mainnet",
        nonce: randomBytes(16).toString("hex"),
        issuedAt: new Date(now).toISOString(),
        expirationTime: new Date(now + 5 * 60_000).toISOString(),
        statement: "Sign in to waffle. This does not authorize any transactions.",
      });
      const challengeId = await store.createChallenge(signInInput, hashSecret(signInInput.nonce));
      return { challengeId, signInInput };
    },
    async verify(request: AuthVerifyRequest) {
      const challenge = await store.findChallenge(request.challengeId);
      if (!challenge || challenge.domain !== domain || challenge.uri !== uri) return null;
      // Reconstruct the expected input from storage. The wire message supplies only the hashed nonce.
      try {
        const signedMessage = Buffer.from(request.signedMessageBase64, "base64");
        const signature = Buffer.from(request.signatureBase64, "base64");
        const publicKey = bs58.decode(request.accountAddress);
        const parsed = parseSignInMessage(signedMessage);
        if (
          !parsed?.nonce ||
          hashSecret(parsed.nonce) !== challenge.nonceHash ||
          publicKey.length !== 32 ||
          signature.length !== 64
        )
          return null;
        const valid = verifySignIn(
          {
            domain: challenge.domain,
            uri: challenge.uri,
            version: challenge.version,
            chainId: challenge.chainId,
            statement: challenge.statement,
            issuedAt: challenge.issuedAt.toISOString(),
            expirationTime: challenge.expiresAt.toISOString(),
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
      const session = await store.completeSignIn(challenge, request.accountAddress, hashSecret(accessToken));
      return session ? { session, accessToken } : null;
    },
  };
}

/** Private handlers must perform their work through this callback, using the supplied transaction. */
export async function withOwner(
  c: Context<AppEnv>,
  store: AuthStore,
  run: (query: AuthQuery, session: Session) => Promise<Response>,
): Promise<Response> {
  const token = bearerToken(c.req.header("authorization"));
  const result = token ? await store.withSession(hashSecret(token), run) : null;
  if (result) return result;
  c.header("WWW-Authenticate", "Bearer");
  return apiError(c, 401, "UNAUTHORIZED", "Valid session required");
}
