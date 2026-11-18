// Sandbox adapter selection: Docker when available, process fallback otherwise.

import { runProcessBuild, type BuildSpec, type BuildResult } from "./process";
import { runDockerBuild, dockerSandboxAvailable } from "./docker";

export type { BuildSpec, BuildResult };
export { scanPackageJson } from "./scanner";
export { runProcessBuild } from "./process";
export { runDockerBuild, dockerSandboxAvailable } from "./docker";

let dockerCache: boolean | null = null;
let dockerCheckedAt = 0;
const DOCKER_RECHECK_MS = 60_000;

async function useDocker(): Promise<boolean> {
  const now = Date.now();
  if (dockerCache === null || now - dockerCheckedAt > DOCKER_RECHECK_MS) {
    dockerCache = await dockerSandboxAvailable();
    dockerCheckedAt = now;
  }
  return dockerCache;
}

export async function runSandboxBuild(spec: BuildSpec): Promise<BuildResult> {
  if (await useDocker()) {
    try {
      return await runDockerBuild(spec);
    } catch (err) {
      spec.onLog(`[sandbox] docker adapter failed (${err instanceof Error ? err.message : err}) — falling back to process`);
    }
  }
  return runProcessBuild(spec);
}

export async function activeAdapter(): Promise<"docker" | "process"> {
  return (await useDocker()) ? "docker" : "process";
}
