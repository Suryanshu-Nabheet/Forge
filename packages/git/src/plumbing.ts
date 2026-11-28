// @forge/git plumbing — typed wrappers over `git` CLI plumbing commands.

import type { CommitInfo, TreeEntry } from "@forge/shared";
import { gitIn } from "./engine";

/** Resolve a rev to a full sha. Returns null for unknown refs. */
export async function revParse(gitDir: string, rev: string): Promise<string | null> {
  try {
    const out = await gitIn(gitDir, ["rev-parse", "--verify", "--quiet", rev]);
    return out.trim() || null;
  } catch {
    return null;
  }
}

export async function listBranches(gitDir: string): Promise<string[]> {
  try {
    const out = await gitIn(gitDir, ["for-each-ref", "--format=%(refname:short)", "refs/heads"]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function defaultBranch(gitDir: string): Promise<string> {
  try {
    const out = await gitIn(gitDir, ["symbolic-ref", "--short", "HEAD"]);
    return out.trim() || "main";
  } catch {
    return "main";
  }
}

/** List entries of a tree at a path (direct children only). */
export async function lsTree(gitDir: string, sha: string, treePath: string): Promise<TreeEntry[]> {
  const args = treePath
    ? ["ls-tree", "-l", sha, "--", `${treePath}/`]
    : ["ls-tree", "-l", sha];
  const out = await gitIn(gitDir, args);
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const tabIdx = line.indexOf("\t");
      const meta = line.slice(0, tabIdx).trim();
      const p = line.slice(tabIdx + 1);
      const parts = meta.split(/\s+/);
      const mode = parts[0]!;
      const type = parts[1] as TreeEntry["type"];
      const shaField = parts[2]!;
      const sizeField = parts[3];
      const rel = treePath && p.startsWith(`${treePath}/`) ? p.slice(treePath.length + 1) : p;

      return {
        mode,
        type,
        sha: shaField,
        path: rel,
        size: type === "blob" && sizeField && sizeField !== "-" ? Number(sizeField) : undefined,
      };
    })
    .filter((e) => !treePath || !e.path.includes("/"));
}

export async function catFileText(gitDir: string, sha: string, maxBytes = 1024 * 1024): Promise<string | null> {
  try {
    const out = await gitIn(gitDir, ["cat-file", "-p", sha], { maxBuffer: maxBytes + 4096 });
    if (Buffer.byteLength(out) > maxBytes) return null; // too big to show inline
    return out;
  } catch {
    return null;
  }
}

/** NUL-byte heuristic for binary detection, reading only the first 8KB. */
export async function isBinary(gitDir: string, sha: string): Promise<boolean> {
  try {
    const out = await gitIn(gitDir, ["cat-file", "-p", sha], { maxBuffer: 1024 * 64 });
    return out.slice(0, 8192).includes("\u0000");
  } catch {
    return false;
  }
}

export interface RawCommit {
  sha: string;
  parentShas: string[];
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  committerName: string;
  committerEmail: string;
  committedAt: string;
  message: string;
}

/** Field separator: \x1f, record separator: \x1e. Subject-only messages. */
const REV_FORMAT = "%H%x1f%an%x1f%ae%x1f%aI%x1f%cn%x1f%ce%x1f%cI%x1f%s%x1e";

function parseRevList(out: string, fullMessage: boolean): RawCommit[] {
  const commits: RawCommit[] = [];
  for (const block of out.split("\x1e")) {
    // `git rev-list --pretty` prefixes every entry with "commit <sha>\n";
    // strip it so field 0 is the sha itself (also handles \n separators).
    const clean = block.replace(/^(?:\n|commit\s+[0-9a-f]+\s*\n)+/g, "").trim();
    if (!clean) continue;
    const fields = clean.split("\x1f");
    if (fields.length < 8) continue;
    commits.push({
      sha: fields[0]!,
      authorName: fields[1]!,
      authorEmail: fields[2]!,
      authoredAt: fields[3]!,
      committerName: fields[4]!,
      committerEmail: fields[5]!,
      committedAt: fields[6]!,
      message: (fields[7] ?? "").trim(),
      parentShas: [],
    });
    if (fullMessage) {
      // %B swallows the trailing separator layout; message already captured.
    }
  }
  return commits;
}

/** Commits in a range, newest first. Use "%B" variant for full bodies. */
export async function revListCommits(gitDir: string, range: string, limit?: number): Promise<RawCommit[]> {
  const out = await gitIn(gitDir, [
    "rev-list", `--pretty=format:${REV_FORMAT}`, range,
    ...(limit ? ["--max-count", String(limit)] : []),
  ]);
  return parseRevList(out, false);
}

export async function commitParents(gitDir: string, sha: string): Promise<string[]> {
  const out = await gitIn(gitDir, ["rev-list", "--parents", "-n", "1", sha]);
  return out.trim().split(/\s+/).slice(1);
}

export async function commitInfo(gitDir: string, sha: string): Promise<CommitInfo | null> {
  try {
    const fmt = "%H%x1f%an%x1f%ae%x1f%aI%x1f%P%x1f%cI%x1f%B%x1e";
    const out = await gitIn(gitDir, ["show", "-s", `--format=${fmt}`, sha]);
    const clean = out.trim();
    const fields = clean.split("\x1f");
    if (fields.length < 7) return null;
    return {
      sha: fields[0]!,
      message: (fields[6] ?? "").trim(),
      authorName: fields[1]!,
      authorEmail: fields[2]!,
      authoredAt: fields[3]!,
      committedAt: fields[5]!,
      parentShas: fields[4]!.split(/\s+/).filter(Boolean),
    };
  } catch {
    return null;
  }
}

/** True if `ancestor` is reachable from `descendant` (merge-base --is-ancestor). */
export async function isAncestor(gitDir: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await gitIn(gitDir, ["merge-base", "--is-ancestor", ancestor, descendant], { maxBuffer: 1024 });
    return true;
  } catch {
    return false;
  }
}

