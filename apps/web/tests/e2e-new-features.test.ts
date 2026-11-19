// E2E: the social + transport + webhooks layer — stars/watchers/forks,
// SSH git transport, commit/compare pages, webhook delivery with HMAC.
// Boots its own server + DB, drives real git over both HTTP and SSH.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer, type Server } from "node:http";
import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import pg from "pg";

const exec = promisify(execFile);

const PORT = 3108;
const SSH_PORT = 3222;
const HOOK_PORT = 9898;
const BASE = `http://localhost:${PORT}`;
const TEST_DB = process.env.FORGE_TEST_DB4 ?? "forge_test4";
const ROOT = process.cwd();
const DATA = `${ROOT}/data-test4`;

let server: ReturnType<typeof spawn> | null = null;
let hookServer: Server | null = null;
const db = new pg.Client({ connectionString: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}` });

interface Delivery {
  event: string | undefined;
  signature: string | undefined;
  body: string;
}
const deliveries: Delivery[] = [];

function jarFetch(jar: { cookie: string }) {
  return async (p: string, init?: RequestInit) => {
    const res = await fetch(`${BASE}${p}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), ...(jar.cookie ? { cookie: jar.cookie } : {}) },
    });
    const setCookie = res.headers.get("set-cookie");
    if (setCookie) jar.cookie = setCookie.split(";")[0]!;
    return res;
  };
}

