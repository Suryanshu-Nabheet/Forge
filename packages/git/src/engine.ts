// @forge/git engine — bare repo lifecycle & storage root management.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile, access, constants } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

/** Where all bare repos live: $FORGE_STORAGE_ROOT/repos (default ./data/repos). */
export function reposRoot(): string {
  const base = process.env.FORGE_STORAGE_ROOT ?? path.join(process.cwd(), "data");
  return path.resolve(base, "repos");
}

/** Where sandbox checkouts live: $FORGE_STORAGE_ROOT/sandboxes. */
export function sandboxesRoot(): string {
  const base = process.env.FORGE_STORAGE_ROOT ?? path.join(process.cwd(), "data");
  return path.resolve(base, "sandboxes");
}

export function repoGitDir(orgSlug: string, repoName: string): string {
  // orgSlug/repoName are validated by callers against DB rows; still defend here.
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(orgSlug)) throw new Error(`invalid org slug: ${orgSlug}`);
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(repoName)) throw new Error(`invalid repo name: ${repoName}`);
  return path.join(reposRoot(), orgSlug, `${repoName}.git`);
}

export async function repoExists(orgSlug: string, repoName: string): Promise<boolean> {
  try {
    await access(repoGitDir(orgSlug, repoName), constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

const POST_RECEIVE_HOOK = [
  "#!/bin/sh",
  "# FORGE-NEXT post-receive hook - notifies the platform of ref updates.",
  "# Reads 'old new ref' lines on stdin, POSTs one JSON object per push.",
  'upstream="${FORGE_POST_RECEIVE_URL:-http://127.0.0.1:3000/internal/hooks/post-receive}"',
  'repo_path="$(pwd)"',
  'org_and_repo="${repo_path#*/repos/}"',
  'org="${org_and_repo%%/*}"',
  'repo="$(basename "$repo_path" .git)"',
  "",
  'updates=""',
  "while read old new ref; do",
  "  updates=\"$updates{\\\"old\\\":\\\"$old\\\",\\\"new\\\":\\\"$new\\\",\\\"ref\\\":\\\"$ref\\\"},\"",
  "done",
  'updates="${updates%,}"',
  "",
  "body=\"{\\\"org\\\":\\\"$org\\\",\\\"repo\\\":\\\"$repo\\\",\\\"updates\\\":[$updates]}\"",
  'curl -s -m 10 -X POST -H "Content-Type: application/json" -d "$body" "$upstream" >/dev/null 2>&1 || true',
  "exit 0",
].join("\n") + "\n";


/** Create a bare repo with post-receive hook installed. Returns its absolute path. */
export async function initBareRepo(orgSlug: string, repoName: string): Promise<string> {
  const gitDir = repoGitDir(orgSlug, repoName);
  await mkdir(path.dirname(gitDir), { recursive: true });
  await exec("git", ["init", "--bare", "--initial-branch=main", gitDir]);
  const hookPath = path.join(gitDir, "hooks", "post-receive");
  await writeFile(hookPath, POST_RECEIVE_HOOK, { mode: 0o755 });
  return gitDir;
}

/** Run git in the bare repo. All args are passed by this package's typed helpers only. */
export async function gitIn(gitDir: string, args: string[], opts?: { stdin?: string; maxBuffer?: number }): Promise<string> {
  const { stdout } = await exec("git", args, {
    cwd: gitDir,
    maxBuffer: opts?.maxBuffer ?? 1024 * 1024 * 64,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_DIR: gitDir,
      LC_ALL: "C",
      NODE_ENV: process.env.NODE_ENV,
    },
  });
  return stdout;
}

/** Spawn git with stdout as a piped stream (for `git archive` etc.). */
export function gitSpawn(gitDir: string, args: string[]) {
  return spawn("git", args, {
    cwd: gitDir,
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      GIT_DIR: gitDir,
      LC_ALL: "C",
      NODE_ENV: process.env.NODE_ENV,
    },
    stdio: ["ignore", "pipe", "pipe"] as const,
  });
}
