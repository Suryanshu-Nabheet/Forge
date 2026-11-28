// post-receive hook handler: sync refs to DB, auto-open PRs, enqueue jobs.

import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@forge/db";
import { organizations, repositories, branches, commits, pullRequests, intents, intentLinks, jobQueue, activities, users, prReviewRequests } from "@forge/db";
import { repoGitDir, revParse, revListCommits, commitParents, commitStats } from "@forge/git";
import { dispatchWebhookEvent } from "./webhooks";

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
      await syncBranch(gitDir, repo.repoId, repo.defaultBranch, branchName, u.new, orgSlug, repoName);
      handled++;
      // Push webhook: fire-and-forget, never breaks the hook path.
      void firePushWebhook(repo.repoId, orgSlug, repoName, branchName, u.new, gitDir).catch(() => {});
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
  orgSlug: string,
  repoName: string,
): Promise<void> {
  // 1. Read the OLD sha BEFORE upserting — the incremental import range
  // (old..new) depends on the pre-push value, and the upsert overwrites it.
  const prior = (await db
    .select({ commitSha: branches.commitSha })
    .from(branches)
    .where(and(eq(branches.repoId, repoId), eq(branches.name, branchName)))
    .limit(1))[0];
  const oldSha = prior?.commitSha ?? null;

  // 2. Upsert branch row (onConflict handles the concurrent-create race:
  // two pushes creating the same branch both land on the update path).
  const isDefault = branchName === repoDefaultBranch;
  await db
    .insert(branches)
    .values({ repoId, name: branchName, commitSha: newSha, isDefault })
    .onConflictDoUpdate({
      target: [branches.repoId, branches.name],
      set: { commitSha: newSha, updatedAt: new Date() },
    });

  // 3. Import new commits (old..new); if branch is new, import last 500.
  const range = oldSha && oldSha !== "0".repeat(40) ? `${oldSha}..${newSha}` : null;

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
      let prNumber: number;
      if (openPr[0]) {
        prId = openPr[0]!.id;
        prNumber = openPr[0]!.number;
        await db.update(pullRequests).set({ headSha: newSha, updatedAt: new Date() }).where(eq(pullRequests.id, prId));
      } else {
        const baseSha = await revParse(gitDir, repoDefaultBranch);
        // Retry on unique-number conflicts from concurrent pushes. A conflict
        // on the open-head-branch partial index means a concurrent push already
        // opened the PR for this branch — adopt that PR instead of failing.
        let pr: { id: number; number: number } | undefined;
        for (let attempt = 0; attempt < 3 && !pr; attempt++) {
          const [{ max }] = await db
            .select({ max: sql<number>`coalesce(max(${pullRequests.number}), 0)` })
            .from(pullRequests)
            .where(eq(pullRequests.repoId, repoId));
          try {
            [pr] = await db
              .insert(pullRequests)
              .values({
                repoId,
                number: max + 1,
                // Conventional-commit style title from the branch slug,
                // with the intent linked in the description.
                title: autoPrTitle(branchName, it.title),
                description: `Implements intent #${it.number}: ${it.title}\n\nAuto-opened from branch \`${branchName}\`.`,
                baseBranch: repoDefaultBranch,
                headBranch: branchName,
                headSha: newSha,
                baseSha,
                authorId: it.authorId,
                intentId: it.id,
              })
              .returning({ id: pullRequests.id, number: pullRequests.number });
          } catch (err) {
            const existingPr = (await db
              .select({ id: pullRequests.id, number: pullRequests.number })
              .from(pullRequests)
              .where(and(
                eq(pullRequests.repoId, repoId),
                eq(pullRequests.headBranch, branchName),
                eq(pullRequests.status, "open"),
              ))
              .limit(1))[0];
            if (existingPr) {
              // Concurrent creator won the race; sync it and reuse it.
              await db.update(pullRequests).set({ headSha: newSha, updatedAt: new Date() }).where(eq(pullRequests.id, existingPr.id));
              pr = existingPr;
              break;
            }
            if (attempt === 2) throw err;
            await new Promise((r) => setTimeout(r, 50 + Math.random() * 100));
          }
        }
        if (!pr) throw new Error("pr creation failed");
        prId = pr.id;
        prNumber = pr.number;

        // CODEOWNERS auto-assignment (best-effort; never fails the push).
        try {
          const { codeownersReviewers } = await import("./codeowners");
          const changedPaths = await changedPathsBetween(gitDir, repoDefaultBranch, newSha);
          const handles = await codeownersReviewers(gitDir, newSha, changedPaths);
          if (handles.length > 0) {
            const ownerRows = await db.select({ id: users.id, handle: users.handle }).from(users)
              .where(inArray(users.handle, handles));
            const authorId = it.authorId;
            for (const o of ownerRows) {
              if (o.id === authorId) continue; // never request review from the author
              await db.insert(prReviewRequests)
                .values({ prId, userId: o.id, source: "codeowners" })
                .onConflictDoNothing();
            }
          }
        } catch (err) {
          console.error("[post-receive] codeowners assignment failed:", err);
        }

        await db.update(intents).set({ linkedPrId: prId, status: "in_review" }).where(eq(intents.id, it.id));
        await db.insert(intentLinks).values({ intentId: it.id, kind: "pr", value: String(prNumber) }).onConflictDoNothing();
        await db.insert(activities).values({
          repoId,
          userId: it.authorId,
          type: "pr_opened",
          data: { title: it.title, number: prNumber, branch: branchName },
        });
        // pull_request(opened) webhook — fire-and-forget.
        void db.select({ visibility: repositories.visibility })
          .from(repositories)
          .where(eq(repositories.id, repoId))
          .limit(1)
          .then(([row]) => row && dispatchWebhookEvent(repoId, {
            event: "pull_request",
            repository: { org: orgSlug, name: repoName, visibility: row.visibility },
            pullRequest: { number: prNumber, title: it.title, base: repoDefaultBranch, head: branchName, status: "open" },
          }))
          .catch(() => {});
      }

      // link intent to the pushed commit (idempotent across re-pushes)
      await db
        .insert(intentLinks)
        .values({ intentId: it.id, kind: "commit", value: newSha })
        .onConflictDoNothing();

      // 5. enqueue: AI PR review + preview build (semantic index queued below, once)
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
  return job.id;
}

