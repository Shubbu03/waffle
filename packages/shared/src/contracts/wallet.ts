import { z } from "zod";
import { idSchema, solanaAddressSchema, timestampSchema } from "./primitives.ts";

export const walletSchema = z.strictObject({
  id: idSchema,
  address: solanaAddressSchema,
  label: z.string().trim().min(1).max(80),
  active: z.boolean(),
  source: z.enum(["catalog", "user"]),
  inclusionReason: z.string().trim().min(1).max(500),
  recentSupportedActivityAt: timestampSchema.nullable(),
});

export const walletCatalogResponseSchema = z.strictObject({
  items: z.array(walletSchema).max(100),
});

/** Paste-a-wallet tracking request. Label is optional; the server derives one otherwise. */
export const trackWalletRequestSchema = z.strictObject({
  address: solanaAddressSchema,
  label: z.string().trim().min(1).max(80).optional(),
});

/** IDs of catalog wallets the caller personally added to tracking. */
export const trackedWalletsResponseSchema = z.strictObject({
  items: z.array(idSchema).max(100),
});

export const trackWalletResponseSchema = z.strictObject({
  wallet: walletSchema,
  created: z.boolean(),
  followed: z.boolean(),
  /** Present when the wallet is very active; signals may lag behind. */
  warning: z.literal("very-active").optional(),
});

/** `paused` is true when this untrack stopped the last tracker and paused the watcher subscription. */
export const untrackWalletResponseSchema = z.strictObject({
  paused: z.boolean(),
});

export const walletSubscriptionSchema = z
  .strictObject({
    walletId: idSchema,
    alertsEnabled: z.boolean(),
    alertsEnabledAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((subscription) => subscription.alertsEnabled === (subscription.alertsEnabledAt !== null), {
    path: ["alertsEnabledAt"],
    message: "Alert opt-in timestamp must match alert state",
  });

/** Omission preserves the existing preference; a new follow defaults to alerts off. */
export const putWalletSubscriptionRequestSchema = z.strictObject({
  alertsEnabled: z.boolean().optional(),
});

export const walletSubscriptionsResponseSchema = z.strictObject({
  items: z.array(walletSubscriptionSchema).max(100),
});

export const pushTokenRegistrationSchema = z.strictObject({
  token: z
    .string()
    .min(1)
    .max(4096)
    .regex(/^[A-Za-z0-9_:.-]+$/),
  platform: z.literal("android"),
  notificationPermission: z.enum(["granted", "denied"]),
});

export type Wallet = z.infer<typeof walletSchema>;
export type WalletSubscription = z.infer<typeof walletSubscriptionSchema>;
export type PutWalletSubscriptionRequest = z.infer<typeof putWalletSubscriptionRequestSchema>;
export type TrackWalletRequest = z.infer<typeof trackWalletRequestSchema>;

export const pushTokenResponseSchema = z.strictObject({
  id: idSchema,
  platform: z.literal("android"),
  notificationPermission: z.enum(["granted", "denied"]),
  active: z.boolean(),
});
export type PushTokenRegistration = z.infer<typeof pushTokenRegistrationSchema>;
