// POST /api/repos — create org (if needed) + repo (DB row + bare git dir).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, orgMembers, recordAudit } from "@forge/db";
import { initBareRepo, repoGitDir, setProtectedBranches } from "@forge/git";
import { requireUser, unauthorized } from "@/server/session";
import { roleInOrg } from "@/server/authz";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await req.json().catch(() => ({}))) as {
    orgSlug?: string; name?: string; description?: string; visibility?: string;
  };
  const orgSlug = (body.orgSlug ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(orgSlug)) return NextResponse.json({ error: "invalid org slug" }, { status: 400 });
  if (!SLUG_RE.test(name)) return NextResponse.json({ error: "invalid repo name" }, { status: 400 });

  // Org: reuse if the caller is a member/owner; otherwise create with caller
  // as owner. On a concurrent-create conflict, re-check membership on the
  // winner's org — the caller may NOT have created it.
  const existingOrg = (await db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1))[0];
  let orgId: number;
  let orgCreated = false;
  if (existingOrg) {
    const role = await roleInOrg(existingOrg.id, user.id);
    if (role === "none") {
      return NextResponse.json({ error: "you are not a member of this organization" }, { status: 403 });
    }
    orgId = existingOrg.id;
  } else {
    let org: { id: number } | undefined;
    try {
      [org] = await db.insert(organizations).values({
        slug: orgSlug,
        name: orgSlug,
        ownerId: user.id,
      }).returning({ id: organizations.id });
      if (org) orgCreated = true;
    } catch (err) {
      // Lost a concurrent create race — the winner made the same org.
      // Only unique violations mean that; anything else is a real error.
      if (!(err instanceof Error) || !/unique/i.test(String((err as { code?: string }).code ?? err.message))) {
        throw err;
      }
      org = (await db.select({ id: organizations.id }).from(organizations)
        .where(eq(organizations.slug, orgSlug)).limit(1))[0];
      if (!org) throw new Error("org creation failed");
    }
    orgId = org!.id;
    // Re-check on the resolved org: if we lost the race, the winner's org
    // may not include us — the same membership gate as the existingOrg path.
    const role = await roleInOrg(orgId, user.id);
    if (role === "none") {
      return NextResponse.json({ error: "you are not a member of this organization" }, { status: 403 });
    }
    // The caller owns or is a member of the resolved org; ensure the
    // membership row exists (owner gets it here, pre-existing member keeps theirs).
    await db.insert(orgMembers).values({ orgId, userId: user.id, role: "owner" }).onConflictDoNothing();
  }

  const protectedBranches = ["main"];
  let repo: { id: number } | undefined;
  try {
    [repo] = await db.insert(repositories).values({
      orgId,
      name,
      description: body.description || null,
      visibility: body.visibility === "private" ? "private" : "public",
      protectedBranches,
    }).returning({ id: repositories.id });
  } catch {
    // Lost a concurrent same-name create → clean 409, not a raw 500.
    return NextResponse.json({ error: "repo already exists" }, { status: 409 });
  }

  // Create the bare repo; on failure roll everything back so we don't
  // leave a repo that 500s on every git operation or an empty org.
  const createdOrgHere = orgCreated;
  try {
    await initBareRepo(orgSlug, name);
    await setProtectedBranches(repoGitDir(orgSlug, name), protectedBranches);
  } catch (err) {
    await db.delete(repositories).where(eq(repositories.id, repo!.id));
    if (createdOrgHere) {
      // Best-effort cleanup of the org this request created (cascades to
      // the membership row); ignore failures — an empty org is harmless.
      await db.delete(organizations).where(eq(organizations.id, orgId)).catch(() => {});
    }
    return NextResponse.json({ error: "failed to initialize repository storage" }, { status: 500 });
  }

  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "repo.create", targetType: "repo", targetId: `${orgSlug}/${name}`, data: { visibility: body.visibility === "private" ? "private" : "public" } });
  return NextResponse.json({ id: repo!.id, orgSlug, name });
}
