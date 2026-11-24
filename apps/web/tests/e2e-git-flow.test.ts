// E2E integration: boots a real forge server on a test port, seeds it, then
// runs genuine `git clone`/`git push` flows over HTTP and verifies the
// AI-native pipeline (auto-PR, review findings, preview, index, Q&A, merge).

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const exec = promisify(execFile);

const PORT = 3105;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = process.env.FORGE_TEST_DB ?? "forge_test";
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data-test");

let server: ReturnType<typeof spawn> | null = null;
let work = "";
let pat = "";
let cookie = "";

/** Session-authenticated fetch. */
async function sfetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
}
const db = new pg.Client({ connectionString: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` });

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

/** Wait until at least `minDone` jobs of a queue type reached done/failed. */
async function waitJobCount(queue: string, minDone: number, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await db.query(
      `SELECT count(*)::int AS n FROM job_queue WHERE status IN ('done','failed') AND queue = $1`,
      [queue],
    );
    if ((r.rows[0] as { n: number }).n >= minDone) return;
    await new Promise((res) => setTimeout(res, 400));
  }
  throw new Error(`job ${queue} did not reach ${minDone} completions`);
}

async function git(args: string[], opts?: { cwd?: string }) {
  return exec("git", args, { cwd: opts?.cwd });
}

beforeAll(async () => {
  // Wipe storage root first: stale bare repos outlive DB resets and
  // break pushes with non-fast-forward on re-runs.
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  await db.connect();
  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGE_PORT: String(PORT),
      DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}`,
      FORGE_STORAGE_ROOT: DATA,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { openSync, writeSync } = await import("node:fs");
  const logFd = openSync("/tmp/forge-e2e-server.log", "w");
  server.stdout?.on("data", (d) => writeSync(logFd, d));
  server.stderr?.on("data", (d) => writeSync(logFd, d));
  await waitForServer();
  work = await mkdtemp(path.join(tmpdir(), "forge-e2e-"));
}, 180_000);

afterAll(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  }
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  await db.end().catch(() => {});
});

describe("seed + users", () => {
  it("registers the demo user, then creates a PAT", async () => {
    const r = await db.query(`SELECT count(*)::int AS n FROM users`);
    expect((r.rows[0] as { n: number }).n).toBe(0);

    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@acme.dev", name: "Ada Lovelace", handle: "ada", password: "longpassword1" }),
    });
    expect(reg.ok).toBe(true);
    cookie = (reg.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(cookie).toMatch(/^forge_session=/);
    void cookie; // used by sfetch

    await db.query(`INSERT INTO organizations (slug, name, owner_id) VALUES ('acme2', 'ACME', 1)`);

    const res = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "e2e", scopes: ["repo:read", "repo:write"] }),
    });
    const data = (await res.json()) as { token: string };
    pat = data.token;
    expect(pat).toMatch(/^forge_pat_/);
  });
});

