// DELETE /api/orgs/:org/repos/:repo — delete a repository (owner-only).
// Removes the bare git directory and DB rows (cascades).

import { NextResponse } from "next/server";
import { rm } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, recordAudit } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";
import { roleInOrg } from "@/server/authz";
import { repoGitDir } from "@forge/git";

export async function DELETE(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org: orgSlug, repo: repoName } = await params;

  const rows = (await db
    .select({ repoId: repositories.id, orgId: organizations.id })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, orgSlug), eq(repositories.name, repoName)))
    .limit(1))[0];
  if (!rows) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  if ((await roleInOrg(rows.orgId, user.id)) !== "owner") {
    return NextResponse.json({ error: "only org owners can delete repositories" }, { status: 403 });
  }

  // Remove DB rows first (cascades to branches/commits/PRs/embeddings…),
  // then the bare repo directory. If the rm fails the data is still gone
  // but the orphaned dir can be cleaned by an operator.
  await db.delete(repositories).where(eq(repositories.id, rows.repoId));
  try {
    await rm(repoGitDir(orgSlug, repoName), { recursive: true, force: true });
  } catch (err) {
    console.error(`[repos] delete: bare repo cleanup failed for ${orgSlug}/${repoName}:`, err);
  }
  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "repo.delete", targetType: "repo", targetId: `${orgSlug}/${repoName}` });
  return NextResponse.json({ ok: true });
}
