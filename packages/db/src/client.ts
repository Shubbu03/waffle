import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema/index.ts";

type ApiLoginFacts = {
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  ownsAppTables: boolean;
  apiRoleUsable: boolean;
  watcherMember: boolean;
  deliveryMember: boolean;
};

/** The API must connect with a dedicated login, never the migration owner. */
export function isRestrictedApiLogin(role: ApiLoginFacts): boolean {
  return (
    role.canLogin &&
    !role.superuser &&
    !role.bypassRls &&
    !role.createRole &&
    !role.ownsAppTables &&
    role.apiRoleUsable &&
    !role.watcherMember &&
    !role.deliveryMember
  );
}

export function createApiDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 5,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
  });
  const db = drizzle({ client, schema });

  return {
    db,
    async assertRestrictedLogin(): Promise<void> {
      const [row] = await client<ApiLoginFacts[]>`
        SELECT r.rolcanlogin AS "canLogin",
          r.rolsuper AS superuser,
          r.rolbypassrls AS "bypassRls",
          r.rolcreaterole AS "createRole",
          EXISTS (
            SELECT 1 FROM pg_class c
            JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
              AND pg_has_role(current_user, c.relowner, 'member')
          ) AS "ownsAppTables",
          pg_has_role(current_user, 'waffle_api', 'USAGE') AS "apiRoleUsable",
          pg_has_role(current_user, 'waffle_watcher', 'member') AS "watcherMember",
          pg_has_role(current_user, 'waffle_delivery', 'member') AS "deliveryMember"
        FROM pg_roles r WHERE r.rolname = current_user
      `;
      if (row === undefined || !isRestrictedApiLogin(row)) {
        throw new Error("API database login must be a non-owner member of waffle_api only");
      }
    },
    async ping(): Promise<void> {
      await client`SELECT 1`;
    },
    async close(): Promise<void> {
      await client.end({ timeout: 5 });
    },
  };
}

export type ApiDatabase = ReturnType<typeof createApiDatabase>;
