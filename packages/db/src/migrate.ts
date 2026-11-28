// Migration runner: applies pending SQL migrations from apps/web/drizzle
// at boot (or via `pnpm db:migrate`). Uses drizzle-orm's migrator against
// the same pg pool as the app; records applied migrations in the
// drizzle.__drizzle_migrations table, the same one drizzle-kit writes.
//
// Existing databases that predate the migration system (created via
// `drizzle-kit push`) have an empty journal: replaying the baseline would
// fail on CREATE TABLE. Those databases are baselined instead — the
// baseline journal entry is inserted without executing it — because their
// schema was already in sync at the time the baseline was generated.

import path from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
import { db } from "./db";

const JOURNAL = "drizzle.__drizzle_migrations";

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

  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: Array<{ idx: number; tag: string; when: number }>;
  };
  const baseline = journal.entries[0];

  // Adopt pre-migration databases: journal table exists but is empty,
  // while the schema itself already has tables. All entries are recorded
  // as applied with the same content-hash the migrator computes, so the
  // migrator skips them; the schema was already push-synced.
  if (baseline) {
    const hashes = journal.entries.map((e) => {
      const content = readFileSync(path.join(dir, `${e.tag}.sql`), "utf8");
      return {
        hash: createHash("sha256").update(content).digest("hex"),
        // The migrator gates on created_at (milliseconds, "folderMillis")
        // — adopt with the exact same value it would have written.
        when: e.when,
      };
    });
    const adopted = await adoptPreMigrationDatabase(hashes);
    if (adopted) {
      console.log(`[db] adopted existing schema as migrations 0..${journal.entries.length - 1} (journal was empty)`);
    }
  }

  await migrate(db, { migrationsFolder: dir });
}

/**
 * If the journal exists but is empty while user tables exist, the database
 * was created before versioned migrations (drizzle-kit push). Record every
 * migration as already applied using the same content-hash the migrator
 * computes, so it skips them. Returns true if adopted.
 */
async function adoptPreMigrationDatabase(
  entries: Array<{ hash: string; when: number }>,
): Promise<boolean> {
  const journalExists = await db.execute(sql`SELECT to_regclass(${JOURNAL}) AS t`);
  const hasJournal = Boolean((journalExists.rows[0] as { t: string | null } | undefined)?.t);
  if (!hasJournal) return false; // fresh DB — migrate() creates the journal

  const journalRows = await db.execute(sql`SELECT count(*)::int AS n FROM ${sql.raw(JOURNAL)}`);
  if ((journalRows.rows[0] as { n: number }).n > 0) return false;

  const userTables = await db.execute(sql`
    SELECT count(*)::int AS n FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  `);
  if ((userTables.rows[0] as { n: number }).n === 0) return false; // empty DB — run real migrations

  for (const [i, e] of entries.entries()) {
    await db.execute(sql`
      INSERT INTO ${sql.raw(JOURNAL)} (hash, created_at)
      VALUES (${e.hash}, ${e.when + i})
    `);
  }
  return true;
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
