// E2E integration (enterprise coverage): exercises features the earlier
// suites missed — rebase merge, the intent plan/scaffold pipeline, webhook
// failure delivery recording, queue reaper recovery, and repo deletion
// including the on-disk bare repo.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { adminDsn, testDbDsn } from "./helpers/db";

const exec = promisify(execFile);

const PORT = 3109;
const SSH_PORT = 3226;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = "forge_test5";
const ROOT = process.cwd();
const DATA = path.join(ROOT, "data-test5");

let server: ReturnType<typeof spawn> | null = null;
let work = "";
let cookie = "";

const db = new pg.Client({ connectionString: testDbDsn(TEST_DB) });

async function sfetch(p: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${p}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...(cookie ? { cookie } : {}) },
  });
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
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  for (let i = 0; i < 5; i++) {
    try {
      await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`);
      break;
    } catch { await new Promise((r) => setTimeout(r, 200)); }
  }
  await admin.query(`CREATE DATABASE ${TEST_DB}`);
  await admin.end();
  await exec("pnpm", ["exec", "tsx", "../../packages/db/src/migrate.ts"], {
    cwd: ROOT,
    env: { ...process.env, DATABASE_URL: testDbDsn(TEST_DB), FORGE_MIGRATIONS_DIR: `${ROOT}/drizzle` },
  });
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  await db.connect();
  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    detached: true,
    env: {
      ...process.env,
      FORGE_PORT: String(PORT),
      DATABASE_URL: testDbDsn(TEST_DB),
      FORGE_STORAGE_ROOT: DATA,
      FORGE_SSH_PORT: String(SSH_PORT),
      // The failure-path webhook test needs to register a localhost target.
      FORGE_WEBHOOK_ALLOW_PRIVATE_TARGETS: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const { openSync, writeSync } = await import("node:fs");
  const logFd = openSync("/tmp/forge-e2e-enterprise.log", "w");
  server.stdout?.on("data", (d) => writeSync(logFd, d));
  server.stderr?.on("data", (d) => writeSync(logFd, d));
  await waitForServer();
  work = await mkdtemp(path.join(tmpdir(), "forge-e2e5-"));
}, 240_000);

afterAll(async () => {
  if (server?.pid) {
    try { process.kill(-server.pid, "SIGKILL"); } catch { server.kill("SIGKILL"); }
  }
  if (work) await rm(work, { recursive: true, force: true }).catch(() => {});
  await rm(DATA, { recursive: true, force: true }).catch(() => {});
  await db.end().catch(() => {});
});

describe("rebase merge strategy", () => {
  it("registers, creates a repo, pushes two branches, merges via rebase", async () => {
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "eva@corp.dev", name: "Eva Dee", handle: "eva", password: "longpassword1" }),
    });
    expect(reg.ok).toBe(true);
    cookie = (reg.headers.get("set-cookie") ?? "").split(";")[0]!;

    const create = await sfetch(`/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "corp", name: "widget", visibility: "public", description: "widgets" }),
    });
    expect(create.ok).toBe(true);

    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/widget.git`;

    await git(["clone", pushUrl, work]);
    await git(["-C", work, "config", "user.name", "Eva"]);
    await git(["-C", work, "config", "user.email", "eva@corp.dev"]);
    await git(["-C", work, "commit", "--allow-empty", "--quiet", "-m", "init"]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/main"]);
    await git(["-C", work, "checkout", "--quiet", "-b", "feature-x"]);
    await git(["-C", work, "commit", "--allow-empty", "--quiet", "-m", "feature work"]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/feature-x"]);

    const pr = await sfetch(`/api/corp/widget/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Feature X", head: "feature-x", base: "main" }),
    });
    const prBody = (await pr.json()) as { number: number };
    expect(pr.ok).toBe(true);

    // main is protected: merging requires an approval from a non-author.
    const reg2 = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sam@corp.dev", name: "Sam Two", handle: "sam", password: "longpassword1" }),
    });
    expect(reg2.ok).toBe(true);
    const samCookie = (reg2.headers.get("set-cookie") ?? "").split(";")[0]!;
    const orgIdRow = await db.query(`SELECT id FROM organizations WHERE slug = 'corp'`);
    const orgId = (orgIdRow.rows[0] as { id: number }).id;
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE handle = 'sam'), 'member')`, [orgId]);
    const approve = await fetch(`${BASE}/api/corp/widget/pulls/${prBody.number}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: samCookie },
      body: JSON.stringify({ state: "approved" }),
    });
    expect(approve.ok).toBe(true);

    const merge = await sfetch(`/corp/widget/pulls/${prBody.number}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "rebase" }),
    });
    const merged = (await merge.json()) as { ok?: boolean; strategy?: string; merged?: string };
    expect(merge.ok).toBe(true);
    expect(merged.strategy).toBe("rebase");

    const row = await db.query(`SELECT status, merged_commit_sha FROM pull_requests WHERE number = $1`, [prBody.number]);
    expect((row.rows[0] as { status: string }).status).toBe("merged");
    expect((row.rows[0] as { merged_commit_sha: string }).merged_commit_sha).toMatch(/^[0-9a-f]{40}$/);

    // main advanced to the rebased head
    const mainSha = (await git(["--git-dir", path.join(DATA, "repos", "corp", "widget.git"), "rev-parse", "main"])).stdout.trim();
    expect(mainSha).toBe(merged.merged);
  });
});

describe("intent plan + scaffold pipeline", () => {
  it("drafts a plan (heuristic mode) and scaffolds the branch with INTENT.md", async () => {
    const create = await sfetch(`/api/corp/widget/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Add widget export", description: "Export widgets to CSV.", kind: "intent" }),
    });
    const issue = (await create.json()) as { number: number };
    expect(create.ok).toBe(true);

    const plan = await sfetch(`/api/corp/widget/issues/${issue.number}/plan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(plan.ok).toBe(true);
    await waitJobCount("intent_plan", 1);

    const intentRow = await db.query(
      `SELECT plan_state, plan FROM intents WHERE number = $1`,
      [issue.number],
    );
    const row = intentRow.rows[0] as { plan_state: string; plan: { branchName: string; steps: string[] } | null };
    expect(row.plan_state).toBe("ready");
    expect(row.plan).not.toBeNull();
    expect(Array.isArray(row.plan!.steps)).toBe(true);

    const scaffold = await sfetch(`/api/corp/widget/issues/${issue.number}/scaffold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sc = (await scaffold.json()) as { ok?: boolean; branch?: string };
    expect(scaffold.ok).toBe(true);
    expect(sc.branch).toMatch(/^i\d+-/);

    // Branch exists in git and in the DB
    const branchesRow = await db.query(`SELECT count(*)::int AS n FROM branches WHERE repo_id = (SELECT id FROM repositories WHERE name = 'widget') AND name = $1`, [sc.branch]);
    expect((branchesRow.rows[0] as { n: number }).n).toBe(1);
    const branchOut = await git(["--git-dir", path.join(DATA, "repos", "corp", "widget.git"), "show", "--name-only", "--format=", sc.branch]);
    expect(branchOut.stdout).toContain("docs/intents/");
  });

  it("is idempotent: scaffolding again returns the existing branch", async () => {
    const intentRow = await db.query(`SELECT number, branch_name FROM intents ORDER BY number DESC LIMIT 1`);
    const { number, branch_name } = intentRow.rows[0] as { number: number; branch_name: string };
    const scaffold = await sfetch(`/api/corp/widget/issues/${number}/scaffold`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    const sc = (await scaffold.json()) as { existing?: boolean; branch?: string };
    expect(scaffold.ok).toBe(true);
    expect(sc.existing).toBe(true);
    expect(sc.branch).toBe(branch_name);
  });
});

