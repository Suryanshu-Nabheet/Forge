// Repository tables: orgs, repositories, branches, commits.

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { Visibility } from "@forge/shared";
import { users } from "./auth";

export const organizations = pgTable(
  "organizations",
  {
    id: serial("id").primaryKey(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    description: text("description"),
    ownerId: integer("owner_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const orgMembers = pgTable(
  "org_members",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").$type<"owner" | "member">().notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("org_members_org_user_idx").on(t.orgId, t.userId),
    index("org_members_user_idx").on(t.userId),
  ],
);

export const repositories = pgTable(
  "repositories",
  {
    id: serial("id").primaryKey(),
    orgId: integer("org_id")
      .notNull()
      .references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    visibility: text("visibility").$type<Visibility>().notNull().default("public"),
    defaultBranch: text("default_branch").notNull().default("main"),
    protectedBranches: jsonb("protected_branches").$type<string[]>().notNull().default(["main"]),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("repos_org_name_idx").on(t.orgId, t.name)],
);

export const branches = pgTable(
  "branches",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    commitSha: text("commit_sha").notNull(),
    isDefault: boolean("is_default").notNull().default(false),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("branches_repo_name_idx").on(t.repoId, t.name)],
);

export const commits = pgTable(
  "commits",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    sha: text("sha").notNull(),
    message: text("message").notNull(),
    authorName: text("author_name").notNull(),
    authorEmail: text("author_email").notNull(),
    authoredAt: timestamp("authored_at", { withTimezone: true }).notNull(),
    committedAt: timestamp("committed_at", { withTimezone: true }).notNull(),
    parentShas: jsonb("parent_shas").$type<string[]>().notNull().default([]),
    additions: integer("additions").notNull().default(0),
    deletions: integer("deletions").notNull().default(0),
  },
  (t) => [
    uniqueIndex("commits_repo_sha_idx").on(t.repoId, t.sha),
    index("commits_repo_idx").on(t.repoId),
  ],
);

// ---------- social layer: stars, forks, watchers ----------

export const stars = pgTable(
  "stars",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("stars_repo_user_idx").on(t.repoId, t.userId),
    index("stars_repo_idx").on(t.repoId),
    index("stars_user_idx").on(t.userId),
  ],
);

export const watchers = pgTable(
  "watchers",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    userId: integer("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("watchers_repo_user_idx").on(t.repoId, t.userId),
    index("watchers_repo_idx").on(t.repoId),
    index("watchers_user_idx").on(t.userId),
  ],
);

/** Fork lineage: every fork repo points back at its origin. */
export const forkedRepos = pgTable(
  "forked_repos",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" })
      .unique(),
    forkedFromRepoId: integer("forked_from_repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    forkedAt: timestamp("forked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("forked_from_idx").on(t.forkedFromRepoId),
  ],
);
