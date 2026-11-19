// POST /api/:org/:repo/star — toggle star for the current user.

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, stars } from "@forge/db";
import { currentUser } from "@/server/session";
import { findVisibleRepo } from "@/server/authz";

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const existing = await db.select({ id: stars.id })
    .from(stars)
    .where(and(eq(stars.repoId, info.repoId), eq(stars.userId, user.id)))
    .limit(1);

  if (existing.length > 0) {
    await db.delete(stars).where(eq(stars.id, existing[0]!.id));
  } else {
    await db.insert(stars).values({ repoId: info.repoId, userId: user.id }).onConflictDoNothing();
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(stars).where(eq(stars.repoId, info.repoId));
  return NextResponse.json({ starred: existing.length === 0, stars: Number(n) });
}
