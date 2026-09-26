import type { ScoredSignal } from "@waffle/shared";
import postgres from "postgres";
import { type SignalQuery, type SignalWriteResult, storeSignal } from "./signal-store.ts";

type WatcherLoginFacts = {
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  ownsAppTables: boolean;
  watcherRoleUsable: boolean;
  apiMember: boolean;
  deliveryMember: boolean;
};

export function isRestrictedWatcherLogin(role: WatcherLoginFacts): boolean {
  return (
    role.canLogin &&
    !role.superuser &&
    !role.bypassRls &&
    !role.createRole &&
    !role.ownsAppTables &&
    role.watcherRoleUsable &&
    !role.apiMember &&
    !role.deliveryMember
  );
}

/** Catalog reads and signal writes use the existing waffle_watcher privilege group. */
export function createWatcherDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
    connection: { statement_timeout: 5000 },
  });
  // Serial short writes keep connection pressure bounded; the transaction lock also covers other processes.
  let writes: Promise<unknown> = Promise.resolve();
  return {
    storeSignal(walletAddress: string, prepare: () => ScoredSignal): Promise<SignalWriteResult> {
      const write = writes.then(() =>
        storeSignal(
          async (run) => {
            const result = await client.begin(async (transaction) => {
              const query: SignalQuery = async <T extends Record<string, unknown>>(
                text: string,
                parameters: (string | number)[] = [],
              ) => Array.from(await transaction.unsafe<T[]>(text, parameters));
              return run(query);
            });
            return result;
          },
          walletAddress,
          prepare,
        ),
      );
      writes = write.catch(() => undefined);
      return write;
    },
    async assertRestrictedLogin(): Promise<void> {
      const [row] = await client<WatcherLoginFacts[]>`
        SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS superuser,
          r.rolbypassrls AS "bypassRls", r.rolcreaterole AS "createRole",
          EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
              AND pg_has_role(current_user, c.relowner, 'member')
          ) AS "ownsAppTables",
          pg_has_role(current_user, 'waffle_watcher', 'USAGE') AS "watcherRoleUsable",
          pg_has_role(current_user, 'waffle_api', 'member') AS "apiMember",
          pg_has_role(current_user, 'waffle_delivery', 'member') AS "deliveryMember"
        FROM pg_roles r WHERE r.rolname = current_user
      `;
      if (!row || !isRestrictedWatcherLogin(row))
        throw new Error("Watcher database login must be a non-owner member of waffle_watcher only");
    },
    async loadActiveWallets(): Promise<string[]> {
      const rows = await client<{ address: string }[]>`
        SELECT address FROM public.watched_wallets WHERE active = true ORDER BY address LIMIT 101
      `;
      return rows.map((row) => row.address);
    },
    async close(): Promise<void> {
      await writes;
      await client.end({ timeout: 5 });
    },
  };
}
