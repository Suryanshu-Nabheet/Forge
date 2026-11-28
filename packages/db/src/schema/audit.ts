// Audit log: security-relevant events with actor, target, and source IP.
// Append-only from the app's perspective — no update path exists.

import {
  pgTable,
  serial,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { users } from "./auth";

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial("id").primaryKey(),
    // Who performed the action (null = anonymous, e.g. failed logins).
    actorId: integer("actor_id").references(() => users.id, { onDelete: "set null" }),
    actorHandle: text("actor_handle"), // denormalized so rows survive actor deletion
    action: text("action").notNull(), // e.g. "auth.login", "pat.create", "repo.delete"
    // What was acted on, e.g. "org/repo", "user:ada", "pat:3".
    targetType: text("target_type"),
    targetId: text("target_id"),
    ip: text("ip"),
    // Structured details (never secrets — no tokens/passwords here).
    data: jsonb("data").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_actor_idx").on(t.actorId, t.id),
    index("audit_action_idx").on(t.action, t.id),
    index("audit_created_idx").on(t.createdAt),
  ],
);

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.login_locked"
  | "auth.totp_failed"
  | "auth.recovery_failed"
  | "auth.recovery_used"
  | "auth.logout"
  | "auth.register"
  | "pat.create"
  | "pat.revoke"
  | "ssh_key.add"
  | "ssh_key.delete"
  | "repo.create"
  | "repo.delete"
  | "repo.settings_update"
  | "org.member_add"
  | "org.member_remove"
  | "pr.merge"
  | "pr.approve"
  | "pr.request_changes"
  | "webhook.create"
  | "webhook.delete"
  | "2fa.enable"
  | "2fa.disable";