/** List tags (name + sha), newest first. */
export async function listTags(gitDir: string): Promise<Array<{ name: string; sha: string }>> {
  try {
    const out = await gitIn(gitDir, ["for-each-ref", "--sort=-creatordate", "--format=%(refname:short)%x1f%(objectname)", "refs/tags"]);
    return out
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((l) => {
        const [name, sha] = l.split("\x1f");
        return { name: name ?? "", sha: sha ?? "" };
      })
      .filter((t) => t.name && t.sha);
  } catch {
    return [];
  }
}

/** Commit stats (additions/deletions) from numstat. */
export async function commitStats(gitDir: string, sha: string): Promise<{ additions: number; deletions: number }> {
  try {
    const out = await gitIn(gitDir, ["show", "--numstat", "--format=", sha]);
    let additions = 0;
    let deletions = 0;
    for (const line of out.split("\n")) {
      if (!line.trim()) continue;
      const [a, d] = line.split("\t");
      if (a && a !== "-") additions += Number(a);
      if (d && d !== "-") deletions += Number(d);
    }
    return { additions, deletions };
  } catch {
    return { additions: 0, deletions: 0 };
  }
}

// ---------- blame ----------

export interface BlameLine {
  sha: string;
  authorName: string;
  authoredAt: string;
  lineNumber: number;
  content: string;
}

/**
 * Per-line authorship for a file at a commit (git blame --porcelain).
 * Each `<sha> <origLine> <finalLine>` header is followed by a tab-prefixed
 * content line for that final line; author metadata lines follow each NEW
 * sha group (repeats omit them), so metadata is cached per sha.
 */
