// Webhook delivery: fan out signed events (push / pull_request / pr_merged)
// to the repo's registered hooks. Runs as a queue job (webhook_delivery).

import { createHmac, timingSafeEqual } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, webhooks, webhookDeliveries } from "@forge/db";
import type { WebhookPayload } from "@forge/shared";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

/** Sign a payload body with a hook's secret (GitHub-style X-Forge-Signature). */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time signature verification (for tests / receivers). */
export function verifySignature(secret: string, body: string, signature: string): boolean {
  const expected = Buffer.from(signPayload(secret, body));
  let presented: Buffer;
  try {
    presented = Buffer.from(signature);
  } catch {
    return false;
  }
  return presented.length === expected.length && timingSafeEqual(presented, expected);
}

/**
 * Enqueue + deliver a webhook event to every matching, active hook on a repo.
 * Called from post-receive (push) and PR lifecycle handlers. Delivery failures
 * never throw into the caller — each hook gets its own delivery row.
 */
export async function dispatchWebhookEvent(repoId: number, payload: WebhookPayload): Promise<number> {
  const event = payload.event;
  const hooks = await db.select().from(webhooks).where(eq(webhooks.repoId, repoId));
  const matching = hooks.filter((h) => h.active && (h.events ?? []).includes(event));

  let delivered = 0;
  for (const hook of matching) {
    const body = JSON.stringify(payload);
    const signature = signPayload(hook.secret, body);
    const [delivery] = await db.insert(webhookDeliveries).values({
      webhookId: hook.id,
      event,
      status: "pending",
      payload,
    }).returning({ id: webhookDeliveries.id });

    const started = Date.now();
    let status: "delivered" | "failed" = "failed";
    let responseStatus: number | null = null;
    let error: string | null = null;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      try {
        const res = await fetch(hook.url, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Forge-Event": event,
            "X-Forge-Signature": signature,
            "X-Forge-Delivery": String(delivery!.id),
            "User-Agent": "Forge-Webhook/1.0",
          },
          body,
          redirect: "error", // no redirect-following: the registered URL is the target
          signal: controller.signal,
        });
        responseStatus = res.status;
        // Drain (capped) so the socket is released; only 2xx counts as delivered.
        const reader = res.body?.getReader();
        if (reader) {
          let read = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done || !value) break;
            read += value.byteLength;
            if (read > MAX_RESPONSE_BYTES) {
              await reader.cancel().catch(() => {});
              break;
            }
          }
        }
        status = res.ok ? "delivered" : "failed";
        if (!res.ok) error = `endpoint responded ${res.status}`;
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    await db.update(webhookDeliveries).set({
      status,
      responseStatus,
      durationMs: Date.now() - started,
      error,
    }).where(eq(webhookDeliveries.id, delivery!.id));

    if (status === "delivered") delivered++;
  }
  return delivered;
}

/** Ping event: sent when a hook is created to verify reachability. */
export function pingPayload(org: string, name: string, visibility: "public" | "private"): WebhookPayload {
  return {
    event: "ping",
    repository: { org, name, visibility },
  };
}
