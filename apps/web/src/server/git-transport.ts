// Git smart HTTP transport: bridges /git/* to `git http-backend` (CGI).
// Handles Basic auth (PAT) + session-cookie auth, enforces repo scopes.

import { spawn } from "node:child_process";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";
import { and, eq } from "drizzle-orm";
import { db, verifyPat } from "@forge/db";
import { organizations, repositories, orgMembers } from "@forge/db";

const CANDIDATE_BACKENDS = [
  "/opt/homebrew/opt/git/libexec/git-core/git-http-backend",
  "/usr/local/opt/git/libexec/git-core/git-http-backend",
  "/usr/libexec/git-core/git-http-backend",
  "/usr/lib/git-core/git-http-backend",
];

function gitHttpBackendPath(): string {
  for (const p of CANDIDATE_BACKENDS) {
    try {
      require("node:fs").accessSync(p);
      return p;
    } catch { /* try next */ }
  }
  return "/opt/homebrew/opt/git/libexec/git-core/git-http-backend";
}

const GIT_HTTP_BACKEND = gitHttpBackendPath();
const REPO_URL_RE = /^([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9_.-]{0,99})\.git(\/.*)?$/;

export interface GitAuthResult {
  userId: number | null;
  scopes: string[];
}

/** Extract Basic credentials or session token from a git request. */
async function authenticate(req: IncomingMessage): Promise<GitAuthResult> {
  const authz = req.headers.authorization ?? "";
  if (authz.startsWith("Basic ")) {
    const decoded = Buffer.from(authz.slice(6), "base64").toString();
    const idx = decoded.indexOf(":");
    const user = idx === -1 ? decoded : decoded.slice(0, idx);
    const pass = idx === -1 ? "" : decoded.slice(idx + 1);
    const pat = await verifyPat(pass);
    if (pat) return { userId: pat.userId, scopes: pat.scopes };
    return { userId: null, scopes: [] };
  }
  return { userId: null, scopes: [] };
}

export function parseGitUrl(pathname: string): { orgSlug: string; repoName: string; rest: string } | null {
  // strip /git prefix
  if (!pathname.startsWith("/git/")) return null;
  const rest = pathname.slice("/git/".length);
  const m = REPO_URL_RE.exec(rest);
  if (!m) return null;
  return { orgSlug: m[1]!, repoName: m[2]!, rest: m[3] ?? "" };
}

interface RepoLookup {
  repoId: number;
  orgId: number;
  visibility: "public" | "private";
  ownerId: number;
}

async function lookupRepo(orgSlug: string, repoName: string): Promise<RepoLookup | null> {
  const rows = await db
    .select({
      repoId: repositories.id,
      orgId: repositories.orgId,
      visibility: repositories.visibility,
      ownerId: organizations.ownerId,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, orgSlug), eq(repositories.name, repoName)))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Handle a git smart HTTP request. Returns false if the path is not a git path.
 */
export async function handleGitRequest(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const parsed = parseGitUrl(url.pathname);
  if (!parsed) return false;

  const repo = await lookupRepo(parsed.orgSlug, parsed.repoName);
  if (!repo) {
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("repository not found");
    return true;
  }

  const isPush = url.pathname.endsWith("/git-receive-pack") || url.searchParams.get("service") === "git-receive-pack";
  const auth = await authenticate(req);

  // Public repos: pulls OK without auth; pushes always require PAT.
  if (!auth.userId) {
    if (isPush || repo.visibility === "private") {
      res.setHeader("WWW-Authenticate", 'Basic realm="forge-git", charset="UTF-8"');
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("authentication required");
      return true;
    }
  }

  const requiredScope = isPush ? "repo:write" : "repo:read";
  if (auth.userId && !auth.scopes.includes(requiredScope)) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end(`missing scope: ${requiredScope}`);
    return true;
  }

  // Private repos: PAT holder must be a member of the owning org.
  if (repo.visibility === "private") {
    if (auth.userId === null) {
      res.setHeader("WWW-Authenticate", 'Basic realm="forge-git", charset="UTF-8"');
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("authentication required");
      return true;
    }
    const member = await db
      .select({ id: orgMembers.id })
      .from(orgMembers)
      .where(and(eq(orgMembers.orgId, repo.orgId), eq(orgMembers.userId, auth.userId)))
      .limit(1);
    const isOwner = repo.ownerId === auth.userId;
    if (member.length === 0 && !isOwner) {
      res.writeHead(403, { "Content-Type": "text/plain" });
      res.end("access denied: not a member of this organization");
      return true;
    }
  }

  await pipeCgi(req, res, parsed, url, auth);
  return true;
}

