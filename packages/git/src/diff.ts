// @forge/git diff — unified diff → structured hunks with line anchors.

import type { DiffFile, DiffHunk, DiffLine } from "@forge/shared";
import { gitIn } from "./engine";

const GIT_DIFF_HEADER_RE = /^diff --git a\/(.+) b\/(.+)$/;
const RENAME_FROM_RE = /^rename from (.+)$/;
const OLD_PATH_RE = /^--- (?:a\/(.+)|\/dev\/null)$/;
const NEW_PATH_RE = /^\+\+\+ (?:b\/(.+)|\/dev\/null)$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const OLD_MODE_RE = /^old mode (\d+)$/;
const NEW_MODE_RE = /^new mode (\d+)$/;
const BINARY_RE = /^Binary files .* differ$/;

/**
 * Build a structured diff between base and head (three-dot: merge-base).
 * Uses `--find-renames` for rename detection.
 */
export async function diffCommits(gitDir: string, base: string, head: string): Promise<DiffFile[]> {
  const out = await gitIn(gitDir, [
    "diff", "--find-renames", "--no-color", `${base}...${head}`,
  ]);
  return parseUnifiedDiff(out);
}

/** Diff between two arbitrary revs, resolved from branch/tag/sha names. */
export async function diffRevs(gitDir: string, baseRev: string, headRev: string): Promise<DiffFile[]> {
  const out = await gitIn(gitDir, [
    "diff", "--find-renames", "--no-color", `${baseRev}...${headRev}`,
  ]);
  return parseUnifiedDiff(out);
}

/** Diff a single file across base..head (used for inline comment anchoring). */
/** Commit diff against its first parent (single-commit view). */
export async function diffCommit(gitDir: string, sha: string): Promise<DiffFile[]> {
  const out = await gitIn(gitDir, [
    "diff", "--find-renames", "--no-color", `${sha}^..${sha}`,
  ]);
  return parseUnifiedDiff(out);
}

export function parseUnifiedDiff(out: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  let curHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const pushHunk = () => {
    if (cur && curHunk) {
      cur.hunks.push(curHunk);
      curHunk = null;
    }
  };
  const pushFile = () => {
    pushHunk();
    if (cur) {
      // Derive status from the parsed /dev/null markers; ensure paths are sane.
      if (cur.status !== "renamed") {
        if (cur.oldPath === null && cur.newPath) cur.status = "added";
        else if (cur.newPath === null && cur.oldPath) cur.status = "removed";
        else {
          cur.oldPath = cur.oldPath ?? cur.path;
          cur.newPath = cur.newPath ?? cur.path;
        }
      }
      files.push(cur);
    }
    cur = null;
  };

  for (const raw of out.split("\n")) {
    const line = raw.replace(/\r$/, "");
    const header = GIT_DIFF_HEADER_RE.exec(line);
    if (header) {
      pushFile();
      cur = {
        path: header[2]!,
        oldPath: header[1]!,
        newPath: header[2]!,
        status: "modified",
        additions: 0,
        deletions:0,
        isBinary: false,
        hunks: [],
      };
      continue;
    }
    if (!cur) continue;
    if (OLD_MODE_RE.test(line) || NEW_MODE_RE.test(line)) continue;
    if (line.startsWith("index ")) continue;
    if (line.startsWith("similarity index")) continue;
    if (line.startsWith("dissimilarity index")) continue;
    const renameFrom = RENAME_FROM_RE.exec(line);
    if (renameFrom) {
      cur.status = "renamed";
      cur.oldPath = renameFrom[1]!;
      continue;
    }
    if (line.startsWith("rename to ")) {
      cur.path = cur.newPath = line.slice("rename to ".length);
      continue;
    }
    const oldPath = OLD_PATH_RE.exec(line);
    if (oldPath) {
      cur.oldPath = oldPath[1] ?? null;
      continue;
    }
    const newPath = NEW_PATH_RE.exec(line);
    if (newPath) {
      if (newPath[1] === undefined) {
        cur.newPath = null;
        cur.path = cur.oldPath ?? cur.path;
      } else {
        cur.newPath = newPath[1]!;
        cur.path = cur.newPath;
      }
      continue;
    }
    if (BINARY_RE.test(line) || (line === "GIT binary patch" && !cur.hunks.length)) {
      cur.isBinary = true;
      continue;
    }
    const hunk = HUNK_RE.exec(line);
    if (hunk) {
      pushHunk();
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[3]);
      curHunk = {
        oldStart: Number(hunk[1]),
        oldLines: Number(hunk[2] ?? "1"),
        newStart: Number(hunk[3]),
        newLines: Number(hunk[4] ?? "1"),
        lines: [],
      };
      continue;
    }
    if (curHunk) {
      if (line.startsWith("+")) {
        curHunk.lines.push({ type: "add", oldLine: null, newLine: newLine++, content: line.slice(1) });
        cur.additions++;
      } else if (line.startsWith("-")) {
        curHunk.lines.push({ type: "remove", oldLine: oldLine++, newLine: null, content: line.slice(1) });
        cur.deletions++;
      } else if (line.startsWith("\\")) {
        // "\ No newline at end of file" — metadata, not a diff line
        continue;
      } else {
        curHunk.lines.push({ type: "context", oldLine: oldLine++, newLine: newLine++, content: line });
      }
    }
  }
  pushFile();
  return files;
}
