// GET/POST /api/[org]/[repo]/releases — list and create releases.
// POST creates the git tag (annotated, on the bare repo) and the release
// row in one step; write-gated like every repo mutation.

import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { db, releases, activities, recordAudit } from "@forge/db";
import { createTag, revParse, repoGitDir } from "@forge/git";
import { requireWritableRepo } from "@/server/authz";
import { dispatchWebhookEvent } from "@forge/jobs";

const TAG_NAME_RE = /^v?[0-9A-Za-z._-]{1,40}$/;

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const rows = await db
    .select()
    .from(releases)
    .where(eq(releases.repoId, gate.repo.repoId))
    .orderBy(desc(releases.id))
    .limit(50);
  return NextResponse.json({ releases: rows });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;

  const body = (await req.json().catch(() => ({}))) as {
    tagName?: string;
    name?: string;
    notes?: string;
    targetRef?: string; // branch or sha; default = default branch head
    prerelease?: boolean;
  };
  const tagName = (body.tagName ?? "").trim();
  if (!TAG_NAME_RE.test(tagName)) {
    return NextResponse.json({ error: "tag name: 1-40 chars, letters/digits/._- (optional leading v)" }, { status: 400 });
  }
  const name = (body.name ?? tagName).trim();
  if (!name) return NextResponse.json({ error: "release name required" }, { status: 400 });

  const gitDir = repoGitDir(org, repo);
  const targetRef = (body.targetRef ?? "").trim() || r.defaultBranch;
  const targetSha = await revParse(gitDir, targetRef);
  if (!targetSha) return NextResponse.json({ error: `cannot resolve target: ${targetRef}` }, { status: 400 });

  // Tag the repo (annotated) — idempotent creation guarded by the unique
  // index on (repoId, tagName) for the release row and git refusing to
  // move an existing tag.
  const existing = (await db
    .select({ id: releases.id })
    .from(releases)
    .where(and(eq(releases.repoId, r.repoId), eq(releases.tagName, tagName)))
    .limit(1))[0];
  if (existing) return NextResponse.json({ error: "release already exists for this tag" }, { status: 409 });

  try {
    await createTag(gitDir, tagName, targetSha, `Release ${name}`, {
      name: user.name,
      email: `${user.handle}@forge.users`,
    });
  } catch {
    return NextResponse.json({ error: "tag creation failed — does the tag already exist?" }, { status: 409 });
  }

  const [release] = await db
    .insert(releases)
    .values({
      repoId: r.repoId,
      tagName,
      targetSha,
      name,
      notes: body.notes?.trim() || null,
      isPrerelease: body.prerelease === true,
      authorId: user.id,
    })
    .returning({ id: releases.id, tagName: releases.tagName });

  await db.insert(activities).values({
    repoId: r.repoId,
    userId: user.id,
    type: "release_published",
    data: { tag: tagName, name },
  });

  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "release.create", targetType: "release", targetId: `${org}/${repo}@${tagName}` });
  void dispatchWebhookEvent(r.repoId, {
    event: "release",
    repository: { org, name: repo, visibility: r.visibility },
    sender: { handle: user.handle, name: user.name },
    release: { tag: tagName, name, targetSha },
  }).catch(() => {});
  return NextResponse.json({ ok: true, id: release!.id, tagName });
}
