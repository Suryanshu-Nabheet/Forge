// Server-side data access for UI pages + REST API routes.
// One module so both React server components and route handlers share logic.

import { and, desc, eq, lt, or, sql } from "drizzle-orm";
import { db } from "@forge/db";
import {
  users, organizations, repositories, branches, commits,
  pullRequests, reviewComments, intents, intentLinks, activities,
  jobRuns, jobEvents, previews, prApprovals,
  stars, watchers, forkedRepos, webhooks, webhookDeliveries as webhookDeliveriesTable,
} from "@forge/db";
import type {
  RepoSummary, PrSummary, IntentSummary, DiffFile, CommitInfo, TreeEntry,
  WebhookSummary, WebhookDeliverySummary, WebhookEventName,
} from "@forge/shared";
import {
  repoGitDir, lsTree, catFileText, isBinary, revParse, revListCommits,
  diffCommits, defaultBranch, commitInfo,
} from "@forge/git";

// ---------- repos ----------

export async function listRepos(userId: number | null, limit = 100): Promise<RepoSummary[]> {
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
    // Visibility filter: public repos for everyone; private repos only
    // for the owning org's members/owner (mirrors the authz core).
    .where(or(
      eq(repositories.visibility, "public"),
      userId === null
        ? sql`false`
        : or(
            eq(organizations.ownerId, userId),
            sql`EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${repositories.orgId} AND m.user_id = ${userId})`,
          ),
    ))
    .orderBy(desc(repositories.updatedAt))
    .limit(limit);
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

export async function listPrs(repoId: number, before?: number, limit = 30): Promise<PrSummary[]> {
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
    .where(before
      ? and(eq(pullRequests.repoId, repoId), lt(pullRequests.number, before))
      : eq(pullRequests.repoId, repoId))
    .orderBy(desc(pullRequests.number))
    .limit(limit);
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

export async function listIntents(repoId: number, before?: number, limit = 30): Promise<IntentSummary[]> {
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
    .where(before
      ? and(eq(intents.repoId, repoId), lt(intents.number, before))
      : eq(intents.repoId, repoId))
    .orderBy(desc(intents.number))
    .limit(limit);
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

/** Activity across repos the user can read (public + their orgs). */
export async function recentActivity(limit = 20, userId: number | null = null) {
  return db
    .select({ id: activities.id, repoId: activities.repoId, userId: activities.userId, type: activities.type, data: activities.data, createdAt: activities.createdAt })
    .from(activities)
    .innerJoin(repositories, eq(repositories.id, activities.repoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(or(
      eq(repositories.visibility, "public"),
      userId === null
        ? sql`false`
        : or(
            eq(organizations.ownerId, userId),
            sql`EXISTS (SELECT 1 FROM org_members m WHERE m.org_id = ${repositories.orgId} AND m.user_id = ${userId})`,
          ),
    ))
    .orderBy(desc(activities.id))
    .limit(limit);
}

// ---------- social: stars / watchers / forks ----------

export async function repoSocial(repoId: number, userId: number | null): Promise<{
  stars: number;
  watchers: number;
  forks: number;
  starred: boolean;
  watching: boolean;
}> {
  const [starCount, watchCount, forkCount] = await Promise.all([
    db.select({ n: sql<number>`count(*)::int` }).from(stars).where(eq(stars.repoId, repoId)),
    db.select({ n: sql<number>`count(*)::int` }).from(watchers).where(eq(watchers.repoId, repoId)),
    db.select({ n: sql<number>`count(*)::int` }).from(forkedRepos).where(eq(forkedRepos.forkedFromRepoId, repoId)),
  ]);
  let starred = false;
  let watching = false;
  if (userId) {
    const [s, w] = await Promise.all([
      db.select({ id: stars.id }).from(stars).where(and(eq(stars.repoId, repoId), eq(stars.userId, userId))).limit(1),
      db.select({ id: watchers.id }).from(watchers).where(and(eq(watchers.repoId, repoId), eq(watchers.userId, userId))).limit(1),
    ]);
    starred = s.length > 0;
    watching = w.length > 0;
  }
  return {
    stars: Number(starCount[0]?.n ?? 0),
    watchers: Number(watchCount[0]?.n ?? 0),
    forks: Number(forkCount[0]?.n ?? 0),
    starred,
    watching,
  };
}

/** Fork lineage info for a repo: where it forked from (if anywhere). */
export async function forkParent(repoId: number): Promise<{ orgSlug: string; name: string } | null> {
  const rows = await db
    .select({ orgSlug: organizations.slug, name: repositories.name })
    .from(forkedRepos)
    .innerJoin(repositories, eq(repositories.id, forkedRepos.forkedFromRepoId))
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(eq(forkedRepos.repoId, repoId))
    .limit(1);
  return rows[0] ?? null;
}

// ---------- webhooks ----------

export async function listWebhooks(repoId: number): Promise<WebhookSummary[]> {
  const rows = await db.select().from(webhooks).where(eq(webhooks.repoId, repoId)).orderBy(desc(webhooks.id));
  return rows.map((w) => ({
    id: w.id,
    url: w.url,
    events: (w.events ?? []) as WebhookEventName[],
    active: w.active,
    createdAt: w.createdAt.toISOString(),
  }));
}

export async function webhookDeliveries(webhookId: number, limit = 20): Promise<WebhookDeliverySummary[]> {
  const rows = await db.select().from(webhookDeliveriesTable)
    .where(eq(webhookDeliveriesTable.webhookId, webhookId))
    .orderBy(desc(webhookDeliveriesTable.id))
    .limit(limit);
  return rows.map((d) => ({
    id: d.id,
    webhookId: d.webhookId,
    event: d.event,
    status: d.status,
    responseStatus: d.responseStatus,
    durationMs: d.durationMs,
    error: d.error,
    createdAt: d.createdAt.toISOString(),
  }));
}

// ---------- compare ----------

/** Parse a compare range like "base...head" or "base..head" into two revs. */
export function parseCompareRange(range: string): { base: string; head: string } | null {
  const three = /^(\S+)\.\.\.(\S+)$/.exec(range);
  if (three) return { base: three[1]!, head: three[2]! };
  const two = /^(\S+)\.\.(\S+)$/.exec(range);
  if (two) return { base: two[1]!, head: two[2]! };
  return null;
}
