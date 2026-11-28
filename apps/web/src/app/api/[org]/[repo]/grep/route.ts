// POST /api/[org]/[repo]/grep — literal/regex code search within one repo.
// Visibility-gated like every read surface; pattern length and result
// count bounded.

import { NextResponse } from "next/server";
import { grepTree, revParse, repoGitDir } from "@forge/git";
import { findVisibleRepo } from "@/server/authz";
import { listBranchesDb } from "@/server/api";

const MAX_PATTERN = 200;
const MAX_RESULTS = 200;

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { q?: string; ref?: string; regex?: boolean };
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ matches: [] });
  if (q.length > MAX_PATTERN) {
    return NextResponse.json({ error: `pattern too long (max ${MAX_PATTERN})` }, { status: 400 });
  }
  // SECURITY: reject flag-shaped patterns; git grep has an -e backstop too,
  // but a leading dash should never survive input validation.
  if (q.startsWith("-")) return NextResponse.json({ error: "pattern may not start with '-'" }, { status: 400 });

  const branches = await listBranchesDb(info.repoId);
  const branch = body.ref && branches.includes(body.ref) ? body.ref : info.defaultBranch;
  const gitDir = repoGitDir(org, repo);
  const sha = await revParse(gitDir, branch);
  if (!sha) return NextResponse.json({ matches: [], note: "empty repository" });

  const matches = await grepTree(gitDir, sha, q, {
    regex: body.regex === true,
    maxResults: MAX_RESULTS,
  });
  return NextResponse.json({ matches, ref: branch, truncated: matches.length >= MAX_RESULTS });
}
