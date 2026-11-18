// Seed: demo org, users, repos, intents, PRs — deterministic + idempotent.
// Creates a PAT named "seed" (printed once) and a deliberately vulnerable
// branch that the autonomous reviewer will flag on push.

import { and, eq, sql } from "drizzle-orm";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, rm, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { db, users, organizations, repositories, intents } from "@forge/db";
import { hashPassword, createPat } from "@forge/db";
import { initBareRepo, repoGitDir } from "@forge/git";

const exec = promisify(execFile);

async function upsertUser(email: string, name: string, handle: string) {
  const existing = (await db.select().from(users).where(eq(users.email, email)).limit(1))[0];
  if (existing) return existing;
  const [u] = await db.insert(users).values({ email, name, handle, passwordHash: hashPassword("password123") })
    .returning({ id: users.id, email: users.email, name: users.name, handle: users.handle });
  return u!;
}

async function main() {
  console.log("[seed] ensuring users…");
  const ada = await upsertUser("ada@acme.dev", "Ada Lovelace", "ada");
  const grace = await upsertUser("grace@acme.dev", "Grace Hopper", "grace");

  // Fresh PAT for git pushes (revokes nothing; name is stable so re-runs are visible)
  const { token } = await createPat(ada.id, "seed", ["repo:read", "repo:write"]);

  console.log("[seed] ensuring org + repo…");
  let org = (await db.select().from(organizations).where(eq(organizations.slug, "acme")).limit(1))[0];
  if (!org) {
    [org] = await db.insert(organizations).values({ slug: "acme", name: "ACME Corp", ownerId: ada.id })
      .returning();
  }
  let repo = (await db.select().from(repositories)
    .where(and(eq(repositories.orgId, org.id), eq(repositories.name, "iris"))).limit(1))[0];
  if (!repo) {
    [repo] = await db.insert(repositories).values({
      orgId: org.id, name: "iris", description: "Iris — authentication service", visibility: "public",
    }).returning();
  }

  // Idempotent intents
  for (const it of [
    { number: 3, title: "Add admin token revocation endpoint", description: "Admins need the ability to revoke sessions by user id. Must check admin privileges before revoking.", kind: "intent" as const, labels: ["security", "api"], authorId: grace.id },
    { number: 4, title: "Rate-limit login attempts", description: "5 attempts per minute per IP, then 429 with Retry-After.", kind: "issue" as const, labels: ["reliability"], authorId: ada.id },
  ]) {
    const existing = (await db.select({ id: intents.id }).from(intents)
      .where(and(eq(intents.repoId, repo.id), eq(intents.number, it.number))).limit(1))[0];
    if (!existing) {
      const { number: _n, ...rest } = it;
      await db.insert(intents).values({ repoId: repo.id, number: it.number, ...rest });
    }
  }

  console.log("[seed] initializing bare repo + pushing commits…");
  await initBareRepo("acme", "iris");
  const gitDir = repoGitDir("acme", "iris");

  const work = await mkdtemp(path.join(tmpdir(), "forge-seed-"));
  try {
    // Only push main if the repo is empty (idempotent on re-runs)
    const hasMain = await exec("git", ["--git-dir", gitDir, "rev-parse", "--verify", "--quiet", "main"])
      .then(() => true).catch(() => false);

    if (!hasMain) {
      await exec("git", ["clone", "--quiet", gitDir, work]);
      const git = ["-C", work];
      await mkdir(path.join(work, "src"), { recursive: true });
      await mkdir(path.join(work, "docs"), { recursive: true });

      await writeFile(path.join(work, "src", "auth.ts"),
`// Iris auth service — session issuance & verification.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export interface Session { userId: number; token: string; expiresAt: Date }

const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;

export function issueSession(userId: number): Session {
  const token = randomBytes(32).toString("hex");
  return { userId, token, expiresAt: new Date(Date.now() + SESSION_TTL_MS) };
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function verifySession(stored: string, presented: string): boolean {
  const a = Buffer.from(stored, "hex");
  const b = Buffer.from(hashToken(presented), "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

// Failure modes: expired sessions are rejected by callers checking expiresAt.
export function isExpired(s: Session): boolean {
  return s.expiresAt.getTime() <= Date.now();
}
`);
      await writeFile(path.join(work, "docs", "architecture.md"),
`# Iris architecture

## Auth

Sessions are issued by \`issueSession\` in \`src/auth.ts\`. Tokens are stored hashed (sha256).

## Failure

\`isExpired\` guards expiry; callers reject expired sessions with 401.
`);
      await writeFile(path.join(work, "package.json"), JSON.stringify({
        name: "iris", version: "0.1.0", private: true,
        scripts: { build: "echo iris build ok", test: "echo no tests yet" },
      }, null, 2));
      await writeFile(path.join(work, "README.md"), "# Iris\n\nAuth service for ACME.\n");

      await exec("git", [...git, "add", "."]);
      await exec("git", [...git, "-c", "user.name=Ada Lovelace", "-c", "user.email=ada@acme.dev", "commit", "--quiet", "-m", "feat: core session auth"]);
      await exec("git", [...git, "push", "--quiet", gitDir, "HEAD:refs/heads/main"]);

      // Vulnerable draft branch (secrets + eval) for the reviewer to catch on PR push.
      await writeFile(path.join(work, "src", "revoke.ts"),
`// Admin session revocation endpoint (draft).
const ADMIN_TOKEN = "ghp_9f8e7d6c5b4a321987654321abcdef";
export function revoke(userId: number, rawInput: string) {
  eval("revoked.add(" + rawInput + ")");
  return userId;
}
`);
      await exec("git", [...git, "add", "."]);
      await exec("git", [...git, "-c", "user.name=Grace Hopper", "-c", "user.email=grace@acme.dev", "commit", "--quiet", "-m", "wip: revocation endpoint"]);
      await exec("git", [...git, "push", "--quiet", gitDir, "HEAD:refs/heads/i3-admin-revocation"]);
      await exec("git", [...git, "checkout", "--quiet", "main"]);
    }
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }

  console.log("[seed] done.");
  console.log(`  users:    ada@acme.dev / password123, grace@acme.dev / password123`);
  console.log(`  repo:     http://localhost:3000/acme/iris`);
  console.log(`  PAT:      ${token}`);
  console.log(`  git:      git clone http://ada:${token}@localhost:3000/git/acme/iris.git`);
}

main().then(() => process.exit(0)).catch((err) => {
  console.error("[seed] failed:", err);
  process.exit(1);
});
