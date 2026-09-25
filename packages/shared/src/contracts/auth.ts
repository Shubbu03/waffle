import { z } from "zod";
import { idSchema, solanaAddressSchema, timestampSchema } from "./primitives.ts";

export const signInInputSchema = z
  .strictObject({
    domain: z.string().min(1).max(253),
    uri: z.url().refine((value) => value.startsWith("https://"), "SIWS URI must use HTTPS"),
    version: z.literal("1"),
    chainId: z.enum(["mainnet", "solana:mainnet"]),
    nonce: z.string().regex(/^[A-Za-z0-9]{22,128}$/),
    issuedAt: timestampSchema,
    expirationTime: timestampSchema,
    statement: z.string().min(1).max(300),
  })
  .refine(
    (input) => {
      const issued = Date.parse(input.issuedAt);
      const expires = Date.parse(input.expirationTime);
      const uriHost = /^https:\/\/([^/?#]+)(?:[/?#]|$)/.exec(input.uri)?.[1];
      return uriHost === input.domain && expires > issued && expires - issued <= 5 * 60_000;
    },
    { message: "SIWS domain and challenge lifetime are invalid" },
  );

export const authChallengeResponseSchema = z.strictObject({
  challengeId: idSchema,
  signInInput: signInInputSchema,
});

/** Signed bytes are base64 on the JSON wire; the API verifies the exact decoded bytes. */
export const authVerifyRequestSchema = z.strictObject({
  challengeId: idSchema,
  accountAddress: solanaAddressSchema,
  signedMessageBase64: z.base64().min(1).max(4096),
  signatureBase64: z.base64().length(88).endsWith("=="),
});

export const sessionSchema = z.strictObject({
  userId: idSchema,
  walletAddress: solanaAddressSchema,
  expiresAt: timestampSchema,
});

export const authVerifyResponseSchema = z.strictObject({
  session: sessionSchema,
  accessToken: z.base64url().length(43),
});

export type SignInInput = z.infer<typeof signInInputSchema>;
export type AuthVerifyRequest = z.infer<typeof authVerifyRequestSchema>;
export type Session = z.infer<typeof sessionSchema>;
