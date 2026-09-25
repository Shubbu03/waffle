import { z } from "zod";
import { idSchema, solanaAddressSchema, timestampSchema } from "./primitives.ts";

export const walletSchema = z.strictObject({
  id: idSchema,
  address: solanaAddressSchema,
  label: z.string().trim().min(1).max(80),
  active: z.boolean(),
  inclusionReason: z.string().trim().min(1).max(500),
  recentSupportedActivityAt: timestampSchema.nullable(),
});

export const walletCatalogResponseSchema = z.strictObject({
  items: z.array(walletSchema).max(100),
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
  token: z.string().min(1).max(4096),
  platform: z.literal("android"),
  notificationPermission: z.enum(["granted", "denied"]),
});

export type Wallet = z.infer<typeof walletSchema>;
export type WalletSubscription = z.infer<typeof walletSubscriptionSchema>;
export type PutWalletSubscriptionRequest = z.infer<typeof putWalletSubscriptionRequestSchema>;
