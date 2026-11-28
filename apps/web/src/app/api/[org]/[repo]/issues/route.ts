// POST /org/repo/issues — create an intent.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq, sql } from "drizzle-orm";
import { db, intents, activities } from "@forge/db";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const body = (await req.json().catch(() => ({}))) as { title?: string; description?: string; kind?: string; labels?: string[] };
  const title = (body.title ?? "").trim();
  if (!title) return NextResponse.json({ error: "title required" }, { status: 400 });

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;


  const kind = body.kind === "spec" || body.kind === "issue" ? body.kind : "intent";

  // Autonomous triage: when no labels are supplied, classify the issue
  // deterministically (security/bug/perf/… keyword triage). User-provided
  // labels always win; this only fills the empty case.
  let labels: string[] = [];
  if (Array.isArray(body.labels)) {
    labels = [...new Set(body.labels.map((l) => String(l).trim()).filter(Boolean))].slice(0, 10);
  } else if (title) {
    try {
      const { triageLabels } = await import("@forge/ai");
      labels = triageLabels(title, body.description ?? "");
    } catch { /* triage is best-effort */ }
  }
  // Retry on unique-number conflicts from concurrent creates (mirrors the
  // PR-number retry in the post-receive handler).
  let intent: { id: number; number: number } | undefined;
  for (let attempt = 0; attempt < 3 && !intent; attempt++) {
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${intents.number}), 0)` })
      .from(intents)
      .where(eq(intents.repoId, r.repoId));
    try {
      [intent] = await db
        .insert(intents)
        .values({
          repoId: r.repoId,
          number: max + 1,
          title,
          description: body.description ?? null,
          kind,
          labels,
        })
        .returning({ id: intents.id, number: intents.number });
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((res) => setTimeout(res, 50 + Math.random() * 100));
    }
  }
  if (!intent) throw new Error("intent creation failed");

  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "intent_created",
    data: { title, number: intent.number },
  });

  return NextResponse.json({ id: intent.id, number: intent.number });
}
