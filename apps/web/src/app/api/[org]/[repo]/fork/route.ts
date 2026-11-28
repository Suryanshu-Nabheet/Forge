// POST /api/:org/:repo/fork — fork a repo into the caller's personal org.
// Creates a new repo row + bare git dir mirroring the source's refs,
// records lineage in forked_repos, and opens a PR-ready upstream remote.

import { NextResponse } from "next/server";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, organizations, repositories, orgMembers, forkedRepos, branches, commits } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";
import { findVisibleRepo, roleInOrg } from "@/server/authz";
import { reposRoot, repoGitDir, setProtectedBranches, gitIn } from "@forge/git";

const exec = promisify(execFile);

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  // Personal org: derived from the user's handle (GitHub-style).
  const slug = user.handle.toLowerCase();
  const existingOrg = (await db.select().from(organizations).where(eq(organizations.slug, slug)).limit(1))[0];
  let orgId: number;
  if (existingOrg) {
    const role = await roleInOrg(existingOrg.id, user.id);
    if (role === "none") {
      return NextResponse.json({ error: "you are not a member of this organization" }, { status: 403 });
    }
    orgId = existingOrg.id;
  } else {
    const [created] = await db.insert(organizations).values({
      slug,
      name: user.name,
      ownerId: user.id,
      description: `${user.name}'s personal org`,
    }).returning({ id: organizations.id });
    orgId = created!.id;
    await db.insert(orgMembers).values({ orgId, userId: user.id, role: "owner" }).onConflictDoNothing();
  }

  // Name: same as upstream unless taken, then name-2, name-3, …
  let name = info.name;
  for (let i = 2; ; i++) {
    const dupe = await db.select({ id: repositories.id }).from(repositories)
      .where(and(eq(repositories.orgId, orgId), eq(repositories.name, name))).limit(1);
    if (dupe.length === 0) break;
    name = `${info.name}-${i}`;
    if (i > 50) return NextResponse.json({ error: "cannot find a free fork name" }, { status: 409 });
  }

  const [forkRow] = await db.insert(repositories).values({
    orgId,
    name,
    description: info.description,
    visibility: info.visibility,
    defaultBranch: info.defaultBranch,
    protectedBranches: ["main"],
  }).returning({ id: repositories.id });

  await db.insert(forkedRepos).values({
    repoId: forkRow!.id,
    forkedFromRepoId: info.repoId,
  });

  // Mirror the git data: local clone of the source bare repo.
  const srcGitDir = repoGitDir(org, info.name);
  const dstGitDir = repoGitDir(slug, name);
  try {
    await exec("git", ["clone", "--mirror", srcGitDir, dstGitDir]);
    // Mirror clones keep origin; reset it to point at the source's HTTP URL
    // so `git push`/`git fetch` in the fork talks to forge itself.
    // Origin URL uses the external base when configured (correct behind proxies);
    // otherwise the local bind address. Mirrored repos are self-contained —
    // the origin is informational and pushes still go through auth.
    const originBase = process.env.FORGE_EXTERNAL_URL?.replace(/\/$/, "")
      ?? `http://localhost:${process.env.FORGE_PORT ?? 3000}`;
    await gitIn(dstGitDir, ["remote", "set-url", "origin", `${originBase}/git/${org}/${info.name}.git`]);
    await setProtectedBranches(dstGitDir, ["main"]);
  } catch (err) {
    // DB rows cascade-delete the fork row on repo delete, but the failed
    // clone dir needs manual cleanup.
    console.error(`[fork] clone failed for ${org}/${info.name} → ${slug}/${name}:`, err);
    await db.delete(repositories).where(eq(repositories.id, forkRow!.id));
    return NextResponse.json({ error: "fork failed while copying git data" }, { status: 500 });
  }

  // Copy branch + commit cache rows so the fork has history immediately.
  const branchRows = await db.select().from(branches).where(eq(branches.repoId, info.repoId));
  if (branchRows.length > 0) {
    await db.insert(branches).values(branchRows.map((b) => ({
      repoId: forkRow!.id,
      name: b.name,
      commitSha: b.commitSha,
      isDefault: b.isDefault,
    }))).onConflictDoNothing();
  }
  const commitRows = await db.select().from(commits).where(eq(commits.repoId, info.repoId)).limit(5000);
  if (commitRows.length > 0) {
    await db.insert(commits).values(commitRows.map((c) => ({
      repoId: forkRow!.id,
      sha: c.sha,
      message: c.message,
      authorName: c.authorName,
      authorEmail: c.authorEmail,
      authoredAt: c.authoredAt,
      committedAt: c.committedAt,
      parentShas: c.parentShas,
      additions: c.additions,
      deletions: c.deletions,
    }))).onConflictDoNothing();
  }

  return NextResponse.json({ id: forkRow!.id, orgSlug: slug, name });
}
