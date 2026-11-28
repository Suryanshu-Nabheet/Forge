// Forge custom server: Next.js UI + git smart HTTP + internal hooks + SSE.
// This is the single process story: `pnpm dev` boots web + git + workers together.

import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createGzip, type Gzip } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import nextFactory from "next";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.FORGE_PORT ?? 3000);

// post-receive hooks must call back to THIS server (tests run on other ports).
process.env.FORGE_POST_RECEIVE_URL ??= `http://127.0.0.1:${port}/internal/hooks/post-receive`;

async function main() {
  // Fail fast on configurations that would break silently in production.
  const { validateEnv } = await import("@forge/db");
  const problems = await validateEnv(process.env.NODE_ENV === "production");
  for (const w of problems.warnings) console.warn(`[forge] env warning: ${w}`);
  if (problems.fatal.length > 0) {
    for (const f of problems.fatal) console.error(`[forge] FATAL: ${f}`);
    process.exit(1);
  }

  // Apply pending migrations before anything reads the schema.
  const { runMigrations } = await import("@forge/db");
  await runMigrations();

  // Boot Next.js
  const nextApp = nextFactory({ dev, dir: process.cwd() });
  await nextApp.prepare();
  const nextHandler = nextApp.getRequestHandler();

  const { handleGitRequest } = await import("./git-transport");
  const { handlePostReceive } = await import("@forge/jobs");
  const { startWorker } = await import("@forge/jobs");
  const { hookToken } = await import("@forge/git");
  // Shared secret for hook callbacks: set before repos/handlers read it.
  process.env.FORGE_HOOK_TOKEN ??= hookToken();

  // Repair pass: existing bare repos may predate the current hook
  // scripts (e.g. pre-token post-receive hooks → their callbacks get
  // 403'd and pushes silently lose DB sync). Reinstall hooks for every
  // repo row at boot; also ensure the protection config exists.
  void (async () => {
    try {
      const { db, repositories, organizations } = await import("@forge/db");
      const { installHooks, repoGitDir, setProtectedBranches } = await import("@forge/git");
      const { and, eq } = await import("drizzle-orm");
      const rows = await db
        .select({ orgSlug: organizations.slug, name: repositories.name, protectedBranches: repositories.protectedBranches })
        .from(repositories)
        .innerJoin(organizations, eq(organizations.id, repositories.orgId));
      for (const r of rows) {
        try {
          const gitDir = repoGitDir(r.orgSlug, r.name);
          await installHooks(gitDir);
          await setProtectedBranches(gitDir, r.protectedBranches ?? ["main"]);
        } catch (err) {
          console.error(`[forge] hook repair failed for ${r.orgSlug}/${r.name}:`, err);
        }
      }
      if (rows.length > 0) console.log(`[forge] hook repair pass complete for ${rows.length} repos`);
    } catch (err) {
      console.error("[forge] hook repair pass failed:", err);
    }
  })();

  let draining = false;

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      // 0. Health probes (no auth, no body): /healthz answers when the
      // process is up (503 while draining so LBs stop routing); /healthz/ready
      // additionally checks the database.
      if (req.method === "GET" && pathname === "/healthz") {
        if (draining) {
          res.writeHead(503, { "Content-Type": "text/plain", "Retry-After": "30" });
          res.end("draining");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end("ok");
        return;
      }
      if (req.method === "GET" && pathname === "/healthz/ready") {
        try {
          const { db } = await import("@forge/db");
          const { sql } = await import("drizzle-orm");
          await db.execute(sql`SELECT 1`);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, db: true, pid: process.pid }));
        } catch (err) {
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, db: false, error: err instanceof Error ? err.message : "db check failed" }));
        }
        return;
      }

      // 1. Internal hook endpoint (post-receive from git bare repos)
      if (req.method === "POST" && pathname === "/internal/hooks/post-receive") {
        // Authenticated with the shared hook token (constant-time compare).
        const presented = String(req.headers["x-forge-hook-token"] ?? "");
        if (!safeTokenEqual(presented, process.env.FORGE_HOOK_TOKEN ?? "")) {
          res.writeHead(403, { "Content-Type": "text/plain" });
          res.end("invalid hook token");
          return;
        }
        const body = await readBody(req);
        const result = await handlePostReceive(JSON.parse(body));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(result));
        return;
      }

      // 2. Git smart HTTP transport
      if (pathname.startsWith("/git/")) {
        const handled = await handleGitRequest(req, res);
        if (handled) return;
      }

      // 3. SSE stream for job logs / PR page live updates (auth required)
      if (pathname.startsWith("/api/sse/")) {
        const allowed = await authorizeSse(req, pathname);
        if (!allowed) {
          res.writeHead(401, { "Content-Type": "text/plain" });
          res.end("authentication required");
          return;
        }
        await handleSse(req, res, pathname);
        return;
      }

      // 4. Everything else → Next.js, gzipped for compressible types.
      await nextHandler(req, withGzip(req, res));
    } catch (err) {
      console.error("[server] request error:", err);
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "text/plain" });
      }
      res.end("internal server error");
    }
  });

  // Internal token for hooks (curl from hooks is localhost-only by default)
  server.listen(port, async () => {
    console.log(`[forge] web + git + hooks listening on http://localhost:${port}`);
    // SSH transport (git@ style clone/push) — optional, separate port.
    try {
      const { startSshServer } = await import("./ssh-server");
      startSshServer();
    } catch (err) {
      console.error("[forge] ssh transport failed to start:", err);
    }
    await startWorker(ssePublish);
  });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    draining = true;
    console.log(`[forge] ${signal} received — draining…`);
    server.close();
    // Stop accepting new connections, then let in-flight jobs finish
    // (bounded); anything still running is requeued by the reaper later.
    try {
      const { stopWorker } = await import("@forge/jobs");
      await stopWorker(20_000);
    } catch { /* worker not started */ }
    process.exit(0);
  };
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

function safeTokenEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

/**
 * Transparent gzip for Next.js-served responses. Installs a compression
 * stream by intercepting writeHead/write/end before the handler runs:
 * compressible content types get Content-Encoding: gzip and the original
 * Content-Length dropped (compressed size differs). SSE, git protocol,
 * health, and hook paths never pass through here.
 */
function withGzip(req: IncomingMessage, res: ServerResponse): ServerResponse {
  const accepts = /\bgzip\b/.test(String(req.headers["accept-encoding"] ?? ""));
  if (!accepts) return res;

  const rawWriteHead = res.writeHead.bind(res);
  const rawWrite = res.write.bind(res);
  const rawEnd = res.end.bind(res);
  let gz: Gzip | null = null;

  res.writeHead = ((status: number, headers?: Record<string, unknown> | ServerResponse) => {
    const merged = typeof headers === "object" && headers !== null
      ? { ...headers as Record<string, unknown> }
      : {};
    const type = String(merged["Content-Type"] ?? merged["content-type"] ?? "");
    const alreadyEncoded = "Content-Encoding" in merged || "content-encoding" in merged;
    if (/^(text\/|application\/(json|javascript|xml)|image\/svg)/.test(type) && !alreadyEncoded) {
      gz = createGzip({ level: 6 });
      gz.on("data", (chunk) => rawWrite(chunk));
      gz.on("end", () => rawEnd());
      delete merged["Content-Length"];
      delete merged["content-length"];
      merged["Content-Encoding"] = "gzip";
      merged["Vary"] = [merged["Vary"], "Accept-Encoding"].filter(Boolean).join(", ");
    }
    return rawWriteHead(status, merged as never);
  }) as typeof res.writeHead;

  res.write = ((chunk: never) => (gz ? gz.write(chunk) : rawWrite(chunk))) as typeof res.write;
  res.end = ((chunk?: never) => {
    if (gz) {
      if (chunk) gz.write(chunk);
      gz.end();
      return res;
    }
    return rawEnd(chunk);
  }) as typeof res.end;

  return res;
}

