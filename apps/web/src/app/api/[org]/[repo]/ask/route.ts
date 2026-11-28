// POST /org/repo/ask — semantic codebase Q&A (queued job, returns answer directly
// for small repos; the queue handles long-running indexing).

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, repositories, embeddings } from "@forge/db";
import { answerQuestion } from "@forge/ai";
import type { EmbeddedChunk } from "@forge/ai";
import { findVisibleRepo } from "@/server/authz";

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const body = (await req.json().catch(() => ({}))) as { question?: string; branch?: string };
  const question = (body.question ?? "").trim();
  if (!question) return NextResponse.json({ error: "question required" }, { status: 400 });

  const r = await findVisibleRepo(org, repo);
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const branch = body.branch ?? r.defaultBranch;
  const chunks = await db
    .select()
    .from(embeddings)
    .where(and(eq(embeddings.repoId, r.repoId), eq(embeddings.branch, branch)));

  const answer = await answerQuestion(question, chunks as unknown as EmbeddedChunk[]);
  return NextResponse.json(answer);
}
