import { type Wallet, walletSchema } from "@waffle/shared";
import { and, eq, sql } from "drizzle-orm";
import type { DatabaseExecutor } from "./database.ts";
import { userTrackedWallets, userWalletSubscriptions, watchedWallets } from "./schema/index.ts";

/** Each user may personally track at most this many wallets. */
export const MAX_TRACKED_PER_USER = 3;
/** Total active tracked wallets (catalog + user). Stays well under the watcher's hard cap of 100. */
export const MAX_ACTIVE_WALLETS = 40;

export const USER_WALLET_INCLUSION_REASON = "Custom wallet added by a user for personal tracking.";

export type AddTrackedWalletResult =
  | { status: "ok"; wallet: Wallet; created: boolean; followed: boolean }
  | { status: "user-limit" }
  | { status: "catalog-limit" }
  | { status: "paused-catalog" };

export type RemoveTrackedWalletResult = { status: "ok"; paused: boolean } | { status: "not-tracked" };

function abbreviate(address: string): string {
  return address.length <= 10 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;
}

type WalletRow = {
  id: string;
  address: string;
  label: string;
  active: boolean;
  source: string;
  inclusionReason: string;
  recentSupportedActivityAt: Date | null;
};

function serializeWallet(row: WalletRow): Wallet {
  return walletSchema.parse({
    ...row,
    recentSupportedActivityAt: row.recentSupportedActivityAt?.toISOString() ?? null,
  });
}

const walletColumns = {
  id: watchedWallets.id,
  address: watchedWallets.address,
  label: watchedWallets.label,
  active: watchedWallets.active,
  source: watchedWallets.source,
  inclusionReason: watchedWallets.inclusionReason,
  recentSupportedActivityAt: watchedWallets.recentSupportedActivityAt,
};

