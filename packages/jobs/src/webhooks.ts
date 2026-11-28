// Webhook delivery: fan out signed events (push / pull_request / pr_merged)
// to the repo's registered hooks. Runs as a queue job (webhook_delivery).

import { createHmac, timingSafeEqual } from "node:crypto";
import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { eq } from "drizzle-orm";
import { db, webhooks, webhookDeliveries } from "@forge/db";
import type { WebhookPayload } from "@forge/shared";

const TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const privateNetworks = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8],
  ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.0.2.0", 24],
  ["192.88.99.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["198.51.100.0", 24],
  ["203.0.113.0", 24], ["224.0.0.0", 4],
] as const) privateNetworks.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8],
  ["2001:db8::", 32], ["2002::", 16],
] as const) privateNetworks.addSubnet(network, prefix, "ipv6");

interface WebhookTarget { url: URL; address: string; family: 4 | 6 }

/** Resolve and pin a webhook destination while rejecting private/reserved ranges. */
export async function resolveWebhookTarget(rawUrl: string): Promise<WebhookTarget> {
  const url = new URL(rawUrl);
  if (!new Set(["http:", "https:"]).has(url.protocol) || url.username || url.password || url.hash) {
    throw new Error("webhook URL must be http(s), without credentials or fragments");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (!hostname || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal")) {
    throw new Error("webhook destination must be publicly routable");
  }

  const literalFamily = isIP(hostname);
  const addresses = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookupWithTimeout(hostname);
  if (addresses.length === 0) throw new Error("webhook hostname did not resolve");

  // Egress policy (replaces the old NODE_ENV-gated escape hatch, which was
  // unusable in production by construction):
  //   FORGE_WEBHOOK_EGRESS=public          → only public addresses (default)
  //   FORGE_WEBHOOK_EGRESS=private-allow   → private ranges allowed too
  //   FORGE_WEBHOOK_EGRESS=allowlist        → only IPs inside FORGE_WEBHOOK_PRIVATE_CIDRS
  // The old FORGE_WEBHOOK_ALLOW_PRIVATE_TARGETS=1 keeps working (dev escape).
  const policy = webhookEgressPolicy();
  if (policy === "public" && addresses.some(({ address, family }) => !isPublicAddress(address, family))) {
    throw new Error("webhook destination must resolve only to public addresses");
  }
  if (policy === "allowlist" && addresses.some(({ address, family }) => !isAllowedCidr(address, family))) {
    throw new Error("webhook destination is outside the FORGE_WEBHOOK_PRIVATE_CIDRS allowlist");
  }
  const chosen = addresses[0]!;
  return { url, address: chosen.address, family: chosen.family as 4 | 6 };
}


type EgressPolicy = "public" | "private-allow" | "allowlist";

function webhookEgressPolicy(): EgressPolicy {
  const raw = (process.env.FORGE_WEBHOOK_EGRESS ?? "").trim().toLowerCase();
  if (raw === "private-allow" || raw === "allowlist") return raw;
  if (process.env.FORGE_WEBHOOK_ALLOW_PRIVATE_TARGETS === "1") return "private-allow";
  return "public";
}

let allowlist: BlockList | null = null;
let allowlistConfigured = false;

/** Parse FORGE_WEBHOOK_PRIVATE_CIDRS ("10.0.0.0/8,192.168.1.0/24") lazily once. */
function isAllowedCidr(address: string, family: number): boolean {
  if (!allowlistConfigured) {
    allowlistConfigured = true;
    allowlist = new BlockList();
    for (const part of (process.env.FORGE_WEBHOOK_PRIVATE_CIDRS ?? "").split(/[\s,]+/).filter(Boolean)) {
      const [net, bits] = part.split("/");
      if (!net || !bits || !/^\d+$/.test(bits)) continue; // skip malformed entries
      allowlist.addSubnet(net, Number(bits), isIP(net) === 6 ? "ipv6" : "ipv4");
    }
  }
  if (!allowlist) return false;
  const kind = family === 6 ? "ipv6" : "ipv4";
  return allowlist.check(address, kind);
}

async function lookupWithTimeout(hostname: string): Promise<Array<{ address: string; family: number }>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      lookup(hostname, { all: true, verbatim: true }),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("webhook DNS lookup timed out")), TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isPublicAddress(address: string, family: number): boolean {
  if (family === 4) return !privateNetworks.check(address, "ipv4");
  if (family !== 6 || !/^[23]/.test(address.toLowerCase())) return false;
  if (privateNetworks.check(address, "ipv6")) return false;
  // IPv4-mapped IPv6 can otherwise tunnel to a blocked IPv4 destination.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped) return isPublicAddress(mapped[1]!, 4);
  return true;
}

