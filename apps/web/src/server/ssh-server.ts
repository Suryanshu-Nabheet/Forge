// Forge SSH transport: git@forge:org/repo.git clone/push over SSH,
// authenticated against the SSH public keys users have uploaded.
//
// Design: ssh2 server on FORGE_SSH_PORT (default 2222; 0 disables).
// Session exec requests follow the standard git-over-SSH convention:
//   git-upload-pack /<org>/<repo>.git    (fetch)
//   git-receive-pack /<org>/<repo>.git   (push)
// The request is authorized (key identity → user → repo ACL), then piped
// to the real git-upload-pack / git-receive-pack processes with the bare
// repo as cwd — the same hook chain (pre-receive/post-receive) fires as
// over HTTP, so branch protection and DB sync work identically.

import { spawn, execFileSync } from "node:child_process";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { db, sshKeys, organizations, repositories, orgMembers, users } from "@forge/db";
import { repoGitDir } from "@forge/git";
import ssh2 from "ssh2";
import type { ParsedKey, Server, ServerChannel } from "ssh2";

// ssh2 is CJS: its named exports (utils, Server) live on the default interop.
const { utils, Server: SshServer } = ssh2 as unknown as {
  utils: { parseKey(data: string | Buffer): ParsedKey | Error };
  Server: new (options: { hostKeys: Buffer[] }) => Server;
};

const SSH_PORT = Number(process.env.FORGE_SSH_PORT ?? 2222);

// git sends e.g.:  git-upload-pack '/org/repo.git'   (single-quoted, leading /)
const GIT_CMD_RE = /^(git-upload-pack|git-receive-pack)\s+'?\/?([a-z0-9][a-z0-9-]{0,38})\/([a-z0-9][a-z0-9_.-]{0,99})\.git'?$/
  ;

interface SshUser {
  userId: number;
  handle: string;
  keyId: number;
}

/** Parse a stored public-key line into a ParsedKey (null when unparsable). */
function parseStoredKey(publicKey: string): ParsedKey | null {
  const parsed = utils.parseKey(publicKey);
  return parsed instanceof Error ? null : parsed;
}

/** Find the user that owns the exact public key blob presented by the client. */
async function userForClientKey(data: Buffer): Promise<SshUser | null> {
  const rows = await db
    .select({
      keyId: sshKeys.id,
      publicKey: sshKeys.publicKey,
      userId: sshKeys.userId,
    })
    .from(sshKeys);
  for (const row of rows) {
    const stored = parseStoredKey(row.publicKey);
    if (!stored) continue;
    if (stored.getPublicSSH().equals(data)) {
      const u = (await db
        .select({ id: users.id, handle: users.handle })
        .from(users)
        .where(eq(users.id, row.userId))
        .limit(1))[0];
      if (u) return { userId: u.id, handle: u.handle, keyId: row.keyId };
    }
  }
  return null;
}

/** Repo ACL check for the authenticated SSH user. */
async function authorizeRepo(
  userId: number,
  command: "git-upload-pack" | "git-receive-pack",
  orgSlug: string,
  repoName: string,
): Promise<{ ok: true; gitDir: string } | { ok: false; reason: string }> {
  const rows = await db
    .select({
      orgId: repositories.orgId,
      visibility: repositories.visibility,
      ownerId: organizations.ownerId,
    })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(and(eq(organizations.slug, orgSlug), eq(repositories.name, repoName)))
    .limit(1);
  const repo = rows[0];
  if (!repo) return { ok: false, reason: "repository not found" };
  const gitDir = repoGitDir(orgSlug, repoName);

  // Membership: org owner or org_members row.
  const member = await db
    .select({ id: orgMembers.id })
    .from(orgMembers)
    .where(and(eq(orgMembers.orgId, repo.orgId), eq(orgMembers.userId, userId)))
    .limit(1);
  const isMember = member.length > 0 || repo.ownerId === userId;

  // Fetch: public → anyone with a valid key; private → members only.
  if (command === "git-upload-pack") {
    if (repo.visibility === "private" && !isMember) {
      return { ok: false, reason: "access denied: not a member of this organization" };
    }
    return { ok: true, gitDir };
  }

  // Push: members only (mirrors the HTTP transport's write policy).
  if (!isMember) return { ok: false, reason: "access denied: not a member of this organization" };
  return { ok: true, gitDir };
}

/** Generate the ed25519 host key on first boot; reuse afterwards. */
function ensureHostKey(): string {
  const keyPath = path.join(
    path.resolve(process.env.FORGE_STORAGE_ROOT ?? "data"),
    "ssh_host_ed25519_key",
  );
  if (!existsSync(keyPath)) {
    mkdirSync(path.dirname(keyPath), { recursive: true });
    execFileSync("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", keyPath, "-C", "forge-host"]);
  }
  return keyPath;
}

