// Webhook management API: list / create / delete / ping hooks for a repo.

import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, webhooks, webhookDeliveries as webhookDeliveriesTable, recordAudit } from "@forge/db";
import { currentUser } from "@/server/session";
import { findVisibleRepo, canWriteRepo } from "@/server/authz";
import { listWebhooks, webhookDeliveries } from "@/server/api";
import { dispatchWebhookEvent, pingPayload, resolveWebhookTarget } from "@forge/jobs";
import type { WebhookEventName } from "@forge/shared";

const VALID_EVENTS = new Set<WebhookEventName>(["push", "pull_request", "pr_merged", "ping"]);

export async function GET(_req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });

  // Write access required even to list: hook URLs + secrets are sensitive.
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  if (!(await canWriteRepo(info.orgId, user.id))) {
    return NextResponse.json({ error: "no write access to this repo" }, { status: 403 });
  }

  const hooks = await listWebhooks(info.repoId);
  const withDeliveries = await Promise.all(hooks.map(async (h) => ({
    ...h,
    deliveries: await webhookDeliveries(h.id, 10),
  })));
  return NextResponse.json({ webhooks: withDeliveries });
}

export async function POST(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  if (!(await canWriteRepo(info.orgId, user.id))) {
    return NextResponse.json({ error: "no write access to this repo" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { url?: string; events?: string[] };
  const url = (body.url ?? "").trim();
  if (url.length > 2048) {
    return NextResponse.json({ error: "url must be a valid http(s) URL" }, { status: 400 });
  }
  try {
    await resolveWebhookTarget(url);
  } catch {
    return NextResponse.json({ error: "webhook URL must resolve only to a public http(s) destination" }, { status: 400 });
  }
  const events = (body.events ?? ["push"]).filter((e): e is WebhookEventName => VALID_EVENTS.has(e as WebhookEventName));
  if (events.length === 0) return NextResponse.json({ error: "at least one valid event required" }, { status: 400 });

  const existingCount = await db.select({ id: webhooks.id }).from(webhooks).where(eq(webhooks.repoId, info.repoId));
  if (existingCount.length >= 20) {
    return NextResponse.json({ error: "webhook limit (20) reached for this repo" }, { status: 400 });
  }

  const secret = randomBytes(24).toString("hex");
  const [row] = await db.insert(webhooks).values({
    repoId: info.repoId,
    url,
    secret,
    events,
  }).returning({ id: webhooks.id, url: webhooks.url, events: webhooks.events, active: webhooks.active, createdAt: webhooks.createdAt });

  // Ping the new hook (fire-and-forget; delivery logged in webhook_deliveries).
  void dispatchWebhookEvent(info.repoId, pingPayload(org, repo, info.visibility)).catch(() => {});

  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "webhook.create", targetType: "webhook", targetId: `${org}/${repo}#${row!.id}`, data: { events } });
  // The delivery engine resolves and pins the address again at delivery time.
  return NextResponse.json({
    id: row!.id,
    url: row!.url,
    events: row!.events,
    active: row!.active,
    secret, // shown exactly once, like PATs
    createdAt: row!.createdAt.toISOString(),
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  if (!(await canWriteRepo(info.orgId, user.id))) {
    return NextResponse.json({ error: "no write access to this repo" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { id?: number };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  await db.delete(webhooks).where(and(eq(webhooks.id, body.id), eq(webhooks.repoId, info.repoId)));
  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "webhook.delete", targetType: "webhook", targetId: `${org}/${repo}#${body.id}` });
  return NextResponse.json({ ok: true });
}

// POST /api/org/repo/hooks with { action: "redeliver", deliveryId } — retry a
// failed (or successful) delivery. Write-gated like the other hook mutations.
export async function PUT(req: Request, { params }: { params: Promise<{ org: string; repo: string }> }) {
  const user = await currentUser();
  if (!user) return NextResponse.json({ error: "authentication required" }, { status: 401 });
  const { org, repo } = await params;
  const info = await findVisibleRepo(org, repo);
  if (!info) return NextResponse.json({ error: "repo not found" }, { status: 404 });
  if (!(await canWriteRepo(info.orgId, user.id))) {
    return NextResponse.json({ error: "no write access to this repo" }, { status: 403 });
  }

  const body = (await req.json().catch(() => ({}))) as { action?: string; deliveryId?: number };
  if (body.action !== "redeliver" || !body.deliveryId || !Number.isInteger(body.deliveryId)) {
    return NextResponse.json({ error: "action=redeliver and deliveryId required" }, { status: 400 });
  }

  // Only redeliver deliveries belonging to THIS repo's hooks.
  const owned = await db
    .select({ id: webhookDeliveriesTable.id })
    .from(webhookDeliveriesTable)
    .innerJoin(webhooks, eq(webhooks.id, webhookDeliveriesTable.webhookId))
    .where(and(eq(webhookDeliveriesTable.id, body.deliveryId), eq(webhooks.repoId, info.repoId)))
    .limit(1);
  if (owned.length === 0) return NextResponse.json({ error: "delivery not found" }, { status: 404 });

  const { redeliverWebhook } = await import("@forge/jobs");
  const newId = await redeliverWebhook(body.deliveryId);
  void recordAudit({ actorId: user.id, actorHandle: user.handle, action: "webhook.redeliver", targetType: "webhook_delivery", targetId: `${org}/${repo}#${body.deliveryId}→${newId}` });
  return NextResponse.json({ ok: true, deliveryId: newId });
}
