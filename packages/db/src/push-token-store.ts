import { createHash } from "node:crypto";
import type { PushTokenRegistration } from "@waffle/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { pushTokens, users } from "./schema/index.ts";

const publicColumns = {
  id: pushTokens.id,
  platform: pushTokens.platform,
  notificationPermission: pushTokens.notificationPermission,
  active: pushTokens.active,
};

/** Only use within auth.withSession: RLS and explicit owner predicates both apply. */
export function createPushTokenStore(tx: DatabaseExecutor, userId: string) {
  return {
    async register(input: PushTokenRegistration) {
      // Serialize registrations for this owner so concurrent requests cannot bypass the device cap.
      await tx.select({ id: users.id }).from(users).where(eq(users.id, userId)).for("update");
      const tokenHash = createHash("sha256").update(input.token).digest("hex");
      const owned = await tx.select(publicColumns).from(pushTokens).where(eq(pushTokens.userId, userId)).limit(11);
      const [existing] = await tx
        .select(publicColumns)
        .from(pushTokens)
        .where(and(eq(pushTokens.userId, userId), eq(pushTokens.tokenHash, tokenHash)));
      const active = input.notificationPermission === "granted";
      if (existing) {
        // Preserve the consent cutoff on retries; re-enabling must not alert for older events.
        if (existing.active === active && existing.notificationPermission === input.notificationPermission)
          return { status: "ok" as const, registration: existing };
        const [row] = await tx
          .update(pushTokens)
          .set({ active, notificationPermission: input.notificationPermission, updatedAt: sql`clock_timestamp()` })
          .where(and(eq(pushTokens.id, existing.id), eq(pushTokens.userId, userId)))
          .returning(publicColumns);
        if (!row) throw new Error("Push registration update failed");
        return { status: "ok" as const, registration: row };
      }
      if (owned.length >= 10) return { status: "limit" as const };
      const [row] = await tx
        .insert(pushTokens)
        .values({
          userId,
          tokenHash,
          token: input.token,
          platform: input.platform,
          notificationPermission: input.notificationPermission,
          active,
          createdAt: sql`clock_timestamp()`,
          updatedAt: sql`clock_timestamp()`,
        })
        .onConflictDoNothing({ target: pushTokens.tokenHash })
        .returning(publicColumns);
      // Never transfer an unseen token away from another owner, even if the caller knows its value.
      return row ? { status: "ok" as const, registration: row } : { status: "conflict" as const };
    },
    async remove(id: string) {
      await tx.delete(pushTokens).where(and(eq(pushTokens.id, id), eq(pushTokens.userId, userId)));
    },
  };
}
