// GET/POST/DELETE /api/orgs/:org/members — org member management (owner-only
// for mutations). Members: repo read/write; owners: settings + protection.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, organizations, users, orgMembers, activities } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";
import { roleInOrg } from "@/server/authz";

async function orgBySlug(slug: string) {
  return (await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1))[0] ?? null;
}

export async function GET(_req: Request, { params }: { params: Promise<{ org: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org } = await params;
  const o = await orgBySlug(org);
  if (!o) return NextResponse.json({ error: "org not found" }, { status: 404 });
  const role = await roleInOrg(o.id, user.id);
  if (role === "none") return NextResponse.json({ error: "not a member" }, { status: 403 });

  const rows = await db
    .select({
      id: orgMembers.id,
      userId: orgMembers.userId,
      role: orgMembers.role,
      name: users.name,
      handle: users.handle,
    })
    .from(orgMembers)
    .innerJoin(users, eq(users.id, orgMembers.userId))
    .where(eq(orgMembers.orgId, o.id));

  // The owner is implicitly a member; include them if not duplicated.
  const ownerRow = (await db.select({ id: users.id, name: users.name, handle: users.handle })
    .from(users).where(eq(users.id, o.ownerId)).limit(1))[0];
  const members = [...rows];
  if (ownerRow && !members.some((m) => m.userId === ownerRow.id)) {
    members.unshift({ id: -1, userId: ownerRow.id, role: "owner" as const, name: ownerRow.name, handle: ownerRow.handle });
  }
  return NextResponse.json({ members, you: role });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org } = await params;
  const o = await orgBySlug(org);
  if (!o) return NextResponse.json({ error: "org not found" }, { status: 404 });
  if ((await roleInOrg(o.id, user.id)) !== "owner") {
    return NextResponse.json({ error: "only org owners can manage members" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { handle?: string };
  const handle = (body.handle ?? "").trim().toLowerCase();
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 });

  const target = (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1))[0];
  if (!target) return NextResponse.json({ error: `no user with handle "${handle}"` }, { status: 404 });
  if (target.id === o.ownerId) {
    return NextResponse.json({ error: "the owner is already an owner" }, { status: 409 });
  }

  await db.insert(orgMembers)
    .values({ orgId: o.id, userId: target.id, role: "member" })
    .onConflictDoNothing();
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ org: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org } = await params;
  const o = await orgBySlug(org);
  if (!o) return NextResponse.json({ error: "org not found" }, { status: 404 });
  if ((await roleInOrg(o.id, user.id)) !== "owner") {
    return NextResponse.json({ error: "only org owners can manage members" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { userId?: number };
  if (!body.userId || !Number.isInteger(body.userId)) {
    return NextResponse.json({ error: "userId required" }, { status: 400 });
  }
  if (body.userId === o.ownerId) {
    return NextResponse.json({ error: "cannot remove the org owner" }, { status: 400 });
  }
  await db.delete(orgMembers).where(and(eq(orgMembers.orgId, o.id), eq(orgMembers.userId, body.userId)));
  return NextResponse.json({ ok: true });
}
