// Standalone worker entry: runs the same job processors as the dev server,
// for production deployments that split web and workers.

import { startWorker, stopWorker } from "@forge/jobs";

async function main() {
  console.log("[forge-worker] standalone worker starting");
  const { validateEnv } = await import("@forge/db");
  const problems = await validateEnv(process.env.NODE_ENV === "production");
  for (const w of problems.warnings) console.warn(`[forge-worker] env warning: ${w}`);
  if (problems.fatal.length > 0) {
    for (const f of problems.fatal) console.error(`[forge-worker] FATAL: ${f}`);
    process.exit(1);
  }
  await startWorker();
  const shutdown = async () => {
    console.log("[forge-worker] shutting down…");
    await stopWorker();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error("[forge-worker] fatal:", err);
  process.exit(1);
});
