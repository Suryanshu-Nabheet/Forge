// POST /org/repo/pulls/:number/comments — human inline comment.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq } from "drizzle-orm";
import { db, pullRequests, reviewComments } from "@forge/db";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const body = (await req.json()) as { body?: string; path?: string; line?: number; side?: "old" | "new" };
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const prRows = await db.select({ id: pullRequests.id }).from(pullRequests)
    .where(and(eq(pullRequests.repoId, r.repoId), eq(pullRequests.number, num)))
    .limit(1);
  const pr = prRows[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  const [comment] = await db.insert(reviewComments).values({
    prId: pr.id,
    path: body.path ?? null,
    line: body.line ?? null,
    side: body.side ?? "new",
    body: text,
    kind: "human",
    authorId: user.id,
  }).returning({ id: reviewComments.id });

  return NextResponse.json({ ok: true, id: comment!.id });
}
