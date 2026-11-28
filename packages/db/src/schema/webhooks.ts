// Webhook tables: per-repo hooks, HMAC-signed deliveries, delivery log.

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  boolean,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { repositories } from "./repos";

export const webhooks = pgTable(
  "webhooks",
  {
    id: serial("id").primaryKey(),
    repoId: integer("repo_id")
      .notNull()
      .references(() => repositories.id, { onDelete: "cascade" }),
    url: text("url").notNull(),
    secret: text("secret").notNull(), // HMAC-SHA256 signing secret
    events: jsonb("events").$type<string[]>().notNull().default(["push"]),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhooks_repo_idx").on(t.repoId)],
);

export const webhookDeliveries = pgTable(
  "webhook_deliveries",
  {
    id: serial("id").primaryKey(),
    webhookId: integer("webhook_id")
      .notNull()
      .references(() => webhooks.id, { onDelete: "cascade" }),
    event: text("event").notNull(),
    status: text("status").$type<"pending" | "delivered" | "failed">().notNull().default("pending"),
    responseStatus: integer("response_status"),
    durationMs: integer("duration_ms"),
    error: text("error"),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("webhook_deliveries_hook_idx").on(t.webhookId)],
);
