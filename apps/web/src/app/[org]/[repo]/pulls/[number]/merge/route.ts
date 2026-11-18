// POST /org/repo/pulls/:number/merge — merge strategies: merge-commit | squash | rebase.

import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/server/session";
import { and, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, organizations, repositories, pullRequests, branches, activities, intents } from "@forge/db";
import { repoGitDir, revParse } from "@forge/git";

const exec = promisify(execFile);

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org, repo, number } = await params;
  const num = Number(number);
  const body = (await req.json().catch(() => ({}))) as { strategy?: string };
  const strategy = body.strategy === "squash" || body.strategy === "rebase" ? body.strategy : "merge";

  const rows = await db
    .select({ repoId: repositories.id, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, org), eq(repositories.name, repo)))
    .limit(1);
  const r = rows[0];
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  const prRows = await db.select().from(pullRequests)
    .where(and(eq(pullRequests.repoId, r.repoId), eq(pullRequests.number, num)))
    .limit(1);
  const pr = prRows[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });
  if (pr.status !== "open") return NextResponse.json({ error: `pr already ${pr.status}` }, { status: 409 });

  const gitDir = repoGitDir(org, repo);
  const work = await mkdtemp(path.join(tmpdir(), "forge-merge-"));
  try {
    await exec("git", ["clone", "--quiet", gitDir, work]);
    await exec("git", ["-C", work, "fetch", "--quiet", gitDir, `refs/heads/${pr.headBranch}:refs/heads/${pr.headBranch}`]);
    await exec("git", ["-C", work, "checkout", "--quiet", pr.baseBranch]);

    const author = ["-c", "user.name=forge-bot", "-c", "user.email=bot@forge.dev"];
    let mergeSha: string;
    if (strategy === "squash") {
      await exec("git", ["-C", work, ...author, "merge", "--squash", `origin/${pr.headBranch}`.replace("origin/", "")]);
      await exec("git", ["-C", work, ...author, "commit", "--quiet", "-m", `${pr.title} (#${pr.number})`]);
    } else if (strategy === "rebase") {
      await exec("git", ["-C", work, "checkout", "--quiet", pr.headBranch]);
      await exec("git", ["-C", work, ...author, "rebase", pr.baseBranch]);
      await exec("git", ["-C", work, "checkout", "--quiet", pr.baseBranch]);
      await exec("git", ["-C", work, ...author, "merge", "--ff-only", pr.headBranch]);
    } else {
      await exec("git", ["-C", work, ...author, "merge", "--no-ff", "-m", `Merge pull request #${pr.number}: ${pr.title}`, pr.headBranch]);
    }
    mergeSha = (await exec("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", work, "push", "--quiet", gitDir, `HEAD:refs/heads/${pr.baseBranch}`]);

    await db.update(pullRequests).set({
      status: "merged",
      mergedCommitSha: mergeSha,
      mergedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(pullRequests.id, pr.id));

    const baseSha = await revParse(gitDir, pr.baseBranch);
    if (baseSha) {
      await db.update(branches)
        .set({ commitSha: baseSha, updatedAt: new Date() })
        .where(and(eq(branches.repoId, r.repoId), eq(branches.name, pr.baseBranch)));
    }

    await db.insert(activities).values({
      repoId: r.repoId,
      type: "pr_merged",
      data: { title: pr.title, number: pr.number, strategy },
    });

    // Close the loop: merged PR → its intent is done.
    if (pr.intentId) {
      await db.update(intents).set({ status: "done", updatedAt: new Date() }).where(eq(intents.id, pr.intentId));
    }

    return NextResponse.json({ ok: true, merged: mergeSha, strategy });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "merge failed" }, { status: 500 });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
