// POST /api/repos — create org (if needed) + repo (DB row + bare git dir).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, users } from "@forge/db";
import { initBareRepo } from "@forge/git";
import { requireUser, unauthorized } from "@/server/session";

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

  // Org: reuse or create (owner = first user; single-tenant dev semantics for MVP).
  const existingOrg = (await db.select().from(organizations).where(eq(organizations.slug, orgSlug)).limit(1))[0];
  let orgId: number;
  if (existingOrg) {
    orgId = existingOrg.id;
  } else {
    const [org] = await db.insert(organizations).values({
      slug: orgSlug,
      name: orgSlug,
      ownerId: user.id,
    }).returning({ id: organizations.id });
    orgId = org!.id;
  }

  const dupe = await db.select({ id: repositories.id }).from(repositories)
    .where(and(eq(repositories.orgId, orgId), eq(repositories.name, name))).limit(1);
  if (dupe.length > 0) return NextResponse.json({ error: "repo already exists" }, { status: 409 });

  const [repo] = await db.insert(repositories).values({
    orgId,
    name,
    description: body.description || null,
    visibility: body.visibility === "private" ? "private" : "public",
  }).returning({ id: repositories.id });

  await initBareRepo(orgSlug, name);

  return NextResponse.json({ id: repo!.id, orgSlug, name });
}
