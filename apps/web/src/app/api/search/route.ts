// POST /api/search — global semantic search across repos the caller can read.
// Cost-bounded: candidates are capped (FORGE_SEARCH_MAX_ROWS, default 2000),
// content is fetched only for the top-20 matches, and anonymous access is
// rate-limited per process (authenticated users get the full budget).

import { NextResponse } from "next/server";
import { eq, inArray, or, and } from "drizzle-orm";
import { db, embeddings, repositories, organizations, orgMembers } from "@forge/db";
import { embedLocal, cosine } from "@forge/ai";
import { currentUser } from "@/server/session";

const MAX_CANDIDATES = Number(process.env.FORGE_SEARCH_MAX_ROWS ?? 2000);
const MAX_ANON_PER_MIN = Number(process.env.FORGE_SEARCH_ANON_PER_MIN ?? 10);

// Tiny in-process limiter for anonymous searches (per-process, like the
// login limiter; single-replica topology is documented).
let anonWindowStart = Date.now();
let anonCount = 0;

function anonAllowed(): boolean {
  const now = Date.now();
  if (now - anonWindowStart > 60_000) {
    anonWindowStart = now;
    anonCount = 0;
  }
  return ++anonCount <= MAX_ANON_PER_MIN;
}

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user && !anonAllowed()) {
    return NextResponse.json(
      { error: "too many anonymous searches — sign in or wait a minute" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { q?: string; repoId?: number };
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

  // Stage 1: cheap columns only (path + embedding vector), bounded.
  const candidates = await db
    .select({
      id: embeddings.id,
      repoId: embeddings.repoId,
      orgSlug: organizations.slug,
      repoName: repositories.name,
      path: embeddings.path,
      branch: embeddings.branch,
      lineStart: embeddings.lineStart,
      lineEnd: embeddings.lineEnd,
      symbol: embeddings.symbol,
      embedding: embeddings.embedding,
    })
    .from(embeddings)
    .innerJoin(repositories, eq(repositories.id, embeddings.repoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(body.repoId ? and(eq(embeddings.repoId, body.repoId), visFilter) : visFilter)
    .limit(MAX_CANDIDATES);

  // Stage 2: score in JS (vectors are unit-normalized → dot product), keep top 20.
  const top = candidates
    .map((r) => ({ ...r, score: cosine(qv, r.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 20);

  // Stage 3: fetch content ONLY for the winners.
  const ids = top.map((t) => t.id);
  const contents = ids.length
    ? await db
        .select({ id: embeddings.id, content: embeddings.content })
        .from(embeddings)
        .where(inArray(embeddings.id, ids))
    : [];
  const contentById = new Map(contents.map((c) => [c.id, c.content]));

  return NextResponse.json({
    results: top.map((r) => ({
      repo: `${r.orgSlug}/${r.repoName}`,
      path: r.path,
      branch: r.branch,
      lineStart: r.lineStart,
      lineEnd: r.lineEnd,
      symbol: r.symbol,
      score: Number(r.score.toFixed(4)),
      snippet: (contentById.get(r.id) ?? "").split("\n").slice(0, 4).join("\n"),
    })),
    scanned: candidates.length,
  });
}


