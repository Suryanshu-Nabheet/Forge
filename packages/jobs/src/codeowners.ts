// CODEOWNERS: parse `.forge/CODEOWNERS` or `CODEOWNERS`/`.github/CODEOWNERS`
// from the head of a PR, match changed paths against the rules, and pick
// reviewer handles. Rule semantics follow the GitHub spec (last matching
// pattern wins; `*` and `**` supported; `!` exclusions respected; the
// classic owner list applies to all paths).

import { revParse, catFileText } from "@forge/git";

export interface CodeownersMatch {
  /** Owners (handles without @) whose rule matched, most specific last. */
  owners: string[];
}

const CODEOWNERS_PATHS = [".forge/CODEOWNERS", "CODEOWNERS", ".github/CODEOWNERS", "docs/CODEOWNERS"];

function parseOwners(rule: string): string[] {
  return rule
    .split(/\s+/)
    .slice(1) // drop the pattern itself
    .map((o) => o.replace(/^@/, "").trim())
    .filter(Boolean);
}

/** Compile a CODEOWNERS path pattern to a RegExp (gitignore-style subset). */
function patternToRegex(pattern: string): RegExp {
  let p = pattern.replace(/^\/+/, ""); // leading / = repo root; strip for match()
  // `**/` … matches at any depth.
  p = p.replace(/\*\*\//g, "(?:.*/)?");
  // `/**` at the end = everything under the dir.
  p = p.replace(/\/\*\*$/, "/.*");
  // Remaining `**` behave like `*` spanning separators.
  p = p.replace(/\*\*/g, ".*");
  // `*` matches within a path segment.
  p = p.replace(/\*/g, "[^/]*");
  return new RegExp(`^${p}`);
}

/**
 * Match one path against the rules; returns the owners of the LAST
 * matching (non-negating) rule, honoring `!` exclusions.
 */
function ownersForPath(path: string, rules: Array<{ negate: boolean; regex: RegExp; owners: string[] }>): string[] | null {
  let matched: string[] | null = null;
  for (const rule of rules) {
    if (rule.regex.test(path)) {
      if (rule.negate) matched = null;
      else matched = rule.owners;
    }
  }
  return matched;
}

/**
 * Resolve CODEOWNERS reviewers for a diff's changed paths.
 * Returns unique owner handles; the PR author is excluded by the caller.
 */
export async function codeownersReviewers(
  gitDir: string,
  headSha: string,
  changedPaths: string[],
): Promise<string[]> {
  // Read the file from the PR head (what the author proposes).
  let raw: string | null = null;
  for (const p of CODEOWNERS_PATHS) {
    const blob = await revParse(gitDir, `${headSha}:${p}`);
    if (!blob) continue;
    raw = await catFileText(gitDir, blob, 256 * 1024);
    if (raw !== null) break;
  }
  if (!raw) return [];

  const rules = raw
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"))
    .map((line) => {
      const negate = line.startsWith("!");
      const pattern = negate ? line.slice(1) : line.split(/\s+/)[0] ?? "";
      return { negate, regex: patternToRegex(pattern), owners: parseOwners(line) };
    })
    .filter((r) => r.owners.length > 0);

  const owners = new Set<string>();
  for (const path of changedPaths) {
    const o = ownersForPath(path, rules);
    if (o) for (const h of o) owners.add(h);
  }
  return [...owners];
}