describe("git over HTTP", () => {
  let freshDir = "";

  it("creates the repo via /api/repos, clones the empty repo, pushes main", async () => {
    const res = await sfetch(`/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "acme2", name: "fresh", visibility: "public" }),
    });
    expect(res.ok).toBe(true);

    freshDir = path.join(work, "fresh");
    await git(["clone", `${BASE}/git/acme2/fresh.git`, freshDir]);
    await git(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-m", "init"], { cwd: freshDir });
    await git(["branch", "-M", "main"], { cwd: freshDir });
    await git(["push", `http://ada:${pat}@localhost:${PORT}/git/acme2/fresh.git`, "main"], { cwd: freshDir });

    const r = await db.query(
      `SELECT name FROM branches WHERE repo_id = (SELECT id FROM repositories WHERE name='fresh')`,
    );
    expect(r.rows).toContainEqual({ name: "main" });
  });

  it("creates an intent via the API (number 1 in repo fresh)", async () => {
    const res = await sfetch(`/api/acme2/fresh/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add health endpoint", description: "liveness probe", kind: "intent" }),
    });
    const data = (await res.json()) as { number: number };
    expect(data.number).toBe(1);
  });

  it("pushes an intent branch and auto-opens a PR with review + preview", async () => {
    await git(["checkout", "-q", "-b", "i1-health"], { cwd: freshDir });
    await exec("bash", ["-c", `echo 'export const health = () => "ok";' > ${freshDir}/health.ts`]);
    await exec("bash", ["-c", `printf '{"name":"fresh","version":"1.0.0","scripts":{"build":"echo built"}}' > ${freshDir}/package.json`]);
    await git(["add", "."], { cwd: freshDir });
    await git(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: health"], { cwd: freshDir });
    await git(["push", "-q", `http://ada:${pat}@localhost:${PORT}/git/acme2/fresh.git`, "HEAD:i1-health"], { cwd: freshDir });

    // PR auto-opened against intent #1
    const prs = await db.query<{ number: number; head_branch: string; intent_id: number }>(
      `SELECT number, head_branch, intent_id FROM pull_requests`,
    );
    expect(prs.rows.length).toBe(1);
    expect(prs.rows[0]!.head_branch).toBe("i1-health");
    expect(prs.rows[0]!.intent_id).not.toBeNull();

    // Worker ran the review + preview jobs for the PR
    await waitJobCount("pr_review", 1);
    const rc = await db.query(`SELECT count(*)::int AS n FROM review_comments`);
    expect((rc.rows[0] as { n: number }).n).toBeGreaterThan(0);

    await waitJobCount("preview_build", 1);
    const prev = await db.query(`SELECT count(*)::int AS n FROM previews`);
    expect((prev.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it("rejects pushes without credentials (no keychain replay)", async () => {
    await git(["checkout", "-q", "-b", "evil"], { cwd: freshDir });
    await git(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "--allow-empty", "-q", "-m", "evil"], { cwd: freshDir });
    await expect(
      git(["-c", "credential.helper=", "push", `${BASE}/git/acme2/fresh.git`, "HEAD:evil"], { cwd: freshDir }),
    ).rejects.toThrow();
  });

  it("manually opens a PR from an arbitrary branch (not intent-named)", async () => {
    // Push a plain feature branch with a commit.
    await git(["checkout", "-q", "-b", "feature-plain"], { cwd: freshDir });
    await exec("bash", ["-c", `echo 'export const plain = 1;' > ${freshDir}/plain.ts`]);
    await git(["add", "."], { cwd: freshDir });
    await git(["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "feat: plain branch"], { cwd: freshDir });
    await git(["push", "-q", `http://ada:${pat}@localhost:${PORT}/git/acme2/fresh.git`, "HEAD:feature-plain"], { cwd: freshDir });

    // Open a manual PR via the new endpoint (session-authenticated).
    const res = await sfetch(`/api/acme2/fresh/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: "feature-plain", base: "main", title: "Plain feature" }),
    });
    const data = (await res.json()) as { ok: boolean; number: number };
    expect(res.ok).toBe(true);
    expect(data.number).toBeGreaterThan(1);

    // Duplicate open is rejected with 409.
    const dupe = await sfetch(`/api/acme2/fresh/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: "feature-plain", base: "main" }),
    });
    expect(dupe.status).toBe(409);

    // The manual PR got AI review + preview jobs too.
    await waitJobCount("pr_review", 2);
    await waitJobCount("preview_build", 2);
  });

  it("rejects a manual PR with no diff (head == base)", async () => {
    const res = await sfetch(`/api/acme2/fresh/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ head: "main", base: "main" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("merge", () => {
  it("blocks merge into protected main without approval", async () => {
    const rows = (await db.query<{ number: number }>(`SELECT number FROM pull_requests ORDER BY id LIMIT 1`)).rows;
    const num = rows[0]!.number;
    const res = await sfetch(`/acme2/fresh/pulls/${num}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "squash" }),
    });
    expect(res.status).toBe(403);
    const data = (await res.json()) as { error?: string };
    expect(data.error).toMatch(/approving review/);
  });

  it("second user approves; author self-approval rejected; merge proceeds", async () => {
    // Use the manual PR (feature-plain, authored by ada) — the auto-PR has a null author.
    const rows = (await db.query<{ number: number }>(`SELECT number FROM pull_requests WHERE head_branch='feature-plain'`)).rows;
    const num = rows[0]!.number;

    // Author cannot approve their own PR.
    const self = await sfetch(`/api/acme2/fresh/pulls/${num}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state: "approved" }),
    });
    expect(self.status).toBe(403);

    // A second user registers, is added to the org, and approves.
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "grace@acme.dev", name: "Grace Hopper", handle: "grace", password: "longpassword1" }),
    });
    const graceCookie = (reg.headers.get("set-cookie") ?? "").split(";")[0]!;
    await db.query(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, u.id, 'member' FROM organizations o, users u
       WHERE o.slug='acme2' AND u.handle='grace'`,
    );

    const approve = await fetch(`${BASE}/api/acme2/fresh/pulls/${num}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: graceCookie },
      body: JSON.stringify({ state: "approved" }),
    });
    expect(approve.ok).toBe(true);

    // Merge now goes through.
    const res = await sfetch(`/acme2/fresh/pulls/${num}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "squash" }),
    });
    const data = (await res.json()) as { ok: boolean; merged?: string };
    expect(data.ok).toBe(true);
    expect(data.merged).toMatch(/^[0-9a-f]{40}$/);

    const pr = await db.query(`SELECT status FROM pull_requests WHERE number = ${num}`);
    expect(pr.rows[0]).toEqual({ status: "merged" });
  });
});

describe("semantic index + Q&A", () => {
  it("indexes pushed code and answers with citations", async () => {
    await waitJobCount("semantic_index", 3); // main + i1-health (+ merge re-index of main)
    const emb = await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM embeddings`);
    expect((emb.rows[0] as { n: number }).n).toBeGreaterThan(0);

    const res = await fetch(`${BASE}/api/acme2/fresh/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "where is health defined?", branch: "i1-health" }),
    });
    const qa = (await res.json()) as { answer: string; citations: Array<{ path: string }> };
    expect(qa.citations.length).toBeGreaterThan(0);
    expect(qa.citations.some((c) => c.path.includes("health"))).toBe(true);
  });
});