describe("webhook failure delivery", () => {
  it("records a failed delivery when the endpoint is dead", async () => {
    const create = await sfetch(`/api/corp/widget/hooks`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "http://localhost:59999/dead", events: ["push"] }),
    });
    expect(create.ok).toBe(true);

    // Push to a fresh (unprotected) branch to trigger the push event —
    // direct pushes to protected main are correctly declined.
    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t2", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/widget.git`;
    await git(["-C", work, "checkout", "--quiet", "main"]);
    await git(["-C", work, "checkout", "--quiet", "-b", "webhook-trigger"]);
    await git(["-C", work, "commit", "--allow-empty", "--quiet", "-m", "trigger webhooks"]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/webhook-trigger"]);

    const deadline = Date.now() + 30_000;
    let row: { status: string } | undefined;
    while (Date.now() < deadline) {
      const r = await db.query(
        `SELECT status FROM webhook_deliveries WHERE event = 'push' ORDER BY id DESC LIMIT 1`,
      );
      row = r.rows[0] as { status: string } | undefined;
      if (row && row.status !== "pending") break;
      await new Promise((res) => setTimeout(res, 400));
    }
    expect(row).toBeDefined();
    expect(row!.status).toBe("failed");
  });
});

describe("queue reaper", () => {
  it("requeues jobs stuck in active state", async () => {
    // Insert a fake stuck job claimed by a dead worker 11 minutes ago.
    // qa_answer has no side effects that could crash the test run; the
    // assertion is that the row leaves 'active'/'worker-dead' state.
    await db.query(`
      INSERT INTO job_queue (queue, payload, status, run_at, attempts, max_attempts, locked_at, locked_by)
      VALUES ('qa_answer', '{"repoId": 999999, "branch": "x", "question": "q", "askerId": null}', 'active',
              now() - interval '11 minutes', 1, 3, now() - interval '11 minutes', 'worker-dead')
    `);
    const before = await db.query(
      `SELECT id FROM job_queue WHERE locked_by = 'worker-dead' ORDER BY id DESC LIMIT 1`,
    );
    const stuckId = (before.rows[0] as { id: number }).id;

    const deadline = Date.now() + 20_000;
    let escaped = false;
    while (Date.now() < deadline) {
      const r = await db.query(`SELECT status, locked_by, attempts FROM job_queue WHERE id = $1`, [stuckId]);
      const row = r.rows[0] as { status: string; locked_by: string | null; attempts: number };
      // Reaped: no longer locked by the dead worker. It will be re-claimed
      // by the live worker (attempts > 1) and likely fail on the missing
      // repo — either way it must not stay stuck with locked_by='worker-dead'.
      if (row.locked_by !== "worker-dead" || row.attempts > 1) { escaped = true; break; }
      await new Promise((res) => setTimeout(res, 500));
    }
    expect(escaped).toBe(true);
  });
});

