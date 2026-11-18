// Authorization core: visibility checks, org membership, repo-level write gates.
// One module so pages, API routes, and the git transport share one policy.

import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, orgMembers } from "@forge/db";
import { currentUser, type AuthUser } from "./session";

export type Role = "owner" | "member" | "none";

/** Org membership lookup (owner implied for org.ownerId). */
export async function roleInOrg(orgId: number, userId: number): Promise<Role> {
  if (!userId) return "none";
  const org = (await db.select({ ownerId: organizations.ownerId }).from(organizations)
    .where(eq(organizations.id, orgId)).limit(1))[0];
  if (org && org.ownerId === userId) return "owner";
  const member = (await db.select({ id: orgMembers.id }).from(orgMembers)
    .where(and(eq(orgMembers.orgId, orgId), eq(orgMembers.userId, userId))).limit(1))[0];
  return member ? "member" : "none";
}

/** Repo read policy: public → everyone; private → org member (or owner). */
export async function canReadRepo(
  repoId: number,
  orgId: number,
  visibility: "public" | "private",
  userId: number | null,
): Promise<boolean> {
  if (visibility === "public") return true;
  if (!userId) return false;
  const role = await roleInOrg(orgId, userId);
  return role !== "none";
}

/** Repo write policy: any org member/owner for now; refine per-role later. */
export async function canWriteRepo(orgId: number, userId: number | null): Promise<boolean> {
  if (!userId) return false;
  const role = await roleInOrg(orgId, userId);
  return role !== "none";
}

/** Full repo lookup + read gate for pages/routes: returns repo info or null (404). */
export interface VisibleRepo {
  repoId: number;
  orgId: number;
  orgSlug: string;
  orgName: string;
  name: string;
  description: string | null;
  visibility: "public" | "private";
  defaultBranch: string;
}

export async function findVisibleRepo(orgSlug: string, repoName: string): Promise<VisibleRepo | null> {
  const rows = await db
    .select({
      repoId: repositories.id,
      orgId: repositories.orgId,
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
  const repo = rows[0];
  if (!repo) return null;
  const user = await currentUser();
  if (!(await canReadRepo(repo.repoId, repo.orgId, repo.visibility, user?.id ?? null))) return null;
  return repo;
}

/** Write gate for mutations on a repo: resolves the repo or returns a 401/404 response. */
export type Gate = { ok: true; repo: VisibleRepo; user: AuthUser } | { ok: false; response: Response };

export async function requireWritableRepo(orgSlug: string, repoName: string): Promise<Gate> {
  const user = await currentUser();
  if (!user) return { ok: false, response: json(401, "authentication required") };
  const repo = await findRepoBySlug(orgSlug, repoName);
  if (!repo) return { ok: false, response: json(404, "repo not found") };
  if (!(await canWriteRepo(repo.orgId, user.id))) {
    return { ok: false, response: json(403, "no write access to this org") };
  }
  return { ok: true, repo, user };
}

async function findRepoBySlug(orgSlug: string, repoName: string): Promise<VisibleRepo | null> {
  const rows = await db
    .select({
      repoId: repositories.id,
      orgId: repositories.orgId,
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

function json(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
