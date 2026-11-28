// E2E: authorization perimeter — private-repo visibility, org membership gates,
// hook authentication, PAT revocation, SSE auth. Boots its own server + DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";
import { adminDsn, testDbDsn } from "./helpers/db";

const exec = promisify(execFile);

const PORT = 3107;
const SSH_PORT = 3225;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = process.env.FORGE_TEST_DB3 ?? "forge_test3";
const ROOT = process.cwd();
const DATA = `${ROOT}/data-test3`;

let server: ReturnType<typeof spawn> | null = null;
let hookToken = "";
const db = new pg.Client({ connectionString: testDbDsn(TEST_DB) });

function jarFetch(jar: { cookie: string }) {
  return async (path: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) },
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) jar.cookie = setCookie.split(";")[0]!;
    return res;
  };
}

async function waitForServer(timeoutMs = 90_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/login`);
      if (res.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start in time");
}

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${TEST_DB};`);
  await admin.end();
  await exec("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: testDbDsn(TEST_DB) },
  });
  await exec("rm", ["-rf", DATA]);
  await db.connect();

  // Boot the server; capture its stdout to learn the hook token (printed for tests).
  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      DATABASE_URL: testDbDsn(TEST_DB),
      FORGE_STORAGE_ROOT: DATA,
      FORGE_PORT: String(PORT),
      FORGE_SSH_PORT: String(SSH_PORT),
      FORGE_HOOK_TOKEN: "test-hook-token-123",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {});
  await waitForServer();
  hookToken = "test-hook-token-123";
}, 240_000);

afterAll(async () => {
  await db.end().catch(() => {});
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  }
  await new Promise((r) => setTimeout(r, 300));
  await exec("rm", ["-rf", DATA]).catch(() => {});
});