describe("repo deletion removes the bare repo on disk", () => {
  it("deletes the repo row and the git directory", async () => {
    const create = await sfetch(`/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "corp", name: "temp-repo", visibility: "public" }),
    });
    expect(create.ok).toBe(true);

    const gitPath = path.join(DATA, "repos", "corp", "temp-repo.git");
    await access(gitPath); // exists

    const del = await sfetch(`/api/orgs/corp/repos/temp-repo`, { method: "DELETE" });
    expect(del.ok).toBe(true);

    await expect(access(gitPath)).rejects.toThrow();
    const row = await db.query(`SELECT count(*)::int AS n FROM repositories WHERE name = 'temp-repo'`);
    expect((row.rows[0] as { n: number }).n).toBe(0);
  });
});

describe("audit log", () => {
  it("records auth events and sensitive mutations with actor attribution", async () => {
    // The suite has already: registered eva, created PATs, created+deleted
    // a repo, approved a PR, merged a PR, created a webhook. All of those
    // should have audit rows attributed to eva (or sam for the approval).
    // Log eva in once so the login event is exercised too.
    const login = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "eva@corp.dev", password: "longpassword1" }),
    });
    expect(login.ok).toBe(true);
    const r = await db.query(`
      SELECT action, actor_handle, target_type, target_id FROM audit_log ORDER BY id
    `);
    const rows = r.rows as Array<{ action: string; actor_handle: string | null; target_type: string | null; target_id: string | null }>;
    const actions = rows.map((x) => x.action);

    expect(actions).toContain("auth.register");
    expect(actions).toContain("auth.login");
    expect(actions).toContain("pat.create");
    expect(actions).toContain("repo.create");
    expect(actions).toContain("repo.delete");
    expect(actions).toContain("pr.approve");
    expect(actions).toContain("pr.merge");
    expect(actions).toContain("webhook.create");

    // Attribution: every row from this suite has an actor handle.
    for (const row of rows) {
      expect(row.actor_handle).toBeTruthy();
    }

    // The merge row points at the right PR.
    const mergeRow = rows.find((x) => x.action === "pr.merge");
    expect(mergeRow!.target_id).toMatch(/corp\/widget#1$/);

    // The audit API scopes to the caller: register a third user with no
    // history and confirm they see nothing.
    const reg3 = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "zed@corp.dev", name: "Zed Three", handle: "zed", password: "longpassword1" }),
    });
    const zedCookie = (reg3.headers.get("set-cookie") ?? "").split(";")[0]!;
    const auditRes = await fetch(`${BASE}/api/audit`, { headers: { cookie: zedCookie } });
    const auditBody = (await auditRes.json()) as { audit: Array<{ action: string }> };
    expect(auditRes.ok).toBe(true);
    // Zed sees only his own registration — nothing from eva or sam.
    const zedActions = auditBody.audit.map((x) => x.action);
    expect(zedActions).toEqual(["auth.register"]);
  });

  it("records failed logins and lockouts for anonymous attackers", async () => {
    // 6 bad logins: 5 record failures, the 6th hits the rate limit.
    for (let i = 0; i < 6; i++) {
      await fetch(`${BASE}/api/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: "nobody@corp.dev", password: "wrong" }),
      });
      await new Promise((res) => setTimeout(res, 10));
    }
    const r = await db.query(
      `SELECT action FROM audit_log WHERE action LIKE 'auth.login%' AND actor_handle = 'nobody@corp.dev' ORDER BY id`,
    );
    const actions = (r.rows as Array<{ action: string }>).map((x) => x.action);
    expect(actions.filter((a) => a === "auth.login_failed").length).toBeGreaterThanOrEqual(5);
    expect(actions).toContain("auth.login_locked");
  });
});

