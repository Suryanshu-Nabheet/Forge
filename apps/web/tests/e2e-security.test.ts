// E2E: authorization perimeter — private-repo visibility, org membership gates,
// hook authentication, PAT revocation, SSE auth. Boots its own server + DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

const PORT = 3107;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = process.env.FORGE_TEST_DB3 ?? "forge_test3";
const ROOT = process.cwd();
const DATA = `${ROOT}/data-test3`;

let server: ReturnType<typeof spawn> | null = null;
let hookToken = "";
const db = new pg.Client({ connectionString: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` });

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
  const admin = new pg.Client({ connectionString: "postgresql://suryanshunabheet@localhost:5432/postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${TEST_DB};`);
  await admin.end();
  await exec("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` },
  });
  await exec("rm", ["-rf", DATA]);
  await db.connect();

  // Boot the server; capture its stdout to learn the hook token (printed for tests).
  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}`,
      FORGE_STORAGE_ROOT: DATA,
      FORGE_PORT: String(PORT),
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
  server?.kill("SIGKILL");
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
