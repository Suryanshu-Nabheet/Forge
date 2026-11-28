// POST /org/repo/pulls/:number/merge — merge strategies: merge-commit | squash | rebase.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, repositories, pullRequests, branches, activities, intents, prApprovals, recordAudit } from "@forge/db";
import { repoGitDir, revParse } from "@forge/git";
import { dispatchWebhookEvent } from "@forge/jobs";

const exec = promisify(execFile);

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);
  const body = (await req.json().catch(() => ({}))) as { strategy?: string };
  const strategy = body.strategy === "squash" || body.strategy === "rebase" ? body.strategy : "merge";

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const prRows = await db.select().from(pullRequests)
    .where(and(eq(pullRequests.repoId, r.repoId), eq(pullRequests.number, num)))
    .limit(1);
  const pr = prRows[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });
  if (pr.status !== "open") return NextResponse.json({ error: `pr already ${pr.status}` }, { status: 409 });

  // Approval gate: merging INTO a protected branch requires ≥1 approval
  // (from someone other than the PR author) and no outstanding
  // changes_requested reviews.
  const protectedRows = (await db.select({ protectedBranches: repositories.protectedBranches })
    .from(repositories).where(eq(repositories.id, r.repoId)).limit(1))[0];
  const isProtected = (protectedRows?.protectedBranches ?? ["main"]).includes(pr.baseBranch);
  if (isProtected) {
    const reviews = await db.select({ state: prApprovals.state, userId: prApprovals.userId })
      .from(prApprovals).where(eq(prApprovals.prId, pr.id));
    const blocking = reviews.some((v) => v.state === "changes_requested");
    const approvals = reviews.filter((v) => v.state === "approved" && v.userId !== pr.authorId);
    if (blocking) {
      return NextResponse.json({ error: "changes were requested on this pull request" }, { status: 403 });
    }
    if (approvals.length === 0) {
      return NextResponse.json({ error: "merging into a protected branch requires at least one approving review" }, { status: 403 });
    }
  }

  const gitDir = repoGitDir(org, repo);
  const work = await mkdtemp(path.join(tmpdir(), "forge-merge-"));

  // Refuse refs that could be parsed as git options (defends argv injection).
  for (const ref of [pr.headBranch, pr.baseBranch]) {
    if (ref.startsWith("-") || ref.includes("..") || /[\r\n\0]/.test(ref)) {
      return NextResponse.json({ error: "invalid branch name" }, { status: 400 });
    }
  }

  try {
    await exec("git", ["clone", "--quiet", gitDir, work]);
    await exec("git", ["-C", work, "fetch", "--quiet", gitDir, `refs/heads/${pr.headBranch}:refs/heads/${pr.headBranch}`]);
    await exec("git", ["-C", work, "checkout", "--quiet", pr.baseBranch]);

    const author = ["-c", "user.name=forge-bot", "-c", "user.email=bot@forge.dev"];
    let mergeSha: string;
    if (strategy === "squash") {
      await exec("git", ["-C", work, ...author, "merge", "--squash", `refs/heads/${pr.headBranch}`]);
      await exec("git", ["-C", work, ...author, "commit", "--quiet", "-m", `${pr.title} (#${pr.number})`]);
    } else if (strategy === "rebase") {
      await exec("git", ["-C", work, "checkout", "--quiet", pr.headBranch]);
      await exec("git", ["-C", work, ...author, "rebase", pr.baseBranch]);
      await exec("git", ["-C", work, "checkout", "--quiet", pr.baseBranch]);
      await exec("git", ["-C", work, ...author, "merge", "--ff-only", `refs/heads/${pr.headBranch}`]);
    } else {
      await exec("git", ["-C", work, ...author, "merge", "--no-ff", "-m", `Merge pull request #${pr.number}: ${pr.title}`, `refs/heads/${pr.headBranch}`]);
    }
    mergeSha = (await exec("git", ["-C", work, "rev-parse", "HEAD"])).stdout.trim();
    await exec("git", ["-C", work, "push", "--quiet", gitDir, `HEAD:refs/heads/${pr.baseBranch}`], {
      env: { ...process.env, FORGE_ALLOW_PROTECTED_BRANCH_PUSH: "1" },
    });

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
      userId: user.id,
      type: "pr_merged",
      data: { title: pr.title, number: pr.number, strategy },
    });

    // Close the loop: merged PR → its intent is done.
    if (pr.intentId) {
      await db.update(intents).set({ status: "done", updatedAt: new Date() }).where(eq(intents.id, pr.intentId));
    }

    // pr_merged webhook — never blocks the merge response.
    void dispatchWebhookEvent(r.repoId, {
      event: "pr_merged",
      repository: { org, name: repo, visibility: r.visibility },
      sender: { handle: user.handle, name: user.name },
      pullRequest: { number: pr.number, title: pr.title, base: pr.baseBranch, head: pr.headBranch, status: "merged" },
    }).catch(() => {});

    void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "pr.merge", targetType: "pr", targetId: `${org}/${repo}#${pr.number}`, data: { strategy } });
    return NextResponse.json({ ok: true, merged: mergeSha, strategy });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "merge failed" }, { status: 500 });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
