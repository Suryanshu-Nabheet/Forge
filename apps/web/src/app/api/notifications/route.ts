// GET/POST /api/notifications — activity feed for the signed-in user:
// everything on repos owned by their orgs. POST marks all read.

import { NextResponse } from "next/server";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import { db, activities, organizations, repositories, orgMembers, users, pullRequests, prReviewRequests } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";

const PAGE_SIZE = 50;

export async function GET(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();

  // Orgs the user belongs to (owned or member).
  const myOrgs = await db
    .select({ orgId: organizations.id })
    .from(organizations)
    .where(or(eq(organizations.ownerId, user.id), inArray(
      organizations.id,
      db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, user.id)),
    )));
  if (myOrgs.length === 0) {
    return NextResponse.json({ notifications: [], unread: 0 });
  }
  const orgIds = myOrgs.map((o) => o.orgId);

  const rows = await db
    .select({
      id: activities.id,
      type: activities.type,
      data: activities.data,
      createdAt: activities.createdAt,
      repoName: repositories.name,
      orgSlug: organizations.slug,
      actorName: users.name,
    })
    .from(activities)
    .innerJoin(repositories, eq(repositories.id, activities.repoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .leftJoin(users, eq(users.id, activities.userId))
    .where(inArray(repositories.orgId, orgIds))
    .orderBy(desc(activities.id))
    .limit(PAGE_SIZE);

  const readRes = await db
    .select({ readAt: users.notificationsReadAt })
    .from(users)
    .where(eq(users.id, user.id))
    .limit(1);
  const readAt = readRes[0]?.readAt ?? new Date(0);

  const unread = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(activities)
    .innerJoin(repositories, eq(repositories.id, activities.repoId))
    .where(and(inArray(repositories.orgId, orgIds), gt(activities.createdAt, readAt)));

  const reviewQueue = await pendingReviewRequests(user.id, orgIds);

  return NextResponse.json({
    notifications: rows.map((r) => ({
      id: r.id,
      type: r.type,
      data: r.data,
      repo: `${r.orgSlug}/${r.repoName}`,
      actor: r.actorName,
      createdAt: r.createdAt?.toISOString() ?? null,
      unread: r.createdAt ? r.createdAt > readAt : false,
    })),
    needsReview: reviewQueue.map((q) => ({
      repo: `${q.orgSlug}/${q.repoName}`,
      number: q.number,
      title: q.title,
      source: q.source,
    })),
    unread: Number(unread[0]?.n ?? 0) + reviewQueue.length,
  });
}

/**
 * "Needs your review": open PRs in the user's orgs where they have a
 * pending review request. Lives in the inbox so CODEOWNERS-assigned
 * reviewers see their queue without watching every repo.
 */
async function pendingReviewRequests(userId: number, orgIds: number[]) {
  if (orgIds.length === 0) return [];
  return db
    .select({
      number: pullRequests.number,
      title: pullRequests.title,
      orgSlug: organizations.slug,
      repoName: repositories.name,
      source: prReviewRequests.source,
    })
    .from(prReviewRequests)
    .innerJoin(pullRequests, eq(pullRequests.id, prReviewRequests.prId))
    .innerJoin(repositories, eq(repositories.id, pullRequests.repoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(
      eq(prReviewRequests.userId, userId),
      eq(pullRequests.status, "open"),
      inArray(repositories.orgId, orgIds),
    ))
    .orderBy(desc(pullRequests.updatedAt))
    .limit(20);
}

export async function POST() {
  const user = await requireUser();
  if (!user) return unauthorized();
  await db.update(users).set({ notificationsReadAt: new Date() }).where(eq(users.id, user.id));
  return NextResponse.json({ ok: true });
}
