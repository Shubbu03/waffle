import type { Session, SignInInput } from "@waffle/shared";

export type AuthQuery = <T extends Record<string, unknown>>(text: string, parameters?: string[]) => Promise<T[]>;
export type AuthTransaction = <T>(run: (query: AuthQuery) => Promise<T>) => Promise<T>;
export type StoredChallenge = {
  id: string;
  nonceHash: string;
  domain: string;
  uri: string;
  version: "1";
  chainId: SignInInput["chainId"];
  statement: string;
  issuedAt: Date;
  expiresAt: Date;
};

export function createAuthStore(transaction: AuthTransaction) {
  return {
    async createChallenge(input: SignInInput, nonceHash: string): Promise<string> {
      return transaction(async (query) => {
        const [row] = await query<{ id: string }>(
          `INSERT INTO public.auth_challenges
            (nonce_hash, domain, uri, version, chain_id, statement, issued_at, expires_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz) RETURNING id`,
          [
            nonceHash,
            input.domain,
            input.uri,
            input.version,
            input.chainId,
            input.statement,
            input.issuedAt,
            input.expirationTime,
          ],
        );
        if (!row) throw new Error("Challenge insert failed");
        return row.id;
      });
    },
    async findChallenge(id: string): Promise<StoredChallenge | null> {
      return transaction(async (query) => {
        const [row] = await query<StoredChallenge>(
          `SELECT id, nonce_hash AS "nonceHash", domain, uri, version, chain_id AS "chainId",
            statement, issued_at AS "issuedAt", expires_at AS "expiresAt"
           FROM public.auth_challenges WHERE id = $1 AND consumed_at IS NULL
            AND issued_at <= clock_timestamp() AND expires_at > clock_timestamp()`,
          [id],
        );
        return row ?? null;
      });
    },
    async completeSignIn(
      challenge: StoredChallenge,
      walletAddress: string,
      tokenHash: string,
    ): Promise<Session | null> {
      return transaction(async (query) => {
        // The conditional UPDATE serializes contenders; only one may mint a session.
        const [consumed] = await query<{ id: string }>(
          `UPDATE public.auth_challenges SET consumed_at = clock_timestamp()
           WHERE id = $1 AND nonce_hash = $2 AND consumed_at IS NULL
            AND issued_at <= clock_timestamp() AND expires_at > clock_timestamp() RETURNING id`,
          [challenge.id, challenge.nonceHash],
        );
        if (!consumed) return null;
        const [user] = await query<{ id: string }>(
          `INSERT INTO public.users (wallet_address) VALUES ($1)
           ON CONFLICT (wallet_address) DO UPDATE SET wallet_address = EXCLUDED.wallet_address RETURNING id`,
          [walletAddress],
        );
        if (!user) throw new Error("User upsert failed");
        const [session] = await query<{ expiresAt: Date }>(
          `INSERT INTO public.sessions (user_id, token_hash, created_at, expires_at)
           VALUES ($1, $2, statement_timestamp(), statement_timestamp() + interval '7 days')
           RETURNING expires_at AS "expiresAt"`,
          [user.id, tokenHash],
        );
        if (!session) throw new Error("Session insert failed");
        return { userId: user.id, walletAddress, expiresAt: session.expiresAt.toISOString() };
      });
    },
    async withSession<T>(
      tokenHash: string,
      run: (query: AuthQuery, session: Session) => Promise<T>,
    ): Promise<T | null> {
      return transaction(async (query) => {
        // Hold the session lock through the owner operation, so logout cannot race a write.
        const [row] = await query<{ userId: string; walletAddress: string; expiresAt: Date }>(
          `SELECT s.user_id AS "userId", u.wallet_address AS "walletAddress", s.expires_at AS "expiresAt"
           FROM public.sessions s JOIN public.users u ON u.id = s.user_id
           WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > clock_timestamp()
           FOR SHARE OF s`,
          [tokenHash],
        );
        if (!row) return null;
        await query("SELECT set_config('app.user_id', $1, true)", [row.userId]);
        return run(query, { ...row, expiresAt: row.expiresAt.toISOString() });
      });
    },
    async logout(tokenHash: string): Promise<boolean> {
      return transaction(async (query) => {
        const rows = await query<{ id: string }>(
          `UPDATE public.sessions SET revoked_at = clock_timestamp()
           WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > clock_timestamp() RETURNING id`,
          [tokenHash],
        );
        return rows.length === 1;
      });
    },
  };
}

export type AuthStore = ReturnType<typeof createAuthStore>;
