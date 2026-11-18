// Collaboration tables: pull requests, review comments, intents, intent links.

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  real,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type {
  PrStatus,
  CommentKind,
  IntentStatus,
  IntentKind,
  ImplementationPlan,
} from "@forge/shared";
import { users } from "./auth";
import { repositories } from "./repos";

export const pullRequests = pgTable(
  "pull_requests",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    baseBranch: text("base_branch").notNull(),
    headBranch: text("head_branch").notNull(),
    headSha: text("head_sha"),
    baseSha: text("base_sha"),
    status: text("status").$type<PrStatus>().notNull().default("open"),
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    riskScore: real("risk_score"),
    riskSummary: text("risk_summary"),
    mergedCommitSha: text("merged_commit_sha"),
    mergedAt: timestamp("merged_at", { withTimezone: true }),
    intentId: integer("intent_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pr_repo_number_idx").on(t.repoId, t.number),
    index("pr_repo_status_idx").on(t.repoId, t.status),
  ],
);

export const prApprovals = pgTable(
  "pr_approvals",
  {
    id: serial("id").primaryKey(),
    prId: integer("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    state: text("state").$type<"approved" | "changes_requested">().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("pr_approvals_pr_user_idx").on(t.prId, t.userId),
    index("pr_approvals_pr_idx").on(t.prId),
  ],
);

export const reviewComments = pgTable(
  "review_comments",
  {
    id: serial("id").primaryKey(),
    prId: integer("pr_id")
      .notNull()
      .references(() => pullRequests.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha"),
    path: text("path"),
    line: integer("line"),
    side: text("side").$type<"old" | "new">(),
    body: text("body").notNull(),
    kind: text("kind").$type<CommentKind>().notNull().default("human"),
    severity: text("severity"),
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("rc_pr_idx").on(t.prId)],
);

export const intents = pgTable(
  "intents",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    number: integer("number").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status").$type<IntentStatus>().notNull().default("open"),
    kind: text("kind").$type<IntentKind>().notNull().default("issue"),
    labels: jsonb("labels").$type<string[]>().notNull().default([]),
    authorId: integer("author_id").references(() => users.id, { onDelete: "set null" }),
    branchName: text("branch_name"),
    linkedPrId: integer("linked_pr_id"),
    plan: jsonb("plan").$type<ImplementationPlan | null>(),
    planState: text("plan_state"), // none | drafting | ready | failed
    priority: integer("priority").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp("closed_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("intents_repo_number_idx").on(t.repoId, t.number),
    index("intents_repo_status_idx").on(t.repoId, t.status),
  ],
);

export const intentLinks = pgTable(
  "intent_links",
  {
    id: serial("id").primaryKey(),
    intentId: integer("intent_id")
      .notNull()
      .references(() => intents.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(), // "commit" | "pr" | "branch"
    value: text("value").notNull(), // sha, PR number, or branch name
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("intent_links_intent_idx").on(t.intentId)],
);
