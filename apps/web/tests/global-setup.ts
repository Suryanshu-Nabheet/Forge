// Vitest global setup: create an isolated forge_test database and push the schema.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { adminDsn, testDbDsn } from "./helpers/db";

const exec = promisify(execFile);

const DB = process.env.FORGE_TEST_DB ?? "forge_test";

export async function setup(): Promise<void> {
  // Kill any stale test-server processes squatting the test port.
  try {
    await exec("bash", ["-c", `lsof -ti:3105,3106,3107,3108,3109,3222,3223,3224,3225,3226 | xargs -r kill -9 || true`]);
  } catch { /* none running */ }

  // Create the test database fresh.
  const client = new pg.Client({ connectionString: adminDsn() });
  await client.connect();
  await client.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE);`);
  await client.query(`CREATE DATABASE ${DB};`);
  await client.end();

  // Wipe the isolated test storage root.
  const path = await import("node:path");
  const fs = await import("node:fs/promises");
  const dataDir = path.join(process.cwd(), "data-test");
  await fs.rm(dataDir, { recursive: true, force: true }).catch(() => {});

  // Apply the versioned migrations — exercises the same path production
  // boots run, and fails the suite if a migration diverges from the schema.
  await exec("pnpm", ["exec", "tsx", "../../packages/db/src/migrate.ts"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDbDsn(DB), FORGE_MIGRATIONS_DIR: `${process.cwd()}/drizzle` },
  });

  // Cosine function (mirrors the one shipped for dev).
  const c2 = new pg.Client({ connectionString: testDbDsn(DB) });
  await c2.connect();
  await c2.query(`
    CREATE OR REPLACE FUNCTION cosine_distance(a real[], b real[]) RETURNS real AS $$
      SELECT 1.0 - (SELECT sum(x*y) FROM unnest(a,b) AS t(x,y));
    $$ LANGUAGE SQL IMMUTABLE;
  `);
  await c2.end();
}

export default setup;
