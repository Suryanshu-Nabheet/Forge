// GET /api/audit — recent audit events (observability surface).
// Scoping: any authenticated user sees events performed by themselves.
// (Org- or platform-level scoping can be layered on without a schema change.)

import { NextResponse } from "next/server";
import { db, auditLog, recentAudit } from "@forge/db";
import { eq, desc } from "drizzle-orm";
import { requireUser, unauthorized } from "@/server/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  // Scope in SQL (the global recency limit would otherwise hide older
  // events); call sites that want platform-wide use recentAudit directly.
  const rows = await db
    .select({
      id: auditLog.id,
      actorId: auditLog.actorId,
      actorHandle: auditLog.actorHandle,
      action: auditLog.action,
      targetType: auditLog.targetType,
      targetId: auditLog.targetId,
      ip: auditLog.ip,
      data: auditLog.data,
      createdAt: auditLog.createdAt,
    })
    .from(auditLog)
    .where(eq(auditLog.actorId, user.id))
    .orderBy(desc(auditLog.id))
    .limit(200);
  return NextResponse.json({ audit: rows });
}