function readBody(req: import("node:http").IncomingMessage, limit = 10 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > limit) {
        reject(new Error("body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

// ---- SSE plumbing: channels keyed by subject (e.g. /api/sse/pr-12) ----
const sseClients = new Map<string, Set<import("node:http").ServerResponse>>();

// ---------- Redis pub/sub fanout (multi-replica) ----------
// With REDIS_URL set, publishes also go to a Redis channel and every
// replica's subscriber bridges them into its local SSE clients — so live
// logs stream no matter which replica runs the job worker. Without
// Redis, publishing stays local (single-process topology).

interface PubSubLike {
  publish(channel: string, message: string): Promise<number>;
  duplicate(): PubSubLike & { subscribe(channel: string): Promise<unknown>; on(event: string, cb: (msg: unknown) => void): unknown };
}

let pubPublisher: PubSubLike | null = null;
let pubInit: Promise<PubSubLike | null> | null = null;

const SSE_CHANNEL = "forge:sse";

async function getSsePublisher(): Promise<PubSubLike | null> {
  if (pubPublisher) return pubPublisher;
  if (!pubInit) {
    pubInit = (async () => {
      if (!process.env.REDIS_URL) return null;
      try {
        const mod = await import("ioredis");
        const pub = new mod.default(process.env.REDIS_URL, {
          maxRetriesPerRequest: 1,
          connectTimeout: 2000,
          lazyConnect: false,
        });
        pub.on("error", (err) => console.error("[sse] redis publisher error:", err.message));
        await pub.connect().catch(() => null);
        // Subscriber: a dedicated connection (Redis requires one per mode).
        const sub = pub.duplicate();
        sub.on("error", (err) => console.error("[sse] redis subscriber error:", err.message));
        await sub.connect().catch(() => null);
        await sub.subscribe(SSE_CHANNEL).catch(() => null);
        sub.on("message", (_channel: string, message: string) => {
          try {
            const parsed = JSON.parse(message) as { channel: string; event: string; data: unknown };
            deliverLocal(parsed.channel, parsed.event, parsed.data);
          } catch { /* malformed frame from a peer — ignore */ }
        });
        console.log("[sse] redis fanout enabled");
        return pub as unknown as PubSubLike;
      } catch {
        return null;
      }
    })();
  }
  pubPublisher = await pubInit;
  return pubPublisher;
}

/** Deliver a frame to this process's local subscribers only. */
function deliverLocal(channel: string, event: string, data: unknown): void {
  const clients = sseClients.get(channel);
  if (!clients) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}

export function ssePublish(channel: string, event: string, data: unknown): void {
  deliverLocal(channel, event, data);
  // Fire-and-forget fanout; Redis-less or failed publishes are fine.
  void getSsePublisher().then((pub) => {
    if (!pub) return;
    const message = JSON.stringify({ channel, event, data });
    void pub.publish(SSE_CHANNEL, message).catch(() => {});
  });
}

/** SSE auth: session cookie required; channel subjects verify repo read access. */
async function authorizeSse(req: import("node:http").IncomingMessage, pathname: string): Promise<boolean> {
  const { userFromSessionToken, db, pullRequests, jobRuns, repositories, organizations, orgMembers } = await import("@forge/db");
  const { and, eq } = await import("drizzle-orm");

  // Extract the session cookie from the raw header (no Next context here).
  const cookieHeader = String(req.headers.cookie ?? "");
  const match = /(?:^|;\s*)forge_session=([^;]+)/.exec(cookieHeader);
  if (!match) return false;
  let token: string;
  try {
    token = decodeURIComponent(match[1]!);
  } catch {
    return false;
  }
  const user = await userFromSessionToken(token);
  if (!user) return false;

  // Channel forms:
  //   <org>/<repo>/pr-<number>   PR live logs (repo-scoped, by display number)
  //   pr-<id>                    legacy PR channel (DB id) — still authorized
  //   job-<runId>                job-run logs
  //   pr-activity                contentless fanout ticks
  const rest = pathname.replace(/^\/api\/sse\//, "");

  const scoped = /^([^\/]+)\/([^/]+)\/pr-(\d+)$/.exec(rest);
  if (scoped) {
    const [, orgSlug, repoName, numStr] = scoped;
    const rows = await db
      .select({ orgId: repositories.orgId, ownerId: organizations.ownerId, visibility: repositories.visibility })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repoId))
      .innerJoin(organizations, eq(organizations.id, repositories.orgId))
      .where(and(
        eq(organizations.slug, orgSlug!),
        eq(repositories.name, repoName!),
        eq(pullRequests.number, Number(numStr)),
      ))
      .limit(1);
    return await authorizeSseRepo(rows[0], user.id, db, orgMembers, and, eq);
  }

  const legacyPr = /^pr-(\d+)$/.exec(rest);
  if (legacyPr) {
    const rows = await db
      .select({ orgId: repositories.orgId, ownerId: organizations.ownerId, visibility: repositories.visibility })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repoId))
      .innerJoin(organizations, eq(organizations.id, repositories.orgId))
      .where(eq(pullRequests.id, Number(legacyPr[1])))
      .limit(1);
    return await authorizeSseRepo(rows[0], user.id, db, orgMembers, and, eq);
  }

  const jobMatch = /^job-(\d+)$/.exec(rest);
  if (jobMatch) {
    const rows = await db
      .select({ orgId: repositories.orgId, ownerId: organizations.ownerId, visibility: repositories.visibility })
      .from(jobRuns)
      .innerJoin(repositories, eq(repositories.id, jobRuns.repoId))
      .innerJoin(organizations, eq(organizations.id, repositories.orgId))
      .where(eq(jobRuns.id, Number(jobMatch[1])))
      .limit(1);
    return await authorizeSseRepo(rows[0], user.id, db, orgMembers, and, eq);
  }

  if (rest === "pr-activity") {
    // Fanout channel carrying only (runId, prId) ticks, not content; any
    // authenticated user may listen.
    return true;
  }
  return false;
}

async function authorizeSseRepo(
  repo: { orgId: number; ownerId: number; visibility: string } | undefined,
  userId: number,
  db: typeof import("@forge/db").db,
  orgMembers: typeof import("@forge/db").orgMembers,
  and: typeof import("drizzle-orm").and,
  eq: typeof import("drizzle-orm").eq,
): Promise<boolean> {
  if (!repo) return false;
  if (repo.visibility === "public") return true;
  // Same predicate as roleInOrg: org owner or org_members row.
  if (repo.ownerId === userId) return true;
  const member = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, repo.orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  return member.length > 0;
}

async function handleSse(req: import("node:http").IncomingMessage, res: import("node:http").ServerResponse, pathname: string) {
  const channel = pathname.replace(/^\/api\/sse\//, "");
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.write(": connected\n\n");
  // Heartbeat keeps proxies with idle read timeouts (nginx default 60s)
  // from closing the stream during quiet builds.
  const heartbeat = setInterval(() => {
    res.write(": ping\n\n");
  }, 15_000);
  const set = sseClients.get(channel) ?? new Set();
  set.add(res);
  sseClients.set(channel, set);
  req.on("close", () => {
    clearInterval(heartbeat);
    set.delete(res);
    if (set.size === 0) sseClients.delete(channel);
  });
}

main().catch((err) => {
  console.error("[forge] fatal:", err);
  process.exit(1);
});