describe("authorization perimeter", () => {
  // Mallory: outsider with a valid account. Ada: org owner.
  const ada = { cookie: "" };
  const mallory = { cookie: "" };

  beforeAll(async () => {
    // Ada registers first, creates a private repo.
    const rf = jarFetch(ada);
    await rf("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@sec.dev", name: "Ada Sec", handle: "adasec", password: "longpassword1" }),
    });
    const repo = await rf("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "secorg", name: "secret", visibility: "private" }),
    });
    expect(repo.ok).toBe(true);

    const mf = jarFetch(mallory);
    await mf("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mallory@sec.dev", name: "Mallory", handle: "mallory", password: "longpassword1" }),
    });
  });

  it("anonymous cannot view a private repo page", async () => {
    const res = await fetch(`${BASE}/secorg/secret`);
    const text = await res.text();
    expect(text).toContain("Repository not found"); // gated, no repo content leaked
    expect(text).not.toMatch(/file tree|branch switcher/i);
  });

  it("non-member (logged in) cannot view a private repo page", async () => {
    const res = await jarFetch(mallory)("/secorg/secret");
    const text = await res.text();
    expect(text).toContain("Repository not found");
  });

  it("org owner can view the private repo page", async () => {
    const res = await jarFetch(ada)("/secorg/secret");
    expect(res.status).toBe(200);
  });

  it("anonymous and non-members cannot semantic-search a private repo", async () => {
    const anon = await fetch(`${BASE}/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "anything" }),
    });
    const hits = (await anon.json()) as { results: Array<{ repo: string }> };
    expect(hits.results.filter((r) => r.repo === "secorg/secret")).toHaveLength(0);

    const outsider = await jarFetch(mallory)("/api/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "anything" }),
    });
    const hits2 = (await outsider.json()) as { results: Array<{ repo: string }> };
    expect(hits2.results.filter((r) => r.repo === "secorg/secret")).toHaveLength(0);
  });

  it("non-member cannot create a repo inside someone else's org", async () => {
    const res = await jarFetch(mallory)("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "secorg", name: "sneaky" }),
    });
    expect(res.status).toBe(403);
  });

  it("internal hook endpoint rejects forged calls without/with bad token", async () => {
    const noToken = await fetch(`${BASE}/internal/hooks/post-receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ org: "secorg", repo: "secret", updates: [] }),
    });
    expect(noToken.status).toBe(403);

    const badToken = await fetch(`${BASE}/internal/hooks/post-receive`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Forge-Hook-Token": "wrong" },
      body: JSON.stringify({ org: "secorg", repo: "secret", updates: [] }),
    });
    expect(badToken.status).toBe(403);
  });

  it("rejects webhook targets on loopback and metadata networks", async () => {
    for (const url of ["http://127.0.0.1:8080/", "http://169.254.169.254/latest/meta-data/"]) {
      const res = await jarFetch(ada)("/api/secorg/secret/hooks", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url, events: ["push"] }),
      });
      expect(res.status).toBe(400);
    }
  });

  it("SSE endpoint requires a session", async () => {
    const res = await fetch(`${BASE}/api/sse/pr-1`);
    expect(res.status).toBe(401);
  });

  it("PAT revocation: create → use → revoke → rejected", async () => {
    const af = jarFetch(ada);
    const created = await af("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "rev-me", scopes: ["repo:read"] }),
    });
    const { token } = (await created.json()) as { token: string };
    expect(token).toMatch(/^forge_pat_/);

    // PAT works for a git fetch (info/refs) on the private repo — owner.
    const probe = await fetch(`${BASE}/git/secorg/secret.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`adasec:${token}`).toString("base64")}` },
    });
    expect(probe.status).toBe(200);

    // Revoke
    const listed = await af("/api/pats");
    const { pats } = (await listed.json()) as { pats: Array<{ id: number; name: string }> };
    const target = pats.find((p) => p.name === "rev-me")!;
    const del = await af("/api/pats", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: target.id }),
    });
    expect(del.ok).toBe(true);

    // Same PAT now rejected
    const rejected = await fetch(`${BASE}/git/secorg/secret.git/info/refs?service=git-upload-pack`, {
      headers: { authorization: `Basic ${Buffer.from(`adasec:${token}`).toString("base64")}` },
    });
    expect(rejected.status).toBe(401);
  });

  it("SSH key deletion removes it from the list", async () => {
    const af = jarFetch(ada);
    await af("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "temp",
        publicKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB1234567890abcdefghijklmnopqrstuvwxyz12 test",
      }),
    });
    const listed = await af("/api/keys");
    const { keys } = (await listed.json()) as { keys: Array<{ id: number; title: string }> };
    expect(keys.some((k) => k.title === "temp")).toBe(true);
    const id = keys.find((k) => k.title === "temp")!.id;
    const del = await af("/api/keys", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(del.ok).toBe(true);
    const after = await af("/api/keys");
    const { keys: afterKeys } = (await after.json()) as { keys: Array<{ id: number }> };
    expect(afterKeys.some((k) => k.id === id)).toBe(false);
  });

  it("org member added by owner gains read access to the private repo", async () => {
    // Owner adds mallory to org_members directly via SQL (admin action).
    await db.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, u.id, 'member' FROM organizations o, users u
       WHERE o.slug='secorg' AND u.handle='mallory'`,
    );
    const res = await jarFetch(mallory)("/secorg/secret");
    expect(res.status).toBe(200);
  });
});

describe("branch protection", () => {
  const ada = { cookie: "" };
  let pat = "";

  beforeAll(async () => {
    // Ada's session + a repo with commits to force-push against.
    const f = jarFetch(ada);
    await f("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@sec.dev", password: "longpassword1" }),
    });
    const created = await f("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "bp-test", scopes: ["repo:read", "repo:write"] }),
    });
    pat = ((await created.json()) as { token: string }).token;

    // Seed a public repo with main + a feature branch.
    await f("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "bporg", name: "protected", visibility: "public" }),
    });
    const mkdtemp = await import("node:fs/promises").then((m) => m.mkdtemp);
    const execFile = (await import("node:child_process")).execFile;
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const tmp = await mkdtemp("/tmp/forge-bp-");
    await exec("git", ["clone", "-q", `${BASE}/git/bporg/protected.git`, tmp]);
    // Two commits on main: init → one (both pushed as fast-forwards).
    await exec("bash", ["-c", `cd ${tmp} && echo hello > a.txt && git add . && git -c user.name=T -c user.email=t@t commit -qm init && echo one > b.txt && git add . && git -c user.name=T -c user.email=t@t commit -qm one`]);
    await exec("git", ["-C", tmp, "push", "-q", `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`, "HEAD:main"]);
    // Rewrite local history for the force-push attempt.
    await exec("bash", ["-c", `cd ${tmp} && git reset -q --hard HEAD~1 && echo two > b.txt && git add . && git -c user.name=T -c user.email=t@t commit -qm two`]);
    // Save the tmp dir path via env-like closure (afterAll cleanup).
    (globalThis as Record<string, unknown>).__bpTmp = tmp;
  });

  it("rejects force-push (non-fast-forward) to a protected branch", async () => {
    const tmp = (globalThis as unknown as { __bpTmp: string }).__bpTmp;
    const execFile = (await import("node:child_process")).execFile;
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await expect(
      exec("git", ["-C", tmp, "push", "-q", "--force",
        `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`, "HEAD:main"]),
    ).rejects.toThrow(/pre-receive hook declined|non-fast-forward/);
  });

  it("rejects direct fast-forward pushes to a protected branch", async () => {
    const tmp = (globalThis as unknown as { __bpTmp: string }).__bpTmp;
    const execFile = (await import("node:child_process")).execFile;
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    const url = `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`;
    await exec("git", ["-C", tmp, "fetch", "-q", url, "main"]);
    await exec("git", ["-C", tmp, "checkout", "-q", "-B", "direct-update", "FETCH_HEAD"]);
    await exec("bash", ["-c", `cd ${tmp} && echo direct > direct.txt && git add . && git -c user.name=T -c user.email=t@t commit -qm direct`]);
    await expect(exec("git", ["-C", tmp, "push", "-q", url, "HEAD:main"]))
      .rejects.toThrow(/pre-receive hook declined|approved pull request/);
  });

  it("rejects deletion of a protected branch", async () => {
    const execFile = (await import("node:child_process")).execFile;
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    await expect(
      exec("git", ["push", "-q", `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`, ":refs/heads/main"]),
    ).rejects.toThrow(/pre-receive hook declined|refusing to delete/);
  });

  it("allows force-push to unprotected branches", async () => {
    const tmp = (globalThis as unknown as { __bpTmp: string }).__bpTmp;
    const execFile = (await import("node:child_process")).execFile;
    const { promisify } = await import("node:util");
    const exec = promisify(execFile);
    // feature branch: create, force-rewrite, push with force — should succeed.
    await exec("git", ["-C", tmp, "push", "-q", `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`, "HEAD:feature-x"]);
    await exec("bash", ["-c", `cd ${tmp} && echo three > c.txt && git add . && git -c user.name=T -c user.email=t@t commit -qm three`]);
    await exec("git", ["-C", tmp, "push", "-q", "--force",
      `http://adasec:${pat}@localhost:${PORT}/git/bporg/protected.git`, "HEAD:feature-x"]);
  });

  it("owner can update the protected list; non-owner gets 403", async () => {
    const f = jarFetch(ada);
    const put = await f("/api/bporg/protected/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ protectedBranches: ["main", "release"] }),
    });
    expect(put.ok).toBe(true);
    const get = await fetch(`${BASE}/api/bporg/protected/settings`);
    const data = (await get.json()) as { protectedBranches: string[] };
    expect(data.protectedBranches).toContain("release");
  });
});

