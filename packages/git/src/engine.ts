// @forge/git engine — bare repo lifecycle & storage root management.

import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const exec = promisify(execFile);

/**
 * Resolve a possibly-relative FORGE_STORAGE_ROOT to an absolute path.
 * Relative values are interpreted from the repo root when they look like a
 * monorepo-relative path (starts with "apps/" or "packages/"), else from cwd.
 * This makes both README conventions work: `FORGE_STORAGE_ROOT=apps/web/data`
 * from the repo root and `FORGE_STORAGE_ROOT=data` from apps/web land on the
 * same directory regardless of the process cwd.
 */
function resolveStorageRoot(): string {
  const raw = process.env.FORGE_STORAGE_ROOT ?? "data";
  const abs = path.resolve(raw);
  if (path.isAbsolute(raw)) return abs;
  if (/^(apps|packages)\//.test(raw)) {
    // Monorepo-rooted: walk up from cwd looking for pnpm-workspace.yaml.
    let dir = process.cwd();
    for (let i = 0; i < 6; i++) {
      if (existsSync(path.join(dir, "pnpm-workspace.yaml"))) {
        return path.resolve(dir, raw);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return abs;
}

/** Where all bare repos live: $FORGE_STORAGE_ROOT/repos (default ./data/repos). */
export function reposRoot(): string {
  return path.join(resolveStorageRoot(), "repos");
}

/** Where sandbox checkouts live: $FORGE_STORAGE_ROOT/sandboxes. */
export function sandboxesRoot(): string {
  return path.join(resolveStorageRoot(), "sandboxes");
}

export function repoGitDir(orgSlug: string, repoName: string): string {
  // orgSlug/repoName are validated by callers against DB rows; still defend here.
  if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(orgSlug)) throw new Error(`invalid org slug: ${orgSlug}`);
  if (!/^[a-z0-9][a-z0-9_.-]{0,99}$/.test(repoName)) throw new Error(`invalid repo name: ${repoName}`);
  return path.join(reposRoot(), orgSlug, `${repoName}.git`);
}

const POST_RECEIVE_HOOK = [
  "#!/bin/sh",
  "# Forge post-receive hook - notifies the platform of ref updates.",
  "# Reads 'old new ref' lines on stdin, POSTs one JSON object per push.",
  "# Authenticated with the shared hook token (FORGE_HOOK_TOKEN) when configured.",
  'upstream="${FORGE_POST_RECEIVE_URL:-http://127.0.0.1:3000/internal/hooks/post-receive}"',
  'token="${FORGE_HOOK_TOKEN}"',
  "# Derive org/repo from the hook's own path: <storage>/repos/<org>/<repo>.git/hooks/post-receive.",
  "# git invokes hooks with an absolute hook path, so $0 is reliable; cd to it",
  "# first so relative invocations resolve too. Immune to cwd and to earlier",
  "# path segments that happen to contain /repos/.",
  'repo_dir="$(cd "$(dirname "$(dirname "$0")")" && pwd)"',
  'repo="$(basename "$repo_dir")"',
  'repo="${repo%.git}"',
  'org="$(basename "$(dirname "$repo_dir")")"',
  "",
  "# JSON-escape a string with pure POSIX parameter expansion (no subprocess):",
  "# backslash first, then double quote. Git refnames cannot contain tab/CR/LF",
  "# (git rejects those at pack time), so these two cover the JSON string needs.",
  'json_escape() {',
  '  escaped="${1//\\\\/\\\\\\\\}"',
  '  escaped="${escaped//\\"/\\\\\\"}"',
  '  printf "%s" "$escaped"',
  "}",
  "",
  'updates=""',
  "while read old new ref; do",
  '  eref="$(json_escape "$ref")"',
  "  updates=\"$updates{\\\"old\\\":\\\"$old\\\",\\\"new\\\":\\\"$new\\\",\\\"ref\\\":\\\"$eref\\\"},\"",
  "done",
  'updates="${updates%,}"',
  "",
  'eorg="$(json_escape "$org")"',
  'erepo="$(json_escape "$repo")"',
  "body=\"{\\\"org\\\":\\\"$eorg\\\",\\\"repo\\\":\\\"$erepo\\\",\\\"updates\\\":[$updates]}\"",
  "if [ -n \"$token\" ]; then",
  '  curl -s -m 10 -X POST -H "Content-Type: application/json" -H "X-Forge-Hook-Token: $token" -d "$body" "$upstream" >/dev/null 2>&1 || true',
  "else",
  '  curl -s -m 10 -X POST -H "Content-Type: application/json" -d "$body" "$upstream" >/dev/null 2>&1 || true',
  "fi",
  "exit 0",
].join("\n") + "\n";

/** Hook token: generated per-process (shared server<->hook via env), or from env. */
export function hookToken(): string {
  if (process.env.FORGE_HOOK_TOKEN) return process.env.FORGE_HOOK_TOKEN;
  const store = globalThis as { __forgeHookToken?: string };
  if (!store.__forgeHookToken) store.__forgeHookToken = randomBytes(24).toString("hex");
  return store.__forgeHookToken;
}


/**
 * Branch protection: a pre-receive hook that rejects direct updates
 * (except initial creation), non-fast-forward updates, and deletions of
 * protected branches. The approved PR merge route sets a private process
 * marker for its controlled push. The protected list is stored in git config
 * (forge.protectedBranches) so the hook has no DB dependency.
 */
const PRE_RECEIVE_HOOK = [
  "#!/bin/sh",
  "# Forge pre-receive hook — enforce branch protection.",
  "zero=\"0000000000000000000000000000000000000000\"",
  "while read old new ref; do",
  '  case "$ref" in',
  "    refs/heads/*) branch=\"${ref#refs/heads/}\" ;;",
  "    *) continue ;;",
  "  esac",
  '  protected="$(git config --get forge.protectedBranches 2>/dev/null || echo main)"',
  '  case ":$protected:" in',
  '    *":$branch:"*)',
  '      if [ "$new" = "$zero" ]; then',
  '        echo "forge: refusing to delete protected branch \\"$branch\\"" >&2',
  "        exit 1",
  "      fi",
  '      if [ "$old" != "$zero" ] && [ "${FORGE_ALLOW_PROTECTED_BRANCH_PUSH:-}" != "1" ]; then',
  '        echo "forge: protected branch updates must be made through an approved pull request" >&2',
  "        exit 1",
  "      fi",
  '      if [ "$old" != "$zero" ] && [ "$(git merge-base --is-ancestor $old $new; echo $?)" != "0" ]; then',
  '        echo "forge: refusing non-fast-forward update to protected branch \\"$branch\\"" >&2',
  "        exit 1",
  "      fi",
  "      ;;",
  "  esac",
  "done",
  "exit 0",
].join("\n") + "\n";

/** Create a bare repo with post-receive + pre-receive hooks installed. */
export async function initBareRepo(orgSlug: string, repoName: string): Promise<string> {
  const gitDir = repoGitDir(orgSlug, repoName);
  await mkdir(path.dirname(gitDir), { recursive: true });
  await exec("git", ["init", "--bare", "--initial-branch=main", gitDir]);
  await installHooks(gitDir);
  return gitDir;
}

/** (Re)install hook scripts into an existing bare repo. */
export async function installHooks(gitDir: string): Promise<void> {
  const hookPath = path.join(gitDir, "hooks", "post-receive");
  await writeFile(hookPath, POST_RECEIVE_HOOK, { mode: 0o755 });
  const prePath = path.join(gitDir, "hooks", "pre-receive");
  await writeFile(prePath, PRE_RECEIVE_HOOK, { mode: 0o755 });
}

/** Sync the protected-branch list into the bare repo's git config. */
export async function setProtectedBranches(gitDir: string, branches: string[]): Promise<void> {
  await exec("git", ["--git-dir", gitDir, "config", "forge.protectedBranches", branches.join(",")]);
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
