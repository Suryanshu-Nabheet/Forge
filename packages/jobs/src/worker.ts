// In-process background worker: claims jobs from the Postgres queue and runs them.
// Runs inside the dev server process (one-command story) and is also the
// standalone worker entry (apps/worker) for production splits.

import { and, eq, sql } from "drizzle-orm";
import { db } from "@forge/db";
import { jobQueue, jobRuns, jobEvents, pullRequests, reviewComments, repositories, embeddings, previews, organizations, intents } from "@forge/db";
import { repoGitDir } from "@forge/git";
import { analyzeDiffForReview, answerQuestion, generatePlan, embedChunks } from "@forge/ai";
import { diffCommits, revParse, catFileText, lsTree, defaultBranch } from "@forge/git";
import type { DiffFile, CodeChunk } from "@forge/shared";

const WORKER_ID = `worker-${process.pid}`;
const POLL_MS = 500;
const CLAIM_LIMIT = 5;

let running = false;

export type SsePublishFn = (channel: string, event: string, data: unknown) => void;

let ssePublish: SsePublishFn = () => {};

export async function startWorker(publish?: SsePublishFn): Promise<void> {
  if (running) return;
  if (publish) ssePublish = publish;
  running = true;
  console.log(`[worker:${WORKER_ID}] started`);
  void pollLoop();
}

export async function stopWorker(): Promise<void> {
  running = false;
}

async function pollLoop(): Promise<void> {
  while (running) {
    try {
      const claimed = await claimJobs();
      if (claimed.length === 0) {
        await sleep(POLL_MS);
      }
      // jobs already run inline above
    } catch (err) {
      console.error("[worker] poll error:", err);
      await sleep(2000);
    }
  }
}

async function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

