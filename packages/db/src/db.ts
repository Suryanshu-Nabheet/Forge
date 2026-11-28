// Drizzle client over node-postgres.

import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import * as schema from "./schema";

const pool = new pg.Pool({
  connectionString: process.env.DATABASE_URL ?? `postgresql://${process.env.USER ?? "postgres"}@localhost:5432/forge`,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
  application_name: "forge",
});

// Postgres restarts / failovers error on idle clients; without a listener
// that surfaces as an uncaught exception in the shared web+worker process.
pool.on("error", (err) => {
  console.error("[db] idle client error:", err.message);
});

export const db = drizzle(pool, { schema });
export { schema };
export type Db = typeof db;
