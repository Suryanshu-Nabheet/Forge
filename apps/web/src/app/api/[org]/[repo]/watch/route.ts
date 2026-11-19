// POST /api/:org/:repo/watch — toggle watch for the current user.

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, watchers } from "@forge/db";
import { currentUser } from "@/server/session";
import { findVisibleRepo } from "@/server/authz";

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const existing = await db.select({ id: watchers.id })
    .from(watchers)
    .where(and(eq(watchers.repoId, info.repoId), eq(watchers.userId, user.id)))
    .limit(1);

  if (existing.length > 0) {
    await db.delete(watchers).where(eq(watchers.id, existing[0]!.id));
  } else {
    await db.insert(watchers).values({ repoId: info.repoId, userId: user.id }).onConflictDoNothing();
  }

  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(watchers).where(eq(watchers.repoId, info.repoId));
  return NextResponse.json({ watching: existing.length === 0, watchers: Number(n) });
}
