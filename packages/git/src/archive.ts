// @forge/git archive — extract a commit snapshot to a directory (sandbox builds).

import { spawn, type ChildProcess } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { gitSpawn, sandboxesRoot } from "./engine";

/** Extract `git archive <commit>` output to destDir via tar. */
export async function extractArchive(gitDir: string, commitSha: string, destDir: string): Promise<void> {
  await mkdir(destDir, { recursive: true });
  await new Promise<void>((resolve, reject) => {
    const tar: ChildProcess = spawn("tar", ["-x", "-C", destDir], { stdio: ["pipe", "ignore", "pipe"] });
    const git = gitSpawn(gitDir, ["archive", commitSha]);
    let stderr = "";
    tar.stderr?.on("data", (d) => (stderr += d.toString()));
    git.stderr?.on("data", (d) => (stderr += d.toString()));
    git.stdout?.pipe(tar.stdin!);
    tar.on("error", reject);
    git.on("error", reject);
    tar.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`git archive | tar failed (code ${code}): ${stderr.slice(0, 2000)}`));
    });
  });
}

export function sandboxDirFor(previewId: number): string {
  // Same monorepo-aware storage-root resolution as reposRoot() — sandboxes
  // must land beside repos regardless of the process cwd.
  return path.join(sandboxesRoot(), `preview-${previewId}`);
}