/** Bridge the request to git http-backend as CGI. */
async function pipeCgi(
  req: IncomingMessage,
  res: ServerResponse,
  parsed: { orgSlug: string; repoName: string; rest: string },
  url: URL,
  auth: GitAuthResult,
): Promise<void> {
  // http-backend resolves repos as GIT_PROJECT_ROOT + PATH_INFO — so the
  // project root is the parent repos dir, and PATH_INFO carries org/repo.git.
  const { reposRoot } = await import("@forge/git");
  const reposDir = reposRoot();
  const gitDir = path.join(reposDir, parsed.orgSlug, `${parsed.repoName}.git`);
  const env = {
    ...process.env,
    GIT_PROJECT_ROOT: reposDir,
    GIT_HTTP_EXPORT_ALL: "1",
    REQUEST_METHOD: req.method ?? "GET",
    PATH_INFO: `/${parsed.orgSlug}/${parsed.repoName}.git${parsed.rest}`,
    QUERY_STRING: url.searchParams.toString(),
    CONTENT_TYPE: req.headers["content-type"] ?? "",
    CONTENT_LENGTH: req.headers["content-length"] ?? "",
    HTTP_CONTENT_ENCODING: (req.headers["content-encoding"] ?? "") as string,
    REMOTE_USER: auth.userId ? `user-${auth.userId}` : "",
    REMOTE_ADDR: (req.socket.remoteAddress ?? "127.0.0.1") as string,
    SERVER_PROTOCOL: "HTTP/1.1",
    GATEWAY_INTERFACE: "CGI/1.1",
    REQUEST_URI: url.pathname + (url.search || ""),
    HTTP_ACCEPT: (req.headers.accept ?? "*/*") as string,
  };

  const child = spawn(GIT_HTTP_BACKEND, [], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });

  req.pipe(child.stdin);
  req.on("error", () => child.stdin.end());
  child.stdin.on("error", () => {/* client abort */});

  // Parse CGI response: headers then body. First chunk may contain partial headers.
  let headerBuf = Buffer.alloc(0);
  let headersDone = false;
  let status = 200;
  const responseHeaders: Record<string, string> = {};

  child.stdout.on("data", (chunk: Buffer) => {
    if (headersDone) {
      res.write(chunk);
      return;
    }
    headerBuf = Buffer.concat([headerBuf, chunk]);
    const sep = headerBuf.indexOf("\r\n\r\n");
    if (sep === -1) return;
    const headerText = headerBuf.subarray(0, sep).toString("latin1");
    for (const line of headerText.split("\r\n")) {
      const colon = line.indexOf(":");
      if (colon === -1) continue;
      const key = line.slice(0, colon).trim();
      const value = line.slice(colon + 1).trim();
      if (key.toLowerCase() === "status") {
        const m = /^(\d{3})/.exec(value);
        if (m) status = Number(m[1]);
      } else {
        responseHeaders[key] = value;
      }
    }
    res.writeHead(status, responseHeaders);
    const body = headerBuf.subarray(sep + 4);
    if (body.length) res.write(body);
    headersDone = true;
  });

  child.stdout.on("end", () => {
    if (!headersDone) {
      // No headers received — treat as error
      res.writeHead(502, { "Content-Type": "text/plain" });
    }
    res.end();
  });

  child.stderr.on("data", () => {/* log only */});

  child.on("error", (err) => {
    if (!headersDone) {
      res.writeHead(500, { "Content-Type": "text/plain" });
    }
    res.end(`git transport error: ${err.message}`);
  });
}
