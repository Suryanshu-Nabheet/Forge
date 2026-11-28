// Migration runner: applies pending SQL migrations from apps/web/drizzle
// at boot (or via `pnpm db:migrate`). Uses drizzle-orm's migrator against
// the same pg pool as the app; records applied migrations in the
// drizzle.__drizzle_migrations table, the same one drizzle-kit writes.

import path from "node:path";
import { existsSync } from "node:fs";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { db } from "./db";

/** Apply pending migrations. Idempotent; safe to call at every boot. */
export async function runMigrations(): Promise<void> {
  // The SQL files live next to the web app that owns drizzle.config.ts.
  // Resolve from the monorepo root so both dev (apps/web cwd) and the
  // standalone worker work.
  const candidates = [
    process.env.FORGE_MIGRATIONS_DIR,
    path.resolve(process.cwd(), "drizzle"),
    path.resolve(process.cwd(), "apps/web/drizzle"),
  ].filter((p): p is string => Boolean(p));

  const dir = candidates.find((p) => existsSync(path.join(p, "meta")));
  if (!dir) {
    throw new Error(
      "migrations directory not found — set FORGE_MIGRATIONS_DIR or run from the monorepo/apps/web",
    );
  }

  await migrate(db, { migrationsFolder: dir });
}

if (process.argv[1] && process.argv[1].endsWith("migrate.ts")) {
  runMigrations()
    .then(() => {
      console.log("[db] migrations applied");
      process.exit(0);
    })
    .catch((err) => {
      console.error("[db] migration failed:", err);
      process.exit(1);
    });
}