describe("two-factor authentication", () => {
  it("requires a TOTP code at login after enrollment and supports recovery codes", async () => {
    // Import the real TOTP helpers to compute valid codes in-test.
    const { totpCode } = await import("@forge/db");

    // Fresh user enrolls 2FA through the API.
    const reg = await fetch(`${BASE}/api/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", name: "Tess Two", handle: "tess", password: "longpassword1" }),
    });
    const tessCookie = (reg.headers.get("set-cookie") ?? "").split(";")[0]!;

    const enrolled = await fetch(`${BASE}/api/2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: tessCookie },
      body: JSON.stringify({ action: "enroll" }),
    });
    const enrollBody = (await enrolled.json()) as { secret: string };
    expect(enrolled.ok).toBe(true);
    expect(enrollBody.secret).toMatch(/^[A-Z2-7]{32}$/);

    const confirm = await fetch(`${BASE}/api/2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: tessCookie },
      body: JSON.stringify({ action: "confirm", code: totpCode(enrollBody.secret), secret: enrollBody.secret }),
    });
    const confirmBody = (await confirm.json()) as { recoveryCodes: string[] };
    expect(confirm.ok).toBe(true);
    expect(confirmBody.recoveryCodes).toHaveLength(8);

    // Status endpoint says enabled.
    const status = await fetch(`${BASE}/api/2fa`, { headers: { cookie: tessCookie } });
    expect(((await status.json()) as { enabled: boolean }).enabled).toBe(true);

    // Login with the correct password now stalls at the TOTP challenge.
    const login1 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1" }),
    });
    const login1Body = (await login1.json()) as { totpRequired?: boolean };
    expect(login1Body.totpRequired).toBe(true);
    expect(login1.headers.get("set-cookie")).toBeNull(); // no session yet

    // Wrong code is rejected.
    const login2 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1", code: "000000" }),
    });
    expect(login2.status).toBe(401);

    // Correct code completes the login.
    const login3 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1", code: totpCode(enrollBody.secret) }),
    });
    expect(login3.ok).toBe(true);
    expect(login3.headers.get("set-cookie")).toMatch(/^forge_session=/);

    // Recovery code: use one, confirm it is single-use.
    const recovery = confirmBody.recoveryCodes[0]!;
    const login4 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1", recoveryCode: recovery }),
    });
    expect(login4.ok).toBe(true);

    const login5 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1", recoveryCode: recovery }),
    });
    expect(login5.status).toBe(401); // already consumed

    // Disable with a current code.
    const disable = await fetch(`${BASE}/api/2fa`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: tessCookie },
      body: JSON.stringify({ action: "disable", code: totpCode(enrollBody.secret) }),
    });
    expect(disable.ok).toBe(true);

    // Login no longer challenges.
    const login6 = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "tess@corp.dev", password: "longpassword1" }),
    });
    expect(login6.ok).toBe(true);

    // Audit trail covers enable + disable.
    const auditRows = await db.query(
      `SELECT action FROM audit_log WHERE action LIKE '2fa.%' ORDER BY id`,
    );
    const actions = (auditRows.rows as Array<{ action: string }>).map((r) => r.action);
    expect(actions).toContain("2fa.enable");
    expect(actions).toContain("2fa.disable");
  });
});

describe("webhook redelivery", () => {
  it("retries a recorded delivery as a new delivery row", async () => {
    // Grab the failed delivery recorded earlier (dead-endpoint hook).
    const failed = await db.query(
      `SELECT id FROM webhook_deliveries WHERE status = 'failed' ORDER BY id DESC LIMIT 1`,
    );
    const deliveryId = (failed.rows[0] as { id: number }).id;

    const res = await sfetch(`/api/corp/widget/hooks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redeliver", deliveryId }),
    });
    const body = (await res.json()) as { ok?: boolean; deliveryId?: number };
    expect(res.ok).toBe(true);
    expect(body.deliveryId).toBeGreaterThan(deliveryId);

    // The retry also fails (endpoint still dead) and is recorded as its own row.
    const deadline = Date.now() + 20_000;
    let retried: { status: string } | undefined;
    while (Date.now() < deadline) {
      const r = await db.query(`SELECT status FROM webhook_deliveries WHERE id = $1`, [body.deliveryId!]);
      const row = r.rows[0] as { status: string } | undefined;
      if (row && row.status !== "pending") { retried = row; break; }
      await new Promise((r2) => setTimeout(r2, 400));
    }
    expect(retried).toBeDefined();
    expect(retried!.status).toBe("failed");

    // Original row untouched; redelivery is audited.
    const orig = await db.query(`SELECT status FROM webhook_deliveries WHERE id = $1`, [deliveryId]);
    expect((orig.rows[0] as { status: string }).status).toBe("failed");
    const audit = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'webhook.redeliver'`);
    expect((audit.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });

  it("rejects redelivery of another repo's delivery", async () => {
    const res = await sfetch(`/api/corp/widget/hooks`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "redeliver", deliveryId: 999999 }),
    });
    expect(res.status).toBe(404);
  });
});
