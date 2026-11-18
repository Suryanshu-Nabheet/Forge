// post-receive hook handler: sync refs to DB, auto-open PRs, enqueue jobs.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@forge/db";
import { organizations, repositories, branches, commits, pullRequests, intents, intentLinks, jobQueue, jobRuns, activities } from "@forge/db";
import { repoGitDir, listBranches, revParse, revListCommits, commitParents, commitStats, defaultBranch } from "@forge/git";

interface PostReceiveBody {
  org: string;
  repo: string;
  updates: Array<{ old: string; new: string; ref: string }>;
}

export async function handlePostReceive(body: PostReceiveBody): Promise<{ ok: true; handled: number }> {
  const { org: orgSlug, repo: repoName, updates } = body;
  const rows = await db
    .select({ repoId: repositories.id, defaultBranch: repositories.defaultBranch, orgId: organizations.id })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, orgSlug), eq(repositories.name, repoName)))
    .limit(1);
  const repo = rows[0];
  if (!repo) throw new Error(`unknown repo ${orgSlug}/${repoName}`);

  const gitDir = repoGitDir(orgSlug, repoName);
  let handled = 0;

  for (const u of updates) {
    const branchMatch = /^refs\/heads\/(.+)$/.exec(u.ref);
    const tagMatch = /^refs\/tags\/(.+)$/.exec(u.ref);

    if (branchMatch && u.new !== "0".repeat(40)) {
      const branchName = branchMatch[1]!;
      await syncBranch(gitDir, repo.repoId, repo.defaultBranch, branchName, u.new);
      handled++;
    } else if (branchMatch && u.new === "0".repeat(40)) {
      await db.delete(branches).where(and(eq(branches.repoId, repo.repoId), eq(branches.name, branchMatch[1]!)));
      handled++;
    }
    if (tagMatch) handled++;
  }

  return { ok: true, handled };
}

async function syncBranch(
  gitDir: string,
  repoId: number,
  repoDefaultBranch: string,
  branchName: string,
  newSha: string,
): Promise<void> {
  // 1. upsert branch row
  const existing = await db
    .select()
    .from(branches)
    .where(and(eq(branches.repoId, repoId), eq(branches.name, branchName)))
    .limit(1);

  if (existing.length === 0) {
    const isDefault = branchName === repoDefaultBranch;
    await db.insert(branches).values({ repoId, name: branchName, commitSha: newSha, isDefault });
  } else {
    await db
      .update(branches)
      .set({ commitSha: newSha, updatedAt: new Date() })
      .where(eq(branches.id, existing[0]!.id));
  }

  // 2. import new commits (old..new); if branch is new, import last 500
  let range: string | null = null;
  if (existing.length > 0 && existing[0]!.commitSha && existing[0]!.commitSha !== "0".repeat(40)) {
    range = `${existing[0]!.commitSha}..${newSha}`;
  }

  const newCommits = range
    ? await revListCommits(gitDir, range, 500)
    : await revListCommits(gitDir, newSha, 500);

  for (const c of newCommits) {
    const parents = await commitParents(gitDir, c.sha);
    const stats = await commitStats(gitDir, c.sha);
    await db
      .insert(commits)
      .values({
        repoId,
        sha: c.sha,
        message: c.message,
        authorName: c.authorName,
        authorEmail: c.authorEmail,
        authoredAt: new Date(c.authoredAt),
        committedAt: new Date(c.committedAt),
        parentShas: parents,
        additions: stats.additions,
        deletions: stats.deletions,
      })
      .onConflictDoNothing();
  }

  // 3. update repo updatedAt
  await db.update(repositories).set({ updatedAt: new Date() }).where(eq(repositories.id, repoId));

  // 4. auto-open or update PR for i{n}-* branches
  const intentMatch = /^i(\d+)-/.exec(branchName);
  if (intentMatch) {
    const intentNumber = Number(intentMatch[1]!);
    const intent = await db
      .select()
      .from(intents)
      .where(and(eq(intents.repoId, repoId), eq(intents.number, intentNumber)))
      .limit(1);
    if (intent[0]) {
      const it = intent[0];
      // find-or-open PR for this branch targeting repo default branch
      const openPr = await db
        .select()
        .from(pullRequests)
        .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.headBranch, branchName), eq(pullRequests.status, "open")))
        .limit(1);
      let prId: number;
      if (openPr[0]) {
        prId = openPr[0]!.id;
        await db.update(pullRequests).set({ headSha: newSha, updatedAt: new Date() }).where(eq(pullRequests.id, prId));
      } else {
        const [{ max }] = await db
          .select({ max: sql<number>`coalesce(max(${pullRequests.number}), 0)` })
          .from(pullRequests)
          .where(eq(pullRequests.repoId, repoId));
        const baseSha = await revParse(gitDir, repoDefaultBranch);
        const [pr] = await db
          .insert(pullRequests)
          .values({
            repoId,
            number: max + 1,
            title: it.title,
            description: `Implements intent #${it.number}: ${it.title}`,
            baseBranch: repoDefaultBranch,
            headBranch: branchName,
            headSha: newSha,
            baseSha,
            authorId: it.authorId,
            intentId: it.id,
          })
          .returning({ id: pullRequests.id, number: pullRequests.number });
        if (!pr) throw new Error("pr creation failed");
        prId = pr.id;
        await db.update(intents).set({ linkedPrId: prId, status: "in_review" }).where(eq(intents.id, it.id));
        await db.insert(intentLinks).values({ intentId: it.id, kind: "pr", value: String(pr.number) });
        await db.insert(activities).values({
          repoId,
          userId: it.authorId,
          type: "pr_opened",
          data: { title: it.title, number: max + 1, branch: branchName },
        });
      }

      // link intent to the pushed commit
      await db.insert(intentLinks).values({ intentId: it.id, kind: "commit", value: newSha });

      // 5. enqueue: semantic index, AI PR review, preview build
      await enqueue("semantic_index", { repoId, branch: branchName, commitSha: newSha });
      await enqueue("pr_review", { repoId, prId });
      await enqueue("preview_build", { repoId, prId, commitSha: newSha, branch: branchName });
    }
  }

  // 6. always index the pushed branch (search freshness)
  await enqueue("semantic_index", { repoId, branch: branchName, commitSha: newSha });
}

export async function enqueue(queue: string, payload: Record<string, unknown>): Promise<number> {
  const [job] = await db.insert(jobQueue).values({ queue, payload }).returning({ id: jobQueue.id });
  if (!job) throw new Error("enqueue failed");
  await db.insert(jobRuns).values({
    jobQueueId: job.id,
    type: queue as never,
    payload,
    status: "queued",
  });
  return job.id;
}