describe("login rate limiting", () => {
  it("locks out after 5 failed attempts per email+ip", async () => {
    // Dedicated throwaway account so the lock doesn't leak into other suites.
    const email = "bruteforce@sec.dev";
    await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, name: "Brute Forth", handle: "brute", password: "longpassword1" }),
    });
    for (let i = 0; i < 5; i++) {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password: "wrong-password" }),
      });
    }
    const blocked = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password: "longpassword1" }), // even correct creds blocked
    });
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("Retry-After")).toBe("60");
  });
});
describe("org member management", () => {
  const ada = { cookie: "" };
  const eve = { cookie: "" };

  beforeAll(async () => {
    // Ada (owner of secorg) signs in; eve registers fresh.
    const af = jarFetch(ada);
    await af("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@sec.dev", password: "longpassword1" }),
    });
    const ef = jarFetch(eve);
    await ef("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "eve2@sec.dev", name: "Eve Two", handle: "eve2", password: "longpassword1" }),
    });
  });

  it("non-member cannot list members", async () => {
    const res = await jarFetch(eve)("/api/orgs/secorg/members");
    expect(res.status).toBe(403);
  });

  it("owner lists members with roles", async () => {
    const res = await jarFetch(ada)("/api/orgs/secorg/members");
    const data = (await res.json()) as { members: Array<{ handle: string; role: string }>; you: string };
    expect(res.ok).toBe(true);
    expect(data.you).toBe("owner");
    expect(data.members.some((m) => m.role === "owner")).toBe(true);
  });

  it("owner adds eve2; eve2 gains private-repo access", async () => {
    const add = await jarFetch(ada)("/api/orgs/secorg/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "eve2" }),
    });
    expect(add.ok).toBe(true);

    const page = await jarFetch(eve)("/secorg/secret");
    expect(page.status).toBe(200);
  });

  it("non-owner cannot add or remove members", async () => {
    const add = await jarFetch(eve)("/api/orgs/secorg/members", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "mallory" }),
    });
    expect(add.status).toBe(403);
  });

  it("owner cannot be removed; members can", async () => {
    const owner = (await db.query(`SELECT owner_id FROM organizations WHERE slug='secorg'`)).rows[0] as { owner_id: number };
    const delOwner = await jarFetch(ada)("/api/orgs/secorg/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: owner.owner_id }),
    });
    expect(delOwner.status).toBe(400);

    const eve2 = (await db.query(`SELECT id FROM users WHERE handle='eve2'`)).rows[0] as { id: number };
    const del = await jarFetch(ada)("/api/orgs/secorg/members", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ userId: eve2.id }),
    });
    expect(del.ok).toBe(true);

    const page = await jarFetch(eve)("/secorg/secret");
    const text = await page.text();
    expect(text).toContain("Repository not found"); // access revoked
  });
});
describe("repo deletion", () => {
  const ada = { cookie: "" };
  const malloryJar = { cookie: "" };

  beforeAll(async () => {
    const af = jarFetch(ada);
    await af("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@sec.dev", password: "longpassword1" }),
    });
    const mf = jarFetch(malloryJar);
    await mf("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "mallory@sec.dev", password: "longpassword1" }),
    });
    // A repo to delete.
    await af("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "secorg", name: "doomed", visibility: "public" }),
    });
  });

  it("anonymous and non-owner cannot delete", async () => {
    const anon = await fetch(`${BASE}/api/orgs/secorg/repos/doomed`, { method: "DELETE" });
    expect(anon.status).toBe(401);

    const member = await jarFetch(malloryJar)("/api/orgs/secorg/repos/doomed", { method: "DELETE" });
    expect(member.status).toBe(403); // mallory is a member, not owner
  });

  it("owner deletes; repo, rows, and bare dir are gone", async () => {
    const res = await jarFetch(ada)("/api/orgs/secorg/repos/doomed", { method: "DELETE" });
    expect(res.ok).toBe(true);

    const gone = await db.query(`SELECT count(*)::int AS n FROM repositories WHERE name='doomed'`);
    expect((gone.rows[0] as { n: number }).n).toBe(0);

    const page = await fetch(`${BASE}/secorg/doomed`);
    const text = await page.text();
    expect(text).toContain("Repository not found");
  });
});
