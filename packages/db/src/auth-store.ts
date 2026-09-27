import type { Session, SignInInput } from "@waffle/shared";
import { and, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseExecutor, DatabaseTransaction } from "./database.ts";
import { authChallenges, sessions, users } from "./schema/index.ts";

export type StoredChallenge = Omit<typeof authChallenges.$inferSelect, "consumedAt">;

export function createAuthStore(transaction: DatabaseTransaction) {
  return {
    async createChallenge(input: SignInInput, nonceHash: string): Promise<string> {
      return transaction(async (tx) => {
        const [row] = await tx
          .insert(authChallenges)
          .values({
            nonceHash,
            domain: input.domain,
            uri: input.uri,
            version: input.version,
            chainId: input.chainId,
            statement: input.statement,
            issuedAt: new Date(input.issuedAt),
            expiresAt: new Date(input.expirationTime),
          })
          .returning({ id: authChallenges.id });
        if (!row) throw new Error("Challenge insert failed");
        return row.id;
      });
    },
    async findChallenge(id: string): Promise<StoredChallenge | null> {
      return transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(authChallenges)
          .where(
            and(
              eq(authChallenges.id, id),
              isNull(authChallenges.consumedAt),
              lte(authChallenges.issuedAt, sql`clock_timestamp()`),
              gt(authChallenges.expiresAt, sql`clock_timestamp()`),
            ),
          );
        return row ?? null;
      });
    },
    async completeSignIn(
      challenge: StoredChallenge,
      walletAddress: string,
      tokenHash: string,
    ): Promise<Session | null> {
      return transaction(async (tx) => {
        // The conditional UPDATE serializes contenders; only one may mint a session.
        const [consumed] = await tx
          .update(authChallenges)
          .set({ consumedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(authChallenges.id, challenge.id),
              eq(authChallenges.nonceHash, challenge.nonceHash),
              isNull(authChallenges.consumedAt),
              lte(authChallenges.issuedAt, sql`clock_timestamp()`),
              gt(authChallenges.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: authChallenges.id });
        if (!consumed) return null;
        const [user] = await tx
          .insert(users)
          .values({ walletAddress })
          .onConflictDoUpdate({
            target: users.walletAddress,
            set: { walletAddress },
          })
          .returning({ id: users.id });
        if (!user) throw new Error("User upsert failed");
        const [session] = await tx
          .insert(sessions)
          .values({
            userId: user.id,
            tokenHash,
            createdAt: sql`statement_timestamp()`,
            expiresAt: sql`statement_timestamp() + interval '7 days'`,
          })
          .returning({ expiresAt: sessions.expiresAt });
        if (!session) throw new Error("Session insert failed");
        return { userId: user.id, walletAddress, expiresAt: session.expiresAt.toISOString() };
      });
    },
    async withSession<T>(
      tokenHash: string,
      run: (tx: DatabaseExecutor, session: Session) => Promise<T>,
    ): Promise<T | null> {
      return transaction(async (tx) => {
        // Hold the session lock through the owner operation, so logout cannot race a write.
        const [row] = await tx
          .select({
            userId: sessions.userId,
            walletAddress: users.walletAddress,
            expiresAt: sessions.expiresAt,
          })
          .from(sessions)
          .innerJoin(users, eq(users.id, sessions.userId))
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .for("share", { of: sessions });
        if (!row) return null;
        await tx.execute(sql`SELECT set_config('app.user_id', ${row.userId}, true)`);
        return run(tx, { ...row, expiresAt: row.expiresAt.toISOString() });
      });
    },
    async logout(tokenHash: string): Promise<boolean> {
      return transaction(async (tx) => {
        const rows = await tx
          .update(sessions)
          .set({ revokedAt: sql`clock_timestamp()` })
          .where(
            and(
              eq(sessions.tokenHash, tokenHash),
              isNull(sessions.revokedAt),
              gt(sessions.expiresAt, sql`clock_timestamp()`),
            ),
          )
          .returning({ id: sessions.id });
        return rows.length === 1;
      });
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
