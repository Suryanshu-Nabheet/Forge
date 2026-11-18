// GET/POST /api/search — global semantic search across repos.

import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, embeddings, repositories, organizations } from "@forge/db";
import { embedLocal, cosine } from "@forge/ai";

export async function POST(req: Request) {
  const body = (await req.json()) as { q?: string; repoId?: number };
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });

  const qv = embedLocal(q, null);
  const rows = await db
    .select({
      repoId: embeddings.repoId,
      orgSlug: organizations.slug,
      repoName: repositories.name,
      path: embeddings.path,
      branch: embeddings.branch,
      lineStart: embeddings.lineStart,
      lineEnd: embeddings.lineEnd,
      symbol: embeddings.symbol,
      content: embeddings.content,
      embedding: embeddings.embedding,
    })
    .from(embeddings)
    .innerJoin(repositories, eq(repositories.id, embeddings.repoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(body.repoId ? and(eq(embeddings.repoId, body.repoId)) : undefined)
    .limit(20000);

  const scored = rows
    .map((r) => ({ ...r, score: cosine(qv, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  return NextResponse.json({
    results: scored.map((r) => ({
      repo: `${r.orgSlug}/${r.repoName}`,
      path: r.path,
      branch: r.branch,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      symbol: r.symbol,
      score: Number(r.score.toFixed(4)),
      snippet: r.content.split("\n").slice(0, 4).join("\n"),
    })),
  });
}
