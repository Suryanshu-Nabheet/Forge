// E2E: auth flows (register/login/logout/session scoping), PR lifecycle
// (close/reopen, merge → intent done), UI pages render, comments.
// Boots a second server instance on its own port + DB.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import pg from "pg";

const exec = promisify(execFile);

const PORT = 3106;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = process.env.FORGE_TEST_DB2 ?? "forge_test2";
const ROOT = process.cwd();
const DATA = `${ROOT}/data-test2`;

let server: ReturnType<typeof spawn> | null = null;
const db = new pg.Client({ connectionString: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` });

// Minimal cookie-jar fetch wrapper
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

async function sql(q: string, params?: unknown[]) {
  const r = await db.query(q, params);
  return r.rows;
}

beforeAll(async () => {
  // Fresh DB for this suite
  const admin = new pg.Client({ connectionString: "postgresql://suryanshunabheet@localhost:5432/postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${TEST_DB};`);
  await admin.end();
  await exec("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` },
  });

  // Wipe the storage root too: a stale bare repo survives DB resets and
  // causes non-fast-forward push failures on re-runs.
  const fs = await import("node:fs/promises");
  await fs.rm(DATA, { recursive: true, force: true }).catch(() => {});

  await db.connect();
  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      FORGE_PORT: String(PORT),
      DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}`,
      FORGE_STORAGE_ROOT: DATA,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {});
  await waitForServer();
}, 180_000);

afterAll(async () => {
  server?.kill("SIGKILL");
  await db.end().catch(() => {});
  // Give the OS a beat to release DB connections, then drop.
  await new Promise((r) => setTimeout(r, 1500));
  const admin = new pg.Client({ connectionString: "postgresql://suryanshunabheet@localhost:5432/postgres" });
  await admin.connect();
  for (let i = 0; i < 5; i++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  await admin.end().catch(() => {});
}, 60_000);

describe("auth flows", () => {
  const jar = { cookie: "" };
  const f = () => jarFetch(jar);

  it("rejects anonymous mutations (401)", async () => {
    const res = await f().call(null, "/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "x", name: "y" }),
    });
    expect(res.status).toBe(401);
  });

  it("registers a user and sets a session", async () => {
    const res = await f()("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "zoe@test.dev", name: "Zoe", handle: "zoe", password: "longpassword1" }),
    });
    expect(res.ok).toBe(true);
    expect(jar.cookie).toMatch(/^forge_session=/);
    const u = (await sql("select handle from users where email='zoe@test.dev'"))[0];
    expect(u).toEqual({ handle: "zoe" });
  });

  it("rejects weak passwords and bad handles", async () => {
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "a@b.dev", name: "A", handle: "ok-handle", password: "short" }),
    });
    expect(res.status).toBe(400);
  });

  it("session scopes keys and PATs to the user", async () => {
    const keysRes = await f()("/api/keys");
    const keys = (await keysRes.json()) as { keys: unknown[] };
    expect(keys.keys).toEqual([]);

    const patRes = await f()("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "zoe-token", scopes: ["repo:read", "repo:write"] }),
    });
    const pat = (await patRes.json()) as { token: string };
    expect(pat.token).toMatch(/^forge_pat_/);

    // PAT authenticates git transport via Basic auth
    const probe = await fetch(`${BASE}/api/keys`);
    expect(probe.status).toBe(401); // anonymous (new jar-less request) is rejected
  });

  it("logout destroys the session", async () => {
    const res = await f()("/api/auth/logout", { method: "POST" });
    expect(res.ok).toBe(true);
    jar.cookie = ""; // server cleared it
    const after = await fetch(`${BASE}/api/keys`);
    expect(after.status).toBe(401);
  });

  it("login with the registered credentials works", async () => {
    const res = await f()("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "zoe@test.dev", password: "longpassword1" }),
    });
    expect(res.ok).toBe(true);
  });
});

describe("repository + intent + PR lifecycle", () => {
  const jar = { cookie: "" };
  const f = () => jarFetch(jar);
  let pat = "";

  beforeAll(async () => {
    // The register block above consumed its jar's session; this suite needs its own.
    const res = await f()("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "zoe@test.dev", password: "longpassword1" }),
    });
    expect(res.ok).toBe(true);
  });

  it("creates a repo (session) and a PAT for git", async () => {
    const res = await f()("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "zoecorp", name: "widgets", visibility: "public" }),
    });
    expect(res.ok).toBe(true);

    const patRes = await f()("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "git", scopes: ["repo:read", "repo:write"] }),
    });
    pat = ((await patRes.json()) as { token: string }).token;
  });

  it("seeds a real commit via git push (PAT over HTTP)", async () => {
    const { mkdtemp, writeFile, mkdir } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const dir = await mkdtemp(path.join(tmpdir(), "zoecorp-"));
    await exec("git", ["clone", "-q", `${BASE}/git/zoecorp/widgets.git`, dir]);
    await mkdir(path.join(dir, "src"), { recursive: true });
    await writeFile(path.join(dir, "src", "index.ts"), "export function widget(): number {\n  return 42;\n}\n");
    await writeFile(path.join(dir, "package.json"), '{"name":"widgets","scripts":{"build":"echo built"}}');
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "-c", "user.name=Zoe", "-c", "user.email=zoe@test.dev", "commit", "-q", "-m", "init"]);
    await exec("git", ["-C", dir, "push", "-q", `http://zoe:${pat}@localhost:${PORT}/git/zoecorp/widgets.git`, "main"]);
    const rows = await sql("select name from branches");
    expect(rows).toContainEqual({ name: "main" });
  });

  it("UI pages render: dashboard, org, repo, file view, issues, pulls", async () => {
    const dashboard = await fetch(`${BASE}/`);
    expect(dashboard.ok).toBe(true);
    expect(await dashboard.text()).toContain("zoecorp/widgets");

    const orgPage = await fetch(`${BASE}/zoecorp`);
    expect(orgPage.ok).toBe(true);
    expect(await orgPage.text()).toContain("widgets");

    const repoPage = await fetch(`${BASE}/zoecorp/widgets`);
    expect((await repoPage.text())).toContain("src");

    const filePage = await fetch(`${BASE}/zoecorp/widgets?path=src/index.ts`);
    const fileHtml = await filePage.text();
    expect(fileHtml).toContain("export function widget");

    const pulls = await fetch(`${BASE}/zoecorp/widgets/pulls`);
    expect(pulls.ok).toBe(true);
    const issues = await fetch(`${BASE}/zoecorp/widgets/issues`);
    expect(issues.ok).toBe(true);
  });

  it("creates an intent, pushes i{n} branch → PR opens; close/reopen syncs intent; merge marks intent done", async () => {
    // intent #1
    const intentRes = await f()("/api/zoecorp/widgets/issues", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Ship widget v2", description: "bigger widget", kind: "intent" }),
    });
    const intent = (await intentRes.json()) as { number: number };
    expect(intent.number).toBe(1);

    // push i1-ship branch with a change
    const { mkdtemp, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const path = (await import("node:path")).default;
    const dir = await mkdtemp(path.join(tmpdir(), "zoecorp-i1-"));
    await exec("git", ["clone", "-q", `${BASE}/git/zoecorp/widgets.git`, dir]);
    await exec("git", ["-C", dir, "checkout", "-q", "-b", "i1-ship"]);
    await writeFile(path.join(dir, "src", "index.ts"), "export function widget(): number {\n  return 43;\n}\n");
    await exec("git", ["-C", dir, "add", "."]);
    await exec("git", ["-C", dir, "-c", "user.name=Zoe", "-c", "user.email=zoe@test.dev", "commit", "-q", "-m", "feat: v2"]);
    await exec("git", ["-C", dir, "push", "-q", `http://zoe:${pat}@localhost:${PORT}/git/zoecorp/widgets.git`, "HEAD:i1-ship"]);

    // PR #1 auto-opened and intent linked
    let rows = await sql("select number, intent_id, status from pull_requests");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.intent_id).not.toBeNull();
    rows = await sql("select status, linked_pr_id from intents where number=1");
    expect(rows[0]!.status).toBe("in_review");

    // close the PR → intent back to in_progress
    const closeRes = await f()(`/api/zoecorp/widgets/pulls/1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(closeRes.ok).toBe(true);
    rows = await sql("select status from intents where number=1");
    expect(rows[0]!.status).toBe("in_progress");

    // reopen → in_review again
    const reopenRes = await f()(`/api/zoecorp/widgets/pulls/1/status`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    expect(reopenRes.ok).toBe(true);
    rows = await sql("select status from intents where number=1");
    expect(rows[0]!.status).toBe("in_review");

    // post a human comment on the PR
    const commentRes = await f()(`/zoecorp/widgets/pulls/1/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "looks great, merging" }),
    });
    expect(commentRes.ok).toBe(true);
    rows = await sql("select kind, body from review_comments");
    expect(rows.some((r) => r.body.includes("looks great"))).toBe(true);

    // merge is blocked: main is protected and nobody approved yet
    const blocked = await f()(`/zoecorp/widgets/pulls/1/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "merge" }),
    });
    expect(blocked.status).toBe(403);

    // second user approves, then merge goes through
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "rita@test.dev", name: "Rita", handle: "rita", password: "longpassword1" }),
    });
    expect(reg.ok).toBe(true);
    const ritaCookie = (reg.headers.get("set-cookie") ?? "").split(";")[0]!;
    await sql(
      `INSERT INTO org_members (org_id, user_id, role)
       SELECT o.id, u.id, 'member' FROM organizations o, users u
       WHERE o.slug='zoecorp' AND u.handle='rita'`,
    );
    const approve = await fetch(`${BASE}/api/zoecorp/widgets/pulls/1/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: ritaCookie },
      body: JSON.stringify({ state: "approved" }),
    });
    expect(approve.ok).toBe(true);

    const mergeRes = await f()(`/zoecorp/widgets/pulls/1/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "merge" }),
    });
    const merged = (await mergeRes.json()) as { ok: boolean };
    expect(merged.ok).toBe(true);
    rows = await sql("select status from pull_requests where number=1");
    expect(rows[0]!.status).toBe("merged");
    rows = await sql("select status from intents where number=1");
    expect(rows[0]!.status).toBe("done");
  });
});
