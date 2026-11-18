// POST/GET /api/org/repo/pulls/:number/approvals — PR review approvals.
// POST body: { state: "approved" | "changes_requested" | "revoke" }
// Author of the PR cannot approve their own PR.

import { NextResponse } from "next/server";
import { and, eq, desc } from "drizzle-orm";
import { db, pullRequests, prApprovals, users, activities } from "@forge/db";
import { requireWritableRepo } from "@/server/authz";

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const num = Number(number);

  const pr = (await db.select({ id: pullRequests.id, authorId: pullRequests.authorId })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, gate.repo.repoId), eq(pullRequests.number, num)))
    .limit(1))[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  const rows = await db
    .select({
      state: prApprovals.state,
      createdAt: prApprovals.createdAt,
      userName: users.name,
      userHandle: users.handle,
    })
    .from(prApprovals)
    .innerJoin(users, eq(users.id, prApprovals.userId))
    .where(eq(prApprovals.prId, pr.id))
    .orderBy(desc(prApprovals.createdAt));

  return NextResponse.json({
    approvals: rows.map((r) => ({
      state: r.state,
      by: r.userName ?? r.userHandle,
      createdAt: r.createdAt?.toISOString() ?? null,
    })),
  });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string; number: string }> }) {
  const { org, repo, number } = await params;
  const gate = await requireWritableRepo(org, repo);
  if (!gate.ok) return gate.response;
  const r = gate.repo;
  const user = gate.user;
  const num = Number(number);

  const body = (await req.json().catch(() => ({}))) as { state?: string };
  const state = body.state === "approved" ? "approved"
    : body.state === "changes_requested" ? "changes_requested"
    : body.state === "revoke" ? "revoke"
    : null;
  if (!state) {
    return NextResponse.json({ error: "state must be approved, changes_requested, or revoke" }, { status: 400 });
  }

  const pr = (await db.select({ id: pullRequests.id, authorId: pullRequests.authorId, title: pullRequests.title })
    .from(pullRequests)
    .where(and(eq(pullRequests.repoId, r.repoId), eq(pullRequests.number, num)))
    .limit(1))[0];
  if (!pr) return NextResponse.json({ error: "pr not found" }, { status: 404 });

  if (state !== "revoke" && pr.authorId === user.id) {
    return NextResponse.json({ error: "cannot review your own pull request" }, { status: 403 });
  }

  if (state === "revoke") {
    await db.delete(prApprovals)
      .where(and(eq(prApprovals.prId, pr.id), eq(prApprovals.userId, user.id)));
  } else {
    await db.insert(prApprovals)
      .values({ prId: pr.id, userId: user.id, state })
      .onConflictDoUpdate({
        target: [prApprovals.prId, prApprovals.userId],
        set: { state, createdAt: new Date() },
      });
    await db.insert(activities).values({
      repoId: r.repoId,
      userId: user.id,
      type: state === "approved" ? "pr_approved" : "pr_changes_requested",
      data: { number: num, title: pr.title },
    });
  }

  return NextResponse.json({ ok: true, state });
}
