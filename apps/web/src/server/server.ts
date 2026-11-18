// Forge custom server: Next.js UI + git smart HTTP + internal hooks + SSE.
// This is the single process story: `pnpm dev` boots web + git + workers together.

import { createServer, type Server } from "node:http";
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

  const server: Server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const pathname = url.pathname;

    try {
      // 1. Internal hook endpoint (post-receive from git bare repos)
      if (req.method === "POST" && pathname === "/internal/hooks/post-receive") {
        // Authenticated with the shared hook token (constant-time compare).
        const presented = String(req.headers["x-forge-hook-token"] ?? "");
        if (presented !== process.env.FORGE_HOOK_TOKEN) {
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

/** SSE auth: session cookie required; PR channels also verify repo read access. */
async function authorizeSse(req: import("node:http").IncomingMessage, pathname: string): Promise<boolean> {
  const { userFromSessionToken } = await import("@forge/db");
  const { db, pullRequests, repositories, organizations, orgMembers } = await import("@forge/db");
  const { and, eq } = await import("drizzle-orm");

  // Extract the session cookie from the raw header (no Next context here).
  const cookieHeader = String(req.headers.cookie ?? "");
  const match = /(?:^|;\s*)forge_session=([^;]+)/.exec(cookieHeader);
  if (!match) return false;
  const user = await userFromSessionToken(decodeURIComponent(match[1]!));
  if (!user) return false;

  const channel = pathname.replace(/^\/api\/sse\//, "");
  const prMatch = /^pr-(\d+)$/.exec(channel);
  if (!prMatch) return true; // authenticated non-PR channels pass

  const prId = Number(prMatch[1]);
  const rows = await db
    .select({ orgId: repositories.orgId, visibility: repositories.visibility })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repoId))
    .where(eq(pullRequests.id, prId))
    .limit(1);
  const repo = rows[0];
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