export async function blameFile(gitDir: string, sha: string, path: string, maxBytes = 512 * 1024): Promise<BlameLine[] | null> {
  let out: string;
  try {
    out = await gitIn(gitDir, ["blame", "--porcelain", sha, "--", path], { maxBuffer: maxBytes + 4096 });
  } catch {
    return null;
  }
  if (Buffer.byteLength(out) > maxBytes) return null;

  const metaBySha = new Map<string, { authorName: string; authoredAt: string }>();
  let pendingSha = "";
  let pendingMeta = { authorName: "", authoredAt: "" };
  const lines: BlameLine[] = [];

  for (const raw of out.split("\n")) {
    const header = /^([0-9a-f]{40}) (\d+) (\d+)/.exec(raw);
    if (header) {
      pendingSha = header[1]!;
      pendingMeta = metaBySha.get(pendingSha) ?? { authorName: "", authoredAt: "" };
      continue;
    }
    if (raw.startsWith("\t")) {
      lines.push({
        sha: pendingSha,
        authorName: pendingMeta.authorName,
        authoredAt: pendingMeta.authoredAt,
        lineNumber: lines.length + 1,
        content: raw.slice(1),
      });
      continue;
    }
    const author = /^author (.+)$/.exec(raw);
    if (author) pendingMeta.authorName = author[1]!;
    const time = /^author-time (\d+)$/.exec(raw);
    if (time) pendingMeta.authoredAt = new Date(Number(time[1]!) * 1000).toISOString();
    if (author || time) metaBySha.set(pendingSha, { ...pendingMeta });
  }
  return lines;
}

// ---------- literal code search ----------

export interface GrepMatch {
  path: string;
  line: number;
  content: string;
}

/**
 * Literal or regex search across a commit's tree (git grep), bounded by
 * maxResults. Patterns are passed as a single argv element — never a
 * shell — so injection is not a concern; the caller validates ownership
 * and scope.
 */
export async function grepTree(
  gitDir: string,
  rev: string,
  pattern: string,
  opts?: { regex?: boolean; maxResults?: number; maxLineLength?: number },
): Promise<GrepMatch[]> {
  const maxResults = opts?.maxResults ?? 200;
  // SECURITY: `-e` marks the pattern as a value, never a flag — without it,
  // a pattern like `-f/dev/zero` turns git grep into an unbounded reader
  // that hangs the calling process. Callers additionally reject leading
  // dashes; this is the structural backstop.
  const args = ["grep", "-n", "-I", "--full-name", opts?.regex ? "-E" : "-F", "-e", pattern, rev];
  let out: string;
  try {
    out = await gitIn(gitDir, args, { maxBuffer: 1024 * 1024 * 16 });
  } catch {
    // git grep exits 1 on no matches
    return [];
  }
  const matches: GrepMatch[] = [];
  const cap = opts?.maxLineLength ?? 300;
  // Output format when a rev is given: `<rev>:<path>:<line>:<content>` —
  // --full-name keeps the path free of ./ prefixes.
  const revPrefix = `${rev}:`;
  for (const line of out.split("\n")) {
    if (matches.length >= maxResults) break;
    const body = line.startsWith(revPrefix) ? line.slice(revPrefix.length) : line;
    const idx = body.indexOf(":");
    const numEnd = body.indexOf(":", idx + 1);
    if (idx === -1 || numEnd === -1) continue;
    const path = body.slice(0, idx);
    const num = Number(body.slice(idx + 1, numEnd));
    if (!Number.isInteger(num)) continue;
    let content = body.slice(numEnd + 1);
    if (content.length > cap) content = content.slice(0, cap) + "…";
    matches.push({ path, line: num, content });
  }
  return matches;
}

/** Create an annotated tag on a bare repo, pointing at targetSha. */
export async function createTag(gitDir: string, name: string, targetSha: string, message: string, tagger: { name: string; email: string }): Promise<void> {
  await gitIn(gitDir, [
    "-c", `user.name=${tagger.name}`, "-c", `user.email=${tagger.email}`,
    "tag", "-a", name, "-m", message, targetSha,
  ]);
}

/** Mergeability check without touching the working tree (merge-tree). */
export async function isMergeable(gitDir: string, baseSha: string, headSha: string): Promise<boolean> {
  try {
    const out = await gitIn(gitDir, ["merge-tree", baseSha, headSha], { maxBuffer: 1024 * 1024 });
    // Old-style merge-tree output: conflicted merges contain
    // "changed in both" blocks / "++++++" conflict markers.
    return !out.includes("changed in both") && !out.includes("<<<<<<<");
  } catch {
    return false;
  }
}
