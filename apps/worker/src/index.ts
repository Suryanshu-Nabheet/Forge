// Standalone worker entry: runs the same job processors as the dev server,
// for production deployments that split web and workers.

import { startWorker, stopWorker } from "@forge/jobs";

async function main() {
  console.log("[forge-worker] standalone worker starting");
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