/** Log an existing user in, filling the jar. */
async function login(jar: { cookie: string }, email: string): Promise<void> {
  const res = await jarFetch(jar)("/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: "longpassword1" }),
  });
  expect(res.ok).toBe(true);
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

  // Local webhook receiver: records deliveries + signatures.
  hookServer = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      deliveries.push({
        event: req.headers["x-forge-event"] as string | undefined,
        signature: req.headers["x-forge-signature"] as string | undefined,
        body,
      });
      res.writeHead(200);
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => hookServer!.listen(HOOK_PORT, resolve));

  server = spawn("pnpm", ["exec", "tsx", "src/server/server.ts"], {
    cwd: ROOT,
    env: {
      ...process.env,
      DATABASE_URL: `postgresql://suryanshunabheet@localhost:5432/${TEST_DB}`,
      FORGE_STORAGE_ROOT: DATA,
      FORGE_PORT: String(PORT),
      FORGE_SSH_PORT: String(SSH_PORT),
      FORGE_HOOK_TOKEN: "test-hook-token-123",
      // tests must not pick up a real key even if the machine has one
      ANTHROPIC_API_KEY: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  server.stdout?.on("data", () => {});
  server.stderr?.on("data", () => {});
  await waitForServer();
}, 300_000);

afterAll(async () => {
  await db.end().catch(() => {});
  hookServer?.close();
  server?.kill("SIGKILL");
  // Leftover tsx/node children are swept by global-setup at the next run;
  // killing by port from inside the worker upsets the vitest IPC channel.
  await new Promise((r) => setTimeout(r, 300));
  await exec("rm", ["-rf", DATA]).catch(() => {});
});

describe("stars, watchers, forks", () => {
  const ada = { cookie: "" };
  const grace = { cookie: "" };
  let pat = "";

  beforeAll(async () => {
    const af = jarFetch(ada);
    await af("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "ada@soc.dev", name: "Ada", handle: "ada", password: "longpassword1" }),
    });
    const gf = jarFetch(grace);
    await gf("/api/auth/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "grace@soc.dev", name: "Grace", handle: "grace", password: "longpassword1" }),
    });
    const repo = await af("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "socorg", name: "widget", description: "widgets" }),
    });
    expect(repo.ok).toBe(true);
    const patRes = await af("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "test", scopes: ["repo:read", "repo:write"] }),
    });
    pat = ((await patRes.json()) as { token: string }).token;

    // Seed the repo with a commit over HTTP so it has content.
    const work = await mkdtemp(path.join(tmpdir(), "seed-"));
    await exec("git", ["clone", `${BASE}/git/socorg/widget.git`, work]);
    await writeFile(path.join(work, "hello.txt"), "hello world\n");
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.dev", "commit", "-m", "seed commit"]);
    await exec("git", ["-C", work, "push", `${BASE.replace("http://", `http://ada:${pat}@`)}/git/socorg/widget.git`, "HEAD:refs/heads/main"]);
    await rm(work, { recursive: true, force: true });
  });

  it("anonymous star/watch get 401", async () => {
    const star = await fetch(`${BASE}/api/socorg/widget/star`, { method: "POST" });
    const watch = await fetch(`${BASE}/api/socorg/widget/watch`, { method: "POST" });
    expect(star.status).toBe(401);
    expect(watch.status).toBe(401);
  });

  it("star toggles and counts", async () => {
    const af = jarFetch(ada);
    const on = await (await af("/api/socorg/widget/star", { method: "POST" })).json();
    expect(on).toMatchObject({ starred: true, stars: 1 });
    const gf = jarFetch(grace);
    const on2 = await (await gf("/api/socorg/widget/star", { method: "POST" })).json();
    expect(on2).toMatchObject({ starred: true, stars: 2 });
    const off = await (await af("/api/socorg/widget/star", { method: "POST" })).json();
    expect(off).toMatchObject({ starred: false, stars: 1 });
  });

  it("watch toggles and counts", async () => {
    const gf = jarFetch(grace);
    const on = await (await gf("/api/socorg/widget/watch", { method: "POST" })).json();
    expect(on).toMatchObject({ watching: true, watchers: 1 });
    const off = await (await gf("/api/socorg/widget/watch", { method: "POST" })).json();
    expect(off).toMatchObject({ watching: false, watchers: 0 });
  });

  it("fork creates a mirror under the forker's personal org with lineage", async () => {
    const gf = jarFetch(grace);
    const fork = await gf("/api/socorg/widget/fork", { method: "POST" });
    expect(fork.ok).toBe(true);
    const data = (await fork.json()) as { orgSlug: string; name: string };
    expect(data.orgSlug).toBe("grace");
    expect(data.name).toBe("widget");

    // The fork page renders and shows the lineage.
    const page = await gf(`/grace/widget`);
    const html = await page.text();
    expect(page.status).toBe(200);
    expect(html).toContain("forked from");
    expect(html).toContain("socorg/widget");

    // The fork's bare repo exists with main present.
    const refs = await exec("git", [
      "--git-dir", path.join(DATA, "repos", "grace", "widget.git"),
      "rev-parse", "--verify", "refs/heads/main",
    ]);
    expect(refs.stdout.trim()).toHaveLength(40);

    // Fork count visible on the source page.
    const srcPage = await jarFetch(ada)("/socorg/widget");
    const srcHtml = await srcPage.text();
    expect(srcHtml).toContain("Fork");
  });

  it("cannot fork twice into a collision (name-suffixed instead)", async () => {
    const af = jarFetch(ada);
    const fork = await af("/api/socorg/widget/fork", { method: "POST" });
    const data = (await fork.json()) as { name: string };
    // ada forks socorg/widget as ada/widget; grace's fork doesn't collide.
    expect(data.name).toBe("widget");
    // A second fork by the same user collides → suffixed name.
    const fork2 = await af("/api/socorg/widget/fork", { method: "POST" });
    const data2 = (await fork2.json()) as { name: string };
    expect(data2.name).toBe("widget-2");
  });
});