interface ClaimedJob {
  id: number;
  queue: string;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

async function claimJobs(): Promise<ClaimedJob[]> {
  // Reclaim jobs stuck in 'active' (worker died mid-run) after a grace period.
  await db.execute(sql`
    UPDATE job_queue SET status = 'queued', locked_at = NULL, locked_by = NULL
    WHERE status = 'active' AND locked_at < now() - interval '10 minutes'
      AND locked_by <> ${WORKER_ID}
  `);

  // Atomic claim: FOR UPDATE SKIP LOCKED via a single UPDATE ... RETURNING
  const claimed = await db.execute(sql`
    UPDATE job_queue SET status = 'active', locked_at = now(), locked_by = ${WORKER_ID}, attempts = attempts + 1
    WHERE id IN (
      SELECT id FROM job_queue
      WHERE status = 'queued' AND run_at <= now()
      ORDER BY id
      FOR UPDATE SKIP LOCKED
      LIMIT ${CLAIM_LIMIT}
    )
    RETURNING id, queue, payload, attempts, max_attempts
  `);
  const rows = (claimed.rows ?? []) as unknown as ClaimedJob[];
  for (const job of rows) {
    void runJob(job).catch((err) => {
      console.error(`[worker] job ${job.id} crashed:`, err);
    });
  }
  return rows;
}

async function runJob(job: Job): Promise<void> {
  const { id, queue, payload, attempts, maxAttempts } = job;
  // job_run row for observability
  const [run] = await db.insert(jobRuns).values({
    jobQueueId: id,
    type: queue as never,
    payload,
    status: "running",
  }).returning({ id: jobRuns.id });
  if (!run) throw new Error("job run insert failed");
  const runId = run.id;

  const startedAt = Date.now();
  try {
    const result = await dispatch(queue, payload, runId);
    await db.update(jobQueue).set({ status: "done", result: { ok: true } }).where(eq(jobQueue.id, id));
    await db.update(jobRuns).set({ status: "done", result: result ?? { ok: true }, finishedAt: new Date(), }).where(eq(jobRuns.id, runId));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[worker] job ${id} (${queue}) failed:`, message);
    const willRetry = attempts < maxAttempts;
    await db.update(jobQueue).set({
      status: willRetry ? "queued" : "failed",
      error: message,
      runAt: new Date(Date.now() + backoffMs(attempts)),
      lockedAt: null,
    }).where(eq(jobQueue.id, id));
    await db.update(jobRuns).set({ status: "failed", error: message, finishedAt: new Date() }).where(eq(jobRuns.id, runId));
  }
}

function backoffMs(attempts: number): number {
  return Math.min(60_000, 1000 * 2 ** attempts);
}

type Job = ClaimedJob;

interface JobResult { [k: string]: unknown }

async function dispatch(queue: string, payload: Record<string, unknown>, runId: number): Promise<JobResult | null> {
  switch (queue) {
    case "pr_review":
      return runPrReview(payload as { repoId: number; prId: number }, runId);
    case "semantic_index":
      return runSemanticIndex(payload as { repoId: number; branch: string; commitSha: string }, runId);
    case "qa_answer":
      return runQaAnswer(payload as { repoId: number; branch: string; question: string; askerId: number | null }, runId);
    case "intent_plan":
      return runIntentPlan(payload as { repoId: number; intentId: number }, runId);
    case "preview_build":
      return runPreviewBuild(payload as { repoId: number; prId: number; commitSha: string; branch: string }, runId);
    default:
      throw new Error(`unknown queue: ${queue}`);
  }
}

async function logEvent(runId: number, level: "info" | "warn" | "error", message: string, prId?: number): Promise<void> {
  await db.insert(jobEvents).values({ jobRunId: runId, level, message });
  ssePublish(`job-${runId}`, "log", { level, message });
  if (prId) ssePublish(`pr-${prId}`, "log", { level, message });
  ssePublish(`pr-activity`, "tick", { runId, prId: prId ?? null });
}

// ---------- job implementations ----------

// Serialize AI-review writes per PR: overlapping runs must not interleave
// delete/insert of ai_review comments (duplicated or halved comment sets).
const reviewLocks = new Map<number, Promise<unknown>>();

async function runPrReview(payload: { repoId: number; prId: number }, runId: number): Promise<JobResult> {
  const prev = reviewLocks.get(payload.prId) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(() => runPrReviewInner(payload, runId));
  reviewLocks.set(payload.prId, next);
  try {
    return await next;
  } finally {
    if (reviewLocks.get(payload.prId) === next) reviewLocks.delete(payload.prId);
  }
}

async function runPrReviewInner(payload: { repoId: number; prId: number }, runId: number): Promise<JobResult> {
  const prRows = await db.select().from(pullRequests).where(eq(pullRequests.id, payload.prId)).limit(1);
  const pr = prRows[0];
  if (!pr) throw new Error(`pr ${payload.prId} not found`);
  const repoRows = await db
    .select({ name: repositories.name, slug: organizations.slug, defaultBranch: repositories.defaultBranch })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(eq(repositories.id, pr.repoId))
    .limit(1);
  const repo = repoRows[0];
  if (!repo) throw new Error(`repo ${pr.repoId} not found`);
  const gitDir = repoGitDir(repo.slug, repo.name);

  await logEvent(runId, "info", `Reviewing PR #${pr.number}: ${pr.title}`, pr.id);
  const baseSha = pr.baseSha ?? (await revParse(gitDir, pr.baseBranch));
  const headSha = pr.headSha;
  if (!baseSha || !headSha) throw new Error("cannot resolve base/head shas");
  const diff: DiffFile[] = await diffCommits(gitDir, baseSha, headSha);

  const analysis = await analyzeDiffForReview(diff);
  await logEvent(runId, "info", `Analysis complete: ${analysis.findings.length} findings, risk ${analysis.riskScore}/100 (${analysis.mode} mode)`, pr.id);

  // Remove previous AI review comments, post fresh ones (inside the per-PR lock).
  await db.delete(reviewComments).where(and(eq(reviewComments.prId, pr.id), eq(reviewComments.kind, "ai_review")));
  for (const f of analysis.findings) {
    await db.insert(reviewComments).values({
      prId: pr.id,
      commitSha: headSha,
      path: f.path,
      line: f.line,
      side: f.side,
      body: `**[${f.severity.toUpperCase()}] ${f.title}**\n\n${f.detail}${f.suggestion ? `\n\n_Suggestion:_ ${f.suggestion}` : ""}`,
      kind: "ai_review",
      severity: f.severity,
    });
  }
  await db.update(pullRequests).set({
    riskScore: analysis.riskScore,
    riskSummary: analysis.summary,
    updatedAt: new Date(),
  }).where(eq(pullRequests.id, pr.id));

  return { findings: analysis.findings.length, riskScore: analysis.riskScore, mode: analysis.mode };
}

async function runSemanticIndex(payload: { repoId: number; branch: string; commitSha: string }, runId: number): Promise<JobResult> {
  const repoRows = await db
    .select({ name: repositories.name, slug: organizations.slug })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(eq(repositories.id, payload.repoId))
    .limit(1);
  const repo = repoRows[0];
  if (!repo) throw new Error(`repo ${payload.repoId} not found`);
  const gitDir = repoGitDir(repo.slug, repo.name);

  await logEvent(runId, "info", `Indexing ${repo.slug}/${repo.name}@${payload.branch} @ ${payload.commitSha.slice(0, 7)}`);

  // Walk the tree at the commit
  const files = await listTreeFiles(gitDir, payload.commitSha);
  await logEvent(runId, "info", `Found ${files.length} files to index`);

  // Delete old embeddings for this repo+branch, then insert fresh.
  await db.delete(embeddings).where(and(eq(embeddings.repoId, payload.repoId), eq(embeddings.branch, payload.branch)));

  let indexed = 0;
  for (const filePath of files) {
    if (!shouldIndex(filePath)) continue;
    const blobSha = await revParse(gitDir, `${payload.commitSha}:${filePath}`);
    if (!blobSha) continue;
    const content = await catFileText(gitDir, blobSha, 512 * 1024);
    if (!content) continue;
    const chunks = chunkFile(filePath, content);
    if (chunks.length === 0) continue;
    const embedded = await embedChunks(chunks);
    for (const c of embedded) {
      await db.insert(embeddings).values({
        repoId: payload.repoId,
        branch: payload.branch,
        path: c.path,
        lineStart: c.lineStart,
        lineEnd: c.lineEnd,
        symbol: c.symbol,
        kind: c.kind,
        content: c.content,
        embedding: c.embedding as never,
      });
    }
    indexed += chunks.length;
  }
  await logEvent(runId, "info", `Indexed ${indexed} chunks`);
  return { files: files.length, chunks: indexed };
}

async function listTreeFiles(gitDir: string, sha: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(treePath: string) {
    const entries = await lsTree(gitDir, sha, treePath);
    for (const e of entries) {
      // lsTree returns paths relative to treePath; re-join for the full path.
      const fullPath = treePath ? `${treePath}/${e.path}` : e.path;
      if (e.type === "tree") {
        await walk(fullPath);
      } else if (e.type === "blob") {
        out.push(fullPath);
      }
    }
  }
  await walk("");
  return out;
}

const TEXT_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json", ".md", ".txt", ".css", ".scss", ".html",
  ".py", ".rs", ".go", ".rb", ".java", ".kt", ".c", ".h", ".cpp", ".hpp", ".sh", ".yml", ".yaml", ".toml",
]);

