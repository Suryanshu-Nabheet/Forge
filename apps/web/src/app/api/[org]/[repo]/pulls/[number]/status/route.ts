// POST /api/org/repo/pulls/:number/status — close or reopen a PR.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, pullRequests, activities, intents } from "@forge/db";
import { requireWritableRepo } from "@/server/authz";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const user = gate.user;
  const num = Number(number);
  const body = (await req.json().catch(() => ({}))) as { status?: string };
  const next = body.status === "open" || body.status === "closed" ? body.status : null;
  if (!next) return NextResponse.json({ error: "status must be open or closed" }, { status: 400 });

  const prRows = await db.select().from(pullRequests)
    .where(and(eq(pullRequests.repoId, gate.repo.repoId), eq(pullRequests.number, num)))
    .limit(1);
  const pr = prRows[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });
  if (pr.status === "merged") return NextResponse.json({ error: "merged PRs cannot change status" }, { status: 409 });

  await db.update(pullRequests)
    .set({ status: next, updatedAt: new Date() })
    .where(eq(pullRequests.id, pr.id));

  // Keep the linked intent's pipeline in sync with PR lifecycle.
  if (pr.intentId) {
    await db.update(intents)
      .set({ status: next === "closed" ? "in_progress" : "in_review", updatedAt: new Date() })
      .where(eq(intents.id, pr.intentId));
  }
  await db.insert(activities).values({
    repoId: gate.repo.repoId,
    userId: user.id,
    type: next === "closed" ? "pr_closed" : "pr_reopened",
    data: { number: num, title: pr.title },
  });
  return NextResponse.json({ ok: true, status: next });
}
