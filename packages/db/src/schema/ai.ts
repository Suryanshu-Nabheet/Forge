// AI + jobs tables: embeddings, queue, runs, events, previews, activity.

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  real,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import type { JobType, JobStatus, PreviewStatus } from "@forge/shared";
import { repositories } from "./repos";
import { pullRequests } from "./collab";
import { users } from "./auth";

export const embeddings = pgTable(
  "embeddings",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    path: text("path").notNull(),
    lineStart: integer("line_start").notNull(),
    lineEnd: integer("line_end").notNull(),
    symbol: text("symbol"),
    kind: text("kind").$type<"symbol" | "text">().notNull(),
    content: text("content").notNull(),
    embedding: real("embedding").array().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("emb_repo_branch_idx").on(t.repoId, t.branch),
    index("emb_path_idx").on(t.repoId, t.path),
  ],
);

export const jobQueue = pgTable(
  "job_queue",
  {
    id: serial("id").primaryKey(),
    queue: text("queue").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    status: text("status").$type<"queued" | "active" | "done" | "failed">().notNull().default("queued"),
    runAt: timestamp("run_at", { withTimezone: true }).notNull().defaultNow(),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lockedBy: text("locked_by"),
    error: text("error"),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_queue_status_idx").on(t.status, t.runAt)],
);

export const jobRuns = pgTable(
  "job_runs",
  {
    id: serial("id").primaryKey(),
    jobQueueId: integer("job_queue_id").references(() => jobQueue.id, { onDelete: "cascade" }),
    type: text("type").$type<JobType>().notNull(),
    repoId: integer("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
    prId: integer("pr_id").references(() => pullRequests.id, { onDelete: "cascade" }),
    status: text("status").$type<JobStatus>().notNull().default("queued"),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
    error: text("error"),
    queuedAt: timestamp("queued_at", { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("job_runs_type_idx").on(t.type),
    index("job_runs_pr_idx").on(t.prId),
  ],
);

export const jobEvents = pgTable(
  "job_events",
  {
    id: serial("id").primaryKey(),
    jobRunId: integer("job_run_id")
      .notNull()
      .references(() => jobRuns.id, { onDelete: "cascade" }),
    level: text("level").$type<"info" | "warn" | "error">().notNull().default("info"),
    message: text("message").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("job_events_run_idx").on(t.jobRunId, t.id)],
);

export const previews = pgTable(
  "previews",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    prId: integer("pr_id").references(() => pullRequests.id, { onDelete: "cascade" }),
    branch: text("branch").notNull(),
    commitSha: text("commit_sha").notNull(),
    status: text("status").$type<PreviewStatus>().notNull().default("queued"),
    adapter: text("adapter").$type<"docker" | "process">().notNull().default("process"),
    buildLog: jsonb("build_log").$type<Array<{ t: string; line: string }>>().notNull().default([]),
    exitCode: integer("exit_code"),
    durationMs: integer("duration_ms"),
    url: text("url"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("previews_pr_idx").on(t.prId)],
);

export const activities = pgTable(
  "activities",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id").references(() => repositories.id, { onDelete: "cascade" }),
    userId: integer("user_id").references(() => users.id, { onDelete: "set null" }),
    type: text("type").notNull(),
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("activities_repo_idx").on(t.repoId, t.id)],
);
