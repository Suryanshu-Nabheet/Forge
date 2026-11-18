// POST /org/repo/issues/:number/scaffold — create the spec branch with INTENT.md
// committed via the git engine, linking intent ↔ branch.

import { NextResponse } from "next/server";
import { requireUser, unauthorized } from "@/server/session";
import { and, eq } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, organizations, repositories, intents, intentLinks, activities } from "@forge/db";
import { repoGitDir } from "@forge/git";

const exec = promisify(execFile);

export async function POST(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const { org, repo, number } = await params;
  const num = Number(number);

  const rows = await db
    .select({ repoId: repositories.id, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, org), eq(repositories.name, repo)))
    .limit(1);
  const r = rows[0];
  if (!r) return NextResponse.json({ error: "repo not found" }, { status: 404 });

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
        `\n---\n_Scaffolded by FORGE-NEXT spec-to-PR workflow._\n`;
    const specPath = intent.plan?.filesToCreate.find((f) => f.path.endsWith(".md"))?.path ?? `docs/intents/${slug}.md`;
    const abs = path.join(work, specPath);
    await exec("mkdir", ["-p", path.dirname(abs)]);
    await writeFile(abs, spec);
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=forge-bot", "-c", "user.email=bot@forge.next", "commit", "--quiet", "-m", `specs: scaffold intent #${num}`]);
    await exec("git", ["-C", work, "push", "--quiet", gitDir, `HEAD:refs/heads/${branchName}`]);

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
