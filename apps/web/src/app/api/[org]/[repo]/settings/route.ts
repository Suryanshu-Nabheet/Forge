// GET/PUT /api/org/repo/settings — repo settings (protected branches).
// Owner-only mutation.

import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, repositories } from "@forge/db";
import { currentUser } from "@/server/session";
import { findVisibleRepo } from "@/server/authz";
import { roleInOrg } from "@/server/authz";
import { repoGitDir, setProtectedBranches } from "@forge/git";

const BRANCH_NAME_RE = /^[a-z0-9][a-z0-9_./-]{0,99}$/i;

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const r = await findVisibleRepo(org, repo);
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  const rows = await db
    .select({ protectedBranches: repositories.protectedBranches, visibility: repositories.visibility })
    .from(repositories)
    .where(eq(repositories.id, r.repoId))
    .limit(1);
  return NextResponse.json(rows[0] ?? { protectedBranches: [], visibility: r.visibility });
}

export async function PUT(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const r = await findVisibleRepo(org, repo);
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  // Only org owners manage protection.
  const role = await roleInOrg(r.orgId, user.id);
  if (role !== "owner") {
    return NextResponse.json({ error: "only org owners can change protection" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { protectedBranches?: string[] };
  if (!Array.isArray(body.protectedBranches)) {
    return NextResponse.json({ error: "protectedBranches must be an array" }, { status: 400 });
  }
  const branches = [...new Set(body.protectedBranches.map((b) => String(b).trim()).filter(Boolean))];
  if (branches.length > 20) return NextResponse.json({ error: "too many protected branches" }, { status: 400 });
  for (const b of branches) {
    if (!BRANCH_NAME_RE.test(b) || b.startsWith("-")) {
      return NextResponse.json({ error: `invalid branch name: ${b}` }, { status: 400 });
    }
  }

  await db.update(repositories).set({ protectedBranches: branches }).where(eq(repositories.id, r.repoId));
  await setProtectedBranches(repoGitDir(org, repo), branches);
  return NextResponse.json({ ok: true, protectedBranches: branches });
}
