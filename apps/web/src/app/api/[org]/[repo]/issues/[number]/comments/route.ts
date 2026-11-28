// POST/GET /api/[org]/[repo]/issues/[number]/comments — intent discussion
// threads. POST body: { body, inReplyTo? } (inReplyTo must target a
// comment on the same intent).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, intents, reviewComments, users, activities } from "@forge/db";
import { requireWritableRepo } from "@/server/authz";

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;

  const intent = (await db
    .select({ id: intents.id })
    .from(intents)
    .where(and(eq(intents.repoId, gate.repo.repoId), eq(intents.number, num)))
    .limit(1))[0];
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });

  const rows = await db
    .select({
      id: reviewComments.id,
      body: reviewComments.body,
      inReplyTo: reviewComments.inReplyTo,
      authorHandle: users.handle,
      authorName: users.name,
      createdAt: reviewComments.createdAt,
    })
    .from(reviewComments)
    .leftJoin(users, eq(users.id, reviewComments.authorId))
    .where(eq(reviewComments.intentId, intent.id))
    .orderBy(reviewComments.id);
  return NextResponse.json({ comments: rows });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as { body?: string; inReplyTo?: number };
  const text = (body.body ?? "").trim();
  if (!text) return NextResponse.json({ error: "body required" }, { status: 400 });
  if (text.length > 20000) return NextResponse.json({ error: "comment too long" }, { status: 400 });

  const intent = (await db
    .select({ id: intents.id, title: intents.title })
    .from(intents)
    .where(and(eq(intents.repoId, r.repoId), eq(intents.number, num)))
    .limit(1))[0];
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });

  if (body.inReplyTo !== undefined) {
    if (!Number.isInteger(body.inReplyTo)) return NextResponse.json({ error: "invalid inReplyTo" }, { status: 400 });
    const parent = (await db
      .select({ id: reviewComments.id })
      .from(reviewComments)
      .where(and(eq(reviewComments.id, body.inReplyTo), eq(reviewComments.intentId, intent.id)))
      .limit(1))[0];
    if (!parent) return NextResponse.json({ error: "parent comment not found on this intent" }, { status: 400 });
  }

  const [row] = await db
    .insert(reviewComments)
    .values({
      intentId: intent.id,
      inReplyTo: body.inReplyTo ?? null,
      body: text,
      kind: "human",
      authorId: user.id,
    })
    .returning({ id: reviewComments.id });

  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "comment_posted",
    data: { title: intent.title, number: num },
  });

  return NextResponse.json({ ok: true, id: row!.id });
}

