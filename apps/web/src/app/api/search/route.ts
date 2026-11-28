// GET/POST /api/search — global semantic search across repos the caller can read.

import { NextResponse } from "next/server";
import { eq, inArray, or, and } from "drizzle-orm";
import { db, embeddings, repositories, organizations, orgMembers } from "@forge/db";
import { embedLocal, cosine } from "@forge/ai";
import { currentUser } from "@/server/session";

export async function POST(req: Request) {
  const user = await currentUser();
  const body = (await req.json()) as { q?: string; repoId?: number };
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });

  // Visible repos: public always; private only orgs the user owns or
  // belongs to (same predicate as roleInOrg).
  const visFilter = user
    ? or(
        eq(repositories.visibility, "public"),
        eq(organizations.ownerId, user.id),
        inArray(
          repositories.orgId,
          db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, user.id)),
        ),
      )
    : eq(repositories.visibility, "public");

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
    .where(body.repoId ? and(eq(embeddings.repoId, body.repoId), visFilter) : visFilter)
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
