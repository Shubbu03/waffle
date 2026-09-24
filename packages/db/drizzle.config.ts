import { config } from "dotenv";
import { defineConfig } from "drizzle-kit";

config({ path: new URL("./.env", import.meta.url), quiet: true });

const migrationDatabaseUrl = process.env.DB_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  ...(migrationDatabaseUrl ? { dbCredentials: { url: migrationDatabaseUrl } } : {}),
  strict: true,
});
