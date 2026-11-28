// GET /api/audit — recent audit events (observability surface).
// Scoping: any authenticated user sees events performed by themselves.
// (Org- or platform-level scoping can be layered on without a schema change.)

import { NextResponse } from "next/server";
import { recentAudit } from "@forge/db";
import { requireUser, unauthorized } from "@/server/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const rows = await recentAudit(200);
  const scoped = rows.filter((r) => r.actorId === user.id);
  return NextResponse.json({ audit: scoped });
}
