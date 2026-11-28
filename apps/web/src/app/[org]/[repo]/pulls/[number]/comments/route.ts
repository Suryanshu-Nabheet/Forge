// POST /org/repo/pulls/:number/comments — human inline comment, with
// optional threading (inReplyTo targets a comment on the same PR).

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq } from "drizzle-orm";
import { db, pullRequests, reviewComments, activities } from "@forge/db";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const body = (await req.json().catch(() => ({}))) as { body?: string; path?: string; line?: number; side?: "old" | "new"; inReplyTo?: number };
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const prRows = await db.select({ id: pullRequests.id, title: pullRequests.title }).from(pullRequests)
    .where(and(eq(pullRequests.repoId, r.repoId), eq(pullRequests.number, num)))
    .limit(1);
  const pr = prRows[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  // Replies must stay within this PR's comment set; they inherit the
  // parent's diff anchor so they render inside the same inline thread.
  let anchor: { path: string | null; line: number | null; side: "old" | "new" } = {
    path: body.path ?? null,
    line: body.line ?? null,
    side: body.side ?? "new",
  };
  if (body.inReplyTo !== undefined) {
    if (!Number.isInteger(body.inReplyTo)) return NextResponse.json({ error: "invalid inReplyTo" }, { status: 400 });
    const parent = (await db
      .select({ id: reviewComments.id, path: reviewComments.path, line: reviewComments.line, side: reviewComments.side })
      .from(reviewComments)
      .where(and(eq(reviewComments.id, body.inReplyTo), eq(reviewComments.prId, pr.id)))
      .limit(1))[0];
    if (!parent) return NextResponse.json({ error: "parent comment not found on this PR" }, { status: 400 });
    anchor = { path: parent.path, line: parent.line, side: parent.side ?? "new" };
  }

  const [comment] = await db.insert(reviewComments).values({
    prId: pr.id,
    inReplyTo: body.inReplyTo ?? null,
    path: anchor.path,
    line: anchor.line,
    side: anchor.side,
    body: text,
    kind: "human",
    authorId: user.id,
  }).returning({ id: reviewComments.id });

  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "comment_posted",
    data: { title: pr.title, number: num },
  });

  return NextResponse.json({ ok: true, id: comment!.id });
}
