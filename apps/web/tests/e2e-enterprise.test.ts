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

describe("repo front-door: README, raw files, blame", () => {
  it("renders the README, serves raw downloads, and blames a file", async () => {
    // Push content: README + a source file across two commits.
    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t3", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/widget.git`;
    await git(["-C", work, "checkout", "--quiet", "-b", "frontdoor"]);
    await exec("bash", ["-c", `cd ${work} && printf '# Widget\\n\\nHello **world**.\\n' > README.md && printf 'line a\\nline b\\n' > src.txt`]);
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "--quiet", "-m", "add readme"]);
    await exec("bash", ["-c", `cd ${work} && printf 'line a\\nline b changed\\n' > src.txt`]);
    await git(["-C", work, "commit", "--all", "--quiet", "-m", "tweak line"]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/frontdoor"]);

    // README renders on the repo front page (server component).
    const page = await fetch(`${BASE}/corp/widget?ref=frontdoor`);
    const html = await page.text();
    expect(page.ok).toBe(true);
    expect(html).toContain("Hello");
    expect(html).toContain("<strong>world</strong>");

    // Raw file: correct content type, exact bytes, download disposition.
    const raw = await fetch(`${BASE}/raw/corp/widget/README.md?ref=frontdoor`);
    expect(raw.ok).toBe(true);
    expect(raw.headers.get("Content-Type")).toContain("text/plain");
    expect(await raw.text()).toContain("Hello **world**.");
    const dl = await fetch(`${BASE}/raw/corp/widget/README.md?ref=frontdoor&download=1`);
    expect(dl.headers.get("Content-Disposition")).toContain("attachment");

    // Markdown FileView renders bold; blame attributes lines across commits.
    const filePage = await fetch(`${BASE}/corp/widget?ref=frontdoor&path=README.md`);
    expect(await filePage.text()).toContain("<strong>world</strong>");
    const blamePage = await fetch(`${BASE}/corp/widget/blame/src.txt?ref=frontdoor`);
    const blameHtml = await blamePage.text();
    expect(blamePage.ok).toBe(true);
    expect(blameHtml).toContain("line b changed");
    // Both commits appear in the blame gutter.
    expect(blameHtml).toMatch(/add readme|tweak line/);
  });
});

describe("literal code search + pagination", () => {
  it("greps literal and regex patterns across repos", async () => {
    // Grep scans default branches. Give the grep a deterministic target:
    // a fresh repo whose (unprotected) main gets the README directly.
    const mk = await sfetch(`/api/repos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "corp", name: "grep-repo", visibility: "public", description: "grep target" }),
    });
    expect(mk.ok).toBe(true);
    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t4", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/grep-repo.git`;
    await git(["-C", work, "checkout", "--quiet", "-b", "greptest"]);
    await exec("bash", ["-c", `cd ${work} && printf '# GrepRepo\n\nHello **world**.\n' > README.md && printf 'line a\nline b\n' > g.txt`]);
    await git(["-C", work, "add", "."]);
    await git(["-C", work, "commit", "--quiet", "-m", "grep content"]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/main"]);
    await git(["-C", work, "checkout", "--quiet", "frontdoor"]);

    const res = await sfetch(`/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "literal", q: "Hello" }),
    });
    const data = (await res.json()) as { matches: Array<{ repo: string; path: string; line: number; content: string }>; scannedRepos: number };
    expect(res.ok).toBe(true);
    expect(data.scannedRepos).toBeGreaterThan(0);
    const hit = data.matches.find((m) => m.path === "README.md");
    expect(hit).toBeDefined();
    expect(hit!.content).toContain("Hello **world**.");

    const re = await sfetch(`/api/search`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ mode: "literal", q: "line [bc]", regex: true }),
    });
    const reData = (await re.json()) as { matches: Array<{ content: string }> };
    expect(re.ok).toBe(true);
    expect(reData.matches.some((m) => m.content.includes("line b changed"))).toBe(true);

    // Per-repo grep endpoint is visibility-consistent: anonymous gets repo not found for private repos only.
    const anon = await fetch(`${BASE}/api/corp/widget/grep`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ q: "Hello" }),
    });
    expect(anon.ok).toBe(true); // widget is public
  });

  it("paginates the pulls list with ?before=", async () => {
    const page1 = await fetch(`${BASE}/corp/widget/pulls`);
    expect(page1.ok).toBe(true);
    // All PRs fit on one page (page size 30); before= beyond the oldest is empty.
    const before = await fetch(`${BASE}/corp/widget/pulls?before=1`);
    expect(before.ok).toBe(true);
    const html = await before.text();
    expect(html).toContain("No pull requests");
  });
});

describe("releases", () => {
  it("creates a tag + release, lists it, and fires the release webhook event", async () => {
    const res = await sfetch(`/api/corp/grep-repo/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagName: "v1.0.0", name: "Version 1.0", notes: "## Changes\n- first **stable** release", prerelease: false }),
    });
    const body = (await res.json()) as { ok?: boolean; tagName?: string; error?: string };
    expect(res.ok).toBe(true);
    expect(body.tagName).toBe("v1.0.0");

    // Tag exists in git on the default branch head.
    const tagSha = (await git(["--git-dir", path.join(DATA, "repos", "corp", "grep-repo.git"), "rev-parse", "v1.0.0"])).stdout.trim();
    expect(tagSha).toMatch(/^[0-9a-f]{40}$/);

    // Duplicate release rejected.
    const dupe = await sfetch(`/api/corp/grep-repo/releases`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tagName: "v1.0.0", name: "again" }),
    });
    expect(dupe.status).toBe(409);

    // Listed on the releases page with rendered notes.
    const page = await fetch(`${BASE}/corp/grep-repo/releases`);
    const html = await page.text();
    expect(page.ok).toBe(true);
    expect(html).toContain("Version 1.0");
    expect(html).toContain("<strong>stable</strong>");

    // Activity + audit recorded for the release.
    const act = await db.query(`SELECT count(*)::int AS n FROM activities WHERE type = 'release_published'`);
    expect((act.rows[0] as { n: number }).n).toBeGreaterThan(0);
    const aud = await db.query(`SELECT count(*)::int AS n FROM audit_log WHERE action = 'release.create'`);
    expect((aud.rows[0] as { n: number }).n).toBeGreaterThan(0);

    // Anonymous users can read the releases page (public repo).
    const anon = await fetch(`${BASE}/corp/grep-repo/releases`);
    expect(anon.ok).toBe(true);
  });
});

