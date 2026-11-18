// POST /api/auth/logout — destroy session, clear cookie.

import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { destroySession } from "@forge/db";

export async function POST() {
  const jar = await cookies();
  const token = jar.get("forge_session")?.value;
  if (token) await destroySession(token);
  const res = NextResponse.json({ ok: true });
  res.cookies.set("forge_session", "", { httpOnly: true, sameSite: "lax", path: "/", maxAge: 0 });
  return res;
}
