// Process-based sandbox runner (fallback when Docker is unavailable).
// Hard limits: sanitized env, timeout, output cap, concurrency semaphore,
// detached process group kill, lifecycle-script prescan.

import { spawn } from "node:child_process";
import { mkdir, writeFile, rm } from "node:fs/promises";
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

const TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 2 * 1024 * 1024; // 2MB
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
    let command: string;
    let args: string[];
    if (hasDockerfile) {
      // We can't safely run Dockerfiles without Docker; report gracefully.
      spec.onLog("[sandbox] Dockerfile present but Docker unavailable — skipping container build (process fallback)");
      return { ok: false, exitCode: null, durationMs: Date.now() - startedAt, adapter: "process", output: "Dockerfile requires Docker adapter" };
    } else if (hasPackageJson) {
      command = "npm";
      args = ["install", "--no-audit", "--no-fund", "--loglevel=error", "--ignore-scripts"];
      spec.onLog("[sandbox] npm install --ignore-scripts");
    } else {
      command = "true";
      args = [];
      spec.onLog("[sandbox] no build config detected — nothing to do");
      return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, adapter: "process", output: "nothing to build" };
    }

    const result = await runCommand(dir, command, args, spec.onLog);
    if (!result.ok) return { ...result, adapter: "process" };

    // If package.json has a build script, run it.
    const pkg = pkgRaw ? (JSON.parse(pkgRaw) as { scripts?: Record<string, string> }) : null;
    if (pkg?.scripts?.build) {
      spec.onLog("[sandbox] npm run build");
      const buildResult = await runCommand(dir, "npm", ["run", "build"], spec.onLog);
      if (!buildResult.ok) return { ...buildResult, adapter: "process" };
    }
    if (pkg?.scripts?.start) {
      // Note: we do NOT keep servers running in the process adapter;
      // the preview record exposes the build as "ran successfully".
      spec.onLog("[sandbox] start script present; process adapter validated build only (no live URL)");
    }
    return { ok: true, exitCode: 0, durationMs: Date.now() - startedAt, adapter: "process", output: "build succeeded" };
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
    release();
  }
}

interface CmdResult {
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  output: string;
}

function sanitizedEnv(home: string): NodeJS.ProcessEnv {
  // Keep the parent's node location available (npm needs `node` on PATH),
  // plus standard system paths. Everything else is dropped.
  const selfBin = path.dirname(process.execPath);
  const parentPaths = process.env.PATH?.split(":") ?? [];
  const trusted = parentPaths.filter((p) =>
    p.startsWith("/opt/homebrew") || p.startsWith("/usr/local") || p.includes("node") || p.includes("npm"),
  );
  return {
    PATH: [selfBin, ...trusted, "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"].join(":"),
    HOME: home,
    LANG: "C.UTF-8",
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_loglevel: "error",
    NO_COLOR: "1",
    NODE_ENV: process.env.NODE_ENV,
  };
}

function runCommand(cwd: string, command: string, args: string[], onLog: (l: string) => void): Promise<CmdResult> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(command, args, {
      cwd,
      env: sanitizedEnv(cwd),
      detached: true, // own process group → kill(-pid) kills the whole tree
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let killed = false;

    const timer = setTimeout(() => {
      killed = true;
      onLog(`[sandbox] timeout after ${TIMEOUT_MS / 1000}s — killing process group`);
      try {
        process.kill(-child.pid!, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, TIMEOUT_MS);

    const append = (chunk: Buffer) => {
      if (output.length < MAX_OUTPUT) output += chunk.toString();
      else if (output.length === MAX_OUTPUT) {
        output += "\n…output truncated…";
        onLog("[sandbox] output cap reached (2MB) — truncating");
      }
      for (const line of chunk.toString().split("\n")) {
        if (line.trim()) onLog(line.slice(0, 2000));
      }
    };
    child.stdout.on("data", append);
    child.stderr.on("data", append);

    child.on("error", (err) => {
      clearTimeout(timer);
      onLog(`[sandbox] spawn error: ${err.message}`);
      resolve({ ok: false, exitCode: null, durationMs: Date.now() - startedAt, output });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const ok = !killed && code === 0;
      resolve({ ok, exitCode: code, durationMs: Date.now() - startedAt, output });
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await (await import("node:fs/promises")).access(p);
    return true;
  } catch {
    return false;
  }
}
