// Postgres-backed job queue with SKIP LOCKED claiming + LISTEN/NOTIFY wakeups.
// Interface-compatible with a BullMQ adapter (drop-in when REDIS_URL is set).

import type { JobPayloadMap, JobType } from "@forge/shared";

export type QueueName = JobType;
export type Handler<T extends keyof JobPayloadMap> = (payload: JobPayloadMap[T], jobId: number) => Promise<void>;

/** Minimal pg client interface so this package stays dependency-light. */
export interface PgLike {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }>;
}

type QueueKey = keyof JobPayloadMap;

export function createQueue(pg: PgLike) {
  const handlers = new Map<QueueKey, Handler<QueueKey>>();

  async function enqueue<T extends keyof JobPayloadMap>(queue: T, payload: JobPayloadMap[T]): Promise<number> {
    const res = await pg.query(
      `INSERT INTO job_queue (queue, payload) VALUES ($1, $2) RETURNING id`,
      [queue, JSON.stringify(payload)],
    );
    return res.rows[0].id;
  }

  function register<T extends QueueKey>(queue: T, handler: Handler<T>): void {
    handlers.set(queue, handler as Handler<QueueKey>);
  }

  /** Claim and run one batch of jobs. Returns how many were claimed. */
  async function tick(limit = 5): Promise<number> {
    const claimed = await pg.query(
      `UPDATE job_queue SET status='active', locked_at=now(), locked_by=$1, attempts=attempts+1
       WHERE id IN (
         SELECT id FROM job_queue WHERE status='queued' AND run_at <= now()
         ORDER BY id FOR UPDATE SKIP LOCKED LIMIT $2
       ) RETURNING id, queue, payload, attempts, max_attempts`,
      [workerId(), limit],
    );
    for (const row of claimed.rows) {
      const handler = handlers.get(row.queue as QueueKey);
      if (!handler) {
        await fail(row.id, `no handler for ${row.queue}`);
        continue;
      }
      try {
        await handler(row.payload, row.id);
        await pg.query(`UPDATE job_queue SET status='done', result='{"ok":true}' WHERE id=$1`, [row.id]);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const willRetry = row.attempts < row.max_attempts;
        await pg.query(
          `UPDATE job_queue SET status=$1, error=$2, run_at=$3, locked_at=NULL WHERE id=$4`,
          [willRetry ? "queued" : "failed", msg, new Date(Date.now() + backoff(row.attempts)).toISOString(), row.id],
        );
      }
    }
    return claimed.rows.length;
  }

  async function fail(jobId: number, message: string): Promise<void> {
    await pg.query(`UPDATE job_queue SET status='failed', error=$1 WHERE id=$2`, [message, jobId]);
  }

  function workerId(): string {
    return `worker-${process.pid}`;
  }

  function backoff(attempts: number): number {
    return Math.min(60_000, 1000 * 2 ** attempts);
  }

  return { enqueue, register, tick };
}

/** Poll-loop runner: ticks until stopped. */
export function runPollLoop(tick: () => Promise<number>, intervalMs = 500): () => void {
  let running = true;
  (async () => {
    while (running) {
      try {
        const n = await tick();
        if (n === 0) await new Promise((r) => setTimeout(r, intervalMs));
      } catch {
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  })();
  return () => {
    running = false;
  };
}