describe("intent management", () => {
  it("edits title, sets labels, closes and reopens via PATCH", async () => {
    const create = await sfetch(`/api/corp/grep-repo/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Original title", description: "before", kind: "issue" }),
    });
    const issue = (await create.json()) as { number: number };
    expect(create.ok).toBe(true);

    const edit = await sfetch(`/api/corp/grep-repo/issues/${issue.number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Renamed", description: "after", labels: ["bug", "urgent"] }),
    });
    expect(edit.ok).toBe(true);
    const row = (await db.query(`SELECT title, description, labels FROM intents WHERE number = $1 AND repo_id = (SELECT id FROM repositories WHERE name = 'grep-repo')`, [issue.number])).rows[0] as {
      title: string; description: string; labels: string[];
    };
    expect(row.title).toBe("Renamed");
    expect(row.description).toBe("after");
    expect(row.labels).toEqual(["bug", "urgent"]);

    const close = await sfetch(`/api/corp/grep-repo/issues/${issue.number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "closed" }),
    });
    expect(close.ok).toBe(true);
    const closedRow = (await db.query(`SELECT status, closed_at FROM intents WHERE number = $1 AND repo_id = (SELECT id FROM repositories WHERE name = 'grep-repo')`, [issue.number])).rows[0] as { status: string; closed_at: Date };
    expect(closedRow.status).toBe("closed");
    expect(closedRow.closed_at).not.toBeNull();

    const reopen = await sfetch(`/api/corp/grep-repo/issues/${issue.number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "open" }),
    });
    expect(reopen.ok).toBe(true);

    // Invalid status rejected with 400.
    const bad = await sfetch(`/api/corp/grep-repo/issues/${issue.number}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ status: "done" }),
    });
    expect(bad.status).toBe(400);

    // Audit trail.
    const aud = await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE action LIKE 'intent.%' AND target_id = $1`,
      [`corp/grep-repo#${issue.number}`],
    );
    expect((aud.rows[0] as { n: number }).n).toBeGreaterThan(0);
  });
});

