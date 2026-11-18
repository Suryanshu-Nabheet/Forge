// POST /org/repo/issues/:number/plan — enqueue the AI plan-drafting job.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, intents } from "@forge/db";
import { enqueue } from "@forge/jobs";

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const intentRows = await db
    .select({ id: intents.id })
    .from(intents)
    .where(and(eq(intents.repoId, r.repoId), eq(intents.number, num)))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });

  await db.update(intents).set({ planState: "drafting" }).where(eq(intents.id, intent.id));
  const jobId = await enqueue("intent_plan", { repoId: r.repoId, intentId: intent.id });

  return NextResponse.json({ queued: true, jobId });
}
