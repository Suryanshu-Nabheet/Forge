// GET/POST /api/pats — personal access token management (session-scoped).

import { NextResponse } from "next/server";
import { db, personalAccessTokens, createPat } from "@forge/db";
import { desc, eq } from "drizzle-orm";
import { requireUser, unauthorized } from "@/server/session";

export async function GET() {
  const user = await requireUser();
  if (!user) return unauthorized();
  const rows = await db
    .select({ id: personalAccessTokens.id, name: personalAccessTokens.name, prefix: personalAccessTokens.prefix })
    .from(personalAccessTokens)
    .where(eq(personalAccessTokens.userId, user.id))
    .orderBy(desc(personalAccessTokens.id));
  return NextResponse.json({ pats: rows });
}

export async function POST(req: Request) {
  const user = await requireUser();
  if (!user) return unauthorized();
  const body = (await req.json()) as { name?: string; scopes?: string[] };
  const name = (body.name ?? "").trim();
  if (!name) return NextResponse.json({ error: "name required" }, { status: 400 });
  const scopes = Array.isArray(body.scopes) && body.scopes.length > 0
    ? body.scopes.filter((s) => s === "repo:read" || s === "repo:write")
    : ["repo:read"];
  const { token } = await createPat(user.id, name, scopes);
  return NextResponse.json({ token });
}