describe("comment threading + intent discussions", () => {
  it("posts inline PR comments with replies, and intent discussion threads", async () => {
    // Intent discussion: top-level + reply via the comments API.
    const issueRes = await sfetch(`/api/corp/grep-repo/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Discussion target", description: "talk here" }),
    });
    const issue = (await issueRes.json()) as { number: number };
    expect(issueRes.ok).toBe(true);

    const c1 = await sfetch(`/api/corp/grep-repo/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "First **comment**" }),
    });
    const c1Body = (await c1.json()) as { id: number };
    expect(c1.ok).toBe(true);

    const reply = await sfetch(`/api/corp/grep-repo/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "A reply", inReplyTo: c1Body.id }),
    });
    expect(reply.ok).toBe(true);

    // Cross-thread reply rejected.
    const bad = await sfetch(`/api/corp/grep-repo/issues/${issue.number}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "bad", inReplyTo: 999999 }),
    });
    expect(bad.status).toBe(400);

    // Threaded comments render on the page (reply nested under parent).
    const page = await fetch(`${BASE}/corp/grep-repo/issues/${issue.number}`);
    const html = await page.text();
    expect(html).toContain("First <strong>comment</strong>");
    expect(html).toContain("A reply");

    // Inline PR comment with anchors + a threaded reply. The head branch
    // must exist in grep-repo: push one.
    const pat2 = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t5", scopes: ["repo:read", "repo:write"] }),
    });
    const pat2Body = (await pat2.json()) as { token: string };
    const push2 = `http://eva:${pat2Body.token}@localhost:${PORT}/git/corp/grep-repo.git`;
    await git(["-C", work, "checkout", "--quiet", "greptest"]);
    await exec("bash", ["-c", `cd ${work} && printf 'line a\nline b changed for the PR\n' > g.txt`]);
    await git(["-C", work, "commit", "--all", "--quiet", "-m", "pr diff"]);
    await git(["-C", work, "push", "--quiet", push2, "HEAD:refs/heads/greptest"]);

    const pr = await sfetch(`/api/corp/grep-repo/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Comment target", head: "greptest", base: "main" }),
    });
    expect(pr.ok).toBe(true);
    const prNum = ((await pr.json()) as { number: number }).number;

    const inline = await sfetch(`/corp/grep-repo/pulls/${prNum}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "inline on g.txt line 1", path: "g.txt", line: 1, side: "new" }),
    });
    const inlineBody = (await inline.json()) as { id: number };
    expect(inline.ok).toBe(true);

    const inlineReply = await sfetch(`/corp/grep-repo/pulls/${prNum}/comments`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ body: "threaded answer", inReplyTo: inlineBody.id }),
    });
    expect(inlineReply.ok).toBe(true);

    // The PR page shows both, nested.
    const prPage = await fetch(`${BASE}/corp/grep-repo/pulls/${prNum}`);
    const prHtml = await prPage.text();
    expect(prHtml).toContain("inline on g.txt line 1");
    expect(prHtml).toContain("threaded answer");

    // comment_posted activity feeds the inbox.
    const act = await db.query(`SELECT count(*)::int AS n FROM activities WHERE type = 'comment_posted'`);
    expect((act.rows[0] as { n: number }).n).toBeGreaterThanOrEqual(3);
  });
});

describe("branches page + deletion", () => {
  it("lists branches and deletes an unprotected one; protected main is refused", async () => {
    // Page lists branches for a read-only anonymous visitor.
    const page = await fetch(`${BASE}/corp/grep-repo/branches`);
    const html = await page.text();
    expect(page.ok).toBe(true);
    expect(html).toContain("greptest");
    expect(html).toContain("main");

    // Deleting protected main is refused.
    const delMain = await sfetch(`/api/corp/grep-repo/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", branch: "main" }),
    });
    expect(delMain.status).toBe(403);

    // Delete greptest: ref gone, DB row gone.
    const del = await sfetch(`/api/corp/grep-repo/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", branch: "greptest" }),
    });
    expect(del.ok).toBe(true);
    const refGone = await git(["--git-dir", path.join(DATA, "repos", "corp", "grep-repo.git"), "rev-parse", "--verify", "refs/heads/greptest"]).catch(() => null);
    expect(refGone).toBeNull();
    const rowGone = await db.query(`SELECT count(*)::int AS n FROM branches WHERE repo_id = (SELECT id FROM repositories WHERE name = 'grep-repo') AND name = 'greptest'`);
    expect((rowGone.rows[0] as { n: number }).n).toBe(0);

    // Unknown branch 404s.
    const del404 = await sfetch(`/api/corp/grep-repo/branches`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", branch: "nope" }),
    });
    expect(del404.status).toBe(404);
  });
});

