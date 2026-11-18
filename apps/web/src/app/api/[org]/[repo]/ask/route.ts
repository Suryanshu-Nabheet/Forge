// POST /org/repo/ask — semantic codebase Q&A (queued job, returns answer directly
// for small repos; the queue handles long-running indexing).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, embeddings } from "@forge/db";
import { answerQuestion } from "@forge/ai";
import type { EmbeddedChunk } from "@forge/ai";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const body = (await req.json()) as { question?: string; branch?: string };
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const rows = await db
    .select({ repoId: repositories.id, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, org), eq(repositories.name, repo)))
    .limit(1);
  const r = rows[0];
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const branch = body.branch ?? r.defaultBranch;
  const chunks = await db
    .select()
    .from(embeddings)
    .where(and(eq(embeddings.repoId, r.repoId), eq(embeddings.branch, branch)));

  const answer = await answerQuestion(question, chunks as unknown as EmbeddedChunk[]);
  return NextResponse.json(answer);
}