describe("commit & compare pages", () => {
  const ada = { cookie: "" };
  let sha = "";
  let pat = "";

  beforeAll(async () => {
    // Continue from the socorg/widget repo: add a second commit on a branch.
    await login(ada, "ada@soc.dev");
    const af = jarFetch(ada);
    const patRes = await af("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "cmp", scopes: ["repo:read", "repo:write"] }),
    });
    pat = ((await patRes.json()) as { token: string }).token;
    expect(pat).toBeTruthy();

    const work = await mkdtemp(path.join(tmpdir(), "cmp-"));
    await exec("git", ["clone", `${BASE}/git/socorg/widget.git`, work]);
    await writeFile(path.join(work, "feature.txt"), "feature work\n");
    await exec("git", ["-C", work, "checkout", "-b", "feature-x"]);
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.dev", "commit", "-m", "feature commit"]);
    const out = await exec("git", ["-C", work, "rev-parse", "HEAD"]);
    sha = out.stdout.trim();
    await exec("git", ["-C", work, "push", `${BASE.replace("http://", `http://ada:${pat}@`)}/git/socorg/widget.git`, "HEAD:refs/heads/feature-x"]);
    await rm(work, { recursive: true, force: true });
  });

  it("commits list page renders with commit links", async () => {
    const res = await jarFetch(ada)("/socorg/widget/commits");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("seed commit");
    expect(html).toMatch(/commits\/[0-9a-f]{7,40}/);
  });

  it("commit detail page shows the diff and parent link", async () => {
    const res = await jarFetch(ada)(`/socorg/widget/commits/${sha}`);
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("feature commit");
    expect(html).toContain("feature.txt");
    expect(html).toContain("feature work"); // diff body line
  });

  it("commit page rejects invalid shas", async () => {
    const res = await jarFetch(ada)("/socorg/widget/commits/zzz-not-a-sha");
    expect(res.status).toBe(200); // page renders…
    const html = await res.text();
    expect(html).toContain("invalid commit id"); // …with the rejection message
  });

  it("compare page shows commits + diff between branches", async () => {
    const res = await jarFetch(ada)("/socorg/widget/compare?base=main&head=feature-x");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("will merge into");
    expect(html).toContain("feature commit");
    expect(html).toContain("feature.txt");
  });

  it("compare with identical branches renders the empty state", async () => {
    const res = await jarFetch(ada)("/socorg/widget/compare?base=main&head=main");
    const html = await res.text();
    expect(res.status).toBe(200);
    expect(html).toContain("Pick two different branches");
  });
});

describe("SSH transport", () => {
  const ada = { cookie: "" };
  let keyDir = "";

  beforeAll(async () => {
    // Upload an SSH key for ada.
    await login(ada, "ada@soc.dev");
    keyDir = await mkdtemp(path.join(tmpdir(), "sshkey-"));
    await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path.join(keyDir, "id_ed25519"), "-q"]);
    const pub = await exec("cat", [path.join(keyDir, "id_ed25519.pub")]);
    const af = jarFetch(ada);
    const add = await af("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "test-key", publicKey: pub.stdout.trim() }),
    });
    expect(add.ok).toBe(true);
  });

  it("clones a public repo over SSH with the registered key", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "ssh-clone-"));
    const ssh = `ssh -i ${path.join(keyDir, "id_ed25519")} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    await exec("git", ["clone", `ssh://git@localhost:${SSH_PORT}/socorg/widget.git`, work], {
      env: { ...process.env, GIT_SSH_COMMAND: ssh },
    });
    const out = await exec("git", ["-C", work, "log", "--oneline"]);
    expect(out.stdout).toContain("seed commit");
    await rm(work, { recursive: true, force: true });
  });

  it("pushes over SSH and the DB syncs through the hook chain", async () => {
    const work = await mkdtemp(path.join(tmpdir(), "ssh-push-"));
    const ssh = `ssh -i ${path.join(keyDir, "id_ed25519")} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    await exec("git", ["clone", `ssh://git@localhost:${SSH_PORT}/socorg/widget.git`, work], {
      env: { ...process.env, GIT_SSH_COMMAND: ssh },
    });
    await exec("git", ["-C", work, "checkout", "-b", "ssh-branch"]);
    await writeFile(path.join(work, "ssh.txt"), "via ssh\n");
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.dev", "commit", "-m", "ssh push commit"]);
    await exec("git", ["-C", work, "push", "origin", "ssh-branch"], {
      env: { ...process.env, GIT_SSH_COMMAND: ssh },
    });
    // post-receive fired: branch is in the DB.
    await new Promise((r) => setTimeout(r, 1000));
    const rows = await db.query("SELECT name FROM branches WHERE name = 'ssh-branch'");
    expect(rows.rows.length).toBe(1);
    await rm(work, { recursive: true, force: true });
  });

  it("rejects an unknown key", async () => {
    const strangerDir = await mkdtemp(path.join(tmpdir(), "stranger-"));
    await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path.join(strangerDir, "id_ed25519"), "-q"]);
    const ssh = `ssh -i ${path.join(strangerDir, "id_ed25519")} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    const work = await mkdtemp(path.join(tmpdir(), "ssh-deny-"));
    await expect(exec("git", ["clone", `ssh://git@localhost:${SSH_PORT}/socorg/widget.git`, work], {
      env: { ...process.env, GIT_SSH_COMMAND: ssh },
    })).rejects.toThrow();
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(strangerDir, { recursive: true, force: true });
  });

  it("a non-member's key cannot clone a private repo over SSH", async () => {
    // Make a private repo owned by ada; grace's key is not a member's key…
    // but grace IS registered with a key? No — only ada uploaded one. So:
    // upload a key for grace, then confirm grace can't clone ada's private repo.
    await login(ada, "ada@soc.dev");
    const af = jarFetch(ada);
    await af("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ orgSlug: "socorg", name: "vault", visibility: "private" }),
    });
    await login(grace0, "grace@soc.dev");
    const gf = jarFetch(grace0);
    const gk = await mkdtemp(path.join(tmpdir(), "gracekey-"));
    await exec("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", path.join(gk, "id_ed25519"), "-q"]);
    const gpub = await exec("cat", [path.join(gk, "id_ed25519.pub")]);
    await gf("/api/keys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "grace-key", publicKey: gpub.stdout.trim() }),
    });
    const ssh = `ssh -i ${path.join(gk, "id_ed25519")} -p ${SSH_PORT} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null`;
    const work = await mkdtemp(path.join(tmpdir(), "ssh-priv-"));
    await expect(exec("git", ["clone", `ssh://git@localhost:${SSH_PORT}/socorg/vault.git`, work], {
      env: { ...process.env, GIT_SSH_COMMAND: ssh },
    })).rejects.toThrow();
    await rm(work, { recursive: true, force: true }).catch(() => {});
    await rm(gk, { recursive: true, force: true }).catch(() => {});
  });
});