/** Push webhook: ship the ref update + up to 20 commit summaries. */
async function firePushWebhook(
  repoId: number,
  orgSlug: string,
  repoName: string,
  branch: string,
  newSha: string,
  gitDir: string,
): Promise<void> {
  const repoRows = await db
    .select({ visibility: repositories.visibility })
    .from(repositories)
    .where(eq(repositories.id, repoId))
    .limit(1);
  if (!repoRows[0]) return;
  let commitSummaries: Array<{ sha: string; message: string; author: string }> = [];
  try {
    const raw = await revListCommits(gitDir, newSha, 20);
    commitSummaries = raw.map((c) => ({ sha: c.sha, message: c.message, author: c.authorName }));
  } catch { /* empty repo edge */ }
  await dispatchWebhookEvent(repoId, {
    event: "push",
    repository: { org: orgSlug, name: repoName, visibility: repoRows[0].visibility },
    ref: `refs/heads/${branch}`,
    commits: commitSummaries,
  });
}

/** Paths changed between base and head via diff-tree (name-only). */
async function changedPathsBetween(gitDir: string, base: string, head: string): Promise<string[]> {
  try {
    const { gitIn } = await import("@forge/git");
    const out = await gitIn(gitDir, ["diff-tree", "--no-commit-id", "--name-only", "-r", base, head]);
    return out.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * Draft a conventional-commit-ish PR title from the intent branch name:
 * `i12-fix-login-timeout` -> "Fix login timeout (i12)". Falls back to the
 * intent title when the branch isn't parseable.
 */
function autoPrTitle(branchName: string, fallbackTitle: string): string {
  const m = /^i(\d+)-(.+)$/.exec(branchName);
  if (!m) return fallbackTitle;
  const slug = m[2]!;
  const intentNum = m[1]!;
  const words = slug.replace(/[-_]+/g, " ").trim();
  if (!words) return fallbackTitle;
  const capitalized = words.charAt(0).toUpperCase() + words.slice(1);
  return `${capitalized} (i${intentNum})`;
}
