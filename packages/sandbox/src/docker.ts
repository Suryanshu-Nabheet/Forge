// Docker sandbox adapter — used when `docker info` responds.
// Same interface as the process adapter. Build runs with cpus/memory caps,
// tmpfs, non-root user, no network, lifecycle-script prescan, logs streamed,
// stopped on timeout.

import { execFile, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { extractArchive, sandboxDirFor } from "@forge/git";
import { scanPackageJson } from "./scanner";
import { revParse, catFileText } from "@forge/git";
import type { BuildSpec, BuildResult } from "./process";

const TIMEOUT_MS = 120_000;
const CPUS = "1.0";
const MEM = "512m";
// Builds run with `--network none`: the container gets no outbound access at
// all. That is a deliberate fail-closed choice — a bridge network would let
// untrusted build code reach arbitrary hosts. The tradeoff (npm install of
// external dependencies fails inside the sandbox) is surfaced per-build in
// the log line below, and dependency-free or offline projects still build.


async function dockerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    execFile("docker", ["info", "--format", "{{.ServerVersion}}"], { timeout: 3000 }, (err, stdout) => {
      resolve(!err && stdout.trim().length > 0);
    });
  });
}

export async function dockerSandboxAvailable(): Promise<boolean> {
  return dockerAvailable();
}

export async function runDockerBuild(spec: BuildSpec): Promise<BuildResult> {
  const startedAt = Date.now();
  const workDir = path.join(sandboxDirFor(spec.previewId ?? 0), `docker-${Date.now()}`);
  await mkdir(path.dirname(workDir), { recursive: true });
  const containerName = `forge-preview-${spec.previewId ?? "x"}-${Date.now()}`;

  try {
    spec.onLog(`[sandbox:docker] extracting ${spec.commitSha.slice(0, 7)}`);
    await extractArchive(spec.gitDir, spec.commitSha, workDir);

    const hasPackageJson = await fileExists(path.join(workDir, "package.json"));
    const hasDockerfile = await fileExists(path.join(workDir, "Dockerfile"));
    if (!hasPackageJson && !hasDockerfile) {
      spec.onLog("[sandbox:docker] no build config — nothing to do");
      return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, adapter: "docker", output: "nothing to build" };
    }

    if (hasDockerfile) {
      spec.onLog("[sandbox:docker] BLOCKED: repository Dockerfiles are not built through the host Docker daemon");
      return { ok: false, exitCode: null, durationMs: Date.now() - startedAt, adapter: "docker", output: "Dockerfile builds are disabled" };
    }

    // Prescan lifecycle scripts from the committed package.json (same policy
    // as the process adapter) before the container runs anything.
    const pkgRaw = await packageJsonAt(spec.gitDir, spec.commitSha);
    const scan = scanPackageJson(pkgRaw);
    if (!scan.ok) {
      spec.onLog(`[sandbox:docker] BLOCKED: ${scan.reason}`);
      return { ok: false, exitCode: null, durationMs: Date.now() - startedAt, adapter: "docker", output: scan.reason ?? "blocked" };
    }

    const script = "cp -R /src/. /work/ && cd /work && npm install --no-audit --no-fund --ignore-scripts && npm run build --if-present";

    const args = [
      "run",
      "--rm",
      "--name", containerName,
      "--cpus", CPUS,
      "--memory", MEM,
      "--network", "none",
      "--cap-drop", "ALL",
      "--security-opt", "no-new-privileges",
      "--read-only",
      "--user", "1000:1000",
      "--pids-limit", "128",
      "--tmpfs", "/tmp:rw,noexec,nosuid,size=64m",
      "--tmpfs", "/work:rw,nosuid,size=256m,uid=1000,gid=1000",
      "-v", `${workDir}:/src:ro`,
      "-w", "/work",
      "node:22-alpine",
      "sh", "-c", script,
    ];
    spec.onLog("[sandbox:docker] network is disabled — `npm install` of external dependencies will fail; vendored/offline deps still build");
    spec.onLog(`[sandbox:docker] docker ${args.slice(0, 6).join(" ")}…`);

    const result = await streamCommand(args, containerName, spec.onLog);
    return { ...result, adapter: "docker" };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
    execFile("docker", ["stop", containerName], () => {});
  }
}

function streamCommand(args: string[], containerName: string, onLog: (l: string) => void): Promise<Omit<BuildResult, "adapter">> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    let killed = false;
    const timer = setTimeout(() => {
      killed = true;
      onLog("[sandbox:docker] timeout — stopping container");
      execFile("docker", ["kill", containerName], () => {});
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    const append = (chunk: Buffer) => {
      const used = Buffer.byteLength(output);
      if (used < 2 * 1024 * 1024) {
        const accepted = chunk.subarray(0, 2 * 1024 * 1024 - used);
        output += accepted.toString();
        for (const line of accepted.toString().split("\n")) if (line.trim()) onLog(line.slice(0, 2000));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    child.on("error", (err) => {
      clearTimeout(timer);
      onLog(`[sandbox:docker] spawn error: ${err.message}`);
      resolve({ ok: false, exitCode: null, durationMs: Date.now() - startedAt, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ ok: !killed && code === 0, exitCode: code, durationMs: Date.now() - startedAt, output });
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const fs = await import("node:fs/promises");
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Look up package.json content at the commit (prescan before build). */
async function packageJsonAt(gitDir: string, sha: string): Promise<string | null> {
  const blobSha = await revParse(gitDir, `${sha}:package.json`);
  if (!blobSha) return null;
  return catFileText(gitDir, blobSha, 256 * 1024);
}
