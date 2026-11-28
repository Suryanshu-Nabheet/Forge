// POST /org/repo/issues/:number/scaffold — create the spec branch with INTENT.md
// committed via the git engine, linking intent ↔ branch.

import { NextResponse } from "next/server";
import { requireWritableRepo } from "@/server/authz";
import { and, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, intents, intentLinks, activities, branches } from "@forge/db";
import { repoGitDir } from "@forge/git";

const exec = promisify(execFile);

/**
 * Join a plan-supplied (LLM-generated) relative path onto the worktree,
 * rejecting absolute paths and anything that escapes the worktree root.
 * Returns null when the path is unsafe.
 */
function safeJoin(root: string, rel: string): string | null {
  const cleaned = rel.replace(/\\/g, "/").trim();
  if (cleaned.startsWith("/") || /^[a-zA-Z]:/.test(cleaned)) return null;
  const abs = path.join(root, cleaned);
  const normalizedRoot = path.resolve(root);
  if (!path.resolve(abs).startsWith(normalizedRoot + path.sep)) return null;
  return abs;
}

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const num = Number(number);

  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const intentRows = await db
    .select()
    .from(intents)
    .where(and(eq(intents.repoId, r.repoId), eq(intents.number, num)))
    .limit(1);
  const intent = intentRows[0];
  if (!intent) return NextResponse.json({ error: "intent not found" }, { status: 404 });

  if (intent.branchName) {
    return NextResponse.json({ ok: true, branch: intent.branchName, existing: true });
  }

  const slug = intent.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || "task";
  const branchName = `i${num}-${slug}`;
  const gitDir = repoGitDir(org, repo);

  // Build a worktree from the bare repo, create INTENT.md, commit to a new branch.
  const work = await mkdtemp(path.join(tmpdir(), "forge-scaffold-"));
  try {
    await exec("git", ["clone", "--quiet", "--branch", r.defaultBranch, gitDir, work]);
    const spec = `# Intent #${num}: ${intent.title}\n\n${intent.description ?? ""}\n\n` +
      (intent.plan
        ? `## Plan\n\n${intent.plan.overview}\n\n### Steps\n${intent.plan.steps.map((s) => `- ${s}`).join("\n")}\n`
        : "") +
        `\n---\n_Scaffolded by Forge spec-to-PR workflow._\n`;
    const specPath = intent.plan?.filesToCreate.find((f) => f.path.endsWith(".md"))?.path ?? `docs/intents/${slug}.md`;
    const abs = safeJoin(work, specPath);
    if (!abs) return NextResponse.json({ error: "plan spec path escapes the repository" }, { status: 400 });
    await exec("mkdir", ["-p", path.dirname(abs)]);
    await writeFile(abs, spec);
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=forge-bot", "-c", "user.email=bot@forge.dev", "commit", "--quiet", "-m", `specs: scaffold intent #${num}`]);
    await exec("git", ["-C", work, "push", "--quiet", gitDir, `HEAD:refs/heads/${branchName}`]);

    // The direct push to the bare repo path bypasses the post-receive hook,
    // so sync the branch row + commit here (same shape as syncBranch).
    const pushedSha = (await exec("git", ["--git-dir", gitDir, "rev-parse", branchName])).stdout.trim();
    await db
      .insert(branches)
      .values({ repoId: r.repoId, name: branchName, commitSha: pushedSha, isDefault: false })
      .onConflictDoUpdate({ target: [branches.repoId, branches.name], set: { commitSha: pushedSha, updatedAt: new Date() } });

    await db.update(intents).set({ branchName, status: "in_progress" }).where(eq(intents.id, intent.id));
    await db.insert(intentLinks).values({ intentId: intent.id, kind: "branch", value: branchName });
    await db.insert(activities).values({
      repoId: r.repoId,
      type: "intent_scaffolded",
      data: { branch: branchName, number: num },
    });
    return NextResponse.json({ ok: true, branch: branchName });
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
