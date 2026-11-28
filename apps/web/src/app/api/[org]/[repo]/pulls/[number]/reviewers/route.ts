// GET/POST/DELETE /api/[org]/[repo]/pulls/[number]/reviewers — manual
// review requests alongside CODEOWNERS auto-assignment.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, pullRequests, prReviewRequests, users, activities, orgMembers } from "@forge/db";
import { requireWritableRepo } from "@/server/authz";

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;

  const pr = (await db
    .select({ id: pullRequests.id, authorId: pullRequests.authorId })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, gate.repo.repoId), eq(pullRequests.number, num)))
    .limit(1))[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  const rows = await db
    .select({ userId: prReviewRequests.userId, handle: users.handle, source: prReviewRequests.source })
    .from(prReviewRequests)
    .innerJoin(users, eq(users.id, prReviewRequests.userId))
    .where(eq(prReviewRequests.prId, pr.id));
  return NextResponse.json({ reviewers: rows });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as { handle?: string };
  const handle = (body.handle ?? "").trim().toLowerCase();
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 });

  const pr = (await db
    .select({ id: pullRequests.id, title: pullRequests.title, authorId: pullRequests.authorId })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, gate.repo.repoId), eq(pullRequests.number, num)))
    .limit(1))[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  const target = (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1))[0];
  if (!target) return NextResponse.json({ error: `no user with handle "${handle}"` }, { status: 404 });
  if (target.id === pr.authorId) {
    return NextResponse.json({ error: "cannot request review from the PR author" }, { status: 400 });
  }
  // Only org members can be requested: a stranger's inbox filters to
  // their own orgs, so a request outside the org would silently do
  // nothing. Reject it instead of pretending.
  const memberRow = (await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, gate.repo.orgId), eq(orgMembers.userId, target.id)))
    .limit(1))[0];
  if (!memberRow && gate.repo.orgId !== undefined) {
    // org owner counts too
    const { organizations } = await import("@forge/db");
    const org = (await db.select({ ownerId: organizations.ownerId }).from(organizations).where(eq(organizations.id, gate.repo.orgId)).limit(1))[0];
    if (!org || org.ownerId !== target.id) {
      return NextResponse.json({ error: "user is not a member of this organization" }, { status: 400 });
    }
  }

  await db.insert(prReviewRequests)
    .values({ prId: pr.id, userId: target.id, source: "manual" })
    .onConflictDoNothing();

  await db.insert(activities).values({
    repoId: gate.repo.repoId,
    userId: user.id,
    type: "review_requested",
    data: { title: pr.title, number: num },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;

  const body = (await req.json().catch(() => ({}))) as { handle?: string };
  const handle = (body.handle ?? "").trim().toLowerCase();
  if (!handle) return NextResponse.json({ error: "handle required" }, { status: 400 });

  const pr = (await db
    .select({ id: pullRequests.id })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, gate.repo.repoId), eq(pullRequests.number, num)))
    .limit(1))[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  const target = (await db.select({ id: users.id }).from(users).where(eq(users.handle, handle)).limit(1))[0];
  if (!target) return NextResponse.json({ error: "no such user" }, { status: 404 });

  await db.delete(prReviewRequests)
    .where(and(eq(prReviewRequests.prId, pr.id), eq(prReviewRequests.userId, target.id)));
  return NextResponse.json({ ok: true });
}