/** Use only the authenticated transaction and user ID supplied by the API owner operation. */
export function createWalletTrackingStore(
  tx: DatabaseExecutor,
  userId: string,
  network: import("@waffle/shared").SolanaNetwork = "mainnet",
) {
  async function activeCount(): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(watchedWallets)
      .where(and(eq(watchedWallets.active, true), eq(watchedWallets.network, network)));
    return row?.count ?? 0;
  }

  async function userCount(): Promise<number> {
    const [row] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userTrackedWallets)
      .innerJoin(watchedWallets, eq(watchedWallets.id, userTrackedWallets.watchedWalletId))
      .where(and(eq(userTrackedWallets.userId, userId), eq(watchedWallets.network, network)));
    return row?.count ?? 0;
  }

  async function ensureFollow(walletId: string): Promise<void> {
    await tx
      .insert(userWalletSubscriptions)
      .values({ userId, watchedWalletId: walletId, alertsEnabled: false })
      .onConflictDoNothing();
  }

  async function add(address: string, label?: string): Promise<AddTrackedWalletResult> {
    const [existing] = await tx
      .select(walletColumns)
      .from(watchedWallets)
      .where(and(eq(watchedWallets.address, address), eq(watchedWallets.network, network)));

    if (existing) {
      if (existing.source === "catalog") {
        if (!existing.active) return { status: "paused-catalog" };
        await ensureFollow(existing.id);
        return { status: "ok", wallet: serializeWallet(existing), created: false, followed: true };
      }
      // Existing user-sourced wallet: idempotent when already tracked by this user.
      const [already] = await tx
        .select({ walletId: userTrackedWallets.watchedWalletId })
        .from(userTrackedWallets)
        .where(and(eq(userTrackedWallets.userId, userId), eq(userTrackedWallets.watchedWalletId, existing.id)));
      if (already) {
        await ensureFollow(existing.id);
        return { status: "ok", wallet: serializeWallet(existing), created: false, followed: true };
      }
      if ((await userCount()) >= MAX_TRACKED_PER_USER) return { status: "user-limit" };
      if (!existing.active) {
        if ((await activeCount()) >= MAX_ACTIVE_WALLETS) return { status: "catalog-limit" };
        await tx.update(watchedWallets).set({ active: true }).where(eq(watchedWallets.id, existing.id));
      }
      await tx.insert(userTrackedWallets).values({ userId, watchedWalletId: existing.id }).onConflictDoNothing();
      await ensureFollow(existing.id);
      return {
        status: "ok",
        wallet: serializeWallet({ ...existing, active: true }),
        created: false,
        followed: true,
      };
    }

    if ((await userCount()) >= MAX_TRACKED_PER_USER) return { status: "user-limit" };
    if ((await activeCount()) >= MAX_ACTIVE_WALLETS) return { status: "catalog-limit" };

    const [inserted] = await tx
      .insert(watchedWallets)
      .values({
        address,
        network,
        label: label?.trim() ? label.trim() : `Tracked · ${abbreviate(address)}`,
        active: true,
        source: "user",
        inclusionReason: USER_WALLET_INCLUSION_REASON,
      })
      .onConflictDoNothing()
      .returning(walletColumns);
    if (!inserted) {
      // Lost a race on the unique address; the winning row now exists.
      const [winner] = await tx
        .select(walletColumns)
        .from(watchedWallets)
        .where(and(eq(watchedWallets.address, address), eq(watchedWallets.network, network)));
      if (!winner) return { status: "catalog-limit" };
      if ((await userCount()) >= MAX_TRACKED_PER_USER) return { status: "user-limit" };
      await tx.insert(userTrackedWallets).values({ userId, watchedWalletId: winner.id }).onConflictDoNothing();
      await ensureFollow(winner.id);
      return { status: "ok", wallet: serializeWallet(winner), created: false, followed: true };
    }
    await tx.insert(userTrackedWallets).values({ userId, watchedWalletId: inserted.id }).onConflictDoNothing();
    await ensureFollow(inserted.id);
    return { status: "ok", wallet: serializeWallet(inserted), created: true, followed: true };
  }

  async function remove(walletId: string): Promise<RemoveTrackedWalletResult> {
    const [scoped] = await tx
      .select({ id: watchedWallets.id })
      .from(watchedWallets)
      .where(and(eq(watchedWallets.id, walletId), eq(watchedWallets.network, network)));
    if (!scoped) return { status: "not-tracked" };
    const removed = await tx
      .delete(userTrackedWallets)
      .where(and(eq(userTrackedWallets.userId, userId), eq(userTrackedWallets.watchedWalletId, walletId)))
      .returning({ walletId: userTrackedWallets.watchedWalletId });
    if (removed.length === 0) return { status: "not-tracked" };

    await tx
      .delete(userWalletSubscriptions)
      .where(and(eq(userWalletSubscriptions.userId, userId), eq(userWalletSubscriptions.watchedWalletId, walletId)));

    const [remaining] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(userTrackedWallets)
      .where(eq(userTrackedWallets.watchedWalletId, walletId));
    const [wallet] = await tx
      .select({ source: watchedWallets.source })
      .from(watchedWallets)
      .where(eq(watchedWallets.id, walletId));
    const shouldPause = (remaining?.count ?? 0) === 0 && wallet?.source === "user";
    if (shouldPause) {
      await tx.update(watchedWallets).set({ active: false }).where(eq(watchedWallets.id, walletId));
    }
    return { status: "ok", paused: shouldPause };
  }

  async function mine(): Promise<string[]> {
    const rows = await tx
      .select({ walletId: userTrackedWallets.watchedWalletId })
      .from(userTrackedWallets)
      .innerJoin(watchedWallets, eq(watchedWallets.id, userTrackedWallets.watchedWalletId))
      .where(and(eq(userTrackedWallets.userId, userId), eq(watchedWallets.network, network)))
      .limit(101);
    return rows.map((row) => row.walletId);
  }

  return { add, remove, mine };
}

export type WalletTrackingStore = ReturnType<typeof createWalletTrackingStore>;