/** Boot the SSH transport server. No-op when FORGE_SSH_PORT=0. */
export function startSshServer(): void {
  if (!Number.isFinite(SSH_PORT) || SSH_PORT <= 0) {
    console.log("[ssh] transport disabled (FORGE_SSH_PORT=0)");
    return;
  }
  let server: Server;
  try {
    server = new SshServer({ hostKeys: [readFileSync(ensureHostKey())] });
  } catch (err) {
    console.error("[ssh] failed to start:", err);
    return;
  }

  server.on("connection", (conn) => {
    let user: SshUser | null = null;

    conn.on("authentication", (ctx) => {
      if (ctx.method !== "publickey") {
        ctx.reject(["publickey"]);
        return;
      }
      void (async () => {
        const match = await userForClientKey(ctx.key.data);
        if (!match) {
          ctx.reject(["publickey"]);
          return;
        }
        if (ctx.signature) {
          // Full auth: verify the signature over the session blob with the stored key.
          const keyRow = (await db
            .select({ publicKey: sshKeys.publicKey })
            .from(sshKeys)
            .where(eq(sshKeys.id, match.keyId))
            .limit(1))[0];
          const stored = keyRow ? parseStoredKey(keyRow.publicKey) : null;
          let verified = false;
          try {
            verified = Boolean(stored && ctx.blob && stored.verify(ctx.blob, ctx.signature));
          } catch (err) {
            console.error("[ssh] signature verify threw:", err);
            verified = false;
          }
          if (!verified) {
            ctx.reject(["publickey"]);
            return;
          }
          // Only a VERIFIED signature grants the session user. Unsigned
          // probes get PK-OK and never populate `user`.
          user = match;
        }
        ctx.accept();
      })();
    });

    conn.on("session", (acceptSession) => {
      const session = acceptSession();
      // git protocol v2 negotiation arrives as a session env var (SendEnv=GIT_PROTOCOL)
      let gitProtocol: string | undefined;
      session.on("env", (acceptEnv, _reject, info) => {
        if (process.env.FORGE_SSH_DEBUG) {
          console.log(`[ssh] env: ${info.key}=${info.val}`);
        }
        if (info.key === "GIT_PROTOCOL" && typeof info.val === "string") {
          gitProtocol = info.val;
        }
        if (acceptEnv) acceptEnv();
      });
      session.on("exec", (accept, reject, info) => {
        if (!user) {
          reject();
          return;
        }
        const cmd = (info.command ?? "").trim();
        const m = GIT_CMD_RE.exec(cmd);
        if (!m) {
          const chan = accept();
          chan.write(`forge: unsupported command: ${cmd}\n`);
          chan.exit(1);
          chan.end();
          return;
        }
        const gitCmd = m[1] as "git-upload-pack" | "git-receive-pack";
        const orgSlug = m[2]!;
        const repoName = m[3]!;
        void handleGitOverSsh(accept, user, gitCmd, orgSlug, repoName, gitProtocol);
      });
    });
  });

  server.listen(SSH_PORT, () => {
    console.log(`[ssh] git transport listening on ssh://localhost:${SSH_PORT}`);
  });
  server.on("error", (err: Error) => {
    console.error("[ssh] server error:", err.message);
  });
}

async function handleGitOverSsh(
  accept: () => ServerChannel,
  user: SshUser,
  gitCmd: "git-upload-pack" | "git-receive-pack",
  orgSlug: string,
  repoName: string,
  gitProtocol?: string,
): Promise<void> {
  const auth = await authorizeRepo(user.userId, gitCmd, orgSlug, repoName);
  if (!auth.ok) {
    const chan = accept();
    chan.write(`forge: ${auth.reason}\n`);
    chan.exit(1);
    chan.end();
    return;
  }

  const chan = accept();
  // Same env contract as the HTTP CGI bridge so hooks fire identically.
  // cwd is the bare repo; "." is the repo argument (relative to cwd).
  const child = spawn(gitCmd, ["."], {
    cwd: auth.gitDir,
    env: {
      ...process.env,
      GIT_DIR: auth.gitDir,
      LC_ALL: "C",
      // git protocol v2 negotiation (SendEnv=GIT_PROTOCOL from the client)
      ...(gitProtocol ? { GIT_PROTOCOL: gitProtocol } : {}),
      // Hooks read these:
      FORGE_HOOK_TOKEN: process.env.FORGE_HOOK_TOKEN ?? "",
      FORGE_POST_RECEIVE_URL: process.env.FORGE_POST_RECEIVE_URL ?? "",
      // Authenticated users still cannot bypass protected-branch PR rules.
      FORGE_ALLOW_PROTECTED_BRANCH_PUSH: "",
    },
  });

  if (process.env.FORGE_SSH_DEBUG) {
    console.log(`[ssh] ${gitCmd} ${orgSlug}/${repoName} pid=${child.pid} gitProtocol=${gitProtocol ?? "v0"}`);
    child.stderr.on("data", (d: Buffer) => console.log(`[ssh] child stderr:`, d.toString().trim()));
    child.on("exit", (code) => console.log(`[ssh] child exit ${code}`));
  }

  chan.pipe(child.stdin);

  // Only send exit-status after the final data has flushed to the client;
  // ssh2 delivers channel messages in order, so an early chan.exit() can
  // reach the git client before the pack bytes do → "remote transport
  // reported error". 'finish' fires when all pipe data has been written.
  const done = (code: number | null) => {
    try {
      chan.exit(code ?? 0);
      chan.end();
    } catch { /* channel may already be closed by client */ }
  };

  child.stdout.pipe(chan, { end: false });
  child.stderr.pipe(chan.stderr, { end: false });
  child.stdout.on("end", () => {
    // stdout drained; give stderr a beat to flush before closing.
    setImmediate(() => done(child.exitCode));
  });

  child.on("error", () => done(1));
  const killChild = () => child.kill("SIGTERM");
  chan.on("close", killChild);
  chan.on("error", killChild);
}
