// POST /api/[org]/[repo]/branches { action: "delete", branch } — delete a
// branch (git ref + DB row). Protected branches are refused; write-gated.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, repositories, branches, activities, recordAudit } from "@forge/db";
import { repoGitDir, revParse } from "@forge/git";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { requireWritableRepo } from "@/server/authz";

const exec = promisify(execFile);

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as { action?: string; branch?: string };
  const branch = (body.branch ?? "").trim();
  if (body.action !== "delete" || !branch) {
    return NextResponse.json({ error: "action=delete and branch required" }, { status: 400 });
  }
  // argv-injection defense (mirrors the merge route)
  if (branch.startsWith("-") || branch.includes("..") || /[\r\n\0]/.test(branch)) {
    return NextResponse.json({ error: "invalid branch name" }, { status: 400 });
  }

  const protectedList = (await db
    .select({ protectedBranches: repositories.protectedBranches })
    .from(repositories)
    .where(eq(repositories.id, r.repoId))
    .limit(1))[0]?.protectedBranches ?? ["main"];
  if (protectedList.includes(branch)) {
    return NextResponse.json({ error: "protected branches cannot be deleted" }, { status: 403 });
  }
  // The default branch is undeletable even if an owner emptied the
  // protection list (the UI already hides it; enforce server-side).
  if (branch === r.defaultBranch) {
    return NextResponse.json({ error: "the default branch cannot be deleted" }, { status: 403 });
  }

  const gitDir = repoGitDir(org, repo);
  // Existence via the exact ref: rev-parse resolves tags/shas too, and
  // update-ref -d exits 0 for a nonexistent branch whose name matches a
  // tag — "deleting" a tag name and orphaning the activity row.
  const refExists = await revParse(gitDir, `refs/heads/${branch}`);
  if (!refExists) return NextResponse.json({ error: "branch not found" }, { status: 404 });

  try {
    // Direct ref deletion on the bare repo (no working tree needed).
    await exec("git", ["--git-dir", gitDir, "update-ref", "-d", `refs/heads/${branch}`]);
  } catch (err) {
    return NextResponse.json({ error: "ref deletion failed" }, { status: 500 });
  }

  await db.delete(branches).where(and(eq(branches.repoId, r.repoId), eq(branches.name, branch)));
  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "branch_deleted",
    data: { branch },
  });
  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "branch.delete", targetType: "branch", targetId: `${org}/${repo}@${branch}` });

  return NextResponse.json({ ok: true });
}