function shouldIndex(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = path.slice(dot).toLowerCase();
  return TEXT_EXTENSIONS.has(ext) && !path.includes("node_modules/") && !path.startsWith("data/");
}

function chunkFile(path: string, content: string): CodeChunk[] {
  // Simple chunker: for code, split on function/class boundaries (heuristic);
  // for prose (markdown), split on headings.
  const lines = content.split("\n");
  const chunks: CodeChunk[] = [];
  if (path.endsWith(".md")) {
    return chunkMarkdown(path, lines);
  }
  // Code chunking: accumulate ~40-line windows aligned to top-level declarations
  const WINDOW = 40;
  let start = 0;
  while (start < lines.length) {
    const slice = lines.slice(start, start + WINDOW);
    const firstDecl = slice.find((l) => /^(export\s+)?(async\s+)?(function|class|interface|type|const|enum)\b/.test(l.trim()));
    const symbol = firstDecl ? (/(?:function|class|interface|type|enum)\s+([A-Za-z0-9_$]+)/.exec(firstDecl)?.[1] ?? null) : null;
    chunks.push({
      path,
      branch: "",
      lineStart: start + 1,
      lineEnd: start + slice.length,
      symbol,
      kind: "symbol",
      content: slice.join("\n"),
    });
    start += WINDOW;
  }
  return chunks;
}