// grace's jar shared across describes (registered in the stars describe).
const grace0 = { cookie: "" };

describe("webhooks", () => {
  const ada = { cookie: "" };
  let secret = "";

  beforeAll(async () => {
    await login(ada, "ada@soc.dev");
    const af = jarFetch(ada);
    const res = await af("/api/socorg/widget/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: `http://localhost:${HOOK_PORT}/hooks`, events: ["push", "pull_request", "pr_merged", "ping"] }),
    });
    const data = (await res.json()) as { secret?: string; id?: number };
    expect(data.secret).toBeTruthy();
    secret = data.secret!;
  });

  it("ping event is delivered on creation with a valid HMAC signature", async () => {
    await new Promise((r) => setTimeout(r, 1000));
    const ping = deliveries.find((d) => d.event === "ping");
    expect(ping).toBeTruthy();
    const expected = `sha256=${createHmac("sha256", secret).update(ping!.body, "utf8").digest("hex")}`;
    expect(ping!.signature).toBe(expected);
  });

  it("push triggers a signed push webhook with commit list", async () => {
    deliveries.length = 0;
    const work = await mkdtemp(path.join(tmpdir(), "wh-"));
    await exec("git", ["clone", `${BASE}/git/socorg/widget.git`, work]);
    await writeFile(path.join(work, "hook.txt"), "hooked\n");
    await exec("git", ["-C", work, "checkout", "-b", "hook-branch"]);
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.dev", "commit", "-m", "hook push"]);
    const patRes = await (await jarFetch(ada)("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "wh", scopes: ["repo:read", "repo:write"] }),
    })).json();
    await exec("git", ["-C", work, "push", `${BASE.replace("http://", `http://ada:${(patRes as { token: string }).token}@`)}/git/socorg/widget.git`, "HEAD:refs/heads/hook-branch"]);
    await rm(work, { recursive: true, force: true });

    await new Promise((r) => setTimeout(r, 1500));
    const push = deliveries.find((d) => d.event === "push");
    expect(push).toBeTruthy();
    const payload = JSON.parse(push!.body) as { ref?: string; commits?: Array<{ message: string }> };
    expect(payload.ref).toBe("refs/heads/hook-branch");
    expect(payload.commits?.some((c) => c.message === "hook push")).toBe(true);
    const expected = `sha256=${createHmac("sha256", secret).update(push!.body, "utf8").digest("hex")}`;
    expect(push!.signature).toBe(expected);
  });

  it("hook list requires write access; deliveries are recorded", async () => {
    const af = jarFetch(ada);
    const list = await af("/api/socorg/widget/hooks");
    const data = (await list.json()) as { webhooks: Array<{ url: string; deliveries: Array<{ event: string; status: string }> }> };
    expect(list.ok).toBe(true);
    expect(data.webhooks.length).toBeGreaterThan(0);
    const hook = data.webhooks[0]!;
    expect(hook.url).toContain(`:${HOOK_PORT}`);
    expect(hook.deliveries.some((d) => d.event === "push" && d.status === "delivered")).toBe(true);

    // Anonymous listing is rejected.
    const anon = await fetch(`${BASE}/api/socorg/widget/hooks`);
    expect(anon.status).toBe(401);
  });

  it("hook creation rejects non-http(s) URLs", async () => {
    const af = jarFetch(ada);
    const res = await af("/api/socorg/widget/hooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "file:///etc/passwd", events: ["push"] }),
    });
    expect(res.status).toBe(400);
  });

  it("deleting a hook stops deliveries", async () => {
    const af = jarFetch(ada);
    const list = await (await af("/api/socorg/widget/hooks")).json() as { webhooks: Array<{ id: number }> };
    const id = list.webhooks[0]!.id;
    deliveries.length = 0;
    const del = await af("/api/socorg/widget/hooks", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    expect(del.ok).toBe(true);

    // Push again — no delivery should arrive.
    const work = await mkdtemp(path.join(tmpdir(), "wh2-"));
    await exec("git", ["clone", `${BASE}/git/socorg/widget.git`, work]);
    await writeFile(path.join(work, "after-delete.txt"), "x\n");
    await exec("git", ["-C", work, "checkout", "-b", "silent-branch"]);
    await exec("git", ["-C", work, "add", "."]);
    await exec("git", ["-C", work, "-c", "user.name=T", "-c", "user.email=t@t.dev", "commit", "-m", "silent push"]);
    const patRes = await (await jarFetch(ada)("/api/pats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "wh2", scopes: ["repo:read", "repo:write"] }),
    })).json();
    await exec("git", ["-C", work, "push", `${BASE.replace("http://", `http://ada:${(patRes as { token: string }).token}@`)}/git/socorg/widget.git`, "HEAD:refs/heads/silent-branch"]);
    await rm(work, { recursive: true, force: true });

    await new Promise((r) => setTimeout(r, 1500));
    expect(deliveries.filter((d) => d.event === "push")).toHaveLength(0);
  });
});
