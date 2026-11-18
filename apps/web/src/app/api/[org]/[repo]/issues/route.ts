// POST /org/repo/issues — create an intent.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq, sql } from "drizzle-orm";
import { db, organizations, repositories, intents, activities } from "@forge/db";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const body = (await req.json()) as { title?: string; description?: string; kind?: string };
  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${intents.number}), 0)` })
    .from(intents)
    .where(eq(intents.repoId, r.repoId));

  const kind = body.kind === "spec" || body.kind === "issue" ? body.kind : "intent";
  const [intent] = await db
    .insert(intents)
    .values({
      repoId: r.repoId,
      number: max + 1,
      title,
      description: body.description ?? null,
      kind,
      labels: [],
    })
    .returning({ id: intents.id, number: intents.number });

  await db.insert(activities).values({
    repoId: r.repoId,
    type: "intent_created",
    data: { title, number: max + 1 },
  });

  return NextResponse.json({ id: intent!.id, number: intent!.number });
}
