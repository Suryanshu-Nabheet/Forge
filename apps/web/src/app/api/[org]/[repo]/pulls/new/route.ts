// POST /org/repo/pulls — manually open a pull request from any branch.

import { NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { db, pullRequests, activities, intents } from "@forge/db";
import { requireWritableRepo, findVisibleRepo } from "@/server/authz";
import { repoGitDir, revParse, listBranches } from "@forge/git";
import { dispatchWebhookEvent } from "@forge/jobs";

// GET: list branches for the new-PR form.
export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const r = await findVisibleRepo(org, repo);
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  const branches = await listBranches(repoGitDir(org, repo));
  return NextResponse.json({ branches, defaultBranch: r.defaultBranch });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as {
    title?: string;
    head?: string;
    base?: string;
    description?: string;
    intentNumber?: number;
  };
  const head = (body.head ?? "").trim();
  const base = (body.base ?? r.defaultBranch).trim();
  const title = (body.title ?? "").trim();
  if (!head) return NextResponse.json({ error: "head branch required" }, { status: 400 });
  if (head === base) return NextResponse.json({ error: "head and base must differ" }, { status: 400 });
  if (head.startsWith("-") || base.startsWith("-")) {
    return NextResponse.json({ error: "invalid branch name" }, { status: 400 });
  }

  const gitDir = repoGitDir(org, repo);
  const branches = await listBranches(gitDir);
  if (!branches.includes(head)) return NextResponse.json({ error: `head branch not found: ${head}` }, { status: 404 });
  if (!branches.includes(base)) return NextResponse.json({ error: `base branch not found: ${base}` }, { status: 404 });

  // No diff? Reject with a clear message.
  const headSha = await revParse(gitDir, head);
  const baseSha = await revParse(gitDir, base);
  if (!headSha || !baseSha) return NextResponse.json({ error: "cannot resolve branch heads" }, { status: 500 });
  if (headSha === baseSha) {
    return NextResponse.json({ error: "head is already at base — nothing to merge" }, { status: 400 });
  }

  // One open PR per head→base pair.
  const existing = await db
    .select({ id: pullRequests.id, number: pullRequests.number })
    .from(pullRequests)
    .where(and(
      eq(pullRequests.repoId, r.repoId),
      eq(pullRequests.headBranch, head),
      eq(pullRequests.baseBranch, base),
      eq(pullRequests.status, "open"),
    ))
    .limit(1);
  if (existing[0]) {
    return NextResponse.json({ error: `PR #${existing[0].number} is already open for ${head} → ${base}` }, { status: 409 });
  }

  // Optional intent link.
  let intentId: number | null = null;
  if (typeof body.intentNumber === "number" && Number.isInteger(body.intentNumber)) {
    const intent = (await db.execute(sql`
      SELECT id FROM intents WHERE repo_id = ${r.repoId} AND number = ${body.intentNumber} LIMIT 1
    `)).rows[0] as { id: number } | undefined;
    if (intent) intentId = intent.id;
  }

  // Allocate the next number with conflict retry (concurrent opens).
  let pr: { id: number; number: number } | undefined;
  for (let attempt = 0; attempt < 3 && !pr; attempt++) {
    const [{ max }] = await db
      .select({ max: sql<number>`coalesce(max(${pullRequests.number}), 0)` })
      .from(pullRequests)
      .where(eq(pullRequests.repoId, r.repoId));
    try {
      [pr] = await db.insert(pullRequests).values({
        repoId: r.repoId,
        number: max + 1,
        title: title || `Merge ${head} into ${base}`,
        description: body.description ?? null,
        baseBranch: base,
        headBranch: head,
        headSha,
        baseSha,
        authorId: user.id,
        intentId,
      }).returning({ id: pullRequests.id, number: pullRequests.number });
    } catch (err) {
      if (attempt === 2) throw err;
      await new Promise((res) => setTimeout(res, 50 + Math.random() * 100));
    }
  }
  if (!pr) return NextResponse.json({ error: "pr creation failed" }, { status: 500 });

  // Mirror the auto-PR path: link the intent both ways so the intent
  // page shows its PR and status flips to in_review.
  if (intentId) {
    await db.update(intents)
      .set({ linkedPrId: pr.id, status: "in_review", updatedAt: new Date() })
      .where(eq(intents.id, intentId));
  }

  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "pr_opened",
    data: { title, number: pr.number, branch: head },
  });

  // pull_request(opened) webhook — fire-and-forget.
  void dispatchWebhookEvent(r.repoId, {
    event: "pull_request",
    repository: { org, name: repo, visibility: r.visibility },
    sender: { handle: user.handle, name: user.name },
    pullRequest: { number: pr.number, title: title || `Merge ${head} into ${base}`, base, head, status: "open" },
  }).catch(() => {});

  // CODEOWNERS auto-assignment (best-effort, same as the auto-PR path).
  try {
    const { codeownersReviewers } = await import("@forge/jobs");
    const { gitIn } = await import("@forge/git");
    const paths = (await gitIn(gitDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", baseSha ?? "HEAD", headSha]))
      .split("\n").map((l) => l.trim()).filter(Boolean);
    const handles = await codeownersReviewers(gitDir, headSha, paths);
    if (handles.length > 0) {
      const { users: userTable, prReviewRequests } = await import("@forge/db");
      const { inArray } = await import("drizzle-orm");
      const ownerRows = await db.select({ id: userTable.id }).from(userTable).where(inArray(userTable.handle, handles));
      for (const o of ownerRows) {
        if (o.id === user.id) continue;
        await db.insert(prReviewRequests).values({ prId: pr.id, userId: o.id, source: "codeowners" }).onConflictDoNothing();
      }
    }
  } catch { /* never block PR creation on assignment */ }

  // Enqueue review + preview like the intent auto-PR path does.
  const { enqueue } = await import("@forge/jobs");
  await enqueue("pr_review", { repoId: r.repoId, prId: pr.id });
  await enqueue("preview_build", { repoId: r.repoId, prId: pr.id, commitSha: headSha, branch: head });

  return NextResponse.json({ ok: true, number: pr.number, id: pr.id });
}
