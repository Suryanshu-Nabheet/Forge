// POST /api/search — global semantic search across repos the caller can read.
// Cost-bounded: candidates are capped (FORGE_SEARCH_MAX_ROWS, default 2000),
// content is fetched only for the top-20 matches, and anonymous access is
// rate-limited per process (authenticated users get the full budget).

import { NextResponse } from "next/server";
import { eq, inArray, or, and, desc } from "drizzle-orm";
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


function visFilterFor(user: Awaited<ReturnType<typeof currentUser>>) {
  return user
    ? or(
        eq(repositories.visibility, "public"),
        eq(organizations.ownerId, user.id),
        inArray(
          repositories.orgId,
          db.select({ orgId: orgMembers.orgId }).from(orgMembers).where(eq(orgMembers.userId, user.id)),
        ),
      )
    : eq(repositories.visibility, "public");
}

/** Grep the N most recently updated visible repos (bounded work per request). */
async function grepAcrossVisible(q: string, regex: boolean, visFilter: ReturnType<typeof visFilterFor>) {
  const { grepTree, revParse, repoGitDir } = await import("@forge/git");
  const repos = await db
    .select({ orgSlug: organizations.slug, name: repositories.name, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(visFilter)
    .orderBy(desc(repositories.updatedAt))
    .limit(Number(process.env.FORGE_GREP_REPOS ?? 20));

  const matches: Array<GrepMatch & { repo: string }> = [];
  let scannedRepos = 0;
  for (const r of repos) {
    const gitDir = repoGitDir(r.orgSlug, r.name);
    const sha = await revParse(gitDir, r.defaultBranch);
    if (!sha) continue;
    scannedRepos++;
    const found = await grepTree(gitDir, sha, q, { regex, maxResults: 50 });
    for (const m of found) matches.push({ ...m, repo: `${r.orgSlug}/${r.name}` });
    if (matches.length >= 200) break;
  }
  return NextResponse.json({
    matches: matches.slice(0, 200),
    truncated: matches.length >= 200,
    scannedRepos,
  });
}

interface GrepMatch { path: string; line: number; content: string }

export async function POST(req: Request) {
  const user = await currentUser();
  if (!user && !anonAllowed()) {
    return NextResponse.json(
      { error: "too many anonymous searches — sign in or wait a minute" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }
  const body = (await req.json().catch(() => ({}))) as { q?: string; repoId?: number; mode?: string; regex?: boolean };
  const q = (body.q ?? "").trim();
  if (!q) return NextResponse.json({ results: [] });

  // Literal/regex mode: grep the most recently updated visible repos
  // (bounded), returning per-file matches. Semantic mode continues below.
  if (body.mode === "literal") {
    return grepAcrossVisible(q, body.regex === true, visFilterFor(user));
  }

  const visFilter = visFilterFor(user);

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


