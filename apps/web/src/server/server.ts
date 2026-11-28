// Forge custom server: Next.js UI + git smart HTTP + internal hooks + SSE.
// This is the single process story: `pnpm dev` boots web + git + workers together.

import { createServer, type Server } from "node:http";
import { timingSafeEqual } from "node:crypto";
import nextFactory from "next";

const dev = process.env.NODE_ENV !== "production";
const port = Number(process.env.FORGE_PORT ?? 3000);

// post-receive hooks must call back to THIS server (tests run on other ports).
process.env.FORGE_POST_RECEIVE_URL ??= `http://127.0.0.1:${port}/internal/hooks/post-receive`;

async function main() {
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

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
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

      // 4. Everything else → Next.js
      await nextHandler(req, res);
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

  const shutdown = async () => {
    console.log("[forge] shutting down…");
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

function safeTokenEqual(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
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

export function ssePublish(channel: string, event: string, data: unknown): void {
  const clients = sseClients.get(channel);
  if (!clients) return;
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    res.write(frame);
  }
}

/** SSE auth: session cookie required; channel subjects verify repo read access. */
async function authorizeSse(req: import("node:http").IncomingMessage, pathname: string): Promise<boolean> {
  const { userFromSessionToken, db, pullRequests, jobRuns, repositories, orgMembers } = await import("@forge/db");
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

  const channel = pathname.replace(/^\/api\/sse\//, "");

  // Resolve the channel subject to a repo, then apply the read policy.
  let repo: { orgId: number; visibility: string } | undefined;
  const prMatch = /^pr-(\d+)$/.exec(channel);
  const jobMatch = /^job-(\d+)$/.exec(channel);
  if (prMatch) {
    const rows = await db
      .select({ orgId: repositories.orgId, visibility: repositories.visibility })
      .from(pullRequests)
      .innerJoin(repositories, eq(repositories.id, pullRequests.repoId))
      .where(eq(pullRequests.id, Number(prMatch[1])))
      .limit(1);
    repo = rows[0];
  } else if (jobMatch) {
    const rows = await db
      .select({ orgId: repositories.orgId, visibility: repositories.visibility })
      .from(jobRuns)
      .innerJoin(repositories, eq(repositories.id, jobRuns.repoId))
      .where(eq(jobRuns.id, Number(jobMatch[1])))
      .limit(1);
    repo = rows[0];
  } else if (channel === "pr-activity") {
    // Fanout channel carrying only (runId, prId) ticks, not content; any
    // authenticated user may listen.
    return true;
  } else {
    return false;
  }
  if (!repo) return false;
  if (repo.visibility === "public") return true;
  const member = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, repo.orgId), eq(orgMembers.userId, user.id)))
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
  const set = sseClients.get(channel) ?? new Set();
  set.add(res);
  sseClients.set(channel, set);
  req.on("close", () => {
    set.delete(res);
    if (set.size === 0) sseClients.delete(channel);
  });
}

main().catch((err) => {
  console.error("[forge] fatal:", err);
  process.exit(1);
});
