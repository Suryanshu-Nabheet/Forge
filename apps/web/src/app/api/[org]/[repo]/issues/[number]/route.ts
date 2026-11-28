// PATCH /api/[org]/[repo]/issues/[number] — edit title/description,
// open/close, and set labels on an intent. Write-gated.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, intents, activities, recordAudit } from "@forge/db";
import { requireWritableRepo } from "@/server/authz";

const MAX_TITLE = 200;
const MAX_LABELS = 10;

export async function PATCH(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    description?: string;
    status?: string;
    labels?: string[];
  };

  const intentRows = await db
    .select()
    .from(intents)
    .where(and(eq(intents.repoId, r.repoId), eq(intents.number, num)))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });

  const update: Partial<typeof intents.$inferInsert> = { updatedAt: new Date() };
  if (body.title !== undefined) {
    const title = body.title.trim();
    if (!title) return NextResponse.json({ error: "title cannot be empty" }, { status: 400 });
    if (title.length > MAX_TITLE) return NextResponse.json({ error: `title too long (max ${MAX_TITLE})` }, { status: 400 });
    update.title = title;
  }
  if (body.description !== undefined) {
    update.description = body.description.trim() || null;
  }
  if (body.status !== undefined) {
    if (body.status !== "open" && body.status !== "closed") {
      return NextResponse.json({ error: "status must be open or closed" }, { status: 400 });
    }
    // done/merge_ready statuses are owned by the PR pipeline.
    update.status = body.status;
    update.closedAt = body.status === "closed" ? new Date() : null;
  }
  if (body.labels !== undefined) {
    if (!Array.isArray(body.labels)) return NextResponse.json({ error: "labels must be an array" }, { status: 400 });
    const labels = [...new Set(body.labels.map((l) => String(l).trim()).filter(Boolean))];
    if (labels.length > MAX_LABELS) return NextResponse.json({ error: `max ${MAX_LABELS} labels` }, { status: 400 });
    update.labels = labels;
  }

  await db.update(intents).set(update).where(eq(intents.id, intent.id));

  if (body.status !== undefined) {
    await db.insert(activities).values({
      repoId: r.repoId,
      userId: user.id,
      type: body.status === "closed" ? "intent_closed" : "intent_reopened",
      data: { title: intent.title, number: num },
    });
  }
  void recordAudit({
    actorId: user.id,
    actorHandle: user.handle,
    action: body.status !== undefined ? "intent.status_update" : "intent.edit",
    targetType: "intent",
    targetId: `${org}/${repo}#${num}`,
    data: body.status !== undefined ? { status: body.status } : {},
  });

  return NextResponse.json({ ok: true });
}
