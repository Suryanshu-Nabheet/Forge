// POST /org/repo/issues — create an intent.

import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/server/session";
import { and, eq, sql } from "drizzle-orm";
import { db, organizations, repositories, intents, activities } from "@forge/db";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org, repo } = await params;
  const body = (await req.json()) as { title?: string; description?: string; kind?: string };
  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  const rows = await db
    .select({ id: repositories.id })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, org), eq(repositories.name, repo)))
    .limit(1);
  const r = rows[0];
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const [{ max }] = await db
    .select({ max: sql<number>`coalesce(max(${intents.number}), 0)` })
    .from(intents)
    .where(eq(intents.repoId, r.id));

  const kind = body.kind === "spec" || body.kind === "issue" ? body.kind : "intent";
  const [intent] = await db
    .insert(intents)
    .values({
      repoId: r.id,
      number: max + 1,
      title,
      description: body.description ?? null,
      kind,
      labels: [],
    })
    .returning({ id: intents.id, number: intents.number });

  await db.insert(activities).values({
    repoId: r.id,
    type: "intent_created",
    data: { title, number: max + 1 },
  });

  return NextResponse.json({ id: intent!.id, number: intent!.number });
}
