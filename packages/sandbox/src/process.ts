// Safe process-mode fallback: inspect and extract commits, but never execute
// repository-controlled build code without an actual container boundary.

import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { extractArchive, sandboxDirFor } from "@forge/git";
import { scanPackageJson } from "./scanner";
import { catFileText, revParse } from "@forge/git";

export interface BuildSpec {
  gitDir: string;
  commitSha: string;
  previewId?: number;
  onLog: (line: string) => void;
}

export interface BuildResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  adapter: "process" | "docker";
  output: string;
}

const MAX_CONCURRENT = 4;

let active = 0;
const waiters: Array<() => void> = [];

async function acquire(): Promise<void> {
  if (active < MAX_CONCURRENT) {
    active++;
    return;
  }
  await new Promise<void>((resolve) => waiters.push(resolve));
  active++;
}

function release(): void {
  active--;
  const next = waiters.shift();
  if (next) next();
}

/** Look up package.json content at the commit (prescan before build). */
async function packageJsonAt(gitDir: string, sha: string): Promise<string | null> {
  const blobSha = await revParse(gitDir, `${sha}:package.json`);
  if (!blobSha) return null;
  return catFileText(gitDir, blobSha, 256 * 1024);
}

export async function runProcessBuild(spec: BuildSpec): Promise<BuildResult> {
  await acquire();
  const startedAt = Date.now();
  let dir: string | null = null;
  try {
    dir = path.join(sandboxDirFor(spec.previewId ?? 0), `build-${Date.now()}`);
    await mkdir(path.dirname(dir), { recursive: true });
    spec.onLog(`[sandbox] extracting ${spec.commitSha.slice(0, 7)} to ${dir}`);
    await extractArchive(spec.gitDir, spec.commitSha, dir);

    const pkgRaw = await packageJsonAt(spec.gitDir, spec.commitSha);
    const scan = scanPackageJson(pkgRaw);
    if (!scan.ok) {
      spec.onLog(`[sandbox] BLOCKED: ${scan.reason}`);
      return { ok: false, exitCode: null, durationMs: Date.now() - startedAt, adapter: "process", output: scan.reason ?? "blocked" };
    }

    const hasPackageJson = pkgRaw !== null;
    const hasDockerfile = await fileExists(path.join(dir, "Dockerfile"));
    if (hasDockerfile) {
      spec.onLog("[sandbox] BLOCKED: Docker is unavailable; Dockerfile builds are disabled");
      return { ok: false, exitCode: null, durationMs: Date.now() - startedAt, adapter: "process", output: "Dockerfile requires Docker adapter" };
    } else if (hasPackageJson) {
      // A child process on the Forge host is not a security boundary. Even
      // with a scrubbed environment, repository build scripts can read files,
      // consume host resources, and make network requests. Only the Docker
      // adapter may execute repository-controlled code.
      spec.onLog("[sandbox] BLOCKED: Docker is unavailable; host process builds are disabled for untrusted repositories");
      return {
        ok: false,
        exitCode: null,
        durationMs: Date.now() - startedAt,
        adapter: "process",
        output: "isolated build unavailable: Docker is required",
      };
    } else {
      spec.onLog("[sandbox] no build config detected — nothing to do");
      return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, adapter: "process", output: "nothing to build" };
    }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await (await import("node:fs/promises")).access(p);
    return true;
  } catch {
    return false;
  }
}