function chunkMarkdown(path: string, lines: string[]): CodeChunk[] {
  const chunks: CodeChunk[] = [];
  let start = 0;
  let heading: string | null = null;
  const push = (from: number, to: number) => {
    if (to <= from) return;
    chunks.push({
      path,
      branch: "",
      lineStart: from + 1,
      lineEnd: to,
      symbol: heading,
      kind: "text",
      content: lines.slice(from, to).join("\n"),
    });
  };
  for (let i = 0; i < lines.length; i++) {
    const h = /^#{1,3}\s+(.*)$/.exec(lines[i]!);
    if (h) {
      push(start, i);
      start = i;
      heading = h[1] ?? null;
    }
  }
  push(start, lines.length);
  return chunks;
}

async function runQaAnswer(payload: { repoId: number; branch: string; question: string; askerId: number | null }, runId: number): Promise<JobResult> {
  const chunks = await db.select().from(embeddings).where(and(eq(embeddings.repoId, payload.repoId), eq(embeddings.branch, payload.branch)));
  const answer = await answerQuestion(payload.question, chunks as never);
  return { answer: answer.answer, citations: answer.citations.length, mode: answer.mode };
}

async function runIntentPlan(payload: { repoId: number; intentId: number }, runId: number): Promise<JobResult> {
  const intentRows = await db.select().from(intents).where(eq(intents.id, payload.intentId)).limit(1);
  const intent = intentRows[0];
  if (!intent) throw new Error(`intent ${payload.intentId} not found`);
  await logEvent(runId, "info", `Drafting implementation plan for #${intent.number}: ${intent.title}`);
  const planBranch = (await db.select({ defaultBranch: repositories.defaultBranch })
      .from(repositories).where(eq(repositories.id, payload.repoId)).limit(1))[0]?.defaultBranch ?? "main";
  const chunks = await db.select().from(embeddings)
    .where(and(eq(embeddings.repoId, payload.repoId), eq(embeddings.branch, planBranch))).limit(60);
  const plan = await generatePlan({ title: intent.title, description: intent.description ?? "" }, chunks as never);
  await db.update(intents).set({ plan, planState: "ready" }).where(eq(intents.id, payload.intentId));
  return { steps: plan.steps.length };
}

async function runPreviewBuild(payload: { repoId: number; prId: number; commitSha: string; branch: string }, runId: number): Promise<JobResult> {
  const repoRows = await db
    .select({ name: repositories.name, slug: organizations.slug })
    .from(repositories)
    .innerJoin(organizations, eq(organizations.id, repositories.orgId))
    .where(eq(repositories.id, payload.repoId))
    .limit(1);
  const repo = repoRows[0];
  if (!repo) throw new Error(`repo ${payload.repoId} not found`);
  const gitDir = repoGitDir(repo.slug, repo.name);
  const { runSandboxBuild } = await import("@forge/sandbox");
  const [preview] = await db.insert(previews).values({
    repoId: payload.repoId,
    prId: payload.prId,
    branch: payload.branch,
    commitSha: payload.commitSha,
    status: "building",
  }).returning({ id: previews.id });
  if (!preview) throw new Error("preview insert failed");

  const result = await runSandboxBuild({
    gitDir,
    commitSha: payload.commitSha,
    previewId: preview.id,
    onLog: (line) => {
      void logEvent(runId, "info", line, payload.prId).catch(() => {});
    },
  });
  await db.update(previews).set({
    status: result.ok ? "running" : "failed",
    exitCode: result.exitCode ?? null,
    durationMs: result.durationMs,
    finishedAt: new Date(),
    adapter: result.adapter,
  }).where(eq(previews.id, preview.id));
  return { ok: result.ok, exitCode: result.exitCode, adapter: result.adapter };
}