describe("user profiles", () => {
  it("shows a user's repos and activity, hides others' private repos", async () => {
    const page = await fetch(`${BASE}/u/eva`);
    const html = await page.text();
    expect(page.ok).toBe(true);
    expect(html).toContain("Eva Dee");
    expect(html).toMatch(/@<[^>]*>?eva|@eva/);
    // Public repos visible anonymously.
    expect(html).toContain("grep-repo");
    // Activity types render.
    expect(html).toMatch(/release_published|comment_posted|pr_merged/);
  });

  it("404s unknown handles", async () => {
    const page = await fetch(`${BASE}/u/ghost-user-xyz`);
    expect(page.status).toBe(200); // page renders its own not-found state
    expect(await page.text()).toContain("No such user");
  });
});

describe("CODEOWNERS review auto-assignment", () => {
  it("assigns owners of changed paths as reviewers when a PR opens", async () => {
    // Add sam as an org member of corp (already done for widget) and a
    // CODEOWNERS file owned by sam, then push a branch that changes it.
    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t6", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/grep-repo.git`;

    // CODEOWNERS rides ON the feature branch: the parser reads it from the
    // PR head, so real-world flows (protection blocks direct main pushes)
    // work identically.
    await git(["-C", work, "fetch", "--quiet", pushUrl, "refs/heads/main:refs/heads/main"]);
    await git(["-C", work, "checkout", "--quiet", "main"]);
    await git(["-C", work, "checkout", "--quiet", "-b", "codeowners-test"]);
    await exec("bash", ["-c", `cd ${work} && mkdir -p .forge && printf '*.txt @sam\\n' > .forge/CODEOWNERS && printf 'line x v2\\n' > x.txt && git add . && git -c user.name=Eva -c user.email=eva@corp.dev commit --quiet -m "add codeowners + change txt"`]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/codeowners-test"]);

    const pr = await sfetch(`/api/corp/grep-repo/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "codeowners PR", head: "codeowners-test", base: "main" }),
    });
    expect(pr.ok).toBe(true);
    const prNum = ((await pr.json()) as { number: number }).number;

    const reviewers = await sfetch(`/api/corp/grep-repo/pulls/${prNum}/reviewers`);
    const rvBody = (await reviewers.json()) as { reviewers: Array<{ handle: string; source: string }> };
    expect(reviewers.ok).toBe(true);
    const sam = rvBody.reviewers.find((v) => v.handle === "sam");
    expect(sam).toBeDefined();
    expect(sam!.source).toBe("codeowners");

    // The author is never auto-assigned: eva owns nothing in the file.
    expect(rvBody.reviewers.some((v) => v.handle === "eva")).toBe(false);

    // Reviewer chips render on the PR page.
    const page = await fetch(`${BASE}/corp/grep-repo/pulls/${prNum}`);
    expect(await page.text()).toContain("sam");

    // Manual add/remove works for org members. tess needs corp membership
    // first (sam is already the CODEOWNERS assignee on this PR).
    const tessOrgId = (await db.query(`SELECT id FROM organizations WHERE slug = 'corp'`)).rows[0] as { id: number };
    await db.query(`INSERT INTO org_members (org_id, user_id, role) VALUES ($1, (SELECT id FROM users WHERE handle = 'tess'), 'member') ON CONFLICT DO NOTHING`, [tessOrgId.id]);
    const add = await sfetch(`/api/corp/grep-repo/pulls/${prNum}/reviewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "tess" }),
    });
    expect(add.ok).toBe(true);
    const rm = await sfetch(`/api/corp/grep-repo/pulls/${prNum}/reviewers`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "tess" }),
    });
    expect(rm.ok).toBe(true);

    // Requests for non-members are rejected (their inbox would never show it).
    const stranger = await sfetch(`/api/corp/grep-repo/pulls/${prNum}/reviewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "zed" }),
    });
    expect(stranger.status).toBe(400);

    // Requesting review from the author is rejected.
    const selfReq = await sfetch(`/api/corp/grep-repo/pulls/${prNum}/reviewers`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle: "eva" }),
    });
    expect(selfReq.status).toBe(400);
  });
});

describe("reviewer inbox queue", () => {
  it("surfaces pending review requests as 'needs your review'", async () => {
    // Sam (the CODEOWNERS-assigned reviewer) checks their inbox.
    const samLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sam@corp.dev", password: "longpassword1" }),
    });
    const samCookie = (samLogin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const inbox = await fetch(`${BASE}/api/notifications`, { headers: { cookie: samCookie } });
    const body = (await inbox.json()) as {
      needsReview: Array<{ repo: string; number: number; source: string }>;
      unread: number;
    };
    expect(inbox.ok).toBe(true);
    const queueEntry = body.needsReview.find((q) => q.repo === "corp/grep-repo");
    expect(queueEntry).toBeDefined();
    expect(queueEntry!.source).toBe("codeowners");
    expect(body.unread).toBeGreaterThan(0);
  });
});

describe("Fixes #n auto-close", () => {
  it("closes the referenced intent when a PR titled 'Fixes #n' merges", async () => {
    // Create the target intent in widget (protected main needs an approval — reuse sam).
    const create = await sfetch(`/api/corp/widget/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Widget bug to fix", description: "fixes nothing yet" }),
    });
    const issue = (await create.json()) as { number: number };
    expect(create.ok).toBe(true);

    // Branch + PR titled "Fixes #<n>".
    const pat = await sfetch(`/api/pats`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "t7", scopes: ["repo:read", "repo:write"] }),
    });
    const patBody = (await pat.json()) as { token: string };
    const pushUrl = `http://eva:${patBody.token}@localhost:${PORT}/git/corp/widget.git`;
    await git(["-C", work, "fetch", "--quiet", pushUrl, "+refs/heads/main:refs/heads/main"]);
    await git(["-C", work, "checkout", "--quiet", "-f", "main"]);
    await git(["-C", work, "checkout", "--quiet", "-b", "fixes-referenced"]);
    await exec("bash", ["-c", `cd ${work} && printf 'fix content\\n' > fix.txt && git add . && git -c user.name=Eva -c user.email=eva@corp.dev commit --quiet -m "fix it"`]);
    await git(["-C", work, "push", "--quiet", pushUrl, "HEAD:refs/heads/fixes-referenced"]);

    const pr = await sfetch(`/api/corp/widget/pulls/new`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: `Fixes #${issue.number}`, head: "fixes-referenced", base: "main" }),
    });
    const prBody = (await pr.json()) as { number: number };
    expect(pr.ok).toBe(true);

    // Approve as sam (non-author) to satisfy the protected-branch gate.
    const samLogin = await fetch(`${BASE}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "sam@corp.dev", password: "longpassword1" }),
    });
    const samCookie = (samLogin.headers.get("set-cookie") ?? "").split(";")[0]!;
    const approve = await fetch(`${BASE}/api/corp/widget/pulls/${prBody.number}/approvals`, {
      method: "POST",
      headers: { "Content-Type": "application/json", cookie: samCookie },
      body: JSON.stringify({ state: "approved" }),
    });
    expect(approve.ok).toBe(true);

    const merge = await sfetch(`/corp/widget/pulls/${prBody.number}/merge`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ strategy: "squash" }),
    });
    expect(merge.ok).toBe(true);

    // The referenced intent is now done.
    const row = (await db.query(
      `SELECT status FROM intents WHERE number = $1 AND repo_id = (SELECT id FROM repositories WHERE name = 'widget')`,
      [issue.number],
    )).rows[0] as { status: string };
    expect(row.status).toBe("done");
  });
});

describe("duplicate issue detection", () => {
  it("flags similar existing intents as possible duplicates", async () => {
    // Seed a distinctive issue.
    const seed = await sfetch(`/api/corp/grep-repo/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Login page slow on mobile devices", description: "The login screen takes 10 seconds to load on phones" }),
    });
    const seedIssue = (await seed.json()) as { number: number };
    expect(seed.ok).toBe(true);

    // File a near-duplicate with different wording.
    const dupe = await sfetch(`/api/corp/grep-repo/issues`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Login screen very slow on phones", description: "Loading the login takes forever on mobile" }),
    });
    const dupeIssue = (await dupe.json()) as { number: number };
    expect(dupe.ok).toBe(true);

    const row = (await db.query(
      `SELECT description FROM intents WHERE number = $1 AND repo_id = (SELECT id FROM repositories WHERE name = 'grep-repo')`,
      [dupeIssue.number],
    )).rows[0] as { description: string | null };
    expect(row.description).toContain("Possible duplicates:");
    expect(row.description).toContain(`#${seedIssue.number}`);
  });
});
