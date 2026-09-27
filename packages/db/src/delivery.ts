import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createLiveDispatchStore } from "./live-store.ts";
import { createPushDeliveryStore } from "./push-delivery-store.ts";
import * as schema from "./schema/index.ts";

type DeliveryLoginFacts = {
  canLogin: boolean;
  superuser: boolean;
  bypassRls: boolean;
  createRole: boolean;
  ownsAppTables: boolean;
  deliveryRoleUsable: boolean;
  apiMember: boolean;
  watcherMember: boolean;
};

export function isRestrictedDeliveryLogin(role: DeliveryLoginFacts): boolean {
  return (
    role.canLogin &&
    !role.superuser &&
    !role.bypassRls &&
    !role.createRole &&
    !role.ownsAppTables &&
    role.deliveryRoleUsable &&
    !role.apiMember &&
    !role.watcherMember
  );
}

/** Separate restricted credentials keep cross-owner delivery privileges out of API requests. */
export function createDeliveryDatabase(databaseUrl: string) {
  const client = postgres(databaseUrl, {
    max: 2,
    connect_timeout: 5,
    idle_timeout: 20,
    prepare: false,
    connection: { statement_timeout: 5000 },
  });
  const db = drizzle({ client, schema });
  return {
    live: createLiveDispatchStore(db),
    push: createPushDeliveryStore((run) => db.transaction(run)),
    async assertRestrictedLogin(): Promise<void> {
      const [row] = await db.execute<DeliveryLoginFacts>(sql`
        SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS superuser,
          r.rolbypassrls AS "bypassRls", r.rolcreaterole AS "createRole",
          EXISTS (
            SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
              AND pg_has_role(current_user, c.relowner, 'member')
          ) AS "ownsAppTables",
          pg_has_role(current_user, 'waffle_delivery', 'USAGE') AS "deliveryRoleUsable",
          pg_has_role(current_user, 'waffle_api', 'member') AS "apiMember",
          pg_has_role(current_user, 'waffle_watcher', 'member') AS "watcherMember"
        FROM pg_roles r WHERE r.rolname = current_user
      `);
      if (!row || !isRestrictedDeliveryLogin(row))
        throw new Error("Delivery database login must be a non-owner member of waffle_delivery only");
    },
    async close() {
      await client.end({ timeout: 5 });
    },
  };
}
