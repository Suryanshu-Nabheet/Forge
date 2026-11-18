// Server-side data access for UI pages + REST API routes.
// One module so both React server components and route handlers share logic.

import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "@forge/db";
import {
  users, organizations, repositories, branches, commits,
  pullRequests, reviewComments, intents, intentLinks, activities,
  jobRuns, jobEvents, previews, prApprovals,
} from "@forge/db";
import type {
  RepoSummary, PrSummary, IntentSummary, DiffFile, CommitInfo, TreeEntry,
} from "@forge/shared";
import {
  repoGitDir, lsTree, catFileText, isBinary, revParse, revListCommits,
  diffCommits, defaultBranch, commitInfo,
} from "@forge/git";

// ---------- repos ----------

export async function listRepos(): Promise<RepoSummary[]> {
  const rows = await db
    .select({
      id: repositories.id,
      orgSlug: organizations.slug,
      name: repositories.name,
      description: repositories.description,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
      updatedAt: repositories.updatedAt,
      openPrCount: sql<number>`(SELECT count(*) FROM pull_requests pr WHERE pr.repo_id = ${repositories.id} AND pr.status = 'open')`,
      openIntentCount: sql<number>`(SELECT count(*) FROM intents i WHERE i.repo_id = ${repositories.id} AND i.status NOT IN ('done','closed'))`,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .orderBy(desc(repositories.updatedAt));
  return rows.map((r) => ({
    id: r.id,
    orgSlug: r.orgSlug,
    name: r.name,
    description: r.description,
    visibility: r.visibility,
    defaultBranch: r.defaultBranch,
    openPrCount: Number(r.openPrCount),
    openIntentCount: Number(r.openIntentCount),
    updatedAt: r.updatedAt?.toISOString() ?? null,
  }));
}

export async function findRepo(orgSlug: string, repoName: string) {
  const rows = await db
    .select({
      id: repositories.id,
      orgSlug: organizations.slug,
      orgName: organizations.name,
      name: repositories.name,
      description: repositories.description,
      visibility: repositories.visibility,
      defaultBranch: repositories.defaultBranch,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, orgSlug), eq(repositories.name, repoName)))
    .limit(1);
  return rows[0] ?? null;
}

export async function listBranchesDb(repoId: number): Promise<string[]> {
  const rows = await db.select({ name: branches.name }).from(branches).where(eq(branches.repoId, repoId));
  return rows.map((r) => r.name);
}

export async function resolveBranchSha(gitDir: string, branch: string | null, repoDefault: string): Promise<string | null> {
  const sha = await revParse(gitDir, branch ?? repoDefault);
  return sha ?? revParse(gitDir, repoDefault);
}

export async function repoTree(gitDir: string, sha: string, path: string): Promise<TreeEntry[]> {
  return lsTree(gitDir, sha, path);
}

export async function repoBlob(gitDir: string, sha: string, path: string): Promise<{ content: string | null; isBinary: boolean } | null> {
  const blobSha = await revParse(gitDir, `${sha}:${path}`);
  if (!blobSha) return null;
  const binary = await isBinary(gitDir, blobSha);
  if (binary) return { content: null, isBinary: true };
  const content = await catFileText(gitDir, blobSha);
  return { content, isBinary: false };
}

// ---------- commits ----------

export async function repoCommits(gitDir: string, branchSha: string, limit = 30): Promise<CommitInfo[]> {
  const raw = await revListCommits(gitDir, branchSha, limit);
  return raw.map((c) => ({
    sha: c.sha,
    message: c.message,
    authorName: c.authorName,
    authorEmail: c.authorEmail,
    authoredAt: c.authoredAt,
    committedAt: c.committedAt,
    parentShas: c.parentShas,
  }));
}

// ---------- PRs ----------

export async function listPrs(repoId: number): Promise<PrSummary[]> {
  const rows = await db
    .select({
      id: pullRequests.id,
      number: pullRequests.number,
      repoId: pullRequests.repoId,
      title: pullRequests.title,
      status: pullRequests.status,
      baseBranch: pullRequests.baseBranch,
      headBranch: pullRequests.headBranch,
      riskScore: pullRequests.riskScore,
      riskSummary: pullRequests.riskSummary,
      headSha: pullRequests.headSha,
      createdAt: pullRequests.createdAt,
      authorHandle: users.handle,
      authorName: users.name,
    })
    .from(pullRequests)
    .leftJoin(users, eq(users.id, pullRequests.authorId))
    .where(eq(pullRequests.repoId, repoId))
    .orderBy(desc(pullRequests.number));
  return rows.map((r) => ({
    ...r,
    authorHandle: r.authorHandle ?? "ghost",
    authorName: r.authorName ?? "Unknown",
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getPr(repoId: number, number: number) {
  const rows = await db.select().from(pullRequests)
    .where(and(eq(pullRequests.repoId, repoId), eq(pullRequests.number, number)))
    .limit(1);
  return rows[0] ?? null;
}

export async function prDiff(gitDir: string, baseSha: string | null, headSha: string | null): Promise<DiffFile[]> {
  if (!baseSha || !headSha) return [];
  try {
    return await diffCommits(gitDir, baseSha, headSha);
  } catch {
    return [];
  }
}

export async function prComments(prId: number) {
  return db.select().from(reviewComments).where(eq(reviewComments.prId, prId)).orderBy(reviewComments.id);
}

export async function listApprovals(prId: number): Promise<Array<{ state: string; by: string }>> {
  return db
    .select({ state: prApprovals.state, by: users.name })
    .from(prApprovals)
    .innerJoin(users, eq(users.id, prApprovals.userId))
    .where(eq(prApprovals.prId, prId))
    .orderBy(desc(prApprovals.createdAt));
}

export async function prPreviews(prId: number) {
  return db.select().from(previews).where(eq(previews.prId, prId)).orderBy(desc(previews.id)).limit(5);
}

export async function prJobEvents(prId: number) {
  const runs = await db.select().from(jobRuns).where(eq(jobRuns.prId, prId)).orderBy(desc(jobRuns.id)).limit(10);
  if (runs.length === 0) return [];
  const events = await db.select().from(jobEvents)
    .where(sql`${jobEvents.jobRunId} IN (${sql.join(runs.map((r) => sql`${r.id}`), sql`, `)})`)
    .orderBy(jobEvents.id);
  return events;
}

// ---------- notifications ----------

/** Unread activity count for the nav badge: activities newer than the
 * user's notificationsReadAt marker, across their orgs. */
export async function countUnreadNotifications(userId: number): Promise<number> {
  const rows = await db.execute(sql`
    SELECT count(*)::int AS n
    FROM activities a
    JOIN repositories r ON r.id = a.repo_id
    JOIN organizations o ON o.id = r.org_id
    WHERE (o.owner_id = ${userId} OR o.id IN (
        SELECT org_id FROM org_members WHERE user_id = ${userId}
      ))
      AND a.created_at > (SELECT notifications_read_at FROM users WHERE id = ${userId})
  `);
  return Number((rows.rows[0] as { n: number } | undefined)?.n ?? 0);
}

// ---------- intents ----------

export async function listIntents(repoId: number): Promise<IntentSummary[]> {
  const rows = await db
    .select({
      id: intents.id,
      number: intents.number,
      repoId: intents.repoId,
      title: intents.title,
      status: intents.status,
      kind: intents.kind,
      labels: intents.labels,
      branchName: intents.branchName,
      linkedPrId: intents.linkedPrId,
      planState: intents.planState,
      createdAt: intents.createdAt,
      authorHandle: users.handle,
    })
    .from(intents)
    .leftJoin(users, eq(users.id, intents.authorId))
    .where(eq(intents.repoId, repoId))
    .orderBy(desc(intents.number));
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    repoId: r.repoId,
    title: r.title,
    status: r.status,
    kind: r.kind,
    authorHandle: r.authorHandle ?? "ghost",
    labels: r.labels,
    branchName: r.branchName,
    linkedPrId: r.linkedPrId,
    hasPlan: r.planState === "ready",
    createdAt: r.createdAt.toISOString(),
  }));
}

export async function getIntent(repoId: number, number: number) {
  const rows = await db.select().from(intents)
    .where(and(eq(intents.repoId, repoId), eq(intents.number, number)))
    .limit(1);
  return rows[0] ?? null;
}

export async function intentLinksFor(intentId: number) {
  return db.select().from(intentLinks).where(eq(intentLinks.intentId, intentId));
}

// ---------- activity ----------

export async function recentActivity(limit = 20) {
  return db.select().from(activities).orderBy(desc(activities.id)).limit(limit);
}
