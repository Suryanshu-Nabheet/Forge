// Boot-time environment validation: fail fast on configurations that
// would otherwise fail silently in production (wrong DB target, per-process
// hook token across replicas, TOTP secrets that can't survive a restart).

import path from "node:path";
import { sql } from "drizzle-orm";
import { db } from "./db";

export interface EnvProblems {
  fatal: string[]; // boot must abort
  warnings: string[]; // boot continues, but loudly
}

export async function validateEnv(isProduction: boolean): Promise<EnvProblems> {
  const fatal: string[] = [];
  const warnings: string[] = [];

  if (isProduction && !process.env.DATABASE_URL) {
    fatal.push("DATABASE_URL is not set — production would silently target the local default database");
  }

  if (isProduction && !process.env.FORGE_HOOK_TOKEN) {
    warnings.push(
      "FORGE_HOOK_TOKEN is auto-generated per process — web/worker splits or multi-replica " +
      "deployments will reject each other's hook callbacks. Set it explicitly.",
    );
  }

  // TOTP secrets are AES-GCM encrypted under FORGE_SECRET (falling back to
  // the per-process hook token). If secrets exist without FORGE_SECRET,
  // every restart re-keys and 2FA codes stop verifying.
  if (!process.env.FORGE_SECRET) {
    try {
      const has = await db.execute(sql`SELECT exists(SELECT 1 FROM users WHERE totp_secret IS NOT NULL) AS t`);
      if ((has.rows[0] as { t: boolean } | undefined)?.t) {
        const msg =
          "FORGE_SECRET is not set but TOTP secrets exist in the database — after a restart, " +
          "2FA codes will fail until users re-enroll (recovery codes keep working). Set FORGE_SECRET.";
        if (isProduction) fatal.push(msg);
        else warnings.push(msg);
      }
    } catch {
      // Table may not exist yet (pre-migration) — skip the check.
    }
  }

  if (process.env.FORGE_STORAGE_ROOT && !path.isAbsolute(process.env.FORGE_STORAGE_ROOT)) {
    warnings.push(
      `FORGE_STORAGE_ROOT=${process.env.FORGE_STORAGE_ROOT} is cwd-relative — processes started ` +
      "from different directories (web vs standalone worker) would use different storage trees.",
    );
  }

  return { fatal, warnings };
}