/** POST to a resolved IP so DNS rebinding cannot change the destination. */
function postWebhook(target: WebhookTarget, headers: Record<string, string>, body: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const { url, address, family } = target;
    const secure = url.protocol === "https:";
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    const hostHeader = url.port ? `${url.hostname}:${url.port}` : url.hostname;
    const req = (secure ? httpsRequest : httpRequest)({
      hostname: address,
      family,
      port: url.port ? Number(url.port) : secure ? 443 : 80,
      method: "POST",
      path: `${url.pathname}${url.search}`,
      headers: { ...headers, Host: hostHeader, "Content-Length": Buffer.byteLength(body) },
      ...(secure && !isIP(hostname) ? { servername: hostname } : {}),
    }, (res) => {
      let read = 0;
      res.on("data", (chunk: Buffer) => {
        read += chunk.length;
        if (read > MAX_RESPONSE_BYTES) req.destroy(new Error("webhook response exceeded size limit"));
      });
      res.on("end", () => resolve(res.statusCode ?? 0));
      res.on("error", reject);
    });
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error("webhook request timed out")));
    req.on("error", reject);
    req.end(body);
  });
}

/** Sign a payload body with a hook's secret (GitHub-style X-Forge-Signature). */
export function signPayload(secret: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

/** Constant-time signature verification (for tests / receivers). */

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
      const target = await resolveWebhookTarget(hook.url);
      responseStatus = await postWebhook(target, {
        "Content-Type": "application/json",
        "X-Forge-Event": event,
        "X-Forge-Signature": signature,
        "X-Forge-Delivery": String(delivery!.id),
        "User-Agent": "Forge-Webhook/1.0",
      }, body);
      status = responseStatus >= 200 && responseStatus < 300 ? "delivered" : "failed";
      if (status === "failed") error = `endpoint responded ${responseStatus}`;
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

/**
 * Retry a recorded delivery: re-sign the stored payload with the hook's
 * current secret and deliver it again through the same SSRF-hardened
 * pipeline. Records a NEW delivery row (the original stays as history).
 * Returns the new delivery id. Throws only for caller errors (unknown
 * delivery / hook); the delivery attempt itself is recorded, never thrown.
 */
export async function redeliverWebhook(deliveryId: number): Promise<number> {
  const deliveryRows = await db.select().from(webhookDeliveries).where(eq(webhookDeliveries.id, deliveryId)).limit(1);
  const delivery = deliveryRows[0];
  if (!delivery) throw new Error("delivery not found");
  const hookRows = await db.select().from(webhooks).where(eq(webhooks.id, delivery.webhookId)).limit(1);
  const hook = hookRows[0];
  if (!hook) throw new Error("webhook not found");
  if (!hook.active) throw new Error("webhook is inactive");

  const payload = delivery.payload as WebhookPayload;
  const event = payload.event ?? delivery.event;
  const body = JSON.stringify(payload);
  const signature = signPayload(hook.secret, body);
  const [row] = await db.insert(webhookDeliveries).values({
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
    const target = await resolveWebhookTarget(hook.url);
    responseStatus = await postWebhook(target, {
      "Content-Type": "application/json",
      "X-Forge-Event": event,
      "X-Forge-Signature": signature,
      "X-Forge-Delivery": String(row!.id),
      "User-Agent": "Forge-Webhook/1.0",
    }, body);
    status = responseStatus >= 200 && responseStatus < 300 ? "delivered" : "failed";
    if (status === "failed") error = `endpoint responded ${responseStatus}`;
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  await db.update(webhookDeliveries).set({
    status,
    responseStatus,
    durationMs: Date.now() - started,
    error,
  }).where(eq(webhookDeliveries.id, row!.id));
  return row!.id;
}
