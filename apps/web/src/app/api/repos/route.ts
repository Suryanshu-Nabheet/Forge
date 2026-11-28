// POST /api/repos — create org (if needed) + repo (DB row + bare git dir).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, orgMembers } from "@forge/db";
import { initBareRepo, repoGitDir, setProtectedBranches } from "@forge/git";
import { requireUser, unauthorized } from "@/server/session";
import { roleInOrg } from "@/server/authz";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as {
    orgSlug?: string; name?: string; description?: string; visibility?: string;
  };
  const orgSlug = (body.orgSlug ?? "").trim().toLowerCase();
  const name = (body.name ?? "").trim().toLowerCase();
  if (!SLUG_RE.test(orgSlug)) return NextResponse.json({ error: "invalid org slug" }, { status: 400 });
  if (!SLUG_RE.test(name)) return NextResponse.json({ error: "invalid repo name" }, { status: 400 });

  // Org: reuse if the caller is a member/owner; otherwise create with caller as owner.
  const existingOrg = (await db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1))[0];
  let orgId: number;
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
    } catch {
      // Lost a concurrent create race — the winner made the same org.
      org = (await db.select({ id: organizations.id }).from(organizations)
        .where(eq(organizations.slug, orgSlug)).limit(1))[0];
      if (!org) throw new Error("org creation failed");
    }
    orgId = org!.id;
    await db.insert(orgMembers).values({ orgId, userId: user.id, role: "owner" }).onConflictDoNothing();
  }

  const dupe = await db.select({ id: repositories.id }).from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.name, name))).limit(1);
  if (dupe.length > 0) return NextResponse.json({ error: "repo already exists" }, { status: 409 });

  const protectedBranches = ["main"];
  const [repo] = await db.insert(repositories).values({
    orgId,
    name,
    description: body.description || null,
    visibility: body.visibility === "private" ? "private" : "public",
    protectedBranches,
  }).returning({ id: repositories.id });

  // Create the bare repo; on failure roll the DB row back so we don't
  // leave a repo that 500s on every git operation (mirrors fork cleanup).
  try {
    await initBareRepo(orgSlug, name);
    await setProtectedBranches(repoGitDir(orgSlug, name), protectedBranches);
  } catch (err) {
    await db.delete(repositories).where(eq(repositories.id, repo!.id));
    return NextResponse.json({ error: "failed to initialize repository storage" }, { status: 500 });
  }

  return NextResponse.json({ id: repo!.id, orgSlug, name });
}
